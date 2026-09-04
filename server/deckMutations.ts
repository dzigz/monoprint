// Per-deck serialized mutations and a change feed.
//
// Everything that changes a stored deck (editor commands, recovery results,
// repaints, prompt edits) goes through `mutate`, which loads the freshest
// copy, applies the change under a per-deck lock, bumps the revision, saves,
// and notifies subscribers. Interleaved writers can never clobber each other.

import type { Deck, RecoveryJob, RepaintJob } from "../src/shared/types.js";
import type { DeckStore } from "./deckStore.js";
import type { FontRegistry } from "./fonts.js";

export type DeckEvent =
  | { type: "deck"; deck: Deck }
  | { type: "recovery"; job: RecoveryJob }
  | { type: "repaint"; job: RepaintJob };

type Listener = (event: DeckEvent) => void;

export class DeckMutations {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly store: DeckStore, private readonly fonts: FontRegistry) {}

  async load(deckId: string) {
    return this.fonts.ensureDeckFonts(await this.store.load(deckId));
  }

  /** Apply `change` to the latest stored deck under the deck's lock. */
  async mutate(deckId: string, change: (deck: Deck) => Deck | Promise<Deck>): Promise<Deck> {
    const previous = this.locks.get(deckId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      const current = await this.load(deckId);
      const changed = await change(current);
      if (changed === current) return current;
      const next: Deck = {
        ...this.fonts.ensureDeckFonts(changed),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.store.save(next);
      this.emit(deckId, { type: "deck", deck: next });
      return next;
    });
    this.locks.set(deckId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(deckId) === run) this.locks.delete(deckId);
    }
  }

  subscribe(deckId: string, listener: Listener) {
    const listeners = this.listeners.get(deckId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(deckId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(deckId);
    };
  }

  emit(deckId: string, event: DeckEvent) {
    for (const listener of this.listeners.get(deckId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        console.error("Deck event listener failed.", error);
      }
    }
  }
}
