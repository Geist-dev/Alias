#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo 'Install Node.js 22 or 24 (including npm), then run bash start.sh again.' >&2
  exit 1
fi
node -e 'const major = Number(process.versions.node.split(".")[0]); if (![22, 24].includes(major)) { console.error("Use Node.js 22 or 24 LTS"); process.exit(1); }'
# Install exactly the committed dependency tree. No global packages are changed.
npm ci --no-audit --no-fund
exec node --env-file-if-exists=.env server.js
