#!/usr/bin/env bash
# Copies the spike Edge Function into supabase/functions/spike/ (where the Supabase CLI expects it),
# together with the app's own src/parseOrder.js. The only change to parseOrder.js is the pdfjs import,
# rewritten from a bare Node specifier to an npm: specifier that Deno understands.
# Run from the repo root:  bash spike/stage-edge.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=supabase/functions/spike
mkdir -p "$DEST"
cp spike/edge/index.ts "$DEST/index.ts"
sed "s#'pdfjs-dist/legacy/build/pdf.mjs'#'npm:pdfjs-dist@4.10.38/legacy/build/pdf.mjs'#" src/parseOrder.js > "$DEST/parseOrder.js"
grep -q "npm:pdfjs-dist@4.10.38" "$DEST/parseOrder.js" || { echo "pdfjs import rewrite failed" >&2; exit 1; }
echo "Staged $DEST (index.ts, parseOrder.js)"
