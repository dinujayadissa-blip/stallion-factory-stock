# Puts the app's server online: the database tables (supabase/migrations) and the Edge Function "api".
#
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-api.ps1 -Ref <project ref id>
#   ... -SetSecrets   also asks for the function's secrets (typed here, never shown, never saved in a file)
#   ... -StageOnly    only builds the deploy folder (.deploy-api), to look at it; no sign-in needed
#
# Needs the one-time `npx supabase login` first (HANDOVER-CLOUD.md). Run from anywhere; it works in the repo.
#
# Why a deploy folder: Supabase only bundles what is inside the function's own folder, and the function runs
# the app's code in src/. So .deploy-api/ (git-ignored) gets a copy of supabase/config.toml, the function
# (index.ts, deno.json) and src/ next to it, with the function's import pointed at that copy.
param(
  [string]$Ref = '',
  [switch]$SetSecrets,
  [switch]$StageOnly,
  [switch]$SkipDbPush
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Run-Step([string]$what, [scriptblock]$cmd) {
  Write-Host ""
  Write-Host "== $what" -ForegroundColor Cyan
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "Stopped: '$what' failed (exit code $LASTEXITCODE). Nothing after it was done." }
}

# ---- 1. The deploy folder ----
$stage = Join-Path $root '.deploy-api'
$fn = Join-Path $stage 'supabase\functions\api'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -Confirm:$false }
New-Item -ItemType Directory -Force (Join-Path $fn 'src') | Out-Null
Copy-Item (Join-Path $root 'supabase\config.toml') (Join-Path $stage 'supabase\config.toml')
Copy-Item (Join-Path $root 'supabase\functions\api\deno.json') (Join-Path $fn 'deno.json')
$entry = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'supabase\functions\api\index.ts')
if ($entry -notmatch [regex]::Escape("'../../../src/edge.js'")) { throw "index.ts no longer imports '../../../src/edge.js' - update this script" }
$entry = $entry.Replace("'../../../src/edge.js'", "'./src/edge.js'")
[System.IO.File]::WriteAllText((Join-Path $fn 'index.ts'), $entry, (New-Object System.Text.UTF8Encoding($false)))
# src/, without the parts only the original (SQLite) version used - nothing online imports them.
$localOnly = @('importPlan.js', 'tidy.js', 'seed.js')
Get-ChildItem (Join-Path $root 'src') -Filter '*.js' | Where-Object { $localOnly -notcontains $_.Name } |
  ForEach-Object { Copy-Item $_.FullName (Join-Path $fn "src\$($_.Name)") }
$bad = Select-String -Path (Join-Path $fn 'src\*.js') -Pattern "from '\./(importPlan|tidy|seed)\.js'" -List
if ($bad) { throw "A file the function needs imports a local-only file: $($bad.Path -join ', ')" }
Write-Host "Deploy folder ready: $fn"
if ($StageOnly) { exit 0 }

if (-not $Ref) { throw "Give the project's Reference ID: -Ref <ref> (Supabase > Project Settings > General)" }

# ---- 2. The database tables ----
if (-not $SkipDbPush) {
  # (asks for the database password the first time - type it, it is not shown)
  Run-Step 'Link this folder to the project' { npx supabase link --project-ref $Ref }
  Run-Step 'Create / update the tables (supabase/migrations)' { npx supabase db push }
}

# ---- 3. The function's secrets (optional; only needed the first time or to change one) ----
if ($SetSecrets) {
  Write-Host ""
  Write-Host "Type each value and press Enter (nothing is shown). Leave one empty to keep what is there." -ForegroundColor Yellow
  $names = [ordered]@{
    'DATABASE_URL'  = 'the pooler connection string, Transaction mode, port 6543 (Supabase > Connect)'
    'PASS_SECRET'   = 'the same random secret as the Pages project''s PASS_SECRET'
    'ALLOWED_HOSTS' = 'the public address without https://, e.g. stallion-stock.pages.dev'
  }
  foreach ($name in $names.Keys) {
    $secure = Read-Host -AsSecureString "$name ($($names[$name]))"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($value) { Run-Step "Set $name" { npx supabase secrets set "$name=$value" --project-ref $Ref } }
    $value = $null
  }
  Run-Step 'Set CLOUD=1' { npx supabase secrets set 'CLOUD=1' --project-ref $Ref }
}

# ---- 4. The function ----
# --use-api: bundled on Supabase's side, so Docker isn't needed. --no-verify-jwt: the app has its own logins.
Run-Step 'Deploy the Edge Function "api"' {
  npx supabase functions deploy api --project-ref $Ref --no-verify-jwt --use-api --workdir $stage
}

Write-Host ""
Write-Host "Done. Check it (type your pass secret in place of <secret>):" -ForegroundColor Green
Write-Host "  curl.exe -i -H `"x-pass-secret: <secret>`" https://$Ref.supabase.co/functions/v1/api/api/me"
Write-Host "  curl.exe -i -H `"x-pass-secret: <secret>`" https://$Ref.supabase.co/functions/v1/api/api/setup"
Write-Host "Expected: /api/me 401 {`"error`":`"Please log in`"} (the function is up); /api/setup 200 {`"needed`":...,`"here`":false}"
Write-Host "(that one reads the database: 503 `"asleep or unreachable`" means DATABASE_URL is wrong). Without the header: 403."
