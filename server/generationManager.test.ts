import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Deck } from "../src/shared/types.js";
import { DeckStore } from "./deckStore.js";
import { GenerationManager } from "./generationManager.js";
import { FontEligibility } from "./fontEligibility.js";
const emptyFonts = new FontEligibility({ entries: [], faces: new Map() });

async function waitForStatus(manager: GenerationManager, id: string, status: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const record = await manager.get(id);
    if (record.status === status) return record;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Generation ${id} did not reach ${status}.`);
}

test("persists public narrative updates and per-slide render state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "presentation-builder-progress-"));
  try {
    const manager = new GenerationManager(new DeckStore(root), emptyFonts, async ({ onProgress }) => {
      await onProgress?.({
        narrativeUpdate: {
          stage: "framing",
          summary: "Frame the decision.",
          thesis: "A specific thesis.",
          targetLanguages: ["sr-Latn", "sv"],
        },
      });
      await onProgress?.({
        workingNoteUpdate: {
          id: "reasoning-1:0",
          text: "Testing the opening against the audience's decision.",
          status: "streaming",
          turn: 1,
          append: true,
        },
      });
      await onProgress?.({
        workingNoteUpdate: {
          id: "reasoning-1:0",
          text: "Testing the opening against the audience's decision. The contrast is stronger than a chronology.",
          status: "complete",
          turn: 1,
        },
      });
      await onProgress?.({
        slideUpdate: {
          slideNumber: 1,
          slideId: "opening",
          status: "generating",
          styleReferenceCount: 0,
        },
      });
      return { assets: [] } as unknown as Deck;
    });

    const started = await manager.start({ prompt: "Explain the decision", attachments: [] });
    const completed = await waitForStatus(manager, started.id, "completed");
    assert.equal(completed.narrativeUpdates?.[0]?.stage, "framing");
    const restored = await new DeckStore(root).loadGeneration(started.id);
    assert.deepEqual(restored.narrativeUpdates?.[0]?.targetLanguages, ["sr-Latn", "sv"]);
    assert.equal(completed.workingNotes?.length, 1);
    assert.equal(completed.workingNotes?.[0]?.status, "complete");
    assert.equal(completed.workingNotes?.[0]?.text, "Testing the opening against the audience's decision. The contrast is stronger than a chronology.");
    assert.equal(completed.slideProgress?.[0]?.status, "generating");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping a generation aborts the active executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "presentation-builder-cancel-"));
  try {
    let started!: () => void;
    const executorStarted = new Promise<void>((resolve) => { started = resolve; });
    const manager = new GenerationManager(new DeckStore(root), emptyFonts, ({ signal }) => new Promise<Deck>((_resolve, reject) => {
      started();
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));

    const generation = await manager.start({ prompt: "Explain the decision", attachments: [] });
    await executorStarted;
    const cancelled = await manager.cancel(generation.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.phase, "cancelled");
    await waitForStatus(manager, generation.id, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
