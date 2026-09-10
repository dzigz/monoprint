// Monoprint shared types — schema version 4.
//
// A deck is the source of truth. Each slide starts as one generated image
// ("generated"). Recovery turns it into a background plate plus editable
// objects ("recovered"); any hand or prompt edit marks it "edited". The
// generated raster is kept as the slide's first version only.

export type FontCatalogEntry = {
  id: string;
  family: string;
  subfamily: string;
  sourceLabel: string;
  axes: string[];
};

export type FontRole = {
  fontId: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
  letterSpacing: number;
};

export type TypographySystem = {
  relationship: "single-family" | "family-variants" | "paired-families";
  rationale: string;
  display: FontRole;
  heading: FontRole;
  body: FontRole;
  label: FontRole;
};

export type FontRoleName = "display" | "heading" | "body" | "label";
export const FONT_ROLE_NAMES: FontRoleName[] = ["display", "heading", "body", "label"];

export type DeckColors = {
  background: string;
  surface: string;
  text: string;
  mutedText: string;
  accent: string;
  accentText: string;
  border: string;
};

export type ColorRoleName = keyof DeckColors;

export type DesignSystem = {
  name: string;
  creativeDirection: string;
  rationale: string;
  typography: TypographySystem;
  colors: DeckColors;
  imageTreatment: string;
  principles: string[];
};

// ---------------------------------------------------------------- sources

export type WebResearchSource = {
  id: string;
  title: string;
  url: string;
  kind: "web";
  publisher?: string;
};

export type RepositorySource = {
  id: string;
  title: string;
  kind: "repository";
  path: string;
  startLine: number;
  endLine: number;
};

export type FileSource = {
  id: string;
  title: string;
  kind: "file";
  attachmentId: string;
  locator?: string;
};

export type DeckSource = WebResearchSource | RepositorySource | FileSource;
export type ResearchSource = DeckSource;

// ------------------------------------------------------------------ brief

export type AttachmentKind = "file" | "folder" | "link";

export type Attachment = {
  id: string;
  kind: AttachmentKind;
  name: string;
  /** Server-side stored file path (files) or absolute directory path (folders). */
  path?: string;
  url?: string;
  mimeType?: string;
  size?: number;
};

export type PresentationBrief = {
  prompt: string;
  attachments: Attachment[];
  /** What the author understood from the prompt; reported in the framing update. */
  inferred?: {
    audience?: string;
    requestedSlideCount?: number;
    purpose?: string;
  };
};

// ------------------------------------------------------------------- copy

export type SlideCopyItem = {
  role: string;
  text: string;
  fontRole?: FontRoleName;
};

// ---------------------------------------------------------------- objects

export type Frame = { x: number; y: number; width: number; height: number };
export type CanvasSize = { width: number; height: number };
export type TextAlign = "left" | "center" | "right";

export type TextStyle = {
  fontRole: FontRoleName;
  /** Deck font override; when absent the role font from the design system applies. */
  fontId?: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing?: number;
  wordSpacing?: number;
  bold?: boolean;
  italic?: boolean;
  align: TextAlign;
  color: string;
  colorRole?: ColorRoleName;
  transform?: "none" | "uppercase";
};

export type ObjectOrigin = {
  kind: "recovered" | "user" | "agent";
  frame?: Frame;
  confidence?: number;
};

/** Exact baseline placements imported from the reconstruction renderer.
 * Coordinates are relative to the object frame, so moving a paragraph keeps
 * every word and mixed font run together. Content/reflow edits invalidate it.
 */
export type ResolvedText = {
  revision: string;
  words: Array<{
    id: number;
    text: string;
    fontId: string;
    em: number;
    baseline: [number, number];
    angle: number;
    color: string;
    line: string;
    scaleX: number;
  }>;
};

export type TextObject = {
  id: string;
  kind: "text";
  frame: Frame;
  text: string;
  style: TextStyle;
  resolved?: ResolvedText;
  copyRole?: string;
  locked?: boolean;
  origin: ObjectOrigin;
};

/** Future object kinds (images, shapes, charts) join this union. */
export type SlideObject = TextObject;
export type SlideObjectKind = SlideObject["kind"];

export type SlideLayers = {
  plateAssetId: string;
  objects: SlideObject[];
};

// ------------------------------------------------------------------ fonts

export type DeckFontVariants = {
  bold?: string;
  italic?: string;
  boldItalic?: string;
};

export type FontMetrics = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  capHeight?: number;
  xHeight?: number;
  spaceAdvance: number;
  descenderDepth: number;
};

export type DeckFont = {
  id: string;
  family: string;
  subfamily: string;
  weight: number;
  style: "normal" | "italic";
  url: string;
  source: "catalog" | "fitted";
  catalogId?: string;
  /** Names usable with CSS local() when the font is installed on this machine. */
  localNames?: string[];
  metrics?: FontMetrics;
  variants?: DeckFontVariants;
};

// ----------------------------------------------------------------- slides

export type RecoveryStatus = "pending" | "queued" | "running" | "recovered" | "failed" | "skipped";

export type RecoveryState = {
  status: RecoveryStatus;
  message?: string;
  error?: string;
  provider?: string;
  providerRef?: string;
  updatedAt: string;
};

export type SlideState = "generated" | "recovered" | "edited";

export type FocusRegion = { cueId: string; box: [number, number, number, number] };
export type SlideFocusRegions = {
  inputKey: string;
  status: "waiting_snapshot" | "queued" | "running" | "ready" | "failed";
  regions: FocusRegion[];
  updatedAt: string;
  model?: string;
  error?: string;
};

export type SlideVersion = {
  version: number;
  assetId: string;
  reason: "generated" | "repainted" | "baked";
  createdAt: string;
};

export type Slide = {
  id: string;
  title: string;
  purpose: string;
  copy: SlideCopyItem[];
  /** The slide's current raster: generated image, or the latest bake/repaint. */
  assetId: string;
  canvas: CanvasSize;
  state: SlideState;
  layers?: SlideLayers;
  recovery: RecoveryState;
  version: number;
  history: SlideVersion[];
  sourceIds?: string[];
  transitionFromPrevious?: string;
  speakerNotes?: string;
  /** Full spoken transcript in Markdown, with inline textual focus cues. */
  talkingPoints?: string;
  /** Server-owned, source-image pixel rectangles for talking-point cues. */
  focusRegions?: SlideFocusRegions;
};

export type DeckAssetKind = "slide-image" | "slide-plate" | "slide-export";

export type DeckAsset = {
  id: string;
  kind: DeckAssetKind;
  slideNumber?: number;
  slideId: string;
  url: string;
  prompt: string;
  copy: SlideCopyItem[];
  alt: string;
  width?: number;
  height?: number;
};

export type Deck = {
  schemaVersion: 4;
  id: string;
  title: string;
  brief: PresentationBrief;
  designSystem: DesignSystem;
  slides: Slide[];
  assets: DeckAsset[];
  fonts: DeckFont[];
  sources?: DeckSource[];
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export type DeckSummary = {
  id: string;
  title: string;
  slideCount: number;
  coverAssetUrl?: string;
  createdAt: string;
  updatedAt: string;
  status: "generating" | "ready" | "failed" | "interrupted";
  recoveredSlides: number;
};

// ------------------------------------------------------------- generation

export type GenerateDeckRequest = {
  prompt: string;
  attachments: Attachment[];
};

export type NarrativeStage = "framing" | "research_update" | "storyboard" | "art_direction" | "ready_to_render";

export type NarrativeSlidePlan = {
  slideNumber: number;
  slideId: string;
  title: string;
  purpose: string;
  transitionFromPrevious?: string;
};

/** Catalog font id per design-system role, reported by the author before painting. */
export type PlannedTypography = Record<FontRoleName, string>;

export type NarrativeUpdate = {
  id: string;
  stage: NarrativeStage;
  summary: string;
  thesis?: string;
  audienceTakeaway?: string;
  designDirection?: string;
  audience?: string;
  requestedSlideCount?: number;
  title?: string;
  typography?: PlannedTypography;
  colors?: DeckColors;
  slides?: NarrativeSlidePlan[];
  createdAt: string;
};

export type WorkingNoteStatus = "streaming" | "complete" | "interrupted";

export type WorkingNote = {
  id: string;
  text: string;
  status: WorkingNoteStatus;
  turn: number;
  createdAt: string;
  updatedAt: string;
};

export type SlideGenerationStatus = "waiting" | "generating" | "completed" | "failed" | "cancelled";

export type SlideGenerationProgress = {
  slideNumber: number;
  slideId: string;
  status: SlideGenerationStatus;
  styleReferenceCount: number;
  assetUrl?: string;
  error?: string;
  /** Text-recovery stage for this slide, once its image exists. */
  recovery?: RecoveryStatus;
  recoveryMessage?: string;
  updatedAt: string;
};

export type GenerationStatus = "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export type GenerationPhase =
  | "queued"
  | "connecting"
  | "inspecting_repository"
  | "reading_attachments"
  | "researching"
  | "reasoning"
  | "generating_image"
  | "validating"
  | "publishing"
  | "recovering"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export type SourceActivity = {
  id: string;
  kind: "web" | "repository" | "file" | "link";
  label: string;
  createdAt: string;
};

export type GenerationRecord = {
  id: string;
  deckId: string;
  request: GenerateDeckRequest;
  status: GenerationStatus;
  phase: GenerationPhase;
  message: string;
  attempts: number;
  turn: number;
  imagesGenerated: number;
  title?: string;
  narrativeUpdates?: NarrativeUpdate[];
  workingNotes?: WorkingNote[];
  slideProgress?: SlideGenerationProgress[];
  sourceActivity?: SourceActivity[];
  resumable: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
};

export type GenerationProgress = Partial<Pick<
  GenerationRecord,
  "phase" | "message" | "attempts" | "turn" | "imagesGenerated" | "resumable" | "title"
>> & {
  narrativeUpdate?: Omit<NarrativeUpdate, "id" | "createdAt">;
  workingNoteUpdate?: Pick<WorkingNote, "id" | "text" | "status" | "turn"> & { append?: boolean };
  slideUpdate?: Omit<SlideGenerationProgress, "updatedAt" | "recovery" | "recoveryMessage">;
  slideRecoveryUpdate?: { slideId: string; recovery: RecoveryStatus; recoveryMessage?: string };
  sourceActivity?: Omit<SourceActivity, "id" | "createdAt">;
};

// ------------------------------------------------ recovery before publish

/** Everything recovery needs for one painted slide before the deck document exists. */
export type AssetRecoveryInput = {
  deckId: string;
  slideId: string;
  asset: DeckAsset;
  canvas: CanvasSize;
  copy: SlideCopyItem[];
  typography: PlannedTypography;
  colors: DeckColors;
};

/** A finished recovery waiting to be attached to a slide at publication. */
export type AssetRecoveryRecord = {
  assetId: string;
  slideId: string;
  platePath: string;
  objects: SlideObject[];
  fonts: DeckFont[];
  provider: string;
  providerRef?: string;
  createdAt: string;
};

// --------------------------------------------------------------- recovery

export type RecoveryJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RecoveryJob = {
  id: string;
  deckId: string;
  slideIds: string[];
  status: RecoveryJobStatus;
  message: string;
  currentSlideId?: string;
  completedSlideIds: string[];
  failedSlideIds: string[];
  startedAt: string;
  updatedAt: string;
  error?: string;
};

// ------------------------------------------------------------ editing API

export type EditScope = "object" | "slide" | "deck";

export type EditRequest = {
  prompt: string;
  scope: EditScope;
  slideId?: string;
  objectId?: string;
  /** PNG data URLs of the slides as currently rendered, keyed by slide id. */
  snapshots?: Record<string, string>;
};

export type RepaintProposal = {
  slideId: string;
  instruction: string;
  reason: string;
};

export type EditResponse =
  | { kind: "applied"; deck: Deck; summary: string; commandCount: number }
  | { kind: "repaint"; proposal: RepaintProposal; summary: string }
  | { kind: "answer"; summary: string };

export type RepaintJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RepaintJob = {
  id: string;
  deckId: string;
  slideId: string;
  instruction: string;
  status: RepaintJobStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  error?: string;
};

// ----------------------------------------------------------------- config

export type AppConfig = {
  generationConfigured: boolean;
  fontCatalogSize: number;
  fontSourceLabel: string;
  openAIRequestTimeoutMs: number;
  recovery: {
    provider: string;
    available: boolean;
    detail?: string;
  };
  fontConsolidation: { available: boolean; detail?: string };
  pptxExport?: { available: boolean; detail?: string };
  platform: string;
};

export type FontConsolidationSummary = {
  slides: number;
  consolidated: number;
  alreadyUniform: number;
  preserved: number;
  skipped: number;
};

export type PptxExportReport = {
  slides: number;
  fonts: number;
  textBoxes: number;
  multilineBoxes: number;
  positionedWords: number;
};
