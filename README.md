# Monoprint

Monoprint writes a presentation from one prompt, paints every slide as a single image, then recovers the text on each slide as editable type so the deck can be edited by hand or by prompt.

A monoprint is a one-of-a-kind print pulled from a plate. Each slide here is exactly that: a background plate with live text on top.

## How it works

1. **Brief.** One prompt box. Write what you need in your own words; audience, slide count, and tone are inferred. Drop files (PDF, DOCX, text, images), paste links, or choose a local folder such as a codebase.
2. **Author.** An agent plans the story, reads your sources, chooses fonts from the fonts installed on this Mac, defines a palette, writes the full spoken talk for each slide, and paints every slide with GPT Image. The working screen shows its decisions as they land.
3. **Recover.** The moment a slide is painted it enters the text pipeline in `font_matching_proto` (branch `proto/font-matching`), while the remaining slides are still being painted. The pipeline finds the text, erases it from the image, fits the deck's own fonts to the pixels, and returns positions, sizes, colors, and fitted font files. Monoprint turns that into a background plate plus text blocks and attaches them to the slide at publication, or right away if the deck is already published. The pipeline is single-threaded by design, so slides queue in painting order; each takes a few minutes.
4. **Edit.** Click text to select, double-click to type, drag to move with snapping, pull the side handles to resize, and use the floating toolbar for alignment, bold, italic, and size steps. Everything else goes through the prompt panel: rewrites, renames across the deck, palette or font changes, and repaints, which you confirm before they run.

Every slide passes through the same stages, and both the working screen and the editor show them: waiting, painting, painted, recovering text, editable. Unfinished slides appear dimmed and their canvas text cannot be edited yet. "Recover again" on a slide runs the pipeline afresh; everything else reuses a finished run when one exists.

**Talking points.** The editor's right sidebar shows a collapsible transcript for the selected slide, directly below the prompt panel. It contains the full spoken talk with formatted paragraphs and textual focus cues such as **[Point to the left column]**. Cues stay in the transcript and do not add canvas highlights. Ask the prompt editor to write or revise talking points for this slide or the whole deck; these edits save and support undo/redo even before text recovery. New decks require a transcript on every slide. Existing decks remain readable and can gain transcripts through the prompt. Transcripts are stored as Markdown in each slide's `talkingPoints` field, separately from supplementary `speakerNotes`.

Visible copy never contains arrow or symbol glyphs: the author draws connectors and keeps the text on each side as separate copy items, and recovery treats every arrow it sees as a drawing. The adapter renders the pipeline's blocks as they come; it does not re-segment them.

The slide count comes from the prompt when you write one ("12 slides", "a ten-slide deck"). Otherwise the author decides it in the storyboard after reading your material, not in its first framing.

The deck document is the source of truth. Slides keep a version history: generated, repainted, and baked rasters. Hand edits and prompt edits use the same command format, so undo, autosave, and the live event stream behave identically.

**Export PDF** downloads the entire deck, with one page per slide in deck order. It saves pending edits, captures the actual editor slide component at twice its native dimensions, and embeds each image losslessly. This preserves recovered fonts and browser text reflow without requiring fonts in the PDF reader. Selection handles, hover highlights and editor controls are excluded. Pages preserve each slide's aspect ratio, including unrecovered slides. This is a visual PDF (text is part of the page image); use Export PPTX for editable text. PDF export runs in the browser without recovery, consolidation or model calls.

**Font consolidation.** Recovery defaults to using one fitted font per eligible multiline text box. After fitting, the pipeline chooses an existing font that changes the box's overall horizontal extent by at most 2%, measured using renderer glyph bounds, recovered word gaps, baseline positions and rotation. It preserves sizes, colours, line breaks and alignment. Boxes with mixed fonts on a line, differing typefaces/weights/styles, excessive width change, or incompatible geometry retain their original font runs. Boxes are never split. The reviewed render and imported text objects use this same layout. The original fitted layout is retained in the run directory.

For existing decks, use **Consolidate fonts** under **This slide**, or **Consolidate deck fonts** under **Deck**. These actions run the same deterministic rule directly on saved editor word geometry and local font files, in a separate short-lived Python process. They work while the HTTP recovery service is offline and do not run OCR, refitting, design review, or external models. Boxes without saved geometry (including text edits that have reflowed), locked boxes and incompatible transforms are preserved. Existing valid talking-point highlights are reused; missing highlights require an explicit retry. Undo restores the previous text objects and highlight cache. Slide images and pipeline run folders are not rewritten.

**Export PPTX** in the deck toolbar saves pending edits, runs font consolidation across the entire deck, then exports that consolidated snapshot. Compatible boxes remain native multiline text; complex runs retain their fitted fonts, positions, colors and rotations in separate editable objects. The recovered background stays an image, and talking points become speaker notes. Full fonts are embedded under unique family names, including converting CFF outlines to TrueType for PowerPoint. Export stops if consolidation, a required font/background, or editable embedding is unavailable. It does not run text recovery or call a model. Consolidation changes are saved only after export succeeds and can be undone in the app.

The local exporter uses the prepared Python environment and the Codex presentation runtime (`PPTX_RUNTIME_ROOT`, default `~/.cache/codex-runtimes/codex-primary-runtime/dependencies`). All slides must have recovered text layers. Validated in PowerPoint for Mac 16.112.3 against all 13 consolidated Super-resolution slides: complete text, embedded fonts and unchanged artwork; 95% of measured word anchors within 0.9 px horizontally and 2.1 px vertically at 1536×864. This is close visual fidelity, not a guarantee of identical pixels across PowerPoint versions. PowerPoint may render ligatures and antialiasing differently; text that has reflowed in the editor is laid out again during export.

Set `TEXT_FONT_CONSOLIDATION=0` in `.env.local` and restart to disable both automatic consolidation and the manual actions. Turning the flag on or off does not rewrite already saved decks. Recovery cache reuse checks the setting and the output report. The width tolerance does not bound changes to shorter lines or replace the editor's existing browser reflow behavior during direct text edits.

## Setup

The prepared main checkout at `~/Documents/monoprint` starts both services with `npm run local`. See [the local runtime guide](docs/local-runtime.md) for the pinned pipeline revision, dependency snapshots and further development.

```sh
cp .env.example .env.local
npm install
npm run dev
```

Set `OPENAI_API_KEY` in `.env.local`. The app runs at http://localhost:4175.

Text recovery needs the sidecar from the font-matching pipeline running on port 4174:

```sh
npm run sidecar
```

That script expects the pipeline worktree at `~/Documents/font_matching_proto` and the Python environment at `~/Documents/font_realtime_generation/.venv`. Override with `SIDECAR_ROOT` and `SIDECAR_PYTHON`. It starts the pipeline's design agent in `aesthetic` mode; set `SIDECAR_DESIGN_AGENT_MODE=overlay` for the measurement-overlay variant. The mode is read once when the sidecar starts, so restart it after changing it. Code changes in the pipeline also need a sidecar restart, since a running sidecar keeps the modules it has already imported. The pipeline needs its own `.env` with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `DATALAB_API_KEY`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4175` | Web server port |
| `ARTIFACTS_ROOT` | `./artifacts` | Where decks, images, fonts, and attachments are stored |
| `FONT_LIBRARY_PATH` | macOS font folders | Font catalog root for the author |
| `TEXT_LAYER_SIDECAR_URL` | `http://127.0.0.1:4174` | The recovery sidecar |
| `SIDECAR_RUNS_DIR` | `~/Documents/font_matching_proto/runs/docedit/v4` | Where the sidecar writes its per-slide run directories |
| `SIDECAR_DOC_PREFIX` | `mp` | Prefix for run directory names (`<prefix>_<first 8 chars of the slide image id>`) |
| `SIDECAR_REUSE_RUNS` | `1` | Reuse a finished run directory instead of calling the sidecar again |
| `SIDECAR_DESIGN_AGENT` | `1` | Let the pipeline's design agent refine each slide (slower, better) |
| `SIDECAR_DESIGN_AGENT_MODE` | `aesthetic` | Design-agent variant passed to `npm run sidecar` (`aesthetic` or `overlay`) |
| `SIDECAR_PORT` | `4174` | Port `npm run sidecar` listens on |
| `TEXT_FONT_CONSOLIDATION` | `1` | Consolidate compatible fitted fonts within each recovered box using the 2% overall-width limit; `0` disables it |
| `OPENAI_TIMEOUT_MS` | `1200000` | Timeout for long model calls |

## Recovery adapter

`server/recovery/provider.ts` is the contract: image in, plate and objects out. `server/recovery/sidecarProvider.ts` implements it against the sidecar. It sends the deck's role fonts and role-labelled copy as known typography, then reads the sidecar's run directory for sizes, spacing, fitted fonts, and the composite images. The adapter imports the reviewed background plate and canonical resolved text layout directly, so the editor and export use the same geometry as the pipeline. Font fitting and consolidation happen in the pipeline; the adapter does not perform a second layout pass.

Text removal fills the source text mask with the surrounding background color when local samples agree. Each word samples its own background, excluding nearby text; gradients, textures and color boundaries retain the inpainting fallback. Pixels outside the text mask stay unchanged. Existing saved backgrounds receive this change when their slides are recovered again.

Objects are a discriminated union (`kind: "text"` today) so images, shapes, and charts can join later without changing the host.

## Commands

```sh
npm test
npm run typecheck
npm run build
npm start
npm run recover -- <deckId> [slideIndex]   # recover one slide from the command line
```

## Data

Each deck lives in `artifacts/<deckId>/`: `deck.json` (schema 4), slide images, `*.plate.png` backgrounds, `fonts/` fitted instance fonts, `attachments/` uploaded files, plus the generation checkpoint files. Older decks (schema 1 to 3) are upgraded on first load and start in the generated state, ready for recovery.
