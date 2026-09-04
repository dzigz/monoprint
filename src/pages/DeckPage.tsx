import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../app/api";
import type { Route } from "../app/router";
import { SlideCanvas } from "../editor/SlideCanvas";
import { PromptPanel } from "../editor/PromptPanel";
import { renderSlideToDataUrl } from "../editor/snapshot";
import { stepFontSize, Toolbar } from "../editor/Toolbar";
import { useDeckEditor } from "../editor/useDeckEditor";
import type { AppConfig, Deck, Slide, TextObject } from "../shared/types";
import { FONT_ROLE_NAMES } from "../shared/types";
import { Button, Eyebrow, StatusDot, Wordmark, formatDate } from "../ui/primitives";

function recoveryLabel(slide: Slide) {
  switch (slide.recovery.status) {
    case "recovered": return slide.state === "edited" ? "Edited" : "Editable";
    case "running": return "Recovering text";
    case "queued": return "Waiting for text recovery";
    case "failed": return "Text recovery failed";
    case "skipped": return "Not recovered";
    default: return "Text recovery pending";
  }
}

export function DeckPage({ deckId, slideId, config, navigate }: { deckId: string; slideId?: string; config?: AppConfig; navigate: (route: Route, options?: { replace?: boolean }) => void }) {
  const editor = useDeckEditor(deckId);
  const { deck } = editor;
  const [selectedObjectId, setSelectedObjectId] = useState<string>();
  const [editingObjectId, setEditingObjectId] = useState<string>();
  const [stageWidth, setStageWidth] = useState(960);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const stageRef = useRef<HTMLDivElement>(null);
  const heightsRef = useRef(new Map<string, number>());

  const activeSlide = useMemo(() => deck?.slides.find((slide) => slide.id === slideId) ?? deck?.slides[0], [deck, slideId]);
  const activeIndex = deck && activeSlide ? deck.slides.indexOf(activeSlide) : 0;
  const selectedObject = activeSlide?.layers?.objects.find((object) => object.id === selectedObjectId) as TextObject | undefined;

  useEffect(() => {
    setSelectedObjectId(undefined);
    setEditingObjectId(undefined);
  }, [activeSlide?.id]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const aspect = activeSlide ? activeSlide.canvas.width / activeSlide.canvas.height : 16 / 9;
      const maxWidth = bounds.width - 48;
      const maxHeight = bounds.height - 48;
      setStageWidth(Math.max(320, Math.min(maxWidth, maxHeight * aspect)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [activeSlide?.canvas.width, activeSlide?.canvas.height]);

  const goToSlide = useCallback((slide: Slide) => navigate({ name: "deck", deckId, slideId: slide.id }, { replace: true }), [deckId, navigate]);

  useEffect(() => {
    if (!deck || !activeSlide) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        if (typing && !editingObjectId) return;
        event.preventDefault();
        if (event.shiftKey) editor.redo(); else editor.undo();
        return;
      }
      if (typing) return;
      if (event.key === "ArrowRight" && !selectedObject && activeIndex < deck.slides.length - 1) { goToSlide(deck.slides[activeIndex + 1]); return; }
      if (event.key === "ArrowLeft" && !selectedObject && activeIndex > 0) { goToSlide(deck.slides[activeIndex - 1]); return; }
      if (!selectedObject) return;
      if (event.key === "Escape") { setSelectedObjectId(undefined); return; }
      if (event.key === "Enter") { event.preventDefault(); setEditingObjectId(selectedObject.id); return; }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        editor.dispatch({ type: "delete_object", slideId: activeSlide.id, objectId: selectedObject.id });
        setSelectedObjectId(undefined);
        return;
      }
      if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        editor.dispatch({ type: "move_object", slideId: activeSlide.id, objectId: selectedObject.id, x: selectedObject.frame.x + dx, y: selectedObject.frame.y + dy });
        return;
      }
      if (meta && event.key.toLowerCase() === "b") { event.preventDefault(); editor.dispatch({ type: "set_text_style", slideId: activeSlide.id, objectId: selectedObject.id, style: { bold: !selectedObject.style.bold } }); return; }
      if (meta && event.key.toLowerCase() === "i") { event.preventDefault(); editor.dispatch({ type: "set_text_style", slideId: activeSlide.id, objectId: selectedObject.id, style: { italic: !selectedObject.style.italic } }); return; }
      if (meta && event.shiftKey && (event.key === "." || event.key === ">")) { event.preventDefault(); editor.dispatch({ type: "set_text_style", slideId: activeSlide.id, objectId: selectedObject.id, style: { fontSize: stepFontSize(selectedObject.style.fontSize, 1) } }); return; }
      if (meta && event.shiftKey && (event.key === "," || event.key === "<")) { event.preventDefault(); editor.dispatch({ type: "set_text_style", slideId: activeSlide.id, objectId: selectedObject.id, style: { fontSize: stepFontSize(selectedObject.style.fontSize, -1) } }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deck, activeSlide, activeIndex, selectedObject, editingObjectId, editor, goToSlide]);

  async function exportPng() {
    if (!deck || !activeSlide) return;
    setExporting(true);
    try {
      const dataUrl = await renderSlideToDataUrl(deck, activeSlide, 1);
      const anchor = document.createElement("a");
      anchor.href = dataUrl;
      anchor.download = `${deck.title.replace(/[^\w-]+/g, "_")}-slide-${activeIndex + 1}.png`;
      anchor.click();
    } catch (error) {
      editor.setError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function bake() {
    if (!deck || !activeSlide) return;
    setExporting(true);
    try {
      const dataUrl = await renderSlideToDataUrl(deck, activeSlide, 1);
      const result = await api.bake(deck.id, activeSlide.id, dataUrl);
      editor.replaceDeck(result.deck, { record: false });
      setNotice(`Saved version ${result.deck.slides[activeIndex]?.version} of slide ${activeIndex + 1}.`);
      window.setTimeout(() => setNotice(undefined), 4000);
    } catch (error) {
      editor.setError(error instanceof Error ? error.message : "Bake failed.");
    } finally {
      setExporting(false);
    }
  }

  async function recover(slideIds?: string[], force = false, fresh = false) {
    if (!deck) return;
    try {
      await api.startRecovery(deck.id, slideIds, force, fresh);
    } catch (error) {
      editor.setError(error instanceof Error ? error.message : "Recovery could not start.");
    }
  }

  if (editor.loading || !deck || !activeSlide) {
    return (
      <main className="deck-page">
        <header className="topbar"><Wordmark onClick={() => navigate({ name: "home" })} /></header>
        <p className="empty">{editor.error ?? "Loading deck…"}</p>
      </main>
    );
  }

  const scale = stageWidth / activeSlide.canvas.width;
  const recoveryTone = editor.recovery?.status === "running" || editor.recovery?.status === "queued" ? "busy" : editor.recovery?.status === "failed" ? "bad" : "ok";
  const pendingSlides = deck.slides.filter((slide) => slide.recovery.status === "pending" || slide.recovery.status === "failed");
  const recovering = deck.slides.some((slide) => slide.recovery.status === "running" || slide.recovery.status === "queued");
  const repaintActive = editor.repaint && (editor.repaint.status === "queued" || editor.repaint.status === "running");
  const measuredHeight = selectedObject ? heightsRef.current.get(selectedObject.id) ?? selectedObject.frame.height : 0;
  const accentStyle = { "--accent": deck.designSystem.colors.accent, "--accent-text": deck.designSystem.colors.accentText } as CSSProperties;

  return (
    <main className="deck-page" style={accentStyle}>
      <header className="topbar">
        <Wordmark onClick={() => navigate({ name: "home" })} />
        <div className="topbar__title">
          <Eyebrow>{deck.brief.inferred?.audience ? `For ${deck.brief.inferred.audience}` : "Presentation"}</Eyebrow>
          <h1>{deck.title}</h1>
        </div>
        <div className="topbar__status">
          {editor.saving ? <span className="save-state">Saving…</span> : editor.error ? <span className="save-state save-state--bad">{editor.error}</span> : <span className="save-state">Saved</span>}
          {recovering && editor.recovery && <span className="recovery-state"><StatusDot tone={recoveryTone} />{editor.recovery.message}</span>}
          {repaintActive && <span className="recovery-state"><StatusDot tone="busy" />{editor.repaint?.message}</span>}
          {notice && <span className="save-state">{notice}</span>}
        </div>
        <div className="topbar__actions">
          <Button variant="quiet" size="sm" disabled={!editor.canUndo} onClick={editor.undo} title="Undo (⌘Z)">Undo</Button>
          <Button variant="quiet" size="sm" disabled={!editor.canRedo} onClick={editor.redo} title="Redo (⌘⇧Z)">Redo</Button>
          {pendingSlides.length > 0 && !recovering && config?.recovery.available && (
            <Button size="sm" onClick={() => void recover(pendingSlides.map((slide) => slide.id), true)}>Recover text ({pendingSlides.length})</Button>
          )}
          <Button size="sm" disabled={exporting} onClick={() => void exportPng()}>Export PNG</Button>
          <Button size="sm" disabled={exporting || !activeSlide.layers} onClick={() => void bake()} title="Save the current look as a new version of this slide">Bake</Button>
        </div>
      </header>

      <div className="deck-shell">
        <aside className="rail" aria-label="Slides">
          <ol className="rail__list">
            {deck.slides.map((slide, index) => (
              <li key={slide.id}>
                <button type="button" className={`rail__item ${slide.id === activeSlide.id ? "is-active" : ""} ${slide.layers ? "" : "is-unfinished"}`} onClick={() => goToSlide(slide)}>
                  <span className="rail__number">{String(index + 1).padStart(2, "0")}</span>
                  <span className="rail__thumb">
                    <SlideCanvas deck={deck} slide={slide} width={168} />
                    <span className={`rail__badge rail__badge--${slide.recovery.status}`} title={recoveryLabel(slide)} />
                  </span>
                  <span className="rail__title">{slide.title}</span>
                  {!slide.layers && <span className={`rail__stage rail__stage--${slide.recovery.status}`}>{recoveryLabel(slide)}</span>}
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <section className="stage" ref={stageRef}>
          <div className="stage__meta">
            <span>{String(activeIndex + 1).padStart(2, "0")} / {String(deck.slides.length).padStart(2, "0")}</span>
            <span className="stage__slide-title">{activeSlide.title}</span>
            <span className={`stage__state stage__state--${activeSlide.recovery.status}`}>{recoveryLabel(activeSlide)}</span>
          </div>
          <div className="stage__frame">
            <SlideCanvas
              deck={deck}
              slide={activeSlide}
              width={stageWidth}
              interactive={Boolean(activeSlide.layers) && !repaintActive}
              selectedId={selectedObjectId}
              editingId={editingObjectId}
              onSelect={setSelectedObjectId}
              onStartEditing={(id) => { setSelectedObjectId(id); setEditingObjectId(id); }}
              onStopEditing={() => setEditingObjectId(undefined)}
              dispatch={editor.dispatch}
              onMeasure={(heights) => { heightsRef.current = heights; }}
              className={`stage__canvas ${activeSlide.layers ? "" : "stage__canvas--unfinished"}`}
              overlay={selectedObject && !editingObjectId ? (
                <Toolbar
                  deck={deck}
                  slide={activeSlide}
                  object={selectedObject}
                  dispatch={editor.dispatch}
                  onEdit={() => setEditingObjectId(selectedObject.id)}
                  style={{
                    left: Math.max(0, Math.min(stageWidth - 440, selectedObject.frame.x * scale)),
                    top: selectedObject.frame.y * scale > 56 ? selectedObject.frame.y * scale - 52 : (selectedObject.frame.y + measuredHeight) * scale + 12,
                  }}
                />
              ) : undefined}
            />
            {!activeSlide.layers && (
              <div className={`stage__banner stage__banner--${activeSlide.recovery.status}`}>
                <StatusDot tone={activeSlide.recovery.status === "running" || activeSlide.recovery.status === "queued" ? "busy" : activeSlide.recovery.status === "failed" ? "bad" : "warn"} />
                <span>{activeSlide.recovery.status === "failed" ? `Text recovery failed: ${activeSlide.recovery.error ?? "unknown error"}` : activeSlide.recovery.status === "running" ? activeSlide.recovery.message ?? "Recovering text…" : activeSlide.recovery.status === "queued" ? "Waiting for the text pipeline." : "This slide is a painted image. Recover its text to edit it."}</span>
                {(activeSlide.recovery.status === "pending" || activeSlide.recovery.status === "failed") && config?.recovery.available && (
                  <Button size="sm" onClick={() => void recover([activeSlide.id], true)}>Recover this slide</Button>
                )}
                {!config?.recovery.available && <span className="stage__banner-detail">{config?.recovery.detail}</span>}
              </div>
            )}
          </div>
        </section>

        <aside className="panel" aria-label="Details">
          <PromptPanel
            deck={deck}
            slide={activeSlide}
            selectedObject={selectedObject}
            onApplied={(next: Deck) => editor.replaceDeck(next)}
            onRepaintStarted={() => setNotice("Repaint started.")}
            disabled={Boolean(repaintActive)}
          />

          <section className="panel__section">
            <Eyebrow>This slide</Eyebrow>
            <h2 className="panel__title">{activeSlide.title}</h2>
            <p className="panel__body">{activeSlide.purpose}</p>
            {activeSlide.transitionFromPrevious && <p className="panel__muted">{activeSlide.transitionFromPrevious}</p>}
            <dl className="panel__facts">
              <dt>Version</dt><dd>{activeSlide.version} · {activeSlide.history.at(-1)?.reason}</dd>
              <dt>Text</dt><dd>{activeSlide.layers ? `${activeSlide.layers.objects.length} blocks` : recoveryLabel(activeSlide)}</dd>
              {activeSlide.recovery.providerRef && <><dt>Pipeline</dt><dd><code>{activeSlide.recovery.providerRef}</code></dd></>}
            </dl>
            {activeSlide.layers && config?.recovery.available && (
              <Button variant="quiet" size="sm" onClick={() => void recover([activeSlide.id], true, true)} title="Run the text pipeline again on this slide's current image (a few minutes)">Recover again</Button>
            )}
          </section>

          <section className="panel__section">
            <Eyebrow>Design</Eyebrow>
            <p className="panel__body">{deck.designSystem.creativeDirection}</p>
            <ul className="swatches" aria-label="Palette">
              {(Object.entries(deck.designSystem.colors) as Array<[string, string]>).map(([role, hex]) => (
                <li key={role} title={`${role} ${hex}`}><i style={{ background: hex }} /><span>{role}</span></li>
              ))}
            </ul>
            <ul className="type-roles">
              {FONT_ROLE_NAMES.map((role) => (
                <li key={role}><span>{role}</span><b>{deck.designSystem.typography[role].family}</b></li>
              ))}
            </ul>
            <p className="panel__muted">Change fonts and colors with a prompt so the whole deck stays coherent.</p>
          </section>

          <section className="panel__section panel__section--meta">
            <Eyebrow>Deck</Eyebrow>
            <dl className="panel__facts">
              <dt>Created</dt><dd>{formatDate(deck.createdAt)}</dd>
              <dt>Slides</dt><dd>{deck.slides.length}</dd>
              <dt>Sources</dt><dd>{deck.sources?.length ?? 0}</dd>
            </dl>
            <Button variant="quiet" size="sm" onClick={() => navigate({ name: "working", generationId: deck.id })}>How it was made</Button>
          </section>
        </aside>
      </div>
    </main>
  );
}
