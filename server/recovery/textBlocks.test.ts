import assert from "node:assert/strict";
import test from "node:test";
import type { DeckColors, DeckFont } from "../../src/shared/types.js";
import { buildTextObjects, type PoolFont, type RecoveredWord } from "./textBlocks.js";

const colors: DeckColors = {
  background: "#FFFFFF",
  surface: "#F0F0F0",
  text: "#111111",
  mutedText: "#666666",
  accent: "#FF5500",
  accentText: "#FFFFFF",
  border: "#CCCCCC",
};

const font: DeckFont = {
  id: "catalog:test",
  family: "Test Sans",
  subfamily: "Regular",
  weight: 400,
  style: "normal",
  url: "/api/fonts/catalog/test",
  source: "catalog",
  metrics: { unitsPerEm: 1000, ascent: 800, descent: -200, lineGap: 0, spaceAdvance: 250, descenderDepth: 200 },
};

const poolFont: PoolFont = { font, fontRole: "body", spaceRatio: 0.3, measure: (text) => text.length * 500 };

function word(id: number, text: string, x0: number, x1: number, y0 = 100, y1 = 124): RecoveredWord {
  return { id, text, box: [x0, y0, x1, y1], pool: "p", em: 24, color: [17, 17, 17] };
}

test("one pipeline block becomes one text object with its lines joined by newlines", () => {
  const objects = buildTextObjects({
    blocks: [{
      id: 1,
      role: "paragraph",
      words: [word(0, "First", 100, 150, 100, 124), word(1, "line", 158, 200, 100, 124), word(2, "Second", 100, 170, 130, 154)],
    }],
    poolFonts: new Map([["p", poolFont]]),
    canvas: { width: 1536, height: 864 },
    colors,
    copy: [{ role: "Body", text: "First line Second", fontRole: "body" }],
  });
  assert.equal(objects.length, 1);
  assert.equal(objects[0].text, "First line\nSecond");
  assert.equal(objects[0].copyRole, "Body");
  assert.equal(objects[0].style.fontRole, "body");
  assert.ok(objects[0].frame.width >= 100, "the frame holds the widest line as the font will set it");
});

test("words on one line are joined by single spaces whatever the gap", () => {
  const objects = buildTextObjects({
    blocks: [{ id: 2, role: "label", words: [word(0, "Input", 100, 160), word(1, "Output", 260, 330)] }],
    poolFonts: new Map([["p", poolFont]]),
    canvas: { width: 1536, height: 864 },
    colors,
    copy: [],
  });
  assert.equal(objects.length, 1);
  assert.equal(objects[0].text, "Input Output");
});
