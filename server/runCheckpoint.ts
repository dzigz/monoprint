import type { RepositorySource } from "../src/shared/types.js";
import { repositorySourceForExcerpt } from "./repositoryTools.js";

type SerializedRunStateEnvelope = {
  currentStep?: {
    type?: unknown;
  };
  generatedItems?: Array<{
    rawItem?: {
      type?: unknown;
      name?: unknown;
      arguments?: unknown;
      output?: unknown;
    };
  }>;
};

function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function outputText(value: unknown) {
  const parsed = parseJson(value);
  if (typeof parsed === "string") return parsed;
  if (Array.isArray(parsed)) {
    const textBlock = parsed.map(objectRecord).find((block) => block?.type === "text" && typeof block.text === "string");
    return typeof textBlock?.text === "string" ? textBlock.text : undefined;
  }
  const block = objectRecord(parsed);
  return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

export function isTerminalRunStateCheckpoint(serialized: string) {
  const checkpoint = JSON.parse(serialized) as SerializedRunStateEnvelope;
  return checkpoint.currentStep?.type === "next_step_final_output";
}

export function repositorySourcesFromRunState(serialized: string) {
  const checkpoint = JSON.parse(serialized) as SerializedRunStateEnvelope;
  const sources = new Map<string, RepositorySource>();
  for (const item of checkpoint.generatedItems ?? []) {
    const rawItem = item.rawItem;
    if (rawItem?.type !== "function_call_result" || rawItem.name !== "read_repository_file") continue;
    const excerpt = objectRecord(parseJson(outputText(rawItem.output)));
    if (
      typeof excerpt?.path !== "string"
      || !Number.isInteger(excerpt.startLine)
      || !Number.isInteger(excerpt.endLine)
      || Number(excerpt.startLine) < 1
      || Number(excerpt.endLine) < Number(excerpt.startLine)
    ) continue;
    const source = repositorySourceForExcerpt({
      path: excerpt.path,
      startLine: Number(excerpt.startLine),
      endLine: Number(excerpt.endLine),
    });
    sources.set(source.id, source);
  }
  return [...sources.values()];
}

export function publishDeckDraftsFromRunState(serialized: string) {
  const checkpoint = JSON.parse(serialized) as SerializedRunStateEnvelope;
  const drafts: unknown[] = [];
  for (const item of checkpoint.generatedItems ?? []) {
    const rawItem = item.rawItem;
    if (rawItem?.type !== "function_call" || rawItem.name !== "publish_deck") continue;
    const draft = parseJson(rawItem.arguments);
    if (objectRecord(draft)) drafts.push(draft);
  }
  return drafts;
}

export function runStateUsedWebSearch(serialized: string) {
  const checkpoint = JSON.parse(serialized) as SerializedRunStateEnvelope;
  return (checkpoint.generatedItems ?? []).some((item) => (
    item.rawItem?.type === "hosted_tool_call"
    && typeof item.rawItem.name === "string"
    && item.rawItem.name.startsWith("web_search")
  ));
}
