import type { Deck, DeckFont, FontRoleName, TextStyle } from "./types.js";

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
