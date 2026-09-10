import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toCanvas } from "html-to-image";
import { PDFDocument } from "pdf-lib";
import type { Deck, DeckFont, Slide } from "../shared/types";
import { fontFamilyFor, loadFont, resolveFont } from "./fonts";
import { SlideCanvas } from "./SlideCanvas";

// Capture the editor's SVG/HTML layout rather than laying out text a second
// time. PDF pages contain lossless images, so readers need no installed fonts.
const PIXEL_RATIO = 2;
const POINTS_PER_CSS_PIXEL = 72 / 96;

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read an export asset."));
    reader.readAsDataURL(blob);
  });
}

function slideFonts(deck: Deck, slide: Slide): DeckFont[] {
  const fonts = new Map<string, DeckFont>();
  for (const object of slide.layers?.objects ?? []) {
    if (object.kind !== "text") continue;
    if (object.resolved) {
      for (const word of object.resolved.words) {
        const font = deck.fonts.find((candidate) => candidate.id === word.fontId);
        if (!font) throw new Error(`Missing recovered font ${word.fontId}.`);
        fonts.set(font.id, font);
      }
    } else {
      const font = resolveFont(deck, object.style);
      if (font) fonts.set(font.id, font);
    }
  }
  return [...fonts.values()];
}

export async function exportDeckToPdf(
  deck: Deck,
  onProgress: (completed: number, total: number) => void = () => {},
): Promise<Blob> {
  if (!deck.slides.length) throw new Error("This deck has no slides to export.");
  const pdf = await PDFDocument.create();
  pdf.setTitle(deck.title);
  pdf.setCreator("Monoprint");
  pdf.setProducer("Monoprint");

  const resources = new Map<string, Promise<string>>();
  const resource = (url: string) => {
    let pending = resources.get(url);
    if (!pending) {
      pending = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error("A slide image or font could not be loaded. Please try again.");
        return asDataUrl(await response.blob());
      });
      resources.set(url, pending);
    }
    return pending;
  };

  // Keep the render tree laid out but outside the viewport. display:none and
  // visibility:hidden would change or suppress the captured content.
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;";
  document.body.appendChild(host);
  const root = createRoot(host);

  try {
    onProgress(0, deck.slides.length);
    for (const [index, slide] of deck.slides.entries()) {
      const base = deck.assets.find((asset) => asset.id === slide.layers?.plateAssetId)
        ?? deck.assets.find((asset) => asset.id === slide.assetId);
      if (!base) throw new Error(`Slide ${index + 1} is missing its image.`);
      const imageUrl = await resource(base.url);
      const fonts = slideFonts(deck, slide);
      const fontEmbedCSS = (await Promise.all(fonts.map(async (font) => {
        await loadFont(font);
        const dataUrl = await resource(font.url);
        return `@font-face { font-family: ${JSON.stringify(fontFamilyFor(font))}; src: url(${JSON.stringify(dataUrl)}); font-weight: ${font.weight}; font-style: ${font.style}; }`;
      }))).join("\n");
      const snapshot = { ...deck, assets: deck.assets.map((asset) => asset.id === base.id ? { ...asset, url: imageUrl } : asset) };
      flushSync(() => root.render(<SlideCanvas key={slide.id} deck={snapshot} slide={slide} width={slide.canvas.width} />));
      await document.fonts.ready;
      await Promise.all(Array.from(host.querySelectorAll("img"), (image) => image.decode()));
      const element = host.firstElementChild as HTMLElement;
      const canvas = await toCanvas(element, {
        width: slide.canvas.width,
        height: slide.canvas.height,
        pixelRatio: PIXEL_RATIO,
        fontEmbedCSS,
        // html-to-image rounds copied font-size values down. SlideCanvas
        // already specifies exact sizes inline (or on SVG text); retain them.
        includeStyleProperties: Array.from(getComputedStyle(element)).filter((name) => name !== "font-size"),
        // Never silently resize a large slide to fit the browser canvas limit.
        skipAutoScale: true,
      });
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error(`Could not render slide ${index + 1}.`)), "image/png",
      ));
      const image = await pdf.embedPng(await png.arrayBuffer());
      const width = slide.canvas.width * POINTS_PER_CSS_PIXEL;
      const height = slide.canvas.height * POINTS_PER_CSS_PIXEL;
      const page = pdf.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      // Embed and release each page before rendering the next one.
      await pdf.flush();
      canvas.width = canvas.height = 0;
      resources.delete(base.url);
      onProgress(index + 1, deck.slides.length);
    }
    const bytes = await pdf.save();
    return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  } finally {
    root.unmount();
    host.remove();
  }
}

export function downloadPdf(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "Presentation"}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to finish handing the Blob to its download manager.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
