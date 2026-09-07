// Editor document state: local optimistic edits as commands, undo/redo by
// snapshot, debounced sync to the server, and live merges from the deck's
// event stream (recovery results, repaints, prompt edits).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, subscribeDeck } from "../app/api";
import { applyCommands, type EditCommand } from "../shared/commands";
import type { Deck, RecoveryJob, RepaintJob } from "../shared/types";
import { mergeServerDeck } from "../shared/merge";
import { loadDeckFonts } from "./fonts";

const MAX_HISTORY = 120;
const SAVE_DELAY_MS = 500;

export function useDeckEditor(deckId: string) {
  const [deck, setDeck] = useState<Deck>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryJob>();
  const [repaint, setRepaint] = useState<RepaintJob>();
  const [fontsReady, setFontsReady] = useState(false);
  const pastRef = useRef<Deck[]>([]);
  const futureRef = useRef<Deck[]>([]);
  const pendingRef = useRef<EditCommand[]>([]);
  const timerRef = useRef<number | undefined>(undefined);
  const deckRef = useRef<Deck | undefined>(undefined);
  const [historyVersion, setHistoryVersion] = useState(0);
  deckRef.current = deck;

  const adoptServerDeck = useCallback((server: Deck) => {
    setDeck((current) => {
      if (!current) return server;
      if (current.id !== server.id) return current;
      if (server.revision <= current.revision && !pendingRef.current.length) return current;
      const merged = mergeServerDeck(current, server);
      return pendingRef.current.length ? safeApply(merged, pendingRef.current) : merged;
    });
    void loadDeckFonts(server);
  }, []);

  const flush = useCallback(async () => {
    const commands = pendingRef.current;
    if (!commands.length || !deckRef.current) return;
    pendingRef.current = [];
    setSaving(true);
    try {
      const { deck: saved } = await api.commands(deckId, commands);
      setDeck((current) => {
        if (!current) return saved;
        const rebased = pendingRef.current.length ? safeApply(saved, pendingRef.current) : saved;
        return mergeServerDeck(rebased, saved);
      });
      setError(undefined);
    } catch (saveError) {
      pendingRef.current = [...commands, ...pendingRef.current];
      setError(saveError instanceof Error ? saveError.message : "Changes could not be saved.");
    } finally {
      setSaving(false);
    }
  }, [deckId]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS);
  }, [flush]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.deck(deckId)
      .then(async ({ deck: loaded, recovery: job, repaint: repaintJob }) => {
        if (cancelled) return;
        setDeck(loaded);
        setRecovery(job);
        setRepaint(repaintJob);
        setLoading(false);
        await loadDeckFonts(loaded);
        if (!cancelled) setFontsReady(true);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "The deck could not be loaded.");
          setLoading(false);
        }
      });
    const unsubscribe = subscribeDeck(deckId, {
      onDeck: adoptServerDeck,
      onRecovery: setRecovery,
      onRepaint: setRepaint,
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [deckId, adoptServerDeck]);

  const dispatch = useCallback((commands: EditCommand | EditCommand[]) => {
    const list = Array.isArray(commands) ? commands : [commands];
    setDeck((current) => {
      if (!current) return current;
      try {
        const next = applyCommands(current, list);
        pastRef.current = [...pastRef.current.slice(-MAX_HISTORY + 1), current];
        futureRef.current = [];
        pendingRef.current = [...pendingRef.current, ...list];
        scheduleSave();
        setHistoryVersion((version) => version + 1);
        return next;
      } catch (commandError) {
        setError(commandError instanceof Error ? commandError.message : "That edit is not possible.");
        return current;
      }
    });
  }, [scheduleSave]);

  const replaceDeck = useCallback((next: Deck, { record = true }: { record?: boolean } = {}) => {
    setDeck((current) => {
      if (record && current) {
        pastRef.current = [...pastRef.current.slice(-MAX_HISTORY + 1), current];
        futureRef.current = [];
        setHistoryVersion((version) => version + 1);
      }
      return next;
    });
    void loadDeckFonts(next);
  }, []);

  const undo = useCallback(() => {
    const previous = pastRef.current.pop();
    if (!previous || !deckRef.current) return;
    futureRef.current.push(deckRef.current);
    pendingRef.current = [];
    setHistoryVersion((version) => version + 1);
    setDeck(previous);
    void syncFullDeck(deckId, previous, setError);
  }, [deckId]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next || !deckRef.current) return;
    pastRef.current.push(deckRef.current);
    pendingRef.current = [];
    setHistoryVersion((version) => version + 1);
    setDeck(next);
    void syncFullDeck(deckId, next, setError);
  }, [deckId]);

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  return useMemo(() => ({
    deck,
    loading,
    error,
    saving,
    recovery,
    repaint,
    fontsReady,
    dispatch,
    replaceDeck,
    adoptServerDeck,
    undo,
    redo,
    canUndo,
    canRedo,
    flush,
    setError,
    historyVersion,
  }), [deck, loading, error, saving, recovery, repaint, fontsReady, dispatch, replaceDeck, adoptServerDeck, undo, redo, canUndo, canRedo, flush, historyVersion]);
}

function safeApply(deck: Deck, commands: EditCommand[]) {
  try {
    return applyCommands(deck, commands);
  } catch {
    return deck;
  }
}

/** Undo/redo restore a whole snapshot; the server accepts it as a replacement through the commands endpoint's sibling PUT. */
async function syncFullDeck(deckId: string, deck: Deck, setError: (message?: string) => void) {
  try {
    const response = await fetch(`/api/decks/${deckId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error ?? "The change could not be saved.");
    }
    setError(undefined);
  } catch (error) {
    setError(error instanceof Error ? error.message : "The change could not be saved.");
  }
}
