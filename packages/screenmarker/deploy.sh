#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "== screenmarker: Cloudflare Pages deploy =="

if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Not logged in to Cloudflare — opening browser login..."
  npx wrangler login
fi

echo "Building..."
npm run build

echo "Deploying to Cloudflare Pages..."
npx wrangler pages deploy dist/client --project-name screenmarker
