import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, copyFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { RunContext } from "@openai/agents";
import { loadFontCatalog } from "./fontCatalog.js";
import { FontEligibility, languageRepertoire, parseExemplarSet } from "./fontEligibility.js";
import { createFetchFontsTool } from "./authoringFonts.js";
import { canonicalLanguages, targetLanguagesSchema } from "../src/shared/languages.js";

const root = path.resolve("server/testFixtures/fonts");
const catalog = await loadFontCatalog(root);
const fonts = new FontEligibility(catalog);
const id = (file: string) => catalog.entries.find(entry => entry.sourceLabel === file)!.id;

test("CLDR exemplars parse for every shipped locale, including ranges, escaped strings and supplementary code points", async () => {
  const require = createRequire(import.meta.url);
  const main = path.join(path.dirname(require.resolve("cldr-misc-full/package.json")), "main");
  const locales = await readdir(main);
  assert(locales.length > 700);
  for (const locale of locales) {
    const data = JSON.parse(await readFile(path.join(main, locale, "characters.json"), "utf8"));
    assert.doesNotThrow(() => parseExemplarSet(data.main[locale].characters.exemplarCharacters), locale);
  }
  assert.deepEqual(parseExemplarSet('[a-c {n\\-} \\u00E9 \\U0001F600]'), ['a', 'b', 'c', 'n-', 'é', '😀']);
  for (const set of ['[a-]', '[z-a]', '[[:Latin:]]', '[a&&b]', '[{abc]', '[\\u12]']) assert.throws(() => parseExemplarSet(set));
});

test("language resolution respects scripts and region fallback without guessing another language", async () => {
  assert.deepEqual(canonicalLanguages(["sr-latn", "sv", "sr-Latn"]), ["sr-Latn", "sv"]);
  assert(!targetLanguagesSchema.safeParse(["../../de"]).success);
  assert(!targetLanguagesSchema.safeParse(["und"]).success);
  assert(!targetLanguagesSchema.safeParse([]).success);
  const latin = await languageRepertoire("sr-Latn-BA"), cyrillic = await languageRepertoire("sr-Cyrl");
  assert.match(latin.characters, /đ/); assert(!latin.characters.includes("ђ"));
  assert.match(cyrillic.characters, /ђ/); assert(!cyrillic.characters.includes("đ"));
  assert.equal((await languageRepertoire("en-Cyrl")).status, "unavailable");
  assert.equal((await languageRepertoire("qaa")).status, "unavailable");
});

test("discovery filters individual weights, italics and collection faces, with mixed-language intersection and pagination", async () => {
  const german = await fonts.fetch({ languages: ["de"] });
  assert(german.fonts.some(font => font.id === id("Narrow-Bold.ttf")));
  const swedish = await fonts.fetch({ languages: ["sv"] });
  assert(swedish.fonts.some(font => font.id === id("Narrow-Italic.ttf")));
  const mixed = await fonts.fetch({ languages: ["sr-Latn", "sv", "de"] });
  assert(mixed.fonts.some(font => font.id === id("Wide-Regular.ttf")));
  assert(mixed.fonts.some(font => font.id === id("Two-Faces.ttc")));
  for (const file of ["Narrow-Bold.ttf", "Narrow-Italic.ttf", "Two-Faces.ttc#1"]) assert(!mixed.fonts.some(font => font.id === id(file)), file);
  const first = await fonts.fetch({ languages: ["en"], family: "Coverage", limit: 2 });
  const next = await fonts.fetch({ languages: ["en"], family: "Coverage", offset: first.nextOffset!, limit: 2 });
  assert.equal(first.fonts.length, 2); assert.equal(next.offset, 2);
  assert(!first.fonts.some(font => next.fonts.some(item => item.id === font.id)));
  assert.equal((await fonts.fetch({ languages: ["en"], family: "Does not exist" })).total, 0);
});

test("actual copy catches names, capital sharp S, combining marks, punctuation and symbols beyond a language label", async () => {
  const narrow = id("Narrow-Bold.ttf"), wide = id("Wide-Regular.ttf");
  assert((await fonts.checkText(narrow, "Grüße", ["de"])).ok);
  assert.deepEqual((await fonts.checkText(narrow, "ẞ Đorđe €", ["de"])).missing, ["ẞ", "Đ", "đ", "€"]);
  assert(!(await fonts.checkText(narrow, "e\u0301", ["en"])).ok);
  const exact = "Đorđe — Grüße, Åsa, e\u0301, Ω and fi €";
  assert((await fonts.checkText(wide, exact, ["sr-Latn", "sv", "de"])).ok);
  assert.equal(exact.includes("e\u0301"), true); // The stored text is never normalized/replaced.
  assert(!(await fonts.checkText(wide, "A\u200dB", ["en"])).ok, "Do not let shaping hide characters recovery's cmap check would reject");
  const refined = await fonts.fetch({ languages: ["de"], text: "ẞ" });
  assert(!refined.fonts.some(font => font.id === narrow));
});

test("HarfBuzz catches a missing substituted glyph even when the cmap claims support", async () => {
  const check = await fonts.checkText(id("Broken-Shaping.ttf"), "X", ["en"]);
  assert.equal(check.ok, false); assert.deepEqual(check.missing, []); assert.match(check.shapingError!, /Missing shaped glyph/);
  assert(!(await fonts.fetch({ languages: ["en"], text: "X" })).fonts.some(font => font.id === id("Broken-Shaping.ttf")));
  assert((await fonts.checkText(id("Wide-Regular.ttf"), "office fi", ["en"])).ok);
});

test("unknown repertoires require exact text and report that language-wide coverage is unavailable", async () => {
  const unknown = await fonts.fetch({ languages: ["qaa"] });
  assert.equal(unknown.total, 0); assert.match(unknown.warning!, /Supply actual text/);
  const exact = await fonts.fetch({ languages: ["qaa"], text: "Test" });
  assert(exact.total > 0); assert.equal(exact.languageCoverage[0].status, "unavailable");
});

test("font bytes, rather than file path alone, invalidate coverage and shaping caches; unreadable faces fail closed", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-font-cache-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "changing.ttf"); await copyFile(path.join(root, "Wide-Regular.ttf"), file);
  const localCatalog = await loadFontCatalog(dir), service = new FontEligibility(localCatalog), fontId = localCatalog.entries[0].id;
  assert((await service.checkText(fontId, "đ", ["sr-Latn"])).ok);
  await copyFile(path.join(root, "Narrow-Bold.ttf"), file);
  assert.deepEqual((await service.checkText(fontId, "đ", ["sr-Latn"])).missing, ["đ"]);
  await writeFile(file, "not a font");
  assert(!(await service.checkText(fontId, "Test", ["en"])).ok);
  const result = await service.fetch({ languages: ["en"] }); assert.equal(result.total, 0); assert.equal(result.unreadableFaces, 1);
});

test("fetch_fonts exposes a valid Agents SDK schema and validates real tool calls", async () => {
  const tool = createFetchFontsTool(fonts);
  assert.equal(tool.name, "fetch_fonts");
  const response = await tool.invoke(new RunContext(), JSON.stringify({ languages: ["sr-Latn"], text: "đ", family: null, offset: null, limit: 2 }));
  const result = JSON.parse(response as string);
  assert.equal(result.fonts.length, 2); assert(result.fonts.every((font: { weight: number }) => font.weight === 400));
  const invalid = await tool.invoke(new RunContext(), JSON.stringify({ languages: [], text: null, family: null, offset: null, limit: null }));
  assert.match(String(invalid), /error/i);
});
