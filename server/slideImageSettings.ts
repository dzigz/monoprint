import type { ImageEditParams } from "openai/resources/images";

// Shared by initial generation and repaint so quality can be changed in one place.
export const SLIDE_IMAGE_SETTINGS = {
  model: "gpt-image-2.5-sunburst",
  // The API supports xhigh, but the installed SDK's quality union predates it.
  // This assertion only bridges the SDK types; the request sends "xhigh".
  quality: "xhigh" as ImageEditParams["quality"],
} as const;
