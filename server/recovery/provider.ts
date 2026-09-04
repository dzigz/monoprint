// The recovery contract: image in, editable layers out.
//
// Any engine that can turn a slide raster into a background plate plus
// editable objects plugs in here. Text is the only object kind today; the
// contract already carries a list of objects so images, shapes, and charts
// can join without changing the host.

import type {
  CanvasSize,
  DeckColors,
  DeckFont,
  FontRoleName,
  SlideCopyItem,
  SlideObject,
} from "../../src/shared/types.js";

export type RecoveryFontInput = {
  role: FontRoleName;
  catalogId: string;
  family: string;
  subfamily: string;
  /** Names the pipeline's font census indexes by, when they differ from the catalog names. */
  censusFamily?: string;
  censusSubfamily?: string;
  weight: number;
  style: "normal" | "italic";
  path: string;
  faceIndex: number;
};

export type RecoveryInput = {
  deckId: string;
  slideId: string;
  assetId: string;
  canvas: CanvasSize;
  /** Absolute path of the raster to recover from (the slide's current version). */
  imagePath: string;
  copy: SlideCopyItem[];
  colors: DeckColors;
  fonts: RecoveryFontInput[];
  /** Directory the provider may write plate images and font files into. */
  outputDirectory: string;
  /** Run the pipeline again even when a finished run for this image exists. */
  fresh?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => Promise<void> | void;
};

export type RecoveryResult = {
  /** Absolute path of the plate image (slide with recovered text removed). */
  platePath: string;
  objects: SlideObject[];
  /** Fonts the objects reference that are not catalog role fonts. */
  fonts: DeckFont[];
  provider: string;
  providerRef?: string;
  diagnostics?: Record<string, unknown>;
};

export interface SlideRecoveryProvider {
  readonly name: string;
  /** Cheap availability probe for the config endpoint and the queue. */
  health(): Promise<{ available: boolean; detail?: string }>;
  recover(input: RecoveryInput): Promise<RecoveryResult>;
}
