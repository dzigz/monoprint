import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fontkit from "fontkit";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import type { Deck } from "../src/shared/types.js";
import { standaloneFont } from "./fontContainer.js";
import { embeddingFromBytes } from "./fontEmbedding.js";
import { PdfExporter, pdfBrowserPath, usedPdfFonts } from "./pdfExport.js";

const fontPath = path.resolve("server/testFixtures/fonts/Two-Faces.ttc");
function fixture(): Deck {
  const style = { fontId: "exact", fontRole: "body", fontSize: 20.5, lineHeight: 1.2, align: "left", color: "#123456" };
  return {
    id: "deck", revision: 3, title: "PDF fixture", fonts: [{ id: "exact", family: "Coverage Test", subfamily: "Regular", weight: 400, style: "normal", source: "fitted", url: "unused" }],
    designSystem: { colors: { background: "#ffffff" } },
    assets: [{ id: "plate", url: "/api/assets/deck/plate.png" }],
    slides: [
      { id: "recovered", canvas: { width: 640, height: 360 }, assetId: "plate", recovery: { status: "recovered" }, layers: { plateAssetId: "plate", objects: [
        { id: "svg", kind: "text", frame: { x: 20, y: 20, width: 580, height: 50 }, style,
          resolved: { words: [{ id: "1", text: "čćđšž", fontId: "exact", baseline: [2.25, 30.5], em: 24.75, angle: -5, scaleX: 0.93, color: "#123456" }] } },
        { id: "edited", kind: "text", frame: { x: 20, y: 100, width: 160, height: 100 }, style, text: "Edited words wrap\nÅÄÖ üß" },
      ] } },
      { id: "unrecovered", canvas: { width: 400, height: 300 }, assetId: "plate", recovery: { status: "failed" } },
    ],
  } as unknown as Deck;
}

test("collection extraction preserves exact faces, layout tables and embedding metadata", async () => {
  const source = await readFile(fontPath);
  for (const i of [0, 1]) {
    const face = standaloneFont(source, i);
    const original = (fontkit.create(source) as fontkit.FontCollection).fonts[i];
    const extracted = fontkit.create(face) as fontkit.Font;
    assert.equal(extracted.postscriptName, original.postscriptName);
    assert.deepEqual(extracted.layout("office").glyphs.map(g => g.id), original.layout("office").glyphs.map(g => g.id));
    assert.deepEqual(embeddingFromBytes(face), embeddingFromBytes(source, i));
    let checksum = 0;
    for (let n = 0; n < face.length; n += 4) checksum = (checksum + face.readUInt32BE(n)) >>> 0;
    assert.equal(checksum, 0xb1b0afba);
  }
  assert.throws(() => standaloneFont(source, 2), /face index/);
});

test("PDF requires every resolved and ordinary text font", () => {
  const deck = fixture();
  assert.deepEqual(usedPdfFonts(deck).map(f => f.id), ["exact"]);
  deck.fonts = [];
  assert.throws(() => usedPdfFonts(deck), /missing its exact font/);
});

test("PDF refuses stale snapshots and active recovery before rendering", async () => {
  const deck = fixture();
  const exporter = new PdfExporter({ load: async () => deck, directory: () => "/unused" }, { fontFile: async () => undefined });
  await assert.rejects(() => exporter.run("deck", 2), /deck changed/);
  deck.slides[0].recovery.status = "running";
  await assert.rejects(() => exporter.run("deck", 3), /recovery to finish/);
});

test("native PDF embeds exact fonts and original-size JPEGs, preserves text and mixed page sizes", async t => {
  let executablePath: string;
  try { executablePath = await pdfBrowserPath(); } catch {
    if (process.env.REQUIRE_PDF_BROWSER === "1") throw new Error("The PDF browser integration test is required.");
    t.skip("Chrome/Chromium is not installed"); return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "monoprint-pdf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await sharp({ create: { width: 640, height: 360, channels: 3, background: "#eadfcc" } }).png().toFile(path.join(directory, "plate.png"));
  const deck = fixture(), before = JSON.stringify(deck);
  const exporter = new PdfExporter({ load: async () => deck, directory: () => directory },
    { fontFile: async () => ({ path: fontPath, face_index: 0 }) }, { executablePath });
  const bytes = await exporter.run("deck", 3);
  assert.equal(JSON.stringify(deck), before);
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 2);
  for (const [i, page] of pdf.getPages().entries()) {
    assert.ok(Math.abs(page.getWidth() - deck.slides[i].canvas.width * 0.75) < 0.3);
    assert.ok(Math.abs(page.getHeight() - deck.slides[i].canvas.height * 0.75) < 0.3);
  }
  const streams = pdf.context.enumerateIndirectObjects().map(([, value]) => value).filter(value => value instanceof PDFRawStream);
  const images = streams.filter(s => s.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
  assert.ok(images.length >= 1);
  for (const image of images) {
    assert.equal(image.dict.get(PDFName.of("Filter"))?.toString(), "/DCTDecode");
    assert.equal(image.dict.get(PDFName.of("Width"))?.toString(), "640");
    assert.equal(image.dict.get(PDFName.of("Height"))?.toString(), "360");
  }
  assert.ok(pdf.context.enumerateIndirectObjects().some(([, value]) => value.toString().includes("/FontFile2")));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const document = await loading.promise;
  try {
    const text = (await (await document.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" ");
    for (const word of ["čćđšž", "Edited", "words", "wrap", "ÅÄÖ", "üß"]) assert.ok(text.includes(word), text);
    assert.equal((await (await document.getPage(2)).getTextContent()).items.length, 0);
  } finally { await loading.destroy(); }
  if (process.env.PDF_TEST_OUTPUT) await writeFile(process.env.PDF_TEST_OUTPUT, bytes);
});
