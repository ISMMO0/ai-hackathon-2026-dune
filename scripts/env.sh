#!/usr/bin/env bash
# Create .env from .env.example when it is absent, with a random
# POSTGRES_PASSWORD and AUTH_SECRET. Never overwrites an existing .env or a
# value already set. GRADIUM_API_KEY and HAI_API_KEY stay for you to fill.
set -euo pipefail
cd "$(dirname "$0")/.."

rand() { openssl rand -hex "$1" 2>/dev/null || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "created .env from .env.example"
fi
chmod 600 .env

fill() { # fill KEY if it is present and empty
  local key=$1 value=$2
  if grep -qE "^${key}=$" .env; then
    sed -i.bak "s|^${key}=$|${key}=${value}|" .env && rm -f .env.bak
    echo "set ${key}"
  fi
}
fill POSTGRES_PASSWORD "$(rand 16)"
fill AUTH_SECRET "$(rand 32)"

for key in GRADIUM_API_KEY HAI_API_KEY; do
  grep -qE "^${key}=.+" .env || echo "still empty: ${key} (its routes answer 503 until you set it)"
done
