import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Deterministic, original 20-second stereo PCM WAV. It is synthesized at test
// time so the test suite never distributes or uploads third-party music.
export default async function globalSetup() {
  const path = resolve(process.cwd(), "tests/fixtures/copyright-safe-fixture.wav");
  await mkdir(dirname(path), { recursive: true });
  const sampleRate = 44_100;
  const seconds = 20;
  const frames = sampleRate * seconds;
  const data = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / sampleRate;
    const envelope = Math.min(1, time * 8, (seconds - time) * 8) * 0.35;
    const left = Math.round((Math.sin(2 * Math.PI * 220 * time) + 0.35 * Math.sin(2 * Math.PI * 440 * time)) * 16384 * envelope);
    const right = Math.round((Math.sin(2 * Math.PI * 329.63 * time) + 0.25 * Math.sin(2 * Math.PI * 659.25 * time)) * 16384 * envelope);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, left)), frame * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, right)), frame * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  await writeFile(path, Buffer.concat([header, data]));
}
