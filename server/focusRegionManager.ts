import path from "node:path";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { canLocateFocus, focusInputKey, parseFocusCues, validateFocusRegions } from "../src/shared/focusRegions.js";
import type { Deck, FocusRegion, Slide, SlideFocusRegions } from "../src/shared/types.js";
import type { DeckMutations } from "./deckMutations.js";
import type { DeckStore } from "./deckStore.js";
import { FOCUS_MODEL, locateFocusRegions } from "./focusRegions.js";

type Work = { deckId: string; slideId: string; inputKey: string; image?: string };
type Options = {
  locate?: (slide: Slide, image: string) => Promise<FocusRegion[]>;
  readImage?: (deck: Deck, slide: Slide) => Promise<string>;
  concurrency?: number;
};

export class FocusInputError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

/** A per-slide background call, independent of the author and text recovery.
 * Only source-matching results are saved. Persisted failures require a retry;
 * queued/running jobs resume when a deck is opened after a server restart. */
export class FocusRegionManager {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly work = new Map<string, Work>();
  private readonly queue: Work[] = [];
  private running = 0;
  private disposed = false;
  private readonly locate: NonNullable<Options["locate"]>;
  private readonly readImage: NonNullable<Options["readImage"]>;
  private readonly concurrency: number;

  constructor(private readonly store: Pick<DeckStore, "assetPath">, private readonly mutations: Pick<DeckMutations, "load" | "mutate">, options: Options = {}) {
    this.locate = options.locate ?? locateFocusRegions;
    this.readImage = options.readImage ?? ((deck, slide) => this.readSlideImage(deck, slide));
    this.concurrency = options.concurrency ?? 2;
  }

  schedule(deckId: string) {
    if (this.disposed) return;
    clearTimeout(this.timers.get(deckId));
    const timer = setTimeout(() => {
      this.timers.delete(deckId);
      void this.ensureDeck(deckId).catch(() => console.error(`Could not schedule highlights for deck ${deckId}.`));
    }, 900);
    timer.unref();
    this.timers.set(deckId, timer);
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  async ensureDeck(deckId: string): Promise<Deck> {
    return this.mutations.mutate(deckId, (deck) => {
      let changed = false;
      const slides = deck.slides.map((slide) => {
        if (!canLocateFocus(slide) || !parseFocusCues(slide.talkingPoints).length) return slide;
        const inputKey = focusInputKey(deck, slide);
        const current = slide.focusRegions;
        const work = { deckId, slideId: slide.id, inputKey };
        if (this.work.has(this.workId(work))) return slide;
        if (current?.inputKey === inputKey) {
          if (current.status === "failed" || current.status === "waiting_snapshot") return slide;
          if (current.status === "ready") {
            try { validateFocusRegions(current.regions, parseFocusCues(slide.talkingPoints), slide.canvas); return slide; }
            catch { /* Replace invalid cached geometry using the same inputs. */ }
          }
        }
        changed = true;
        if (slide.state !== "edited") this.enqueue(work);
        return { ...slide, focusRegions: this.state(inputKey, slide.state === "edited" ? "waiting_snapshot" : "queued") };
      });
      return changed ? { ...deck, slides } : deck;
    }).finally(() => this.pump());
  }

  /** Snapshot requests are accepted only for exactly the saved visual inputs.
   * Multiple tabs and repeated requests share the same job. */
  async request(deckId: string, slideId: string, inputKey: string, image?: string, retry = false) {
    let snapshot: string | undefined;
    if (image) {
      const deck = await this.mutations.load(deckId);
      const slide = this.requireInput(deck, slideId, inputKey);
      snapshot = await validateFocusSnapshot(image, slide.canvas);
    }
    return this.mutations.mutate(deckId, (deck) => {
      const slide = this.requireInput(deck, slideId, inputKey);
      const work: Work = { deckId, slideId, inputKey, image: snapshot };
      if (this.work.has(this.workId(work))) return deck;
      if (slide.focusRegions?.inputKey === inputKey
        && (slide.focusRegions.status === "ready" || (slide.focusRegions.status === "failed" && !retry))) return deck;
      const needsSnapshot = slide.state === "edited" && !snapshot;
      if (!needsSnapshot) this.enqueue(work);
      return { ...deck, slides: deck.slides.map((candidate) => candidate.id === slideId
        ? { ...candidate, focusRegions: this.state(inputKey, needsSnapshot ? "waiting_snapshot" : "queued") }
        : candidate) };
    }).finally(() => this.pump());
  }

  private requireInput(deck: Deck, slideId: string, inputKey: string) {
    const slide = deck.slides.find((candidate) => candidate.id === slideId);
    if (!slide) throw new FocusInputError("Slide not found.", 404);
    if (!canLocateFocus(slide) || !parseFocusCues(slide.talkingPoints).length || focusInputKey(deck, slide) !== inputKey) {
      throw new FocusInputError("The slide changed. Highlights will use the latest saved version.");
    }
    return slide;
  }

  private state(inputKey: string, status: SlideFocusRegions["status"], regions: FocusRegion[] = [], error?: string): SlideFocusRegions {
    return { inputKey, status, regions, updatedAt: new Date().toISOString(), model: FOCUS_MODEL, ...(error ? { error } : {}) };
  }

  private workId(work: Work) { return JSON.stringify([work.deckId, work.slideId, work.inputKey]); }
  private enqueue(work: Work) {
    this.work.set(this.workId(work), work);
    this.queue.push(work);
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const work = this.queue.shift()!;
      this.running++;
      void this.run(work).catch(() => console.error(`Could not save highlights for ${work.slideId}.`)).finally(() => {
        this.work.delete(this.workId(work));
        this.running--;
        this.pump();
        this.schedule(work.deckId);
      });
    }
  }

  private async run(work: Work) {
    try {
      const deck = await this.mutations.mutate(work.deckId, (deck) => {
        const slide = this.requireInput(deck, work.slideId, work.inputKey);
        return { ...deck, slides: deck.slides.map((candidate) => candidate.id === slide.id
          ? { ...candidate, focusRegions: this.state(work.inputKey, "running") } : candidate) };
      });
      const slide = this.requireInput(deck, work.slideId, work.inputKey);
      const image = work.image ?? await this.readImage(deck, slide);
      // Image IO may outlast an edit. Check again before making a paid call.
      this.requireInput(await this.mutations.load(work.deckId), work.slideId, work.inputKey);
      const regions = validateFocusRegions(await this.locate(slide, image), parseFocusCues(slide.talkingPoints), slide.canvas);
      await this.finish(work, this.state(work.inputKey, "ready", regions));
    } catch (error) {
      if (error instanceof FocusInputError) return;
      console.error(`Highlight generation failed for ${work.slideId} (${error instanceof Error ? error.name : "unknown error"}).`);
      await this.finish(work, this.state(work.inputKey, "failed", [], "Could not generate highlights. You can retry without regenerating the slide."));
    }
  }

  private async finish(work: Work, focusRegions: SlideFocusRegions) {
    await this.mutations.mutate(work.deckId, (deck) => {
      const slide = deck.slides.find((candidate) => candidate.id === work.slideId);
      if (!slide || !canLocateFocus(slide) || focusInputKey(deck, slide) !== work.inputKey) return deck;
      return { ...deck, slides: deck.slides.map((candidate) => candidate.id === slide.id ? { ...candidate, focusRegions } : candidate) };
    });
  }

  private async readSlideImage(deck: Deck, slide: Slide) {
    const asset = deck.assets.find((candidate) => candidate.id === slide.assetId && candidate.slideId === slide.id);
    const prefix = `/api/assets/${deck.id}/`;
    if (!asset?.url.startsWith(prefix)) throw new Error("Missing local slide image.");
    const name = decodeURIComponent(asset.url.slice(prefix.length));
    if (path.basename(name) !== name) throw new Error("Invalid slide image path.");
    const data = await readFile(this.store.assetPath(deck.id, name));
    const image = sharp(data, { limitInputPixels: 40_000_000 });
    const metadata = await image.metadata();
    if (metadata.width !== slide.canvas.width || metadata.height !== slide.canvas.height) throw new Error("Slide image dimensions do not match the canvas.");
    return `data:image/png;base64,${(await image.png().toBuffer()).toString("base64")}`;
  }
}

export async function validateFocusSnapshot(image: string, canvas: Slide["canvas"]) {
  if (image.length > 40_000_000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new FocusInputError("Expected a PNG slide snapshot smaller than 30 MB.", 400);
  try {
    const decoded = sharp(Buffer.from(image.slice(image.indexOf(",") + 1), "base64"), { limitInputPixels: 40_000_000 });
    const metadata = await decoded.metadata();
    if (metadata.format !== "png" || metadata.width !== canvas.width || metadata.height !== canvas.height) throw new Error("Wrong dimensions.");
    return `data:image/png;base64,${(await decoded.png().toBuffer()).toString("base64")}`;
  } catch { throw new FocusInputError("Snapshot dimensions must match the slide canvas.", 400); }
}
