#!/usr/bin/env bash
# Build the app with the configured public BASE_PATH and rsync the dist/
# contents up to DEPLOY_HOST:DEPLOY_DIR/BASE_PATH/ — preserving structure
# and deleting anything no longer in the build.
#
# Reads BASE_PATH, DEPLOY_HOST, DEPLOY_DIR from the environment (or .env
# in the project root). Run from the project root:  scripts/deploy.sh
set -euo pipefail

# Move to the project root so relative paths resolve regardless of where
# this was invoked from.
cd "$(dirname "$0")/.."

# Load .env if present, exporting every assignment.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

: "${BASE_PATH:?BASE_PATH must be set (e.g. /cubedex/)}"
: "${DEPLOY_HOST:?DEPLOY_HOST must be set (e.g. example.com)}"
: "${DEPLOY_DIR:?DEPLOY_DIR must be set (e.g. example.com)}"

# Normalise BASE_PATH to /<...>/ — exactly one leading and one trailing
# slash, regardless of how many the input had. A bare/empty path collapses
# to a single "/".
while [[ "$BASE_PATH" == /* ]]; do BASE_PATH="${BASE_PATH#/}"; done
while [[ "$BASE_PATH" == */ ]]; do BASE_PATH="${BASE_PATH%/}"; done
if [[ -z "$BASE_PATH" ]]; then BASE_PATH="/"; else BASE_PATH="/${BASE_PATH}/"; fi
# Strip ALL trailing slashes on DEPLOY_DIR so concatenation with BASE_PATH
# (which always starts with /) never produces a doubled separator.
while [[ "$DEPLOY_DIR" == */ ]]; do DEPLOY_DIR="${DEPLOY_DIR%/}"; done

target="${DEPLOY_HOST}:${DEPLOY_DIR}${BASE_PATH}"

echo "→ Building with BASE_PATH=${BASE_PATH}"
BASE_PATH="${BASE_PATH}" npm run build

echo "→ Syncing dist/ → ${target}"
# `dist/` (trailing slash) tells rsync to copy the CONTENTS of dist into
# the target directory rather than copying the dist folder itself.
rsync -av --delete dist/ "${target}"

echo "✓ Deployed to ${target}"
