import { useEffect, useRef, useState } from "react";
import { api } from "../app/api";
import { canLocateFocus, focusInputKey } from "../shared/focusRegions";
import type { Deck } from "../shared/types";
import { renderSlideToDataUrl } from "./snapshot";

/** The server can read original rasters itself. For edited slides, send the
 * existing canvas renderer's current image once the server has saved the same
 * inputs. This runs for every waiting slide, independently of cue hover. */
export function useFocusSnapshots(deck: Deck | undefined, fontsReady: boolean, onUpdated: (deck: Deck) => void) {
  const latest = useRef(deck);
  latest.current = deck;
  const attempted = useRef(new Set<string>());
  const inFlight = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!deck || !fontsReady || inFlight.current) return;
    const slide = deck.slides.find((slide) => {
      const focus = slide.focusRegions;
      return canLocateFocus(slide) && focus?.status === "waiting_snapshot"
        && focus.inputKey === focusInputKey(deck, slide)
        && !attempted.current.has(`${deck.id}/${slide.id}/${focus.inputKey}/${focus.updatedAt}`);
    });
    if (!slide?.focusRegions) return;
    const { inputKey, updatedAt } = slide.focusRegions;
    const attempt = `${deck.id}/${slide.id}/${inputKey}/${updatedAt}`;
    const timer = window.setTimeout(() => {
      attempted.current.add(attempt);
      inFlight.current = true;
      void (async () => {
        try {
          const image = await renderSlideToDataUrl(deck, slide);
          const current = latest.current;
          const currentSlide = current?.slides.find((candidate) => candidate.id === slide.id);
          if (!current || current.id !== deck.id || !currentSlide || focusInputKey(current, currentSlide) !== inputKey) return;
          onUpdated((await api.focusRegions(deck.id, slide.id, inputKey, { image })).deck);
          setErrors((previous) => { const next = { ...previous }; delete next[attempt]; return next; });
        } catch {
          setErrors((previous) => ({ ...previous, [attempt]: "Could not prepare the edited slide for highlights." }));
        } finally {
          inFlight.current = false;
          setTick((value) => value + 1);
        }
      })();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [deck, fontsReady, tick, onUpdated]);

  return (slideId: string) => {
    const slide = deck?.slides.find((candidate) => candidate.id === slideId);
    const focus = slide?.focusRegions;
    return focus?.status === "waiting_snapshot" ? errors[`${deck?.id}/${slideId}/${focus.inputKey}/${focus.updatedAt}`] : undefined;
  };
}
