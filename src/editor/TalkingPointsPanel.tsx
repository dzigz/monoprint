import Markdown from "react-markdown";
import type { Slide } from "../shared/types";

export function TalkingPointsPanel({ slide, slideNumber }: { slide: Slide; slideNumber: number }) {
  const transcript = slide.talkingPoints?.trim();

  return (
    <section className="panel__section talking-points" aria-label="Talking points">
      <details open>
        <summary className="talking-points__summary">
          <span>Talking points</span>
          <span className="talking-points__slide">Slide {slideNumber}</span>
        </summary>
        {transcript ? (
          <>
            <p className="panel__muted">Full spoken talk. Bracketed cues guide where to point.</p>
            <div
              key={slide.id}
              className="talking-points__transcript"
              role="region"
              aria-label={`Transcript for slide ${slideNumber}`}
              tabIndex={0}
            >
              <Markdown skipHtml disallowedElements={["img"]}>{transcript}</Markdown>
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
