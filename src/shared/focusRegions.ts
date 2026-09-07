import { fromMarkdown } from "mdast-util-from-markdown";
import type { Deck, FocusRegion, Slide } from "./types.js";

export type FocusCue = { id: string; label: string; start: number; end: number; spokenContext: string };

// Cache identity, not a security primitive. Two independent 32-bit accumulators
// keep this synchronous and identical in Node and the browser.
function fingerprint(value: string) {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    a = Math.imul(a ^ value.charCodeAt(i), 0x01000193);
    b = Math.imul(b ^ value.charCodeAt(i), 0x85ebca6b);
  }
  return [a, b].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Parse the same Markdown syntax the transcript renders; code and escaped
 * markers are not cues. Positions refer to the untrimmed source string. */
export function parseFocusCues(transcript = ""): FocusCue[] {
  const cues: FocusCue[] = [];
  const occurrences = new Map<string, number>();
  type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
  const visit = (node: Node) => {
    if (node.type === "link" || node.type === "linkReference") return;
    if (node.type === "strong" && node.children?.every((child) => child.type === "text")) {
      const text = node.children.map((child) => child.value ?? "").join("");
      const match = /^\[([^\[\]\n]+)\]$/.exec(text);
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (match && start !== undefined && end !== undefined && match[1].trim()) {
        const label = match[1].trim();
        const count = (occurrences.get(label) ?? 0) + 1;
        occurrences.set(label, count);
        cues.push({ id: `cue-${fingerprint(label)}-${count}`, label, start, end, spokenContext: "" });
      }
      return;
    }
    node.children?.forEach(visit);
  };
  visit(fromMarkdown(transcript));
  return cues.map((cue, i) => ({ ...cue, spokenContext: transcript.slice(cue.end, cues[i + 1]?.start).trim() }));
}

export function canLocateFocus(slide: Slide) {
  return Boolean(slide.layers) && slide.recovery.status === "recovered";
}

/** Includes visual inputs and transcript, never results or deck revision. New
 * fonts recovered on unrelated slides must not invalidate existing results. */
export function focusInputKey(deck: Deck, slide: Slide) {
  const fontIds = new Set<string>();
  for (const object of slide.layers?.objects ?? []) {
    if (object.kind !== "text") continue;
    const roleId = deck.designSystem.typography[object.style.fontRole].fontId;
    const roleFont = deck.fonts.find((font) => font.catalogId === roleId && font.source === "catalog")
      ?? deck.fonts.find((font) => font.id === `catalog:${roleId}` || font.id === roleId);
    if (object.style.fontId) fontIds.add(object.style.fontId);
    if (roleFont && (!object.style.fontId || object.style.bold || object.style.italic)) fontIds.add(roleFont.id);
    object.resolved?.words.forEach((word) => fontIds.add(word.fontId));
  }
  for (const font of deck.fonts) {
    if (fontIds.has(font.id)) Object.values(font.variants ?? {}).forEach((id) => fontIds.add(id));
  }
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  };
  return `focus-v1-${fingerprint(JSON.stringify(canonical({
    title: slide.title, talkingPoints: slide.talkingPoints ?? "", canvas: slide.canvas,
    assetId: slide.assetId, state: slide.state, layers: slide.layers,
    typography: deck.designSystem.typography, colors: deck.designSystem.colors,
    fonts: deck.fonts.filter((font) => fontIds.has(font.id)).sort((a, b) => a.id.localeCompare(b.id)),
  })))}`;
}

/** Reject the whole response if any cue is missing, duplicated or invalid. */
export function validateFocusRegions(regions: FocusRegion[], cues: FocusCue[], canvas: Slide["canvas"]) {
  const remaining = new Set(cues.map((cue) => cue.id));
  if (regions.length !== cues.length) throw new Error("The highlight response did not cover every cue.");
  for (const { cueId, box } of regions) {
    if (!remaining.delete(cueId)) throw new Error("The highlight response contained an unknown or duplicate cue.");
    if (box.length !== 4 || !box.every(Number.isFinite)
      || box[0] < 0 || box[1] < 0 || box[2] > canvas.width || box[3] > canvas.height
      || box[0] >= box[2] || box[1] >= box[3]) throw new Error("The highlight response contained an invalid rectangle.");
  }
  return regions;
}

export function currentFocusRegions(deck: Deck, slide: Slide): FocusRegion[] {
  const focus = slide.focusRegions;
  if (!canLocateFocus(slide) || focus?.status !== "ready" || focus.inputKey !== focusInputKey(deck, slide)) return [];
  try { return validateFocusRegions(focus.regions, parseFocusCues(slide.talkingPoints), slide.canvas); }
  catch { return []; }
}
