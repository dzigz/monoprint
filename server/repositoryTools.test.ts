import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { repositorySourceForExcerpt, RepositoryReader, validateRepositoryRoot } from "./repositoryTools.js";

test("lists, searches, and reads repository source with line grounding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "presentation-repository-reader-"));
  try {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "src", "server.ts"), [
      "export function start() {",
      "  return createServer();",
      "}",
    ].join("\n"));
    await writeFile(path.join(root, ".env"), "SECRET=hidden");
    await writeFile(path.join(root, "node_modules", "dependency.js"), "createServer()");

    const validatedRoot = await validateRepositoryRoot(root);
    const reader = new RepositoryReader(validatedRoot);
    const listing = await reader.list(".", 3, 100);
    assert(listing.entries.some((entry) => entry.path === "src/server.ts"));
    assert(!listing.entries.some((entry) => entry.path.includes("node_modules")));
    assert(!listing.entries.some((entry) => entry.path.includes(".env")));

    const search = await reader.search({ query: "createServer", maxResults: 10 });
    assert.deepEqual(search.matches.map((match) => [match.path, match.line]), [["src/server.ts", 2]]);

    const excerpt = await reader.read("src/server.ts", 2, 3);
    assert.equal(excerpt.path, "src/server.ts");
    assert.equal(excerpt.startLine, 2);
    assert.equal(excerpt.endLine, 3);
    assert.equal(excerpt.content, "  return createServer();\n}");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository reader rejects traversal and sensitive files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "presentation-repository-boundary-"));
  try {
    await writeFile(path.join(root, "source.ts"), "export const value = 1;");
    await writeFile(path.join(root, ".env.local"), "SECRET=hidden");
    const reader = new RepositoryReader(await validateRepositoryRoot(root));

    await assert.rejects(() => reader.read("../outside.ts"), /escapes the selected root/);
    await assert.rejects(() => reader.read(".env.local"), /excluded from repository inspection/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository validation reports an unusable root clearly", async () => {
  await assert.rejects(
    () => validateRepositoryRoot(path.join(tmpdir(), "presentation-repository-that-does-not-exist")),
    /does not exist or cannot be read/,
  );
});

test("assigns a stable source identity to an observed repository excerpt", () => {
  const first = repositorySourceForExcerpt({ path: "src/server.ts", startLine: 2, endLine: 3 });
  const second = repositorySourceForExcerpt({ path: "src/server.ts", startLine: 2, endLine: 3 });
  assert.deepEqual(first, second);
  assert.equal(first.kind, "repository");
  assert.equal(first.path, "src/server.ts");
});
