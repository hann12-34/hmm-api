#!/usr/bin/env bash
# One-shot: seed MongoDB + print env vars for Render Dashboard (NEW hmm-api service only).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing hmm-api/.env"
  exit 1
fi

echo "=== Seeding hmm_maintenance (skips existing users) ==="
npm run seed

echo ""
echo "=== Copy these into Render → NEW Web Service → hmm-api → Environment ==="
python3 - <<'PY'
from pathlib import Path
for line in Path('.env').read_text().splitlines():
    if line.startswith(('MONGODB_URI=', 'JWT_SECRET=', 'CORS_ORIGIN=')):
        key = line.split('=', 1)[0]
        print(f"{key}=*** (see hmm-api/.env)")
PY
echo ""
echo "Build: npm install"
echo "Start: npm start"
echo "Root Directory: hmm-api (if repo contains parent folder)"
echo ""
echo "Existing Render services: DO NOT TOUCH."
