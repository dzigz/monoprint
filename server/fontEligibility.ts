import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import * as fontkit from "fontkit";
import * as hb from "harfbuzzjs";
import { canonicalLanguages } from "../src/shared/languages.js";
import { FONT_ROLE_NAMES, type PlannedTypography, type SlideCopyItem } from "../src/shared/types.js";
import type { LoadedFontCatalog } from "./fontCatalog.js";
import { fontEmbedding, type FontEmbedding } from "./fontEmbedding.js";

const require = createRequire(import.meta.url);
const cldrRoot = path.dirname(require.resolve("cldr-misc-full/package.json"));
const cldrVersion = (require("cldr-misc-full/package.json") as { version: string }).version;
// Match recovery's cmap requirement: even combining/format characters must be
// supported unless they are whitespace. Shaping alone can hide an unsupported character.
const ignorable = /^\p{White_Space}$/u;
const codePoints = (text: string) => [...new Set([...text].filter(char => !ignorable.test(char)))];

/** CLDR exemplar literals: characters, escaped literals, ranges, and {strings}.
 * Fail closed on unsupported UnicodeSet operators rather than inventing a repertoire.
 */
export function parseExemplarSet(input: string): string[] {
  if (!input.startsWith("[") || !input.endsWith("]")) throw new Error("Invalid CLDR exemplar set.");
  const source = [...input.slice(1, -1)];
  function escapeAt(index: number): { text: string; end: number } {
    let char = source[index + 1];
    if (!char) throw new Error("Incomplete exemplar escape.");
    if (char === "u" || char === "U") {
      const length = char === "u" ? 4 : 8;
      const hex = source.slice(index + 2, index + 2 + length).join("");
      if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) throw new Error("Invalid exemplar code point.");
      return { text: String.fromCodePoint(parseInt(hex, 16)), end: index + 1 + length };
    }
    if (/[pPN]/.test(char)) throw new Error("Unsupported exemplar property escape.");
    return { text: char, end: index + 1 };
  }
  const tokens: Array<{ text: string; literal: boolean }> = [];
  for (let i = 0; i < source.length; i++) {
    let char = source[i];
    if (/\s/u.test(char)) continue;
    if (char === "\\") {
      const escaped = escapeAt(i); i = escaped.end;
      tokens.push({ text: escaped.text, literal: true });
    } else if (char === "{") {
      let text = "";
      while (++i < source.length && source[i] !== "}") {
        if (source[i] === "{") throw new Error("Invalid nested exemplar string.");
        if (source[i] === "\\") { const escaped = escapeAt(i); text += escaped.text; i = escaped.end; }
        else text += source[i];
      }
      if (!text || source[i] !== "}") throw new Error("Invalid exemplar string.");
      tokens.push({ text, literal: true });
    } else {
      if (/[\[\]&^}:]/.test(char)) throw new Error("Unsupported exemplar set operator.");
      tokens.push({ text: char, literal: false });
    }
  }
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (tokens[i + 1]?.text === "-" && !tokens[i + 1].literal) {
      const end = tokens[i + 2];
      if (!end || [...token.text].length !== 1 || [...end.text].length !== 1) throw new Error("Invalid exemplar range.");
      const first = token.text.codePointAt(0)!, last = end.text.codePointAt(0)!;
      if (last < first) throw new Error("Reversed exemplar range.");
      for (let cp = first; cp <= last; cp++) result.push(String.fromCodePoint(cp));
      i += 2;
    } else {
      if (token.text === "-" && !token.literal) throw new Error("Incomplete exemplar range.");
      result.push(token.text);
    }
  }
  return result;
}

export type LanguageRepertoire = { language: string; locale?: string; characters: string; status: "available" | "unavailable" };
const repertoires = new Map<string, Promise<LanguageRepertoire>>();
export function languageRepertoire(language: string): Promise<LanguageRepertoire> {
  const [tag] = canonicalLanguages([language]);
  let pending = repertoires.get(tag);
  if (!pending) {
    pending = (async () => {
      const requested = new Intl.Locale(tag), maximized = requested.maximize();
      const candidates = [...new Set([
        requested.baseName, maximized.baseName,
        ...(maximized.script ? [`${requested.language}-${maximized.script}`] : []),
        requested.region ? `${requested.language}-${requested.region}` : requested.language,
        requested.language,
      ])];
      for (const locale of candidates) {
        // A missing script-specific locale must never fall back to another script.
        if (new Intl.Locale(locale).maximize().script !== maximized.script) continue;
        let data;
        try { data = JSON.parse(await readFile(path.join(cldrRoot, "main", locale, "characters.json"), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        const exemplar = data.main?.[locale]?.characters?.exemplarCharacters;
        if (typeof exemplar !== "string") continue;
        const values = parseExemplarSet(exemplar).map(value => value.normalize("NFC"));
        const characters = codePoints(values.flatMap(value => [value, value.toLocaleUpperCase(tag)]).join("")).join("");
        if (characters) return { language: tag, locale, characters, status: "available" as const };
      }
      return { language: tag, characters: "", status: "unavailable" as const };
    })();
    repertoires.set(tag, pending);
  }
  return pending;
}

type Snapshot = { key: string; bytes: Buffer; coverage: Set<number>; embedding: FontEmbedding };
type Check = { ok: boolean; missing: string[]; shapingError?: string; embedding?: FontEmbedding };
export type EligibleFont = {
  id: string; family: string; subfamily: string; style: "normal" | "italic"; weight: number; italic: boolean; axes: string[];
  embedding?: FontEmbedding;
};
type CopySlide = { slideId: string; copy?: SlideCopyItem[] };

/** Read-only font discovery and preflight. Cache identity includes file contents and collection face. */
export class FontEligibility {
  private readonly metadata = new Map<string, Pick<Snapshot, "coverage" | "embedding">>();
  private readonly shaped = new Map<string, Check>();
  private readonly shapers = new Map<string, hb.Font>();
  private readonly blobs = new Map<string, hb.Blob>();
  constructor(readonly catalog: LoadedFontCatalog) {}

  private async snapshot(id: string, files: Map<string, Promise<Buffer>>): Promise<Snapshot> {
    const face = this.catalog.faces.get(id);
    if (!face) throw new Error(`Unknown catalog font ${id}.`);
    let pending = files.get(face.absolutePath);
    if (!pending) {
      pending = readFile(face.absolutePath); files.set(face.absolutePath, pending);
      if (files.size > 4) files.delete(files.keys().next().value!);
    }
    const bytes = await pending;
    const key = `${createHash("sha256").update(bytes).digest("hex")}:${face.faceIndex}`;
    let metadata = this.metadata.get(key);
    if (!metadata) {
      const opened = fontkit.create(bytes);
      const font = ("fonts" in opened ? opened.fonts[face.faceIndex] : opened) as fontkit.Font;
      if (!font || !(font.unitsPerEm > 0)) throw new Error("Unreadable font face.");
      metadata = { coverage: new Set(font.characterSet.filter(cp => font.hasGlyphForCodePoint(cp))), embedding: fontEmbedding(font) };
      this.metadata.set(key, metadata);
    }
    return { key, bytes, ...metadata };
  }

  private shape(snapshot: Snapshot, id: string, text: string, languages: string[]): Check {
    const cacheKey = `${snapshot.key}:${JSON.stringify([languages, text])}`;
    const cached = this.shaped.get(cacheKey);
    if (cached) return cached;
    const missing = codePoints(text).filter(char => !snapshot.coverage.has(char.codePointAt(0)!));
    let result: Check = { ok: !missing.length, missing };
    if (!missing.length && text.trim()) {
      try {
        let font = this.shapers.get(snapshot.key);
        if (!font) {
          // Several faces can share a large TTC. Keep one native copy of its bytes.
          const fileKey = snapshot.key.split(":")[0];
          let blob = this.blobs.get(fileKey);
          if (!blob) {
            blob = new hb.Blob(snapshot.bytes); this.blobs.set(fileKey, blob);
            if (this.blobs.size > 8) this.blobs.delete(this.blobs.keys().next().value!);
          }
          const face = new hb.Face(blob, this.catalog.faces.get(id)!.faceIndex);
          font = new hb.Font(face);
          if (!font.nominalGlyph(" ".codePointAt(0)!) && !face.collectUnicodes().length) throw new Error("Font format is unavailable to the shaping engine.");
          this.shapers.set(snapshot.key, font);
          if (this.shapers.size > 16) this.shapers.delete(this.shapers.keys().next().value!);
        }
        // Word segmentation separates mixed-language runs while retaining combining/joining sequences.
        // Validate under every declared language; HarfBuzz guesses each segment's script/direction.
        const buffer = new hb.Buffer();
        for (const language of languages) {
          for (const { segment } of new Intl.Segmenter(language, { granularity: "word" }).segment(text)) {
            if (!codePoints(segment).length) continue;
            buffer.reset(); buffer.addText(segment); buffer.setLanguage(language); buffer.guessSegmentProperties();
            hb.shape(font, buffer);
            const glyphs = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions();
            if (!glyphs.length || glyphs.some(glyph => glyph.codepoint === 0)) throw new Error(`Missing shaped glyph in ${JSON.stringify(segment)}.`);
            if (positions.length !== glyphs.length || positions.some(position => ![position.xAdvance, position.yAdvance, position.xOffset, position.yOffset].every(Number.isFinite))) {
              throw new Error("Invalid shaped glyph positions.");
            }
          }
        }
      } catch (error) { result = { ok: false, missing, shapingError: error instanceof Error ? error.message : String(error) }; }
    }
    this.shaped.set(cacheKey, result);
    if (this.shaped.size > 2000) this.shaped.delete(this.shaped.keys().next().value!);
    return result;
  }

  describe(id: string): EligibleFont {
    const entry = this.catalog.entries.find(entry => entry.id === id), face = this.catalog.faces.get(id);
    if (!entry || !face) throw new Error(`Unknown catalog font ${id}. Call fetch_fonts for available faces.`);
    return { id, family: entry.family, subfamily: entry.subfamily, style: face.italic ? "italic" : "normal", weight: face.weight, italic: face.italic, axes: entry.axes };
  }

  async fetch({ languages, text, family, offset = 0, limit = 60 }: { languages: string[]; text?: string; family?: string; offset?: number; limit?: number }) {
    languages = canonicalLanguages(languages);
    const data = await Promise.all(languages.map(languageRepertoire));
    const unavailable = data.filter(item => item.status === "unavailable").map(item => item.language);
    const files = new Map<string, Promise<Buffer>>();
    const characters = codePoints(data.map(item => item.characters).join("") + (text ?? ""));
    const eligible: EligibleFont[] = [];
    let unreadable = 0;
    let excludedByEmbedding = 0;
    if (!unavailable.length || text?.trim()) {
      for (const entry of this.catalog.entries) {
        if (family && !entry.family.toLocaleLowerCase().includes(family.toLocaleLowerCase())) continue;
        try {
          const snapshot = await this.snapshot(entry.id, files);
          if (!snapshot.embedding.editable) { excludedByEmbedding++; continue; }
          if (!characters.every(char => snapshot.coverage.has(char.codePointAt(0)!))) continue;
          if (text && !this.shape(snapshot, entry.id, text, languages).ok) continue;
          eligible.push({ ...this.describe(entry.id), embedding: snapshot.embedding });
        } catch { unreadable++; }
      }
    }
    return {
      languages, repertoireSource: `Unicode CLDR ${cldrVersion} main exemplars with locale uppercase`,
      languageCoverage: data.map(({ characters: _characters, ...item }) => item),
      validation: text ? "language repertoire plus exact text and HarfBuzz shaping" : "language repertoire only; final copy still requires preflight",
      ...(unavailable.length ? { warning: `No repertoire data for ${unavailable.join(", ")}. Supply actual text for font discovery; language-wide support cannot be claimed.` } : {}),
      embeddingRequirement: "Editable outline embedding for PowerPoint; full fonts, without changing permission flags",
      excludedByEmbedding, unreadableFaces: unreadable, total: eligible.length, offset,
      fonts: eligible.slice(offset, offset + limit),
      nextOffset: offset + limit < eligible.length ? offset + limit : null,
    };
  }

  async checkText(id: string, text: string, languages: string[]): Promise<Check> {
    try { return this.shape(await this.snapshot(id, new Map()), id, text, canonicalLanguages(languages)); }
    catch (error) { return { ok: false, missing: [], shapingError: error instanceof Error ? error.message : String(error) }; }
  }

  async validate(languages: string[], typography: PlannedTypography, slides: CopySlide[]) {
    languages = canonicalLanguages(languages);
    const required = codePoints((await Promise.all(languages.map(languageRepertoire))).map(item => item.characters).join(""));
    const files = new Map<string, Promise<Buffer>>();
    const problems = [];
    for (const role of FONT_ROLE_NAMES) {
      this.describe(typography[role]);
      const items = slides.flatMap(slide => (slide.copy ?? []).filter(item => item.fontRole === role).map(item => ({ ...item, slideId: slide.slideId })));
      const text = items.map(item => item.text).join("\n");
      let check: Check;
      try {
        const snapshot = await this.snapshot(typography[role], files);
        const languageMissing = required.filter(char => !snapshot.coverage.has(char.codePointAt(0)!));
        check = this.shape(snapshot, typography[role], text, languages);
        check = { ...check, embedding: snapshot.embedding, ok: check.ok && !languageMissing.length && snapshot.embedding.editable, missing: [...new Set([...languageMissing, ...check.missing])] };
      } catch (error) { check = { ok: false, missing: [], shapingError: error instanceof Error ? error.message : String(error) }; }
      if (check.ok) continue;
      const alternatives = await this.fetch({ languages, text, limit: 8 });
      problems.push({ fontRole: role, font: this.describe(typography[role]), ...check,
        missing: check.missing.map(character => ({ character, codePoint: `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` })),
        affectedCopy: items.filter(item => !check.missing.length || check.missing.some(char => item.text.includes(char))).map(item => ({ slideId: item.slideId, role: item.role, text: item.text })),
        alternatives: alternatives.fonts,
      });
    }
    if (problems.length) throw new Error(`Font preflight failed. Select compatible faces with fetch_fonts and submit a revised ready_to_render plan; preserve the requested wording. ${JSON.stringify(problems)}`);
  }
}
