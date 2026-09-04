// Recovery provider backed by the font_matching_proto text-layer sidecar
// (branch proto/font-matching). The sidecar runs OCR, known-typography
// matching, measured fitting, and compositing; this adapter feeds it the
// deck's known fonts and copy, then reads its run directory to assemble
// editable objects. Nothing in the sidecar repo is modified.

import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as fontkit from "fontkit";
import sharp from "sharp";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { DeckFont, FontRoleName, SlideCopyItem } from "../../src/shared/types.js";
import { FONT_ROLE_NAMES } from "../../src/shared/types.js";
import type { FontRegistry } from "../fonts.js";
import { buildPlateFromComposite } from "./plate.js";
import type { RecoveryFontInput, RecoveryInput, RecoveryResult, SlideRecoveryProvider } from "./provider.js";
import { buildTextObjects, type PoolFont, type RecoveredBlock, type RecoveredWord } from "./textBlocks.js";

export type SidecarProviderOptions = {
  baseUrl: string;
  runsDirectory: string;
  docPrefix: string;
  reuseRuns: boolean;
  designAgent: boolean;
  fontRegistry: FontRegistry;
};

type SidecarWord = {
  id: number;
  text: string;
  box_pct: [number, number, number, number];
  style?: string;
  pool?: string;
  face?: string | null;
  color?: number[];
};

type SidecarTextLayer = {
  doc: string;
  page_size: [number, number];
  blocks: Array<{ id: number | string; role?: string; words: SidecarWord[] }>;
};

type SidecarResponse = {
  docName: string;
  final: string;
  plate_render?: string;
  layer: string;
  ledger?: string;
  textLayer: SidecarTextLayer;
  error?: string;
};

type KnownPayload = {
  faces: Record<string, { fid: string; path: string; wght: number; family: string; weight: string }>;
  copy: Array<{ label: string; text: string; face: string }>;
  body: string;
};

const WEIGHT_STYLE_WORDS: Array<[number, string]> = [
  [100, "thin"], [200, "extralight"], [300, "light"], [400, "regular"], [500, "medium"],
  [600, "semibold"], [700, "bold"], [800, "extrabold"], [900, "black"],
];

function styleWord(weight: number) {
  return WEIGHT_STYLE_WORDS.reduce((best, [candidate, word]) => (
    Math.abs(candidate - weight) < Math.abs(best[0] - weight) ? [candidate, word] : best
  ))[1];
}

function censusId(family: string, subfamily: string) {
  return `${family.trim().replace(/\s+/g, "_")}|${subfamily.trim().replace(/\s+/g, "_")}`;
}

function faceDisplayName(font: RecoveryFontInput) {
  return /^regular$/i.test(font.subfamily) ? font.family : `${font.family} ${font.subfamily}`;
}

function faceCensusId(font: RecoveryFontInput) {
  return censusId(font.censusFamily ?? font.family, font.censusSubfamily ?? font.subfamily);
}

/** Best-effort font role from a production copy label, for decks recorded before fontRole existed. */
export function guessFontRole(label: string): FontRoleName {
  const value = label.toLowerCase();
  if (/\b(deck title|cover|display|hero|big number|statistic|stat\b|metric \d+ value)/.test(value)) return "display";
  if (/\b(headline|heading|title|header|section)/.test(value)) return "heading";
  if (/\b(label|eyebrow|date|footer|axis|legend|tag|unit|caption|source|attribution|page|slide number|step \d+ label|kicker|byline|category)/.test(value)) return "label";
  return "body";
}

async function exists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function sanitizePool(pool: string) {
  return pool.replace(/\//g, "_").replace(/\|/g, "-");
}

function sanitizeFace(face: string) {
  return face.replace(/[^A-Za-z0-9]+/g, "_");
}

export class SidecarRecoveryProvider implements SlideRecoveryProvider {
  readonly name = "font-matching-sidecar";

  // A reconstruct call can take well over the default five-minute header
  // timeout of Node's fetch, so the sidecar gets a dispatcher without limits.
  private readonly dispatcher = new UndiciAgent({ headersTimeout: 0, bodyTimeout: 0 });

  constructor(private readonly options: SidecarProviderOptions) {}

  private inFlight = 0;

  /**
   * The sidecar serves one request at a time, so a probe that times out while
   * it is working means "busy", not "down". Only a refused connection or a
   * bad response counts as unavailable.
   */
  async health() {
    if (this.inFlight > 0) return { available: true, detail: `${this.options.baseUrl} (processing a slide)` };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${this.options.baseUrl}/health`, { signal: controller.signal });
      if (!response.ok) return { available: false, detail: `Sidecar responded ${response.status}.` };
      return { available: true, detail: this.options.baseUrl };
    } catch (error) {
      if (controller.signal.aborted) return { available: true, detail: `${this.options.baseUrl} (busy)` };
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      return { available: false, detail: `No sidecar at ${this.options.baseUrl}${code ? ` (${code})` : ""}. Start it with npm run sidecar.` };
    } finally {
      clearTimeout(timer);
    }
  }

  docName(input: RecoveryInput) {
    return `${this.options.docPrefix}_${input.assetId.slice(0, 8)}`.replace(/[^A-Za-z0-9_-]/g, "");
  }

  buildKnownPayload(input: RecoveryInput): KnownPayload {
    const faces: KnownPayload["faces"] = {};
    const nameByRole = new Map<FontRoleName, string>();
    for (const font of input.fonts) {
      const name = faceDisplayName(font);
      nameByRole.set(font.role, name);
      faces[name] = {
        fid: faceCensusId(font),
        path: font.path,
        wght: font.weight,
        family: font.family,
        weight: styleWord(font.weight),
      };
    }
    const body = nameByRole.get("body") ?? [...nameByRole.values()][0];
    return {
      faces,
      copy: input.copy.map((item) => ({
        label: item.role,
        text: item.text,
        face: nameByRole.get(item.fontRole ?? guessFontRole(item.role)) ?? body,
      })),
      body,
    };
  }

  private async callReconstruct(input: RecoveryInput, docName: string, known: KnownPayload): Promise<SidecarResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.inFlight += 1;
    try {
      const response = await undiciFetch(`${this.options.baseUrl}/reconstruct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imagePath: input.imagePath,
          deck: input.deckId.slice(0, 8),
          docName,
          known,
          designAgent: this.options.designAgent,
        }),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      const payload = await response.json() as SidecarResponse;
      if (!response.ok || payload.error) throw new Error(payload.error ?? `Sidecar responded ${response.status}.`);
      return payload;
    } finally {
      this.inFlight -= 1;
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Ask the sidecar to rebuild the text layer of a finished run without
   * re-running the pipeline: an empty edit set re-composes in seconds and
   * returns the same layer its reconstruct call would.
   */
  private async callRerender(input: RecoveryInput, docName: string): Promise<SidecarResponse> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    this.inFlight += 1;
    try {
      const response = await undiciFetch(`${this.options.baseUrl}/rerender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docName, edits: {} }),
        signal: controller.signal,
        dispatcher: this.dispatcher,
      });
      const payload = await response.json() as SidecarResponse;
      if (!response.ok || payload.error) throw new Error(payload.error ?? `Sidecar responded ${response.status}.`);
      return payload;
    } finally {
      this.inFlight -= 1;
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async runDirectoryComplete(docDirectory: string) {
    return (await exists(path.join(docDirectory, "match_A_final.png")))
      && (await exists(path.join(docDirectory, "match_A_layer.png")))
      && (await exists(path.join(docDirectory, "render_ems.json")));
  }

  /** Rebuild the sidecar's text layer from its run directory (used when reusing a finished run). */
  private async textLayerFromRunDirectory(docDirectory: string, imagePath: string): Promise<SidecarTextLayer> {
    const ocr = await readJson<{ words?: Array<{ text: string; image_bbox: number[] }> } | Array<{ text: string; image_bbox: number[] }>>(
      path.join(docDirectory, "ocr", "word_bboxes.json"),
    );
    const words = (Array.isArray(ocr) ? ocr : ocr?.words ?? []).map((word) => ({ text: word.text, box: [...word.image_bbox] as number[] }));
    const blocks = (await readJson<{ blocks?: Array<{ id: number | string; role?: string; words?: number[] }> }>(path.join(docDirectory, "blocks.json")))?.blocks ?? [];
    const asg2 = (await readJson<Record<string, string>>(path.join(docDirectory, "asg2.json"))) ?? {};
    const overrides = (await readJson<{ drop_words?: number[]; set_text?: Record<string, string>; set_box?: Record<string, number[]>; plates?: number[][] }>(
      path.join(docDirectory, "design_overrides.json"),
    )) ?? {};
    const unrenderable = (await readJson<Record<string, unknown>>(path.join(docDirectory, "unrenderable.json"))) ?? {};
    const dropped = new Set<number>([...(overrides.drop_words ?? []), ...Object.keys(unrenderable).map(Number)]);
    for (const box of overrides.plates ?? []) {
      words.forEach((word, index) => {
        const cx = (word.box[0] + word.box[2]) / 2;
        const cy = (word.box[1] + word.box[3]) / 2;
        if (box[0] <= cx && cx <= box[2] && box[1] <= cy && cy <= box[3]) dropped.add(index);
      });
    }
    for (const [key, text] of Object.entries(overrides.set_text ?? {})) {
      const index = Number(key);
      if (words[index] && String(text).trim()) words[index].text = String(text).trim();
    }
    for (const [key, box] of Object.entries(overrides.set_box ?? {})) {
      const index = Number(key);
      if (words[index] && box.length === 4) words[index].box = box.map(Number);
    }
    const image = sharp(imagePath).ensureAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const sampleColor = (box: number[]): [number, number, number] => {
      const x0 = Math.max(0, Math.round(box[0]));
      const y0 = Math.max(0, Math.round(box[1]));
      const x1 = Math.min(W, Math.round(box[2]));
      const y1 = Math.min(H, Math.round(box[3]));
      if (x1 - x0 < 2 || y1 - y0 < 2) return [17, 17, 17];
      const ring: number[][] = [];
      const inner: Array<[number, number, number]> = [];
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * W + x) * 4;
          const pixel: [number, number, number] = [data[offset], data[offset + 1], data[offset + 2]];
          if (y === y0 || y === y1 - 1 || x === x0 || x === x1 - 1) ring.push(pixel);
          else inner.push(pixel);
        }
      }
      const med = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
      const background = [med(ring.map((p) => p[0])), med(ring.map((p) => p[1])), med(ring.map((p) => p[2]))];
      const distances = inner.map((p) => Math.hypot(p[0] - background[0], p[1] - background[1], p[2] - background[2]));
      const peak = Math.max(...distances, 1);
      const ink = inner.filter((_, index) => distances[index] >= 0.5 * peak);
      if (!ink.length) return [17, 17, 17];
      return [med(ink.map((p) => p[0])), med(ink.map((p) => p[1])), med(ink.map((p) => p[2]))];
    };
    return {
      doc: path.basename(docDirectory),
      page_size: [W, H],
      blocks: blocks.map((block) => ({
        id: block.id,
        role: block.role,
        words: (block.words ?? [])
          .filter((index) => index < words.length && !dropped.has(index) && asg2[String(index)])
          .map((index) => {
            const word = words[index];
            return {
              id: index,
              text: word.text,
              box_pct: [
                (100 * word.box[0]) / W,
                (100 * word.box[1]) / H,
                (100 * (word.box[2] - word.box[0])) / W,
                (100 * (word.box[3] - word.box[1])) / H,
              ] as [number, number, number, number],
              pool: asg2[String(index)],
              color: sampleColor(word.box),
            };
          }),
      })),
    };
  }

  /**
   * The fitted instance font for a pool. A run directory keeps instance files
   * from earlier runs of the same slide, so the file is chosen by the face the
   * current run elected; only when that file is missing does the newest file
   * for the pool serve as a fallback.
   */
  private async fittedFontFile(docDirectory: string, pool: string, chosenFace?: string) {
    const fontsDirectory = path.join(docDirectory, "matched_fonts");
    let files: string[];
    try {
      files = await readdir(fontsDirectory);
    } catch {
      return undefined;
    }
    const prefix = `${sanitizePool(pool)}__`;
    if (chosenFace) {
      const exact = `${prefix}${sanitizeFace(chosenFace)}__cal.ttf`;
      if (files.includes(exact)) return path.join(fontsDirectory, exact);
    }
    const candidates = files.filter((file) => file.startsWith(prefix) && (file.endsWith("__cal.ttf") || file.endsWith("__floor.ttf")));
    if (!candidates.length) return undefined;
    const withTimes = await Promise.all(candidates.map(async (file) => {
      const fullPath = path.join(fontsDirectory, file);
      const { mtimeMs } = await stat(fullPath);
      return { fullPath, mtimeMs, calibrated: file.endsWith("__cal.ttf") };
    }));
    withTimes.sort((a, b) => Number(b.calibrated) - Number(a.calibrated) || b.mtimeMs - a.mtimeMs);
    return withTimes[0].fullPath;
  }

  async recover(input: RecoveryInput): Promise<RecoveryResult> {
    const docName = this.docName(input);
    const docDirectory = path.join(this.options.runsDirectory, docName);
    const known = this.buildKnownPayload(input);
    let textLayer: SidecarTextLayer;
    let reused = false;

    if (this.options.reuseRuns && !input.fresh && await this.runDirectoryComplete(docDirectory)) {
      reused = true;
      const health = await this.health();
      if (health.available) {
        await input.onProgress?.("Rebuilding the text layer from the pipeline's finished run.");
        try {
          textLayer = (await this.callRerender(input, docName)).textLayer;
        } catch (error) {
          console.warn(`Sidecar re-render failed for ${docName}; reading the run directory instead.`, error);
          textLayer = await this.textLayerFromRunDirectory(docDirectory, input.imagePath);
        }
      } else {
        await input.onProgress?.("Reusing the pipeline's finished run for this slide.");
        textLayer = await this.textLayerFromRunDirectory(docDirectory, input.imagePath);
      }
    } else {
      await input.onProgress?.("Sending the slide to the text pipeline. This takes a few minutes.");
      const response = await this.callReconstruct(input, docName, known);
      textLayer = response.textLayer;
    }

    const finalPath = path.join(docDirectory, "match_A_final.png");
    const layerPath = path.join(docDirectory, "match_A_layer.png");
    if (!(await exists(finalPath)) || !(await exists(layerPath))) {
      throw new Error(`The pipeline finished but its run directory ${docDirectory} has no composite output.`);
    }

    await input.onProgress?.("Rebuilding the background plate.");
    const platePath = path.join(input.outputDirectory, `${input.assetId}.plate.png`);
    const plate = await buildPlateFromComposite({ finalPath, layerPath, outputPath: platePath });

    const renderEms = (await readJson<{ words?: Record<string, number> }>(path.join(docDirectory, "render_ems.json")))?.words ?? {};
    const spaceCal = (await readJson<{ pools?: Record<string, { ratio?: number }> }>(path.join(docDirectory, "spacecal.json")))?.pools ?? {};
    const weightFit = (await readJson<Record<string, { chosen?: string; adopted?: string }>>(path.join(docDirectory, "weightfit.json"))) ?? {};

    const roleByCensusId = new Map<string, FontRoleName>();
    for (const font of input.fonts) {
      for (const id of new Set([faceCensusId(font), censusId(font.family, font.subfamily)])) {
        if (!roleByCensusId.has(id)) roleByCensusId.set(id, font.role);
      }
    }
    const roleFontByRole = new Map<FontRoleName, RecoveryFontInput>(input.fonts.map((font) => [font.role, font]));

    const [pageWidth, pageHeight] = textLayer.page_size;
    const scaleX = input.canvas.width / pageWidth;
    const scaleY = input.canvas.height / pageHeight;
    const poolNames = new Set<string>();
    const blocks: RecoveredBlock[] = textLayer.blocks.map((block) => ({
      id: block.id,
      role: block.role,
      words: block.words.map((word): RecoveredWord => {
        if (word.pool) poolNames.add(word.pool);
        const [px, py, pw, ph] = word.box_pct;
        const x0 = (px / 100) * pageWidth * scaleX;
        const y0 = (py / 100) * pageHeight * scaleY;
        const x1 = ((px + pw) / 100) * pageWidth * scaleX;
        const y1 = ((py + ph) / 100) * pageHeight * scaleY;
        const em = renderEms[String(word.id)];
        return {
          id: word.id,
          text: word.text,
          box: [x0, y0, x1, y1],
          pool: word.pool,
          color: word.color && word.color.length === 3 ? [word.color[0], word.color[1], word.color[2]] : undefined,
          em: em !== undefined ? em * scaleX : undefined,
        };
      }),
    }));

    const poolFonts = new Map<string, PoolFont>();
    const fonts: DeckFont[] = [];
    for (const pool of poolNames) {
      const chosen = weightFit[pool]?.chosen ?? weightFit[pool]?.adopted;
      const [family = "", subfamily = "Regular"] = (chosen ?? "").split("|").map((part) => part.replace(/_/g, " "));
      const role = (chosen ? roleByCensusId.get(chosen) : undefined)
        ?? (/heading/.test(pool) ? "heading" : /label/.test(pool) ? "label" : "body");
      const fittedPath = await this.fittedFontFile(docDirectory, pool, chosen);
      let font: DeckFont | undefined;
      if (fittedPath) {
        font = await this.options.fontRegistry.registerFittedFont({
          deckId: input.deckId,
          sourcePath: fittedPath,
          family: family || roleFontByRole.get(role)?.family || "Unknown",
          subfamily: subfamily || "Regular",
          label: `${input.assetId.slice(0, 8)}_${path.basename(fittedPath, path.extname(fittedPath))}`,
        });
        fonts.push(font);
      } else {
        const catalogFace = family ? this.options.fontRegistry.findFace(family, subfamily) : undefined;
        const catalogId = catalogFace?.id ?? roleFontByRole.get(role)?.catalogId;
        font = catalogId ? this.options.fontRegistry.deckFontForCatalog(catalogId, false) : undefined;
      }
      if (!font) continue;
      poolFonts.set(pool, { font, fontRole: role, spaceRatio: spaceCal[pool]?.ratio, measure: measureWith(fittedPath ?? this.options.fontRegistry.catalogFilePath(font.catalogId ?? "")?.path) });
    }
    const bodyFont = roleFontByRole.get("body");
    const fallbackFont = bodyFont ? this.options.fontRegistry.deckFontForCatalog(bodyFont.catalogId, false) : undefined;
    const fallbackPoolFont: PoolFont | undefined = fallbackFont ? { font: fallbackFont, fontRole: "body" } : undefined;

    const objects = buildTextObjects({
      blocks,
      poolFonts,
      fallbackPoolFont,
      canvas: input.canvas,
      colors: input.colors,
      copy: input.copy,
    });

    return {
      platePath,
      objects,
      fonts,
      provider: this.name,
      providerRef: docName,
      diagnostics: {
        reused,
        docDirectory,
        words: blocks.reduce((sum, block) => sum + block.words.length, 0),
        pools: [...poolNames],
        plateFilledPixels: plate.filledPixels,
      },
    };
  }
}

function measureWith(fontPath: string | undefined) {
  if (!fontPath) return undefined;
  try {
    const opened = fontkit.openSync(fontPath);
    const font = ("fonts" in opened ? opened.fonts[0] : opened) as fontkit.Font;
    return (text: string) => {
      try {
        return font.layout(text).advanceWidth;
      } catch {
        return text.length * font.unitsPerEm * 0.55;
      }
    };
  } catch {
    return undefined;
  }
}

export function copyForKnownPayload(copy: SlideCopyItem[]) {
  return copy.map((item) => ({ ...item, fontRole: item.fontRole ?? guessFontRole(item.role) }));
}

export { FONT_ROLE_NAMES };
