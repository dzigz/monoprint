// Render a slide to a PNG data URL in the browser: plate image plus text
// objects drawn with the same fonts the editor uses. Used for bake and for
// showing the prompt agent what the user sees.

import type { Deck, Slide, TextObject } from "../shared/types";
import { fontFamilyFor, resolveFont } from "./fonts";

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

function wrapLine(context: CanvasRenderingContext2D, line: string, maxWidth: number) {
  const words = line.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

export async function renderSlideToDataUrl(deck: Deck, slide: Slide, scale = 1): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(slide.canvas.width * scale);
  canvas.height = Math.round(slide.canvas.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is not available.");
  context.scale(scale, scale);

  const baseAssetId = slide.layers?.plateAssetId ?? slide.assetId;
  const base = deck.assets.find((asset) => asset.id === baseAssetId);
  if (base) {
    const image = await loadImage(base.url);
    context.drawImage(image, 0, 0, slide.canvas.width, slide.canvas.height);
  } else {
    context.fillStyle = deck.designSystem.colors.background;
    context.fillRect(0, 0, slide.canvas.width, slide.canvas.height);
  }

  for (const object of slide.layers?.objects ?? []) {
    if (object.kind !== "text") continue;
    await drawText(context, deck, object);
  }
  return canvas.toDataURL("image/png");
}

async function drawText(context: CanvasRenderingContext2D, deck: Deck, object: TextObject) {
  const font = resolveFont(deck, object.style);
  const family = font ? `${JSON.stringify(fontFamilyFor(font))}, ${JSON.stringify(font.family)}` : "sans-serif";
  const size = object.style.fontSize;
  const fontSpec = `${object.style.italic && (!font || font.style !== "italic") ? "italic " : ""}${object.style.bold && (!font || font.weight < 600) ? "bold " : ""}${size}px ${family}`;
  try {
    await document.fonts.load(fontSpec);
  } catch {
    // Fall through with whatever the browser has.
  }
  context.font = fontSpec;
  context.fillStyle = object.style.color;
  context.textBaseline = "alphabetic";
  const extended = context as CanvasRenderingContext2D & { letterSpacing?: string; wordSpacing?: string };
  if ("letterSpacing" in extended) extended.letterSpacing = `${object.style.letterSpacing ?? 0}px`;
  if ("wordSpacing" in extended) extended.wordSpacing = `${object.style.wordSpacing ?? 0}px`;

  const metrics = font?.metrics;
  const unitsPerEm = metrics?.unitsPerEm ?? 1000;
  const ascent = ((metrics?.ascent ?? unitsPerEm * 0.8) / unitsPerEm) * size;
  const descent = (Math.abs(metrics?.descent ?? unitsPerEm * 0.2) / unitsPerEm) * size;
  const lineHeightPx = object.style.lineHeight * size;
  const halfLeading = (lineHeightPx - (ascent + descent)) / 2;
  const transform = object.style.transform === "uppercase" ? (text: string) => text.toUpperCase() : (text: string) => text;
  const paragraphs = transform(object.text).split("\n");
  const lines = paragraphs.flatMap((paragraph) => wrapLine(context, paragraph, object.frame.width));
  lines.forEach((line, index) => {
    const baseline = object.frame.y + halfLeading + ascent + index * lineHeightPx;
    const width = context.measureText(line).width;
    const x = object.style.align === "center"
      ? object.frame.x + object.frame.width / 2 - width / 2
      : object.style.align === "right"
        ? object.frame.x + object.frame.width - width
        : object.frame.x;
    context.fillText(line, x, baseline);
  });
}
