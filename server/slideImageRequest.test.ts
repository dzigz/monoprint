import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import sharp from "sharp";
import { DocumentVisuals } from "./documentVisuals.js";
import { requestSlideImage, sourceVisualSelectionSchema } from "./slideImageRequest.js";

test("the real SDK sends selected source pixels before style anchors in multipart edits, including the first slide", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-image-request-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "input.png"), anchor = path.join(dir, "anchor.png");
  await writeFile(file, await sharp({ create: { width: 16, height: 16, channels: 3, background: "orange" } }).png().toBuffer());
  await writeFile(anchor, await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } }).png().toBuffer());
  const visuals = new DocumentVisuals([{ id: "input", name: "input.png", kind: "file", path: file }]);
  const source = { ...await visuals.prepare((await visuals.list())[0].id), instruction: "Retain the orange reference content." };
  let sent = 0;
  const client = new OpenAI({ apiKey: "test-no-network", maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init); assert.match(request.url, /images\/edits$/);
    const form = await request.formData(); const files = form.getAll("image[]") as File[];
    assert.equal(files.length, sent === 0 ? 1 : 2);
    assert.deepEqual(Buffer.from(await files[0].arrayBuffer()), await readFile(source.path));
    if (sent === 1) assert.deepEqual(Buffer.from(await files[1].arrayBuffer()), await readFile(anchor));
    const prompt = String(form.get("prompt")); assert.match(prompt, /Input image 1 is SOURCE CONTENT/);
    assert.match(prompt, /Retain the orange/);
    if (sent === 1) assert.match(prompt, /Input image 2 is earlier slide artwork/);
    assert.equal(form.get("model"), "gpt-image-2.5-sunburst"); assert.equal(form.get("quality"), "xhigh");
    sent++; return new Response(JSON.stringify({ data: [{ b64_json: "fixture" }] }), { headers: { "Content-Type": "application/json" } });
  }});
  await requestSlideImage(client.images, "New slide", [], [source]);
  await requestSlideImage(client.images, "New slide", [anchor], [source]); assert.equal(sent, 2);
});

test("slides without references keep the generation endpoint; selections enforce image limits and unique IDs", async () => {
  let sent = false;
  const client = new OpenAI({ apiKey: "test-no-network", maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init); assert.match(request.url, /images\/generations$/);
    const body = await request.json(); assert.equal(body.model, "gpt-image-2.5-sunburst"); assert.equal(body.image, undefined);
    sent = true; return new Response(JSON.stringify({ data: [] }), { headers: { "Content-Type": "application/json" } });
  }});
  await requestSlideImage(client.images, "Prompt", [], []); assert(sent);
  assert(!sourceVisualSelectionSchema.safeParse([{ visualId: "a", instruction: "Keep" }, { visualId: "a", instruction: "Keep" }]).success);
  assert(!sourceVisualSelectionSchema.safeParse(Array.from({ length: 15 }, (_, i) => ({ visualId: String(i), instruction: "Keep" }))).success);
});
