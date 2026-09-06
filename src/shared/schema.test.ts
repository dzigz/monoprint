import assert from "node:assert/strict";
import test from "node:test";
import { applyCommands, editCommandSchema, EditCommandError } from "./commands.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeckStore } from "../../server/deckStore.js";
import { mergeServerDeck } from "./merge.js";
import {
  migrateDeck,
  deckSchema,
  normalizePublishedDeckDraft,
  publishDeckSchema,
  publishDeckToolSchema,
  validateDeck,
  type PublishedDeckInput,
} from "./schema.js";
import { appendRoleLabeledCopyBlock } from "./slideCopy.js";
import type { Deck, DeckAsset, FontCatalogEntry } from "./types.js";

const font: FontCatalogEntry = {
  id: "font-1",
  family: "Test Sans",
  subfamily: "Regular",
  sourceLabel: "TestSans-Regular.ttf",
  axes: [],
};

function openingCopy() {
  return [
    { role: "Headline", text: "Opening", fontRole: "display" as const },
    { role: "Subhead", text: "Frame the idea", fontRole: "body" as const },
  ];
}

function answerCopy() {
  return [
    { role: "Headline", text: "Answer", fontRole: "heading" as const },
    { role: "Closing thesis", text: "Resolve the idea", fontRole: "body" as const },
  ];
}

function designSystem() {
  const fontRole = {
    fontId: font.id,
    family: font.family,
    weight: 400,
    style: "normal" as const,
    letterSpacing: 0,
  };
  return {
    name: "Test direction",
    creativeDirection: "A disciplined editorial image system",
    rationale: "Keeps the deck coherent",
    typography: {
      relationship: "single-family" as const,
      rationale: "One family creates continuity",
      display: fontRole,
      heading: fontRole,
      body: fontRole,
      label: fontRole,
    },
    colors: {
      background: "#FFFFFF",
      surface: "#F0F0F0",
      text: "#111111",
      mutedText: "#666666",
      accent: "#FF5500",
      accentText: "#FFFFFF",
      border: "#CCCCCC",
    },
    imageTreatment: "Crisp editorial collage",
    principles: ["One idea per slide"],
  };
}

function input(): PublishedDeckInput {
  return {
    title: "Test deck",
    designSystem: designSystem(),
    slides: [
      { id: "slide-1", title: "Opening", purpose: "Frame the idea", copy: openingCopy(), assetId: "asset-1", talkingPoints: "## Opening\n\nLet's start with the idea we will develop together. **[Point to the headline]** This is the question our talk will answer." },
      { id: "slide-2", title: "Answer", purpose: "Resolve the idea", copy: answerCopy(), assetId: "asset-2", talkingPoints: "We can now answer the question we started with. **[Point to the closing statement]** This conclusion follows from the explanation we just worked through." },
    ],
    sources: [],
  };
}

function assets() {
  const firstCopy = openingCopy();
  const secondCopy = answerCopy();
  const entries: DeckAsset[] = [
    {
      id: "asset-1",
      kind: "slide-image",
      slideNumber: 1,
      slideId: "slide-1",
      url: "/one.png",
      prompt: appendRoleLabeledCopyBlock("Opening composition", firstCopy),
      copy: firstCopy,
      alt: "Opening slide",
    },
    {
      id: "asset-2",
      kind: "slide-image",
      slideNumber: 2,
      slideId: "slide-2",
      url: "/two.png",
      prompt: appendRoleLabeledCopyBlock("Closing composition", secondCopy),
      copy: secondCopy,
      alt: "Answer slide",
    },
  ];
  return new Map(entries.map((asset) => [asset.id, asset]));
}

test("accepts a one-to-one mapping of generated images to slides", () => {
  const referenced = validateDeck(input(), [font], assets(), 2);
  assert.deepEqual(referenced.map((asset) => asset.id), ["asset-1", "asset-2"]);
});

test("rejects a slide without a generated image", () => {
  const deck = input();
  deck.slides[1].assetId = "invented";
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /does not reference a generated slide image/);
});

test("rejects reuse of one generated image across slides", () => {
  const deck = input();
  deck.slides[1].assetId = deck.slides[0].assetId;
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /duplicate identifiers/);
});

test("rejects a generated image assigned to a different slide", () => {
  const deck = input();
  const generated = assets();
  generated.get("asset-2")!.slideId = "another-slide";
  assert.throws(() => validateDeck(deck, [font], generated, 2), /must reference its own full-slide generated image/);
});

test("rejects a generated image published at a different slide number", () => {
  const deck = input();
  const generated = assets();
  generated.get("asset-2")!.slideNumber = 1;
  assert.throws(() => validateDeck(deck, [font], generated, 2), /image generated for slide number 2/);
});

test("requires role-labelled copy with a font role on every published slide", () => {
  const deck = input() as unknown as Record<string, unknown>;
  const slides = deck.slides as Array<Record<string, unknown>>;
  delete slides[1].copy;
  assert.equal(publishDeckSchema.safeParse(deck).success, false);
  const missingFontRole = input() as unknown as { slides: Array<{ copy: Array<Record<string, unknown>> }> };
  delete missingFontRole.slides[0].copy[0].fontRole;
  assert.equal(publishDeckSchema.safeParse(missingFontRole).success, false);
});

test("requires a non-blank talking transcript on every published slide, including tool input", () => {
  for (const schema of [publishDeckSchema, publishDeckToolSchema]) {
    assert.equal(schema.safeParse(input()).success, true);
    for (const invalid of [undefined, null, "", " \n\t ", ["A bullet summary"]]) {
      const deck = input();
      const slide = deck.slides[1] as unknown as Record<string, unknown>;
      if (invalid === undefined) delete slide.talkingPoints;
      else slide.talkingPoints = invalid;
      assert.equal(schema.safeParse(deck).success, false);
    }
  }
});

test("preserves the full Markdown transcript and separate notes through publication normalization", () => {
  const draft = input();
  draft.slides[0].speakerNotes = "Supplementary delivery context.";
  const published = normalizePublishedDeckDraft(publishDeckToolSchema.parse(draft));
  assert.equal(published.slides[0].talkingPoints, draft.slides[0].talkingPoints);
  assert.equal(published.slides[0].speakerNotes, draft.slides[0].speakerNotes);
});

test("rejects an empty copy role", () => {
  const deck = input();
  deck.slides[1].copy[0].role = "";
  assert.equal(publishDeckSchema.safeParse(deck).success, false);
});

test("normalizes harmless null optional metadata before publication", () => {
  const deck = input() as unknown as {
    slides: Array<Record<string, unknown>>;
    sources: unknown;
  };
  deck.slides[0].sourceIds = null;
  deck.slides[0].transitionFromPrevious = null;
  deck.slides[0].speakerNotes = null;
  deck.sources = null;
  const parsed = normalizePublishedDeckDraft(publishDeckToolSchema.parse(deck));
  assert.equal(parsed.slides[0].transitionFromPrevious, undefined);
  assert.equal(parsed.sources, undefined);
});

test("accepts the art director's numeric tracking scale without blocking publication", () => {
  const deck = input();
  deck.designSystem.typography.display.letterSpacing = -1.2;
  assert.equal(publishDeckSchema.safeParse(deck).success, true);
});

test("requires an explicit source discriminator", () => {
  const deck = input() as unknown as { sources: Array<Record<string, unknown>> };
  deck.sources = [{ id: "source-1", title: "Primary source", url: "https://example.com/report" }];
  assert.equal(publishDeckSchema.safeParse(deck).success, false);
});

test("rejects copy that differs from the role-labelled copy used for image generation", () => {
  const deck = input();
  deck.slides[1].copy[1].text = "A different conclusion";
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /copy must exactly match/);
});

test("rejects an image prompt without the canonical role-labelled copy block", () => {
  const generated = assets();
  generated.get("asset-2")!.prompt = "Closing composition with bare quoted strings";
  assert.throws(() => validateDeck(input(), [font], generated, 2), /does not contain its canonical role-labelled copy block/);
});

test("enforces the requested slide-image count", () => {
  assert.throws(() => validateDeck(input(), [font], assets(), 3), /requires exactly 3 slide images/);
});

test("rejects a font family that does not match the catalog", () => {
  const deck = input();
  deck.designSystem.typography.display.family = "Invented Font";
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /does not match font/);
});

test("accepts cited web research attached to a slide", () => {
  const deck = input();
  deck.sources = [{ id: "source-1", title: "Primary source", kind: "web", url: "https://example.com/report" }];
  deck.slides[1].sourceIds = ["source-1"];
  assert.doesNotThrow(() => validateDeck(deck, [font], assets(), 2));
});

test("rejects a slide that cites an unknown source", () => {
  const deck = input();
  deck.slides[0].sourceIds = ["missing-source"];
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /references unknown source/);
});

test("accepts repository source ranges for a repository-grounded deck", () => {
  const deck = input();
  deck.sources = [{
    id: "repo-source-1",
    title: "Request handling",
    kind: "repository",
    path: "src/server.ts",
    startLine: 20,
    endLine: 48,
  }];
  deck.slides[1].sourceIds = ["repo-source-1"];
  assert.doesNotThrow(() => validateDeck(deck, [font], assets(), 2, { repositoryPath: "/tmp/example-repository" }));
});

test("requires repository grounding when a repository is supplied", () => {
  assert.throws(
    () => validateDeck(input(), [font], assets(), 2, { repositoryPath: "/tmp/example-repository" }),
    /must include repository source references/,
  );
});

test("rejects repository sources for an ordinary deck", () => {
  const deck = input();
  deck.sources = [{
    id: "repo-source-1",
    title: "Escaped source",
    kind: "repository",
    path: "src/server.ts",
    startLine: 1,
    endLine: 2,
  }];
  assert.throws(() => validateDeck(deck, [font], assets(), 2), /require a repository/);
});

test("rejects file sources that reference unknown attachments", () => {
  const deck = input();
  deck.sources = [{ id: "file-1", title: "Report.pdf", kind: "file", attachmentId: "missing" }];
  assert.throws(() => validateDeck(deck, [font], assets(), 2, { attachmentIds: new Set(["known"]) }), /unknown attachment/);
});

test("migrates a schema 3 deck into layered slides that start as generated", () => {
  const legacy = {
    schemaVersion: 3,
    id: "deck-1",
    title: "Legacy deck",
    brief: { objective: "Explain the idea", audience: "Engineers", requestedSlideCount: 2, repositoryPath: "/tmp/repo" },
    designSystem: designSystem(),
    slides: [
      { id: "slide-1", title: "Opening", purpose: "Frame the idea", copy: [{ role: "Headline", text: "Opening" }], assetId: "asset-1" },
      { id: "slide-2", title: "Answer", purpose: "Resolve the idea", copy: [{ role: "Headline", text: "Answer" }], assetId: "asset-2" },
    ],
    assets: [...assets().values()],
  };
  const deck = migrateDeck(legacy, { assetDimensions: { "asset-1": { width: 1536, height: 1024 } } });
  assert.equal(deck.schemaVersion, 4);
  assert.equal(deck.slides[0].state, "generated");
  assert.equal(deck.slides[0].recovery.status, "pending");
  assert.deepEqual(deck.slides[0].canvas, { width: 1536, height: 1024 });
  assert.deepEqual(deck.slides[1].canvas, { width: 1536, height: 864 });
  assert.equal(deck.slides[0].history[0].reason, "generated");
  assert.equal(deck.brief.attachments[0]?.kind, "folder");
  assert.equal(deck.brief.inferred?.audience, "Engineers");
  assert.match(deck.brief.prompt, /Explain the idea/);
});

function editableDeck(): Deck {
  const legacy = {
    schemaVersion: 3,
    id: "deck-1",
    title: "Editable deck",
    brief: { objective: "Explain the idea", audience: "Engineers" },
    designSystem: designSystem(),
    slides: [
      { id: "slide-1", title: "Opening", purpose: "Frame the idea", copy: openingCopy(), assetId: "asset-1" },
      { id: "slide-2", title: "Answer", purpose: "Resolve the idea", copy: answerCopy(), assetId: "asset-2" },
    ],
    assets: [...assets().values()],
  };
  const deck = migrateDeck(legacy);
  deck.slides[0].layers = {
    plateAssetId: "asset-1",
    objects: [{
      id: "text-1",
      kind: "text",
      frame: { x: 100, y: 100, width: 600, height: 80 },
      text: "Opening",
      style: { fontRole: "display", fontSize: 64, lineHeight: 1.1, align: "left", color: "#111111" },
      origin: { kind: "recovered" },
    }],
  };
  deck.slides[0].state = "recovered";
  return deck;
}

test("applies edit commands and marks the slide as edited", () => {
  const deck = editableDeck();
  const next = applyCommands(deck, [
    { type: "set_text", slideId: "slide-1", objectId: "text-1", text: "A better opening" },
    { type: "move_object", slideId: "slide-1", objectId: "text-1", x: 120, y: 140 },
    { type: "set_text_style", slideId: "slide-1", objectId: "text-1", style: { align: "center", bold: true } },
    { type: "set_colors", colors: { accent: "#00AA00" } },
  ]);
  const object = next.slides[0].layers?.objects[0];
  assert.equal(object?.kind, "text");
  assert.equal(object?.text, "A better opening");
  assert.deepEqual([object?.frame.x, object?.frame.y], [120, 140]);
  assert.equal(object?.style.align, "center");
  assert.equal(object?.style.bold, true);
  assert.equal(next.slides[0].state, "edited");
  assert.equal(next.designSystem.colors.accent, "#00AA00");
  assert.equal(deck.slides[0].layers?.objects[0].text, "Opening", "the original deck is not mutated");
});

test("rejects edits to slides that have not been recovered", () => {
  const deck = editableDeck();
  assert.throws(
    () => applyCommands(deck, [{ type: "set_text", slideId: "slide-2", objectId: "text-1", text: "x" }]),
    EditCommandError,
  );
});

test("talking-point commands work across recovery states and leave artwork and notes intact", () => {
  const original = editableDeck();
  original.slides[0].speakerNotes = "Supplementary context to retain.";
  const commands = original.slides.map((slide, index) => editCommandSchema.parse({
    type: "set_slide_meta",
    slideId: slide.id,
    talkingPoints: input().slides[index].talkingPoints,
  }));
  const edited = applyCommands(original, commands);
  for (const [index, slide] of edited.slides.entries()) {
    assert.equal(slide.talkingPoints, input().slides[index].talkingPoints);
    const { talkingPoints: _transcript, ...unchanged } = slide;
    assert.deepEqual(unchanged, original.slides[index]);
    assert.equal(original.slides[index].talkingPoints, undefined, "undo snapshot stays unchanged");
  }
  const renamed = applyCommands(edited, [{ type: "set_slide_meta", slideId: "slide-1", title: "Renamed" }]);
  assert.equal(renamed.slides[0].talkingPoints, edited.slides[0].talkingPoints);
  const cleared = applyCommands(edited, [editCommandSchema.parse({ type: "set_slide_meta", slideId: "slide-1", talkingPoints: "" })]);
  assert.equal(cleared.slides[0].talkingPoints, "");
  assert.equal(cleared.slides[1].talkingPoints, edited.slides[1].talkingPoints);
});

test("stored decks accept missing transcripts and preserve transcripts through saves and undo/redo snapshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "monoprint-talking-points-"));
  try {
    const store = new DeckStore(root);
    const original = editableDeck();
    await store.save(original);
    const loaded = await store.load(original.id);
    assert.equal(loaded.slides[0].talkingPoints, undefined);
    const edited = applyCommands(loaded, [{ type: "set_slide_meta", slideId: "slide-1", talkingPoints: input().slides[0].talkingPoints }]);
    await store.save(edited);
    assert.equal((await store.load(edited.id)).slides[0].talkingPoints, edited.slides[0].talkingPoints);

    const recoveryUpdate = structuredClone(edited);
    recoveryUpdate.slides[0].recovery.updatedAt = "2099-01-01T00:00:00.000Z";
    recoveryUpdate.slides[0].version += 1;
    // Full-deck undo/redo uses the same schema and server merge as the PUT endpoint.
    const undone = mergeServerDeck(deckSchema.parse(original), recoveryUpdate);
    await store.save(undone);
    assert.equal((await store.load(original.id)).slides[0].talkingPoints, undefined);
    assert.equal(undone.slides[0].version, recoveryUpdate.slides[0].version);
    const redone = mergeServerDeck(deckSchema.parse(edited), undone);
    await store.save(redone);
    assert.equal((await store.load(original.id)).slides[0].talkingPoints, edited.slides[0].talkingPoints);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
