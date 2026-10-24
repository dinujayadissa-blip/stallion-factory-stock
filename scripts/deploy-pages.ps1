# Publishes the screens and the pass-through to Cloudflare Pages (https://stallion-stock.pages.dev).
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-pages.ps1
# First time only: `npx wrangler login` (opens the browser; sign in to Cloudflare), then once create the project:
#   npx wrangler pages project create stallion-stock --production-branch main
# and in the Cloudflare dashboard (Workers & Pages > stallion-stock > Settings > Variables and Secrets) set
#   API_ORIGIN  = https://<supabase-project-ref>.supabase.co   (plain text)
#   PASS_SECRET = the shared secret, the same value the Supabase function has   (Secret)
# Nothing secret lives in this repo.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

node scripts/build-pages.js
if ($LASTEXITCODE -ne 0) { throw 'Building dist-pages failed' }

npx wrangler pages deploy dist-pages --project-name stallion-stock --branch main
if ($LASTEXITCODE -ne 0) { throw 'wrangler pages deploy failed' }
