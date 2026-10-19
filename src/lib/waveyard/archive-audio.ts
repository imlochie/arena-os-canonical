/** Internet Archive public audio adapter. No login, protected stream extraction,
 * or inference claims. Licence metadata is an uploader claim, NOT a warranty.
 * Only explicit CC0/CC-BY grants are eligible; owner review is still required.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeFetch } from "../security/outbound-url";
import { MAX_UPLOAD_BYTES } from "./audio";
import { addTrackFromAudioFile } from "./library/service";

export const ARCHIVE_RIGHTS_NOTICE =
  "Internet Archive metadata is supplied by uploaders, not a rights warranty. Review both recording and composition rights, attribution, notices and any third-party restrictions. No rights are inferred from public availability. Only explicit CC0 or CC-BY files are eligible here; other items remain references.";
const fetchPublic: typeof fetch = (url, init) =>
  safeFetch(String(url), init, {
    policy: "public",
    timeoutMs: 60000,
    maxRedirects: 3,
  });
function idOf(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id))
    throw new Error("Invalid Archive identifier.");
  return id;
}
const text = (value: unknown): string =>
  typeof value === "string"
    ? value.slice(0, 2000)
    : Array.isArray(value)
      ? value
          .filter((v) => typeof v === "string")
          .join("; ")
          .slice(0, 2000)
      : "";
export function archiveLicence(
  value: unknown,
): { url: string; attributionRequired: boolean; label: string } | null {
  // Multiple/ambiguous declarations are not silently reduced to a permissive one.
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !["creativecommons.org", "www.creativecommons.org"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const path = url.pathname.replace(/\/$/, "");
    if (path === "/publicdomain/zero/1.0")
      return {
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        label: "CC0 1.0",
        attributionRequired: false,
      };
    const by = path.match(/^\/licenses\/by\/(2\.0|2\.5|3\.0|4\.0)$/);
    return by
      ? {
          url: `https://creativecommons.org/licenses/by/${by[1]}/`,
          label: `CC BY ${by[1]}`,
          attributionRequired: true,
        }
      : null;
  } catch {
    return null;
  }
}
async function json(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url);
  if (!response.ok)
    throw new Error(
      `Internet Archive unavailable (HTTP ${response.status}); no audio imported.`,
    );
  // Bound even a chunked metadata response before parsing.
  if (!response.body) throw new Error("Archive returned no metadata.");
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => {
    void reader.cancel();
  }, 60000);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024)
        throw new Error("Archive metadata exceeds 4 MiB.");
      chunks.push(part.value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function searchArchiveAudio(query: string, fetcher = fetchPublic) {
  if (!query.trim() || query.length > 120)
    throw new Error("Enter 1–120 characters to search.");
  const escaped = query.trim().replace(/[\\"]/g, "\\$&");
  const url = new URL("https://archive.org/advancedsearch.php");
  url.searchParams.set(
    "q",
    `mediatype:audio AND (title:"${escaped}" OR creator:"${escaped}")`,
  );
  for (const field of ["identifier", "title", "creator", "licenseurl"])
    url.searchParams.append("fl[]", field);
  url.searchParams.set("rows", "12");
  url.searchParams.set("page", "1");
  url.searchParams.set("output", "json");
  const data = await json(url.href, fetcher);
  if (!Array.isArray(data.response?.docs))
    throw new Error("Archive search response is invalid.");
  return data.response.docs
    .slice(0, 12)
    .flatMap((row: Record<string, unknown>) => {
      if (
        typeof row.identifier !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(row.identifier)
      )
        return [];
      return [
        {
          id: row.identifier,
          title: text(row.title),
          artist: text(row.creator),
          sourceUrl: `https://archive.org/details/${row.identifier}`,
          licence: archiveLicence(row.licenseurl),
          state: "reference-only" as const,
        },
      ];
    });
}
export async function inspectArchiveAudio(id: string, fetcher = fetchPublic) {
  idOf(id);
  const data = await json(`https://archive.org/metadata/${id}`, fetcher);
  const meta = data.metadata;
  if (
    !meta ||
    meta.identifier !== id ||
    meta.mediatype !== "audio" ||
    data.is_dark === true ||
    meta.is_dark === "true" ||
    [meta.collection]
      .flat()
      .some((name: unknown) =>
        ["inlibrary", "access-restricted-item", "printdisabled"].includes(
          String(name),
        ),
      ) ||
    meta.access_restricted === true ||
    meta.access_restricted === "true"
  )
    throw new Error("This is not an accessible public audio item.");
  const licence = archiveLicence(meta.licenseurl);
  const files: Array<{
    name: string;
    bytes: number;
    previewUrl: string;
    importEligible: boolean;
    sha1: string | null;
  }> = Array.isArray(data.files)
    ? data.files.slice(0, 500).flatMap((file: Record<string, unknown>) => {
        const name = typeof file.name === "string" ? file.name : "";
        const bytes = Number(file.size);
        // Do not offer encrypted, private, traversal, playlist or non-audio files.
        if (
          !name ||
          /[\x00-\x1f\x7f]/.test(name) ||
          name.includes("/") ||
          name.includes("\\") ||
          name.includes("..") ||
          !/\.(mp3|flac|wav|ogg|m4a)$/i.test(name) ||
          !Number.isSafeInteger(bytes) ||
          bytes <= 0 ||
          bytes > MAX_UPLOAD_BYTES ||
          file.private === "true" ||
          file.private === true
        )
          return [];
        return [
          {
            name,
            bytes,
            sha1:
              typeof file.sha1 === "string" && /^[a-f0-9]{40}$/i.test(file.sha1)
                ? file.sha1.toLowerCase()
                : null,
            previewUrl: `https://archive.org/download/${id}/${encodeURIComponent(name)}`,
            importEligible:
              licence !== null &&
              (file.licenseurl === undefined ||
                archiveLicence(file.licenseurl)?.url === licence.url),
          },
        ];
      })
    : [];
  return {
    id,
    title: text(meta.title),
    artist: text(meta.creator),
    sourceUrl: `https://archive.org/details/${id}`,
    licence,
    rightsNotice: ARCHIVE_RIGHTS_NOTICE,
    files,
  };
}
export async function importArchiveAudio(
  input: {
    ownerId: string;
    id: string;
    file: string;
    rightsReviewed: boolean;
    signal?: AbortSignal;
  },
  fetcher = fetchPublic,
) {
  input.signal?.throwIfAborted();
  if (input.rightsReviewed !== true)
    throw new Error(
      "Review the source, licence and recording/composition rights before importing.",
    );
  // Re-fetch rights and file eligibility on the server; never trust a search
  // card, client licence field, arbitrary URL or previously signed audio URL.
  const item = await inspectArchiveAudio(input.id, fetcher);
  if (!item.licence)
    throw new Error("No unambiguous supported remix licence; reference only.");
  const file = item.files.find((file) => file.name === input.file);
  if (!file || !file.importEligible)
    throw new Error(
      "Selected audio file is unavailable or exceeds the intake limit.",
    );
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(120000)])
    : AbortSignal.timeout(120000);
  const response = await fetcher(file.previewUrl, { signal });
  if (!response.ok || !response.body)
    throw new Error(
      "Archive audio could not be acquired; no library track created.",
    );
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== file.bytes) {
    await response.body.cancel();
    throw new Error("Archive audio length changed; review the item again.");
  }
  const root = await mkdtemp(join(tmpdir(), "wy-archive-"));
  let received = 0;
  const sourceHash = createHash("sha1");
  try {
    const path = join(
      root,
      "audio" + file.name.slice(file.name.lastIndexOf(".")).toLowerCase(),
    );
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        sourceHash.update(chunk);
        done(
          received > file.bytes || received > MAX_UPLOAD_BYTES
            ? new Error("Archive audio exceeded its declared size.")
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream,
      ),
      limit,
      createWriteStream(path),
      { signal },
    );
    const downloadedSha1 = sourceHash.digest("hex");
    if (file.sha1 && downloadedSha1 !== file.sha1)
      throw new Error(
        "Archive file failed the provider SHA-1 integrity check; nothing imported.",
      );
    if (received !== file.bytes)
      throw new Error("Archive audio was truncated; nothing imported.");
    signal.throwIfAborted();
    return await addTrackFromAudioFile({
      ownerId: input.ownerId,
      filePath: path,
      filename: file.name,
      mimeType: (
        {
          ".wav": "audio/wav",
          ".flac": "audio/flac",
          ".mp3": "audio/mpeg",
          ".ogg": "audio/ogg",
          ".m4a": "audio/mp4",
        } as Record<string, string>
      )[file.name.slice(file.name.lastIndexOf(".")).toLowerCase()],
      title: item.title,
      artist: item.artist,
      prepareSeparation: false,
      provenance: {
        method: "authorized-url",
        sourceUrl: item.sourceUrl,
        title: item.title,
        artist: item.artist,
        resolver: "internet-archive-public-audio",
        metadata: {
          provider: "Internet Archive",
          identifier: item.id,
          file: file.name,
          providerSha1: file.sha1,
          downloadedSha1,
          licence: item.licence,
          attribution: `${item.title} — ${item.artist}; ${item.sourceUrl}; ${item.licence.url}. Describe modifications and retain applicable notices on export.`,
          rightsReviewed: true,
          rightsNotice: ARCHIVE_RIGHTS_NOTICE,
          acquiredAt: new Date().toISOString(),
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
