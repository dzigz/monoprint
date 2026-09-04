import type { SlideCopyItem } from "./types.js";

export const ROLE_LABELED_COPY_HEADING = "VISIBLE COPY — EXACT TEXT WITH PRODUCTION ROLE LABELS";

export function formatRoleLabeledCopyBlock(copy: SlideCopyItem[]) {
  return [
    ROLE_LABELED_COPY_HEADING,
    ...copy.map((item) => `${item.role}: ${JSON.stringify(item.text)}`),
    "The role labels before each colon are production metadata. Do not render the role labels; render only the quoted text assigned to them.",
    "Render every quoted string exactly once. No other text may appear anywhere on the slide.",
  ].join("\n");
}

export function appendRoleLabeledCopyBlock(prompt: string, copy: SlideCopyItem[]) {
  return `${prompt.trim()}\n\n${formatRoleLabeledCopyBlock(copy)}`;
}

export function slideCopyMatches(left: SlideCopyItem[], right?: SlideCopyItem[]) {
  if (!right || left.length !== right.length) return false;
  return left.every((item, index) => (
    item.role === right[index]?.role && item.text === right[index]?.text
  ));
}
