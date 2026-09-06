#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -x .local/node/bin/node ]; then
  echo "The local runtime is missing. See docs/local-runtime.md." >&2
  exit 1
fi
exec .local/node/bin/node scripts/start-local.mjs
