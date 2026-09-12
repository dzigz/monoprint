import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { editableEmbedding, embeddingFromBytes } from "./fontEmbedding.js";
import { FontEligibility } from "./fontEligibility.js";
import { loadFontCatalog } from "./fontCatalog.js";
import { assertEditableFontEmbedding } from "./pptxExport.js";
import type { Deck } from "../src/shared/types.js";

const fixture = path.resolve("server/testFixtures/fonts/Wide-Regular.ttf");
function withPermissions(source: Buffer, flags: number, face = 0) {
  const bytes = Buffer.from(source);
  const directory = bytes.toString("ascii", 0, 4) === "ttcf" ? bytes.readUInt32BE(12 + face * 4) : 0;
  for (let i = 0; i < bytes.readUInt16BE(directory + 4); i++) {
    const record = directory + 12 + i * 16;
    if (bytes.toString("ascii", record, record + 4) === "OS/2") {
      bytes.writeUInt16BE(flags, bytes.readUInt32BE(record + 8) + 8); return bytes;
    }
  }
  throw new Error("Fixture has no OS/2 table");
}

test("editable outline embedding honors source flags, supports full-font restrictions, and fails closed without metadata", async () => {
  const bytes = await readFile(fixture);
  for (const [flags, allowed] of [[0,true],[2,false],[4,false],[8,true],[12,true],[256,true],[260,false],[264,true],[512,false],[520,false]] as const) {
    assert.equal(editableEmbedding(flags).editable, allowed, String(flags));
    assert.equal(embeddingFromBytes(withPermissions(bytes, flags)).editable, allowed, `fontkit ${flags}`);
  }
  assert.equal(editableEmbedding(undefined).editable, false);
  assert.equal(embeddingFromBytes(bytes, 1).editable, false);
  assert.equal(embeddingFromBytes(withPermissions(bytes, 264)).noSubsetting, true);
  const collection = await readFile("server/testFixtures/fonts/Two-Faces.ttc");
  const changed = withPermissions(collection, 4, 1);
  assert(embeddingFromBytes(changed, 0).editable);
  assert(!embeddingFromBytes(changed, 1).editable);
});

test("font discovery excludes non-embeddable faces and preflight catches direct IDs and changed permissions", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-embedding-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = await readFile(fixture);
  await writeFile(path.join(dir, "allowed.ttf"), withPermissions(bytes, 8));
  await writeFile(path.join(dir, "readonly.ttf"), withPermissions(bytes, 4));
  const catalog = await loadFontCatalog(dir), fonts = new FontEligibility(catalog);
  const allowed = catalog.entries.find(font => font.sourceLabel === "allowed.ttf")!.id;
  const readonly = catalog.entries.find(font => font.sourceLabel === "readonly.ttf")!.id;
  const discovery = await fonts.fetch({ languages: ["sr-Latn"], text: "Đorđe" });
  assert.deepEqual(discovery.fonts.map(font => font.id), [allowed]);
  assert.equal(discovery.excludedByEmbedding, 1);
  assert.equal(discovery.fonts[0].embedding?.editable, true);
  const roles = (id: string) => ({ display: id, heading: id, body: id, label: id });
  const slides = [{ slideId: "s", copy: [{ role: "Headline", fontRole: "display" as const, text: "Đorđe" }] }];
  await assert.rejects(fonts.validate(["sr-Latn"], roles(readonly), slides), /preview-print/);
  await fonts.validate(["sr-Latn"], roles(allowed), slides);
  await writeFile(path.join(dir, "allowed.ttf"), withPermissions(bytes, 2));
  await assert.rejects(fonts.validate(["sr-Latn"], roles(allowed), slides), /restricted/);
});

test("export reports the used font families and reasons without blocking unused restricted variants or changing files", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-export-embedding-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = await readFile(fixture), readonly = withPermissions(bytes, 4);
  const allowedPath = path.join(dir, "allowed.ttf"), blockedPath = path.join(dir, "readonly.ttf");
  await writeFile(allowedPath, bytes); await writeFile(blockedPath, readonly);
  const deck = { fonts: [
    { id: "ok", family: "Allowed Family", subfamily: "Regular" },
    { id: "bad", family: "Source Family", subfamily: "Bold" },
    { id: "bad-copy", family: "Source Family", subfamily: "Bold" },
  ] } as Deck;
  const before = JSON.stringify(deck);
  await assertEditableFontEmbedding(deck, { ok: { path: allowedPath, face_index: 0 } });
  await assert.rejects(assertEditableFontEmbedding(deck, { bad: { path: blockedPath, face_index: 0 }, "bad-copy": { path: blockedPath, face_index: 0 } }), error => {
    assert.match(String(error), /Source Family \(Bold\): preview\/print embedding only/);
    assert.equal(String(error).split("Source Family").length, 2);
    assert.match(String(error), /deck has not been changed/); return true;
  });
  assert.equal(JSON.stringify(deck), before); assert.deepEqual(await readFile(blockedPath), readonly);
});
