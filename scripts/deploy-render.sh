#!/usr/bin/env bash
# Creates a NEW Render web service named "hmm-api" only.
# Does NOT modify or redeploy any existing Render services.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${RENDER_API_KEY:-}" ]]; then
  echo "Set RENDER_API_KEY (Render Dashboard → Account Settings → API Keys)"
  exit 1
fi
if [[ ! -f .env ]]; then
  echo "Missing .env — run setup first"
  exit 1
fi

# shellcheck disable=SC1091
source .env
if [[ -z "${MONGODB_URI:-}" || -z "${JWT_SECRET:-}" ]]; then
  echo ".env must define MONGODB_URI and JWT_SECRET"
  exit 1
fi

echo "Checking existing Render services..."
EXISTING=$(curl -sf -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services?limit=100" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for item in data:
    s = item.get('service', item)
    print(s.get('name',''))
")

if echo "$EXISTING" | grep -qx 'hmm-api'; then
  echo "Service 'hmm-api' already exists — not creating a duplicate."
  echo "Open Render Dashboard and deploy hmm-api manually if needed."
  exit 0
fi

OWNER_ID=$(curl -sf -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/owners?limit=1" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data[0]['owner']['id'])
")

echo "Creating NEW service hmm-api (owner $OWNER_ID)..."
SERVICE_JSON=$(curl -sf -X POST \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services" \
  -d "{
    \"type\": \"web_service\",
    \"name\": \"hmm-api\",
    \"ownerId\": \"$OWNER_ID\",
    \"runtime\": \"node\",
    \"plan\": \"starter\",
    \"region\": \"oregon\",
    \"branch\": \"main\",
    \"buildCommand\": \"npm install\",
    \"startCommand\": \"npm start\",
    \"envVars\": [
      {\"key\": \"MONGODB_URI\", \"value\": $(python3 -c "import json,os; print(json.dumps(os.environ['MONGODB_URI']))")},
      {\"key\": \"JWT_SECRET\", \"value\": $(python3 -c "import json,os; print(json.dumps(os.environ['JWT_SECRET']))")},
      {\"key\": \"CORS_ORIGIN\", \"value\": \"*\"}
    ]
  }")

SERVICE_ID=$(echo "$SERVICE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Created hmm-api service id: $SERVICE_ID"
echo "Next: connect a Git repo root = hmm-api folder, or upload via Render Dashboard."
echo "Then set APIConfig.baseURL in iOS to your Render URL."
