import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { applyCommands } from "../src/shared/commands.js";
import { canLocateFocus, currentFocusRegions, focusInputKey, parseFocusCues, validateFocusRegions } from "../src/shared/focusRegions.js";
import { deckSchema } from "../src/shared/schema.js";
import { mergeServerDeck } from "../src/shared/merge.js";
import type { Deck, FocusRegion, Slide } from "../src/shared/types.js";
import { DeckStore } from "./deckStore.js";
import { DeckMutations } from "./deckMutations.js";
import type { FontRegistry } from "./fonts.js";
import { focusContext } from "./focusRegions.js";
import { FocusInputError, FocusRegionManager, validateFocusSnapshot } from "./focusRegionManager.js";

function fixture(): Deck {
  const role = { fontId: "sans", family: "Sans", weight: 400, style: "normal" as const, letterSpacing: 0 };
  return {
    schemaVersion: 4, id: "test-deck", title: "Test", brief: { prompt: "Test", attachments: [] },
    designSystem: {
      name: "Test", creativeDirection: "Test", rationale: "Test", imageTreatment: "Test", principles: ["Test"],
      typography: { relationship: "single-family", rationale: "Test", display: role, heading: role, body: role, label: role },
      colors: { background: "#ffffff", surface: "#eeeeee", text: "#111111", mutedText: "#777777", accent: "#0000ff", accentText: "#ffffff", border: "#888888" },
    },
    fonts: [{ id: "sans", family: "Sans", subfamily: "Regular", weight: 400, style: "normal", url: "/sans.ttf", source: "catalog" }],
    assets: [{ id: "asset", slideId: "slide", kind: "slide-image", url: "/api/assets/test-deck/slide.png", prompt: "Test", copy: [], alt: "Test", width: 200, height: 100 }],
    slides: [{
      id: "slide", title: "Test slide", purpose: "Test", copy: [], assetId: "asset", canvas: { width: 200, height: 100 }, state: "recovered",
      recovery: { status: "recovered", updatedAt: "2026-09-07T00:00:00.000Z" }, version: 1, history: [],
      talkingPoints: "Intro. **[First section]** Explain why the first section matters.\n\n**[Second section]** Explain the second section fully.",
      layers: { plateAssetId: "plate", objects: [{ id: "text", kind: "text", frame: { x: 10, y: 10, width: 70, height: 15 }, text: "First section", style: { fontRole: "body", fontSize: 12, lineHeight: 1.2, align: "left", color: "#111111" }, origin: { kind: "recovered" } }] },
    }],
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z", revision: 0,
  };
}
function boxes(slide: Slide): FocusRegion[] {
  return parseFocusCues(slide.talkingPoints).map((cue, i) => ({ cueId: cue.id, box: [i * 100, 10, i * 100 + 90, 80] }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Background highlights did not settle.");
}
async function harness(t: test.TestContext, locate: (slide: Slide, image: string) => Promise<FocusRegion[]>, deck = fixture()) {
  const root = await mkdtemp(path.join(tmpdir(), "monoprint-focus-"));
  const store = new DeckStore(root);
  const fonts = { ensureDeckFonts: (deck: Deck) => deck } as FontRegistry;
  const mutations = new DeckMutations(store, fonts);
  await store.save(deck);
  const manager = new FocusRegionManager(store, mutations, { locate, readImage: async () => "original-image", concurrency: 1 });
  t.after(async () => { manager.dispose(); await rm(root, { recursive: true, force: true }); });
  return { manager, mutations, load: () => store.load(deck.id), deck };
}

test("Markdown cues exclude code, links, escaped markers and ordinary emphasis, and retain complete context", () => {
  const transcript = "  Intro\n\n**[Region]** Full paragraph.\n\nStill speaking.\n\n`**[Code]**`\n\n```\n**[Fence]**\n```\n\n[**[Link]**](https://example.com)\n\n\\*\\*[Escaped]\\*\\* **Other bold**\n\n__[Region]__ Another explanation.";
  const cues = parseFocusCues(transcript);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].label, "Region");
  assert.notEqual(cues[0].id, cues[1].id);
  assert.match(cues[0].spokenContext, /Still speaking/);
  assert.equal(cues[1].spokenContext, "Another explanation.");
  assert.equal(transcript.slice(cues[0].start, cues[0].end), "**[Region]**");
  assert.equal(parseFocusCues(`More introduction\n${transcript}`)[0].id, cues[0].id);
});

test("model context includes all cues, full transcript and recovered spatial anchors", () => {
  const slide = fixture().slides[0];
  const context = focusContext(slide);
  assert.equal(context.talking_points, slide.talkingPoints);
  assert.equal(context.cues.length, 2);
  assert.match(context.cues[0].spoken_context, /why the first section matters/);
  assert.deepEqual(context.recovered_text[0], { id: "text", text: "First section", box_xyxy: [10, 10, 80, 25] });
});

test("rectangles require complete unique cue coverage and finite in-bounds positive geometry", () => {
  const slide = fixture().slides[0];
  const cues = parseFocusCues(slide.talkingPoints);
  assert.deepEqual(validateFocusRegions(boxes(slide), cues, slide.canvas), boxes(slide));
  for (const invalid of [
    boxes(slide).slice(0, 1), [boxes(slide)[0], boxes(slide)[0]],
    ...[[0, 0, 201, 90], [0, -1, 20, 90], [20, 0, 20, 90], [20, 0, 10, 90], [0, 0, NaN, 90]].map((box) => [{ ...boxes(slide)[0], box: box as FocusRegion["box"] }, boxes(slide)[1]]),
  ]) assert.throws(() => validateFocusRegions(invalid, cues, slide.canvas));
});

test("input identity ignores result/status, unrelated slides and unrelated fonts; edits invalidate it", () => {
  const deck = fixture();
  const key = focusInputKey(deck, deck.slides[0]);
  const modified = structuredClone(deck);
  modified.revision++;
  modified.slides[0].focusRegions = { inputKey: key, status: "ready", regions: boxes(modified.slides[0]), updatedAt: "now" };
  modified.fonts.push({ ...modified.fonts[0], id: "unrelated" });
  assert.equal(focusInputKey(modified, modified.slides[0]), key);
  const moves = applyCommands(deck, [{ type: "move_object", slideId: "slide", objectId: "text", x: 20, y: 10 }]);
  assert.notEqual(focusInputKey(moves, moves.slides[0]), key);
  for (const edit of [
    applyCommands(deck, [{ type: "set_slide_meta", slideId: "slide", talkingPoints: "**[First section]** New meaning." }]),
    applyCommands(deck, [{ type: "set_colors", colors: { background: "#eeeeee" } }]),
    applyCommands(deck, [{ type: "set_font_role", role: "body", font: { fontId: "serif", family: "Serif" } }]),
  ]) assert.notEqual(focusInputKey(edit, edit.slides[0]), key);
  assert.equal(applyCommands(deck, [{ type: "set_colors", colors: { background: "#eeeeee" } }]).slides[0].state, "edited");
});

test("stored metadata round-trips; old decks load; merging never exposes a stale box over local edits", () => {
  const server = fixture();
  assert.equal(deckSchema.parse(server).slides[0].focusRegions, undefined);
  const slide = server.slides[0];
  slide.focusRegions = { inputKey: focusInputKey(server, slide), status: "ready", regions: boxes(slide), updatedAt: server.updatedAt };
  assert.deepEqual(deckSchema.parse(server).slides[0].focusRegions, slide.focusRegions);
  assert.equal(currentFocusRegions(server, slide).length, 2);
  const local = applyCommands(server, [{ type: "set_text", slideId: "slide", objectId: "text", text: "Changed locally" }]);
  const merged = mergeServerDeck(local, server);
  assert.equal(merged.slides[0].layers!.objects[0].text, "Changed locally");
  assert.deepEqual(currentFocusRegions(merged, merged.slides[0]), []);
  const repaint = { ...slide, assetId: "new-raster" };
  assert.deepEqual(currentFocusRegions(server, repaint), []);
});

test("one call handles all cues, deduplicates repeated requests and reuses saved results", async (t) => {
  let calls = 0;
  const result = deferred<FocusRegion[]>();
  const h = await harness(t, async () => { calls++; return result.promise; });
  await Promise.all([h.manager.ensureDeck(h.deck.id), h.manager.ensureDeck(h.deck.id)]);
  await waitFor(async () => calls === 1);
  const key = focusInputKey(h.deck, h.deck.slides[0]);
  await h.manager.request(h.deck.id, "slide", key, undefined, true);
  result.resolve(boxes(h.deck.slides[0]));
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "ready");
  await h.manager.ensureDeck(h.deck.id);
  assert.equal(calls, 1);
  assert.equal((await h.load()).slides[0].focusRegions?.regions.length, 2);
});

test("an in-flight result cannot overwrite a newer transcript", async (t) => {
  const first = deferred<FocusRegion[]>();
  let calls = 0;
  const h = await harness(t, async (slide) => ++calls === 1 ? first.promise : boxes(slide));
  await h.manager.ensureDeck(h.deck.id);
  await waitFor(async () => calls === 1);
  await h.mutations.mutate(h.deck.id, (deck) => applyCommands(deck, [{ type: "set_slide_meta", slideId: "slide", talkingPoints: "**[New section]** Entirely revised context." }]));
  await h.manager.ensureDeck(h.deck.id);
  first.resolve(boxes(h.deck.slides[0]));
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "ready");
  const deck = await h.load();
  assert.equal(calls, 2);
  assert.equal(deck.slides[0].focusRegions?.inputKey, focusInputKey(deck, deck.slides[0]));
  assert.equal(deck.slides[0].focusRegions?.regions[0].cueId, parseFocusCues(deck.slides[0].talkingPoints)[0].id);
});

test("failure does not block the deck or automatically repeat calls; explicit retry succeeds", async (t) => {
  let calls = 0;
  const h = await harness(t, async (slide) => { if (++calls === 1) throw new Error("Model unavailable"); return boxes(slide); });
  await h.manager.ensureDeck(h.deck.id);
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "failed");
  await h.manager.ensureDeck(h.deck.id);
  assert.equal(calls, 1);
  await h.manager.request(h.deck.id, "slide", focusInputKey(h.deck, h.deck.slides[0]), undefined, true);
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "ready");
  assert.equal(calls, 2);
});

test("recovery gates generation, and edited slides wait for a matching fresh snapshot", async (t) => {
  const deck = fixture();
  deck.slides[0].recovery.status = "running";
  const images: string[] = [];
  const h = await harness(t, async (slide, image) => { images.push(image); return boxes(slide); }, deck);
  assert.equal(canLocateFocus(deck.slides[0]), false);
  await h.manager.ensureDeck(deck.id);
  assert.equal((await h.load()).slides[0].focusRegions, undefined);
  await h.mutations.mutate(deck.id, (current) => ({ ...current, slides: current.slides.map((slide) => ({ ...slide, state: "edited", recovery: { ...slide.recovery, status: "recovered" } })) }));
  const waiting = await h.manager.ensureDeck(deck.id);
  assert.equal(waiting.slides[0].focusRegions?.status, "waiting_snapshot");
  assert.equal(images.length, 0);
  const png = `data:image/png;base64,${(await sharp({ create: { width: 200, height: 100, channels: 3, background: "white" } }).png().toBuffer()).toString("base64")}`;
  await assert.rejects(h.manager.request(deck.id, "slide", "stale-key", png), FocusInputError);
  const key = focusInputKey(waiting, waiting.slides[0]);
  await h.manager.request(deck.id, "slide", key, png);
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "ready");
  assert.equal(images.length, 1);
  assert.match(images[0], /^data:image\/png;base64,/);
  await assert.rejects(validateFocusSnapshot(png, { width: 201, height: 100 }), /dimensions/);
  await assert.rejects(validateFocusSnapshot("https://example.com/a.png", { width: 200, height: 100 }), /PNG/);
});

test("opening resumes orphaned jobs and skips decks without cues", async (t) => {
  const deck = fixture();
  const slide = deck.slides[0];
  slide.focusRegions = { inputKey: focusInputKey(deck, slide), status: "running", regions: [], updatedAt: deck.updatedAt };
  let calls = 0;
  const h = await harness(t, async (slide) => { calls++; return boxes(slide); }, deck);
  await h.manager.ensureDeck(deck.id);
  await waitFor(async () => (await h.load()).slides[0].focusRegions?.status === "ready");
  assert.equal(calls, 1);
  await h.mutations.mutate(deck.id, (current) => applyCommands(current, [{ type: "set_slide_meta", slideId: "slide", talkingPoints: "No cues here." }]));
  await h.manager.ensureDeck(deck.id);
  assert.equal(calls, 1);
  const updated = await h.load();
  assert.deepEqual(currentFocusRegions(updated, updated.slides[0]), []);
});
