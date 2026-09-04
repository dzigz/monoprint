import path from "node:path";
import { access, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { deckSchema, migrateDeck, type AssetDimensions } from "../src/shared/schema.js";
import type {
  AssetRecoveryRecord,
  Deck,
  DeckAsset,
  DeckSummary,
  GenerationRecord,
  RecoveryJob,
  RepaintJob,
} from "../src/shared/types.js";
import { imageDimensions } from "./recovery/plate.js";

const latestFileName = "latest";
const latestGenerationFileName = "latest-generation";
const deckFileName = "deck.json";
const assetsFileName = "assets.json";
const generationFileName = "generation.json";
const runStateFileName = "run-state.json";
const recoveryFileName = "recovery.json";
const repaintFileName = "repaint.json";

function safeId(id: string) {
  if (!id || path.basename(id) !== id || id.startsWith(".")) throw new Error("Invalid deck identifier.");
  return id;
}

function requestHeadline(generation: GenerationRecord) {
  const request = generation.request as { prompt?: string; objective?: string };
  return (request.prompt ?? request.objective ?? "Untitled brief").split("\n")[0].slice(0, 80);
}

function safeName(name: string) {
  const base = path.basename(name).replace(/[^A-Za-z0-9._ -]+/g, "_").trim();
  if (!base || base.startsWith(".")) throw new Error("Invalid file name.");
  return base;
}

export class DeckStore {
  private readonly deckWrites = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  directory(deckId: string) {
    return path.join(this.root, safeId(deckId));
  }

  async prepare(deckId: string) {
    const directory = this.directory(deckId);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  assetPath(deckId: string, fileName: string) {
    return path.join(this.directory(deckId), safeName(fileName));
  }

  attachmentsDirectory(deckId: string) {
    return path.join(this.directory(deckId), "attachments");
  }

  fontsDirectory(deckId: string) {
    return path.join(this.directory(deckId), "fonts");
  }

  // ---------------------------------------------------------------- decks

  async save(deck: Deck) {
    const directory = await this.prepare(deck.id);
    const previous = this.deckWrites.get(deck.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await writeFile(path.join(directory, deckFileName), JSON.stringify(deck, null, 2), "utf8");
    });
    this.deckWrites.set(deck.id, next);
    await next;
    if (this.deckWrites.get(deck.id) === next) this.deckWrites.delete(deck.id);
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, latestFileName), deck.id, "utf8");
  }

  async hasDeck(deckId: string) {
    try {
      await access(path.join(this.directory(deckId), deckFileName));
      return true;
    } catch {
      return false;
    }
  }

  /** Load a deck, upgrading older schema versions in place. */
  async load(deckId: string): Promise<Deck> {
    const directory = this.directory(deckId);
    const raw = JSON.parse(await readFile(path.join(directory, deckFileName), "utf8")) as { schemaVersion?: unknown; assets?: unknown };
    if (raw.schemaVersion === 4) return deckSchema.parse(raw);

    const assetDimensions: AssetDimensions = {};
    for (const asset of Array.isArray(raw.assets) ? raw.assets as Array<{ id?: string; url?: string }> : []) {
      if (!asset.id || !asset.url) continue;
      try {
        assetDimensions[asset.id] = await imageDimensions(path.join(directory, path.basename(asset.url)));
      } catch {
        // Missing image files keep the default canvas.
      }
    }
    let createdAt: string | undefined;
    try {
      createdAt = (await stat(path.join(directory, deckFileName))).mtime.toISOString();
    } catch {
      // Fall back to now.
    }
    const migrated = migrateDeck(raw, { assetDimensions, createdAt });
    await this.save(migrated);
    return migrated;
  }

  async loadLatest() {
    const deckId = (await readFile(path.join(this.root, latestFileName), "utf8")).trim();
    return this.load(deckId);
  }

  async listDeckIds() {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      ids.push(entry.name);
    }
    return ids;
  }

  async summaries(): Promise<DeckSummary[]> {
    const summaries: DeckSummary[] = [];
    for (const id of await this.listDeckIds()) {
      const directory = this.directory(id);
      let generation: GenerationRecord | undefined;
      try {
        generation = JSON.parse(await readFile(path.join(directory, generationFileName), "utf8")) as GenerationRecord;
      } catch {
        generation = undefined;
      }
      let deck: Deck | undefined;
      try {
        deck = await this.load(id);
      } catch {
        deck = undefined;
      }
      if (!deck && !generation) continue;
      if (deck) {
        const cover = deck.assets.find((asset) => asset.id === deck?.slides[0]?.assetId);
        summaries.push({
          id,
          title: deck.title,
          slideCount: deck.slides.length,
          coverAssetUrl: cover?.url,
          createdAt: deck.createdAt,
          updatedAt: deck.updatedAt,
          status: generation && (generation.status === "queued" || generation.status === "running") ? "generating" : "ready",
          recoveredSlides: deck.slides.filter((slide) => slide.layers).length,
        });
      } else if (generation) {
        summaries.push({
          id,
          title: generation.title ?? requestHeadline(generation),
          slideCount: generation.slideProgress?.length ?? 0,
          coverAssetUrl: generation.slideProgress?.find((slide) => slide.assetUrl)?.assetUrl,
          createdAt: generation.startedAt,
          updatedAt: generation.updatedAt,
          status: generation.status === "queued" || generation.status === "running"
            ? "generating"
            : generation.status === "failed" || generation.status === "cancelled"
              ? "failed"
              : "interrupted",
          recoveredSlides: 0,
        });
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // --------------------------------------------------------------- assets

  async saveAssets(deckId: string, assets: DeckAsset[]) {
    const directory = await this.prepare(deckId);
    await writeFile(path.join(directory, assetsFileName), JSON.stringify(assets, null, 2), "utf8");
  }

  async loadAssets(deckId: string) {
    return JSON.parse(await readFile(path.join(this.directory(deckId), assetsFileName), "utf8")) as DeckAsset[];
  }

  async saveAttachment(deckId: string, fileName: string, content: Buffer) {
    const directory = this.attachmentsDirectory(deckId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, safeName(fileName));
    await writeFile(target, content);
    return target;
  }

  // ------------------------------------------------------------- run state

  async saveRunState(deckId: string, serializedState: string) {
    const directory = await this.prepare(deckId);
    await writeFile(path.join(directory, runStateFileName), serializedState, "utf8");
  }

  async loadRunState(deckId: string) {
    return readFile(path.join(this.directory(deckId), runStateFileName), "utf8");
  }

  async hasRunState(deckId: string) {
    try {
      await access(path.join(this.directory(deckId), runStateFileName));
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ generation

  async saveGeneration(record: GenerationRecord) {
    const directory = await this.prepare(record.deckId);
    await writeFile(path.join(directory, generationFileName), JSON.stringify(record, null, 2), "utf8");
  }

  async loadGeneration(generationId: string) {
    return JSON.parse(
      await readFile(path.join(this.directory(generationId), generationFileName), "utf8"),
    ) as GenerationRecord;
  }

  async setLatestGeneration(generationId: string) {
    await mkdir(this.root, { recursive: true });
    await writeFile(path.join(this.root, latestGenerationFileName), safeId(generationId), "utf8");
  }

  async loadLatestGeneration() {
    const generationId = (await readFile(path.join(this.root, latestGenerationFileName), "utf8")).trim();
    return this.loadGeneration(generationId);
  }

  // -------------------------------------------------------------- recovery

  recoveryDirectory(deckId: string) {
    return path.join(this.directory(deckId), "recovery");
  }

  /** Recovery results produced before the deck document exists, keyed by asset id. */
  async saveAssetRecovery(deckId: string, record: AssetRecoveryRecord) {
    const directory = this.recoveryDirectory(deckId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${safeName(record.assetId)}.json`), JSON.stringify(record, null, 2), "utf8");
  }

  async listAssetRecoveries(deckId: string): Promise<AssetRecoveryRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.recoveryDirectory(deckId));
    } catch {
      return [];
    }
    const records: AssetRecoveryRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.recoveryDirectory(deckId), entry), "utf8")) as AssetRecoveryRecord);
      } catch {
        // Skip unreadable records.
      }
    }
    return records;
  }

  async deleteAssetRecovery(deckId: string, assetId: string) {
    await rm(path.join(this.recoveryDirectory(deckId), `${safeName(assetId)}.json`), { force: true });
  }

  async saveRecoveryJob(job: RecoveryJob) {
    const directory = await this.prepare(job.deckId);
    await writeFile(path.join(directory, recoveryFileName), JSON.stringify(job, null, 2), "utf8");
  }

  async loadRecoveryJob(deckId: string) {
    return JSON.parse(await readFile(path.join(this.directory(deckId), recoveryFileName), "utf8")) as RecoveryJob;
  }

  async saveRepaintJob(job: RepaintJob) {
    const directory = await this.prepare(job.deckId);
    await writeFile(path.join(directory, repaintFileName), JSON.stringify(job, null, 2), "utf8");
  }
}
