#!/usr/bin/env bash
# Run once after GitHub repo exists. Opens GitHub login if needed, then pushes code.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Pushing hmm-api to GitHub (hann12-34/hmm-api) ==="
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/hann12-34/hmm-api.git"
git push -u origin main

echo ""
echo "=== Done. Open Render and connect this repo as NEW Web Service: hmm-api ==="
open "https://dashboard.render.com/web/new?onboarding=active"
