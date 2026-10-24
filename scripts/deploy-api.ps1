# Puts the app's server online: the database tables (supabase/migrations), the Edge Function "api" and a check
# that the private photo bucket item-photos is there (scripts/ensure-bucket.mjs).
#
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-api.ps1 -Ref <project ref id>
#   ... -SetSecrets   also asks for the function's secrets (typed here, never shown; passed on through a temporary
#                     env file in $env:TEMP that is deleted straight after, never on a command line)
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
  # The values never go on a command line (other programs on the PC can read those): they are written to a
  # temporary env file in $env:TEMP (this Windows user's own folder), handed over with --env-file, and the
  # file is deleted in the finally block, whatever happens. Each value is in single quotes, so nothing in it
  # is read as a variable or a comment.
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($name in $names.Keys) {
    $secure = Read-Host -AsSecureString "$name ($($names[$name]))"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    if ($value) {
      if ($value.Contains("'") -or $value.Contains("`n") -or $value.Contains("`r")) { throw "Stopped: the value for $name has a ' or a line break in it, which can't be passed on safely. Nothing was set." }
      $lines.Add("$name='$value'")
    }
    $value = $null
  }
  $lines.Add("CLOUD='1'")
  $envFile = Join-Path $env:TEMP ("fs-secrets-" + [guid]::NewGuid().ToString('N') + ".env")
  try {
    [System.IO.File]::WriteAllLines($envFile, $lines, (New-Object System.Text.UTF8Encoding($false)))
    $lines.Clear()
    Run-Step "Set the function's secrets ($($names.Keys -join ', '), CLOUD=1; empty ones kept as they were)" {
      npx supabase secrets set --env-file $envFile --project-ref $Ref
    }
  } finally {
    if (Test-Path $envFile) { Remove-Item -Force $envFile -Confirm:$false }
  }
}

# ---- 4. The function ----
# --use-api: bundled on Supabase's side, so Docker isn't needed. --no-verify-jwt: the app has its own logins.
Run-Step 'Deploy the Edge Function "api"' {
  npx supabase functions deploy api --project-ref $Ref --no-verify-jwt --use-api --workdir $stage
}

# ---- 5. The photo bucket item-photos: there, and private ----
# (scripts/ensure-bucket.mjs: made private if it is missing; a PUBLIC bucket stops here.) The service key is
# read from $env:SUPABASE_SERVICE_ROLE_KEY when it is set, otherwise typed here (not shown); it reaches node
# through the environment of this window only, never the command line, and is removed again afterwards.
Write-Host ""
Write-Host "== The photo bucket item-photos (made private if missing; stops if it is public)" -ForegroundColor Cyan
$hadKey = [bool]$env:SUPABASE_SERVICE_ROLE_KEY
if (-not $hadKey) {
  $secure = Read-Host -AsSecureString "Service key SUPABASE_SERVICE_ROLE_KEY (Supabase > Project Settings > API Keys; nothing is shown; Enter to skip)"
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:SUPABASE_SERVICE_ROLE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
if ($env:SUPABASE_SERVICE_ROLE_KEY) {
  $oldUrl = $env:SUPABASE_URL
  $env:SUPABASE_URL = "https://$Ref.supabase.co"
  try {
    node (Join-Path $root 'scripts\ensure-bucket.mjs')
    if ($LASTEXITCODE -ne 0) { throw "Stopped: the photo bucket check failed (see the line above). The function is deployed; fix the bucket, then run: node scripts\ensure-bucket.mjs" }
  } finally {
    $env:SUPABASE_URL = $oldUrl
    if (-not $hadKey) { Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY -ErrorAction SilentlyContinue }
  }
} else {
  Write-Host "Skipped. Before photos are copied, run: node scripts\ensure-bucket.mjs (with the values set as in HANDOVER-CLOUD.md step 2)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Check it (type your pass secret in place of <secret>):" -ForegroundColor Green
Write-Host "  curl.exe -i -H `"x-pass-secret: <secret>`" https://$Ref.supabase.co/functions/v1/api/api/me"
Write-Host "  curl.exe -i -H `"x-pass-secret: <secret>`" https://$Ref.supabase.co/functions/v1/api/api/setup"
Write-Host "Expected: /api/me 401 {`"error`":`"Please log in`"} (the function is up); /api/setup 200 {`"needed`":...,`"here`":false}"
Write-Host "(that one reads the database: 503 `"asleep or unreachable`" means DATABASE_URL is wrong). Without the header: 403."
