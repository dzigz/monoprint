# Monoprint

Monoprint writes a presentation from one prompt, paints every slide as a single image, then recovers the text on each slide as editable type so the deck can be edited by hand or by prompt.

A monoprint is a one-of-a-kind print pulled from a plate. Each slide here is exactly that: a background plate with live text on top.

## How it works

1. **Brief.** One prompt box. Write what you need in your own words; audience, slide count, and tone are inferred. Drop files (PDF, DOCX, text, images), paste links, or choose a local folder such as a codebase.
2. **Author.** An agent plans the story, reads your sources, chooses fonts from the fonts installed on this Mac, defines a palette, and paints every slide with GPT Image. The working screen shows its decisions as they land.
3. **Recover.** The moment a slide is painted it enters the text pipeline in `font_matching_proto` (branch `proto/font-matching`), while the remaining slides are still being painted. The pipeline finds the text, erases it from the image, fits the deck's own fonts to the pixels, and returns positions, sizes, colors, and fitted font files. Monoprint turns that into a background plate plus text blocks and attaches them to the slide at publication, or right away if the deck is already published. The pipeline is single-threaded by design, so slides queue in painting order; each takes a few minutes.
4. **Edit.** Click text to select, double-click to type, drag to move with snapping, pull the side handles to resize, and use the floating toolbar for alignment, bold, italic, and size steps. Everything else goes through the prompt panel: rewrites, renames across the deck, palette or font changes, and repaints, which you confirm before they run.

Every slide passes through the same stages, and both the working screen and the editor show them: waiting, painting, painted, recovering text, editable. Unfinished slides appear dimmed and cannot be edited yet. "Recover again" on a slide runs the pipeline afresh; everything else reuses a finished run when one exists.

Visible copy never contains arrow or symbol glyphs: the author draws connectors and keeps the text on each side as separate copy items, and recovery treats every arrow it sees as a drawing. The adapter renders the pipeline's blocks as they come; it does not re-segment them.

The slide count comes from the prompt when you write one ("12 slides", "a ten-slide deck"). Otherwise the author decides it in the storyboard after reading your material, not in its first framing.

The deck document is the source of truth. Slides keep a version history: generated, repainted, and baked rasters. Hand edits and prompt edits use the same command format, so undo, autosave, and the live event stream behave identically.

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
| `OPENAI_TIMEOUT_MS` | `1200000` | Timeout for long model calls |

## Recovery adapter

`server/recovery/provider.ts` is the contract: image in, plate and objects out. `server/recovery/sidecarProvider.ts` implements it against the sidecar. It sends the deck's role fonts and role-labelled copy as known typography, then reads the sidecar's run directory for sizes, spacing, fitted fonts, and the composite images. The adapter imports the reviewed background plate and canonical resolved text layout directly, so the editor and export use the same geometry as the pipeline. Nothing in the pipeline repository is modified.

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
