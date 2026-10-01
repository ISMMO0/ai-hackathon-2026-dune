#!/usr/bin/env bash
# Build the `starter` CLI from this checkout and put it on your PATH, so you
# (and your agent) can run `starter ...` against the local app.
set -euo pipefail
cd "$(dirname "$0")/.."

need_major=22
if ! command -v node >/dev/null 2>&1; then
  echo "node is missing: install Node ${need_major}+ (https://nodejs.org)" >&2; exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt "$need_major" ]; then
  echo "node $(node -v) is too old: Node ${need_major}+ is needed" >&2; exit 1
fi

pnpm_version=$(node -p 'require("./package.json").packageManager.split("@")[1]')
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  corepack enable >/dev/null 2>&1 || true
  if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(npx -y "pnpm@${pnpm_version}"); fi
fi

echo "==> installing dependencies"
"${PNPM[@]}" install --frozen-lockfile || "${PNPM[@]}" install

echo "==> building the CLI"
"${PNPM[@]}" turbo build --filter=@antasphere/starter

chmod +x packages/cli/dist/bin.js
echo "==> linking 'starter' globally"
if (cd packages/cli && npm link --no-fund --no-audit >/dev/null 2>&1) && command -v starter >/dev/null 2>&1; then
  echo "linked: $(command -v starter)"
else
  echo "global link failed (no write access to npm's global prefix?). Add this to your shell instead:"
  echo "  alias starter='node $PWD/packages/cli/dist/bin.js'"
fi

cat <<NEXT

Next:
  1. Open http://127.0.0.1:3000, go to API keys, create a key with items:write ticked.
  2. starter login --api-url http://127.0.0.1:3000 --api-key <your ytk_ key>
  3. starter whoami
NEXT
