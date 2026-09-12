import type { Deck } from "../shared/types";

/** Print the saved editor layout as native PDF text with JPEG 95 backgrounds. */
export async function exportDeckToPdf(
  deck: Deck,
  onProgress: (completed: number, total: number) => void = () => {},
): Promise<Blob> {
  onProgress(0, deck.slides.length);
  const response = await fetch(`/api/decks/${encodeURIComponent(deck.id)}/pdf`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: deck.revision }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "PDF export failed. Please try again.");
  }
  const blob = await response.blob();
  onProgress(deck.slides.length, deck.slides.length);
  return blob;
}

export function downloadPdf(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "Presentation"}.pdf`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to finish handing the Blob to its download manager.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
