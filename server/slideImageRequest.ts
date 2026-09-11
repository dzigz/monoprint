import { readFile } from "node:fs/promises";
import OpenAI, { toFile } from "openai";
import { z } from "zod";
import { MAX_SOURCE_VISUALS, type PreparedVisual } from "./documentVisuals.js";
import { SLIDE_IMAGE_SETTINGS } from "./slideImageSettings.js";

export const sourceVisualSelectionSchema = z.array(z.object({
  visualId: z.string().min(1),
  instruction: z.string().trim().min(1).max(2000).describe("How to use this source image on the new slide: what content to retain, its role, and any requested changes."),
})).max(MAX_SOURCE_VISUALS).refine(items => new Set(items.map(i => i.visualId)).size === items.length, "Select each source visual only once.");
export type SourceVisualSelection = z.infer<typeof sourceVisualSelectionSchema>[number];
export type SourceVisualInput = PreparedVisual & { instruction: string };

export function fullSlidePrompt(prompt: string, styleReferenceCount: number, sources: SourceVisualInput[] = []) {
  return [
    "Create one complete, polished presentation slide as a single full-bleed landscape image.",
    "This is the actual slide artwork, not a slide shown inside a mockup, screen, device, editor, or room.",
    "Compose across the full native 1536x864 (16:9) canvas. Keep essential words and visuals within comfortable slide-safe margins; the viewer will preserve the entire image without cropping.",
    "Treat the slide as editorial information design: the visual structure and exact words must together communicate a specific relationship, mechanism, comparison, change, piece of evidence, or consequence. Make the focal idea immediately recoverable and keep supporting context quiet.",
    "Do not add generic AI-presentation styling such as automatic dark-neon technology aesthetics, glowing networks or orbs, glassmorphism, floating 3D icons, decorative data particles, arbitrary gradients, or dashboard-card grids unless the production specification gives that device a necessary content-specific role.",
    ...sources.map((source, i) => `Input image ${i + 1} is SOURCE CONTENT from ${JSON.stringify(source.name)}, ${source.locator}. Use it according to this instruction: ${source.instruction}`),
    styleReferenceCount > 0
      ? `Input image${styleReferenceCount > 1 ? "s" : ""} ${Array.from({ length: styleReferenceCount }, (_, i) => sources.length + i + 1).join(" and ")} ${styleReferenceCount > 1 ? "are" : "is"} earlier slide artwork supplied only as deck-level STYLE REFERENCES. Preserve the established typography character, palette, background treatment, medium, texture, line quality, and recurring visual grammar. Do not copy or retain style-reference-slide wording, data, subject matter, objects, or layout; create the new slide specified below. This style-only restriction does not apply to the source-content images identified above.`
      : undefined,
    "Render typography cleanly and exactly as specified. Add no unrequested text, logos, watermarks, page furniture, or UI chrome.",
    prompt,
  ].filter(Boolean).join("\n\n");
}

/** Actual source pixels and style anchors share one ordered multipart image request. */
export async function requestSlideImage(
  images: Pick<OpenAI["images"], "generate" | "edit">,
  prompt: string,
  stylePaths: string[],
  sources: SourceVisualInput[],
  signal?: AbortSignal,
) {
  if (sources.length > MAX_SOURCE_VISUALS || sources.length + stylePaths.length > 16) throw new Error("Too many image references for one slide.");
  signal?.throwIfAborted();
  const completePrompt = fullSlidePrompt(prompt, stylePaths.length, sources);
  const settings = { ...SLIDE_IMAGE_SETTINGS, prompt: completePrompt, size: "1536x864" as const, output_format: "png" as const };
  if (!stylePaths.length && !sources.length) return images.generate(settings, { signal });
  const files = await Promise.all([
    ...sources.map(async (source, i) => toFile(await readFile(source.path), `source-${i + 1}.png`, { type: "image/png" })),
    ...stylePaths.map(async (file, i) => toFile(await readFile(file), `style-${i + 1}.png`, { type: "image/png" })),
  ]);
  signal?.throwIfAborted();
  return images.edit({ ...settings, image: files }, { signal });
}
