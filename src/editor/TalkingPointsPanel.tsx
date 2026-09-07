import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps } from "react";
import Markdown, { type ExtraProps } from "react-markdown";
import { canLocateFocus, currentFocusRegions, focusInputKey, parseFocusCues, type FocusCue } from "../shared/focusRegions";
import type { Deck, Slide } from "../shared/types";
import { api } from "../app/api";

const CueContext = createContext({
  cues: [] as FocusCue[], available: new Set<string>(),
  hover: (_id?: string) => {}, focus: (_id?: string) => {},
});

function FocusStrong({ node, children, ...props }: ComponentProps<"strong"> & ExtraProps) {
  const context = useContext(CueContext);
  const cue = context.cues.find((candidate) => candidate.start === node?.position?.start.offset);
  if (!cue) return <strong {...props}>{children}</strong>;
  const available = context.available.has(cue.id);
  return <button
    type="button" className="talking-points__cue" data-cue-id={cue.id} disabled={!available}
    aria-label={`Highlight: ${cue.label}`}
    onPointerEnter={() => { if (available) context.hover(cue.id); }}
    onPointerLeave={() => context.hover(undefined)}
    onFocus={() => context.focus(cue.id)} onBlur={() => context.focus(undefined)}
    onKeyDown={(event) => { if (event.key === "Escape") { context.hover(undefined); event.currentTarget.blur(); } }}
  >{children}</button>;
}
const markdownComponents = { strong: FocusStrong };

export function TalkingPointsPanel({ deck, slide, slideNumber, snapshotError, onHighlight, onUpdated }: {
  deck: Deck; slide: Slide; slideNumber: number; snapshotError?: string;
  onHighlight: (cueId?: string) => void; onUpdated: (deck: Deck) => void;
}) {
  const transcript = slide.talkingPoints ?? "";
  const cues = useMemo(() => parseFocusCues(transcript), [transcript]);
  const available = useMemo(() => new Set(currentFocusRegions(deck, slide).map((region) => region.cueId)), [deck, slide]);
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const [open, setOpen] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string>();
  const inputKey = focusInputKey(deck, slide);
  const current = slide.focusRegions?.inputKey === inputKey ? slide.focusRegions : undefined;
  const error = retryError ?? snapshotError ?? (current?.status === "failed" ? current.error : undefined);
  const ready = available.size > 0;
  useEffect(() => {
    const cueId = hovered ?? focused;
    onHighlight(open && cueId && available.has(cueId) ? cueId : undefined);
  }, [hovered, focused, open, available, onHighlight]);

  const retry = async () => {
    setRetrying(true);
    setRetryError(undefined);
    try { onUpdated((await api.focusRegions(deck.id, slide.id, inputKey, { retry: true })).deck); }
    catch (error) { setRetryError(error instanceof Error ? error.message : "Could not retry highlights."); }
    finally { setRetrying(false); }
  };

  return (
    <section className="panel__section talking-points" aria-label="Talking points">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="talking-points__summary">
          <span>Talking points</span>
          <span className="talking-points__slide">Slide {slideNumber}</span>
        </summary>
        {transcript.trim() ? (
          <>
            <p className="panel__muted">{ready ? "Hover over a bracketed cue or focus it with Tab to highlight its section." : "Full spoken talk. Bracketed cues guide where to point."}</p>
            {cues.length > 0 && !ready && <div className="talking-points__status" role="status">
              <span>{!canLocateFocus(slide) ? "Highlights will be available after text recovery." : error ?? (current?.status === "waiting_snapshot" ? "Preparing updated highlights…" : "Finding focus areas…")}</span>
              {canLocateFocus(slide) && error && <button type="button" className="talking-points__retry" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry highlights"}</button>}
            </div>}
            <div
              key={slide.id}
              className="talking-points__transcript"
              role="region"
              aria-label={`Transcript for slide ${slideNumber}`}
              tabIndex={0}
            >
              <CueContext.Provider value={{ cues, available, hover: setHovered, focus: setFocused }}>
                <Markdown skipHtml disallowedElements={["img"]} components={markdownComponents}>{transcript}</Markdown>
              </CueContext.Provider>
            </div>
            <p className="panel__muted">Use the prompt above to revise the talking points.</p>
          </>
        ) : (
          <div className="talking-points__empty">
            <p>No talking points yet.</p>
            <p className="panel__muted">Choose “This slide” above and ask “Write talking points for this slide.” Choose “Whole deck” to write them for every slide.</p>
          </div>
        )}
      </details>
    </section>
  );
}
