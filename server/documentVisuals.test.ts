import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { RunContext } from "@openai/agents";
import { AttachmentLibrary, createAttachmentTools, extractAttachment } from "./attachments.js";
import { DeckStore } from "./deckStore.js";
import { DocumentVisuals, parseXml } from "./documentVisuals.js";
import type { Attachment, DeckSource } from "../src/shared/types.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-visuals-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
function attachment(dir: string, name: string, id = name): Attachment { return { id, kind: "file", name, path: path.join(dir, name) }; }
async function png() { return sharp({ create: { width: 200, height: 100, channels: 3, background: "#f97316" } }).png().toBuffer(); }

test("PDF pages include scanned visuals; crops preserve pixels and survive a new library instance", async t => {
  const dir = await fixture(t); const a = attachment(dir, "input.pdf");
  const doc = await PDFDocument.create(); const image = await doc.embedPng(await png());
  doc.addPage([200, 100]).drawText("Readable source text", { x: 10, y: 50, size: 12 });
  doc.addPage([200, 100]).drawImage(image, { x: 0, y: 0, width: 200, height: 100 });
  await writeFile(a.path!, await doc.save());
  const library = new AttachmentLibrary([a]); const extracted = await library.extract(a);
  assert.match(extracted.text!, /Readable source text/); assert.equal(extracted.pages, 2); assert.equal(extracted.visuals?.length, 2);
  const scan = extracted.visuals![1];
  const cropId = await library.visuals.crop(scan.id, { x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
  const crop = await library.visuals.prepare(cropId);
  const pixel = await sharp(crop.path).resize(1, 1).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixel], [249, 115, 22]);
  const resumed = await new DocumentVisuals([a]).prepare(cropId);
  assert.equal(resumed.id, cropId); assert.deepEqual(await readFile(resumed.path), await readFile(crop.path));
  await assert.rejects(library.visuals.crop(scan.id, { x: 0.9, y: 0, width: 0.2, height: 1 }), /bounds/);
  await assert.rejects(library.visuals.prepare("/etc/passwd"), /Unknown/);
});

test("standalone images are normalized without MIME metadata and returned as actual tool images with source records", async t => {
  const dir = await fixture(t); const a = attachment(dir, "picture.png"); await writeFile(a.path!, await png());
  const library = new AttachmentLibrary([a]); const initial = await library.imageInputs(); assert.equal(initial.length, 1);
  const sources: DeckSource[] = [];
  const tools = createAttachmentTools({ library, onActivity: async () => {}, onSource: async s => { sources.push(s); } });
  const list = tools.find(t => t.name === "list_attachment_visuals")!;
  const listing = JSON.parse(await list.invoke(new RunContext(), JSON.stringify({ attachmentId: a.id })) as string);
  assert.equal(listing.visuals[0].id, initial[0].visualId);
  const view = tools.find(t => t.name === "view_attachment_visual")!;
  const result = await view.invoke(new RunContext(), JSON.stringify({ visualId: initial[0].visualId })) as unknown as { type: string; image?: string }[];
  assert.equal(result[1].type, "image"); assert.match(result[1].image!, /^data:image\/png;base64,/); assert.equal(sources.length, 1);
  assert.equal(sources[0].kind, "file");
});

test("PPTX follows presentation relationship order, reads notes, and extracts images when page conversion is unavailable", async t => {
  const dir = await fixture(t); const a = attachment(dir, "ordered.pptx");
  const old = process.env.DOCUMENT_SOFFICE_PATH; process.env.DOCUMENT_SOFFICE_PATH = path.join(dir, "missing-converter");
  t.after(async () => { if (old === undefined) delete process.env.DOCUMENT_SOFFICE_PATH; else process.env.DOCUMENT_SOFFICE_PATH = old; });
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", '<p:presentation xmlns:p="p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="second"/><p:sldId r:id="first"/></p:sldIdLst></p:presentation>');
  zip.file("ppt/_rels/presentation.xml.rels", '<Relationships><Relationship Id="first" Target="slides/slide1.xml" Type="slide"/><Relationship Id="second" Target="slides/slide2.xml" Type="slide"/></Relationships>');
  const slide = (text: string) => `<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
  zip.file("ppt/slides/slide1.xml", slide("Last in presentation")); zip.file("ppt/slides/slide2.xml", slide("First in presentation"));
  zip.file("ppt/slides/_rels/slide2.xml.rels", '<Relationships><Relationship Id="image" Type="type/image" Target="../media/photo.png"/><Relationship Id="note" Type="type/notesSlide" Target="../notesSlides/note.xml"/><Relationship Id="external" Type="type/image" TargetMode="External" Target="https://invalid.example/private.png"/></Relationships>');
  zip.file("ppt/media/photo.png", await png()); zip.file("ppt/notesSlides/note.xml", slide("Speaker note"));
  await writeFile(a.path!, await zip.generateAsync({ type: "nodebuffer" }));
  const library = new AttachmentLibrary([a]); const data = await library.extract(a);
  assert.match(data.text!, /\[Slide 1\]\nFirst in presentation/); assert.match(data.text!, /\[Slide 1 notes\]\nSpeaker note/);
  assert.match(data.text!, /\[Slide 2\]\nLast in presentation/); assert.equal(data.visuals?.length, 1);
  assert(data.warnings!.some(w => /previews unavailable/.test(w))); assert(data.warnings!.some(w => /linked external/.test(w))); assert.equal((await library.visuals.prepare(data.visuals![0].id)).width, 200);
});

test("DOCX extracts body/header images and text; malformed and unsupported files are explicit without blocking other visuals", async t => {
  const dir = await fixture(t); const a = attachment(dir, "word.docx");
  const old = process.env.DOCUMENT_SOFFICE_PATH; process.env.DOCUMENT_SOFFICE_PATH = path.join(dir, "missing-converter");
  t.after(async () => { if (old === undefined) delete process.env.DOCUMENT_SOFFICE_PATH; else process.env.DOCUMENT_SOFFICE_PATH = old; });
  const zip = new JSZip(); zip.file("word/document.xml", '<w:document xmlns:w="w"><w:p><w:r><w:t>Document body</w:t></w:r></w:p></w:document>');
  zip.file("word/header1.xml", '<w:hdr xmlns:w="w"><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:hdr>');
  zip.file("word/_rels/header1.xml.rels", '<Relationships><Relationship Id="logo" Type="type/image" Target="media/logo.png"/></Relationships>');
  zip.file("word/media/logo.png", await png()); await writeFile(a.path!, await zip.generateAsync({ type: "nodebuffer" }));
  const bad = attachment(dir, "bad.pdf"); await writeFile(bad.path!, "broken");
  const library = new AttachmentLibrary([bad, a]); const manifest = await library.manifest();
  assert("note" in manifest[0] && manifest[0].note); assert.match((await library.extract(a)).text!, /Document body[\s\S]*Header/);
  assert.equal((await library.visuals.list()).length, 1);
  assert.equal((await extractAttachment(attachment(dir, "old.ppt"))).kind, "binary");
  assert.throws(() => parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a>&x;</a>'), /entities/);
});

test("source replacement invalidates visual IDs and cached crops", async t => {
  const dir = await fixture(t); const a = attachment(dir, "image.png"); await writeFile(a.path!, await png());
  const first = new DocumentVisuals([a]); const visual = (await first.list())[0];
  const crop = await first.crop(visual.id, { x: 0, y: 0, width: 0.5, height: 1 }); await first.prepare(crop);
  await writeFile(a.path!, await sharp({ create: { width: 200, height: 100, channels: 3, background: "blue" } }).png().toBuffer());
  const second = new DocumentVisuals([a]); assert.notEqual((await second.list())[0].id, visual.id);
  await assert.rejects(second.prepare(crop), /Unknown/);
});


test("uploads with identical filenames keep distinct source content and visual IDs", async t => {
  const dir = await fixture(t); const store = new DeckStore(dir);
  const orange = await png();
  const blue = await sharp({ create: { width: 200, height: 100, channels: 3, background: "blue" } }).png().toBuffer();
  const first = await store.saveAttachment("deck", "image.png", orange);
  const second = await store.saveAttachment("deck", "image.png", blue);
  assert.notEqual(first, second); assert.deepEqual(await readFile(first), orange);
  const library = new DocumentVisuals([
    { id: "first", kind: "file", name: "image.png", path: first },
    { id: "second", kind: "file", name: "image.png", path: second },
  ]);
  const visuals = await library.list(); assert.equal(visuals.length, 2); assert.notEqual(visuals[0].id, visuals[1].id);
  const pixels = await Promise.all(visuals.map(async v => sharp((await library.prepare(v.id)).path).resize(1, 1).removeAlpha().raw().toBuffer()));
  assert.notDeepEqual(pixels[0], pixels[1]);
});
