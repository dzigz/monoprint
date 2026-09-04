import assert from "node:assert/strict";
import test from "node:test";
import { copyFormDataForUndici, undiciFetchWithUploadSupport } from "./openaiClient.js";

test("adapts global FormData for the matching Undici fetch implementation", async () => {
  const source = new FormData();
  source.append("prompt", "Render the slide");
  source.append("image", new File(["reference"], "anchor.png", { type: "image/png" }));

  const copy = copyFormDataForUndici(source);
  const entries = [...copy.entries()];
  assert.equal(entries[0]?.[0], "prompt");
  assert.equal(entries[0]?.[1], "Render the slide");
  assert.equal(entries[1]?.[0], "image");
  assert.equal(typeof entries[1]?.[1], "object");
  assert.equal((entries[1]?.[1] as File).name, "anchor.png");

  assert.equal(
    (undiciFetchWithUploadSupport as typeof globalThis.fetch & { Response?: typeof Response }).Response,
    globalThis.Response,
  );
});
