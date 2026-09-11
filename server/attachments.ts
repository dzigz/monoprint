// Brief attachments: uploaded files, linked pages, and local folders.
//
// Files are stored beside the deck and exposed through text and visual
// inspection tools. Links are fetched on demand. Folders reuse the
// read-only repository tools. Every successful read becomes a source record.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { tool } from "@openai/agents";
import { z } from "zod";
import { httpUrl } from "../src/shared/schema.js";
import { DocumentVisuals, isVisualDocument, type Visual } from "./documentVisuals.js";
import type { Attachment, DeckSource, FileSource, WebResearchSource } from "../src/shared/types.js";

const MAX_TEXT_CHARS = 1_500_000;
const DEFAULT_READ_CHARS = 12_000;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".rtf", ".log", ".ts", ".tsx", ".js", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".sql", ".sh", ".toml", ".ini"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type ExtractedAttachment = {
  attachment: Attachment;
  kind: "text" | "image" | "binary";
  text?: string;
  pages?: number;
  error?: string;
  visuals?: Visual[];
  warnings?: string[];
};

export function extractLinks(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

export function isImageAttachment(attachment: Attachment) {
  return attachment.kind === "file" && (Boolean(attachment.mimeType && IMAGE_MIME_TYPES.has(attachment.mimeType)) || /\.(png|jpe?g|webp|gif)$/i.test(attachment.name));
}

export async function extractAttachment(attachment: Attachment, visuals = new DocumentVisuals([attachment])): Promise<ExtractedAttachment> {
  if (attachment.kind !== "file" || !attachment.path) return { attachment, kind: "binary" };
  const extension = path.extname(attachment.name).toLowerCase();
  const mimeType = attachment.mimeType ?? "";
  try {
    if (isVisualDocument(attachment)) {
      const document = await visuals.document(attachment);
      return { attachment, kind: isImageAttachment(attachment) ? "image" : "text", ...document };
    }
    if (TEXT_EXTENSIONS.has(extension) || mimeType.startsWith("text/") || mimeType === "application/json") {
      const text = await readFile(attachment.path, "utf8");
      return { attachment, kind: "text", text: text.slice(0, MAX_TEXT_CHARS) };
    }
    return { attachment, kind: "binary", error: "Unsupported file type; only its name is available." };
  } catch (error) {
    return { attachment, kind: "binary", error: error instanceof Error ? error.message : "Could not read the file." };
  }
}

export function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export async function fetchLinkText(url: string, signal?: AbortSignal) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Only http and https links can be opened.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Monoprint/0.1 (+local presentation builder)", Accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8,*/*;q=0.5" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`The link responded with status ${response.status}.`);
    const contentType = response.headers.get("content-type") ?? "";
    const titleFromUrl = parsed.hostname;
    if (contentType.includes("pdf")) {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const data = new Uint8Array(await response.arrayBuffer());
      const document = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
      const pages: string[] = [];
      for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 60); pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        pages.push(`[Page ${pageNumber}]\n${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")}`);
      }
      return { title: titleFromUrl, text: pages.join("\n\n").slice(0, MAX_TEXT_CHARS), contentType };
    }
    const body = await response.text();
    const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? htmlToText(titleMatch[1]).slice(0, 200) || titleFromUrl : titleFromUrl;
    const text = contentType.includes("html") ? htmlToText(body) : body;
    return { title, text: text.slice(0, MAX_TEXT_CHARS), contentType };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export class AttachmentLibrary {
  private readonly extracted = new Map<string, Promise<ExtractedAttachment>>();

  readonly visuals: DocumentVisuals;
  constructor(readonly attachments: Attachment[], signal?: AbortSignal) { this.visuals = new DocumentVisuals(attachments, signal); }

  get files() {
    return this.attachments.filter((attachment) => attachment.kind === "file");
  }

  get links() {
    return this.attachments.filter((attachment) => attachment.kind === "link");
  }

  get folders() {
    return this.attachments.filter((attachment) => attachment.kind === "folder");
  }

  extract(attachment: Attachment) {
    let pending = this.extracted.get(attachment.id);
    if (!pending) {
      pending = extractAttachment(attachment, this.visuals);
      this.extracted.set(attachment.id, pending);
    }
    return pending;
  }

  async imageInputs() {
    const images: Array<{ attachment: Attachment; visualId: string; dataUrl: string }> = [];
    for (const attachment of this.files.filter(isImageAttachment).slice(0, 8)) {
      const extracted = await this.extract(attachment);
      const visual = extracted.visuals?.[0];
      if (!visual) continue;
      const prepared = await this.visuals.prepare(visual.id);
      const bytes = await readFile(prepared.path);
      images.push({ attachment, visualId: visual.id, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
    }
    return images;
  }

  /** Compact description of what the author was given. */
  async manifest() {
    const entries = [];
    for (const attachment of this.attachments) {
      if (attachment.kind === "file") {
        const extracted = await this.extract(attachment);
        entries.push({
          id: attachment.id,
          kind: "file",
          name: attachment.name,
          type: extracted.kind,
          ...(extracted.pages ? { pages: extracted.pages } : {}),
          ...(extracted.text ? { characters: extracted.text.length } : {}),
          ...(extracted.error ? { note: extracted.error } : {}),
          visualCount: extracted.visuals?.length ?? 0,
          ...(extracted.warnings?.length ? { warnings: extracted.warnings } : {}),
        });
      } else if (attachment.kind === "link") {
        entries.push({ id: attachment.id, kind: "link", url: attachment.url });
      } else {
        entries.push({ id: attachment.id, kind: "folder", name: attachment.name, path: attachment.path });
      }
    }
    return entries;
  }
}

export const attachmentToolNames = new Set(["list_attachments", "read_attachment", "list_attachment_visuals", "view_attachment_visual", "open_link"]);

export function isAttachmentToolName(name: string) {
  return attachmentToolNames.has(name);
}

export function createAttachmentTools({
  library,
  onActivity,
  onSource,
  signal,
}: {
  library: AttachmentLibrary;
  onActivity: (message: string, kind: "file" | "link") => Promise<void>;
  onSource: (source: DeckSource) => Promise<void>;
  signal?: AbortSignal;
}) {
  const listAttachments = tool({
    name: "list_attachments",
    description: "List the files and links attached to the brief, with their ids, types, and sizes. Read a file with read_attachment; open a link with open_link.",
    parameters: z.object({}),
    async execute() {
      return JSON.stringify(await library.manifest());
    },
  });

  const readAttachment = tool({
    name: "read_attachment",
    description: "Read text from an attached file by id. Long files are read in chunks: pass startChar to continue. Returns a source record to cite on slides that rely on it.",
    parameters: z.object({
      attachmentId: z.string().min(1),
      startChar: z.number().int().nonnegative().optional(),
      maxChars: z.number().int().min(500).max(40_000).optional(),
    }),
    async execute({ attachmentId, startChar = 0, maxChars = DEFAULT_READ_CHARS }) {
      const attachment = library.attachments.find((candidate) => candidate.id === attachmentId);
      if (!attachment || attachment.kind !== "file") throw new Error(`Unknown attachment ${attachmentId}.`);
      await onActivity(`Reading ${attachment.name}.`, "file");
      const extracted = await library.extract(attachment);
      if (extracted.kind === "image") return JSON.stringify({ attachmentId, note: "Use list_attachment_visuals and view_attachment_visual to inspect this image and obtain a visual ID for generate_slide_image." });
      if (!extracted.text) throw new Error(extracted.error ?? "This attachment has no readable text.");
      const end = Math.min(extracted.text.length, startChar + maxChars);
      const source: FileSource = {
        id: `file-${attachment.id.slice(0, 8)}-${startChar}`,
        title: attachment.name,
        kind: "file",
        attachmentId: attachment.id,
        locator: `chars ${startChar}-${end}`,
      };
      await onSource(source);
      return JSON.stringify({
        attachmentId,
        name: attachment.name,
        totalChars: extracted.text.length,
        startChar,
        endChar: end,
        hasMore: end < extracted.text.length,
        visualCount: extracted.visuals?.length ?? 0,
        warnings: extracted.warnings,
        text: extracted.text.slice(startChar, end),
        source,
      });
    },
  });

  const openLink = tool({
    name: "open_link",
    description: "Fetch a web page or PDF by URL and return its readable text. Use for links in the brief and for following up on search results. Returns a source record to cite.",
    parameters: z.object({
      url: httpUrl.describe("Complete http or https URL to open."),
      startChar: z.number().int().nonnegative().optional(),
      maxChars: z.number().int().min(500).max(40_000).optional(),
    }),
    async execute({ url, startChar = 0, maxChars = DEFAULT_READ_CHARS }) {
      await onActivity(`Opening ${new URL(url).hostname}.`, "link");
      const page = await fetchLinkText(url, signal);
      const end = Math.min(page.text.length, startChar + maxChars);
      const source: WebResearchSource = {
        id: `link-${randomUUID().slice(0, 8)}`,
        title: page.title,
        kind: "web",
        url,
        publisher: new URL(url).hostname,
      };
      await onSource(source);
      return JSON.stringify({
        url,
        title: page.title,
        totalChars: page.text.length,
        startChar,
        endChar: end,
        hasMore: end < page.text.length,
        text: page.text.slice(startChar, end),
        source,
      });
    },
  });

  const listVisuals = tool({
    name: "list_attachment_visuals",
    description: "List page/slide previews, embedded images, and saved crops from uploaded PDF, DOCX, PPTX, and image files. Stable visual IDs can be inspected and passed to generate_slide_image. Paginate to see all results.",
    parameters: z.object({ attachmentId: z.string().optional(), start: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }),
    async execute({ attachmentId, start = 0, limit = 50 }) {
      await onActivity("Listing source visuals.", "file");
      const visuals = await library.visuals.list(attachmentId);
      return JSON.stringify({ visuals: visuals.slice(start, start + limit), total: visuals.length, hasMore: start + limit < visuals.length });
    },
  });
  const viewVisual = tool({
    name: "view_attachment_visual",
    description: "See an uploaded image, embedded document image, or rendered page/slide. Optionally crop using normalized coordinates (0–1) to isolate a chart, photograph, or diagram. Returns actual image pixels and a reusable visual ID. Inspect source visuals before selecting them for generation.",
    parameters: z.object({ visualId: z.string().min(1), crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).optional() }),
    async execute({ visualId, crop }) {
      await onActivity("Inspecting a source visual.", "file");
      const id = crop ? await library.visuals.crop(visualId, crop) : visualId;
      const visual = await library.visuals.prepare(id);
      await onSource(visual.source);
      return [
        { type: "text" as const, text: JSON.stringify({ visualId: id, name: visual.name, locator: visual.locator, width: visual.width, height: visual.height, source: visual.source }) },
        { type: "image" as const, image: `data:image/png;base64,${(await readFile(visual.path)).toString("base64")}`, detail: "high" as const },
      ];
    },
  });
  return [listAttachments, readAttachment, listVisuals, viewVisual, openLink];
}
