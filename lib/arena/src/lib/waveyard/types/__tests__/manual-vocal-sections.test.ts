import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import { manualVocalSectionSchema, manualVocalSectionSetInputSchema } from "../index";

describe("manual vocal sections", () => {
  it("accepts labeled source ranges and named custom sections", () => {
    expect(manualVocalSectionSchema.safeParse({
      id: "a1a1a1a1-1111-4111-8111-111111111111",
      label: "verse",
      startMs: 20_000,
      endMs: 50_000,
    }).success).toBe(true);
    expect(manualVocalSectionSchema.safeParse({
      id: "a1a1a1a1-1111-4111-8111-111111111112",
      label: "custom",
      title: "Vocal break",
      startMs: 120_000,
      endMs: 152_000,
    }).success).toBe(true);
  });

  it("rejects reversed, empty, unnamed custom, duplicate, or excessive marker sets", () => {
    const valid = {
      id: "a1a1a1a1-1111-4111-8111-111111111111",
      label: "verse" as const,
      title: "",
      startMs: 20_000,
      endMs: 50_000,
    };
    expect(manualVocalSectionSchema.safeParse({ ...valid, endMs: valid.startMs }).success).toBe(false);
    expect(manualVocalSectionSchema.safeParse({ ...valid, label: "custom", title: "" }).success).toBe(false);
    expect(manualVocalSectionSetInputSchema.safeParse({
      expectedRevision: 0,
      sections: [valid, valid],
    }).success).toBe(false);
    expect(manualVocalSectionSetInputSchema.safeParse({
      expectedRevision: 0,
      sections: Array.from({ length: 129 }, (_, index) => ({
        ...valid,
        id: `a1a1a1a1-1111-4111-8111-${String(index).padStart(12, "0")}`,
      })),
    }).success).toBe(false);
  });
});
