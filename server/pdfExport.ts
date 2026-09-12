import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright-core";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import { SlideCanvas } from "../src/editor/SlideCanvas.js";
import { resolveFont } from "../src/shared/fontSelection.js";
import type { Deck, DeckFont } from "../src/shared/types.js";
import type { DeckStore } from "./deckStore.js";
import type { FontConsolidation } from "./fontConsolidation.js";
import { standaloneFont } from "./fontContainer.js";
import { embeddingFromBytes } from "./fontEmbedding.js";

export class PdfExportError extends Error {
  constructor(message: string, readonly status = 500) { super(message); }
}

const origin = "https://monoprint-export.invalid";
const cssString = (text: string) => JSON.stringify(text).replace(/</g, "\\3c ");
const printCss = `
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; }
  section { break-after: page; overflow: hidden; }
  section:last-child { break-after: auto; }
  .slide-canvas { position: relative; overflow: hidden; }
  .slide-canvas__surface { position: absolute; left: 0; top: 0; transform-origin: top left; overflow: hidden; }
  .slide-canvas__base { position: absolute; left: 0; top: 0; width: 100%; height: 100%; object-fit: fill; }
`;

export function usedPdfFonts(deck: Deck): DeckFont[] {
  const result = new Map<string, DeckFont>();
  for (const slide of deck.slides) for (const object of slide.layers?.objects ?? []) {
    const fonts = object.resolved
      ? object.resolved.words.map(word => deck.fonts.find(font => font.id === word.fontId))
      : [resolveFont(deck, object.style)];
    for (const font of fonts) {
      if (!font) throw new PdfExportError("A text object is missing its exact font. Restore the font before exporting.", 409);
      result.set(font.id, font);
    }
  }
  return [...result.values()];
}

export async function pdfBrowserPath(configured = process.env.PDF_CHROMIUM_PATH) {
  const candidates = configured ? [configured] : [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
    chromium.executablePath(),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed browser. */ }
  }
  throw new PdfExportError("PDF export needs Chrome or Chromium. Install it or set PDF_CHROMIUM_PATH to its executable.", 503);
}

export class PdfExporter {
  constructor(private readonly store: Pick<DeckStore, "load" | "directory">,
    private readonly fonts: Pick<FontConsolidation, "fontFile">,
    private readonly options: { executablePath?: string } = {}) {}

  async run(deckId: string, expectedRevision: number) {
    // Export an immutable saved snapshot. Never consolidate, recover or save it.
    const deck = await this.store.load(deckId);
    if (deck.revision !== expectedRevision) throw new PdfExportError("The deck changed. Please export again using the latest saved version.", 409);
    if (!deck.slides.length) throw new PdfExportError("This deck has no slides to export.", 409);
    if (deck.slides.some(slide => ["running", "queued"].includes(slide.recovery.status))) {
      throw new PdfExportError("Wait for text recovery to finish before exporting.", 409);
    }
    const executablePath = await pdfBrowserPath(this.options.executablePath);
    const resources = new Map<string, { body: Buffer; contentType: string }>();
    const exportFonts = usedPdfFonts(deck);
    const fontCss: string[] = [];
    for (const [i, font] of exportFonts.entries()) {
      const file = await this.fonts.fontFile(deck, font.id);
      if (!file) throw new PdfExportError(`The font ${font.family} ${font.subfamily} is unavailable.`, 409);
      const bytes = standaloneFont(await readFile(file.path), file.face_index);
      const embedding = embeddingFromBytes(bytes);
      if (!["installable", "editable", "preview-print"].includes(embedding.mode) || embedding.noSubsetting) {
        throw new PdfExportError(`The font ${font.family} does not support this PDF embedding method.`, 409);
      }
      const url = `${origin}/font/${i}`;
      resources.set(url, { body: bytes, contentType: "font/ttf" });
      fontCss.push(`@font-face { font-family: ${cssString(font.id)}; src: url("${url}"); font-weight: ${font.weight}; font-style: ${font.style}; }`);
    }
    const directory = await realpath(this.store.directory(deckId));
    const assets = new Map<string, string>();
    for (const [i, slide] of deck.slides.entries()) {
      const base = deck.assets.find(asset => asset.id === slide.layers?.plateAssetId)
        ?? deck.assets.find(asset => asset.id === slide.assetId);
      if (!base) throw new PdfExportError(`Slide ${i + 1} is missing its image.`, 409);
      if (assets.has(base.id)) continue;
      const prefix = `/api/assets/${deck.id}/`;
      const name = base.url.startsWith(prefix) ? decodeURIComponent(base.url.slice(prefix.length)) : "";
      if (!name || path.basename(name) !== name || name.startsWith(".")) throw new PdfExportError("Invalid slide asset.", 409);
      const file = await realpath(path.join(directory, name));
      if (!file.startsWith(directory + path.sep)) throw new PdfExportError("Invalid slide asset.", 409);
      // Keep source pixels at their original resolution, with full chroma detail.
      const body = await sharp(file).flatten({ background: deck.designSystem.colors.background })
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
      const url = `${origin}/image/${i}`;
      resources.set(url, { body, contentType: "image/jpeg" });
      assets.set(base.id, url);
    }
    const snapshot = { ...deck, assets: deck.assets.map(asset => ({ ...asset, url: assets.get(asset.id) ?? "" })) };
    const pages = deck.slides.map((slide, i) => {
      const { width, height } = slide.canvas;
      return renderToStaticMarkup(createElement("section", { style: { page: `slide${i}`, width, height } },
        createElement(SlideCanvas, { deck: snapshot, slide, width })));
    }).join("");
    const pageCss = deck.slides.map((slide, i) => `@page slide${i} { size: ${slide.canvas.width}px ${slide.canvas.height}px; margin: 0; }`).join("\n");
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${printCss}\n${pageCss}\n${fontCss.join("\n")}</style></head><body>${pages}</body></html>`;
    const browser = await chromium.launch({ executablePath, headless: true });
    const deadline = setTimeout(() => { void browser.close(); }, 180_000);
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60_000);
      await page.route("**/*", route => {
        const resource = resources.get(route.request().url());
        return resource ? route.fulfill({ ...resource, headers: { "Access-Control-Allow-Origin": "*" } }) : route.abort();
      });
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(async fonts => {
        for (const font of fonts) {
          const faces = await document.fonts.load(`${font.style} ${font.weight} 16px ${JSON.stringify(font.id)}`);
          if (!faces.length || faces.some(face => face.status !== "loaded")) throw new Error(`Could not load the exact font ${font.id}.`);
        }
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, image => image.decode()));
        // Independently positioned SVG words need explicit spaces for copy/search.
        // A trailing space cannot move the next independently anchored word.
        for (const word of document.querySelectorAll("svg text")) {
          word.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
          (word as SVGTextElement).style.whiteSpace = "pre";
          if (word.textContent && !/\s$/.test(word.textContent)) word.textContent += " ";
        }
      }, exportFonts.map(({ id, weight, style }) => ({ id, weight, style })));
      const printed = await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true });
      const pdf = await PDFDocument.load(printed);
      if (pdf.getPageCount() !== deck.slides.length) throw new PdfExportError("PDF pagination did not match the deck.");
      pdf.setTitle(deck.title); pdf.setCreator("Monoprint"); pdf.setProducer("Monoprint");
      return Buffer.from(await pdf.save());
    } finally { clearTimeout(deadline); await browser.close(); }
  }
}
