import type { Frame, Slide, SlideObject } from "../shared/types";

export type Guide = { axis: "x" | "y"; position: number; kind: "margin" | "center" | "object" | "origin" };

export type SnapResult = { x: number; y: number; guides: Guide[] };

const SAFE_MARGIN_RATIO = 0.05;

export function snapFrame(
  frame: Frame,
  slide: Slide,
  others: SlideObject[],
  origin: Frame | undefined,
  threshold: number,
): SnapResult {
  const { width: cw, height: ch } = slide.canvas;
  const marginX = cw * SAFE_MARGIN_RATIO;
  const marginY = ch * SAFE_MARGIN_RATIO;
  const xTargets: Array<{ value: number; kind: Guide["kind"] }> = [
    { value: marginX, kind: "margin" },
    { value: cw - marginX, kind: "margin" },
    { value: cw / 2, kind: "center" },
  ];
  const yTargets: Array<{ value: number; kind: Guide["kind"] }> = [
    { value: marginY, kind: "margin" },
    { value: ch - marginY, kind: "margin" },
    { value: ch / 2, kind: "center" },
  ];
  for (const other of others) {
    xTargets.push({ value: other.frame.x, kind: "object" }, { value: other.frame.x + other.frame.width, kind: "object" }, { value: other.frame.x + other.frame.width / 2, kind: "object" });
    yTargets.push({ value: other.frame.y, kind: "object" }, { value: other.frame.y + other.frame.height, kind: "object" }, { value: other.frame.y + other.frame.height / 2, kind: "object" });
  }
  if (origin) {
    xTargets.push({ value: origin.x, kind: "origin" });
    yTargets.push({ value: origin.y, kind: "origin" });
  }

  const edgesX = [
    { offset: 0, value: frame.x },
    { offset: frame.width / 2, value: frame.x + frame.width / 2 },
    { offset: frame.width, value: frame.x + frame.width },
  ];
  const edgesY = [
    { offset: 0, value: frame.y },
    { offset: frame.height / 2, value: frame.y + frame.height / 2 },
    { offset: frame.height, value: frame.y + frame.height },
  ];

  let bestX: { delta: number; guide: Guide } | undefined;
  for (const edge of edgesX) {
    for (const target of xTargets) {
      const delta = target.value - edge.value;
      if (Math.abs(delta) <= threshold && (!bestX || Math.abs(delta) < Math.abs(bestX.delta))) {
        bestX = { delta, guide: { axis: "x", position: target.value, kind: target.kind } };
      }
    }
  }
  let bestY: { delta: number; guide: Guide } | undefined;
  for (const edge of edgesY) {
    for (const target of yTargets) {
      const delta = target.value - edge.value;
      if (Math.abs(delta) <= threshold && (!bestY || Math.abs(delta) < Math.abs(bestY.delta))) {
        bestY = { delta, guide: { axis: "y", position: target.value, kind: target.kind } };
      }
    }
  }
  return {
    x: frame.x + (bestX?.delta ?? 0),
    y: frame.y + (bestY?.delta ?? 0),
    guides: [bestX?.guide, bestY?.guide].filter((guide): guide is Guide => Boolean(guide)),
  };
}
