import * as fontkit from "fontkit";

export type FontEmbedding = {
  editable: boolean;
  fsType?: number;
  mode: "installable" | "editable" | "preview-print" | "restricted" | "bitmap-only" | "unknown";
  noSubsetting: boolean;
};

/** Same conservative outline-embedding policy as scripts/pptx-layout.py.
 * Read actual metadata; never change a font's embedding bits to make it pass.
 * Full fonts are embedded, so the no-subsetting flag is supported.
 */
export function editableEmbedding(fsType: number | undefined): FontEmbedding {
  const unknown: FontEmbedding = { editable: false, mode: "unknown", noSubsetting: false };
  if (fsType === undefined || !Number.isInteger(fsType) || fsType < 0 || fsType > 0xffff) return unknown;
  const base = { fsType, noSubsetting: Boolean(fsType & 0x100) };
  if (fsType & 0x200) return { ...base, editable: false, mode: "bitmap-only" };
  if (fsType & 8) return { ...base, editable: true, mode: "editable" };
  if (fsType & 4) return { ...base, editable: false, mode: "preview-print" };
  if (fsType & 2) return { ...base, editable: false, mode: "restricted" };
  return { ...base, editable: true, mode: "installable" };
}

export function fontEmbedding(font: fontkit.Font): FontEmbedding {
  // Fontkit decodes fsType into named booleans, not the numeric uint16.
  const flags = (font as unknown as { "OS/2"?: { fsType?: Record<string, boolean> } })["OS/2"]?.fsType;
  const bits = { noEmbedding: 2, viewOnly: 4, editable: 8, noSubsetting: 0x100, bitmapOnly: 0x200 };
  if (!flags || Object.keys(bits).some(key => typeof flags[key] !== "boolean")) return editableEmbedding(undefined);
  return editableEmbedding(Object.entries(bits).reduce((value, [name, bit]) => value | (flags[name] ? bit : 0), 0));
}

export function embeddingFromBytes(bytes: Buffer, faceIndex = 0): FontEmbedding {
  const opened = fontkit.create(bytes);
  const font = ("fonts" in opened ? opened.fonts[faceIndex] : faceIndex === 0 ? opened : undefined) as fontkit.Font | undefined;
  return font ? fontEmbedding(font) : editableEmbedding(undefined);
}

export function embeddingReason(embedding: FontEmbedding) {
  switch (embedding.mode) {
    case "preview-print": return "preview/print embedding only";
    case "restricted": return "restricted embedding";
    case "bitmap-only": return "bitmap embedding only";
    case "unknown": return "embedding permissions could not be verified";
    default: return `${embedding.mode} embedding permitted`;
  }
}
