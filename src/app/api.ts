import type {
  AppConfig,
  Deck,
  DeckSummary,
  EditRequest,
  EditResponse,
  GenerationRecord,
  RecoveryJob,
  RepaintJob,
} from "../shared/types";
import type { EditCommand } from "../shared/commands";

type ApiError = { error?: string };

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export const api = {
  config: () => request<AppConfig>("/api/config"),
  decks: () => request<{ decks: DeckSummary[] }>("/api/decks"),
  deck: (deckId: string) => request<{ deck: Deck; recovery?: RecoveryJob; repaint?: RepaintJob }>(`/api/decks/${deckId}`),
  commands: (deckId: string, commands: EditCommand[]) => request<{ deck: Deck }>(`/api/decks/${deckId}/commands`, { method: "POST", body: JSON.stringify({ commands }) }),
  edit: (deckId: string, body: EditRequest) => request<EditResponse>(`/api/decks/${deckId}/edit`, { method: "POST", body: JSON.stringify(body) }),
  repaint: (deckId: string, slideId: string, instruction: string) => request<{ job: RepaintJob }>(`/api/decks/${deckId}/slides/${slideId}/repaint`, { method: "POST", body: JSON.stringify({ instruction }) }),
  bake: (deckId: string, slideId: string, image: string) => request<{ deck: Deck; assetUrl: string }>(`/api/decks/${deckId}/slides/${slideId}/bake`, { method: "POST", body: JSON.stringify({ image }) }),
  focusRegions: (deckId: string, slideId: string, inputKey: string, options: { image?: string; retry?: boolean } = {}) => request<{ deck: Deck }>(`/api/decks/${deckId}/slides/${slideId}/focus-regions`, { method: "POST", body: JSON.stringify({ inputKey, ...options }) }),
  startRecovery: (deckId: string, slideIds?: string[], force = false, fresh = false) => request<{ job: RecoveryJob }>(`/api/decks/${deckId}/recovery`, { method: "POST", body: JSON.stringify({ slideIds, force, fresh }) }),
  consolidateFonts: (deckId: string, expectedRevision: number, slideIds?: string[]) => request<{ deck: Deck; summary: import("../shared/types").FontConsolidationSummary }>(`/api/decks/${deckId}/consolidate-fonts`, { method: "POST", body: JSON.stringify({ slideIds, expectedRevision }) }),
  exportPptx: (deckId: string, expectedRevision: number) => request<{ deck: Deck; summary: import("../shared/types").FontConsolidationSummary; report: import("../shared/types").PptxExportReport; downloadUrl: string; filename: string }>(`/api/decks/${deckId}/pptx`, { method: "POST", body: JSON.stringify({ expectedRevision }) }),
  cancelRecovery: (deckId: string) => request<{ job?: RecoveryJob }>(`/api/decks/${deckId}/recovery/cancel`, { method: "POST", body: "{}" }),
  generate: (body: { prompt: string; attachments: unknown[] }) => request<{ generation: GenerationRecord }>("/api/generate", { method: "POST", body: JSON.stringify(body) }),
  generation: (generationId: string) => request<{ generation: GenerationRecord }>(`/api/generations/${generationId}`),
  generations: () => request<{ generations: GenerationRecord[] }>("/api/generations"),
  resume: (generationId: string) => request<{ generation: GenerationRecord }>(`/api/generations/${generationId}/resume`, { method: "POST", body: "{}" }),
  cancel: (generationId: string) => request<{ generation: GenerationRecord }>(`/api/generations/${generationId}/cancel`, { method: "POST", body: "{}" }),
  pickFolder: () => request<{ path: string; name: string } | undefined>("/api/pick-folder", { method: "POST", body: "{}" }),
};

export function subscribeGeneration(generationId: string, onStatus: (record: GenerationRecord) => void) {
  const events = new EventSource(`/api/generations/${generationId}/events`);
  events.addEventListener("status", ((event: MessageEvent<string>) => onStatus(JSON.parse(event.data) as GenerationRecord)) as EventListener);
  return () => events.close();
}

export function subscribeDeck(
  deckId: string,
  handlers: { onDeck?: (deck: Deck) => void; onRecovery?: (job: RecoveryJob) => void; onRepaint?: (job: RepaintJob) => void },
) {
  const events = new EventSource(`/api/decks/${deckId}/events`);
  events.addEventListener("deck", ((event: MessageEvent<string>) => handlers.onDeck?.(JSON.parse(event.data) as Deck)) as EventListener);
  events.addEventListener("recovery", ((event: MessageEvent<string>) => handlers.onRecovery?.(JSON.parse(event.data) as RecoveryJob)) as EventListener);
  events.addEventListener("repaint", ((event: MessageEvent<string>) => handlers.onRepaint?.(JSON.parse(event.data) as RepaintJob)) as EventListener);
  return () => events.close();
}

export async function fileToBase64(file: File) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
