# Talking-point highlights

After a slide is published and text recovery completes, `FocusRegionManager`
queues a separate OpenAI call for that slide. It uses `gpt-5.6-sol` with medium
reasoning, the finished image, full talking-point transcript, every bold
bracketed cue and its following spoken context, and recovered text-object boxes.
The author agent is unchanged. There is no SAM fallback or verifier.

The structured response must contain exactly one in-bounds pixel rectangle per
cue. Results are stored in optional `slide.focusRegions` metadata (compatible
with existing schema 4 decks) and delivered through the existing deck event
stream. The talking-points panel displays rectangles on hover or keyboard focus.
The overlay is presentation UI only and is not included in Bake or image exports.

Two calls run concurrently. Opening an existing deck backfills missing results
and resumes interrupted jobs. Edits are debounced and results are keyed to the
transcript and visual inputs, so stale results are neither displayed nor saved.
Unchanged results are reused; failures are shown with a per-slide retry button.
Hovering never makes a model request. Slides without cues make no calls.

Recovered slides use their original raster, matching the grounding experiment.
Canvas or deck-style edits request a fresh snapshot from the browser before the
next call. This uses the existing Bake/prompt canvas renderer, whose text reflow
can differ slightly from live HTML editing. The editor must be open for these
snapshots; generation of highlights never blocks using or editing a deck.

`POST /api/decks/:deckId/slides/:slideId/focus-regions` accepts `inputKey`, an
optional PNG `image`, and optional `retry`. The server checks the saved input
key again after snapshot decoding and before accepting model results. Snapshot
dimensions must match the canvas. Images remain transient; only rectangles and
generation status are added to the deck. Keep the `focus-v1` input-key version in
sync with changes to the prompt/model or grounding contract that require a rerun.

Run `npm test`, `npm run typecheck`, and `npm run build` to validate the integration.
