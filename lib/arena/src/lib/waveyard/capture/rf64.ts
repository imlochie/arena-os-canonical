import { link, open, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const RF64_SENTINEL = 0xffff_ffff;
const DS64_SIZE = 28;
const FIXED_HEADER_BYTES = 56;
const MAX_FORMAT_CHUNK_BYTES = 4096;

export interface Rf64Format {
  /** Exact WAVEFORMATEX or WAVEFORMATEXTENSIBLE bytes from the capture API. */
  formatChunk: Uint8Array;
}

export interface Rf64Header {
  bytes: Buffer;
  dataOffset: number;
  blockAlign: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export interface Rf64RecordingResult {
  path: string;
  dataBytes: number;
  sampleFrames: number;
  fileBytes: number;
  discardedTailBytes: number;
}

function parseFormat(format: Rf64Format): Omit<Rf64Header, "bytes" | "dataOffset"> & { formatChunk: Buffer } {
  const chunk = Buffer.from(format.formatChunk);
  if (chunk.length < 16 || chunk.length > MAX_FORMAT_CHUNK_BYTES) {
    throw new Error(`WAVE format chunk must be between 16 and ${MAX_FORMAT_CHUNK_BYTES} bytes.`);
  }
  const channels = chunk.readUInt16LE(2);
  const sampleRate = chunk.readUInt32LE(4);
  const blockAlign = chunk.readUInt16LE(12);
  const bitsPerSample = chunk.readUInt16LE(14);
  if (channels < 1 || channels > 64 || sampleRate < 1 || blockAlign < 1 || bitsPerSample < 1) {
    throw new Error("WAVE format chunk contains invalid channel, rate, alignment, or sample-width values.");
  }
  if (chunk.length >= 18 && chunk.readUInt16LE(16) > chunk.length - 18) {
    throw new Error("WAVE format extension length exceeds the supplied format chunk.");
  }
  return { formatChunk: chunk, blockAlign, sampleRate, channels, bitsPerSample };
}

export function createRf64Header(format: Rf64Format): Rf64Header {
  const parsed = parseFormat(format);
  const paddedFormatBytes = parsed.formatChunk.length + (parsed.formatChunk.length & 1);
  const dataHeaderOffset = FIXED_HEADER_BYTES + paddedFormatBytes;
  const dataOffset = dataHeaderOffset + 8;
  const bytes = Buffer.alloc(dataOffset);

  bytes.write("RF64", 0, "ascii");
  bytes.writeUInt32LE(RF64_SENTINEL, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("ds64", 12, "ascii");
  bytes.writeUInt32LE(DS64_SIZE, 16);
  // ds64 sizes remain zero until finalization; the RF64 markers identify this
  // as an unfinished recording that the recovery path can safely inspect.
  bytes.writeBigUInt64LE(0n, 20);
  bytes.writeBigUInt64LE(0n, 28);
  bytes.writeBigUInt64LE(0n, 36);
  bytes.writeUInt32LE(0, 44);
  bytes.write("fmt ", 48, "ascii");
  bytes.writeUInt32LE(parsed.formatChunk.length, 52);
  parsed.formatChunk.copy(bytes, FIXED_HEADER_BYTES);
  bytes.write("data", dataHeaderOffset, "ascii");
  bytes.writeUInt32LE(RF64_SENTINEL, dataHeaderOffset + 4);

  return {
    bytes,
    dataOffset,
    blockAlign: parsed.blockAlign,
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: parsed.bitsPerSample,
  };
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  const buffer = Buffer.from(bytes);
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(buffer, written, buffer.length - written, position + written);
    if (result.bytesWritten <= 0) throw new Error("RF64 file write made no progress.");
    written += result.bytesWritten;
  }
}

async function patchSizes(
  handle: FileHandle,
  header: Pick<Rf64Header, "dataOffset" | "blockAlign">,
  dataBytes: number,
): Promise<number> {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes % header.blockAlign !== 0) {
    throw new Error("RF64 audio data must contain a safe number of complete PCM frames.");
  }
  const fileBytes = header.dataOffset + dataBytes;
  if (!Number.isSafeInteger(fileBytes)) throw new Error("RF64 file size exceeds the safe file-position range.");
  const sizes = Buffer.alloc(24);
  sizes.writeBigUInt64LE(BigInt(fileBytes - 8), 0);
  sizes.writeBigUInt64LE(BigInt(dataBytes), 8);
  sizes.writeBigUInt64LE(BigInt(dataBytes / header.blockAlign), 16);
  await writeAll(handle, sizes, 20);
  await handle.sync();
  return fileBytes;
}

export class Rf64Recorder {
  private constructor(
    private readonly partialPath: string,
    private readonly finalPath: string,
    private readonly handle: FileHandle,
    private readonly header: Rf64Header,
  ) {}

  static async create(input: { partialPath: string; finalPath: string; format: Rf64Format }): Promise<Rf64Recorder> {
    if (input.partialPath === input.finalPath) throw new Error("Partial and final recording paths must differ.");
    if (dirname(resolve(input.partialPath)) !== dirname(resolve(input.finalPath))) {
      throw new Error("Partial and final RF64 files must be in the same directory for safe no-overwrite finalization.");
    }
    const header = createRf64Header(input.format);
    const handle = await open(input.partialPath, "wx+");
    try {
      await writeAll(handle, header.bytes, 0);
      await handle.sync();
      return new Rf64Recorder(input.partialPath, input.finalPath, handle, header);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  get format(): Omit<Rf64Header, "bytes"> {
    const { bytes: _bytes, ...format } = this.header;
    return format;
  }

  private pcmBytes = 0;
  private pending = Buffer.alloc(0);
  private finalized = false;
  private finalizing = false;
  private closed = false;

  get sampleFrames(): number {
    return this.pcmBytes / this.header.blockAlign;
  }

  async writePcm(chunk: Uint8Array): Promise<void> {
    if (this.finalized || this.finalizing) throw new Error("Cannot write to a finalized RF64 recording.");
    const input = this.pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.pending, chunk]);
    const completeBytes = input.length - (input.length % this.header.blockAlign);
    if (completeBytes > 0) {
      await writeAll(this.handle, input.subarray(0, completeBytes), this.header.dataOffset + this.pcmBytes);
      this.pcmBytes += completeBytes;
    }
    this.pending = Buffer.from(input.subarray(completeBytes));
  }

  async flush(): Promise<void> {
    if (this.finalized || this.finalizing) throw new Error("Cannot flush a finalized RF64 recording.");
    await this.handle.sync();
  }

  async finalize(): Promise<Rf64RecordingResult> {
    if (this.finalized || this.finalizing) throw new Error("RF64 recording was already finalized.");
    this.finalizing = true;
    const discardedTailBytes = this.pending.length;
    this.pending = Buffer.alloc(0);
    try {
      const fileBytes = await patchSizes(this.handle, this.header, this.pcmBytes);
      await this.handle.close();
      this.closed = true;
      await link(this.partialPath, this.finalPath);
      await unlink(this.partialPath);
      this.finalized = true;
      return {
        path: this.finalPath,
        dataBytes: this.pcmBytes,
        sampleFrames: this.pcmBytes / this.header.blockAlign,
        fileBytes,
        discardedTailBytes,
      };
    } finally {
      this.finalizing = false;
    }
  }

  /** Close without patching sizes so the next launch can exercise recovery. */
  async leaveRecoverable(): Promise<void> {
    if (this.finalized) return;
    this.finalizing = true;
    this.pending = Buffer.alloc(0);
    try {
      if (!this.closed) {
        await this.handle.sync();
        await this.handle.close();
        this.closed = true;
      }
      this.finalized = true;
    } finally {
      this.finalizing = false;
    }
  }
}

function parseExistingHeader(bytes: Buffer): Omit<Rf64Header, "bytes"> & {
  finalized: boolean;
  riffSize: bigint;
  dataBytes: bigint;
  sampleFrames: bigint;
} {
  if (bytes.length < FIXED_HEADER_BYTES || bytes.toString("ascii", 0, 4) !== "RF64" ||
    bytes.readUInt32LE(4) !== RF64_SENTINEL || bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.toString("ascii", 12, 16) !== "ds64" || bytes.readUInt32LE(16) < DS64_SIZE ||
    bytes.toString("ascii", 48, 52) !== "fmt ") {
    throw new Error("File is not a recoverable Waveyard RF64 recording.");
  }
  const riffSize = bytes.readBigUInt64LE(20);
  const dataBytes = bytes.readBigUInt64LE(28);
  const sampleFrames = bytes.readBigUInt64LE(36);
  const finalized = riffSize !== 0n || dataBytes !== 0n || sampleFrames !== 0n;
  if (finalized && riffSize === 0n) {
    throw new Error("RF64 recovery rejected inconsistent finalized size fields.");
  }
  const formatBytes = bytes.readUInt32LE(52);
  if (formatBytes < 16 || formatBytes > MAX_FORMAT_CHUNK_BYTES) {
    throw new Error("RF64 recovery rejected an invalid format chunk size.");
  }
  const paddedFormatBytes = formatBytes + (formatBytes & 1);
  const dataHeaderOffset = FIXED_HEADER_BYTES + paddedFormatBytes;
  const dataOffset = dataHeaderOffset + 8;
  if (bytes.length < dataOffset || bytes.toString("ascii", dataHeaderOffset, dataHeaderOffset + 4) !== "data" ||
    bytes.readUInt32LE(dataHeaderOffset + 4) !== RF64_SENTINEL) {
    throw new Error("RF64 recovery rejected an incomplete or unexpected header.");
  }
  const formatChunk = bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + formatBytes);
  const parsed = parseFormat({ formatChunk });
  return {
    dataOffset,
    blockAlign: parsed.blockAlign,
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    bitsPerSample: parsed.bitsPerSample,
    finalized,
    riffSize,
    dataBytes,
    sampleFrames,
  };
}

async function promoteToUniqueRecoveredPath(partialPath: string): Promise<string> {
  const directory = dirname(partialPath);
  const original = basename(partialPath).replace(/\.partial\.wav$/i, "");
  for (let suffix = 1; suffix < 10_000; suffix++) {
    const name = suffix === 1 ? `${original}.recovered.wav` : `${original}.recovered-${suffix}.wav`;
    const candidate = join(directory, name);
    try {
      await link(partialPath, candidate);
      await unlink(partialPath);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("Could not find a free filename for the recovered recording.");
}

/** Inspect finalized capture PCM without decoding or changing its format. */
export async function inspectRf64Recording(path: string) {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(MAX_FORMAT_CHUNK_BYTES + FIXED_HEADER_BYTES + 10);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = parseExistingHeader(buffer.subarray(0, bytesRead));
    const dataBytes = Number(header.dataBytes);
    if (!header.finalized || !Number.isSafeInteger(dataBytes) || dataBytes % header.blockAlign !== 0
      || header.dataOffset + dataBytes > size || header.riffSize !== BigInt(size - 8)) {
      throw new Error("RF64 capture has incomplete or inconsistent PCM sizes.");
    }
    const formatSize = buffer.readUInt32LE(52);
    return {
      ...header,
      dataBytes,
      sampleFrames: dataBytes / header.blockAlign,
      format: { formatChunk: Buffer.from(buffer.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + formatSize)) },
    };
  } finally {
    await handle.close();
  }
}

/**
 * Recover a Waveyard partial RF64 after an interrupted process. Only complete
 * PCM frames are retained; malformed or unrelated files are never rewritten.
 */
export async function recoverRf64Partial(partialPath: string): Promise<Rf64RecordingResult> {
  const handle = await open(partialPath, "r+");
  try {
    const prefix = Buffer.alloc(FIXED_HEADER_BYTES + MAX_FORMAT_CHUNK_BYTES + 10);
    const read = await handle.read(prefix, 0, prefix.length, 0);
    const header = parseExistingHeader(prefix.subarray(0, read.bytesRead));
    const fileInfo = await handle.stat();
    const availableData = fileInfo.size - header.dataOffset;
    if (availableData < 0) throw new Error("RF64 recovery found a file shorter than its header.");
    let dataBytes: number;
    let discardedTailBytes: number;
    if (header.finalized) {
      if (
        header.dataBytes !== BigInt(availableData) ||
        header.riffSize !== BigInt(fileInfo.size - 8) ||
        header.sampleFrames !== BigInt(availableData / header.blockAlign) ||
        availableData % header.blockAlign !== 0
      ) {
        throw new Error("RF64 recovery rejected finalized size fields that do not match the file.");
      }
      dataBytes = availableData;
      discardedTailBytes = 0;
    } else {
      dataBytes = availableData - (availableData % header.blockAlign);
      discardedTailBytes = availableData - dataBytes;
      const fileBytes = header.dataOffset + dataBytes;
      if (discardedTailBytes > 0) await handle.truncate(fileBytes);
      await patchSizes(handle, header, dataBytes);
    }
    const fileBytes = header.dataOffset + dataBytes;
    await handle.close();
    const recoveredPath = await promoteToUniqueRecoveredPath(partialPath);
    return {
      path: recoveredPath,
      dataBytes,
      sampleFrames: dataBytes / header.blockAlign,
      fileBytes,
      discardedTailBytes,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
