const MAX_CONTROL_ITEMS = 8;
const MAX_CONTROL_LENGTH = 180;

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => {
      const point = parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    });
}

function cleanInstructions(value: string): string[] | null {
  const items = value
    .replace(/<[^>]*>/g, " ")
    .split("|")
    .map((item) => decodeEntities(item).replace(/\s+/g, " ").trim().slice(0, MAX_CONTROL_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_CONTROL_ITEMS);
  return items.length ? items : null;
}

/** Reads only instructions explicitly embedded in this game's HTML source. */
export function readArcadeGameControls(source: unknown): string[] | null {
  if (typeof source !== "string") return null;

  const metadataTag = source.match(/<meta\b(?=[^>]*\bname\s*=\s*["']arena-controls["'])[^>]*>/i)?.[0];
  if (metadataTag) {
    const content = metadataTag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    const instructions = content ? cleanInstructions(content) : null;
    if (instructions) return instructions;
  }

  // Older offline templates rendered their exact controls in a dedicated help block.
  const legacyHelp = source.match(/<div\b(?=[^>]*\bclass\s*=\s*["']help["'])[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  return legacyHelp ? cleanInstructions(legacyHelp.replace(/<br\s*\/?>/gi, " | ")) : null;
}
