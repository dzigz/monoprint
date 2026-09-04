import { useState } from "react";
import { api } from "../app/api";
import type { Deck, EditScope, RepaintProposal, Slide, TextObject } from "../shared/types";
import { Button, Eyebrow } from "../ui/primitives";
import { renderSlideToDataUrl } from "./snapshot";

type Exchange = {
  id: string;
  prompt: string;
  scope: EditScope;
  status: "pending" | "done" | "error";
  summary?: string;
  proposal?: RepaintProposal;
  proposalState?: "offered" | "started" | "declined";
};

export function PromptPanel({
  deck,
  slide,
  selectedObject,
  onApplied,
  onRepaintStarted,
  disabled,
}: {
  deck: Deck;
  slide: Slide;
  selectedObject?: TextObject;
  onApplied: (deck: Deck) => void;
  onRepaintStarted: () => void;
  disabled?: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [scope, setScope] = useState<EditScope | "auto">("auto");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const busy = exchanges.some((exchange) => exchange.status === "pending");
  const effectiveScope: EditScope = scope === "auto" ? (selectedObject ? "object" : "slide") : scope;

  async function submit() {
    const text = prompt.trim();
    if (!text || busy) return;
    const id = `${Date.now()}`;
    setExchanges((current) => [...current, { id, prompt: text, scope: effectiveScope, status: "pending" }]);
    setPrompt("");
    try {
      const snapshots: Record<string, string> = {};
      const targets = effectiveScope === "deck" ? deck.slides.slice(0, 8) : [slide];
      for (const target of targets) {
        try {
          snapshots[target.id] = await renderSlideToDataUrl(deck, target, effectiveScope === "deck" ? 0.35 : 0.5);
        } catch {
          // A missing snapshot is acceptable; the agent still has the text.
        }
      }
      const result = await api.edit(deck.id, {
        prompt: text,
        scope: effectiveScope,
        slideId: effectiveScope === "deck" ? undefined : slide.id,
        objectId: effectiveScope === "object" ? selectedObject?.id : undefined,
        snapshots,
      });
      if (result.kind === "applied") {
        onApplied(result.deck);
        setExchanges((current) => current.map((exchange) => exchange.id === id ? { ...exchange, status: "done", summary: result.summary } : exchange));
      } else if (result.kind === "repaint") {
        setExchanges((current) => current.map((exchange) => exchange.id === id ? { ...exchange, status: "done", summary: result.summary, proposal: result.proposal, proposalState: "offered" } : exchange));
      } else {
        setExchanges((current) => current.map((exchange) => exchange.id === id ? { ...exchange, status: "done", summary: result.summary } : exchange));
      }
    } catch (error) {
      setExchanges((current) => current.map((exchange) => exchange.id === id ? { ...exchange, status: "error", summary: error instanceof Error ? error.message : "The edit failed." } : exchange));
    }
  }

  async function confirmRepaint(exchange: Exchange) {
    if (!exchange.proposal) return;
    try {
      await api.repaint(deck.id, exchange.proposal.slideId, exchange.proposal.instruction);
      setExchanges((current) => current.map((item) => item.id === exchange.id ? { ...item, proposalState: "started" } : item));
      onRepaintStarted();
    } catch (error) {
      setExchanges((current) => current.map((item) => item.id === exchange.id ? { ...item, status: "error", summary: error instanceof Error ? error.message : "The repaint could not start." } : item));
    }
  }

  return (
    <section className="prompt-panel" aria-label="Edit with a prompt">
      <div className="prompt-panel__head">
        <Eyebrow>Ask for a change</Eyebrow>
        <div className="scope" role="radiogroup" aria-label="Scope">
          {selectedObject && (
            <button type="button" className={`scope__btn ${effectiveScope === "object" ? "is-active" : ""}`} onClick={() => setScope("object")}>This text</button>
          )}
          <button type="button" className={`scope__btn ${effectiveScope === "slide" ? "is-active" : ""}`} onClick={() => setScope("slide")}>This slide</button>
          <button type="button" className={`scope__btn ${effectiveScope === "deck" ? "is-active" : ""}`} onClick={() => setScope("deck")}>Whole deck</button>
        </div>
      </div>
      <textarea
        className="prompt-panel__input"
        value={prompt}
        rows={3}
        disabled={disabled || busy}
        placeholder={effectiveScope === "deck"
          ? "Rename a term everywhere, warm up the palette, change the heading font…"
          : effectiveScope === "object"
            ? "Shorten this, make it a question, move it to the right…"
            : "Tighten the headline, add a caption, replace the illustration…"}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit();
          event.stopPropagation();
        }}
      />
      <div className="prompt-panel__actions">
        <span className="prompt-panel__hint">{busy ? "Working…" : "⌘↵ to send"}</span>
        <Button variant="primary" size="sm" disabled={disabled || busy || !prompt.trim()} onClick={() => void submit()}>Send</Button>
      </div>
      {exchanges.length > 0 && (
        <ol className="exchanges">
          {[...exchanges].reverse().map((exchange) => (
            <li key={exchange.id} className={`exchange exchange--${exchange.status}`}>
              <p className="exchange__prompt"><span className="exchange__scope">{exchange.scope === "deck" ? "deck" : exchange.scope === "object" ? "text" : "slide"}</span>{exchange.prompt}</p>
              {exchange.status === "pending" && <p className="exchange__reply exchange__reply--pending">Reading the slide…</p>}
              {exchange.summary && <p className="exchange__reply">{exchange.summary}</p>}
              {exchange.proposal && (
                <div className="proposal">
                  <p className="proposal__reason">{exchange.proposal.reason}</p>
                  <p className="proposal__instruction">{exchange.proposal.instruction}</p>
                  {exchange.proposalState === "offered" && (
                    <div className="proposal__actions">
                      <Button variant="primary" size="sm" onClick={() => void confirmRepaint(exchange)}>Repaint slide {deck.slides.findIndex((candidate) => candidate.id === exchange.proposal?.slideId) + 1}</Button>
                      <Button variant="quiet" size="sm" onClick={() => setExchanges((current) => current.map((item) => item.id === exchange.id ? { ...item, proposalState: "declined" } : item))}>Not now</Button>
                    </div>
                  )}
                  {exchange.proposalState === "started" && <p className="proposal__state">Repainting. The slide updates when it is done, then its text is recovered again.</p>}
                  {exchange.proposalState === "declined" && <p className="proposal__state">Left as is.</p>}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
