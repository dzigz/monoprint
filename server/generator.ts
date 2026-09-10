import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Agent,
  isOpenAIResponsesRawModelStreamEvent,
  OpenAIProvider,
  Runner,
  RunState,
  tool,
  user,
  webSearchTool,
  type AgentInputItem,
} from "@openai/agents";
import { toFile } from "openai";
import { z } from "zod";
import {
  CODEBASE_PRESENTATION_GUIDANCE,
  PRESENTATION_AUTHOR_SYSTEM_PROMPT,
} from "../src/agent/systemPrompt.js";
import {
  DEFAULT_CANVAS,
  deckSchema,
  normalizePublishedDeckDraft,
  publishDeckToolSchema,
  slideCopySchema,
  validateDeck,
  type PublishedDeckInput,
} from "../src/shared/schema.js";
import {
  appendRoleLabeledCopyBlock,
  formatRoleLabeledCopyBlock,
  slideCopyMatches,
} from "../src/shared/slideCopy.js";
import type {
  AssetRecoveryInput,
  Deck,
  DeckAsset,
  DeckColors,
  DeckSource,
  FontCatalogEntry,
  GenerateDeckRequest,
  GenerationProgress,
  NarrativeUpdate,
  PlannedTypography,
  RepositorySource,
  Slide,
  SlideCopyItem,
} from "../src/shared/types.js";
import { FONT_ROLE_NAMES } from "../src/shared/types.js";
import { attachRecord } from "./recoveryManager.js";
import { AttachmentLibrary, createAttachmentTools, extractLinks, isAttachmentToolName } from "./attachments.js";
import { DeckStore } from "./deckStore.js";
import { imageDimensions } from "./recovery/plate.js";
import { fontCatalogForPrompt } from "./fontCatalog.js";
import { getOpenAIClient } from "./openaiClient.js";
import { SLIDE_IMAGE_SETTINGS } from "./slideImageSettings.js";
import {
  createRepositoryTools,
  isRepositoryToolName,
  RepositoryReader,
  validateRepositoryRoot,
} from "./repositoryTools.js";
import {
  isTerminalRunStateCheckpoint,
  publishDeckDraftsFromRunState,
  repositorySourcesFromRunState,
  runStateUsedWebSearch,
} from "./runCheckpoint.js";

const MAX_PARALLEL_SLIDE_IMAGES = 30;

function repositoryActivityLabel(message: string) {
  const trimmed = message.replace(/\.$/, "");
  const read = trimmed.match(/^Reading (.+?)(?: from line \d+)?$/);
  if (read) return read[1];
  const search = trimmed.match(/^Searching repository source for [“"](.+)[”"]$/);
  if (search) return `search: ${search[1]}`;
  const inspect = trimmed.match(/^Inspecting the repository structure(?: at (.+))?$/);
  if (inspect) return inspect[1] ? `folder ${inspect[1]}` : "repository root";
  return trimmed || "Repository";
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};

/** The slide count the user wrote in the prompt, if any. Only an explicit number binds the author. */
export function extractRequestedSlideCount(prompt: string): number | undefined {
  const text = prompt.toLowerCase().replace(/\s+/g, " ");
  const patterns = [
    /\b(\d{1,2})\s*(?:-|–)?\s*(?:slides?|pages?)\b/,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s*(?:-|–)?\s*(?:slides?|pages?)\b/,
    /\b(?:slide|page)\s*(?:count|number)\s*(?:[:=]|of|is|should be|around|about)?\s*(\d{1,2})\b/,
    /\b(?:around|about|roughly|exactly|max|maximum|at most|up to)\s*(\d{1,2})\s*(?:slides?|pages?)\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(match[1]) || NUMBER_WORDS[match[1]];
    if (value && value >= 1 && value <= 60) return value;
  }
  return undefined;
}

function createHashId(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}
const STYLE_ANCHOR_SLIDES = 2;
const WORKING_NOTE_UPDATE_INTERVAL_MS = 250;

function errorChain(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    current = record.cause ?? record.error;
  }
  return chain;
}

function isTransientCallError(error: unknown) {
  return errorChain(error).some((item) => {
    if (!(item instanceof Error)) return false;
    const record = item as Error & { code?: string; status?: number; statusCode?: number };
    const status = record.status ?? record.statusCode;
    if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) return true;
    if (["APIConnectionError", "APIConnectionTimeoutError", "FetchError", "ModelTimeoutError"].includes(record.name)) {
      return true;
    }
    return [
      "EAI_AGAIN",
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ENOTFOUND",
      "EPIPE",
      "ETIMEDOUT",
      "UND_ERR_BODY_TIMEOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
    ].includes(record.code ?? "");
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Generation stopped by the user.");
}

async function retryTransientCall<T>(operation: () => Promise<T>, signal?: AbortSignal) {
  try {
    throwIfAborted(signal);
    return await operation();
  } catch (error) {
    if (signal?.aborted || !isTransientCallError(error)) throw error;
    return operation();
  }
}

function createConcurrencyGate(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(operation: () => Promise<T>) {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

function fullSlidePrompt(prompt: string, styleReferenceCount: number) {
  return [
    "Create one complete, polished presentation slide as a single full-bleed landscape image.",
    "This is the actual slide artwork, not a slide shown inside a mockup, screen, device, editor, or room.",
    "Compose across the full native 1536x864 (16:9) canvas. Keep essential words and visuals within comfortable slide-safe margins; the viewer will preserve the entire image without cropping.",
    "Treat the slide as editorial information design: the visual structure and exact words must together communicate a specific relationship, mechanism, comparison, change, piece of evidence, or consequence. Make the focal idea immediately recoverable and keep supporting context quiet.",
    "Do not add generic AI-presentation styling such as automatic dark-neon technology aesthetics, glowing networks or orbs, glassmorphism, floating 3D icons, decorative data particles, arbitrary gradients, or dashboard-card grids unless the production specification gives that device a necessary content-specific role.",
    styleReferenceCount > 0
      ? `The ${styleReferenceCount === 1 ? "input image is" : `${styleReferenceCount} input images are`} earlier slide artwork supplied only as ${styleReferenceCount === 1 ? "a" : "the"} deck-level style reference. Preserve the established typography character, palette, background treatment, medium, texture, line quality, and recurring visual grammar. Do not copy or retain reference-slide wording, data, subject matter, objects, or layout; create the new slide specified below.`
      : undefined,
    "Render typography cleanly and exactly as specified. Add no unrequested text, logos, watermarks, page furniture, or UI chrome.",
    prompt,
  ].filter(Boolean).join("\n\n");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function isTerminalStateResumeError(error: unknown) {
  return errorChain(error).some((item) => (
    item instanceof Error && item.message.includes("cannot be resumed directly from serialized terminal state")
  ));
}

export async function generateDeck({
  deckId,
  request,
  fontCatalog,
  store,
  resume = false,
  signal,
  initialAttempt = 0,
  onProgress = async () => {},
  onAssetReady,
}: {
  deckId: string;
  request: GenerateDeckRequest;
  fontCatalog: FontCatalogEntry[];
  store: DeckStore;
  resume?: boolean;
  signal?: AbortSignal;
  initialAttempt?: number;
  onProgress?: (progress: GenerationProgress) => Promise<void>;
  /** Called the moment a slide image is written, so text recovery can start before publication. */
  onAssetReady?: (input: AssetRecoveryInput) => Promise<void>;
}) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");

  const folderAttachment = request.attachments.find((attachment) => attachment.kind === "folder" && attachment.path);
  const repositoryRoot = folderAttachment?.path
    ? await validateRepositoryRoot(folderAttachment.path)
    : undefined;
  const repositoryReader = repositoryRoot ? new RepositoryReader(repositoryRoot, signal) : undefined;
  const promptLinks = extractLinks(request.prompt);
  const attachments = [
    ...request.attachments,
    ...promptLinks
      .filter((url) => !request.attachments.some((attachment) => attachment.kind === "link" && attachment.url === url))
      .map((url) => ({ id: `link-${createHashId(url)}`, kind: "link" as const, name: new URL(url).hostname, url })),
  ];
  const library = new AttachmentLibrary(attachments);
  const attachmentIds = new Set(attachments.filter((attachment) => attachment.kind === "file").map((attachment) => attachment.id));
  const observedFileAndLinkSources = new Map<string, DeckSource>();
  let inferredAudience: string | undefined;
  const explicitSlideCount = extractRequestedSlideCount(request.prompt);
  let inferredSlideCount: number | undefined = explicitSlideCount;
  let plannedDesign: { typography: PlannedTypography; colors: DeckColors } | undefined;
  const catalogFontIds = new Set(fontCatalog.map((font) => font.id));

  const outputDirectory = await store.prepare(deckId);
  if (resume) {
    try {
      return deckSchema.parse(await store.load(deckId));
    } catch {
      // The generation has not published a deck yet.
    }
  }

  let persistedAssets: DeckAsset[] = [];
  if (resume) {
    try {
      persistedAssets = await store.loadAssets(deckId);
    } catch {
      // A checkpoint can exist before the first slide image is generated.
    }
  }

  let serializedResumeState: string | undefined;
  if (resume) {
    try {
      serializedResumeState = await store.loadRunState(deckId);
    } catch {
      // A saved deck may exist without an agent checkpoint.
    }
  }

  const assets = new Map<string, DeckAsset>(persistedAssets.map((asset) => [asset.id, asset]));
  const assetBySlideId = new Map(persistedAssets.map((asset) => [asset.slideId, asset]));
  const assetBySlideNumber = new Map<number, DeckAsset>();
  for (const asset of persistedAssets) {
    if (asset.slideNumber === undefined) continue;
    const existing = assetBySlideNumber.get(asset.slideNumber);
    if (existing && existing.id !== asset.id) {
      throw new Error(`Multiple generated images claim slide number ${asset.slideNumber}.`);
    }
    assetBySlideNumber.set(asset.slideNumber, asset);
  }
  const pendingBySlideId = new Map<string, { slideNumber: number; promise: Promise<string> }>();
  const pendingSlideIdByNumber = new Map<number, string>();
  const runImageGeneration = createConcurrencyGate(MAX_PARALLEL_SLIDE_IMAGES);
  const firstSlideReady = createDeferred<DeckAsset>();
  const secondSlideReady = createDeferred<DeckAsset>();
  const persistedFirstSlide = assetBySlideNumber.get(1);
  const persistedSecondSlide = assetBySlideNumber.get(2);
  if (persistedFirstSlide) firstSlideReady.resolve(persistedFirstSlide);
  if (persistedSecondSlide) secondSlideReady.resolve(persistedSecondSlide);
  let assetWrite = Promise.resolve();
  let readyNarrativePlan: NarrativeUpdate | undefined;
  if (resume) {
    try {
      const generation = await store.loadGeneration(deckId);
      readyNarrativePlan = [...(generation.narrativeUpdates ?? [])]
        .reverse()
        .find((update) => update.stage === "ready_to_render");
    } catch {
      // Older checkpoints may not contain structured narrative progress.
    }
  }
  const observedRepositorySources = new Map<string, RepositorySource>(
    (serializedResumeState ? repositorySourcesFromRunState(serializedResumeState) : [])
      .map((source) => [source.id, source]),
  );
  let webResearchUsed = serializedResumeState ? runStateUsedWebSearch(serializedResumeState) : false;
  if (resume) {
    try {
      const generation = await store.loadGeneration(deckId);
      const framing = [...(generation.narrativeUpdates ?? [])].reverse().find((update) => update.stage === "framing");
      inferredAudience = framing?.audience;
      inferredSlideCount = explicitSlideCount ?? framing?.requestedSlideCount;
      const designUpdate = [...(generation.narrativeUpdates ?? [])].reverse().find((update) => update.typography && update.colors);
      if (designUpdate?.typography && designUpdate.colors) plannedDesign = { typography: designUpdate.typography, colors: designUpdate.colors };
    } catch {
      // No framing update was recorded.
    }
  }

  async function saveAssets() {
    const snapshot = [...assets.values()];
    assetWrite = assetWrite.catch(() => {}).then(() => store.saveAssets(deckId, snapshot));
    await assetWrite;
  }

  await saveAssets();
  const openai = getOpenAIClient();
  const runner = new Runner({ modelProvider: new OpenAIProvider({ openAIClient: openai }) });
  let publishedDeck: Deck | undefined;
  let publicationAttempts = 0;
  const MAX_PUBLICATION_ATTEMPTS = 2;

  function canonicalSources(inputSources: DeckSource[] | undefined) {
    const byLocation = new Map<string, DeckSource>();
    const observedLinks = new Set([...observedFileAndLinkSources.values()].filter((source) => source.kind === "web").map((source) => (source as { url: string }).url));
    for (const source of inputSources ?? []) {
      if (source.kind === "web" && (webResearchUsed || observedLinks.has(source.url))) {
        byLocation.set(`web:${source.url}`, source);
      }
      if (source.kind === "file" && attachmentIds.has(source.attachmentId)) {
        byLocation.set(`file:${source.attachmentId}:${source.locator ?? ""}`, source);
      }
    }
    for (const source of observedRepositorySources.values()) {
      byLocation.set(`repository:${source.path}:${source.startLine}:${source.endLine}`, source);
    }
    return [...byLocation.values()];
  }

  async function finalizeDeck(input: PublishedDeckInput) {
    if (!readyNarrativePlan?.slides) {
      throw new Error("A ready_to_render narrative plan must be reported before publication.");
    }
    if (input.slides.length !== readyNarrativePlan.slides.length) {
      throw new Error("The published deck must contain every slide in the visible ready_to_render narrative plan.");
    }

    const sources = canonicalSources(input.sources);
    const sourceIds = new Set(sources.map((source) => source.id));
    const slides = readyNarrativePlan.slides.map((planned, index) => {
      const submitted = input.slides[index];
      const asset = assetBySlideId.get(planned.slideId);
      if (!submitted || submitted.id !== planned.slideId) {
        throw new Error(`Published slide ${index + 1} must be ${planned.slideId}, the slide planned at that position in the ready_to_render plan (received ${submitted?.id ?? "nothing"}).`);
      }
      if (!asset) throw new Error(`Slide ${planned.slideId} does not have a generated image.`);
      const retainedSourceIds = (submitted.sourceIds ?? []).filter((sourceId) => sourceIds.has(sourceId));
      const transition = submitted.transitionFromPrevious ?? planned.transitionFromPrevious;
      return {
        id: planned.slideId,
        title: submitted.title.trim() || planned.title,
        purpose: submitted.purpose.trim() || planned.purpose,
        copy: submitted.copy,
        assetId: asset.id,
        ...(retainedSourceIds.length ? { sourceIds: retainedSourceIds } : {}),
        ...(transition ? { transitionFromPrevious: transition } : {}),
        ...(submitted.speakerNotes ? { speakerNotes: submitted.speakerNotes } : {}),
        talkingPoints: submitted.talkingPoints,
      };
    });

    const normalizedInput: PublishedDeckInput = {
      ...input,
      slides,
      sources,
    };

    if (repositoryRoot && observedRepositorySources.size === 0) {
      throw new Error("A repository-grounded deck must inspect source before it can be published.");
    }
    await onProgress({ phase: "validating", message: "Checking the final slide-to-image mapping." });
    const referencedAssets = validateDeck(
      normalizedInput,
      fontCatalog,
      assets,
      inferredSlideCount,
      { repositoryPath: repositoryRoot, attachmentIds },
    );
    await onProgress({ phase: "publishing", message: "Publishing the presentation." });
    const now = new Date().toISOString();
    const measuredAssets: DeckAsset[] = [];
    for (const asset of referencedAssets) {
      let dimensions = { width: asset.width ?? DEFAULT_CANVAS.width, height: asset.height ?? DEFAULT_CANVAS.height };
      try {
        dimensions = await imageDimensions(path.join(outputDirectory, path.basename(asset.url)));
      } catch {
        // Keep the declared canvas.
      }
      measuredAssets.push({ ...asset, width: dimensions.width, height: dimensions.height });
    }
    const publishedSlides: Slide[] = normalizedInput.slides.map((slide) => {
      const asset = measuredAssets.find((candidate) => candidate.id === slide.assetId) as DeckAsset;
      return {
        id: slide.id,
        title: slide.title,
        purpose: slide.purpose,
        copy: slide.copy,
        assetId: slide.assetId,
        canvas: { width: asset.width ?? DEFAULT_CANVAS.width, height: asset.height ?? DEFAULT_CANVAS.height },
        state: "generated",
        recovery: { status: "pending", updatedAt: now },
        version: 1,
        history: [{ version: 1, assetId: slide.assetId, reason: "generated", createdAt: now }],
        ...(slide.sourceIds?.length ? { sourceIds: slide.sourceIds } : {}),
        ...(slide.transitionFromPrevious ? { transitionFromPrevious: slide.transitionFromPrevious } : {}),
        ...(slide.speakerNotes ? { speakerNotes: slide.speakerNotes } : {}),
        talkingPoints: slide.talkingPoints,
      };
    });
    let draftDeck: Deck = deckSchema.parse({
      schemaVersion: 4,
      id: deckId,
      title: normalizedInput.title,
      brief: {
        prompt: request.prompt,
        attachments,
        inferred: {
          ...(inferredAudience ? { audience: inferredAudience } : {}),
          ...(inferredSlideCount ? { requestedSlideCount: inferredSlideCount } : {}),
        },
      },
      designSystem: normalizedInput.designSystem,
      slides: publishedSlides,
      assets: measuredAssets,
      fonts: [],
      ...(sources.length ? { sources } : {}),
      createdAt: now,
      updatedAt: now,
      revision: 0,
    } satisfies Deck);
    const attachedAssetIds: string[] = [];
    for (const record of await store.listAssetRecoveries(deckId)) {
      const slide = draftDeck.slides.find((candidate) => candidate.assetId === record.assetId);
      if (!slide) continue;
      draftDeck = attachRecord(draftDeck, slide.id, record);
      attachedAssetIds.push(record.assetId);
    }
    publishedDeck = draftDeck;
    await store.saveAssets(deckId, measuredAssets);
    await store.save(publishedDeck);
    for (const assetId of attachedAssetIds) await store.deleteAssetRecovery(deckId, assetId);
    return publishedDeck;
  }

  async function announceAsset(asset: DeckAsset, slideId: string, copy: SlideCopyItem[]) {
    if (!onAssetReady || !plannedDesign) return;
    try {
      await onAssetReady({
        deckId,
        slideId,
        asset,
        canvas: { width: asset.width ?? DEFAULT_CANVAS.width, height: asset.height ?? DEFAULT_CANVAS.height },
        copy,
        typography: plannedDesign.typography,
        colors: plannedDesign.colors,
      });
    } catch (error) {
      console.error(`Could not start text recovery for slide ${slideId}:`, error);
    }
  }

  function signalAnchorReady(asset: DeckAsset) {
    if (asset.slideNumber === 1) firstSlideReady.resolve(asset);
    if (asset.slideNumber === 2) secondSlideReady.resolve(asset);
  }

  function signalAnchorFailure(slideNumber: number, error: unknown) {
    if (slideNumber === 1) firstSlideReady.reject(error);
    if (slideNumber === 2) secondSlideReady.reject(error);
  }

  async function styleReferencesFor(slideNumber: number) {
    if (slideNumber === 1) return [];
    if (slideNumber === 2) return [await firstSlideReady.promise];
    return Promise.all([firstSlideReady.promise, secondSlideReady.promise]);
  }

  function assetFilePath(asset: DeckAsset) {
    const fileName = path.basename(asset.url);
    if (!fileName) throw new Error(`Style-reference asset ${asset.id} has no file name.`);
    return path.join(outputDirectory, fileName);
  }

  async function requestSlideImage(prompt: string, styleReferences: DeckAsset[]) {
    const completePrompt = fullSlidePrompt(prompt, styleReferences.length);
    return runImageGeneration(() => retryTransientCall(async () => {
      throwIfAborted(signal);
      if (styleReferences.length === 0) {
        return openai.images.generate({
          ...SLIDE_IMAGE_SETTINGS,
          prompt: completePrompt,
          size: "1536x864",
          output_format: "png",
        }, { signal });
      }

      const referenceImages = await Promise.all(styleReferences.map(async (asset) => {
        throwIfAborted(signal);
        const referencePath = assetFilePath(asset);
        return toFile(createReadStream(referencePath), path.basename(referencePath), { type: "image/png" });
      }));
      throwIfAborted(signal);
      return openai.images.edit({
        ...SLIDE_IMAGE_SETTINGS,
        image: referenceImages,
        prompt: completePrompt,
        size: "1536x864",
        output_format: "png",
      }, { signal });
    }, signal));
  }

  async function generateSlide(
    slideNumber: number,
    slideId: string,
    prompt: string,
    copy: SlideCopyItem[],
    alt: string,
  ) {
    try {
      throwIfAborted(signal);
      const productionPrompt = appendRoleLabeledCopyBlock(prompt, copy);
      const plannedSlide = readyNarrativePlan?.slides?.find((slide) => slide.slideNumber === slideNumber);
      if (!readyNarrativePlan || !plannedSlide) {
        throw new Error("Report a complete ready_to_render narrative plan before generating slide images.");
      }
      if (plannedSlide.slideId !== slideId) {
        throw new Error(`Slide number ${slideNumber} must use planned slide ID ${plannedSlide.slideId}.`);
      }

      const existingForNumber = assetBySlideNumber.get(slideNumber);
      const existing = assetBySlideId.get(slideId);
      if (existingForNumber && existingForNumber.slideId !== slideId) {
        throw new Error(`Slide number ${slideNumber} already belongs to ${existingForNumber.slideId}.`);
      }
      if (existing) {
        if (existing.slideNumber !== undefined && existing.slideNumber !== slideNumber) {
          throw new Error(`Slide ${slideId} was already generated as slide number ${existing.slideNumber}.`);
        }
        if (existing.copy?.length && !slideCopyMatches(existing.copy, copy)) {
          throw new Error(`Slide ${slideId} was already generated with different role-labelled copy.`);
        }
        let assetMetadataChanged = false;
        if (!existing.copy?.length) {
          existing.copy = copy;
          assetMetadataChanged = true;
        }
        if (!existing.prompt.includes(formatRoleLabeledCopyBlock(copy))) {
          existing.prompt = appendRoleLabeledCopyBlock(existing.prompt, copy);
          assetMetadataChanged = true;
        }
        if (existing.slideNumber === undefined) {
          existing.slideNumber = slideNumber;
          assetBySlideNumber.set(slideNumber, existing);
          assetMetadataChanged = true;
        }
        if (assetMetadataChanged) await saveAssets();
        signalAnchorReady(existing);
        await announceAsset(existing, slideId, copy);
        await onProgress({
          slideUpdate: {
            slideNumber,
            slideId,
            status: "completed",
            styleReferenceCount: Math.min(Math.max(slideNumber - 1, 0), STYLE_ANCHOR_SLIDES),
            assetUrl: existing.url,
          },
        });
        return JSON.stringify({
          assetId: existing.id,
          slideId,
          slideNumber,
          styleReferenceCount: Math.min(Math.max(slideNumber - 1, 0), STYLE_ANCHOR_SLIDES),
          reused: true,
        });
      }

      const expectedStyleReferenceCount = Math.min(Math.max(slideNumber - 1, 0), STYLE_ANCHOR_SLIDES);
      await onProgress({
        phase: "generating_image",
        message: slideNumber === 1
          ? "Generating slide 1 as the first visual style anchor."
          : `Slide ${slideNumber} is waiting for ${expectedStyleReferenceCount === 1 ? "its style anchor" : "both style anchors"}.`,
        slideUpdate: {
          slideNumber,
          slideId,
          status: slideNumber === 1 ? "generating" : "waiting",
          styleReferenceCount: expectedStyleReferenceCount,
        },
      });
      const styleReferences = await styleReferencesFor(slideNumber);
      throwIfAborted(signal);

      await onProgress({
        phase: "generating_image",
        message: styleReferences.length === 0
          ? `Generating slide ${slideNumber} as the first visual style anchor.`
          : `Generating slide ${slideNumber} with ${styleReferences.length} earlier slide style ${styleReferences.length === 1 ? "reference" : "references"}.`,
        slideUpdate: {
          slideNumber,
          slideId,
          status: "generating",
          styleReferenceCount: styleReferences.length,
        },
      });

      const assetId = randomUUID();
      const fileName = `${assetId}.png`;
      const response = await requestSlideImage(productionPrompt, styleReferences);
      throwIfAborted(signal);
      const encoded = response.data?.[0]?.b64_json;
      if (!encoded) throw new Error(`Image generation returned no data for slide ${slideId}.`);

      await writeFile(path.join(outputDirectory, fileName), Buffer.from(encoded, "base64"));
      let dimensions = { width: DEFAULT_CANVAS.width, height: DEFAULT_CANVAS.height };
      try {
        dimensions = await imageDimensions(path.join(outputDirectory, fileName));
      } catch {
        // Keep the default canvas.
      }
      const asset: DeckAsset = {
        id: assetId,
        kind: "slide-image",
        slideNumber,
        slideId,
        url: `/api/assets/${deckId}/${fileName}`,
        prompt: productionPrompt,
        copy,
        alt,
        width: dimensions.width,
        height: dimensions.height,
      };
      assets.set(assetId, asset);
      assetBySlideId.set(slideId, asset);
      assetBySlideNumber.set(slideNumber, asset);
      await saveAssets();
      signalAnchorReady(asset);
      await announceAsset(asset, slideId, copy);
      await onProgress({
        phase: "reasoning",
        message: `Slide ${slideNumber} is rendered. Continuing the image-native deck.`,
        imagesGenerated: assets.size,
        slideUpdate: {
          slideNumber,
          slideId,
          status: "completed",
          styleReferenceCount: styleReferences.length,
          assetUrl: asset.url,
        },
      });
      return JSON.stringify({
        assetId,
        slideId,
        slideNumber,
        styleReferenceCount: styleReferences.length,
        reused: false,
      });
    } catch (error) {
      signalAnchorFailure(slideNumber, error);
      await onProgress({
        slideUpdate: {
          slideNumber,
          slideId,
          status: signal?.aborted ? "cancelled" : "failed",
          styleReferenceCount: Math.min(Math.max(slideNumber - 1, 0), STYLE_ANCHOR_SLIDES),
          error: signal?.aborted
            ? "Stopped by the user."
            : error instanceof Error ? error.message : "Slide generation failed.",
        },
      });
      throw error;
    }
  }

  const narrativeSlidePlanSchema = z.object({
    slideNumber: z.number().int().positive().max(60),
    slideId: z.string().min(1),
    title: z.string().min(1),
    purpose: z.string().min(1),
    transitionFromPrevious: z.string().min(1).optional(),
  });

  const reportNarrativeProgress = tool({
    name: "report_narrative_progress",
    description: "Publish a concise, user-visible authoring update. Use this for decisions, narrative structure, evidence needs, and art direction—not private chain-of-thought. A complete ready_to_render update is required before image generation.",
    parameters: z.object({
      stage: z.enum(["framing", "research_update", "storyboard", "art_direction", "ready_to_render"]),
      summary: z.string().min(1).describe("Concise account of what was decided or changed and why it matters to the deck."),
      thesis: z.string().min(1).optional(),
      audienceTakeaway: z.string().min(1).optional(),
      designDirection: z.string().min(1).optional(),
      audience: z.string().min(1).optional().describe("Framing only: the audience inferred from the prompt, as a short phrase."),
      requestedSlideCount: z.number().int().positive().max(60).optional().describe("Framing only: the slide count the user explicitly wrote in the prompt. Omit when the prompt states no number; do not estimate."),
      title: z.string().min(1).optional().describe("Working deck title, from the storyboard onward."),
      typography: z.object({
        display: z.string().min(1),
        heading: z.string().min(1),
        body: z.string().min(1),
        label: z.string().min(1),
      }).optional().describe("Catalog font id for each role. Required from the art_direction update onward; text recovery uses these the moment each slide is painted."),
      colors: z.object({
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        text: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        mutedText: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accentText: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        border: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }).optional().describe("The deck palette as seven six-digit hex values. Required from the art_direction update onward."),
      slides: z.array(narrativeSlidePlanSchema).min(1).max(60).optional(),
    }),
    async execute(rawUpdate) {
      let acceptedReadyPlan: NarrativeUpdate | undefined;
      const update = { ...rawUpdate };
      const notes: string[] = [];
      if (update.stage === "framing") {
        if (update.audience) inferredAudience = update.audience;
        if (update.requestedSlideCount !== undefined) {
          if (explicitSlideCount === undefined) {
            notes.push("requestedSlideCount ignored: the prompt states no explicit slide count, so decide the count in the storyboard after reading the material.");
            delete update.requestedSlideCount;
          } else if (update.requestedSlideCount !== explicitSlideCount) {
            notes.push(`requestedSlideCount corrected to ${explicitSlideCount}, the number written in the prompt.`);
            update.requestedSlideCount = explicitSlideCount;
          }
        }
      }
      if (update.typography) {
        const missing = FONT_ROLE_NAMES.filter((role) => !catalogFontIds.has(update.typography?.[role] ?? ""));
        if (missing.length) throw new Error(`Typography references font ids that are not in availableFonts for roles: ${missing.join(", ")}.`);
      }
      if (update.stage === "ready_to_render" && (!update.typography || !update.colors)) {
        throw new Error("ready_to_render progress requires the final typography (catalog font ids per role) and colors (seven hex values).");
      }
      if (update.typography && update.colors) plannedDesign = { typography: update.typography, colors: update.colors };
      if (["storyboard", "ready_to_render"].includes(update.stage) && !update.slides?.length) {
        throw new Error(`${update.stage} progress requires the ordered slide plan.`);
      }
      if (update.slides) {
        const slideIds = new Set<string>();
        update.slides.forEach((slide, index) => {
          if (slide.slideNumber !== index + 1) {
            throw new Error("Narrative slide numbers must be consecutive and start at 1.");
          }
          if (slideIds.has(slide.slideId)) throw new Error(`Duplicate narrative slide ID ${slide.slideId}.`);
          slideIds.add(slide.slideId);
        });
      }
      if (update.stage === "ready_to_render") {
        if (!update.thesis || !update.audienceTakeaway || !update.designDirection || !update.slides) {
          throw new Error("ready_to_render progress requires thesis, audienceTakeaway, designDirection, and the complete slide plan.");
        }
        if (inferredSlideCount !== undefined && update.slides.length !== inferredSlideCount) {
          throw new Error(`The brief asked for exactly ${inferredSlideCount} slides; plan exactly that many.`);
        }
        acceptedReadyPlan = {
          ...update,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
        };
      }

      await onProgress({
        phase: "reasoning",
        message: update.stage === "ready_to_render"
          ? `Narrative locked with ${update.slides?.length ?? 0} slides. Starting visual production.`
          : `Authoring update: ${update.stage.replaceAll("_", " ")}.`,
        ...(update.title ? { title: update.title } : {}),
        narrativeUpdate: update,
      });
      if (acceptedReadyPlan) readyNarrativePlan = acceptedReadyPlan;
      return JSON.stringify({ recorded: true, stage: update.stage, slides: update.slides?.length ?? 0, ...(notes.length ? { notes } : {}) });
    },
  });

  const generateSlideImage = tool({
    name: "generate_slide_image",
    description: "Generate the complete raster image for one presentation slide from the accepted ready_to_render narrative plan. Every slide must be created with this tool exactly once before publication.",
    parameters: z.object({
      slideNumber: z.number().int().positive().max(60).describe("One-based position in the final deck. Generate 1 first, then 2, then issue all remaining slide numbers as parallel calls."),
      slideId: z.string().min(1).describe("Stable identifier that will be used for this same slide in publish_deck."),
      copy: slideCopySchema.describe("Every exact reader-visible string in reading order. Each item must have a specific production role label. Do not put role labels inside text."),
      prompt: z.string().min(1).describe("Self-contained, content-first production specification for the complete slide: intended change in understanding, exact propositions and evidence, explanatory relationships, composition and hierarchy, approved fonts and palette, content-derived image treatment, continuity, and explicit omissions. Refer to copy items by role when explaining placement or hierarchy, but do not duplicate the visible-copy list; the service appends it canonically."),
      alt: z.string().min(1).describe("Concise accessible description that states the slide's substantive claim and important visual relationship."),
    }),
    async execute({ slideNumber, slideId, copy, prompt, alt }) {
      const pending = pendingBySlideId.get(slideId);
      if (pending) {
        if (pending.slideNumber !== slideNumber) {
          throw new Error(`Slide ${slideId} is already pending as slide number ${pending.slideNumber}.`);
        }
        return pending.promise;
      }

      const pendingSlideId = pendingSlideIdByNumber.get(slideNumber);
      if (pendingSlideId && pendingSlideId !== slideId) {
        throw new Error(`Slide number ${slideNumber} is already pending for ${pendingSlideId}.`);
      }

      const task = generateSlide(slideNumber, slideId, prompt, copy, alt);
      pendingBySlideId.set(slideId, { slideNumber, promise: task });
      pendingSlideIdByNumber.set(slideNumber, slideId);
      try {
        return await task;
      } finally {
        pendingBySlideId.delete(slideId);
        if (pendingSlideIdByNumber.get(slideNumber) === slideId) {
          pendingSlideIdByNumber.delete(slideNumber);
        }
      }
    },
  });

  const publishDeck = tool({
    name: "publish_deck",
    description: "Publish the completed image-native narrative exactly once after every substantive slide has its own generated full-slide image. The server normalizes soft metadata and preserves the accepted plan and generated assets; do not call this tool more than once.",
    parameters: publishDeckToolSchema,
    isEnabled: () => !publishedDeck && publicationAttempts < MAX_PUBLICATION_ATTEMPTS,
    async execute(input) {
      publicationAttempts += 1;
      try {
        const deck = await finalizeDeck(normalizePublishedDeckDraft(input));
        return JSON.stringify({ published: true, deckId, slideImages: deck.assets.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (publicationAttempts >= MAX_PUBLICATION_ATTEMPTS) throw new Error(`Publication failed: ${message}`);
        return JSON.stringify({
          published: false,
          error: message,
          instruction: "Correct the publication payload and call publish_deck once more. Keep the same slide ids in plan order and the exact copy used for each generated image. This is the last attempt.",
        });
      }
    },
  });

  const repositoryTools = repositoryReader
    ? createRepositoryTools({
        reader: repositoryReader,
        onActivity: async (message) => {
          await onProgress({
            phase: "inspecting_repository",
            message,
            resumable: true,
            sourceActivity: { kind: "repository", label: repositoryActivityLabel(message) },
          });
        },
        onSource: async (source) => {
          observedRepositorySources.set(source.id, source);
        },
      })
    : [];
  const attachmentTools = library.files.length || library.links.length
    ? createAttachmentTools({
        library,
        signal,
        onActivity: async (message, kind) => {
          await onProgress({
            phase: "reading_attachments",
            message,
            resumable: true,
            sourceActivity: { kind, label: message.replace(/^(Reading|Opening)\s*/, "").replace(/\.$/, "") },
          });
        },
        onSource: async (source) => {
          observedFileAndLinkSources.set(source.id, source);
        },
      })
    : [];

  if (
    resume
    && serializedResumeState
    && readyNarrativePlan?.slides?.every((slide) => assetBySlideId.has(slide.slideId))
  ) {
    const drafts = publishDeckDraftsFromRunState(serializedResumeState);
    for (const draft of drafts.reverse()) {
      const parsed = publishDeckToolSchema.safeParse(draft);
      if (!parsed.success || parsed.data.slides.length !== readyNarrativePlan.slides.length) continue;
      const normalized = normalizePublishedDeckDraft(parsed.data);
      const matchesPlan = normalized.slides.every((slide, index) => {
        const planned = readyNarrativePlan?.slides?.[index];
        return planned && slide.id === planned.slideId;
      });
      if (!matchesPlan) continue;
      await onProgress({
        phase: "recovering",
        message: "All slide images are complete. Finalizing once from the saved publication draft.",
      });
      return finalizeDeck(normalized);
    }
  }

  const agent = new Agent({
    name: "Image-native presentation author and art director",
    instructions: repositoryRoot
      ? `${PRESENTATION_AUTHOR_SYSTEM_PROMPT}\n\n${CODEBASE_PRESENTATION_GUIDANCE}`
      : PRESENTATION_AUTHOR_SYSTEM_PROMPT,
    model: "gpt-5.6-sol",
    modelSettings: {
      reasoning: { effort: "xhigh", summary: "auto" },
      parallelToolCalls: true,
      retry: { maxRetries: 0 },
    },
    tools: [
      webSearchTool({ searchContextSize: "medium" }),
      ...attachmentTools,
      ...repositoryTools,
      reportNarrativeProgress,
      generateSlideImage,
      publishDeck,
    ],
  });

  const attachmentManifest = await library.manifest();
  const authoringRequest = {
    prompt: request.prompt,
    attachments: attachmentManifest,
    slideCount: explicitSlideCount !== undefined
      ? { requested: explicitSlideCount, rule: "The prompt states this number. Plan and publish exactly this many slides." }
      : { requested: null, rule: "The prompt states no number. Do not settle on a count in framing; decide it in the storyboard after reading the material, and change it if the story needs more or fewer slides." },
    outputContract: "Author a specific, evidence-aware linear explanation and generate every slide as one complete image with generate_slide_image before publish_deck can succeed. Infer audience, purpose, tone, and slide count from the prompt; report them in the framing update.",
    researchCapability: "During narrative planning, hosted web search is available if online research into a concept, current fact, or external evidence is needed. Attached files are read with read_attachment and links with open_link. These are optional capabilities within planning, not separate stages.",
    ...(repositoryRoot ? {
      repository: {
        path: repositoryRoot,
        access: "Read-only repository listing, source search, and exact line-range reading are available through the repository tools.",
        grounding: "Claims about this implementation must be grounded in repository source references with relative paths and inclusive line ranges.",
      },
    } : {}),
    availableFonts: fontCatalogForPrompt(fontCatalog),
  };

  const continuationInstruction = [
    "Continue and finish the same image-native deck; the previous run ended before publication.",
    "The underlying rendering transport has been restored, so retry the unfinished image work now.",
    "Do not regenerate completed slide images. Call generate_slide_image with each completed slide's exact prior slideNumber and slideId so the service can reuse its checkpointed asset.",
    "Follow the required anchor sequence for any unfinished images, publish the complete deck, and do not stop after merely describing an earlier error.",
  ].join(" ");

  let continuingFromHistory = false;
  let runInput: string | AgentInputItem[] | RunState<unknown, typeof agent>;
  // Read through a closure so control-flow narrowing on the loop's reassignments
  // cannot make the run result's type depend on itself.
  const currentRunInput = () => runInput;
  if (resume) {
    const serializedState = serializedResumeState ?? await store.loadRunState(deckId);
    const restoredState = await RunState.fromString(agent, serializedState);
    if (isTerminalRunStateCheckpoint(serializedState)) {
      runInput = [...restoredState.history, user(continuationInstruction)];
      continuingFromHistory = true;
    } else {
      runInput = restoredState;
    }
  } else {
    const imageInputs = await library.imageInputs();
    const initialContent: Parameters<typeof user>[0] = [
      { type: "input_text", text: `Author, render, and publish this image-native presentation deck:\n${JSON.stringify(authoringRequest, null, 2)}` },
      ...imageInputs.flatMap((image) => [
        { type: "input_text" as const, text: `Attached image ${image.attachment.id}: ${image.attachment.name}` },
        { type: "input_image" as const, image: image.dataUrl },
      ]),
    ];
    const initialMessage: AgentInputItem = user(initialContent);
    runInput = [initialMessage];
  }
  let automaticResumeAvailable = true;
  let attempt = initialAttempt;

  while (true) {
    attempt += 1;
    await onProgress({
      phase: "connecting",
      message: continuingFromHistory
        ? "Continuing from saved authoring history after an incomplete run."
        : resume || attempt > 1
          ? "Resuming from the latest image-generation checkpoint."
          : "Starting the image-native presentation author.",
      attempts: attempt,
    });

    const result = await runner.run(agent, currentRunInput(), { maxTurns: 80, stream: true, signal });
    const pendingWorkingNoteText = new Map<string, string>();
    const lastWorkingNoteUpdateAt = new Map<string, number>();
    try {
      for await (const event of result) {
        if (event.type === "raw_model_stream_event" && event.data.type === "response_started") {
          await store.saveRunState(deckId, result.state.toString());
          await onProgress({
            phase: "reasoning",
            message: "The author is planning the story and shared visual language.",
            turn: result.currentTurn,
            resumable: true,
          });
        }

        if (isOpenAIResponsesRawModelStreamEvent(event)) {
          const rawEvent = event.data.event;
          if (rawEvent.type === "response.reasoning_summary_text.delta") {
            const noteId = `${rawEvent.item_id}:${rawEvent.summary_index}`;
            const pendingText = `${pendingWorkingNoteText.get(noteId) ?? ""}${rawEvent.delta}`;
            pendingWorkingNoteText.set(noteId, pendingText);
            const now = Date.now();
            const lastUpdateAt = lastWorkingNoteUpdateAt.get(noteId) ?? 0;
            if (now - lastUpdateAt >= WORKING_NOTE_UPDATE_INTERVAL_MS) {
              pendingWorkingNoteText.set(noteId, "");
              lastWorkingNoteUpdateAt.set(noteId, now);
              await onProgress({
                phase: "reasoning",
                message: "The author is developing the narrative.",
                turn: result.currentTurn,
                resumable: true,
                workingNoteUpdate: {
                  id: noteId,
                  text: pendingText,
                  status: "streaming",
                  turn: result.currentTurn,
                  append: true,
                },
              });
            }
          } else if (rawEvent.type === "response.reasoning_summary_text.done") {
            const noteId = `${rawEvent.item_id}:${rawEvent.summary_index}`;
            pendingWorkingNoteText.delete(noteId);
            lastWorkingNoteUpdateAt.delete(noteId);
            await onProgress({
              phase: "reasoning",
              message: "The author is developing the narrative.",
              turn: result.currentTurn,
              resumable: true,
              workingNoteUpdate: {
                id: noteId,
                text: rawEvent.text,
                status: "complete",
                turn: result.currentTurn,
              },
            });
          }
        }

        if (event.type === "run_item_stream_event") {
          await store.saveRunState(deckId, result.state.toString());
          if (event.name === "reasoning_item_created") {
            await onProgress({
              phase: "reasoning",
              message: "The author is refining the narrative and slide-image prompts.",
              turn: result.currentTurn,
              resumable: true,
            });
          } else if (event.name === "tool_called") {
            const rawItem = event.item.rawItem;
            const isWebSearch = rawItem.type === "hosted_tool_call" && rawItem.name.startsWith("web_search");
            const isNarrativeReport = rawItem.type === "function_call" && rawItem.name === "report_narrative_progress";
            const isRepositoryInspection = rawItem.type === "function_call" && isRepositoryToolName(rawItem.name);
            const isAttachmentRead = rawItem.type === "function_call" && isAttachmentToolName(rawItem.name);
            if (isWebSearch) webResearchUsed = true;
            await onProgress({
              phase: isWebSearch ? "researching" : isRepositoryInspection ? "inspecting_repository" : isAttachmentRead ? "reading_attachments" : "reasoning",
              message: isWebSearch
                ? "Searching the web."
                : isRepositoryInspection
                  ? "Reading the codebase."
                : isAttachmentRead
                  ? "Reading attached material."
                : isNarrativeReport
                  ? "Recording a decision."
                : "Painting slides.",
              turn: result.currentTurn,
              resumable: true,
              ...(isWebSearch ? { sourceActivity: { kind: "web" as const, label: "Web search" } } : {}),
            });
          } else if (event.name === "tool_output") {
            const rawItem = event.item.rawItem;
            const isNarrativeReport = rawItem.type === "function_call_result" && rawItem.name === "report_narrative_progress";
            const isRepositoryInspection = rawItem.type === "function_call_result" && isRepositoryToolName(rawItem.name);
            await onProgress({
              phase: isRepositoryInspection ? "inspecting_repository" : "reasoning",
              message: isNarrativeReport
                ? "Narrative update recorded. Continuing the authoring process."
                : isRepositoryInspection
                  ? "Repository evidence recorded. Continuing the narrative."
                : "Slide-image work completed. Continuing from the saved checkpoint.",
              turn: result.currentTurn,
              resumable: true,
            });
          }
        }
      }
      await result.completed;
      await store.saveRunState(deckId, result.state.toString());
      break;
    } catch (error) {
      await store.saveRunState(deckId, result.state.toString());
      await onProgress({ resumable: true, turn: result.currentTurn });
      if (publishedDeck) break;
      if (!continuingFromHistory && isTerminalStateResumeError(error)) {
        continuingFromHistory = true;
        runInput = [...result.state.history, user(continuationInstruction)];
        await onProgress({
          phase: "recovering",
          message: "The saved run had already ended. Continuing safely from its persisted history.",
        });
        continue;
      }
      if (automaticResumeAvailable && isTransientCallError(error)) {
        automaticResumeAvailable = false;
        runInput = result.state;
        await onProgress({
          phase: "recovering",
          message: "The connection was interrupted. Resuming once from the latest image-generation checkpoint.",
        });
        continue;
      }
      throw error;
    }
  }

  if (!publishedDeck) throw new Error("The authoring run ended without publishing a complete image-native deck.");
  return publishedDeck;
}
