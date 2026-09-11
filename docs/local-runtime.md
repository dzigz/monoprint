# Reproducible local development

The main checkout is prepared at `~/Documents/monoprint`. The earlier checkout remains at `~/Documents/ChatGPT/presentation_builder_prototype`, including its unrelated uncommitted changes. Those changes are not part of this release.

Start the app and its Python pipeline together:

```sh
cd ~/Documents/monoprint
npm run local
```

Open http://localhost:4175. Ctrl+C stops both processes. `npm run sidecar` uses the same pinned runtime and validation, but starts only the pipeline for use with a separately launched app. The launcher waits for the sidecar before starting the app and stops its other process if either service exits. Stop any separately launched service on ports 4174/4175 first. Nothing starts automatically at login.

## Recorded code and dependencies

`runtime-lock.json` records the editor revision used by the original 12-slide validation and the current tested Python pipeline commit, plus Node, npm and Python versions. `package-lock.json` pins the JavaScript dependency tree. `requirements.local.lock.txt` records the Python environment used by that validation.

The ignored `.local/` directory contains:

- `pipeline/`: a clean Git worktree at the recorded pipeline commit.
- `node/`: a local copy of the tested Node runtime.
- `python-base/` and `python/`: local copies of the tested Python runtime and virtual environment. The virtual environment points to the copied base runtime.

The launcher checks the Node/Python versions and the pipeline revision and tracked changes. It uses the app source in the current main checkout, so further Monoprint edits are picked up by its development watcher. It does not switch branches or fetch new code when starting. Python code changes need a sidecar restart. To adopt a new pipeline revision, validate it, update the worktree and `runtime-lock.json`, and commit that pairing.

The Python package file is an environment snapshot, including transitive packages. On this Mac the copied environment preserves the exact installed files; it is not a claim of portability to a different operating system. Fonts, docTR model weights and the FriBiDi library remain the existing local resources used during validation. Remote model/API services can still change behavior even when local code is pinned.

## Private configuration and existing decks

The ignored `.env.local` contains the app key and points `ARTIFACTS_ROOT` at the existing deck storage. The ignored `.local/pipeline/.env` contains the pipeline's own API configuration. No secrets, slides, fonts, model weights or runtimes belong in Git.

The launcher derives `TEXT_LAYER_SIDECAR_URL`, `SIDECAR_ROOT`, `SIDECAR_PYTHON`, and `SIDECAR_RUNS_DIR` from its own pinned runtime so recovery, consolidation, and export use the same checkout. A separately launched app also defaults to `.local/pipeline`; explicit path overrides remain available for that mode. Port overrides remain available through `PORT` and `SIDECAR_PORT`. The default design-agent mode is `aesthetic`, with normal cache reuse enabled. New slides run the whole pipeline. Retrying an existing slide can reuse OCR; it is not the cache-bypassed procedure used in the 12-slide audit.

The default pipeline is now `db014ff1cb98255c89328cf7a52633201c8d3416`, including transactional text recovery, OCR-missed text registration, block regrouping, explicit region-level solid fill or inpainting, shared source-mask validation, and graphic protection scoped to each word’s erase region. Repairs preserve prior editable text and layout or roll back. Final coverage auditing reports required text that remains unresolved. Ordinary erasure still samples a solid color on nearly uniform backgrounds and retains inpainting for nonuniform areas. Sampling excludes detected text and checks agreement on both axes; nearby artwork outside the mask is preserved. The pipeline code digest invalidates old render caches. Recover existing slides again to update their saved backgrounds.

`TEXT_FONT_CONSOLIDATION` defaults to `1` and is passed to both services. Set it to `0` in `.env.local` and restart to disable consolidation. The pipeline preserves the original fitted layout and writes a per-box decision report; final rendering, review and app import use the chosen layout. Existing saved decks change only through recovery or a manual consolidation action.

Existing decks also have fast **Consolidate fonts** and **Consolidate deck fonts** actions. They call the pinned Python consolidation module through `scripts/consolidate-fonts.py`, using saved editor geometry and deck font files. The local Python installation is required; a running HTTP sidecar is not. The worker rejects network and child-process calls. The API serializes the operation with other deck changes and checks the expected revision before applying it.

The prepared checkout shares the existing decks. Editing or recovering those decks updates that shared data. To use separate test data, start with `ARTIFACTS_ROOT=/absolute/path/to/test-artifacts npm run local`.

## PowerPoint export

The deck toolbar's **Export PPTX** action always runs local font consolidation first, under the same revision-checked mutation lock as deck saves. The exporter builds from the resulting snapshot before committing it. A failed build leaves the saved deck unchanged; disabling `TEXT_FONT_CONSOLIDATION` also disables PPTX export. Missing recovery layers must be recovered beforehand. There is no automatic OCR, model call, or fallback to an unconsolidated export.

`PPTX_RUNTIME_ROOT` points at a directory containing `node/bin/node` and `node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs`. It defaults to the installed Codex primary runtime under `~/.cache/codex-runtimes/`. The exporter also needs the same Python/fontTools/HarfBuzz environment used by consolidation. Prepared font copies are cached by source contents and transform in `.local/pptx-fonts`; finished exports and receipts live in `.local/pptx-exports`. Neither directory belongs in Git. Font copies have unique internal names and retain full character coverage; original deck font files are not modified. The first export prepares the fonts, and later exports reuse those copies.

Text is native and editable, with original artwork as the recovered background image. Talking points are stored as speaker notes. Missing fonts, restricted editable-embedding permissions, unequal slide sizes, and text that combines horizontal scaling with rotation fail explicitly. PowerPoint's native text cannot preserve the resulting shear transform. Font matching and text recovery are never silently rerun.

## Rebuilding the setup

For JavaScript dependencies, use Node/npm versions from `runtime-lock.json` and run `npm ci`, then `npm test`, `npm run typecheck` and `npm run build`.

The Python repository is private and must be available locally. Create `.local/pipeline` at the recorded commit, prepare Python at `.local/python/bin/python` with the recorded packages, and provide its `.env`. Put the recorded Node runtime at `.local/node/bin/node`. The same font library, docTR weights and FriBiDi support are needed to reproduce the tested environment. The setup on this Mac is already prepared; these are restoration requirements, not commands needed for every launch.

The public Monoprint repository contains the editor, launcher and version records. It does not include or deploy the private Python pipeline. A hosted app needs both components deployed separately.

## Validation of this setup

On 2026-09-06, the clean checkout passed 38 tests, both TypeScript checks and the production build using `npm ci` dependencies. The copied Python runtime loaded Raqm shaping, 2,549 census faces and the docTR detector. A temporary-port smoke test verified the homepage, pipeline connection and isolated test storage; Ctrl+C released both service ports. No model/OCR calls or slide rerenders were performed for this setup change.

On 2026-09-09, font consolidation passed 53 app tests, both TypeScript checks, the production build, 29 existing pipeline tests and 8 consolidation tests. Offline validation against all 34 stored slides matched the prior width/style audit: 262 boxes consolidated, 305 already uniform, and 19 exception boxes (44 lines) unchanged. OFF reproduced every original layout. Representative before/after text renders were inspected. This validation used saved layouts and did not call OCR or external models.

On 2026-09-10, the manual actions passed 58 app tests, 4 Python adapter tests, type checks and the production build. A separate app with copied deck storage, no model key and recovery offline verified single-slide consolidation, Undo, and all 13 slides. The local operation measured 278 ms for slide 3 (7 boxes) and 793 ms for the full deck (125 boxes). The nine exception boxes, original text, word styles, slide assets and all existing highlights were preserved.

The 2026-09-10 export validation used all 13 consolidated Super-resolution slides in native PowerPoint for Mac 16.112.3. All 1,441 recovered words and all 13 notes pages survived export. The result contains 357 native text objects (118 multiline) and 276 complete embedded fonts, with byte-identical background images. Native PDF renders were compared at the original 1536×864 canvas size: 95th-percentile word-anchor errors were 0.873 px horizontal and 2.022 px vertical; maxima were 3.227 px and 3.468 px. Package integrity, slide geometry, and Artifact Tool re-import passed. The UI-produced deck matched the validated slide XML after resolving relationship IDs and excluding generated creation IDs. PowerPoint's viewing mode allowed native rendering/printing; its subscription restriction prevented an edit/save-cycle test. These figures cover that complete deck and PowerPoint version, not every possible edited layout or another viewer.

A separate smoke fixture deliberately assigned two fitted font IDs across a multiline box. The real local consolidation worker and PPTX exporter reduced it to one font and one multiline text box, saved revision 1, and finished in 1.37 seconds using the font cache. The user's saved deck was not used as test storage. Regression checks passed: 63 app tests, 5 Python font/layout tests, TypeScript checks, and production build.

The 2026-09-10 solid-background erasure change passed 36 pipeline regression tests, including seven tests for light/dark colors, separate panels, nearby artwork, raster noise, gradients, color boundaries, retained text and mixed fill modes. Offline plate reconstruction across all 13 Super-resolution slides used solid fills for 1,431 words and fallback inpainting for 10. Every source mask matched its saved version and all unmasked pixels stayed identical. The slide 9 crop and full-deck plate comparison were inspected. This validation rebuilt backgrounds in local output files without OCR, model calls, font fitting or changes to saved deck assets.

The 2026-09-11 editable-text promotion includes checkpoint `f729a65` and the graphic-protection fix `db014ff`. The final fix was compared with that checkpoint on 34 full slides across three decks (3,151 native entries), plus three repair replays. Native text layers stayed pixel-identical; 32 background plates were identical and the other two removed 46 residual glyph pixels. All protected-graphic and outside-mask checks passed. Pipeline checks passed 106 tests and 12 subtests. The known dark-seed smudge on a textured background remains unresolved; this promotion does not claim to fix it. Image generation and repaint continue to use the shared `gpt-image-2.5-sunburst` / `xhigh` settings in `server/slideImageSettings.ts`.

Activation in the default `.local/pipeline` checkout passed 106 pipeline tests and 12 subtests, all 63 app tests, 4 consolidation-adapter checks, 5 PPTX-layout checks, TypeScript checks, and the production build. Both `npm run sidecar` and `npm run local` started from the pinned checkout on temporary ports and released their ports on shutdown. The combined launcher overrode deliberately incorrect app pipeline paths with its pinned runtime. The restarted app reported generation configured and recovery, consolidation, and PPTX export available; all eight saved deck documents retained their original hashes. Activation checks did not generate a new deck or call external models.

## Visual document inputs

Source document processing runs in the app. PDF.js renders PDF pages; ZIP/XML readers extract DOCX/PPTX text and embedded media, and LibreOffice produces Office page/slide previews. The prepared machine uses `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice`; `DOCUMENT_SOFFICE_PATH` selects another executable. Conversions use isolated profiles and private copies without external relationships. The image model receives selected source PNGs separately from the existing style anchors. Local caches and crop recipes live in `.visuals-v1/` folders beside the uploaded files under each deck's `attachments/`, keyed by source contents. No new dependency is required in the text-recovery pipeline.
