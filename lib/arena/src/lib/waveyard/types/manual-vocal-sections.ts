import { z } from "zod/v4";

export const MANUAL_VOCAL_SECTION_LABELS = [
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "breakdown",
  "outro",
  "custom",
] as const;

export const manualVocalSectionSchema = z.object({
  id: z.string().uuid(),
  label: z.enum(MANUAL_VOCAL_SECTION_LABELS),
  title: z.string().trim().max(80).default(""),
  startMs: z.number().int().min(0),
  endMs: z.number().int().positive(),
}).strict().superRefine((section, context) => {
  if (section.endMs <= section.startMs) {
    context.addIssue({
      code: "custom",
      path: ["endMs"],
      message: "A vocal section must end after it starts.",
    });
  }
  if (section.label === "custom" && !section.title.trim()) {
    context.addIssue({
      code: "custom",
      path: ["title"],
      message: "Name a custom vocal section.",
    });
  }
});

export const manualVocalSectionSetInputSchema = z.object({
  expectedRevision: z.number().int().min(0),
  confirmCurrentAudio: z.boolean().optional().default(false),
  sections: z.array(manualVocalSectionSchema).max(128),
}).strict().superRefine((set, context) => {
  const seen = new Set<string>();
  set.sections.forEach((section, index) => {
    if (seen.has(section.id)) {
      context.addIssue({
        code: "custom",
        path: ["sections", index, "id"],
        message: "Vocal-section IDs must be unique.",
      });
    }
    seen.add(section.id);
  });
});

export type ManualVocalSection = z.infer<typeof manualVocalSectionSchema>;
export type ManualVocalSectionLabel = (typeof MANUAL_VOCAL_SECTION_LABELS)[number];
export type ManualVocalSectionSetInput = z.infer<typeof manualVocalSectionSetInputSchema>;

export function manualVocalSectionLabel(section: Pick<ManualVocalSection, "label" | "title">) {
  return section.label === "custom" ? section.title.trim() : section.label;
}
