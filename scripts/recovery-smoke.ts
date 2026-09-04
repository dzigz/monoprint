// Smoke test: recover one slide of an existing deck through the sidecar adapter.
// Usage: npx tsx scripts/recovery-smoke.ts <deckId> [slideIndex]
import path from "node:path";
import { homedir } from "node:os";
import { DeckMutations } from "../server/deckMutations.js";
import { DeckStore } from "../server/deckStore.js";
import { loadFontCatalog } from "../server/fontCatalog.js";
import { FontRegistry } from "../server/fonts.js";
import { SidecarRecoveryProvider } from "../server/recovery/sidecarProvider.js";
import { RecoveryManager } from "../server/recoveryManager.js";

const [deckId, slideIndexArg] = process.argv.slice(2);
if (!deckId) throw new Error("deckId required");
const slideIndex = Number(slideIndexArg ?? 0);
const artifactsRoot = path.resolve("artifacts");
const catalog = await loadFontCatalog(["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", path.join(homedir(), "Library/Fonts")]);
const fonts = new FontRegistry(catalog, artifactsRoot);
const store = new DeckStore(artifactsRoot);
const mutations = new DeckMutations(store, fonts);
const provider = new SidecarRecoveryProvider({
  baseUrl: "http://127.0.0.1:4174",
  runsDirectory: path.join(homedir(), "Documents/font_matching_proto/runs/docedit/v4"),
  docPrefix: process.env.SIDECAR_DOC_PREFIX ?? "kn",
  reuseRuns: true,
  designAgent: true,
  fontRegistry: fonts,
});
const manager = new RecoveryManager(store, mutations, fonts, provider);
const deck = await mutations.load(deckId);
const slide = deck.slides[slideIndex];
console.log("deck", deck.title, "slides", deck.slides.length, "target", slide.id, slide.assetId.slice(0, 8), "fonts", deck.fonts.length);
const started = Date.now();
mutations.subscribe(deckId, (event) => {
  if (event.type === "recovery") console.log("job:", event.job.status, event.job.message);
  if (event.type === "deck") {
    const s = event.deck.slides[slideIndex];
    console.log("slide:", s.recovery.status, s.recovery.message ?? "", s.recovery.error ?? "");
  }
});
await manager.enqueue(deckId, [slide.id], { force: true });
while (true) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  const current = await mutations.load(deckId);
  const status = current.slides[slideIndex].recovery.status;
  if (status === "recovered" || status === "failed") {
    const final = current.slides[slideIndex];
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s:`, status, final.recovery.error ?? "");
    for (const object of final.layers?.objects ?? []) {
      if (object.kind !== "text") continue;
      console.log(`- [${object.style.fontRole}/${object.copyRole ?? "?"}] ${JSON.stringify(object.text).slice(0, 60)} @ (${object.frame.x.toFixed(0)},${object.frame.y.toFixed(0)}) ${object.frame.width.toFixed(0)}x${object.frame.height.toFixed(0)} size ${object.style.fontSize} lh ${object.style.lineHeight} ${object.style.align} ${object.style.color} font ${object.style.fontId}`);
    }
    console.log("deck fonts:", current.fonts.map((font) => `${font.id} ${font.family} ${font.subfamily} ${font.url}`).join("\n  "));
    console.log("plate:", current.assets.find((asset) => asset.id === final.layers?.plateAssetId)?.url);
    break;
  }
}
process.exit(0);
