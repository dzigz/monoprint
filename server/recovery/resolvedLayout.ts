import type { CanvasSize, DeckFont, FontRoleName, TextObject } from "../../src/shared/types.js";

export type PipelineLayout = {
  schema: number;
  page_size: [number, number];
  fonts: Record<string, { path: string; face_index: number; sha256: string }>;
  words: Record<string, {
    id: number; text: string; font: string; em: number; baseline: [number, number];
    bounds: [number, number, number, number]; angle: number; color: number[]; line: string;
  }>;
  blocks: Array<{ id: string | number; role?: string; align: "left" | "center" | "right";
    lines: Array<{ id: string; words: number[] }> }>;
};

const hex = (rgb: number[]) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Preserve the renderer's word baselines and exact font instances. No OCR,
 * width fitting, line breaking or inpainting occurs at the export boundary. */
export function objectsFromResolved(layout: PipelineLayout, fonts: Map<string, DeckFont>, canvas: CanvasSize, revision: string): TextObject[] {
  if (layout.schema !== 1) throw new Error(`Unsupported resolved layout schema ${layout.schema}`);
  const sx = canvas.width / layout.page_size[0], sy = canvas.height / layout.page_size[1];
  return layout.blocks.flatMap((block) => {
    const words = block.lines.flatMap((line) => line.words.map((id) => layout.words[String(id)]));
    if (!words.length) return [];
    const points = words.flatMap((word) => {
      const [x,y] = word.baseline, [a,b,c,d] = word.bounds;
      const t = word.angle * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
      return [[a,b],[c,b],[c,d],[a,d]].map(([u,v]) => [(x+u*co-v*si)*sx, (y+u*si+v*co)*sy]);
    });
    const x = Math.min(...points.map((p) => p[0])), y = Math.min(...points.map((p) => p[1]));
    const frame = { x, y, width: Math.max(1, Math.max(...points.map((p) => p[0]))-x), height: Math.max(1, Math.max(...points.map((p) => p[1]))-y) };
    const ref = words[0], font = fonts.get(ref.font);
    if (!font) throw new Error(`Missing resolved font ${ref.font}`);
    const role: FontRoleName = block.role === "heading" ? "heading" : block.role === "label" ? "label" : "body";
    return [{ id: `text_${block.id}`, kind: "text" as const, frame,
      text: block.lines.map((line) => line.words.map((id) => layout.words[String(id)].text).join(" ")).join("\n"),
      style: { fontRole: role, fontId: font.id, fontSize: ref.em*sy, lineHeight: 1.2, align: block.align, color: hex(ref.color) },
      origin: { kind: "recovered" as const, frame: { ...frame } },
      resolved: { revision, words: words.map((word) => {
        const runFont = fonts.get(word.font);
        if (!runFont) throw new Error(`Missing resolved font ${word.font}`);
        return { id: word.id, text: word.text, fontId: runFont.id, em: word.em*sy,
          baseline: [word.baseline[0]*sx-x, word.baseline[1]*sy-y] as [number, number],
          angle: word.angle, color: hex(word.color), line: word.line, scaleX: sx/sy };
      }) },
    }];
  });
}
