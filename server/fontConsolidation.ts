import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { textObjectSchema } from "../src/shared/commands.js";
import { currentFocusRegions, focusInputKey, parseFocusCues } from "../src/shared/focusRegions.js";
import type { Deck, FontConsolidationSummary, Slide, TextObject } from "../src/shared/types.js";
import type { DeckMutations } from "./deckMutations.js";
import type { DeckStore } from "./deckStore.js";
import type { FontRegistry } from "./fonts.js";

export class FontConsolidationError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

type FontFile = { path: string; face_index: number };
export type ConsolidationInput = {
  fonts: Record<string, FontFile>;
  slides: Array<{ id: string; canvas: Slide["canvas"]; objects: TextObject[] }>;
};
const countsSchema = z.object({ consolidated:z.number().int().nonnegative(), alreadyUniform:z.number().int().nonnegative(), preserved:z.number().int().nonnegative(), skipped:z.number().int().nonnegative() });
const outputSchema = z.object({ slides:z.array(z.object({ id:z.string(), updates:z.array(textObjectSchema), counts:countsSchema })) });
export type ConsolidationOutput = z.infer<typeof outputSchema>;

type Options = {
  projectRoot: string;
  enabled: boolean;
  pipelineRoot?: string;
  python?: string;
  execute?: (input: ConsolidationInput) => Promise<ConsolidationOutput>;
};

/** A separate local process: never contacts the HTTP sidecar or a model. */
export class FontConsolidation {
  private readonly pipeline: string;
  private readonly python: string;
  constructor(private readonly store: Pick<DeckStore,"fontsDirectory">,
    private readonly mutations: Pick<DeckMutations,"mutate">,
    private readonly fonts: Pick<FontRegistry,"catalogFilePath">,
    private readonly options: Options) {
    this.pipeline = options.pipelineRoot ?? path.join(options.projectRoot,".local/pipeline");
    this.python = options.python ?? path.join(options.projectRoot,".local/python/bin/python");
  }

  async health() {
    if (!this.options.enabled) return { available:false, detail:"Font consolidation is disabled by TEXT_FONT_CONSOLIDATION." };
    if (this.options.execute) return { available:true };
    try {
      await Promise.all([this.python,path.join(this.pipeline,"scripts/matching/font_consolidation.py"),
        path.join(this.pipeline,"scripts/matching/python.sh"),path.join(this.options.projectRoot,"scripts/consolidate-fonts.py")].map(file=>access(file)));
      return { available:true };
    } catch { return { available:false, detail:"The local font-consolidation runtime is not installed." }; }
  }

  async run(deckId: string, slideIds: string[] | undefined, expectedRevision: number, beforeSave?: (deck: Deck) => Promise<void>) {
    const health = await this.health();
    if (!health.available) throw new FontConsolidationError(health.detail!,503);
    const summary: FontConsolidationSummary = { slides:0, consolidated:0, alreadyUniform:0, preserved:0, skipped:0 };
    const deck = await this.mutations.mutate(deckId, async current => {
      if (current.revision !== expectedRevision) throw new FontConsolidationError("The deck changed. Please try again using the latest saved version.");
      const wanted = new Set(slideIds ?? current.slides.map(s=>s.id));
      if ([...wanted].some(id=>!current.slides.some(s=>s.id===id))) throw new FontConsolidationError("Slide not found.",404);
      const selected = current.slides.filter(s=>wanted.has(s.id));
      if (selected.some(s=>["running","queued"].includes(s.recovery.status))) throw new FontConsolidationError("Wait for text recovery to finish before consolidating fonts.");
      const input: ConsolidationInput = { fonts:{}, slides:selected.filter(s=>s.layers).map(s=>({id:s.id,canvas:s.canvas,objects:s.layers!.objects})) };
      const ids = new Set(input.slides.flatMap(s=>s.objects.flatMap(o=>o.resolved?.words.map(w=>w.fontId) ?? [])));
      await Promise.all([...ids].map(async id => {
        const file = await this.fontFile(current,id);
        if (file) input.fonts[id] = file;
      }));
      const result = outputSchema.parse(await (this.options.execute?.(input) ?? this.execute(input)));
      summary.slides = input.slides.length;
      const replacements = new Map<string,Map<string,TextObject>>();
      for (const item of result.slides) {
        if (!wanted.has(item.id)) throw new Error("Unexpected slide in consolidation output.");
        for (const key of ["consolidated","alreadyUniform","preserved","skipped"] as const) summary[key] += item.counts[key];
        if (item.updates.length) replacements.set(item.id,new Map(item.updates.map(o=>[o.id,o])));
      }
      if (!replacements.size) { await beforeSave?.(current); return current; }
      const next = { ...current, slides:current.slides.map(slide => {
        const updates = replacements.get(slide.id);
        if (!updates || !slide.layers) return slide;
        return { ...slide, state:"edited" as const, layers:{ ...slide.layers, objects:slide.layers.objects.map(object=>updates.get(object.id) ?? object) } };
      }) };
      // Consolidation preserves section meaning/placement. Keep valid highlight
      // rectangles, and require an explicit retry if none can be reused.
      // This prevents the normal edit listener from starting a model call.
      next.slides = next.slides.map(slide => {
        if (!replacements.has(slide.id) || !parseFocusCues(slide.talkingPoints).length) return slide;
        const previous = current.slides.find(s=>s.id===slide.id)!;
        const regions = currentFocusRegions(current,previous);
        return { ...slide, focusRegions:regions.length
          ? { ...previous.focusRegions!, inputKey:focusInputKey(next,slide) }
          : { inputKey:focusInputKey(next,slide),status:"failed" as const,regions:[],updatedAt:new Date().toISOString(),
              model:previous.focusRegions?.model ?? "",error:"No saved highlights to reuse. Use Retry highlights to generate them." } };
      });
      await beforeSave?.(next);
      return next;
    });
    return { deck, summary };
  }

  async fontFile(deck: Deck, id: string): Promise<FontFile | undefined> {
    const font = deck.fonts.find(f=>f.id===id);
    if (!font) return;
    if (font.source === "catalog" && font.catalogId) {
      const file = this.fonts.catalogFilePath(font.catalogId);
      return file && { path:file.path,face_index:file.faceIndex };
    }
    const prefix = `/api/assets/${deck.id}/fonts/`;
    if (!font.url.startsWith(prefix)) return;
    try {
      const name = decodeURIComponent(font.url.slice(prefix.length));
      if (!name || path.basename(name)!==name || name.startsWith(".")) return;
      const directory = await realpath(this.store.fontsDirectory(deck.id));
      const file = await realpath(path.join(directory,name));
      if (!file.startsWith(directory+path.sep)) return;
      return { path:file,face_index:0 };
    } catch { return; }
  }

  private execute(input: ConsolidationInput): Promise<ConsolidationOutput> {
    return new Promise((resolve,reject) => {
      const child = execFile("sh",[path.join(this.pipeline,"scripts/matching/python.sh"),
        path.join(this.options.projectRoot,"scripts/consolidate-fonts.py"),this.pipeline],
      { cwd:this.options.projectRoot,env:{...process.env,SIDECAR_PYTHON:this.python},timeout:60_000,maxBuffer:16_000_000 },
      (error,stdout,stderr) => {
        if (error) { console.error("Local font consolidation failed:",stderr); reject(new FontConsolidationError("Local font consolidation failed. The deck was not changed.",500)); return; }
        try { resolve(outputSchema.parse(JSON.parse(stdout))); } catch (error) { reject(error); }
      });
      child.stdin?.on("error",()=>{});
      child.stdin?.end(JSON.stringify(input));
    });
  }
}
