import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalRunStateCheckpoint,
  publishDeckDraftsFromRunState,
  repositorySourcesFromRunState,
  runStateUsedWebSearch,
} from "./runCheckpoint.js";

test("identifies serialized final-output checkpoints that require history continuation", () => {
  assert.equal(isTerminalRunStateCheckpoint(JSON.stringify({
    currentStep: { type: "next_step_final_output", output: "Incomplete" },
  })), true);
});

test("leaves interrupted checkpoints eligible for direct RunState resumption", () => {
  assert.equal(isTerminalRunStateCheckpoint(JSON.stringify({
    currentStep: { type: "next_step_run_again" },
  })), false);
});

test("recovers observed repository sources and publication drafts from a checkpoint", () => {
  const publicationDraft = { title: "Recovered deck", slides: [] };
  const serialized = JSON.stringify({
    generatedItems: [
      {
        rawItem: {
          type: "function_call_result",
          name: "read_repository_file",
          output: {
            type: "text",
            text: JSON.stringify({
              path: "src/server.ts",
              startLine: 10,
              endLine: 24,
              totalLines: 80,
              content: "source",
            }),
          },
        },
      },
      {
        rawItem: {
          type: "function_call",
          name: "publish_deck",
          arguments: JSON.stringify(publicationDraft),
        },
      },
      {
        rawItem: {
          type: "hosted_tool_call",
          name: "web_search_call",
        },
      },
    ],
  });

  assert.deepEqual(repositorySourcesFromRunState(serialized).map((source) => ({
    kind: source.kind,
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
  })), [{ kind: "repository", path: "src/server.ts", startLine: 10, endLine: 24 }]);
  assert.deepEqual(publishDeckDraftsFromRunState(serialized), [publicationDraft]);
  assert.equal(runStateUsedWebSearch(serialized), true);
});
