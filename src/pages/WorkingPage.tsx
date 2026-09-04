import { useEffect, useMemo, useState } from "react";
import { api, subscribeDeck, subscribeGeneration } from "../app/api";
import type { Route } from "../app/router";
import type { Deck, GenerationRecord, NarrativeUpdate, Slide, SlideGenerationProgress } from "../shared/types";
import { Button, Eyebrow, StatusDot, Wordmark, elapsedLabel } from "../ui/primitives";

function isActive(record?: GenerationRecord) {
  return record?.status === "queued" || record?.status === "running";
}

function statusLine(record: GenerationRecord) {
  if (record.status === "completed") return "Presentation ready.";
  if (record.status === "failed") return record.error ?? "Generation stopped after an error.";
  if (record.status === "cancelled") return "Stopped.";
  if (record.status === "interrupted") return "Interrupted. Resume to continue from the last checkpoint.";
  const painting = (record.slideProgress ?? []).filter((slide) => slide.status === "completed").length;
  const total = record.slideProgress?.length ?? 0;
  switch (record.phase) {
    case "queued": return "Queued.";
    case "connecting": return "Starting the author.";
    case "reading_attachments": return "Reading your sources.";
    case "inspecting_repository": return "Reading the codebase.";
    case "researching": return "Searching the web.";
    case "reasoning": return record.narrativeUpdates?.some((update) => update.stage === "ready_to_render") ? "Preparing slides." : "Planning the story.";
    case "generating_image": return total ? `Painting slide ${Math.min(total, painting + 1)} of ${total}.` : "Painting slides.";
    case "validating": return "Checking the deck.";
    case "publishing": return "Publishing.";
    case "recovering": return "Recovering from the last checkpoint.";
    default: return record.message;
  }
}

type Stage = { label: string; tone: "idle" | "busy" | "ok" | "warn" | "bad"; className: string };

/** Where a slide is in its pipeline: waiting, painting, painted, recovering text, editable. */
function stageOf(progress?: SlideGenerationProgress, published?: Slide): Stage {
  const recovery = published?.recovery.status ?? progress?.recovery;
  if (progress?.status === "failed") return { label: "painting failed", tone: "bad", className: "failed" };
  if (progress?.status === "cancelled") return { label: "stopped", tone: "warn", className: "cancelled" };
  if (progress?.status === "generating") return { label: "painting", tone: "busy", className: "generating" };
  if (progress?.status !== "completed" && !published) return { label: "waiting", tone: "idle", className: "waiting" };
  switch (recovery) {
    case "recovered": return { label: "editable", tone: "ok", className: "editable" };
    case "running": return { label: "recovering text", tone: "busy", className: "recovering" };
    case "queued": return { label: "painted · text queued", tone: "busy", className: "recovering" };
    case "failed": return { label: "painted · text failed", tone: "bad", className: "failed" };
    default: return { label: "painted · text next", tone: "warn", className: "painted" };
  }
}

function latest(updates: NarrativeUpdate[] | undefined, stage: NarrativeUpdate["stage"]) {
  return [...(updates ?? [])].reverse().find((update) => update.stage === stage);
}

export function WorkingPage({ generationId, navigate }: { generationId: string; navigate: (route: Route, options?: { replace?: boolean }) => void }) {
  const [record, setRecord] = useState<GenerationRecord>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [notesOpen, setNotesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [deck, setDeck] = useState<Deck>();

  // Once the deck is published, follow its recovery from the deck's own event stream.
  useEffect(() => {
    if (record?.status !== "completed") return;
    let cancelled = false;
    api.deck(record.deckId).then(({ deck: loaded }) => { if (!cancelled) setDeck(loaded); }).catch(() => {});
    const unsubscribe = subscribeDeck(record.deckId, { onDeck: (next) => { if (!cancelled) setDeck(next); } });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [record?.status, record?.deckId]);

  useEffect(() => {
    let unsubscribe = () => {};
    api.generation(generationId)
      .then(({ generation }) => {
        setRecord(generation);
        if (isActive(generation)) unsubscribe = subscribeGeneration(generationId, setRecord);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "This run could not be loaded."));
    return () => unsubscribe();
  }, [generationId]);

  useEffect(() => {
    if (!isActive(record)) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [record?.status]);

  useEffect(() => {
    if (record && !isActive(record) && record.status !== "completed") return;
    if (record && isActive(record)) {
      const stop = subscribeGeneration(generationId, setRecord);
      return stop;
    }
  }, [generationId, record?.status === "queued" || record?.status === "running"]);

  const framing = latest(record?.narrativeUpdates, "framing");
  const storyboard = latest(record?.narrativeUpdates, "ready_to_render") ?? latest(record?.narrativeUpdates, "storyboard");
  const artDirection = latest(record?.narrativeUpdates, "art_direction");
  const research = (record?.narrativeUpdates ?? []).filter((update) => update.stage === "research_update");
  const progress = useMemo(() => new Map((record?.slideProgress ?? []).map((slide) => [slide.slideNumber, slide])), [record?.slideProgress]);
  const publishedSlides = useMemo(() => new Map((deck?.slides ?? []).map((slide) => [slide.id, slide])), [deck]);
  const plan = storyboard?.slides ?? [];
  const requestText = (record?.request as { prompt?: string; objective?: string } | undefined);
  const title = record?.title ?? storyboard?.title ?? (requestText?.prompt ?? requestText?.objective ?? "Presentation").split("\n")[0].slice(0, 90);

  async function stop() {
    try {
      const { generation } = await api.cancel(generationId);
      setRecord(generation);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not stop.");
    }
  }

  async function resume() {
    try {
      const { generation } = await api.resume(generationId);
      setRecord(generation);
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : "Could not resume.");
    }
  }

  if (!record) {
    return (
      <main className="working">
        <header className="topbar"><Wordmark onClick={() => navigate({ name: "home" })} /></header>
        <p className="empty">{error ?? "Loading…"}</p>
      </main>
    );
  }

  const tone = record.status === "completed" ? "ok" : isActive(record) ? "busy" : record.status === "failed" ? "bad" : "warn";
  void tick;

  return (
    <main className="working">
      <header className="topbar">
        <Wordmark onClick={() => navigate({ name: "home" })} />
        <div className="topbar__title">
          <Eyebrow>Working</Eyebrow>
          <h1>{title}</h1>
        </div>
        <div className="topbar__status">
          <StatusDot tone={tone} />
          <span className="topbar__status-text">{statusLine(record)}</span>
          <span className="topbar__elapsed">{elapsedLabel(record.startedAt, record.completedAt)}</span>
        </div>
        <div className="topbar__actions">
          {isActive(record) && <Button variant="danger" onClick={() => void stop()}>Stop</Button>}
          {!isActive(record) && record.resumable && record.status !== "completed" && <Button onClick={() => void resume()}>Resume</Button>}
          {record.status === "completed" && <Button variant="primary" onClick={() => navigate({ name: "deck", deckId: record.deckId })}>Open deck</Button>}
        </div>
      </header>

      {error && <p className="notice notice--bad" role="alert">{error}</p>}

      <div className="working__body">
        <section className="decisions" aria-label="Author's decisions">
          <article className={`card ${framing ? "card--ready" : "card--pending"}`}>
            <Eyebrow>What it understood</Eyebrow>
            {framing ? (
              <>
                <p className="card__lead">{framing.summary}</p>
                <dl className="card__facts">
                  {framing.audience && <><dt>Audience</dt><dd>{framing.audience}</dd></>}
                  {framing.thesis && <><dt>Thesis</dt><dd>{framing.thesis}</dd></>}
                  {framing.audienceTakeaway && <><dt>Takeaway</dt><dd>{framing.audienceTakeaway}</dd></>}
                  {framing.requestedSlideCount && <><dt>Slides</dt><dd>{framing.requestedSlideCount}, as requested</dd></>}
                </dl>
              </>
            ) : <p className="card__placeholder">Reading the brief…</p>}
          </article>

          <article className={`card ${record.sourceActivity?.length ? "card--ready" : "card--pending"}`}>
            <Eyebrow>Sources it read</Eyebrow>
            {record.sourceActivity?.length ? (
              <ul className="source-list">
                {record.sourceActivity.map((activity) => (
                  <li key={activity.id}><span className={`source-kind source-kind--${activity.kind}`}>{activity.kind}</span>{activity.label}</li>
                ))}
              </ul>
            ) : <p className="card__placeholder">{isActive(record) ? "Nothing read yet." : "No outside sources were read."}</p>}
            {research.length > 0 && (
              <ul className="research-notes">
                {research.map((update) => <li key={update.id}>{update.summary}</li>)}
              </ul>
            )}
          </article>

          <article className={`card ${storyboard ? "card--ready" : "card--pending"}`}>
            <Eyebrow>Storyboard</Eyebrow>
            {storyboard ? (
              <ol className="storyboard">
                {plan.map((slide) => (
                  <li key={slide.slideId}>
                    <span className="storyboard__number">{String(slide.slideNumber).padStart(2, "0")}</span>
                    <span className="storyboard__title">{slide.title}</span>
                    <span className="storyboard__purpose">{slide.purpose}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="card__placeholder">The slide plan appears once the story is settled.</p>}
          </article>

          <article className={`card ${artDirection ? "card--ready" : "card--pending"}`}>
            <Eyebrow>Visual direction</Eyebrow>
            {artDirection ? (
              <>
                <p className="card__lead">{artDirection.designDirection ?? artDirection.summary}</p>
                {artDirection.designDirection && <p className="card__body">{artDirection.summary}</p>}
              </>
            ) : <p className="card__placeholder">Fonts, palette, and the visual premise appear after the storyboard.</p>}
          </article>

          <details className="fold" open={notesOpen} onToggle={(event) => setNotesOpen((event.target as HTMLDetailsElement).open)}>
            <summary>Author's notes</summary>
            <div className="fold__body">
              {(record.workingNotes ?? []).length === 0
                ? <p className="card__placeholder">No notes yet.</p>
                : record.workingNotes?.map((note) => (
                    <p key={note.id} className={`note note--${note.status}`}>{note.text}</p>
                  ))}
            </div>
          </details>

          <details className="fold" open={detailsOpen} onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}>
            <summary>Details</summary>
            <div className="fold__body">
              <dl className="card__facts">
                <dt>Phase</dt><dd>{record.phase}</dd>
                <dt>Attempt</dt><dd>{Math.max(1, record.attempts)}</dd>
                <dt>Turn</dt><dd>{record.turn || "—"}</dd>
                <dt>Images</dt><dd>{record.imagesGenerated}</dd>
                <dt>Run</dt><dd><code>{record.id}</code></dd>
              </dl>
              <p className="card__body">{record.message}</p>
            </div>
          </details>
        </section>

        <section className="slide-grid-panel" aria-label="Slides">
          <div className="section-heading">
            <Eyebrow>Slides</Eyebrow>
            <span className="section-heading__count">{plan.length || "—"}</span>
            <span className="section-heading__note">Each slide is painted, then its text is recovered so it becomes editable.{record.status === "completed" ? " Click a slide to open it." : ""}</span>
          </div>
          {plan.length === 0 ? (
            <p className="empty">Tiles appear when the storyboard is ready.</p>
          ) : (
            <ul className="tile-grid">
              {plan.map((slide) => {
                const state = progress.get(slide.slideNumber);
                const published = publishedSlides.get(slide.slideId);
                const stage = stageOf(state, published);
                const openable = record.status === "completed";
                const body = (
                  <>
                    <div className="tile__image">
                      {state?.assetUrl ? <img src={state.assetUrl} alt={slide.title} /> : <div className="tile__blank" />}
                    </div>
                    <div className="tile__caption">
                      <span className="tile__number">{String(slide.slideNumber).padStart(2, "0")}</span>
                      <span className="tile__title">{published?.title ?? slide.title}</span>
                      <span className="tile__status"><StatusDot tone={stage.tone} />{stage.label}</span>
                    </div>
                  </>
                );
                return (
                  <li key={slide.slideId} className={`tile tile--${stage.className}`}>
                    {openable
                      ? <button type="button" className="tile__open" onClick={() => navigate({ name: "deck", deckId: record.deckId, slideId: slide.slideId })}>{body}</button>
                      : body}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
