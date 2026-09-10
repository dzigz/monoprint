import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Deck, PptxExportReport } from "../src/shared/types.js";
import { resolveFont } from "../src/shared/fontSelection.js";
import type { DeckStore } from "./deckStore.js";
import { FontConsolidation, FontConsolidationError } from "./fontConsolidation.js";

const execute = promisify(execFile);
export class PptxExportError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}
type Options = {
  projectRoot: string; runtimeRoot?: string; pipelineRoot?: string; python?: string;
  build?: (deck: Deck, directory: string) => Promise<PptxExportReport>;
};

/** Export under the consolidation mutation lock: never builds from stale input
 * and never saves a half-consolidated deck if export preparation fails. */
export class PptxExporter {
  readonly root: string;
  private runtime: string;
  private pipeline: string;
  private python: string;
  constructor(private store: Pick<DeckStore,"directory">,
    private consolidation: Pick<FontConsolidation,"run"|"health"|"fontFile">,
    private options: Options) {
    this.root=path.join(options.projectRoot,".local/pptx-exports");
    this.runtime=options.runtimeRoot ?? path.join(homedir(),".cache/codex-runtimes/codex-primary-runtime/dependencies");
    this.pipeline=options.pipelineRoot ?? path.join(options.projectRoot,".local/pipeline");
    this.python=options.python ?? path.join(options.projectRoot,".local/python/bin/python");
  }
  async health() {
    const consolidation=await this.consolidation.health();
    if (!consolidation.available) return consolidation;
    if (this.options.build) return {available:true};
    try {
      await Promise.all([path.join(this.runtime,"node/bin/node"),path.join(this.runtime,"node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs"),
        path.join(this.options.projectRoot,"scripts/export-pptx.mjs"),path.join(this.options.projectRoot,"scripts/pptx-layout.py")].map(f=>access(f)));
      return {available:true};
    } catch { return {available:false,detail:"The PPTX export runtime is unavailable. Configure PPTX_RUNTIME_ROOT."}; }
  }
  async run(deckId: string, expectedRevision: number) {
    const health=await this.health();
    if (!health.available) throw new PptxExportError(health.detail!,503);
    const id=randomUUID();const directory=path.join(this.root,id);
    let report: PptxExportReport | undefined;
    let filename: string | undefined;
    try {
      // Mandatory even for a previously consolidated deck. This also catches
      // boxes introduced by later recovery or editing.
      const result=await this.consolidation.run(deckId,undefined,expectedRevision,async deck=>{
        assertExportable(deck);
        await mkdir(directory,{recursive:true});
        report=await (this.options.build?.(deck,directory) ?? this.build(deck,directory));
        filename=`${deck.title.replace(/[^\p{L}\p{N}._ -]+/gu,"_").slice(0,120) || "Presentation"}.pptx`;
        // Make the download usable before committing any consolidation changes.
        await writeFile(path.join(directory,"receipt.json"),JSON.stringify({deckId,sourceRevision:expectedRevision,filename,report,consolidationChecked:true,createdAt:new Date().toISOString()}));
      });
      return {...result,report:report!,downloadUrl:`/api/decks/${deckId}/pptx/${id}`,filename:filename!};
    } catch(error) {
      await rm(directory,{recursive:true,force:true});
      if (error instanceof PptxExportError || error instanceof FontConsolidationError) throw error;
      console.error("PPTX export failed:",error);
      throw new PptxExportError("PowerPoint export failed. The deck was not changed; see the server log for details.",500);
    }
  }
  async download(deckId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new PptxExportError("Export not found.",404);
    try {
      const directory=path.join(this.root,id);const receipt=JSON.parse(await readFile(path.join(directory,"receipt.json"),"utf8"));
      if (receipt.deckId!==deckId) throw new Error();
      const file=path.join(directory,"presentation.pptx");await access(file);
      return {file,filename:receipt.filename as string};
    } catch { throw new PptxExportError("Export not found. Please export the deck again.",404); }
  }
  private async build(deck: Deck, directory: string): Promise<PptxExportReport> {
    const fontFiles: Record<string,{path:string;face_index:number}>={};
    const selected=new Set<string>();
    // Resolve ordinary edited text with the same face selection as the editor.
    const snapshot=structuredClone(deck);
    for (const slide of snapshot.slides) for (const object of slide.layers!.objects) {
      if (object.resolved) object.resolved.words.forEach(w=>selected.add(w.fontId));
      else {
        const font=resolveFont(snapshot,object.style);
        if (!font) throw new PptxExportError(`Missing font for “${object.text.slice(0,40)}”.`,422);
        object.style.fontId=font.id;selected.add(font.id);
      }
    }
    await Promise.all([...selected].map(async id=>{
      const file=await this.consolidation.fontFile(snapshot,id);
      if (!file) throw new PptxExportError("An editable text font is missing. Recover the affected slide before exporting.",422);
      fontFiles[id]=file;
    }));
    const backgrounds: Record<string,string>={};
    const assetDirectory=await realpath(this.store.directory(deck.id));
    await Promise.all(snapshot.slides.map(async slide=>{
      const asset=snapshot.assets.find(a=>a.id===slide.layers!.plateAssetId);
      const prefix=`/api/assets/${deck.id}/`;
      if (!asset || !asset.url.startsWith(prefix)) throw new PptxExportError("A recovered slide background is missing.",422);
      const name=decodeURIComponent(asset.url.slice(prefix.length));
      if (!name || name.startsWith(".") || path.basename(name)!==name) throw new PptxExportError("Invalid slide background path.",422);
      const file=await realpath(path.join(assetDirectory,name));
      if (!file.startsWith(assetDirectory+path.sep)) throw new PptxExportError("Invalid slide background path.",422);
      backgrounds[slide.id]=file;
    }));
    const input=path.join(directory,"input.json"),plan=path.join(directory,"plan.json"),candidate=path.join(directory,"candidate.pptx"),output=path.join(directory,"presentation.pptx");
    await writeFile(input,JSON.stringify({deck:snapshot,fontFiles,backgrounds,fontCacheDirectory:path.join(this.options.projectRoot,".local/pptx-fonts")}));
    const pythonArgs=[path.join(this.pipeline,"scripts/matching/python.sh"),path.join(this.options.projectRoot,"scripts/pptx-layout.py")];
    const env={...process.env,SIDECAR_PYTHON:this.python};
    try {
      await execute("sh",[...pythonArgs,"prepare",input,plan],{env,timeout:180_000,maxBuffer:2_000_000});
      await execute(path.join(this.runtime,"node/bin/node"),[path.join(this.options.projectRoot,"scripts/export-pptx.mjs"),plan,candidate,path.join(this.runtime,"node/node_modules")],{env,timeout:180_000,maxBuffer:2_000_000});
      await execute("sh",[...pythonArgs,"finish",plan,output,"--candidate",candidate],{env,timeout:60_000,maxBuffer:2_000_000});
    } catch(error) {
      const detail=(error as {stderr?:string}).stderr;
      if (detail?.includes("Font does not permit editable embedding")) throw new PptxExportError("One of the fonts does not permit editable embedding. Export stopped to avoid substituting it.",422);
      if (detail?.includes("Combined horizontal scaling and rotation")) throw new PptxExportError("A text run combines rotation with horizontal scaling. PowerPoint cannot preserve that transform as native text; export stopped without changing the deck.",422);
      throw error;
    }
    const result=JSON.parse(await readFile(plan,"utf8"));
    await Promise.all(["fonts","input.json","plan.json","candidate.pptx","candidate.pptx.inspect.ndjson"].map(name=>rm(path.join(directory,name),{recursive:true,force:true})));
    return {slides:deck.slides.length,fonts:result.fonts.length,...result.stats};
  }
}

export function assertExportable(deck: Deck) {
  if (!deck.slides.length) throw new PptxExportError("There are no slides to export.",422);
  if (deck.slides.some(s=>!s.layers)) throw new PptxExportError("Recover text on every slide before exporting an editable PowerPoint.",422);
  const size=deck.slides[0].canvas;
  if (deck.slides.some(s=>s.canvas.width!==size.width || s.canvas.height!==size.height)) throw new PptxExportError("PowerPoint requires every slide to use the same canvas size.",422);
}
