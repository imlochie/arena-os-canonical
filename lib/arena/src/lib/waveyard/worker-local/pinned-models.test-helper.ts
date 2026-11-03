import assert from "node:assert/strict";
import { copyFile, link, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checksumFile } from "../audio";
import { findMdxModel, type MdxModelSpec } from "../separation/mdx";

export const FOUR_STEM_MODELS = [
  "kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other",
].map((id) => findMdxModel(id)!);

/** Shared real-weight setup; never supplies an inference/model substitute. */
export async function stagePinnedModels(
  installedDirectory: string,
  privateDirectory: string,
  models: readonly MdxModelSpec[] = FOUR_STEM_MODELS,
) {
  await mkdir(privateDirectory, { recursive: true });
  for (const model of models) {
    const source = join(installedDirectory, model.file);
    assert.equal(await checksumFile(source), model.sha256, `${model.id} must match its registry checksum`);
    try {
      await link(source, join(privateDirectory, model.file));
    } catch {
      await copyFile(source, join(privateDirectory, model.file));
    }
  }
}
