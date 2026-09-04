// Repaint one slide: build a fresh production prompt from the slide's current
// text and the user's instruction, render it with the image model using the
// current slide and the first slide as style anchors, then store the result as
// the slide's next version and hand it back to text recovery.

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { toFile } from "openai";
import { appendRoleLabeledCopyBlock, ROLE_LABELED_COPY_HEADING } from "../src/shared/slideCopy.js";
import type { Deck, DeckAsset, RepaintJob, Slide, SlideCopyItem } from "../src/shared/types.js";
import type { DeckMutations } from "./deckMutations.js";
import type { DeckStore } from "./deckStore.js";
import { getOpenAIClient } from "./openaiClient.js";
import { imageDimensions } from "./recovery/plate.js";

export function copyFromSlide(slide: Slide): SlideCopyItem[] {
  if (slide.layers?.objects.length) {
    return slide.layers.objects
      .filter((object) => object.kind === "text" && object.text.trim())
      .map((object, index) => ({
        role: object.copyRole ?? `Text ${index + 1}`,
        text: object.text.replace(/\s*\n\s*/g, " ").trim(),
        fontRole: object.style.fontRole,
      }));
  }
  return slide.copy;
}

function stripCopyBlock(prompt: string) {
  const index = prompt.indexOf(ROLE_LABELED_COPY_HEADING);
  return (index >= 0 ? prompt.slice(0, index) : prompt).trim();
}

export function buildRepaintPrompt(deck: Deck, slide: Slide, instruction: string, copy: SlideCopyItem[]) {
  const asset = deck.assets.find((candidate) => candidate.id === slide.assetId);
  const original = asset ? stripCopyBlock(asset.prompt) : "";
  const typography = deck.designSystem.typography;
  const colors = deck.designSystem.colors;
  const base = [
    original || `Create one complete professional ${slide.canvas.width}x${slide.canvas.height} presentation slide titled "${slide.title}". ${slide.purpose}`,
    "",
    "REVISION OF AN EXISTING SLIDE",
    `The user asked for this change: ${instruction.trim()}`,
    "Keep everything the instruction does not mention: the same design system, background treatment, palette, typography roles, and overall composition logic. The input images are the current version of this slide and the deck's first slide; they are style references only. Apply the change fully rather than hinting at it.",
    `Design system: display ${typography.display.family}, heading ${typography.heading.family}, body ${typography.body.family}, label ${typography.label.family}. Colors: background ${colors.background}, surface ${colors.surface}, text ${colors.text}, muted ${colors.mutedText}, accent ${colors.accent}, accent text ${colors.accentText}, border ${colors.border}.`,
    `Compose across the full ${slide.canvas.width}x${slide.canvas.height} canvas with comfortable margins. Crisp readable typography; no unrequested text, logos, watermarks, or UI chrome.`,
  ].join("\n");
  return appendRoleLabeledCopyBlock(base, copy);
}

export class RepaintManager {
  private readonly jobs = new Map<string, RepaintJob>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: DeckStore,
    private readonly mutations: DeckMutations,
    private readonly onRepainted: (deckId: string, slideId: string) => Promise<void>,
  ) {}

  job(deckId: string) {
    return this.jobs.get(deckId);
  }

  async start(deckId: string, slideId: string, instruction: string) {
    const existing = this.jobs.get(deckId);
    if (existing && (existing.status === "queued" || existing.status === "running")) {
      throw new Error("A repaint is already running for this deck.");
    }
    const now = new Date().toISOString();
    const job: RepaintJob = {
      id: randomUUID(),
      deckId,
      slideId,
      instruction,
      status: "queued",
      message: "Preparing the repaint.",
      startedAt: now,
      updatedAt: now,
    };
    await this.setJob(job);
    const controller = new AbortController();
    this.controllers.set(deckId, controller);
    void this.run(job, controller.signal).finally(() => {
      if (this.controllers.get(deckId) === controller) this.controllers.delete(deckId);
    });
    return job;
  }

  async cancel(deckId: string) {
    this.controllers.get(deckId)?.abort(new Error("Repaint stopped by the user."));
    return this.jobs.get(deckId);
  }

  private async setJob(job: RepaintJob) {
    this.jobs.set(job.deckId, job);
    await this.store.saveRepaintJob(job);
    this.mutations.emit(job.deckId, { type: "repaint", job });
  }

  private async update(deckId: string, changes: Partial<RepaintJob>) {
    const current = this.jobs.get(deckId);
    if (!current) return;
    await this.setJob({ ...current, ...changes, updatedAt: new Date().toISOString() });
  }

  private async run(job: RepaintJob, signal: AbortSignal) {
    const { deckId, slideId } = job;
    try {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
      const deck = await this.mutations.load(deckId);
      const slide = deck.slides.find((candidate) => candidate.id === slideId);
      if (!slide) throw new Error("Unknown slide.");
      const currentAsset = deck.assets.find((asset) => asset.id === slide.assetId);
      const firstAsset = deck.assets.find((asset) => asset.id === deck.slides[0]?.assetId);
      if (!currentAsset) throw new Error("The slide has no image to repaint from.");

      const copy = copyFromSlide(slide);
      const prompt = buildRepaintPrompt(deck, slide, job.instruction, copy);
      await this.update(deckId, { status: "running", message: "Painting the new version of the slide." });

      const references = [currentAsset, ...(firstAsset && firstAsset.id !== currentAsset.id ? [firstAsset] : [])];
      const openai = getOpenAIClient();
      const images = await Promise.all(references.map((asset) => toFile(
        createReadStream(this.store.assetPath(deckId, path.basename(asset.url))),
        path.basename(asset.url),
        { type: "image/png" },
      )));
      const response = await openai.images.edit({
        model: "gpt-image-2",
        image: images,
        prompt,
        size: `${slide.canvas.width}x${slide.canvas.height}` as "1536x864",
        quality: "high",
      }, { signal });
      const encoded = response.data?.[0]?.b64_json;
      if (!encoded) throw new Error("Image generation returned no data.");

      const assetId = randomUUID();
      const fileName = `${assetId}.png`;
      const filePath = this.store.assetPath(deckId, fileName);
      await writeFile(filePath, Buffer.from(encoded, "base64"));
      const dimensions = await imageDimensions(filePath);
      const asset: DeckAsset = {
        id: assetId,
        kind: "slide-image",
        slideId,
        url: `/api/assets/${deckId}/${fileName}`,
        prompt,
        copy,
        alt: `${slide.title} (repainted)`,
        width: dimensions.width,
        height: dimensions.height,
      };

      await this.mutations.mutate(deckId, (current) => ({
        ...current,
        assets: [...current.assets, asset],
        slides: current.slides.map((candidate) => candidate.id !== slideId ? candidate : {
          ...candidate,
          assetId,
          copy,
          canvas: { width: dimensions.width, height: dimensions.height },
          state: "generated",
          layers: undefined,
          recovery: { status: "pending", message: "Repainted; text recovery pending.", updatedAt: new Date().toISOString() },
          version: candidate.version + 1,
          history: [...candidate.history, { version: candidate.version + 1, assetId, reason: "repainted", createdAt: new Date().toISOString() }],
        }),
      }));
      await this.update(deckId, { status: "completed", message: "Slide repainted. Recovering its text." });
      await this.onRepainted(deckId, slideId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Repaint failed.";
      console.error(`Repaint failed for slide ${slideId} of deck ${deckId}:`, error);
      await this.update(deckId, {
        status: signal.aborted ? "cancelled" : "failed",
        message: signal.aborted ? "Repaint stopped." : "The repaint failed.",
        error: signal.aborted ? undefined : message,
      });
    }
  }
}
