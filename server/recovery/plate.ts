// Plate reconstruction.
//
// The sidecar composites plate + text layer into its final image but never
// writes the plate itself. Wherever the text layer is transparent the final
// image IS the plate, so the plate is recovered by filling only the pixels
// under re-drawn glyphs from their neighbours. The fill walks a frontier from
// the edge of each masked region inward (onion peel), touching every masked
// pixel once, and yields to the event loop so the server stays responsive.

import { setImmediate as yieldToLoop } from "node:timers/promises";
import sharp from "sharp";

export type PlateBuildInput = {
  finalPath: string;
  layerPath: string;
  outputPath: string;
  alphaThreshold?: number;
  dilate?: number;
};

const YIELD_EVERY = 20_000;

export async function buildPlateFromComposite({
  finalPath,
  layerPath,
  outputPath,
  alphaThreshold = 8,
  dilate = 1,
}: PlateBuildInput) {
  const { data: rgba, info } = await sharp(finalPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const layer = await sharp(layerPath)
    .ensureAlpha()
    .resize(width, height, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const total = width * height;
  // 0 = known pixel, 1 = to fill, 2 = queued on the frontier
  let mask = new Uint8Array(total);
  for (let index = 0; index < total; index += 1) {
    if (layer.data[index * 4 + 3] > alphaThreshold) mask[index] = 1;
  }
  for (let round = 0; round < dilate; round += 1) mask = dilateMask(mask, width, height);

  const pixels = new Float32Array(total * 3);
  for (let index = 0; index < total; index += 1) {
    pixels[index * 3] = rgba[index * 4];
    pixels[index * 3 + 1] = rgba[index * 4 + 1];
    pixels[index * 3 + 2] = rgba[index * 4 + 2];
  }

  // Seed the frontier with masked pixels that touch a known pixel.
  const queue: number[] = [];
  const neighbours = (index: number, visit: (neighbour: number) => void) => {
    const x = index % width;
    const y = (index - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        visit(ny * width + nx);
      }
    }
  };
  for (let index = 0; index < total; index += 1) {
    if (mask[index] !== 1) continue;
    let touchesKnown = false;
    neighbours(index, (neighbour) => { if (mask[neighbour] === 0) touchesKnown = true; });
    if (touchesKnown) {
      mask[index] = 2;
      queue.push(index);
    }
  }

  let filled = 0;
  let head = 0;
  let processed = 0;
  while (head < queue.length) {
    const index = queue[head];
    head += 1;
    let r = 0; let g = 0; let b = 0; let count = 0;
    neighbours(index, (neighbour) => {
      if (mask[neighbour] !== 0) return;
      r += pixels[neighbour * 3];
      g += pixels[neighbour * 3 + 1];
      b += pixels[neighbour * 3 + 2];
      count += 1;
    });
    if (count > 0) {
      pixels[index * 3] = r / count;
      pixels[index * 3 + 1] = g / count;
      pixels[index * 3 + 2] = b / count;
    }
    mask[index] = 0;
    filled += 1;
    neighbours(index, (neighbour) => {
      if (mask[neighbour] === 1) {
        mask[neighbour] = 2;
        queue.push(neighbour);
      }
    });
    processed += 1;
    if (processed % YIELD_EVERY === 0) await yieldToLoop();
  }

  const output = Buffer.alloc(total * 3);
  for (let index = 0; index < total * 3; index += 1) output[index] = Math.max(0, Math.min(255, Math.round(pixels[index])));
  await sharp(output, { raw: { width, height, channels: 3 } }).png().toFile(outputPath);
  return { width, height, filledPixels: filled };
}

function dilateMask(mask: Uint8Array, width: number, height: number) {
  const out = new Uint8Array(mask);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (!mask[index]) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }
  return out;
}

export async function imageDimensions(filePath: string) {
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) throw new Error(`Cannot read image dimensions for ${filePath}.`);
  return { width: metadata.width, height: metadata.height };
}
