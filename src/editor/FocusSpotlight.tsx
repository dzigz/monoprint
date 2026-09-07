import { useMemo } from "react";
import type { CanvasSize, FocusRegion } from "../shared/types";

const FEATHER_PX = 18;

/** An outward-only distance fade: the rectangular interior is fully clear.
 * Edge strips and radial corners start at zero opacity on the boundary, then
 * ease to an opaque mask. Blurring a cutout would soften its interior too. */
export function spotlightMask(canvas: CanvasSize, box: FocusRegion["box"], feather: number) {
  const [left, top, right, bottom] = box;
  const width = right - left;
  const height = bottom - top;
  const stops = Array.from({ length: 9 }, (_, i) => {
    const t = i / 8;
    return `<stop offset="${t}" stop-color="white" stop-opacity="${t * t * (3 - 2 * t)}"/>`;
  }).join("");
  const edge = (x: number, y: number, length: number, angle: number) =>
    `<rect width="${length}" height="${feather}" fill="url(#edge)" transform="translate(${x} ${y}) rotate(${angle})"/>`;
  const corner = (x: number, y: number, dx: number, dy: number) =>
    `<rect x="${dx}" y="${dy}" width="${feather}" height="${feather}" fill="url(#corner)" transform="translate(${x} ${y})"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">
    <defs>
      <linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${feather}">${stops}</linearGradient>
      <radialGradient id="corner" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${feather}">${stops}</radialGradient>
    </defs>
    <g shape-rendering="crispEdges">
      <path fill="white" fill-rule="evenodd" d="M0 0H${canvas.width}V${canvas.height}H0Z M${left - feather} ${top - feather}H${right + feather}V${bottom + feather}H${left - feather}Z"/>
      ${edge(left, bottom, width, 0)}${edge(right, top, width, 180)}
      ${edge(left, top, height, 90)}${edge(right, bottom, height, -90)}
      ${corner(left, top, -feather, -feather)}${corner(right, top, 0, -feather)}
      ${corner(left, bottom, -feather, 0)}${corner(right, bottom, 0, 0)}
    </g>
  </svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

export function FocusSpotlight({ canvas, box, scale }: { canvas: CanvasSize; box: FocusRegion["box"]; scale: number }) {
  // Keep the apparent softness constant as the stage resizes.
  const mask = useMemo(() => spotlightMask(canvas, box, FEATHER_PX / scale), [canvas, box, scale]);
  return <div
    className="slide-canvas__spotlight" aria-hidden="true" data-testid="focus-region" data-focus-box={box.join(",")}
    style={{ maskImage: mask, WebkitMaskImage: mask }}
  />;
}
