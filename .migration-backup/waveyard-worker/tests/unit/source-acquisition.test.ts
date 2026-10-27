import { describe, expect, it } from "vitest";
import { buildStageFor, summariseSourceIntake } from "@waveyard/types";
import { validateAuthorizedSourceUrl, type AuthorizedSourceResolver } from "../../apps/web/src/lib/authorized-source-resolver";

describe("unified source acquisition", () => {
  it("accepts local-only, URL-only, and mixed intake without making a second source model", () => {
    expect(summariseSourceIntake({ localFileCount: 2, urls: [] })).toMatchObject({ requestedCount: 2, distinctUrls: [] });
    expect(summariseSourceIntake({ localFileCount: 0, urls: ["https://youtube.com/watch?v=one", "https://youtube.com/watch?v=two"] })).toMatchObject({ requestedCount: 2, distinctUrls: ["https://youtube.com/watch?v=one", "https://youtube.com/watch?v=two"] });
    expect(summariseSourceIntake({ localFileCount: 2, urls: ["https://example.test/audio"] })).toMatchObject({ requestedCount: 3 });
  });

  it("deduplicates repeated URLs while keeping invalid URLs explicit", () => {
    const summary = summariseSourceIntake({ localFileCount: 0, urls: ["https://youtube.com/watch?v=one", "https://youtube.com/watch?v=one", "not a url", "ftp://unsupported.example/file"] });
    expect(summary).toEqual({ requestedCount: 3, distinctUrls: ["https://youtube.com/watch?v=one"], invalidUrls: ["not a url", "ftp://unsupported.example/file"] });
  });

  it("uses an injectable authorized resolver rather than platform scraping", async () => {
    const fake: AuthorizedSourceResolver = { resolve: async (sourceUrl) => ({ audioUrl: "https://resolver.example/audio.mp3", filename: "authorized.mp3", title: "Authorized track", resolver: "fake", metadata: { sourceUrl } }) };
    expect(validateAuthorizedSourceUrl("https://youtube.com/watch?v=one")).toBe("https://youtube.com/watch?v=one");
    expect(validateAuthorizedSourceUrl("ftp://not-supported.example/file")).toBeNull();
    await expect(fake.resolve("https://youtube.com/watch?v=one")).resolves.toMatchObject({ filename: "authorized.mp3", resolver: "fake" });
  });

  it("keeps progress language meaningful and deterministic", () => {
    expect(buildStageFor({ acceptedSources: 2, failedSources: 0, processing: true, analysesReady: false, arrangementReady: false })).toBe("separating");
    expect(buildStageFor({ acceptedSources: 2, failedSources: 0, processing: false, analysesReady: false, arrangementReady: false })).toBe("understanding");
    expect(buildStageFor({ acceptedSources: 2, failedSources: 0, processing: false, analysesReady: true, arrangementReady: false })).toBe("building");
    expect(buildStageFor({ acceptedSources: 2, failedSources: 0, processing: false, analysesReady: true, arrangementReady: true })).toBe("ready");
    expect(buildStageFor({ acceptedSources: 1, failedSources: 1, processing: false, analysesReady: true, arrangementReady: true })).toBe("ready");
    expect(buildStageFor({ acceptedSources: 0, failedSources: 2, processing: false, analysesReady: false, arrangementReady: false })).toBe("failed");
  });
});
