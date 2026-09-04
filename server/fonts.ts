// Font registry: resolves design-system roles and fitted instance fonts to
// files the browser can load, with the metrics needed for baseline placement.

import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  Deck,
  DeckFont,
  DeckFontVariants,
  DesignSystem,
  FontCatalogEntry,
  FontRoleName,
} from "../src/shared/types.js";
import { FONT_ROLE_NAMES } from "../src/shared/types.js";
import { readFontMetrics, weightFromSubfamily, isItalicSubfamily, type FontFace, type LoadedFontCatalog } from "./fontCatalog.js";

export const CATALOG_FONT_PREFIX = "catalog:";
export const FITTED_FONT_PREFIX = "fitted:";

export class FontRegistry {
  private readonly byId: Map<string, FontCatalogEntry>;
  private readonly byFamily: Map<string, FontCatalogEntry[]>;
  private readonly metricsCache = new Map<string, DeckFont["metrics"]>();

  constructor(readonly catalog: LoadedFontCatalog, readonly artifactsRoot: string) {
    this.byId = new Map(catalog.entries.map((entry) => [entry.id, entry]));
    this.byFamily = new Map();
    for (const entry of catalog.entries) {
      const key = entry.family.toLowerCase();
      this.byFamily.set(key, [...(this.byFamily.get(key) ?? []), entry]);
    }
  }

  entry(catalogId: string) {
    return this.byId.get(catalogId);
  }

  face(catalogId: string): FontFace | undefined {
    return this.catalog.faces.get(catalogId);
  }

  familyEntries(family: string) {
    return this.byFamily.get(family.toLowerCase()) ?? [];
  }

  /** Find a catalog face by family and subfamily, tolerant of spacing/underscores. */
  findFace(family: string, subfamily?: string) {
    const entries = this.familyEntries(family);
    if (!entries.length) return undefined;
    if (!subfamily) return entries.find((entry) => /^regular$/i.test(entry.subfamily)) ?? entries[0];
    const normalized = subfamily.replace(/[_\s-]+/g, "").toLowerCase();
    return entries.find((entry) => entry.subfamily.replace(/[_\s-]+/g, "").toLowerCase() === normalized)
      ?? entries.find((entry) => entry.subfamily.replace(/[_\s-]+/g, "").toLowerCase().includes(normalized));
  }

  private metricsFor(absolutePath: string, faceIndex: number) {
    const key = `${absolutePath}#${faceIndex}`;
    if (!this.metricsCache.has(key)) this.metricsCache.set(key, readFontMetrics(absolutePath, faceIndex));
    return this.metricsCache.get(key);
  }

  deckFontId(catalogId: string) {
    return `${CATALOG_FONT_PREFIX}${catalogId}`;
  }

  deckFontForCatalog(catalogId: string, includeVariants = true): DeckFont | undefined {
    const entry = this.entry(catalogId);
    const face = this.face(catalogId);
    if (!entry || !face) return undefined;
    const localNames = [face.fullName, face.postscriptName, `${entry.family} ${entry.subfamily}`, entry.family]
      .filter((name): name is string => Boolean(name));
    return {
      id: this.deckFontId(catalogId),
      family: entry.family,
      subfamily: entry.subfamily,
      weight: face.weight || weightFromSubfamily(entry.subfamily),
      style: face.italic || isItalicSubfamily(entry.subfamily) ? "italic" : "normal",
      url: `/api/fonts/catalog/${catalogId}`,
      source: "catalog",
      catalogId,
      localNames: [...new Set(localNames)],
      metrics: this.metricsFor(face.absolutePath, face.faceIndex),
      ...(includeVariants ? { variants: this.variantsFor(entry) } : {}),
    };
  }

  /** Bold, italic, and bold-italic siblings within the same family. */
  variantsFor(entry: FontCatalogEntry): DeckFontVariants | undefined {
    const siblings = this.familyEntries(entry.family).filter((candidate) => candidate.id !== entry.id);
    if (!siblings.length) return undefined;
    const baseFace = this.face(entry.id);
    const baseWeight = baseFace?.weight ?? weightFromSubfamily(entry.subfamily);
    const baseItalic = baseFace?.italic ?? isItalicSubfamily(entry.subfamily);
    const describe = (candidate: FontCatalogEntry) => {
      const face = this.face(candidate.id);
      return {
        entry: candidate,
        weight: face?.weight ?? weightFromSubfamily(candidate.subfamily),
        italic: face?.italic ?? isItalicSubfamily(candidate.subfamily),
      };
    };
    const described = siblings.map(describe);
    const pickBold = (italic: boolean) => {
      const heavier = described
        .filter((candidate) => candidate.italic === italic && candidate.weight > baseWeight && candidate.weight <= 900)
        .sort((a, b) => Math.abs(a.weight - 700) - Math.abs(b.weight - 700));
      return heavier[0]?.entry;
    };
    const pickItalic = (weight: number) => described
      .filter((candidate) => candidate.italic)
      .sort((a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight))[0]?.entry;
    const variants: DeckFontVariants = {};
    if (!baseItalic) {
      const bold = pickBold(false);
      if (bold) variants.bold = this.deckFontId(bold.id);
      const italic = pickItalic(baseWeight);
      if (italic) variants.italic = this.deckFontId(italic.id);
      const boldItalic = pickItalic(Math.max(700, baseWeight + 100));
      if (boldItalic && boldItalic.id !== italic?.id) variants.boldItalic = this.deckFontId(boldItalic.id);
    } else {
      const bold = pickBold(true);
      if (bold) variants.bold = this.deckFontId(bold.id);
    }
    return Object.keys(variants).length ? variants : undefined;
  }

  /** Every deck font a design system needs: the four role fonts plus their variants. */
  roleFonts(designSystem: DesignSystem): DeckFont[] {
    const fonts = new Map<string, DeckFont>();
    const add = (catalogId: string, includeVariants: boolean) => {
      const font = this.deckFontForCatalog(catalogId, includeVariants);
      if (font && !fonts.has(font.id)) fonts.set(font.id, font);
      return font;
    };
    for (const role of FONT_ROLE_NAMES) {
      const font = add(designSystem.typography[role].fontId, true);
      for (const variantId of Object.values(font?.variants ?? {})) {
        add(variantId.slice(CATALOG_FONT_PREFIX.length), false);
      }
    }
    return [...fonts.values()];
  }

  /** Merge role fonts into a deck without dropping fitted fonts it already carries. */
  ensureDeckFonts(deck: Deck): Deck {
    const existing = new Map(deck.fonts.map((font) => [font.id, font]));
    let changed = false;
    for (const font of this.roleFonts(deck.designSystem)) {
      const current = existing.get(font.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(font)) {
        existing.set(font.id, font);
        changed = true;
      }
    }
    return changed ? { ...deck, fonts: [...existing.values()] } : deck;
  }

  roleFont(deck: Deck, role: FontRoleName) {
    return deck.fonts.find((font) => font.id === this.deckFontId(deck.designSystem.typography[role].fontId));
  }

  /** Register a fitted instance font produced by a recovery provider, copying it into the deck's artifacts. */
  async registerFittedFont({
    deckId,
    sourcePath,
    family,
    subfamily,
    weight,
    style,
    label,
  }: {
    deckId: string;
    sourcePath: string;
    family: string;
    subfamily: string;
    weight?: number;
    style?: "normal" | "italic";
    label: string;
  }): Promise<DeckFont> {
    const fontsDirectory = path.join(this.artifactsRoot, deckId, "fonts");
    await mkdir(fontsDirectory, { recursive: true });
    const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, "_");
    const fileName = `${safeLabel}${path.extname(sourcePath) || ".ttf"}`;
    const destination = path.join(fontsDirectory, fileName);
    await copyFile(sourcePath, destination);
    const catalogFace = this.findFace(family, subfamily);
    return {
      id: `${FITTED_FONT_PREFIX}${deckId.slice(0, 8)}:${safeLabel}`,
      family,
      subfamily,
      weight: weight ?? weightFromSubfamily(subfamily),
      style: style ?? (isItalicSubfamily(subfamily) ? "italic" : "normal"),
      url: `/api/assets/${deckId}/fonts/${fileName}`,
      source: "fitted",
      ...(catalogFace ? { catalogId: catalogFace.id } : {}),
      metrics: readFontMetrics(destination, 0),
    };
  }

  catalogFilePath(catalogId: string) {
    const face = this.face(catalogId);
    return face ? { path: face.absolutePath, faceIndex: face.faceIndex } : undefined;
  }
}
