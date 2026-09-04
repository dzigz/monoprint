import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@openai/agents";
import { z } from "zod";
import type { DeckSource, RepositorySource } from "../src/shared/types.js";

const execFileAsync = promisify(execFile);
const MAX_READ_BYTES = 2_000_000;
const DEFAULT_MAX_LINES = 400;

const ignoredDirectoryNames = new Set([
  ".git",
  ".cache",
  ".next",
  ".nuxt",
  ".output",
  ".parcel-cache",
  ".turbo",
  ".venv",
  "__pycache__",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv",
]);

const sensitiveFileNames = new Set([
  ".netrc",
  ".npmrc",
  "id_dsa",
  "id_ed25519",
  "id_rsa",
]);

const sensitiveExtensions = new Set([".key", ".p12", ".pem", ".pfx"]);
const repositoryToolNames = new Set(["list_repository", "search_repository", "read_repository_file"]);

export function isRepositoryToolName(name: string) {
  return repositoryToolNames.has(name);
}

function isSensitiveFileName(fileName: string) {
  const lower = fileName.toLowerCase();
  return lower === ".env"
    || lower.startsWith(".env.")
    || sensitiveFileNames.has(lower)
    || sensitiveExtensions.has(path.extname(lower));
}

function hasIgnoredOrSensitivePart(relativePath: string) {
  const parts = relativePath.split(path.sep).filter(Boolean);
  return parts.some((part, index) => ignoredDirectoryNames.has(part.toLowerCase())
    || (index === parts.length - 1 && isSensitiveFileName(part)));
}

function isInside(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function portableRelativePath(value: string) {
  const portable = value.split(path.sep).join("/");
  return portable.startsWith("./") ? portable.slice(2) : portable;
}

export async function validateRepositoryRoot(repositoryPath: string) {
  let resolved: string;
  try {
    resolved = await realpath(path.resolve(repositoryPath));
  } catch {
    throw new Error("Repository path does not exist or cannot be read.");
  }
  const details = await stat(resolved);
  if (!details.isDirectory()) throw new Error("Repository path must refer to a directory.");
  return resolved;
}

export type RepositorySearchMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
};

export type RepositoryExcerpt = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
};

export function repositorySourceForExcerpt(excerpt: Pick<RepositoryExcerpt, "path" | "startLine" | "endLine">): RepositorySource {
  const location = `${excerpt.path}:${excerpt.startLine}:${excerpt.endLine}`;
  const digest = createHash("sha256").update(location).digest("hex").slice(0, 16);
  return {
    id: `repository-${digest}`,
    title: `${excerpt.path}, lines ${excerpt.startLine}–${excerpt.endLine}`,
    kind: "repository",
    path: excerpt.path,
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
  };
}

export class RepositoryReader {
  constructor(readonly root: string, private readonly signal?: AbortSignal) {}

  private async resolve(relativePath = ".", expected: "file" | "directory" | "either" = "either") {
    if (path.isAbsolute(relativePath)) throw new Error("Repository paths must be relative to the selected root.");
    const lexicalPath = path.resolve(this.root, relativePath);
    if (!isInside(this.root, lexicalPath)) throw new Error("Repository path escapes the selected root.");
    let currentPath = this.root;
    for (const part of path.relative(this.root, lexicalPath).split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, part);
      if ((await lstat(currentPath)).isSymbolicLink()) throw new Error("Symbolic links are not inspected.");
    }
    const resolved = await realpath(lexicalPath);
    if (!isInside(this.root, resolved)) throw new Error("Repository path resolves outside the selected root.");
    const normalizedRelativePath = path.relative(this.root, resolved);
    if (hasIgnoredOrSensitivePart(normalizedRelativePath)) {
      throw new Error("That path is excluded from repository inspection.");
    }
    const details = await lstat(resolved);
    if (expected === "file" && !details.isFile()) throw new Error("Repository path must refer to a file.");
    if (expected === "directory" && !details.isDirectory()) throw new Error("Repository path must refer to a directory.");
    return { resolved, relative: portableRelativePath(normalizedRelativePath || "."), details };
  }

  async list(relativePath = ".", maxDepth = 3, maxEntries = 600) {
    const start = await this.resolve(relativePath, "directory");
    const entries: Array<{ path: string; type: "file" | "directory" }> = [];
    let truncated = false;

    const visit = async (directory: string, depth: number) => {
      if (truncated) return;
      const children = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (child.isSymbolicLink() || ignoredDirectoryNames.has(child.name.toLowerCase()) || isSensitiveFileName(child.name)) continue;
        const childPath = path.join(directory, child.name);
        const childRelative = portableRelativePath(path.relative(this.root, childPath));
        if (child.isDirectory()) {
          entries.push({ path: `${childRelative}/`, type: "directory" });
          if (depth < maxDepth) await visit(childPath, depth + 1);
        } else if (child.isFile()) {
          entries.push({ path: childRelative, type: "file" });
        }
      }
    };

    await visit(start.resolved, 1);
    return { root: start.relative, entries, truncated };
  }

  async read(relativePath: string, startLine = 1, endLine?: number) {
    if (startLine < 1 || (endLine !== undefined && endLine < startLine)) {
      throw new Error("Line ranges must be positive and endLine must not precede startLine.");
    }
    const target = await this.resolve(relativePath, "file");
    if (target.details.size > MAX_READ_BYTES) {
      throw new Error(`File is too large to inspect safely (${target.details.size} bytes).`);
    }
    const content = await readFile(target.resolved, "utf8");
    if (content.includes("\0")) throw new Error("Binary files cannot be inspected as source text.");
    const lines = content.split(/\r?\n/);
    const finalEndLine = Math.min(endLine ?? startLine + DEFAULT_MAX_LINES - 1, lines.length);
    if (startLine > lines.length) throw new Error(`startLine exceeds the file's ${lines.length} lines.`);
    return {
      path: target.relative,
      startLine,
      endLine: finalEndLine,
      totalLines: lines.length,
      content: lines.slice(startLine - 1, finalEndLine).join("\n"),
    };
  }

  async search({
    query,
    relativePath = ".",
    filePattern,
    regex = false,
    maxResults = 80,
  }: {
    query: string;
    relativePath?: string;
    filePattern?: string;
    regex?: boolean;
    maxResults?: number;
  }) {
    const target = await this.resolve(relativePath);
    const args = [
      "--json",
      "--line-number",
      "--column",
      "--hidden",
      "--color",
      "never",
      ...(!regex ? ["--fixed-strings"] : []),
      ...[...ignoredDirectoryNames].flatMap((directory) => ["--glob", `!**/${directory}/**`]),
      "--glob", "!**/.env",
      "--glob", "!**/.env.*",
      "--glob", "!**/*.key",
      "--glob", "!**/*.p12",
      "--glob", "!**/*.pem",
      "--glob", "!**/*.pfx",
      "--glob", "!**/.netrc",
      "--glob", "!**/.npmrc",
      "--glob", "!**/id_dsa",
      "--glob", "!**/id_ed25519",
      "--glob", "!**/id_rsa",
      ...(filePattern ? ["--glob", filePattern] : []),
      "--regexp",
      query,
      target.relative,
    ];

    let stdout = "";
    try {
      const result = await execFileAsync("rg", args, {
        cwd: this.root,
        encoding: "utf8",
        maxBuffer: 2_000_000,
        timeout: 30_000,
        signal: this.signal,
      });
      stdout = result.stdout;
    } catch (error) {
      const commandError = error as Error & { code?: number | string; stdout?: string };
      if (commandError.code !== 1) throw error;
      stdout = commandError.stdout ?? "";
    }

    const matches: RepositorySearchMatch[] = [];
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: Array<{ start?: number }>;
        };
      };
      if (event.type !== "match" || !event.data?.path?.text || !event.data.line_number) continue;
      matches.push({
        path: portableRelativePath(event.data.path.text),
        line: event.data.line_number,
        column: (event.data.submatches?.[0]?.start ?? 0) + 1,
        text: (event.data.lines?.text ?? "").trimEnd(),
      });
      if (matches.length >= maxResults) break;
    }
    return { query, matches, truncated: matches.length >= maxResults };
  }

  async validateSources(sources: DeckSource[]) {
    const repositorySources = sources.filter((source) => source.kind === "repository");
    if (repositorySources.length === 0) {
      throw new Error("A repository-grounded deck must publish at least one repository source reference.");
    }
    for (const source of repositorySources) {
      const excerpt = await this.read(source.path, source.startLine, source.endLine);
      if (excerpt.endLine !== source.endLine) {
        throw new Error(`Repository source ${source.id} extends beyond ${source.path}.`);
      }
    }
  }
}

export function createRepositoryTools({
  reader,
  onActivity,
  onSource,
}: {
  reader: RepositoryReader;
  onActivity: (message: string) => Promise<void>;
  onSource?: (source: RepositorySource) => Promise<void>;
}) {
  const listRepository = tool({
    name: "list_repository",
    description: "List source files and directories beneath the selected repository. Dependency caches, build output, version-control internals, secrets, and symlinks are excluded.",
    parameters: z.object({
      relativePath: z.string().max(1_000).optional(),
      maxDepth: z.number().int().min(1).max(8).optional(),
      maxEntries: z.number().int().min(1).max(2_000).optional(),
    }),
    async execute({ relativePath, maxDepth, maxEntries }) {
      await onActivity(`Inspecting the repository structure${relativePath ? ` at ${relativePath}` : ""}.`);
      return JSON.stringify(await reader.list(relativePath, maxDepth, maxEntries));
    },
  });

  const searchRepository = tool({
    name: "search_repository",
    description: "Search repository source text and return exact relative paths, line numbers, columns, and matching lines. Search is literal unless regex is explicitly true.",
    parameters: z.object({
      query: z.string().min(1).max(500),
      relativePath: z.string().max(1_000).optional(),
      filePattern: z.string().min(1).max(200).optional(),
      regex: z.boolean().optional(),
      maxResults: z.number().int().min(1).max(200).optional(),
    }),
    async execute(input) {
      await onActivity(`Searching repository source for “${input.query.slice(0, 80)}”.`);
      return JSON.stringify(await reader.search(input));
    },
  });

  const readRepositoryFile = tool({
    name: "read_repository_file",
    description: "Read an exact line range from a UTF-8 source file in the selected repository. Returns the relative path and authoritative line numbers for citation.",
    parameters: z.object({
      relativePath: z.string().min(1).max(1_000),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }).refine(({ startLine, endLine }) => endLine === undefined || startLine === undefined || endLine >= startLine, {
      message: "endLine must be greater than or equal to startLine.",
    }),
    async execute({ relativePath, startLine, endLine }) {
      await onActivity(`Reading ${relativePath}${startLine ? ` from line ${startLine}` : ""}.`);
      const excerpt = await reader.read(relativePath, startLine, endLine);
      const source = repositorySourceForExcerpt(excerpt);
      await onSource?.(source);
      return JSON.stringify({ ...excerpt, source });
    },
  });

  return [listRepository, searchRepository, readRepositoryFile];
}
