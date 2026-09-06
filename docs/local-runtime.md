# Reproducible local development

The main checkout is prepared at `~/Documents/monoprint`. The earlier checkout remains at `~/Documents/ChatGPT/presentation_builder_prototype`, including its unrelated uncommitted changes. Those changes are not part of this release.

Start the app and its Python pipeline together:

```sh
cd ~/Documents/monoprint
npm run local
```

Open http://localhost:4175. Ctrl+C stops both processes. The launcher waits for the sidecar before starting the app and stops its other process if either service exits. Stop any separately launched service on ports 4174/4175 first. Nothing starts automatically at login.

## Recorded code and dependencies

`runtime-lock.json` records the editor revision used by the 12-slide validation and its corresponding Python pipeline commit, plus Node, npm and Python versions. `package-lock.json` pins the JavaScript dependency tree. `requirements.local.lock.txt` records the Python environment used by that validation.

The ignored `.local/` directory contains:

- `pipeline/`: a clean detached Git worktree at the recorded pipeline commit.
- `node/`: a local copy of the tested Node runtime.
- `python-base/` and `python/`: local copies of the tested Python runtime and virtual environment. The virtual environment points to the copied base runtime.

The launcher checks the Node/Python versions and the pipeline revision and tracked changes. It uses the app source in the current main checkout, so further Monoprint edits are picked up by its development watcher. It does not switch branches or fetch new code when starting. Python code changes need a sidecar restart. To adopt a new pipeline revision, validate it, update the detached worktree and `runtime-lock.json`, and commit that pairing.

The Python package file is an environment snapshot, including transitive packages. On this Mac the copied environment preserves the exact installed files; it is not a claim of portability to a different operating system. Fonts, docTR model weights and the FriBiDi library remain the existing local resources used during validation. Remote model/API services can still change behavior even when local code is pinned.

## Private configuration and existing decks

The ignored `.env.local` contains the app key and points `ARTIFACTS_ROOT` at the existing deck storage. The ignored `.local/pipeline/.env` contains the pipeline's own API configuration. No secrets, slides, fonts, model weights or runtimes belong in Git.

The launcher derives `TEXT_LAYER_SIDECAR_URL` and `SIDECAR_RUNS_DIR` from its own pipeline checkout so the app and sidecar cannot accidentally use different run folders. Port overrides remain available through `PORT` and `SIDECAR_PORT`. The default design-agent mode is `aesthetic`, with normal cache reuse enabled. New slides run the whole pipeline. Retrying an existing slide can reuse OCR; it is not the cache-bypassed procedure used in the 12-slide audit.

The prepared checkout shares the existing decks. Editing or recovering those decks updates that shared data. To use separate test data, start with `ARTIFACTS_ROOT=/absolute/path/to/test-artifacts npm run local`.

## Rebuilding the setup

For JavaScript dependencies, use Node/npm versions from `runtime-lock.json` and run `npm ci`, then `npm test`, `npm run typecheck` and `npm run build`.

The Python repository is private and must be available locally. Create `.local/pipeline` at the recorded commit, prepare Python at `.local/python/bin/python` with the recorded packages, and provide its `.env`. Put the recorded Node runtime at `.local/node/bin/node`. The same font library, docTR weights and FriBiDi support are needed to reproduce the tested environment. The setup on this Mac is already prepared; these are restoration requirements, not commands needed for every launch.

The public Monoprint repository contains the editor, launcher and version records. It does not include or deploy the private Python pipeline. A hosted app needs both components deployed separately.

## Validation of this setup

On 2026-09-06, the clean checkout passed 38 tests, both TypeScript checks and the production build using `npm ci` dependencies. The copied Python runtime loaded Raqm shaping, 2,549 census faces and the docTR detector. A temporary-port smoke test verified the homepage, pipeline connection and isolated test storage; Ctrl+C released both service ports. No model/OCR calls or slide rerenders were performed for this setup change.
