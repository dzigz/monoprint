import { randomUUID } from "node:crypto";
import type {
  AssetRecoveryInput,
  Deck,
  FontCatalogEntry,
  GenerateDeckRequest,
  GenerationProgress,
  GenerationRecord,
  RecoveryStatus,
} from "../src/shared/types.js";
import { DeckStore } from "./deckStore.js";
import { generateDeck } from "./generator.js";

type Listener = (record: GenerationRecord) => void;
type GenerationExecutor = (args: Parameters<typeof generateDeck>[0]) => Promise<Deck>;
type CompletionHook = (deck: Deck) => Promise<void> | void;
type AssetReadyHook = (input: AssetRecoveryInput) => Promise<void> | void;

function isActive(record: GenerationRecord) {
  return record.status === "queued" || record.status === "running";
}

export class GenerationManager {
  private readonly records = new Map<string, GenerationRecord>();
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly writes = new Map<string, Promise<void>>();

  private readonly completionHooks: CompletionHook[] = [];
  private readonly assetReadyHooks: AssetReadyHook[] = [];

  constructor(
    private readonly store: DeckStore,
    private readonly fontCatalog: FontCatalogEntry[],
    private readonly executor: GenerationExecutor = generateDeck,
  ) {}

  onCompleted(hook: CompletionHook) {
    this.completionHooks.push(hook);
  }

  /** Called as soon as a slide image is written, before publication. */
  onAssetReady(hook: AssetReadyHook) {
    this.assetReadyHooks.push(hook);
  }

  /** Reflect a slide's text-recovery stage on the run record, whatever the run's status. */
  async reportSlideRecovery(deckId: string, slideId: string, status: RecoveryStatus, message?: string) {
    let current: GenerationRecord | undefined = this.records.get(deckId);
    if (!current) {
      try {
        current = await this.store.loadGeneration(deckId);
      } catch {
        return;
      }
    }
    const byId = new Map((current.slideProgress ?? []).map((slide) => [slide.slideId, slide]));
    const existing = byId.get(slideId);
    if (!existing) return;
    byId.set(slideId, { ...existing, recovery: status, recoveryMessage: message, updatedAt: new Date().toISOString() });
    await this.update(deckId, { slideProgress: [...byId.values()].sort((a, b) => a.slideNumber - b.slideNumber) });
  }

  async list() {
    const records: GenerationRecord[] = [];
    for (const id of await this.store.listDeckIds()) {
      try {
        records.push(await this.get(id));
      } catch {
        // Directories without a generation record are decks created another way.
      }
    }
    return records;
  }

  async start(request: GenerateDeckRequest, id = randomUUID()) {
    const now = new Date().toISOString();
    const record: GenerationRecord = {
      id,
      deckId: id,
      request,
      status: "queued",
      phase: "queued",
      message: "The presentation is queued for authoring.",
      attempts: 0,
      turn: 0,
      imagesGenerated: 0,
      narrativeUpdates: [],
      workingNotes: [],
      slideProgress: [],
      resumable: false,
      startedAt: now,
      updatedAt: now,
    };
    this.records.set(id, record);
    await this.persist(record);
    await this.store.setLatestGeneration(id);
    this.emit(record);
    this.launch(id, false);
    return record;
  }

  async resume(id: string) {
    const record = await this.get(id);
    if (record.status === "completed" || this.active.has(id)) return record;
    if (!(record.resumable || await this.store.hasRunState(record.deckId))) {
      throw new Error("This generation has no saved checkpoint to resume.");
    }

    const queued = await this.update(id, {
      status: "queued",
      phase: "queued",
      message: "The saved generation is queued to resume.",
      error: undefined,
      resumable: true,
      completedAt: undefined,
    });
    await this.store.setLatestGeneration(id);
    this.launch(id, true);
    return queued;
  }

  async cancel(id: string) {
    const record = await this.get(id);
    if (!isActive(record)) return record;

    this.controllers.get(id)?.abort(new Error("Generation stopped by the user."));
    const resumable = await this.store.hasRunState(record.deckId);
    return this.update(id, {
      status: "cancelled",
      phase: "cancelled",
      message: "Generation stopped. Any completed work remains checkpointed.",
      error: undefined,
      resumable,
      workingNotes: this.interruptWorkingNotes(record),
    });
  }

  async get(id: string) {
    let record = this.records.get(id);
    if (!record) {
      record = await this.store.loadGeneration(id);
      this.records.set(id, record);
    }

    if (isActive(record) && !this.active.has(id)) {
      const resumable = await this.store.hasRunState(record.deckId);
      record = await this.update(id, {
        status: "interrupted",
        phase: "interrupted",
        message: "The server stopped while this presentation was being authored.",
        error: "Generation was interrupted by a server restart.",
        resumable,
        workingNotes: this.interruptWorkingNotes(record),
      });
    }
    return record;
  }

  async latest() {
    const persisted = await this.store.loadLatestGeneration();
    if (!this.records.has(persisted.id)) this.records.set(persisted.id, persisted);
    return this.get(persisted.id);
  }

  subscribe(id: string, listener: Listener) {
    const listeners = this.listeners.get(id) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    const current = this.records.get(id);
    if (current) listener(current);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  private launch(id: string, resume: boolean) {
    if (this.active.has(id)) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const task = this.execute(id, resume, controller.signal);
    this.active.set(id, task);
    void task
      .catch((error) => console.error("Generation job failed while updating its status.", error))
      .finally(() => {
        this.active.delete(id);
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
      });
  }

  private async execute(id: string, resume: boolean, signal: AbortSignal) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown generation ${id}.`);

    await this.update(id, {
      status: "running",
      phase: resume ? "recovering" : "connecting",
      message: resume ? "Loading the latest authoring checkpoint." : "Starting the presentation author.",
      error: undefined,
    });

    try {
      const deck = await this.executor({
        deckId: record.deckId,
        request: record.request,
        fontCatalog: this.fontCatalog,
        store: this.store,
        resume,
        signal,
        initialAttempt: record.attempts,
        onProgress: async (progress) => {
          await this.reportProgress(id, progress);
        },
        onAssetReady: async (input) => {
          for (const hook of this.assetReadyHooks) {
            try {
              await hook(input);
            } catch (hookError) {
              console.error("Asset-ready hook failed.", hookError);
            }
          }
        },
      });
      await this.update(id, {
        status: "completed",
        phase: "completed",
        message: "Presentation ready.",
        title: deck.title,
        imagesGenerated: deck.assets.filter((asset) => asset.kind === "slide-image").length,
        resumable: false,
        completedAt: new Date().toISOString(),
        error: undefined,
      });
      for (const hook of this.completionHooks) {
        try {
          await hook(deck);
        } catch (hookError) {
          console.error("Post-generation hook failed.", hookError);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        const resumable = await this.store.hasRunState(record.deckId);
        await this.update(id, {
          status: "cancelled",
          phase: "cancelled",
          message: "Generation stopped. Any completed work remains checkpointed.",
          error: undefined,
          resumable,
          workingNotes: this.interruptWorkingNotes(this.records.get(id) ?? record),
        });
        return;
      }
      const message = error instanceof Error ? error.message : "Generation failed.";
      const resumable = await this.store.hasRunState(record.deckId);
      console.error(error);
      await this.update(id, {
        status: "failed",
        phase: "failed",
        message: resumable ? "Generation paused after an error. Its checkpoint can be resumed." : "Generation failed.",
        error: message,
        resumable,
        workingNotes: this.interruptWorkingNotes(this.records.get(id) ?? record),
      });
    }
  }

  private async reportProgress(id: string, progress: GenerationProgress) {
    const current = this.records.get(id) ?? await this.store.loadGeneration(id);
    if (current.status === "cancelled") return current;

    const { narrativeUpdate, workingNoteUpdate, slideUpdate, slideRecoveryUpdate, sourceActivity, ...recordProgress } = progress;
    const changes: Partial<GenerationRecord> = {
      ...recordProgress,
      status: "running",
      error: undefined,
    };

    if (narrativeUpdate) {
      const update = {
        ...narrativeUpdate,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      changes.narrativeUpdates = [...(current.narrativeUpdates ?? []), update];
    }

    if (workingNoteUpdate) {
      const now = new Date().toISOString();
      const byId = new Map((current.workingNotes ?? []).map((note) => [note.id, note]));
      const existing = byId.get(workingNoteUpdate.id);
      byId.set(workingNoteUpdate.id, {
        id: workingNoteUpdate.id,
        text: workingNoteUpdate.append
          ? `${existing?.text ?? ""}${workingNoteUpdate.text}`
          : workingNoteUpdate.text,
        status: workingNoteUpdate.status,
        turn: workingNoteUpdate.turn,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      changes.workingNotes = [...byId.values()];
    }

    if (sourceActivity) {
      const entry = { ...sourceActivity, id: randomUUID(), createdAt: new Date().toISOString() };
      const existing = current.sourceActivity ?? [];
      if (!existing.some((item) => item.kind === entry.kind && item.label === entry.label)) {
        changes.sourceActivity = [...existing, entry].slice(-200);
      }
    }

    if (slideUpdate) {
      const byNumber = new Map((current.slideProgress ?? []).map((slide) => [slide.slideNumber, slide]));
      const previous = byNumber.get(slideUpdate.slideNumber);
      byNumber.set(slideUpdate.slideNumber, {
        ...slideUpdate,
        ...(previous?.recovery ? { recovery: previous.recovery, recoveryMessage: previous.recoveryMessage } : {}),
        updatedAt: new Date().toISOString(),
      });
      changes.slideProgress = [...byNumber.values()].sort((a, b) => a.slideNumber - b.slideNumber);
    }

    if (slideRecoveryUpdate) {
      const list = changes.slideProgress ?? current.slideProgress ?? [];
      changes.slideProgress = list.map((slide) => slide.slideId === slideRecoveryUpdate.slideId
        ? { ...slide, recovery: slideRecoveryUpdate.recovery, recoveryMessage: slideRecoveryUpdate.recoveryMessage, updatedAt: new Date().toISOString() }
        : slide);
    }

    return this.update(id, changes);
  }

  private async update(id: string, changes: Partial<GenerationRecord>) {
    const current = this.records.get(id) ?? await this.store.loadGeneration(id);
    const next: GenerationRecord = {
      ...current,
      ...changes,
      id: current.id,
      deckId: current.deckId,
      request: current.request,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    await this.persist(next);
    this.emit(next);
    return next;
  }

  private async persist(record: GenerationRecord) {
    const previous = this.writes.get(record.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.store.saveGeneration(record));
    this.writes.set(record.id, next);
    await next;
    if (this.writes.get(record.id) === next) this.writes.delete(record.id);
  }

  private emit(record: GenerationRecord) {
    for (const listener of this.listeners.get(record.id) ?? []) listener(record);
  }

  private interruptWorkingNotes(record: GenerationRecord) {
    const now = new Date().toISOString();
    return (record.workingNotes ?? []).map((note) => note.status === "streaming"
      ? { ...note, status: "interrupted" as const, updatedAt: now }
      : note);
  }
}
