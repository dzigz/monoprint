import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { loadFontCatalog } from "./fontCatalog.js";
import { FontEligibility } from "./fontEligibility.js";
import { AuthoringFontPlan } from "./authoringFonts.js";
import { FONT_ROLE_NAMES, type NarrativeUpdate, type Deck, type TypographySystem, type DeckAsset } from "../src/shared/types.js";
import { buildRepaintPrompt } from "./repaint.js";
import { targetLanguageInstruction } from "../src/shared/languages.js";
import { deckSchema } from "../src/shared/schema.js";
import { PRESENTATION_AUTHOR_SYSTEM_PROMPT } from "../src/agent/systemPrompt.js";

const root = path.resolve("server/testFixtures/fonts");
const catalog = await loadFontCatalog(root), fonts = new FontEligibility(catalog);
const id = (name: string) => catalog.entries.find(entry => entry.sourceLabel === name)!.id;
const wide = id("Wide-Regular.ttf"), narrow = id("Narrow-Bold.ttf");
function makePlan(font = wide): NarrativeUpdate {
  return {
    id: "ready", stage: "ready_to_render", createdAt: "2026-09-11T00:00:00Z", summary: "Ready", targetLanguages: ["en"],
    typography: { display: font, heading: font, body: font, label: font },
    colors: { background: "#FFFFFF", surface: "#FFFFFF", text: "#000000", mutedText: "#111111", accent: "#222222", accentText: "#FFFFFF", border: "#333333" },
    slides: [
      { slideNumber: 1, slideId: "s1", title: "First", purpose: "First", copy: [{ role: "Headline", fontRole: "display", text: "First" }] },
      { slideNumber: 2, slideId: "s2", title: "Second", purpose: "Second", copy: [{ role: "Name", fontRole: "body", text: "Đorđe" }] },
    ],
  };
}
function design(plan: NarrativeUpdate): TypographySystem {
  return { relationship: "single-family", rationale: "Test", ...Object.fromEntries(FONT_ROLE_NAMES.map(role => {
    const face = fonts.describe(plan.typography![role]);
    return [role, { fontId: face.id, family: face.family, weight: face.weight, style: face.italic ? "italic" : "normal", letterSpacing: 0 }];
  })) } as TypographySystem;
}

test("whole-deck preflight blocks a later slide's unsupported words before slide 1; a corrected plan is accepted", async () => {
  const guard = new AuthoringFontPlan(fonts);
  const invalid = makePlan(narrow);
  await assert.rejects(guard.accept(invalid), error => {
    assert.match(String(error), /Đ/); assert.match(String(error), /U\+0110/); assert.match(String(error), /s2/); assert.match(String(error), /alternatives/);
    assert.match(String(error), new RegExp(wide)); return true;
  });
  await assert.rejects(guard.beforeImage(1, "s1", invalid.slides![0].copy!), /complete ready_to_render/);
  const accepted = await guard.accept(makePlan());
  await guard.beforeImage(1, "s1", accepted.slides![0].copy!);
  assert.match(guard.promptSpecification(), /Coverage Test/);
});

test("missing language/copy and language-incompatible faces cannot bypass the preflight", async () => {
  const guard = new AuthoringFontPlan(fonts), plan = makePlan();
  const noLanguage = { ...plan, targetLanguages: undefined };
  await assert.rejects(guard.accept(noLanguage), /targetLanguages/);
  const noCopy = { ...plan, slides: plan.slides!.map(slide => ({ ...slide, copy: undefined })) };
  await assert.rejects(guard.accept(noCopy), /complete role-labelled copy/);
  const wrongLanguage = makePlan(narrow); wrongLanguage.targetLanguages = ["sr-Latn"];
  wrongLanguage.slides!.forEach(slide => { slide.copy![0].text = "Test"; });
  await assert.rejects(guard.accept(wrongLanguage), /Font preflight failed/);
});

test("image copy, typography, colors, languages and order stay locked after the first render begins", async () => {
  const guard = new AuthoringFontPlan(fonts), plan = await guard.accept(makePlan());
  await assert.rejects(guard.beforeImage(1, "s1", [{ role: "Headline", fontRole: "display", text: "Different" }]), /exactly match/);
  await guard.beforeImage(1, "s1", plan.slides![0].copy!);
  guard.recordPlanningUpdate({ stage: "research_update", typography: undefined, colors: undefined });
  assert.match(guard.promptSpecification(), /Coverage Test/);
  assert.throws(() => guard.setLanguages(["sv"]), /locked/);
  assert.throws(() => guard.assertUpdateAllowed({ typography: makePlan(narrow).typography }), /locked/);
  assert.throws(() => guard.assertUpdateAllowed({ colors: { ...plan.colors!, accent: "#123456" } }), /locked/);
  const revised = makePlan(); revised.slides![1].copy![0].text = "Later revision";
  await assert.rejects(guard.accept(revised), /Copy.*locked/);
  await assert.rejects(guard.accept({ ...plan, slides: [...plan.slides!].reverse() }), /order.*locked/);
  await guard.accept(plan); // Idempotent reports/resume remain valid.
  guard.assertPublishedDesign(design(plan), plan.colors!);
  assert.throws(() => guard.assertPublishedDesign(design(plan), { ...plan.colors!, text: "#123456" }), /preserve/);
  const wrongStyle = design(plan); wrongStyle.body.style = "italic";
  assert.throws(() => guard.assertPublishedDesign(wrongStyle, plan.colors!), /exact face/);
});

test("pre-render language or art-direction revisions require a newly accepted plan", async () => {
  const guard = new AuthoringFontPlan(fonts), plan = await guard.accept(makePlan());
  guard.recordPlanningUpdate({ targetLanguages: ["de"] });
  await assert.rejects(guard.beforeImage(1, "s1", plan.slides![0].copy!), /complete ready_to_render/);
  const translated = await guard.accept({ ...plan, targetLanguages: ["de"] });
  guard.recordPlanningUpdate({ colors: { ...plan.colors!, accent: "#123456" } });
  await assert.rejects(guard.beforeImage(1, "s1", translated.slides![0].copy!), /complete ready_to_render/);
  const updated = await guard.accept({ ...translated, colors: { ...plan.colors!, accent: "#123456" } });
  await guard.beforeImage(1, "s1", updated.slides![0].copy!);
});

test("resume rechecks every planned slide against current font contents before rendering unfinished images", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "mp-font-resume-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "font.ttf"); await copyFile(path.join(root, "Wide-Regular.ttf"), file);
  const local = await loadFontCatalog(dir), service = new FontEligibility(local), fontId = local.entries[0].id;
  const first = new AuthoringFontPlan(service); const saved = JSON.parse(JSON.stringify(await first.accept(makePlan(fontId))));
  await copyFile(path.join(root, "Narrow-Bold.ttf"), file);
  const resumed = new AuthoringFontPlan(service, saved);
  await assert.rejects(resumed.beforeImage(1, "s1", saved.slides[0].copy), /Đ/);
});

test("legacy checkpoints can fill missing language/copy without changing the already-generated assets or fonts", async () => {
  const plan = makePlan(), old = { ...plan, targetLanguages: undefined, slides: plan.slides!.map(slide => ({ ...slide, copy: undefined })) };
  const asset = { slideId: "s1", copy: plan.slides![0].copy } as DeckAsset;
  const guard = new AuthoringFontPlan(fonts, old, undefined, [asset]);
  await assert.rejects(guard.beforeImage(2, "s2", plan.slides![1].copy!), /Older checkpoint/);
  await assert.rejects(guard.accept(makePlan(narrow)), /Typography.*locked/);
  const changed = makePlan(); changed.slides![0].copy![0].text = "Changed";
  await assert.rejects(guard.accept(changed), /Copy.*locked/);
  const accepted = await guard.accept(plan);
  await guard.beforeImage(2, "s2", accepted.slides![1].copy!);
});

test("a concurrently revised plan cannot render using the stale preflight result", async () => {
  const service = new FontEligibility(catalog), guard = new AuthoringFontPlan(service);
  const plan = await guard.accept(makePlan());
  const validate = service.validate.bind(service);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  service.validate = async (...args) => { await gate; return validate(...args); };
  const pending = guard.beforeImage(1, "s1", plan.slides![0].copy!);
  guard.recordPlanningUpdate({ targetLanguages: ["de"] }); release();
  await assert.rejects(pending, /plan changed/);
});

test("target language persists in saved deck schemas and repaint prompts; legacy decks keep their existing copy language", () => {
  const plan = makePlan();
  const deck = {
    schemaVersion: 4, id: "d", title: "Deck", brief: { prompt: "An English request for a Swedish deck", attachments: [], inferred: { targetLanguages: ["sv"] } },
    designSystem: { name: "Test", creativeDirection: "Test", rationale: "Test", typography: design(plan), colors: plan.colors!, imageTreatment: "Test", principles: ["Test"] },
    slides: [{ id: "s1", title: "Åsa", purpose: "Test", copy: [{ role: "Headline", text: "Åsa", fontRole: "display" }], assetId: "a", canvas: { width: 1536, height: 864 }, state: "generated", recovery: { status: "pending", updatedAt: plan.createdAt }, version: 1, history: [{ version: 1, assetId: "a", reason: "generated", createdAt: plan.createdAt }] }],
    assets: [{ id: "a", kind: "slide-image", slideId: "s1", url: "/a.png", prompt: "Test", copy: [{ role: "Headline", text: "Åsa", fontRole: "display" }], alt: "Åsa" }],
    fonts: [], createdAt: plan.createdAt, updatedAt: plan.createdAt, revision: 0,
  } as Deck;
  const restored = deckSchema.parse(JSON.parse(JSON.stringify(deck)));
  assert.deepEqual(restored.brief.inferred?.targetLanguages, ["sv"]);
  const prompt = buildRepaintPrompt(restored, restored.slides[0], "Change the background", restored.slides[0].copy);
  assert.match(prompt, /priority order: sv/); assert.match(prompt, /Åsa/);
  assert.match(targetLanguageInstruction(), /Preserve the language/);
  assert(!PRESENTATION_AUTHOR_SYSTEM_PROMPT.includes("descriptive English"));
  assert(PRESENTATION_AUTHOR_SYSTEM_PROMPT.includes("explicitly requested output language takes precedence"));
  assert(!PRESENTATION_AUTHOR_SYSTEM_PROMPT.includes("availableFonts"));
});
