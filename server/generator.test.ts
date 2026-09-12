import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { setTracingDisabled } from "@openai/agents";
import sharp from "sharp";
import { generateDeck } from "./generator.js";
import { loadFontCatalog } from "./fontCatalog.js";
import { FontEligibility } from "./fontEligibility.js";
import { DeckStore } from "./deckStore.js";
import type { NarrativeUpdate } from "../src/shared/types.js";

setTracingDisabled(true);

test("the production authoring tools block bad copy before image requests, then render and persist the validated language/fonts", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-author-fonts-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DeckStore(dir), catalog = await loadFontCatalog("server/testFixtures/fonts"), fontEligibility = new FontEligibility(catalog);
  const face = (name: string) => catalog.entries.find(entry => entry.sourceLabel === name)!;
  const wide = face("Wide-Regular.ttf"), narrow = face("Narrow-Bold.ttf");
  const typography = (id: string) => ({ display: id, heading: id, body: id, label: id });
  const colors = { background: "#FFFFFF", surface: "#FFFFFF", text: "#000000", mutedText: "#111111", accent: "#222222", accentText: "#FFFFFF", border: "#333333" };
  const slides = [
    { slideNumber: 1, slideId: "s1", title: "Åsa", purpose: "Introduce", copy: [{ role: "Headline", fontRole: "display", text: "Åsa" }] },
    { slideNumber: 2, slideId: "s2", title: "Đorđe", purpose: "Explain", copy: [{ role: "Name", fontRole: "body", text: "Đorđe" }] },
  ];
  const ready = (id: string) => ({ stage: "ready_to_render", summary: "Ready", targetLanguages: ["sv"], thesis: "Test", audienceTakeaway: "Test", designDirection: "Test", typography: typography(id), colors, slides });
  let modelTurn = 0, imageRequests = 0;
  const updates: NarrativeUpdate[] = [], recovered: string[] = [];
  const pixel = await sharp({ create: { width: 16, height: 9, channels: 3, background: "white" } }).png().toBuffer();
  const call = (name: string, args: unknown) => ({ type: "function_call", id: `fc_${modelTurn}`, call_id: `call_${modelTurn}`, name, arguments: JSON.stringify(args), status: "completed" });
  const client = new OpenAI({ apiKey: "test-no-network", maxRetries: 0, fetch: async (input, init) => {
    const request = new Request(input, init);
    if (/\/images\/(generations|edits)$/.test(request.url)) {
      const payload = request.url.endsWith("edits") ? Object.fromEntries(await request.formData()) : await request.json();
      assert.match(String(payload.prompt), /priority order: sv/);
      assert.match(String(payload.prompt), /Use these exact font faces/);
      assert.match(String(payload.prompt), new RegExp(wide.id));
      assert.equal(payload.model, "gpt-image-2.5-sunburst"); assert.equal(payload.quality, "xhigh");
      imageRequests++;
      return Response.json({ data: [{ b64_json: pixel.toString("base64") }] });
    }
    assert.match(request.url, /\/responses$/);
    const body = await request.json(); assert(body.stream);
    const history = JSON.stringify(body.input);
    const output = [];
    switch (++modelTurn) {
      case 1:
        assert(body.tools.some((tool: { name?: string }) => tool.name === "fetch_fonts"));
        assert(!history.includes('"availableFonts"'));
        assert.match(body.instructions, /requested output language takes precedence/);
        output.push(call("report_narrative_progress", { stage: "framing", summary: "Write in Swedish", targetLanguages: ["sv"], audience: "Readers" })); break;
      case 2: output.push(call("fetch_fonts", { languages: ["sv"], text: "Åsa Đorđe" })); break;
      case 3: output.push(call("report_narrative_progress", ready(narrow.id))); break;
      case 4:
        assert.equal(imageRequests, 0); assert.match(history, /Font preflight failed/); assert.match(history, /U\+0110/);
        output.push(call("generate_slide_image", { ...slides[0], prompt: "Paint", alt: "Åsa" })); break;
      case 5:
        assert.equal(imageRequests, 0); assert.match(history, /complete ready_to_render/);
        output.push(call("report_narrative_progress", ready(wide.id))); break;
      case 6:
        output.push(call("generate_slide_image", { slideNumber: 1, slideId: "s1", copy: [{ role: "Headline", fontRole: "display", text: "Altered" }], prompt: "Paint", alt: "Altered" })); break;
      case 7:
        assert.equal(imageRequests, 0); assert.match(history, /exactly match/);
        output.push(call("generate_slide_image", { ...slides[0], prompt: "Paint", alt: "Åsa" })); break;
      case 8:
        assert.equal(imageRequests, 1);
        output.push(call("generate_slide_image", { ...slides[1], prompt: "Paint", alt: "Đorđe" })); break;
      case 9: {
        assert.equal(imageRequests, 2, history.slice(-3000));
        const assets = await store.loadAssets("probe");
        const fontRole = { fontId: wide.id, family: wide.family, weight: 400, style: "normal", letterSpacing: 0 };
        output.push(call("publish_deck", {
          title: "Svensk presentation",
          designSystem: { name: "Test", creativeDirection: "Test", rationale: "Test", typography: { relationship: "single-family", rationale: "Test", display: fontRole, heading: fontRole, body: fontRole, label: fontRole }, colors, imageTreatment: "Test", principles: ["Test"] },
          slides: slides.map(slide => ({ id: slide.slideId, title: slide.title, purpose: slide.purpose, copy: slide.copy, assetId: assets.find(asset => asset.slideId === slide.slideId)!.id, talkingPoints: "Här är förklaringen.", speakerNotes: "Svenska anteckningar." })), sources: [],
        })); break;
      }
      case 10: output.push({ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Klar.", annotations: [] }] }); break;
      default: throw new Error(`Unexpected model turn ${modelTurn}: ${history.slice(-3000)}`);
    }
    const response = { id: `resp_${modelTurn}`, object: "response", status: "completed", model: "test", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const events = [
      { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
      ...output.map((item, i) => ({ type: "response.output_item.added", sequence_number: i + 1, output_index: i, item })),
      { type: "response.completed", sequence_number: output.length + 1, response },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  }});
  const deck = await generateDeck({ deckId: "probe", request: { prompt: "Create exactly 2 slides in Swedish, retaining the supplied names.", attachments: [] }, store, fontEligibility, openaiClient: client,
    onProgress: async progress => { if (progress.narrativeUpdate) updates.push({ ...progress.narrativeUpdate, id: "update", createdAt: new Date().toISOString() }); },
    onAssetReady: async input => { assert.equal(input.typography.body, wide.id); recovered.push(input.slideId); },
  });
  assert.equal(imageRequests, 2); assert.deepEqual(recovered, ["s1", "s2"]);
  assert.deepEqual(deck.brief.inferred?.targetLanguages, ["sv"]);
  assert.deepEqual((await store.load("probe")).brief.inferred?.targetLanguages, ["sv"]);
  assert.equal(updates.filter(update => update.stage === "ready_to_render").length, 1);
  assert.deepEqual(updates.at(-1)?.slides?.map(slide => slide.copy), slides.map(slide => slide.copy));
});
