import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import * as fontkit from "fontkit";
import type { FontCatalogEntry, FontMetrics } from "../src/shared/types.js";

const supportedExtensions = new Set([".ttf", ".otf", ".ttc", ".woff", ".woff2"]);
const excludedReferenceFonts = /emoji|braille|symbols|wingdings|webdings|zapf|lastresort|hiragino|pingfang|songti|kaiti|heiti|gurmukhi|kohinoor|mishafi|noto sans (?!$)/i;

type FontFile = {
  absolutePath: string;
  relativePath: string;
};

export type FontFace = {
  absolutePath: string;
  faceIndex: number;
  fullName?: string;
  postscriptName?: string;
  /** Typographic family and subfamily (name IDs 16/17) when the font declares them. */
  preferredFamily?: string;
  preferredSubfamily?: string;
  weight: number;
  italic: boolean;
};

export type LoadedFontCatalog = {
  entries: FontCatalogEntry[];
  faces: Map<string, FontFace>;
};

async function collectFontFiles(root: string, current = root): Promise<FontFile[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: FontFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFontFiles(root, absolutePath));
      continue;
    }
    if (!entry.isFile() || !supportedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    files.push({ absolutePath, relativePath: path.relative(root, absolutePath) });
  }
  return files;
}

function catalogId(locator: string) {
  return createHash("sha1").update(locator).digest("hex").slice(0, 14);
}

function fallbackName(relativePath: string) {
  return path.basename(relativePath, path.extname(relativePath))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function variableAxes(relativePath: string) {
  const match = path.basename(relativePath, path.extname(relativePath)).match(/\[([^\]]+)\]/);
  return match ? match[1].split(",").map((axis) => axis.trim()).filter(Boolean) : [];
}

function variableFamilyName(relativePath: string) {
  const stem = path.basename(relativePath, path.extname(relativePath));
  const family = stem.split("[")[0];
  return family.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
}

const weightWords: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra ?light|ultra ?light/i, 200],
  [/light/i, 300],
  [/medium/i, 500],
  [/semi ?bold|demi ?bold/i, 600],
  [/extra ?bold|ultra ?bold/i, 800],
  [/black|heavy/i, 900],
  [/bold/i, 700],
];

export function weightFromSubfamily(subfamily: string, os2Weight?: number) {
  if (os2Weight && os2Weight >= 100 && os2Weight <= 900) return os2Weight;
  for (const [pattern, weight] of weightWords) {
    if (pattern.test(subfamily)) return weight;
  }
  return 400;
}

export function isItalicSubfamily(subfamily: string) {
  return /italic|oblique/i.test(subfamily);
}

function readFontEntries(absolutePath: string, relativePath: string) {
  const fallback = fallbackName(relativePath);
  const fileAxes = variableAxes(relativePath);
  try {
    const opened = fontkit.openSync(absolutePath);
    const fonts = "fonts" in opened ? opened.fonts : [opened];
    return fonts.map((font, faceIndex) => {
      const variationAxes = "variationAxes" in font
        ? Object.keys(font.variationAxes as Record<string, unknown>)
        : [];
      const axes = fileAxes.length > 0 ? fileAxes : variationAxes;
      const subfamily = font?.subfamilyName?.trim() || "Regular";
      const os2 = (font as unknown as { "OS/2"?: { usWeightClass?: number } })["OS/2"];
      const records = (font as unknown as { name?: { records?: Record<string, Record<string, string>> } }).name?.records ?? {};
      const preferredFamily = records.preferredFamily?.en?.trim() || undefined;
      const preferredSubfamily = records.preferredSubfamily?.en?.trim() || undefined;
      return {
        faceIndex,
        family: fileAxes.length > 0 && fonts.length === 1
          ? variableFamilyName(relativePath)
          : font?.familyName?.trim() || fallback,
        subfamily,
        axes,
        fullName: font?.fullName?.trim() || undefined,
        postscriptName: font?.postscriptName?.trim() || undefined,
        preferredFamily,
        preferredSubfamily,
        weight: weightFromSubfamily(subfamily, os2?.usWeightClass),
        italic: isItalicSubfamily(subfamily) || Boolean((font as unknown as { italicAngle?: number }).italicAngle),
      };
    });
  } catch {
    return [{ faceIndex: 0, family: fallback, subfamily: "Regular", axes: fileAxes, fullName: undefined, postscriptName: undefined, preferredFamily: undefined, preferredSubfamily: undefined, weight: 400, italic: false }];
  }
}

export async function loadFontCatalog(roots: string | string[]): Promise<LoadedFontCatalog> {
  const resolvedRoots = (Array.isArray(roots) ? roots : [roots]).map((root) => path.resolve(root));
  const fontFiles = (await Promise.all(resolvedRoots.map((root) => collectFontFiles(root))))
    .flat()
    .filter((font, index, files) => files.findIndex((candidate) => candidate.absolutePath === font.absolutePath) === index)
    .filter((font) => !excludedReferenceFonts.test(font.relativePath));
  const faces = new Map<string, FontFace>();
  const entries = fontFiles.flatMap(({ absolutePath, relativePath }) =>
    readFontEntries(absolutePath, relativePath)
      .filter(({ family }) => !excludedReferenceFonts.test(family))
      .map(({ faceIndex, family, subfamily, axes, fullName, postscriptName, preferredFamily, preferredSubfamily, weight, italic }) => {
        const id = catalogId(`${absolutePath}#${faceIndex}`);
        faces.set(id, { absolutePath, faceIndex, fullName, postscriptName, preferredFamily, preferredSubfamily, weight, italic });
        return {
          id,
          family,
          subfamily,
          axes,
          sourceLabel: `${relativePath}${faceIndex > 0 ? `#${faceIndex}` : ""}`,
        } satisfies FontCatalogEntry;
      }),
  );

  entries.sort((a, b) =>
    a.family.localeCompare(b.family) || a.subfamily.localeCompare(b.subfamily) || a.sourceLabel.localeCompare(b.sourceLabel),
  );
  return { entries, faces };
}

export function fontCatalogForPrompt(entries: FontCatalogEntry[]) {
  return entries.map((font) => ({
    id: font.id,
    family: font.family,
    style: font.subfamily,
    axes: font.axes,
    file: font.sourceLabel,
  }));
}

/** Metrics the browser needs to place a baseline where the pipeline measured it. */
export function readFontMetrics(absolutePath: string, faceIndex = 0): FontMetrics | undefined {
  try {
    const opened = fontkit.openSync(absolutePath);
    const font = ("fonts" in opened ? opened.fonts[faceIndex] : opened) as fontkit.Font;
    const unitsPerEm = font.unitsPerEm;
    const space = font.glyphForCodePoint(0x20);
    const descenderProbe = font.glyphForCodePoint("p".codePointAt(0) as number);
    const descenderDepth = descenderProbe?.bbox ? Math.max(0, -descenderProbe.bbox.minY) : Math.abs(font.descent);
    return {
      unitsPerEm,
      ascent: font.ascent,
      descent: font.descent,
      lineGap: font.lineGap,
      capHeight: font.capHeight || undefined,
      xHeight: font.xHeight || undefined,
      spaceAdvance: space?.advanceWidth ?? unitsPerEm * 0.25,
      descenderDepth,
    };
  } catch {
    return undefined;
  }
}
