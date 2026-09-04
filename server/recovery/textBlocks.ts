// Turn recovered words into editable text objects.
//
// Providers report words with boxes, sizes, faces, and colors. This module
// groups them into lines and blocks, infers alignment and leading, snaps
// colors to the deck palette, links blocks back to the copy contract, and
// computes the frame so the browser's first baseline lands where the
// pipeline measured it.

import { randomUUID } from "node:crypto";
import type {
  DeckColors,
  DeckFont,
  FontRoleName,
  Frame,
  SlideCopyItem,
  TextAlign,
  TextObject,
} from "../../src/shared/types.js";

export type RecoveredWord = {
  id: number;
  text: string;
  /** Pixel box [x0, y0, x1, y1] in canvas units. */
  box: [number, number, number, number];
  pool?: string;
  color?: [number, number, number];
  /** Font size in px the provider rendered this word at. */
  em?: number;
};

export type RecoveredBlock = {
  id: string | number;
  role?: string;
  words: RecoveredWord[];
};

export type PoolFont = {
  font: DeckFont;
  fontRole: FontRoleName;
  /** Calibrated word gap as a fraction of em, when measured. */
  spaceRatio?: number;
  /** Advance width of a string in font units, measured with the actual font file. */
  measure?: (text: string) => number;
};

export type BuildTextObjectsInput = {
  blocks: RecoveredBlock[];
  poolFonts: Map<string, PoolFont>;
  fallbackPoolFont?: PoolFont;
  canvas: { width: number; height: number };
  colors: DeckColors;
  copy: SlideCopyItem[];
};

const DESCENDER_CHARS = new Set("gjpqy,;()@$");

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function variance(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function toHex(rgb: [number, number, number]) {
  return `#${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

function colorDistance(a: [number, number, number], b: [number, number, number]) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

export function snapColor(rgb: [number, number, number], colors: DeckColors, tolerance = 28) {
  let best: { role: keyof DeckColors; distance: number } | undefined;
  for (const [role, hex] of Object.entries(colors) as Array<[keyof DeckColors, string]>) {
    if (role === "background" || role === "surface" || role === "border") continue;
    const distance = colorDistance(rgb, parseHex(hex));
    if (!best || distance < best.distance) best = { role, distance };
  }
  if (best && best.distance <= tolerance) return { color: colors[best.role], colorRole: best.role };
  return { color: toHex(rgb) };
}

function normalizeText(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Match a recovered block to the copy item whose text it best covers. */
export function matchCopyItem(text: string, copy: SlideCopyItem[]) {
  const target = normalizeText(text);
  if (!target) return undefined;
  const targetTokens = target.split(" ").filter(Boolean);
  let best: { item: SlideCopyItem; score: number } | undefined;
  for (const item of copy) {
    const candidate = normalizeText(item.text);
    if (!candidate) continue;
    const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
    const overlap = targetTokens.filter((token) => candidateTokens.has(token)).length;
    const score = overlap / Math.max(targetTokens.length, candidateTokens.size);
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 0.5 ? best.item : undefined;
}

type Line = {
  words: RecoveredWord[];
  box: [number, number, number, number];
  baseline: number;
  text: string;
};

function groupLines(words: RecoveredWord[]): RecoveredWord[][] {
  const rows: Array<{ y0: number; y1: number; words: RecoveredWord[] }> = [];
  const sorted = [...words].sort((a, b) => (a.box[1] + a.box[3]) / 2 - (b.box[1] + b.box[3]) / 2);
  for (const word of sorted) {
    const [, y0, , y1] = word.box;
    const row = rows.find((candidate) => {
      const overlap = Math.min(y1, candidate.y1) - Math.max(y0, candidate.y0);
      return overlap > 0.5 * Math.min(y1 - y0, candidate.y1 - candidate.y0);
    });
    if (row) {
      row.words.push(word);
      row.y0 = Math.min(row.y0, y0);
      row.y1 = Math.max(row.y1, y1);
    } else {
      rows.push({ y0, y1, words: [word] });
    }
  }
  rows.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  return rows.map((row) => row.words.sort((a, b) => a.box[0] - b.box[0]));
}

/** Words of one segment joined by single spaces; wide gaps have already split the segment. */
function lineText(words: RecoveredWord[]) {
  return words.map((word) => word.text).join(" ");
}

function lineBaseline(words: RecoveredWord[], descenderDepthPx: number) {
  const bottoms = words.map((word) => {
    const hasDescender = [...word.text].some((char) => DESCENDER_CHARS.has(char));
    return hasDescender ? word.box[3] - descenderDepthPx : word.box[3];
  });
  return median(bottoms);
}

function inferAlignment(lines: Line[], canvasWidth: number): TextAlign {
  if (lines.length < 2) {
    const [line] = lines;
    if (!line) return "left";
    const center = (line.box[0] + line.box[2]) / 2;
    return Math.abs(center - canvasWidth / 2) <= canvasWidth * 0.015 ? "center" : "left";
  }
  const lefts = lines.map((line) => line.box[0]);
  const rights = lines.map((line) => line.box[2]);
  const centers = lines.map((line) => (line.box[0] + line.box[2]) / 2);
  const scores = { left: variance(lefts), center: variance(centers), right: variance(rights) };
  const best = (Object.entries(scores) as Array<[TextAlign, number]>).sort((a, b) => a[1] - b[1])[0][0];
  return scores[best] < scores.left - 1 ? best : "left";
}

export function buildTextObjects({ blocks, poolFonts, fallbackPoolFont, canvas, colors, copy }: BuildTextObjectsInput): TextObject[] {
  const objects: TextObject[] = [];
  for (const block of blocks) {
    const words = block.words.filter((word) => word.em && word.em > 0 && word.text.trim());
    if (!words.length) continue;

    const poolCounts = new Map<string, number>();
    for (const word of words) poolCounts.set(word.pool ?? "", (poolCounts.get(word.pool ?? "") ?? 0) + word.text.length);
    const dominantPool = [...poolCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
    const poolFont = poolFonts.get(dominantPool) ?? fallbackPoolFont;
    if (!poolFont) continue;

    const em = median(words.map((word) => word.em as number));
    const metrics = poolFont.font.metrics;
    const unitsPerEm = metrics?.unitsPerEm ?? 1000;
    const ascentPx = ((metrics?.ascent ?? unitsPerEm * 0.8) / unitsPerEm) * em;
    const descentPx = (Math.abs(metrics?.descent ?? unitsPerEm * 0.2) / unitsPerEm) * em;
    const descenderDepthPx = ((metrics?.descenderDepth ?? unitsPerEm * 0.2) / unitsPerEm) * em;
    const spaceUnit = poolFont.spaceRatio ? poolFont.spaceRatio * em : undefined;

    const toLine = (lineWords: RecoveredWord[]): Line => ({
      words: lineWords,
      box: [
        Math.min(...lineWords.map((word) => word.box[0])),
        Math.min(...lineWords.map((word) => word.box[1])),
        Math.max(...lineWords.map((word) => word.box[2])),
        Math.max(...lineWords.map((word) => word.box[3])),
      ],
      baseline: lineBaseline(lineWords, descenderDepthPx),
      text: lineText(lineWords),
    });
    const lines: Line[] = groupLines(words).map(toLine);
    if (!lines.length) continue;

    const leadings = lines.slice(1).map((line, index) => line.baseline - lines[index].baseline);
    const leading = leadings.length ? median(leadings) : em * 1.25;
    const lineHeight = Math.max(0.85, Math.min(2.4, leading / em));
    const align = inferAlignment(lines, canvas.width);

    const contentHeight = ascentPx + descentPx;
    const halfLeading = (lineHeight * em - contentHeight) / 2;
    const firstBaseline = lines[0].baseline;
    const top = firstBaseline - ascentPx - halfLeading;
    const left = Math.min(...lines.map((line) => line.box[0]));
    const right = Math.max(...lines.map((line) => line.box[2]));
    const measuredWidth = right - left;
    // The frame must hold every line as the browser will set it, so measure
    // each line with the real font (advances plus calibrated word gaps) and
    // never trust the OCR box alone.
    const spaceAdvancePx = ((metrics?.spaceAdvance ?? unitsPerEm * 0.25) / unitsPerEm) * em;
    const renderedWidths = lines.map((line) => {
      if (!poolFont.measure) return line.box[2] - line.box[0];
      const spaces = (line.text.match(/ /g) ?? []).length;
      const unitsWidth = poolFont.measure(line.text.replace(/ /g, ""));
      const spaceWidth = spaceUnit !== undefined ? spaceUnit : spaceAdvancePx;
      return (unitsWidth / unitsPerEm) * em + spaces * spaceWidth;
    });
    const widestLine = Math.max(measuredWidth, ...renderedWidths);
    const width = Math.max(8, widestLine * 1.015 + em * 0.35);
    const height = lines.length * lineHeight * em;
    const frame: Frame = align === "center"
      ? { x: (left + right) / 2 - width / 2, y: top, width, height }
      : align === "right"
        ? { x: right - width, y: top, width, height }
        : { x: left, y: top, width, height };

    const colorSamples = words.map((word) => word.color).filter((color): color is [number, number, number] => Boolean(color));
    const medianColor: [number, number, number] = colorSamples.length
      ? [median(colorSamples.map((c) => c[0])), median(colorSamples.map((c) => c[1])), median(colorSamples.map((c) => c[2]))]
      : parseHex(colors.text);
    const snapped = snapColor(medianColor, colors);

    const text = lines.map((line) => line.text).join("\n");
    const matchedCopy = matchCopyItem(text, copy);
    const wordSpacing = spaceUnit !== undefined && metrics
      ? spaceUnit - (metrics.spaceAdvance / unitsPerEm) * em
      : undefined;

    objects.push({
      id: randomUUID(),
      kind: "text",
      frame,
      text,
      style: {
        fontRole: matchedCopy?.fontRole ?? poolFont.fontRole,
        fontId: poolFont.font.id,
        fontSize: Math.round(em * 100) / 100,
        lineHeight: Math.round(lineHeight * 1000) / 1000,
        ...(wordSpacing !== undefined && Math.abs(wordSpacing) > 0.05 ? { wordSpacing: Math.round(wordSpacing * 100) / 100 } : {}),
        align,
        color: snapped.color,
        ...(snapped.colorRole ? { colorRole: snapped.colorRole } : {}),
      },
      ...(matchedCopy ? { copyRole: matchedCopy.role } : {}),
      origin: {
        kind: "recovered",
        frame: { x: left, y: Math.min(...lines.map((line) => line.box[1])), width: measuredWidth, height: Math.max(...lines.map((line) => line.box[3])) - Math.min(...lines.map((line) => line.box[1])) },
        confidence: matchedCopy ? 0.9 : 0.6,
      },
    });
  }
  return objects;
}
