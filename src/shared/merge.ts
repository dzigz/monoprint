import type { Deck, Slide } from "./types.js";

/**
 * Combine a deck carrying local edits with the server's latest copy. Local
 * text, frames, styles, and design-system edits win; server-owned state
 * (assets, fonts, recovery results, repaints) is adopted.
 */
export function mergeServerDeck(local: Deck, server: Deck): Deck {
  const serverSlides = new Map(server.slides.map((slide) => [slide.id, slide]));
  const slides: Slide[] = local.slides.map((slide) => {
    const remote = serverSlides.get(slide.id);
    if (!remote) return slide;
    const remoteNewerRecovery = remote.recovery.updatedAt > slide.recovery.updatedAt;
    const adoptLayers = !slide.layers || (Boolean(remote.layers) && remoteNewerRecovery && slide.state !== "edited");
    const adoptRaster = remote.version > slide.version;
    return {
      ...slide,
      recovery: remoteNewerRecovery ? remote.recovery : slide.recovery,
      history: remote.history.length >= slide.history.length ? remote.history : slide.history,
      version: Math.max(remote.version, slide.version),
      ...(adoptRaster ? { assetId: remote.assetId, canvas: remote.canvas, copy: remote.copy } : {}),
      ...(adoptLayers ? { layers: remote.layers, state: remote.layers ? remote.state : slide.state } : {}),
    };
  });
  const assetIds = new Set(local.assets.map((asset) => asset.id));
  const assets = [...local.assets, ...server.assets.filter((asset) => !assetIds.has(asset.id))];
  const fontIds = new Set(local.fonts.map((font) => font.id));
  const fonts = [...local.fonts, ...server.fonts.filter((font) => !fontIds.has(font.id))];
  return { ...local, slides, assets, fonts, revision: Math.max(local.revision, server.revision) };
}
