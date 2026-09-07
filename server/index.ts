import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import express from "express";
import dotenv from "dotenv";
import { z } from "zod";
import { applyCommands, editCommandSchema, EditCommandError } from "../src/shared/commands.js";
import { mergeServerDeck } from "../src/shared/merge.js";
import { deckSchema } from "../src/shared/schema.js";
import type { Attachment, EditRequest, GenerateDeckRequest } from "../src/shared/types.js";
import { DeckMutations } from "./deckMutations.js";
import { DeckStore } from "./deckStore.js";
import { runEditAgent } from "./editAgent.js";
import { loadFontCatalog } from "./fontCatalog.js";
import { FontRegistry } from "./fonts.js";
import { GenerationManager } from "./generationManager.js";
import { FocusInputError, FocusRegionManager } from "./focusRegionManager.js";
import { getOpenAIRequestTimeoutMs } from "./openaiClient.js";
import { SidecarRecoveryProvider } from "./recovery/sidecarProvider.js";
import { RecoveryManager } from "./recoveryManager.js";
import { RepaintManager } from "./repaint.js";
import { validateRepositoryRoot } from "./repositoryTools.js";

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
dotenv.config({ path: path.join(projectRoot, ".env.local") });

const port = Number(process.env.PORT ?? 4175);
const artifactsRoot = path.resolve(process.env.ARTIFACTS_ROOT ?? path.join(projectRoot, "artifacts"));
const configuredFontLibrary = process.env.FONT_LIBRARY_PATH?.trim();
const fontLibraryRoots = configuredFontLibrary
  ? [path.resolve(configuredFontLibrary)]
  : [
      "/System/Library/Fonts",
      "/System/Library/Fonts/Supplemental",
      "/Library/Fonts",
      path.join(homedir(), "Library/Fonts"),
    ];
const fontSourceLabel = configuredFontLibrary ? configuredFontLibrary : "Installed macOS fonts";
const fontCatalog = await loadFontCatalog(fontLibraryRoots);
const fonts = new FontRegistry(fontCatalog, artifactsRoot);
const store = new DeckStore(artifactsRoot);
const mutations = new DeckMutations(store, fonts);
const focusRegions = new FocusRegionManager(store, mutations);
mutations.onDeckChanged((deck) => focusRegions.schedule(deck.id));
const recoveryProvider = new SidecarRecoveryProvider({
  baseUrl: process.env.TEXT_LAYER_SIDECAR_URL ?? "http://127.0.0.1:4174",
  runsDirectory: path.resolve(process.env.SIDECAR_RUNS_DIR ?? path.join(homedir(), "Documents/font_matching_proto/runs/docedit/v4")),
  docPrefix: process.env.SIDECAR_DOC_PREFIX ?? "mp",
  reuseRuns: process.env.SIDECAR_REUSE_RUNS !== "0",
  designAgent: process.env.SIDECAR_DESIGN_AGENT !== "0",
  fontRegistry: fonts,
});
const generations = new GenerationManager(store, fontCatalog.entries);
const recovery = new RecoveryManager(store, mutations, fonts, recoveryProvider);
const repaints = new RepaintManager(store, mutations, async (deckId, slideId) => {
  await recovery.enqueue(deckId, [slideId], { force: true });
});
// Slide stages flow back onto the run record so the working screen can show them.
recovery.onStatus((deckId, slideId, status, message) => generations.reportSlideRecovery(deckId, slideId, status, message));
// Text recovery starts the moment a slide is painted, not after publication.
generations.onAssetReady(async (input) => {
  const health = await recoveryProvider.health();
  if (!health.available) {
    console.warn(`Text recovery deferred for ${input.slideId}: ${health.detail}`);
    return;
  }
  await recovery.enqueueAsset(input);
});
generations.onCompleted(async (deck) => {
  await recovery.attachPending(deck.id);
  focusRegions.schedule(deck.id);
  const health = await recoveryProvider.health();
  if (!health.available) {
    console.warn(`Text recovery skipped for deck ${deck.id}: ${health.detail}`);
    return;
  }
  await recovery.enqueue(deck.id);
});

const app = express();
app.use(express.json({ limit: "250mb" }));

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

// ----------------------------------------------------------------- config

app.get("/api/config", async (_request, response) => {
  const health = await recoveryProvider.health();
  response.json({
    generationConfigured: Boolean(process.env.OPENAI_API_KEY),
    fontCatalogSize: fontCatalog.entries.length,
    fontSourceLabel,
    openAIRequestTimeoutMs: getOpenAIRequestTimeoutMs(),
    recovery: { provider: recoveryProvider.name, available: health.available, detail: health.detail },
    platform: process.platform,
  });
});

// ------------------------------------------------------------------ decks

app.get("/api/decks", async (_request, response) => {
  try {
    response.json({ decks: await store.summaries() });
  } catch (error) {
    console.error("Deck listing failed.", error);
    response.status(500).json({ error: errorMessage(error, "Could not list decks.") });
  }
});

app.get("/api/decks/latest", async (_request, response) => {
  try {
    const deck = await store.loadLatest();
    response.json({ deck: await focusRegions.ensureDeck(deck.id) });
  } catch {
    response.status(404).json({ error: "No deck exists yet." });
  }
});

app.get("/api/decks/:deckId", async (request, response) => {
  try {
    response.json({ deck: await focusRegions.ensureDeck(request.params.deckId), recovery: recovery.job(request.params.deckId), repaint: repaints.job(request.params.deckId) });
  } catch {
    response.status(404).json({ error: "Deck not found." });
  }
});

const commandsBodySchema = z.object({ commands: z.array(editCommandSchema).min(1).max(500) });

const focusRequestSchema = z.object({
  inputKey: z.string().min(1).max(100),
  image: z.string().max(40_000_000).optional(),
  retry: z.boolean().optional(),
});
app.post("/api/decks/:deckId/slides/:slideId/focus-regions", async (request, response) => {
  try {
    const body = focusRequestSchema.parse(request.body);
    const deck = await focusRegions.request(request.params.deckId, request.params.slideId, body.inputKey, body.image, body.retry);
    response.json({ deck });
  } catch (error) {
    const status = error instanceof FocusInputError ? error.status : error instanceof z.ZodError ? 400 : 500;
    response.status(status).json({ error: status === 500 ? "Could not prepare slide highlights." : errorMessage(error, "Invalid highlight request.") });
  }
});

app.post("/api/decks/:deckId/commands", async (request, response) => {
  try {
    const { commands } = commandsBodySchema.parse(request.body);
    const deck = await mutations.mutate(request.params.deckId, (current) => applyCommands(current, commands));
    response.json({ deck });
  } catch (error) {
    const status = error instanceof EditCommandError || error instanceof z.ZodError ? 400 : 500;
    response.status(status).json({ error: errorMessage(error, "Edit failed.") });
  }
});

app.put("/api/decks/:deckId", async (request, response) => {
  try {
    const incoming = deckSchema.parse(request.body?.deck);
    if (incoming.id !== request.params.deckId) throw new Error("Deck id mismatch.");
    const deck = await mutations.mutate(request.params.deckId, (current) => mergeServerDeck(incoming, current));
    response.json({ deck });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400 : 500;
    response.status(status).json({ error: errorMessage(error, "The deck could not be saved.") });
  }
});

app.get("/api/decks/:deckId/events", async (request, response) => {
  const deckId = request.params.deckId;
  try {
    await mutations.load(deckId);
  } catch {
    response.status(404).json({ error: "Deck not found." });
    return;
  }
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  const send = (event: string, payload: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  const unsubscribe = mutations.subscribe(deckId, (event) => {
    if (event.type === "deck") send("deck", event.deck);
    else if (event.type === "recovery") send("recovery", event.job);
    else send("repaint", event.job);
  });
  const recoveryJob = recovery.job(deckId);
  if (recoveryJob) send("recovery", recoveryJob);
  const repaintJob = repaints.job(deckId);
  if (repaintJob) send("repaint", repaintJob);
  // Recover events missed between the initial GET and SSE connection, or
  // while the browser was disconnected. Revision checks discard older copies.
  void mutations.load(deckId).then((deck) => { if (!response.destroyed) send("deck", deck); }).catch(() => {});
  focusRegions.schedule(deckId);
  const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// --------------------------------------------------------------- recovery

app.post("/api/decks/:deckId/recovery", async (request, response) => {
  try {
    const health = await recoveryProvider.health();
    if (!health.available) throw new Error(health.detail ?? "The text pipeline is not available.");
    const slideIds = Array.isArray(request.body?.slideIds) ? request.body.slideIds.map(String) : undefined;
    const force = Boolean(request.body?.force);
    const fresh = Boolean(request.body?.fresh);
    response.status(202).json({ job: await recovery.enqueue(request.params.deckId, slideIds, { force, fresh }) });
  } catch (error) {
    response.status(409).json({ error: errorMessage(error, "Recovery could not start.") });
  }
});

app.post("/api/decks/:deckId/recovery/cancel", async (request, response) => {
  try {
    response.json({ job: await recovery.cancel(request.params.deckId) });
  } catch (error) {
    response.status(409).json({ error: errorMessage(error, "Recovery could not be stopped.") });
  }
});

// ---------------------------------------------------------- prompt editing

const editBodySchema = z.object({
  prompt: z.string().min(1).max(4000),
  scope: z.enum(["object", "slide", "deck"]),
  slideId: z.string().min(1).optional(),
  objectId: z.string().min(1).optional(),
  snapshots: z.record(z.string(), z.string().max(6_000_000)).optional(),
});

app.post("/api/decks/:deckId/edit", async (request, response) => {
  try {
    const body = editBodySchema.parse(request.body) as EditRequest;
    const deck = await mutations.load(request.params.deckId);
    const result = await runEditAgent({ deck, request: body, fontCatalog: fontCatalog.entries });
    if (result.kind === "applied") {
      const saved = await mutations.mutate(request.params.deckId, () => result.deck);
      response.json({ ...result, deck: saved });
      return;
    }
    response.json(result);
  } catch (error) {
    const status = error instanceof EditCommandError || error instanceof z.ZodError ? 400 : 500;
    console.error(error);
    response.status(status).json({ error: errorMessage(error, "The edit could not be completed.") });
  }
});

app.post("/api/decks/:deckId/slides/:slideId/repaint", async (request, response) => {
  try {
    const instruction = String(request.body?.instruction ?? "").trim();
    if (!instruction) throw new Error("A repaint instruction is required.");
    response.status(202).json({ job: await repaints.start(request.params.deckId, request.params.slideId, instruction) });
  } catch (error) {
    response.status(409).json({ error: errorMessage(error, "The repaint could not start.") });
  }
});

app.post("/api/decks/:deckId/repaint/cancel", async (request, response) => {
  response.json({ job: await repaints.cancel(request.params.deckId) });
});

const bakeBodySchema = z.object({ image: z.string().min(32).max(30_000_000) });

app.post("/api/decks/:deckId/slides/:slideId/bake", async (request, response) => {
  try {
    const { image } = bakeBodySchema.parse(request.body);
    const match = image.match(/^data:image\/png;base64,(.+)$/);
    if (!match) throw new Error("Expected a PNG data URL.");
    const assetId = randomUUID();
    const fileName = `${assetId}.png`;
    await store.prepare(request.params.deckId);
    await import("node:fs/promises").then((fs) => fs.writeFile(store.assetPath(request.params.deckId, fileName), Buffer.from(match[1], "base64")));
    const deck = await mutations.mutate(request.params.deckId, (current) => {
      const slide = current.slides.find((candidate) => candidate.id === request.params.slideId);
      if (!slide) throw new Error("Unknown slide.");
      const now = new Date().toISOString();
      return {
        ...current,
        assets: [...current.assets, {
          id: assetId,
          kind: "slide-export",
          slideId: slide.id,
          url: `/api/assets/${current.id}/${fileName}`,
          prompt: "",
          copy: [],
          alt: `${slide.title} (baked)`,
          width: slide.canvas.width,
          height: slide.canvas.height,
        }],
        slides: current.slides.map((candidate) => candidate.id !== slide.id ? candidate : {
          ...candidate,
          version: candidate.version + 1,
          history: [...candidate.history, { version: candidate.version + 1, assetId, reason: "baked", createdAt: now }],
        }),
      };
    });
    response.json({ deck, assetUrl: `/api/assets/${request.params.deckId}/${fileName}` });
  } catch (error) {
    response.status(400).json({ error: errorMessage(error, "The bake could not be saved.") });
  }
});

// ------------------------------------------------------------- generation

const uploadSchema = z.object({
  prompt: z.string().min(1).max(20_000),
  attachments: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), name: z.string().min(1).max(255), mimeType: z.string().max(200).optional(), dataBase64: z.string().min(1) }),
    z.object({ kind: z.literal("folder"), path: z.string().min(1).max(2000) }),
    z.object({ kind: z.literal("link"), url: z.url() }),
  ])).max(100).default([]),
});

app.post("/api/generate", async (request, response) => {
  try {
    const body = uploadSchema.parse(request.body);
    const deckId = randomUUID();
    const attachments: Attachment[] = [];
    for (const item of body.attachments) {
      if (item.kind === "file") {
        const content = Buffer.from(item.dataBase64, "base64");
        const storedPath = await store.saveAttachment(deckId, item.name, content);
        attachments.push({ id: randomUUID(), kind: "file", name: item.name, path: storedPath, mimeType: item.mimeType, size: content.byteLength });
      } else if (item.kind === "folder") {
        const resolved = await validateRepositoryRoot(item.path);
        attachments.push({ id: randomUUID(), kind: "folder", name: path.basename(resolved), path: resolved });
      } else {
        attachments.push({ id: randomUUID(), kind: "link", name: new URL(item.url).hostname, url: item.url });
      }
    }
    const generationRequest: GenerateDeckRequest = { prompt: body.prompt.trim(), attachments };
    const generation = await generations.start(generationRequest, deckId);
    response.status(202).json({ generation });
  } catch (error) {
    console.error(error);
    response.status(400).json({ error: errorMessage(error, "Could not start generation.") });
  }
});

app.post("/api/pick-folder", async (_request, response) => {
  if (process.platform !== "darwin") {
    response.status(400).json({ error: "The folder picker is only available on macOS. Paste a folder path into the prompt instead." });
    return;
  }
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", "POSIX path of (choose folder with prompt \"Choose a folder for the presentation\")"], { timeout: 120_000 });
    const chosen = stdout.trim().replace(/\/$/, "");
    if (!chosen) throw new Error("No folder chosen.");
    const resolved = await validateRepositoryRoot(chosen);
    response.json({ path: resolved, name: path.basename(resolved) });
  } catch (error) {
    const message = errorMessage(error, "No folder chosen.");
    response.status(/canceled|cancelled|-128/i.test(message) ? 204 : 400).json({ error: message });
  }
});

app.get("/api/generations", async (_request, response) => {
  response.json({ generations: await generations.list() });
});

app.get("/api/generations/latest", async (_request, response) => {
  try {
    response.json({ generation: await generations.latest() });
  } catch {
    response.status(404).json({ error: "No generation exists yet." });
  }
});

app.get("/api/generations/:generationId", async (request, response) => {
  try {
    response.json({ generation: await generations.get(request.params.generationId) });
  } catch {
    response.status(404).json({ error: "Generation not found." });
  }
});

app.get("/api/generations/:generationId/events", async (request, response) => {
  try {
    const generationId = request.params.generationId;
    await generations.get(generationId);
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const send = (generation: Awaited<ReturnType<typeof generations.get>>) => {
      response.write(`event: status\ndata: ${JSON.stringify(generation)}\n\n`);
    };
    const unsubscribe = generations.subscribe(generationId, send);
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  } catch {
    response.status(404).json({ error: "Generation not found." });
  }
});

app.post("/api/generations/:generationId/resume", async (request, response) => {
  try {
    response.status(202).json({ generation: await generations.resume(request.params.generationId) });
  } catch (error) {
    response.status(409).json({ error: errorMessage(error, "Generation could not be resumed.") });
  }
});

app.post("/api/generations/:generationId/cancel", async (request, response) => {
  try {
    response.status(202).json({ generation: await generations.cancel(request.params.generationId) });
  } catch (error) {
    response.status(409).json({ error: errorMessage(error, "Generation could not be stopped.") });
  }
});

// ------------------------------------------------------------ assets/fonts

app.get("/api/assets/:deckId/:fileName", (request, response) => {
  if (path.basename(request.params.fileName) !== request.params.fileName) {
    response.status(400).json({ error: "Invalid asset name." });
    return;
  }
  response.sendFile(path.join(store.directory(request.params.deckId), request.params.fileName), (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: "Asset unavailable." });
  });
});

app.get("/api/assets/:deckId/fonts/:fileName", (request, response) => {
  if (path.basename(request.params.fileName) !== request.params.fileName) {
    response.status(400).json({ error: "Invalid font name." });
    return;
  }
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.sendFile(path.join(store.fontsDirectory(request.params.deckId), request.params.fileName), (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: "Font unavailable." });
  });
});

app.get("/api/fonts/catalog/:catalogId", (request, response) => {
  const file = fonts.catalogFilePath(request.params.catalogId);
  if (!file) {
    response.status(404).json({ error: "Unknown font." });
    return;
  }
  response.setHeader("Cache-Control", "public, max-age=86400");
  response.sendFile(file.path, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: "Font unavailable." });
  });
});

app.get("/api/fonts", (request, response) => {
  const query = String(request.query.q ?? "").toLowerCase();
  const limit = Math.min(200, Number(request.query.limit ?? 50));
  const entries = query
    ? fontCatalog.entries.filter((font) => font.family.toLowerCase().includes(query) || font.subfamily.toLowerCase().includes(query))
    : fontCatalog.entries;
  response.json({ fonts: entries.slice(0, limit) });
});

// ------------------------------------------------------------------- app

if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({ server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(projectRoot, "dist")));
  app.use((_request, response) => {
    response.sendFile(path.join(projectRoot, "dist", "index.html"));
  });
}

app.listen(port, () => {
  console.log(`Monoprint: http://localhost:${port}`);
  console.log(`Font catalog: ${fontCatalog.entries.length} faces from ${fontSourceLabel}`);
  void recoveryProvider.health().then((health) => {
    console.log(health.available ? `Text pipeline: ${health.detail}` : `Text pipeline unavailable: ${health.detail}`);
  });
  void recovery.recoverStale().catch((error) => console.error("Could not re-queue interrupted recovery jobs.", error));
});
