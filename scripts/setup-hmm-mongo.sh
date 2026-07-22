#!/usr/bin/env bash
# HMM MongoDB setup — paste Atlas connection string, then seed + verify.
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "=== Configure HMM MongoDB URI ==="
echo "Atlas (Safari) -> Clusters -> Connect -> Drivers -> copy string"
echo "Trailing DB name must be: hmm_maintenance  (do NOT use discovr)"
echo ""
read -r -p "Paste MONGODB_URI: " URI

if [[ -z "$URI" || "$URI" != mongodb* ]]; then
  echo "Error: must start with mongodb:// or mongodb+srv://"
  exit 1
fi
if [[ "$URI" == *"/discovr"* ]] || [[ "$URI" == *"discovr.vzlnmqb"* ]]; then
  echo "Error: this is the Discovr cluster/DB. Use the HMM cluster URI instead."
  exit 1
fi
if [[ "$URI" != *"hmm_maintenance"* ]]; then
  echo "Setting the DB name to hmm_maintenance..."
  URI=$(URI="$URI" python3 - <<'PY'
import os, re
u = os.environ["URI"]
if re.search(r'/[^/?]+', u):
    u = re.sub(r'(mongodb(\+srv)?://[^/]+/)([^/?]*)', r'\1hmm_maintenance', u, count=1)
else:
    u = u.rstrip('/') + '/hmm_maintenance'
if '?' not in u:
    u += '?retryWrites=true&w=majority'
print(u)
PY
)
fi

JWT=$(grep '^JWT_SECRET=' .env 2>/dev/null | cut -d= -f2- || echo "hmm-jwt-$(openssl rand -hex 24 2>/dev/null || python3 -c 'import secrets; print(secrets.token_hex(24))')")
cat > .env <<EOF
PORT=3001
MONGODB_URI=$URI
JWT_SECRET=$JWT
CORS_ORIGIN=*
EOF

echo ""
echo "=== Connection test ==="
node - <<'NODE'
require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 })
  .then(async () => {
    console.log('✅ MongoDB OK — DB:', mongoose.connection.db.databaseName);
    await mongoose.disconnect();
  })
  .catch(e => { console.error('❌ Connection failed:', e.message); process.exit(1); });
NODE

echo ""
echo "=== Seed HMM accounts ==="
npm run seed

echo ""
echo "=== Render Environment Variables (copy) ==="
echo "MONGODB_URI=$URI"
echo "JWT_SECRET=$JWT"
echo "CORS_ORIGIN=*"
