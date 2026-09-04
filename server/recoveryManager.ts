// Recovery queue. Slides enter as soon as their image is painted (before the
// deck document exists) or later from a published deck. The pipeline is
// single-threaded by design, so items run one at a time in arrival order.
// Results attach to the published slide when there is one, otherwise they
// wait as records that publication picks up.

import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AssetRecoveryInput,
  AssetRecoveryRecord,
  Deck,
  DeckAsset,
  DeckColors,
  PlannedTypography,
  RecoveryJob,
  RecoveryStatus,
  Slide,
} from "../src/shared/types.js";
import { FONT_ROLE_NAMES } from "../src/shared/types.js";
import type { DeckMutations } from "./deckMutations.js";
import type { DeckStore } from "./deckStore.js";
import type { FontRegistry } from "./fonts.js";
import type { RecoveryFontInput, RecoveryResult, SlideRecoveryProvider } from "./recovery/provider.js";

type QueueItem = {
  deckId: string;
  slideId: string;
  assetId: string;
  /** Present when the slide was painted but the deck is not published yet. */
  pending?: AssetRecoveryInput;
  /** Run the pipeline again instead of reusing its finished run. */
  fresh?: boolean;
};

export type RecoveryStatusListener = (deckId: string, slideId: string, status: RecoveryStatus, message?: string) => Promise<void> | void;

export class RecoveryManager {
  private readonly queue: QueueItem[] = [];
  private readonly jobs = new Map<string, RecoveryJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly statusListeners: RecoveryStatusListener[] = [];
  private current?: QueueItem;
  private working = false;

  constructor(
    private readonly store: DeckStore,
    private readonly mutations: DeckMutations,
    private readonly fonts: FontRegistry,
    private readonly provider: SlideRecoveryProvider,
  ) {}

  onStatus(listener: RecoveryStatusListener) {
    this.statusListeners.push(listener);
  }

  job(deckId: string) {
    return this.jobs.get(deckId);
  }

  private isQueued(deckId: string, assetId: string) {
    return (this.current?.deckId === deckId && this.current.assetId === assetId)
      || this.queue.some((item) => item.deckId === deckId && item.assetId === assetId);
  }

  /** Recover one painted slide right away, before the deck is published. */
  async enqueueAsset(input: AssetRecoveryInput) {
    if (this.isQueued(input.deckId, input.asset.id)) return;
    this.queue.push({ deckId: input.deckId, slideId: input.slideId, assetId: input.asset.id, pending: input });
    await this.notify(input.deckId, input.slideId, "queued", "Waiting for the text pipeline.");
    await this.touchJob(input.deckId, [input.slideId]);
    void this.work();
  }

  /** Queue slides of a published deck. Skips slides already recovered unless forced. */
  async enqueue(deckId: string, slideIds?: string[], { force = false, fresh = false }: { force?: boolean; fresh?: boolean } = {}) {
    const deck = await this.mutations.mutate(deckId, (current) => {
      const targets = new Set(slideIds ?? current.slides.map((slide) => slide.id));
      const now = new Date().toISOString();
      return {
        ...current,
        slides: current.slides.map((slide) => {
          if (!targets.has(slide.id)) return slide;
          const alreadyDone = slide.recovery.status === "recovered" && slide.layers;
          const inFlight = this.isQueued(deckId, slide.assetId);
          if (alreadyDone && !force) return slide;
          if (inFlight) {
            const running = this.current?.deckId === deckId && this.current.assetId === slide.assetId;
            return { ...slide, recovery: { ...slide.recovery, status: running ? "running" : "queued", message: running ? "In the text pipeline." : "Waiting for the text pipeline.", updatedAt: now, provider: this.provider.name } };
          }
          return { ...slide, recovery: { status: "queued", message: "Waiting for the text pipeline.", updatedAt: now, provider: this.provider.name } };
        }),
      };
    });
    const queued = deck.slides.filter((slide) => slide.recovery.status === "queued" && !this.isQueued(deckId, slide.assetId));
    for (const slide of queued) this.queue.push({ deckId, slideId: slide.id, assetId: slide.assetId, fresh });
    const job = await this.touchJob(deckId, queued.map((slide) => slide.id));
    void this.work();
    return job;
  }

  /** Attach recovery records that finished before the deck was published. */
  async attachPending(deckId: string) {
    const records = await this.store.listAssetRecoveries(deckId);
    if (!records.length) return;
    const attached: string[] = [];
    await this.mutations.mutate(deckId, (current) => {
      let next = current;
      for (const record of records) {
        const slide = next.slides.find((candidate) => candidate.assetId === record.assetId);
        if (!slide) continue;
        next = attachRecord(next, slide.id, record);
        attached.push(record.assetId);
      }
      return next;
    });
    for (const assetId of attached) await this.store.deleteAssetRecovery(deckId, assetId);
  }

  /** After a restart, slides left in running or queued states go back into the queue. */
  async recoverStale() {
    const health = await this.provider.health();
    if (!health.available) return;
    for (const deckId of await this.store.listDeckIds()) {
      if (!(await this.store.hasDeck(deckId))) continue;
      let deck: Deck;
      try {
        deck = await this.mutations.load(deckId);
      } catch {
        continue;
      }
      await this.attachPending(deckId);
      const stale = deck.slides.filter((slide) => slide.recovery.status === "running" || slide.recovery.status === "queued");
      if (stale.length) {
        console.log(`Re-queuing ${stale.length} interrupted recovery job(s) for deck ${deckId}.`);
        await this.enqueue(deckId, stale.map((slide) => slide.id), { force: true });
      }
    }
  }

  async cancel(deckId: string) {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index].deckId === deckId) this.queue.splice(index, 1);
    }
    this.controllers.get(deckId)?.abort(new Error("Recovery stopped by the user."));
    if (await this.store.hasDeck(deckId)) {
      await this.mutations.mutate(deckId, (deck) => ({
        ...deck,
        slides: deck.slides.map((slide) => slide.recovery.status === "queued"
          ? { ...slide, recovery: { ...slide.recovery, status: "pending", message: "Recovery stopped.", updatedAt: new Date().toISOString() } }
          : slide),
      }));
    }
    const job = this.jobs.get(deckId);
    if (job) await this.setJob({ ...job, status: "cancelled", message: "Recovery stopped.", updatedAt: new Date().toISOString() });
    return this.jobs.get(deckId);
  }

  // ------------------------------------------------------------- internals

  private async notify(deckId: string, slideId: string, status: RecoveryStatus, message?: string) {
    for (const listener of this.statusListeners) {
      try {
        await listener(deckId, slideId, status, message);
      } catch (error) {
        console.error("Recovery status listener failed.", error);
      }
    }
  }

  private async touchJob(deckId: string, slideIds: string[]) {
    const now = new Date().toISOString();
    const existing = this.jobs.get(deckId);
    const active = existing && (existing.status === "queued" || existing.status === "running");
    const job: RecoveryJob = active
      ? { ...existing, slideIds: [...new Set([...existing.slideIds, ...slideIds])], updatedAt: now }
      : {
          id: randomUUID(),
          deckId,
          slideIds,
          status: slideIds.length ? "queued" : "completed",
          message: slideIds.length ? `${slideIds.length} slide${slideIds.length === 1 ? "" : "s"} waiting for text recovery.` : "Nothing to recover.",
          completedSlideIds: [],
          failedSlideIds: [],
          startedAt: now,
          updatedAt: now,
        };
    await this.setJob(job);
    return job;
  }

  private async setJob(job: RecoveryJob) {
    this.jobs.set(job.deckId, job);
    await this.store.saveRecoveryJob(job);
    this.mutations.emit(job.deckId, { type: "recovery", job });
  }

  private async finishJobItem(deckId: string, slideId: string, outcome: "completed" | "failed", message: string) {
    const job = this.jobs.get(deckId);
    if (!job) return;
    const completedSlideIds = outcome === "completed" ? [...new Set([...job.completedSlideIds, slideId])] : job.completedSlideIds;
    const failedSlideIds = outcome === "failed" ? [...new Set([...job.failedSlideIds, slideId])] : job.failedSlideIds;
    const remaining = this.queue.some((item) => item.deckId === deckId);
    const done = !remaining;
    await this.setJob({
      ...job,
      completedSlideIds,
      failedSlideIds,
      currentSlideId: undefined,
      status: done ? (completedSlideIds.length || !failedSlideIds.length ? "completed" : "failed") : "running",
      message: done
        ? failedSlideIds.length ? `Recovery finished with ${failedSlideIds.length} failed slide${failedSlideIds.length === 1 ? "" : "s"}.` : "Text recovery finished."
        : message,
      updatedAt: new Date().toISOString(),
    });
  }

  private async work() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift() as QueueItem;
        this.current = item;
        try {
          await this.recoverOne(item);
        } finally {
          this.current = undefined;
        }
      }
    } finally {
      this.working = false;
    }
  }

  private fontsFor(typography: PlannedTypography): RecoveryFontInput[] {
    const fonts: RecoveryFontInput[] = [];
    for (const role of FONT_ROLE_NAMES) {
      const catalogId = typography[role];
      const entry = this.fonts.entry(catalogId);
      const file = this.fonts.catalogFilePath(catalogId);
      const face = this.fonts.face(catalogId);
      if (!entry || !file) continue;
      fonts.push({
        role,
        catalogId,
        family: entry.family,
        subfamily: entry.subfamily,
        censusFamily: face?.preferredFamily,
        censusSubfamily: face?.preferredSubfamily,
        weight: face?.weight ?? 400,
        style: face?.italic ? "italic" : "normal",
        path: file.path,
        faceIndex: file.faceIndex,
      });
    }
    return fonts;
  }

  private typographyOf(deck: Deck): PlannedTypography {
    return {
      display: deck.designSystem.typography.display.fontId,
      heading: deck.designSystem.typography.heading.fontId,
      body: deck.designSystem.typography.body.fontId,
      label: deck.designSystem.typography.label.fontId,
    };
  }

  private async recoverOne(item: QueueItem) {
    const { deckId, slideId, assetId } = item;
    const controller = new AbortController();
    this.controllers.set(deckId, controller);

    // Resolve what to recover: either the pending painted asset or the published slide.
    let asset: DeckAsset | undefined;
    let copy = item.pending?.copy ?? [];
    let colors: DeckColors | undefined = item.pending?.colors;
    let typography: PlannedTypography | undefined = item.pending?.typography;
    let canvas = item.pending?.canvas;
    let published = false;
    if (item.pending) {
      asset = item.pending.asset;
    }
    if (await this.store.hasDeck(deckId)) {
      try {
        const deck = await this.mutations.load(deckId);
        const slide = deck.slides.find((candidate) => candidate.id === slideId);
        if (slide) {
          published = true;
          if (!item.pending && slide.recovery.status !== "queued") return;
          asset = deck.assets.find((candidate) => candidate.id === slide.assetId) ?? asset;
          copy = slide.copy.length ? slide.copy : copy;
          colors = deck.designSystem.colors;
          typography = this.typographyOf(deck);
          canvas = slide.canvas;
          if (slide.assetId !== assetId && item.pending) return; // the slide moved on to a newer version
        }
      } catch {
        // Fall through with the pending input.
      }
    }
    if (!asset || !colors || !typography || !canvas) {
      await this.markFailed(item, published, "The slide has no image or design information to recover from.");
      return;
    }

    const job = this.jobs.get(deckId);
    if (job) await this.setJob({ ...job, status: "running", currentSlideId: slideId, message: `Recovering ${slideId}.`, updatedAt: new Date().toISOString() });
    await this.setSlideState(item, published, "running", "Starting the text pipeline.");

    try {
      const imagePath = this.store.assetPath(deckId, path.basename(asset.url));
      const result = await this.provider.recover({
        deckId,
        slideId,
        assetId: asset.id,
        canvas,
        imagePath,
        copy,
        colors,
        fonts: this.fontsFor(typography),
        outputDirectory: this.store.directory(deckId),
        fresh: item.fresh,
        signal: controller.signal,
        onProgress: async (message) => {
          await this.setSlideState(item, published, "running", message);
        },
      });
      await this.attachResult(item, result, canvas);
      await this.notify(deckId, slideId, "recovered", `${result.objects.length} text block${result.objects.length === 1 ? "" : "s"} recovered.`);
      await this.finishJobItem(deckId, slideId, "completed", `Recovered ${slideId}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Recovery failed.";
      const aborted = controller.signal.aborted;
      console.error(`Recovery failed for slide ${slideId} of deck ${deckId}:`, error);
      if (aborted) {
        await this.setSlideState(item, published, "pending", "Recovery stopped.");
      } else {
        await this.markFailed(item, published, message);
      }
    } finally {
      if (this.controllers.get(deckId) === controller) this.controllers.delete(deckId);
    }
  }

  private async attachResult(item: QueueItem, result: RecoveryResult, canvas: { width: number; height: number }) {
    const record: AssetRecoveryRecord = {
      assetId: item.assetId,
      slideId: item.slideId,
      platePath: result.platePath,
      objects: result.objects,
      fonts: result.fonts,
      provider: result.provider,
      providerRef: result.providerRef,
      createdAt: new Date().toISOString(),
    };
    if (await this.store.hasDeck(item.deckId)) {
      let attached = false;
      await this.mutations.mutate(item.deckId, (current) => {
        const slide = current.slides.find((candidate) => candidate.id === item.slideId && candidate.assetId === item.assetId);
        if (!slide) return current;
        attached = true;
        return attachRecord(current, slide.id, record, canvas);
      });
      if (attached) return;
    }
    await this.store.saveAssetRecovery(item.deckId, record);
  }

  private async setSlideState(item: QueueItem, published: boolean, status: RecoveryStatus, message: string) {
    await this.notify(item.deckId, item.slideId, status, message);
    if (!published) return;
    await this.mutations.mutate(item.deckId, (deck) => ({
      ...deck,
      slides: deck.slides.map((slide) => slide.id === item.slideId
        ? { ...slide, recovery: { ...slide.recovery, status, message, error: undefined, updatedAt: new Date().toISOString(), provider: this.provider.name } }
        : slide),
    }));
  }

  private async markFailed(item: QueueItem, published: boolean, message: string) {
    await this.notify(item.deckId, item.slideId, "failed", message);
    if (published) {
      await this.mutations.mutate(item.deckId, (deck) => ({
        ...deck,
        slides: deck.slides.map((slide) => slide.id === item.slideId
          ? { ...slide, recovery: { ...slide.recovery, status: "failed", message: "The text pipeline could not recover this slide.", error: message, updatedAt: new Date().toISOString() } }
          : slide),
      }));
    }
    await this.finishJobItem(item.deckId, item.slideId, "failed", `Slide failed: ${message}`);
  }
}

/** Put a finished recovery onto a slide of a deck document. */
export function attachRecord(deck: Deck, slideId: string, record: AssetRecoveryRecord, canvas?: { width: number; height: number }): Deck {
  const slide = deck.slides.find((candidate) => candidate.id === slideId);
  if (!slide) return deck;
  const plateAsset: DeckAsset = {
    id: `${record.assetId}-plate-v${slide.version}`,
    kind: "slide-plate",
    slideId,
    url: `/api/assets/${deck.id}/${path.basename(record.platePath)}`,
    prompt: "",
    copy: [],
    alt: "Background of slide without editable text",
    width: (canvas ?? slide.canvas).width,
    height: (canvas ?? slide.canvas).height,
  };
  const fontsById = new Map(deck.fonts.map((font) => [font.id, font]));
  for (const font of record.fonts) fontsById.set(font.id, font);
  const assets = deck.assets.some((candidate) => candidate.id === plateAsset.id)
    ? deck.assets.map((candidate) => (candidate.id === plateAsset.id ? plateAsset : candidate))
    : [...deck.assets, plateAsset];
  const recoveredSlide: Slide = {
    ...slide,
    state: "recovered",
    layers: { plateAssetId: plateAsset.id, objects: record.objects },
    recovery: {
      status: "recovered",
      message: `${record.objects.length} text block${record.objects.length === 1 ? "" : "s"} recovered.`,
      provider: record.provider,
      providerRef: record.providerRef,
      updatedAt: new Date().toISOString(),
    },
  };
  return {
    ...deck,
    fonts: [...fontsById.values()],
    assets,
    slides: deck.slides.map((candidate) => (candidate.id === slideId ? recoveredSlide : candidate)),
  };
}
