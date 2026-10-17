#!/usr/bin/env bash
# First-run setup: create .env and fill the generated secrets / LiveKit API key pair.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env

fill() { # fill <KEY> <value>: only when the key is empty in .env
  if grep -Eq "^$1=[[:space:]]*(#.*)?$" .env; then
    sed -i -E "s|^$1=[[:space:]]*(#.*)?$|$1=$2|" .env
    echo "generated $1"
  fi
}
for key in POSTGRES_PASSWORD BACKEND_JWT_SECRET ADMIN_API_TOKEN WEBHOOK_SIGNING_SECRET LIVEKIT_API_SECRET; do
  fill "$key" "$(openssl rand -hex 32)"
done
fill LIVEKIT_API_KEY "API$(openssl rand -hex 6)"

cat <<'MSG'

Next:
  1. Edit .env: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
  2. (cd widget && npm install && npm run build) && (cd agent-ui && npm install && npm run build)
  3. docker compose up -d --build
  4. docker compose exec backend node dist/cli/create-agent.js alice 'a-strong-password' 'Alice'
MSG
