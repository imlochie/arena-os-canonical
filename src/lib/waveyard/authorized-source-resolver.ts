export type AuthorizedSourceResolution = {
  audioUrl: string;
  filename: string;
  mimeType?: string;
  title?: string;
  artist?: string;
  resolver: string;
  metadata?: Record<string, unknown>;
};

export type AuthorizedSourceResolver = { resolve: (sourceUrl: string) => Promise<AuthorizedSourceResolution> };

export function validateAuthorizedSourceUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return /^https?:$/.test(url.protocol) && Boolean(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

/**
 * Waveyard never scrapes platforms, accepts user credentials, or bypasses DRM.
 * A deployment must configure a compliant resolver that returns an authorized,
 * temporary audio URL for material the user can lawfully provide.
 */
export function configuredAuthorizedSourceResolver(fetcher: typeof fetch = fetch): AuthorizedSourceResolver | null {
  const endpoint = process.env.AUTHORIZED_SOURCE_RESOLVER_URL;
  if (!endpoint) return null;
  return {
    async resolve(sourceUrl) {
      const response = await fetcher(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceUrl }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.authorized !== true || typeof body.audioUrl !== "string" || typeof body.filename !== "string")
        throw new Error(typeof body.error === "string" ? body.error : "The authorized resolver could not acquire this source.");
      const audioUrl = validateAuthorizedSourceUrl(body.audioUrl);
      if (!audioUrl) throw new Error("The authorized resolver returned an invalid audio location.");
      return { audioUrl, filename: body.filename, mimeType: typeof body.mimeType === "string" ? body.mimeType : undefined, title: typeof body.title === "string" ? body.title : undefined, artist: typeof body.artist === "string" ? body.artist : undefined, resolver: endpoint, metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined };
    },
  };
}
