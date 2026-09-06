// Browser font loading for deck fonts. Each deck font is registered under its
// own id as the CSS family name, so objects can point at an exact face.

import type { Deck, DeckFont, FontRoleName, TextStyle } from "../shared/types";

const loaded = new Map<string, Promise<void>>();

export function fontFamilyFor(font: DeckFont) {
  return font.id;
}

export function loadDeckFonts(deck: Deck) {
  return Promise.all(deck.fonts.map((font) => loadFont(font)));
}

export function loadFont(font: DeckFont) {
  const existing = loaded.get(font.id);
  if (existing) return existing;
  const sources = [
    ...(font.localNames ?? []).map((name) => `local(${JSON.stringify(name)})`),
    `url(${JSON.stringify(font.url)})`,
  ].join(", ");
  const pending = (async () => {
    if (typeof FontFace === "undefined") return;
    try {
      const face = new FontFace(fontFamilyFor(font), sources, {
        weight: String(font.weight),
        style: font.style,
        display: "block",
      });
      await face.load();
      document.fonts.add(face);
    } catch (error) {
      if (font.source === "fitted") {
        loaded.delete(font.id);
        throw new Error(`Could not load the exact recovered font ${font.id}`, { cause: error });
      }
      console.warn(`Font ${font.family} ${font.subfamily} could not be loaded; falling back.`, error);
      try {
        const face = new FontFace(fontFamilyFor(font), (font.localNames ?? [font.family]).map((name) => `local(${JSON.stringify(name)})`).join(", "));
        await face.load();
        document.fonts.add(face);
      } catch {
        // The browser falls back to the generic family.
      }
    }
  })();
  loaded.set(font.id, pending);
  return pending;
}

export function roleFont(deck: Deck, role: FontRoleName) {
  const catalogId = deck.designSystem.typography[role].fontId;
  return deck.fonts.find((font) => font.catalogId === catalogId && font.source === "catalog")
    ?? deck.fonts.find((font) => font.id === `catalog:${catalogId}`);
}

/** Resolve the deck font an object should render with, honouring bold/italic toggles. */
export function resolveFont(deck: Deck, style: TextStyle): DeckFont | undefined {
  const base = (style.fontId ? deck.fonts.find((font) => font.id === style.fontId) : undefined) ?? roleFont(deck, style.fontRole);
  if (!base) return undefined;
  if (!style.bold && !style.italic) return base;
  const variantHost = base.variants ? base : roleFont(deck, style.fontRole);
  const variants = variantHost?.variants;
  const wantsBold = Boolean(style.bold) && base.weight < 600;
  const wantsItalic = Boolean(style.italic) && base.style !== "italic";
  const variantId = wantsBold && wantsItalic
    ? variants?.boldItalic ?? variants?.bold ?? variants?.italic
    : wantsBold
      ? variants?.bold
      : wantsItalic
        ? variants?.italic
        : undefined;
  return (variantId ? deck.fonts.find((font) => font.id === variantId) : undefined) ?? base;
}

export function cssFontStack(font: DeckFont | undefined, fallback = "sans-serif") {
  if (!font) return fallback;
  return `${JSON.stringify(fontFamilyFor(font))}, ${JSON.stringify(font.family)}, ${fallback}`;
}

export function hasVariant(deck: Deck, style: TextStyle, variant: "bold" | "italic") {
  const base = (style.fontId ? deck.fonts.find((font) => font.id === style.fontId) : undefined) ?? roleFont(deck, style.fontRole);
  const host = base?.variants ? base : roleFont(deck, style.fontRole);
  if (variant === "bold") return Boolean(host?.variants?.bold) || (base ? base.weight >= 600 : false);
  return Boolean(host?.variants?.italic) || base?.style === "italic";
}
