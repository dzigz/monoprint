import { tool } from "@openai/agents";
import { z } from "zod";
import { canonicalLanguages, targetLanguagesSchema } from "../src/shared/languages.js";
import { slideCopyMatches } from "../src/shared/slideCopy.js";
import { FONT_ROLE_NAMES, type DeckAsset, type NarrativeUpdate, type SlideCopyItem, type TypographySystem, type DeckColors } from "../src/shared/types.js";
import type { FontEligibility } from "./fontEligibility.js";

export function createFetchFontsTool(fonts: FontEligibility) {
  return tool({
    name: "fetch_fonts",
    description: "Find installed font faces for the target presentation languages/scripts that permit editable PowerPoint embedding. Uses Unicode CLDR main exemplars, actual font embedding permissions, and each face's real character coverage. Supply final text to additionally check exact characters and HarfBuzz shaping. Returns exact font IDs, families, styles, weights, embedding metadata, and pagination. No font files are sent to the image model.",
    parameters: z.object({
      languages: targetLanguagesSchema,
      text: z.string().min(1).max(240000).optional().describe("Actual copy assigned to this font, including names, punctuation, quotations and mixed-language content."),
      family: z.string().trim().min(1).optional().describe("Optional family-name search within compatible fonts."),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    execute: async input => JSON.stringify(await fonts.fetch(input)),
  });
}

function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function sameDesign(left: NarrativeUpdate, right: NarrativeUpdate) {
  return FONT_ROLE_NAMES.every(role => left.typography?.[role] === right.typography?.[role])
    && Object.keys(left.colors ?? {}).every(key => left.colors?.[key as keyof DeckColors] === right.colors?.[key as keyof DeckColors]);
}

/** Owns the font/copy contract across planning, concurrent rendering, and checkpoint recovery. */
export class AuthoringFontPlan {
  languages?: string[];
  private plan?: NarrativeUpdate;
  private renderingStarted: boolean;
  private revision = 0;
  private preflighted = false;

  constructor(private readonly fonts: FontEligibility, restored?: NarrativeUpdate, languages?: string[], private readonly assets: DeckAsset[] = []) {
    this.plan = restored;
    this.languages = restored?.targetLanguages ?? languages;
    this.renderingStarted = assets.length > 0;
  }

  setLanguages(values: string[]) {
    const languages = canonicalLanguages(values);
    if (same(this.languages, languages)) return;
    if (this.renderingStarted && this.languages) throw new Error("Target languages are locked once rendering starts.");
    this.languages = languages;
    this.preflighted = false;
    this.revision++;
  }

  assertUpdateAllowed(update: Partial<NarrativeUpdate>) {
    if (!this.renderingStarted || !this.plan) return;
    if (update.typography && !FONT_ROLE_NAMES.every(role => update.typography?.[role] === this.plan?.typography?.[role])) throw new Error("Typography is locked once rendering starts.");
    if (update.colors && !sameDesign({ ...this.plan, colors: update.colors }, this.plan)) throw new Error("Colors are locked once rendering starts.");
    if (update.targetLanguages && this.languages && !same(canonicalLanguages(update.targetLanguages), this.languages)) throw new Error("Target languages are locked once rendering starts.");
  }

  recordPlanningUpdate(update: Partial<NarrativeUpdate>) {
    this.assertUpdateAllowed(update);
    if (update.targetLanguages) this.setLanguages(update.targetLanguages);
    const proposed = this.plan ? {
      ...this.plan,
      ...(update.typography ? { typography: update.typography } : {}),
      ...(update.colors ? { colors: update.colors } : {}),
    } : undefined;
    if (this.plan && proposed && !sameDesign(this.plan, proposed)) {
      this.plan = undefined;
      this.preflighted = false;
      this.revision++;
    }
  }

  private assertPlanAllowed(candidate: NarrativeUpdate) {
    this.assertUpdateAllowed(candidate);
    if (!this.renderingStarted || !this.plan) return;
    if (candidate.slides?.length !== this.plan.slides?.length || candidate.slides?.some((slide, i) => slide.slideId !== this.plan?.slides?.[i]?.slideId)) {
      throw new Error("Slide order is locked once rendering starts.");
    }
    for (const slide of candidate.slides ?? []) {
      const prior = this.plan.slides?.find(item => item.slideId === slide.slideId)?.copy
        ?? this.assets.find(asset => asset.slideId === slide.slideId)?.copy;
      if (prior?.length && (!slide.copy || !slideCopyMatches(prior, slide.copy))) throw new Error(`Copy for ${slide.slideId} is locked once rendering starts.`);
    }
  }

  async accept(candidate: NarrativeUpdate) {
    const languages = candidate.targetLanguages ?? this.languages;
    if (!languages?.length) throw new Error("Report targetLanguages in framing before ready_to_render.");
    if (!candidate.typography || !candidate.colors || !candidate.slides?.length || candidate.slides.some(slide => !slide.copy?.length || slide.copy.some(item => !item.fontRole))) {
      throw new Error("ready_to_render requires final typography, colors, and complete role-labelled copy with fontRole for every slide.");
    }
    const accepted = structuredClone({ ...candidate, targetLanguages: canonicalLanguages(languages) });
    this.assertPlanAllowed(accepted);
    const revision = this.revision;
    await this.fonts.validate(accepted.targetLanguages, candidate.typography, candidate.slides);
    if (revision !== this.revision) throw new Error("The language or render plan changed during font preflight. Submit the current plan again.");
    this.assertPlanAllowed(accepted);
    this.plan = accepted;
    this.languages = accepted.targetLanguages;
    this.preflighted = true;
    this.revision++;
    return accepted;
  }

  async beforeImage(slideNumber: number, slideId: string, copy: SlideCopyItem[]) {
    const plan = this.plan, slide = plan?.slides?.[slideNumber - 1];
    if (!this.languages?.length || !plan?.typography || !slide?.copy?.length || !same(this.languages, plan.targetLanguages)) {
      throw new Error("Submit a complete ready_to_render plan with targetLanguages and final copy for font preflight before generating new images. Older checkpoint images remain reusable.");
    }
    if (slide.slideId !== slideId || !slideCopyMatches(slide.copy, copy)) throw new Error(`Image copy for ${slideId} must exactly match the accepted ready_to_render plan.`);
    const revision = this.revision;
    // Resuming revalidates every slide against the currently installed font bytes.
    await this.fonts.validate(this.languages, plan.typography, this.preflighted ? [{ slideId, copy }] : plan.slides!);
    if (revision !== this.revision) throw new Error("The plan changed during image preflight. Retry with the accepted plan.");
    this.preflighted = true;
    this.renderingStarted = true;
  }

  assertPublishedDesign(typography: TypographySystem, colors: DeckColors) {
    if (!this.plan?.typography) return; // Historical checkpoints without a structured design.
    if (!sameDesign(this.plan, { ...this.plan, typography: Object.fromEntries(FONT_ROLE_NAMES.map(role => [role, typography[role].fontId])) as NarrativeUpdate["typography"], colors })) {
      throw new Error("Publication must preserve the typography and colors accepted before rendering.");
    }
    // Legacy runs did not promise exact face metadata; keep their completed assets publishable.
    if (!this.plan.targetLanguages || this.plan.slides?.some(slide => !slide.copy?.length)) return;
    for (const role of FONT_ROLE_NAMES) {
      const face = this.fonts.describe(typography[role].fontId);
      if (typography[role].family !== face.family || typography[role].weight !== face.weight || typography[role].style !== (face.italic ? "italic" : "normal")) {
        throw new Error(`Publish the exact face returned by fetch_fonts for ${role}: ${JSON.stringify(face)}. Select a separate catalog face for a different weight or italic.`);
      }
    }
  }

  promptSpecification() {
    if (!this.plan?.typography) return "";
    return `Use these exact font faces for all canonical copy; do not synthesize other weights or italics: ${JSON.stringify(Object.fromEntries(FONT_ROLE_NAMES.map(role => [role, this.fonts.describe(this.plan!.typography![role])])))}`;
  }
}
