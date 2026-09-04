import { z } from "zod";
import type {
  Attachment,
  Deck,
  DeckAsset,
  FontCatalogEntry,
  PresentationBrief,
  Slide,
} from "./types.js";
import { formatRoleLabeledCopyBlock, slideCopyMatches } from "./slideCopy.js";
import { slideObjectSchema } from "./commands.js";

export const DEFAULT_CANVAS = { width: 1536, height: 864 };

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color.");
// Tool schemas reach the OpenAI API, which rejects JSON Schema "format" keywords
// such as the one z.url() emits, so URLs are validated with a refinement instead.
export const httpUrl = z.string().min(1).max(2000).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "Use a complete http or https URL.");
const optionalNonEmptyString = z.string().min(1).optional();
const optionalSourceIds = z.array(z.string().min(1)).max(20).optional();
const optionalSlideCount = z.number().int().positive().max(60).optional();
const fontRoleNameSchema = z.enum(["display", "heading", "body", "label"]);

const fontRoleSchema = z.object({
  fontId: z.string().min(1),
  family: z.string().min(1),
  weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]),
  letterSpacing: z.number().finite().describe("Tracking value chosen by the art director. Units are descriptive metadata, so publication does not constrain the numeric scale."),
});

export const slideCopyItemSchema = z.object({
  role: z.string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\r\n]+$/, "A copy role must be a concise single-line label.")
    .describe("Production-only semantic role for this exact text element, such as Headline, Subhead, Evidence qualifier, Axis label, or Step 2 caption. The role is not reader-visible copy."),
  text: z.string()
    .trim()
    .min(1)
    .max(2000)
    .describe("Exact reader-visible text to render for this role, without surrounding quotation marks."),
  fontRole: fontRoleNameSchema
    .describe("Which design-system font role this text is set in: display, heading, body, or label. Required so the text can be recovered as editable type in the right face."),
}).strict();

export const slideCopySchema = z.array(slideCopyItemSchema)
  .min(1)
  .max(120)
  .describe("Every reader-visible text element on the slide, each paired with an explicit production role label and font role, listed in reading order.");

export const designSystemSchema = z.object({
  name: z.string().min(1),
  creativeDirection: z.string().min(1),
  rationale: z.string().min(1),
  typography: z.object({
    relationship: z.enum(["single-family", "family-variants", "paired-families"]),
    rationale: z.string().min(1),
    display: fontRoleSchema,
    heading: fontRoleSchema,
    body: fontRoleSchema,
    label: fontRoleSchema,
  }),
  colors: z.object({
    background: color,
    surface: color,
    text: color,
    mutedText: color,
    accent: color,
    accentText: color,
    border: color,
  }),
  imageTreatment: z.string().min(1),
  principles: z.array(z.string().min(1)).min(1).max(8),
});

const publishedSlideSchema = z.object({
  id: z.string().min(1).describe("Stable concise slide identifier."),
  title: z.string().min(1).describe("Descriptive or conclusion-led title, never merely a slide number or generic topic label."),
  purpose: z.string().min(1).describe("Concrete learning delta: what the audience understands after this slide that it could not reliably understand before."),
  copy: slideCopySchema,
  assetId: z.string().min(1).describe("Asset identifier returned by generate_slide_image for this exact slide."),
  sourceIds: optionalSourceIds.describe("Only sources that materially support claims on this slide."),
  transitionFromPrevious: optionalNonEmptyString.describe("How this slide advances, deepens, qualifies, contrasts, tests, or applies the preceding understanding."),
  speakerNotes: z.string().optional().describe("Useful interpretation, evidence, qualifications, or delivery context that does not merely repeat visible copy."),
});

const webResearchSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: httpUrl,
  kind: z.literal("web"),
  publisher: optionalNonEmptyString,
});

const repositorySourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.literal("repository"),
  path: z.string().min(1).refine((value) => {
    const portable = value.replaceAll("\\", "/");
    return !portable.startsWith("/") && !portable.split("/").includes("..");
  }, "Repository source paths must stay relative to the selected root."),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine(({ startLine, endLine }) => endLine >= startLine, {
  message: "Repository source endLine must be greater than or equal to startLine.",
});

const fileSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.literal("file"),
  attachmentId: z.string().min(1),
  locator: optionalNonEmptyString,
});

const deckSourceSchema = z.discriminatedUnion("kind", [webResearchSourceSchema, repositorySourceSchema, fileSourceSchema]);

const attachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["file", "folder", "link"]),
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

const briefSchema = z.object({
  prompt: z.string().min(1),
  attachments: z.array(attachmentSchema).max(200),
  inferred: z.object({
    audience: z.string().min(1).optional(),
    requestedSlideCount: optionalSlideCount,
    purpose: z.string().min(1).optional(),
  }).optional(),
});

const deckAssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["slide-image", "slide-plate", "slide-export"]),
  slideNumber: z.number().int().positive().max(60).optional(),
  slideId: z.string().min(1),
  url: z.string().min(1),
  prompt: z.string(),
  copy: z.array(slideCopyItemSchema.partial({ fontRole: true })),
  alt: z.string(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

const deckFontSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  subfamily: z.string().min(1),
  weight: z.number().int().min(100).max(900),
  style: z.enum(["normal", "italic"]),
  url: z.string().min(1),
  source: z.enum(["catalog", "fitted"]),
  catalogId: z.string().optional(),
  localNames: z.array(z.string()).optional(),
  metrics: z.object({
    unitsPerEm: z.number().positive(),
    ascent: z.number(),
    descent: z.number(),
    lineGap: z.number(),
    capHeight: z.number().optional(),
    xHeight: z.number().optional(),
    spaceAdvance: z.number(),
    descenderDepth: z.number(),
  }).optional(),
  variants: z.object({
    bold: z.string().optional(),
    italic: z.string().optional(),
    boldItalic: z.string().optional(),
  }).optional(),
});

const recoveryStateSchema = z.object({
  status: z.enum(["pending", "queued", "running", "recovered", "failed", "skipped"]),
  message: z.string().optional(),
  error: z.string().optional(),
  provider: z.string().optional(),
  providerRef: z.string().optional(),
  updatedAt: z.string(),
});

const slideSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  copy: z.array(slideCopyItemSchema.partial({ fontRole: true })),
  assetId: z.string().min(1),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  state: z.enum(["generated", "recovered", "edited"]),
  layers: z.object({
    plateAssetId: z.string().min(1),
    objects: z.array(slideObjectSchema),
  }).optional(),
  recovery: recoveryStateSchema,
  version: z.number().int().positive(),
  history: z.array(z.object({
    version: z.number().int().positive(),
    assetId: z.string().min(1),
    reason: z.enum(["generated", "repainted", "baked"]),
    createdAt: z.string(),
  })),
  sourceIds: optionalSourceIds,
  transitionFromPrevious: optionalNonEmptyString,
  speakerNotes: z.string().optional(),
});

/** The author's publish_deck output (generation time). */
export const publishDeckSchema = z.object({
  title: z.string().min(1),
  designSystem: designSystemSchema,
  slides: z.array(publishedSlideSchema).min(1).max(60),
  sources: z.array(deckSourceSchema).max(200).optional(),
});

const publishDeckToolSlideSchema = publishedSlideSchema.extend({
  sourceIds: z.array(z.string().min(1)).max(20).nullable().optional(),
  transitionFromPrevious: z.string().min(1).nullable().optional(),
  speakerNotes: z.string().nullable().optional(),
});

const publishDeckToolWebSourceSchema = webResearchSourceSchema.extend({
  publisher: z.string().min(1).nullable().optional(),
});

const publishDeckToolSourceSchema = z.discriminatedUnion("kind", [
  publishDeckToolWebSourceSchema,
  repositorySourceSchema,
  fileSourceSchema.extend({ locator: z.string().min(1).nullable().optional() }),
]);

export const publishDeckToolSchema = publishDeckSchema.extend({
  slides: z.array(publishDeckToolSlideSchema).min(1).max(60),
  sources: z.array(publishDeckToolSourceSchema).max(200).nullable().optional(),
});

/** A stored deck document. */
export const deckSchema = z.object({
  schemaVersion: z.literal(4),
  id: z.string().min(1),
  title: z.string().min(1),
  brief: briefSchema,
  designSystem: designSystemSchema,
  slides: z.array(slideSchema).min(1).max(60),
  assets: z.array(deckAssetSchema).min(1),
  fonts: z.array(deckFontSchema),
  sources: z.array(deckSourceSchema).max(200).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative(),
});

export type PublishedDeckInput = z.infer<typeof publishDeckSchema>;
export type PublishedDeckDraftInput = z.infer<typeof publishDeckToolSchema>;

export function normalizePublishedDeckDraft(input: PublishedDeckDraftInput): PublishedDeckInput {
  return publishDeckSchema.parse({
    title: input.title,
    designSystem: input.designSystem,
    slides: input.slides.map((slide) => ({
      id: slide.id,
      title: slide.title,
      purpose: slide.purpose,
      copy: slide.copy,
      assetId: slide.assetId,
      ...(slide.sourceIds?.length ? { sourceIds: slide.sourceIds } : {}),
      ...(slide.transitionFromPrevious ? { transitionFromPrevious: slide.transitionFromPrevious } : {}),
      ...(slide.speakerNotes ? { speakerNotes: slide.speakerNotes } : {}),
    })),
    sources: input.sources?.map((source) => {
      if (source.kind === "web") {
        return {
          id: source.id,
          title: source.title,
          kind: source.kind,
          url: source.url,
          ...(source.publisher ? { publisher: source.publisher } : {}),
        };
      }
      if (source.kind === "file") {
        return {
          id: source.id,
          title: source.title,
          kind: source.kind,
          attachmentId: source.attachmentId,
          ...(source.locator ? { locator: source.locator } : {}),
        };
      }
      return source;
    }),
  });
}

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contain duplicate identifiers.`);
  }
}

/** Generation-time integrity check: the published plan must match the generated images exactly. */
export function validateDeck(
  input: PublishedDeckInput,
  fontCatalog: FontCatalogEntry[],
  assets: Map<string, DeckAsset>,
  expectedSlideCount?: number,
  options: { repositoryPath?: string; attachmentIds?: Set<string> } = {},
) {
  const fontIds = new Set(fontCatalog.map((font) => font.id));
  const typography = input.designSystem.typography;
  const selectedFonts = [typography.display, typography.heading, typography.body, typography.label];

  for (const role of selectedFonts) {
    if (!fontIds.has(role.fontId)) throw new Error(`Typography references unavailable font ${role.fontId}.`);
    const catalogEntry = fontCatalog.find((font) => font.id === role.fontId);
    if (catalogEntry?.family !== role.family) {
      throw new Error(`Typography family ${role.family} does not match font ${role.fontId}.`);
    }
  }

  if (expectedSlideCount !== undefined && input.slides.length !== expectedSlideCount) {
    throw new Error(`The brief requires exactly ${expectedSlideCount} slide images; received ${input.slides.length}.`);
  }

  assertUnique(input.slides.map((slide) => slide.id), "Slides");
  assertUnique(input.slides.map((slide) => slide.assetId), "Slide asset references");

  const sources = input.sources ?? [];
  assertUnique(sources.map((source) => source.id), "Sources");
  assertUnique(sources.map((source) => source.kind === "repository"
    ? `repository:${source.path}:${source.startLine}:${source.endLine}`
    : source.kind === "file"
      ? `file:${source.attachmentId}:${source.locator ?? ""}`
      : `web:${source.url}`), "Source locations");
  const repositorySources = sources.filter((source) => source.kind === "repository");
  if (options.repositoryPath && repositorySources.length === 0) {
    throw new Error("A repository-grounded deck must include repository source references.");
  }
  if (!options.repositoryPath && repositorySources.length > 0) {
    throw new Error("Repository sources require a repository in the presentation brief.");
  }
  for (const source of sources) {
    if (source.kind === "file" && options.attachmentIds && !options.attachmentIds.has(source.attachmentId)) {
      throw new Error(`Source ${source.id} references unknown attachment ${source.attachmentId}.`);
    }
  }
  const sourceIds = new Set(sources.map((source) => source.id));

  for (const [slideIndex, slide] of input.slides.entries()) {
    assertUnique(slide.sourceIds ?? [], `Sources for slide ${slide.id}`);
    for (const sourceId of slide.sourceIds ?? []) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`Slide ${slide.id} references unknown source ${sourceId}.`);
      }
    }
    const asset = assets.get(slide.assetId);
    if (!asset) throw new Error(`Slide ${slide.id} does not reference a generated slide image.`);
    if (asset.kind !== "slide-image" || asset.slideId !== slide.id) {
      throw new Error(`Slide ${slide.id} must reference its own full-slide generated image.`);
    }
    if (!slideCopyMatches(slide.copy, asset.copy)) {
      throw new Error(`Slide ${slide.id} copy must exactly match the role-labelled copy used to generate its image.`);
    }
    if (!asset.prompt.includes(formatRoleLabeledCopyBlock(slide.copy))) {
      throw new Error(`Slide ${slide.id} image prompt does not contain its canonical role-labelled copy block.`);
    }
    if (asset.slideNumber !== undefined && asset.slideNumber !== slideIndex + 1) {
      throw new Error(`Slide ${slide.id} must use the image generated for slide number ${slideIndex + 1}.`);
    }
  }

  return input.slides.map((slide) => assets.get(slide.assetId) as DeckAsset);
}

// ------------------------------------------------------------- migration

type LegacyBrief = {
  objective?: unknown;
  audience?: unknown;
  requestedSlideCount?: unknown;
  repositoryPath?: unknown;
  prompt?: unknown;
  attachments?: unknown;
  inferred?: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function migrateBrief(raw: unknown): PresentationBrief {
  const legacy = record(raw) as LegacyBrief;
  if (typeof legacy.prompt === "string" && Array.isArray(legacy.attachments)) {
    return briefSchema.parse(legacy);
  }
  const objective = typeof legacy.objective === "string" ? legacy.objective : "Untitled brief";
  const audience = typeof legacy.audience === "string" && legacy.audience.trim() ? legacy.audience.trim() : undefined;
  const requestedSlideCount = typeof legacy.requestedSlideCount === "number" ? legacy.requestedSlideCount : undefined;
  const repositoryPath = typeof legacy.repositoryPath === "string" && legacy.repositoryPath ? legacy.repositoryPath : undefined;
  const attachments: Attachment[] = repositoryPath
    ? [{ id: "legacy-repository", kind: "folder", name: repositoryPath.split("/").filter(Boolean).at(-1) ?? repositoryPath, path: repositoryPath }]
    : [];
  const promptLines = [objective];
  if (audience) promptLines.push(`Audience: ${audience}`);
  if (requestedSlideCount) promptLines.push(`${requestedSlideCount} slides.`);
  return {
    prompt: promptLines.join("\n"),
    attachments,
    inferred: {
      ...(audience ? { audience } : {}),
      ...(requestedSlideCount ? { requestedSlideCount } : {}),
    },
  };
}

export type AssetDimensions = Record<string, { width: number; height: number }>;

/**
 * Upgrade any stored deck document (schema 1–4) to schema 4. Older decks keep
 * their generated images as version 1 of every slide and start in the
 * "generated" state, ready for recovery.
 */
export function migrateDeck(raw: unknown, options: { assetDimensions?: AssetDimensions; createdAt?: string } = {}): Deck {
  const source = record(raw);
  if (source.schemaVersion === 4) return deckSchema.parse(source);

  const now = options.createdAt ?? new Date().toISOString();
  const assetsRaw = Array.isArray(source.assets) ? source.assets.map(record) : [];
  const assets: DeckAsset[] = assetsRaw.map((asset) => {
    const dimensions = options.assetDimensions?.[String(asset.id)];
    return {
      id: String(asset.id),
      kind: "slide-image",
      ...(typeof asset.slideNumber === "number" ? { slideNumber: asset.slideNumber } : {}),
      slideId: String(asset.slideId),
      url: String(asset.url),
      prompt: typeof asset.prompt === "string" ? asset.prompt : "",
      copy: Array.isArray(asset.copy) ? asset.copy.map(record).map((item) => ({ role: String(item.role), text: String(item.text) })) : [],
      alt: typeof asset.alt === "string" ? asset.alt : "",
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
    };
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const slidesRaw = Array.isArray(source.slides) ? source.slides.map(record) : [];
  const slides: Slide[] = slidesRaw.map((slide) => {
    const assetId = String(slide.assetId);
    const asset = assetById.get(assetId);
    const copy = Array.isArray(slide.copy)
      ? slide.copy.map(record).map((item) => ({ role: String(item.role), text: String(item.text) }))
      : asset?.copy ?? [];
    const canvas = asset?.width && asset?.height ? { width: asset.width, height: asset.height } : DEFAULT_CANVAS;
    return {
      id: String(slide.id),
      title: String(slide.title ?? "Untitled slide"),
      purpose: String(slide.purpose ?? ""),
      copy,
      assetId,
      canvas,
      state: "generated",
      recovery: { status: "pending", updatedAt: now },
      version: 1,
      history: [{ version: 1, assetId, reason: "generated", createdAt: now }],
      ...(Array.isArray(slide.sourceIds) && slide.sourceIds.length ? { sourceIds: slide.sourceIds.map(String) } : {}),
      ...(typeof slide.transitionFromPrevious === "string" && slide.transitionFromPrevious ? { transitionFromPrevious: slide.transitionFromPrevious } : {}),
      ...(typeof slide.speakerNotes === "string" && slide.speakerNotes ? { speakerNotes: slide.speakerNotes } : {}),
    };
  });
  const sourcesRaw = Array.isArray(source.sources) ? source.sources : undefined;
  const deck: Deck = {
    schemaVersion: 4,
    id: String(source.id),
    title: String(source.title ?? "Untitled deck"),
    brief: migrateBrief(source.brief),
    designSystem: designSystemSchema.parse(source.designSystem),
    slides,
    assets,
    fonts: [],
    ...(sourcesRaw ? { sources: z.array(deckSourceSchema).parse(sourcesRaw) } : {}),
    createdAt: now,
    updatedAt: now,
    revision: 0,
  };
  return deckSchema.parse(deck);
}
