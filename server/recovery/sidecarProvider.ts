// Recovery provider backed by the font_matching_proto text-layer sidecar
// (branch proto/font-matching). The sidecar runs OCR, known-typography
// matching, measured fitting, and compositing; this adapter feeds it the
// deck's known fonts and copy, then reads its run directory to assemble
// editable objects. Nothing in the sidecar repo is modified.

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { objectsFromResolved, type PipelineLayout } from "./resolvedLayout.js";
import * as fontkit from "fontkit";
import sharp from "sharp";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import type { DeckFont, FontRoleName, SlideCopyItem } from "../../src/shared/types.js";
import { FONT_ROLE_NAMES } from "../../src/shared/types.js";
import type { FontRegistry } from "../fonts.js";
import type { RecoveryFontInput, RecoveryInput, RecoveryResult, SlideRecoveryProvider } from "./provider.js";

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
  resolved?: PipelineLayout;
  revision?: string;
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
  faces: Record<string, { fid: string; path: string; face_index: number; slant: string; wght: number; family: string; weight: string }>;
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
        face_index: font.faceIndex,
        slant: font.style === "italic" ? "italic" : "upright",
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
    const state = await readJson<{ schema: number; revision: string; assets: Record<string, string>; code_files: Record<string, string>; input_files: Record<string, string | null>; source_fonts: Record<string, string> }>(path.join(docDirectory, "render_state.json"));
    if (!state || state.schema < 4 || !state.code_files || !state.input_files) return false;
    for (const [name, hash] of Object.entries({ ...state.assets, ...state.code_files, ...state.input_files, ...state.source_fonts })) {
      const file = path.isAbsolute(name) ? name : path.join(docDirectory, name);
      if (hash === null) { if (await exists(file)) return false; continue; }
      if (!hash || !(await exists(file)) || createHash("sha256").update(await readFile(file)).digest("hex") !== hash) return false;
    }
    if (this.options.designAgent) {
      const review = await readJson<{ status: string; reviewed_revision: string; revision: string }>(path.join(docDirectory, "design_report.json"));
      if (!review || review.status !== "reviewed" || review.revision !== state.revision || review.reviewed_revision !== state.revision) return false;
    }
    return true;
  }

  /** Rebuild the sidecar's text layer from its run directory (used when reusing a finished run). */
  private async textLayerFromRunDirectory(docDirectory: string, imagePath: string): Promise<SidecarTextLayer> {
    const resolved = await readJson<PipelineLayout>(path.join(docDirectory, "resolved_layout.json"));
    const state = await readJson<{ revision: string }>(path.join(docDirectory, "render_state.json"));
    if (resolved && state) return { doc: path.basename(docDirectory), page_size: resolved.page_size, blocks: [], resolved, revision: state.revision };
    throw new Error("This run has no resolved layout; reconstruct it with the current pipeline.");
  }

  private async requestMatches(docDirectory: string, input: RecoveryInput, known: KnownPayload) {
    const request = await readJson<{ image: string; known: KnownPayload; fonts: Record<string, string>; deck: string; designAgent: boolean }>(path.join(docDirectory, "request.json"));
    if (!request || request.deck !== input.deckId.slice(0,8) || request.designAgent !== this.options.designAgent || stableJson(request.known) !== stableJson(known)) return false;
    if (request.image !== createHash("sha256").update(await readFile(input.imagePath)).digest("hex")) return false;
    for (const [file, hash] of Object.entries(request.fonts ?? {})) {
      if (!(await exists(file)) || createHash("sha256").update(await readFile(file)).digest("hex") !== hash) return false;
    }
    return true;
  }

  private async resolvedResult(input: RecoveryInput, docDirectory: string, textLayer: SidecarTextLayer, reused: boolean): Promise<RecoveryResult> {
    const layout = textLayer.resolved!;
    const registered = new Map<string, DeckFont>();
    for (const [key, rec] of Object.entries(layout.fonts)) {
      if (rec.face_index !== 0) throw new Error("Resolved font instances must contain one face.");
      if (createHash("sha256").update(await readFile(rec.path)).digest("hex") !== rec.sha256) throw new Error(`Resolved font changed: ${rec.path}`);
      const opened = fontkit.openSync(rec.path);
      const face = ("fonts" in opened ? opened.fonts[0] : opened) as fontkit.Font;
      const font = await this.options.fontRegistry.registerFittedFont({
        deckId: input.deckId, sourcePath: rec.path, family: face.familyName,
        subfamily: face.subfamilyName, label: `resolved_${key}`,
      });
      registered.set(key, font);
    }
    await input.onProgress?.("Loading the reviewed layout and background plate.");
    const platePath = path.join(input.outputDirectory, `${input.assetId}.plate.png`);
    await sharp(path.join(docDirectory, "match_A_plate.png")).resize(input.canvas.width, input.canvas.height, { fit: "fill" }).png().toFile(platePath);
    const objects = objectsFromResolved(layout, registered, input.canvas, textLayer.revision!);
    return { platePath, objects, fonts: [...registered.values()], provider: this.name, providerRef: path.basename(docDirectory),
      diagnostics: { reused, docDirectory, revision: textLayer.revision, words: Object.keys(layout.words).length, layoutSchema: layout.schema, plateFilledPixels: 0 } };
  }

  async recover(input: RecoveryInput): Promise<RecoveryResult> {
    const docName = this.docName(input);
    const docDirectory = path.join(this.options.runsDirectory, docName);
    const known = this.buildKnownPayload(input);
    let textLayer: SidecarTextLayer;
    let reused = false;

    if (this.options.reuseRuns && !input.fresh && await this.runDirectoryComplete(docDirectory)
        && await this.requestMatches(docDirectory, input, known)) {
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

    if (!(await this.runDirectoryComplete(docDirectory))) throw new Error("The pipeline output changed or still needs design review. Reconstruct this slide.");
    if (textLayer.resolved && textLayer.revision) return this.resolvedResult(input, docDirectory, textLayer, reused);
    throw new Error("The pipeline did not return a resolved layout. Update the sidecar and reconstruct this slide.");


  }
}

export function copyForKnownPayload(copy: SlideCopyItem[]) {
  return copy.map((item) => ({ ...item, fontRole: item.fontRole ?? guessFontRole(item.role) }));
}

export { FONT_ROLE_NAMES };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
