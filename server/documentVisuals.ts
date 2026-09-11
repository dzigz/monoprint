import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import sharp from "sharp";
import type { Attachment, FileSource } from "../src/shared/types.js";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const PDF_ROOT = path.dirname(require.resolve("pdfjs-dist/package.json"));
const MAX_TEXT = 1_500_000;
const MAX_IMAGE_BYTES = 12_000_000;
export const MAX_SOURCE_VISUALS = 14; // Leaves two of the image API's 16 slots for style anchors.
export type Crop = { x: number; y: number; width: number; height: number };
export type Visual = { id: string; attachmentId: string; name: string; locator: string; kind: "page" | "image" | "crop" };
export type PreparedVisual = Visual & { path: string; width: number; height: number; mimeType: "image/png"; source: FileSource };
type Recipe = Visual & ({ file: string } | { pdf: string; page: number } | { parent: string; crop: Crop });
export type VisualDocument = { text?: string; pages?: number; visuals: Visual[]; warnings: string[] };
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function writeAtomic(file: string, content: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
const publicVisual = ({ id, attachmentId, name, locator, kind }: Visual): Visual => ({ id, attachmentId, name, locator, kind });
let officeQueue = Promise.resolve();

export function parseXml(text: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("Document XML entities are unsupported.");
  return new DOMParser({ errorHandler: { warning() {}, error(message) { throw new Error(message); }, fatalError(message) { throw new Error(message); } } }).parseFromString(text, "application/xml");
}
function elements(node: Document | Element, name: string) { return Array.from(node.getElementsByTagNameNS("*", name)); }
function relationshipPath(part: string) { return path.posix.join(path.posix.dirname(part), "_rels", path.posix.basename(part) + ".rels"); }
function targetPart(part: string, target: string) {
  const result = path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(part), target));
  if (result.startsWith("../") || result.includes("\\")) throw new Error("Invalid document relationship path.");
  return result;
}
async function xmlPart(zip: JSZip, part: string) {
  const file = zip.file(part); if (!file) throw new Error(`Missing document part: ${part}`);
  const text = await file.async("string"); if (text.length > 16_000_000) throw new Error(`Document part is too large: ${part}`);
  return parseXml(text);
}
async function relationships(zip: JSZip, part: string) {
  const rels = zip.file(relationshipPath(part));
  if (!rels) return [];
  return elements(parseXml(await rels.async("string")), "Relationship")
    .filter(e => e.getAttribute("TargetMode") !== "External")
    .map(e => ({ id: e.getAttribute("Id")!, type: e.getAttribute("Type")!, target: targetPart(part, e.getAttribute("Target")!) }));
}
function textFromXml(doc: Document) {
  return elements(doc, "p").map(p => {
    const tokens: string[] = [];
    const walk = (node: Element) => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 1) continue;
        const element = child as Element;
        if (element.localName === "p") continue; // Nested text boxes own their paragraphs.
        if (element.localName === "t") tokens.push(element.textContent ?? "");
        else if (element.localName === "tab") tokens.push("\t");
        else if (element.localName === "br" || element.localName === "cr") tokens.push("\n");
        else walk(element);
      }
    };
    walk(p); return tokens.join("");
  }).join("\n");
}

async function pdfDocument(file: string) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return getDocument({ data: new Uint8Array(await readFile(file)), useSystemFonts: true,
    standardFontDataUrl: path.join(PDF_ROOT, "standard_fonts/"), cMapUrl: path.join(PDF_ROOT, "cmaps/"), cMapPacked: true,
    wasmUrl: path.join(PDF_ROOT, "wasm/") }).promise;
}
async function renderPdf(file: string, pageNumber: number) {
  const document = await pdfDocument(file);
  try {
    const page = await document.getPage(pageNumber); const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(3, 2200 / Math.max(base.width, base.height)) });
    const factory = document.canvasFactory as { create(w: number, h: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown }; destroy(c: unknown): void };
    const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvas: canvas.canvas as unknown as HTMLCanvasElement, canvasContext: canvas.context as CanvasRenderingContext2D, viewport }).promise;
      return canvas.canvas.toBuffer("image/png");
    } finally { factory.destroy(canvas); }
  } finally { await document.loadingTask.destroy(); }
}

async function officePdf(zip: JSZip, extension: string, directory: string, signal?: AbortSignal) {
  const destination = path.join(directory, "document.pdf");
  try { await access(destination); return destination; } catch { /* first conversion */ }
  // Render a private copy without external relationships. Never fetch linked artwork.
  const safe = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
  for (const file of Object.values(safe.files).filter(f => f.name.endsWith(".rels"))) {
    const xml = parseXml(await file.async("string"));
    for (const rel of elements(xml, "Relationship")) if (rel.getAttribute("TargetMode") === "External") rel.parentNode?.removeChild(rel);
    safe.file(file.name, new XMLSerializer().serializeToString(xml));
  }
  const input = path.join(directory, "document" + extension);
  await writeFile(input, await safe.generateAsync({ type: "nodebuffer" }));
  const bundled = path.join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice");
  const command = process.env.DOCUMENT_SOFFICE_PATH ?? bundled;
  let release!: () => void;
  const previous = officeQueue; officeQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  let profile: string | undefined;
  try {
    signal?.throwIfAborted();
    profile = await mkdtemp(path.join(tmpdir(), "monoprint-office-"));
    await exec(command, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--convert-to", "pdf", "--outdir", directory, input], { timeout: 120_000, maxBuffer: 2_000_000, signal });
    await access(destination);
    return destination;
  } finally {
    release();
    if (profile) await rm(profile, { recursive: true, force: true });
    await rm(input, { force: true });
  }
}

/** A source-scoped catalog. The agent receives IDs, never filesystem paths. */
export class DocumentVisuals {
  private documents = new Map<string, Promise<VisualDocument>>();
  private recipes = new Map<string, Recipe>();
  private directories = new Map<string, string>();
  private prepared = new Map<string, Promise<PreparedVisual>>();
  constructor(private attachments: Attachment[], private signal?: AbortSignal) {}

  document(attachment: Attachment) {
    let pending = this.documents.get(attachment.id);
    if (!pending) { pending = this.extract(attachment); this.documents.set(attachment.id, pending); }
    return pending;
  }
  private async extract(attachment: Attachment): Promise<VisualDocument> {
    if (!attachment.path) return { visuals: [], warnings: [] };
    this.signal?.throwIfAborted();
    const bytes = await readFile(attachment.path);
    const sourceHash = hash(bytes);
    const directory = path.join(path.dirname(attachment.path), ".visuals-v1", hash(attachment.id + sourceHash).slice(0, 32));
    await mkdir(directory, { recursive: true }); this.directories.set(attachment.id, directory);
    const visuals: Visual[] = []; const warnings: string[] = [];
    const add = (locator: string, kind: Visual["kind"], recipe: { file: string } | { pdf: string; page: number }) => {
      const visual = { id: "visual-" + hash(attachment.id + sourceHash + locator).slice(0, 24), attachmentId: attachment.id, name: attachment.name, locator, kind };
      this.recipes.set(visual.id, { ...visual, ...recipe }); visuals.push(visual);
    };
    const extension = path.extname(attachment.name).toLowerCase();
    let text: string | undefined, pages: number | undefined;
    const addPdf = async (file: string, extractText: boolean, noun: string) => {
      const doc = await pdfDocument(file); const chunks: string[] = [];
      try {
        pages = doc.numPages;
        let length = 0;
        for (let n = 1; n <= doc.numPages; n++) {
          this.signal?.throwIfAborted();
          add(`${noun} ${n}`, "page", { pdf: file, page: n });
          if (extractText && length < MAX_TEXT) {
            const page = await doc.getPage(n); const content = await page.getTextContent();
            const words = content.items.map(i => "str" in i ? i.str : "").join(" ");
            const chunk = `[${noun} ${n}]\n${words}`; chunks.push(chunk); length += chunk.length; page.cleanup();
          }
        }
        if (extractText) text = chunks.join("\n\n").slice(0, MAX_TEXT);
        if (length > MAX_TEXT) warnings.push(`Extracted text is limited to ${MAX_TEXT} characters; every page remains available visually.`);
      } finally { await doc.loadingTask.destroy(); }
    };
    if (extension === ".pdf" || attachment.mimeType === "application/pdf") {
      await addPdf(attachment.path, true, "Page");
    } else if ([".docx", ".pptx"].includes(extension) || /application\/vnd.openxmlformats-officedocument\.(wordprocessingml.document|presentationml.presentation)$/.test(attachment.mimeType ?? "")) {
      const isPptx = extension === ".pptx" || attachment.mimeType?.includes("presentationml");
      const zip = await JSZip.loadAsync(bytes);
      let linkedImages = 0;
      for (const relFile of Object.values(zip.files).filter(f => f.name.endsWith(".rels"))) {
        linkedImages += elements(parseXml(await relFile.async("string")), "Relationship")
          .filter(r => r.getAttribute("TargetMode") === "External" && r.getAttribute("Type")?.endsWith("/image")).length;
      }
      if (linkedImages) warnings.push(`${linkedImages} linked external image(s) are not embedded and were not fetched.`);
      let parts: { part: string; locator: string }[];
      if (isPptx) {
        const presentation = await xmlPart(zip, "ppt/presentation.xml");
        const rels = await relationships(zip, "ppt/presentation.xml");
        parts = elements(presentation, "sldId").map((s, i) => {
          const rid = s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? s.getAttribute("r:id");
          const part = rels.find(r => r.id === rid)?.target;
          if (!part) throw new Error(`Missing slide relationship at position ${i + 1}`);
          return { part, locator: `Slide ${i + 1}` };
        });
      } else {
        parts = [{ part: "word/document.xml", locator: "Document" }, ...Object.keys(zip.files)
          .filter(p => /^word\/(header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p)).sort().map(part => ({ part, locator: path.posix.basename(part, ".xml") }))];
      }
      const chunks: string[] = [];
      for (const { part, locator } of parts) {
        const xml = await xmlPart(zip, part); chunks.push(`[${locator}]\n${textFromXml(xml)}`);
        const rels = await relationships(zip, part);
        for (const note of rels.filter(r => r.type.endsWith("/notesSlide"))) {
          chunks.push(`[${locator} notes]\n${textFromXml(await xmlPart(zip, note.target))}`);
        }
        for (const rel of rels.filter(r => r.type.endsWith("/image"))) {
          const embedded = zip.file(rel.target);
          if (!embedded) { warnings.push(`${locator}: missing embedded image ${rel.id}.`); continue; }
          try {
            const image = await embedded.async("nodebuffer");
            const file = path.join(directory, hash(rel.target).slice(0, 24) + path.extname(rel.target));
            // Check decoder support now; unsupported Office vectors remain visible in page previews.
            await sharp(image, { limitInputPixels: 80_000_000 }).metadata();
            await writeAtomic(file, image); add(`${locator}, image ${rel.id}`, "image", { file });
          } catch { warnings.push(`${locator}: image ${rel.id} requires the rendered page preview.`); }
        }
      }
      text = chunks.join("\n\n").slice(0, MAX_TEXT);
      if (chunks.join("\n\n").length > MAX_TEXT) warnings.push(`Extracted text is limited to ${MAX_TEXT} characters.`);
      try { await addPdf(await officePdf(zip, isPptx ? ".pptx" : ".docx", directory, this.signal), false, isPptx ? "Slide" : "Page"); }
      catch (error) {
        this.signal?.throwIfAborted();
        warnings.push(`Page previews unavailable. Configure DOCUMENT_SOFFICE_PATH to a working LibreOffice executable. Text and extracted images remain available. ${error instanceof Error ? error.message.slice(0, 200) : "Conversion failed."}`);
      }
    } else {
      // Standalone images use the same IDs, rendering, and generation path as document images.
      await sharp(bytes, { limitInputPixels: 80_000_000 }).metadata();
      add("Attached image", "image", { file: attachment.path });
    }
    // Crop recipes survive agent/process resumption. Only current source IDs can be restored.
    for (const file of await readdir(directory)) {
      if (!/^crop-[a-f0-9]+\.json$/.test(file)) continue;
      try {
        const { parent, crop } = JSON.parse(await readFile(path.join(directory, file), "utf8"));
        if (this.recipes.has(parent)) this.addCrop(parent, crop);
      } catch { /* a stale or interrupted recipe can be recreated by the agent */ }
    }
    return { text, pages, visuals, warnings };
  }
  async list(attachmentId?: string) {
    const files = this.attachments.filter(a => a.kind === "file" && (!attachmentId || a.id === attachmentId));
    if (attachmentId && !files.length) throw new Error(`Unknown attachment ${attachmentId}.`);
    for (const file of files) if (isVisualDocument(file)) await this.document(file).catch(() => { this.signal?.throwIfAborted(); });
    return [...this.recipes.values()].filter(r => !attachmentId || r.attachmentId === attachmentId).map(publicVisual);
  }
  private addCrop(parent: string, crop: Crop) {
    const original = this.recipes.get(parent); if (!original) throw new Error(`Unknown visual ${parent}.`);
    if (original.kind === "crop") throw new Error("Crop the original visual, using its original coordinates.");
    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error("Crop must fit within normalized bounds 0–1.");
    const normalized = { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
    const id = "visual-" + hash(parent + JSON.stringify(normalized)).slice(0, 24);
    const recipe: Recipe = { ...publicVisual(original), id, kind: "crop", locator: `${original.locator}, crop ${JSON.stringify(normalized)}`, parent, crop: normalized };
    this.recipes.set(id, recipe); return recipe;
  }
  async crop(parent: string, crop: Crop) {
    await this.list(); const recipe = this.addCrop(parent, crop);
    const directory = this.directories.get(recipe.attachmentId)!;
    await writeAtomic(path.join(directory, `crop-${recipe.id.slice(7)}.json`), JSON.stringify({ parent, crop }));
    return recipe.id;
  }
  async prepare(id: string): Promise<PreparedVisual> {
    await this.list();
    let pending = this.prepared.get(id);
    if (!pending) { pending = this.prepareOnce(id); this.prepared.set(id, pending); pending.catch(() => this.prepared.delete(id)); }
    return pending;
  }
  private async prepareOnce(id: string): Promise<PreparedVisual> {
    this.signal?.throwIfAborted();
    const recipe = this.recipes.get(id); if (!recipe) throw new Error(`Unknown attachment visual ${id}. Use list_attachment_visuals.`);
    const file = path.join(this.directories.get(recipe.attachmentId)!, id + ".png");
    try { await access(file); } catch {
      let input: Buffer;
      if ("parent" in recipe) {
        const parent = await this.prepare(recipe.parent); const c = recipe.crop;
        const left = Math.floor(c.x * parent.width), top = Math.floor(c.y * parent.height);
        const width = Math.min(parent.width - left, Math.max(1, Math.round(c.width * parent.width)));
        const height = Math.min(parent.height - top, Math.max(1, Math.round(c.height * parent.height)));
        input = await sharp(parent.path).extract({ left, top, width, height }).png().toBuffer();
      } else input = "pdf" in recipe ? await renderPdf(recipe.pdf, recipe.page) : await readFile(recipe.file);
      let image = await sharp(input, { limitInputPixels: 80_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true }).png().toBuffer();
      if (image.byteLength > MAX_IMAGE_BYTES) image = await sharp(image).resize({ width: 1600, height: 1600, fit: "inside" }).png().toBuffer();
      if (image.byteLength > MAX_IMAGE_BYTES) throw new Error("Visual exceeds the image input size limit after resizing.");
      await writeAtomic(file, image);
    }
    const meta = await sharp(file).metadata();
    return { ...publicVisual(recipe), path: file, width: meta.width!, height: meta.height!, mimeType: "image/png",
      source: { id: `file-${id}`, title: recipe.name, kind: "file", attachmentId: recipe.attachmentId, locator: recipe.locator } };
  }
}
export function isVisualDocument(a: Attachment) {
  return a.kind === "file" && (/\.(pdf|docx|pptx|png|jpe?g|webp|gif)$/i.test(a.name) || /^(image\/(png|jpeg|webp|gif)|application\/pdf|application\/vnd.openxmlformats-officedocument\.(wordprocessingml.document|presentationml.presentation))$/.test(a.mimeType ?? ""));
}
