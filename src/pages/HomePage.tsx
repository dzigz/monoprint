import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fileToBase64 } from "../app/api";
import type { Route } from "../app/router";
import type { AppConfig, DeckSummary } from "../shared/types";
import { Button, Eyebrow, StatusDot, Wordmark, formatDate } from "../ui/primitives";

type PendingAttachment =
  | { key: string; kind: "file"; file: File }
  | { key: string; kind: "folder"; path: string; name: string }
  | { key: string; kind: "link"; url: string };

const LINK_PATTERN = /https?:\/\/[^\s<>()"']+/g;

export function HomePage({ config, navigate }: { config?: AppConfig; navigate: (route: Route) => void }) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api.decks().then(({ decks: list }) => setDecks(list)).catch(() => setDecks([]));
  }, []);

  const detectedLinks = useMemo(() => {
    const matches = prompt.match(LINK_PATTERN) ?? [];
    return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
  }, [prompt]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const next = [...files].map((file) => ({ key: `${file.name}-${file.size}-${file.lastModified}`, kind: "file" as const, file }));
    setAttachments((current) => [...current, ...next.filter((item) => !current.some((existing) => existing.key === item.key))]);
  }, []);

  async function chooseFolder() {
    try {
      const chosen = await api.pickFolder();
      if (!chosen) return;
      setAttachments((current) => [...current.filter((item) => item.kind !== "folder"), { key: `folder-${chosen.path}`, kind: "folder", path: chosen.path, name: chosen.name }]);
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : "No folder chosen.");
    }
  }

  async function create() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const payload = [];
      for (const item of attachments) {
        if (item.kind === "file") {
          payload.push({ kind: "file", name: item.file.name, mimeType: item.file.type || undefined, dataBase64: await fileToBase64(item.file) });
        } else if (item.kind === "folder") {
          payload.push({ kind: "folder", path: item.path });
        } else {
          payload.push({ kind: "link", url: item.url });
        }
      }
      const { generation } = await api.generate({ prompt: prompt.trim(), attachments: payload });
      navigate({ name: "working", generationId: generation.id });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The presentation could not be started.");
      setBusy(false);
    }
  }

  const canCreate = Boolean(prompt.trim()) && !busy && Boolean(config?.generationConfigured);

  return (
    <main className="home">
      <header className="home__header">
        <Wordmark />
        <span className="home__tagline">Every slide is a print. Every word stays editable.</span>
      </header>

      <section className="home__hero">
        <Eyebrow>New presentation</Eyebrow>
        <div
          className={`brief ${dragging ? "brief--dragging" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
          }}
        >
          <textarea
            className="brief__prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the presentation you need. Who it is for, what it should change in their understanding, how many slides, the tone. Paste links. Drop files anywhere here."
            rows={6}
            disabled={busy}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void create();
            }}
          />
          {(attachments.length > 0 || detectedLinks.length > 0) && (
            <ul className="brief__chips">
              {attachments.map((item) => (
                <li key={item.key} className={`chip chip--${item.kind}`}>
                  <span className="chip__kind">{item.kind}</span>
                  <span className="chip__name">{item.kind === "file" ? item.file.name : item.kind === "folder" ? item.name : item.url}</span>
                  <button type="button" className="chip__remove" aria-label="Remove" onClick={() => setAttachments((current) => current.filter((existing) => existing.key !== item.key))}>×</button>
                </li>
              ))}
              {detectedLinks.map((url) => (
                <li key={url} className="chip chip--link chip--detected" title="Found in the prompt">
                  <span className="chip__kind">link</span>
                  <span className="chip__name">{url}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="brief__actions">
            <div className="brief__tools">
              <Button variant="quiet" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>Add files</Button>
              {config?.platform === "darwin" && <Button variant="quiet" size="sm" onClick={() => void chooseFolder()} disabled={busy}>Choose folder</Button>}
              <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
              <span className="brief__hint">{config ? `${config.fontCatalogSize} fonts on this machine` : "Connecting…"}</span>
            </div>
            <Button variant="primary" size="lg" onClick={() => void create()} disabled={!canCreate}>{busy ? "Starting…" : "Create presentation"}</Button>
          </div>
        </div>
        {config && !config.generationConfigured && <p className="notice notice--warn">Add OPENAI_API_KEY to .env.local to enable generation.</p>}
        {config && !config.recovery.available && <p className="notice">Text recovery is offline: {config.recovery.detail}</p>}
        {error && <p className="notice notice--bad" role="alert">{error}</p>}
      </section>

      <section className="home__decks">
        <div className="section-heading">
          <Eyebrow>Past decks</Eyebrow>
          <span className="section-heading__count">{decks.length}</span>
        </div>
        {decks.length === 0 ? (
          <p className="empty">Nothing yet. The first deck you create appears here.</p>
        ) : (
          <ul className="deck-grid">
            {decks.map((deck) => (
              <li key={deck.id}>
                <button
                  type="button"
                  className="deck-card"
                  onClick={() => navigate(deck.status === "generating" || deck.status === "interrupted" || deck.status === "failed"
                    ? { name: "working", generationId: deck.id }
                    : { name: "deck", deckId: deck.id })}
                >
                  <span className="deck-card__cover">
                    {deck.coverAssetUrl ? <img src={deck.coverAssetUrl} alt="" /> : <span className="deck-card__blank" />}
                  </span>
                  <span className="deck-card__body">
                    <span className="deck-card__title">{deck.title}</span>
                    <span className="deck-card__meta">
                      <StatusDot tone={deck.status === "ready" ? "ok" : deck.status === "generating" ? "busy" : deck.status === "failed" ? "bad" : "warn"} />
                      {deck.status === "ready"
                        ? `${deck.slideCount} slides · ${deck.recoveredSlides === deck.slideCount ? "editable" : `${deck.recoveredSlides}/${deck.slideCount} editable`}`
                        : deck.status === "generating" ? "Generating" : deck.status === "failed" ? "Stopped" : "Interrupted"}
                      <span className="deck-card__date">{formatDate(deck.updatedAt)}</span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
