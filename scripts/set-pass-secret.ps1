# Makes the shared pass secret (the password the Cloudflare pass-through shows the Supabase function) and puts
# the SAME value in both places, without anyone ever seeing it:
#   - Supabase function secret PASS_SECRET (through a temporary env file in $env:TEMP, deleted straight after)
#   - Cloudflare Pages secret PASS_SECRET (typed into wrangler through the pipe, never on a command line)
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-pass-secret.ps1 -Ref <project ref id>
#
# Run it again any time to change the secret (then redeploy the Pages site so it picks the new one up).
# Needs `npx supabase login` and `npx wrangler login` first (HANDOVER-CLOUD.md).
param(
  [Parameter(Mandatory = $true)][string]$Ref,
  [string]$PagesProject = 'stallion-stock'
)
$ErrorActionPreference = 'Stop'

# 32 random bytes, URL-safe base64 (letters, digits, - and _ only, so nothing in it needs quoting).
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$bytes = $null

$envFile = Join-Path $env:TEMP ("fs-pass-" + [guid]::NewGuid().ToString('N') + ".env")
try {
  [System.IO.File]::WriteAllText($envFile, "PASS_SECRET='$secret'`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "== Supabase: setting PASS_SECRET" -ForegroundColor Cyan
  npx supabase secrets set --env-file $envFile --project-ref $Ref
  if ($LASTEXITCODE -ne 0) { throw "Stopped: Supabase didn't take the secret (exit code $LASTEXITCODE). Nothing was set in Cloudflare." }
  Write-Host "== Cloudflare: setting PASS_SECRET on $PagesProject" -ForegroundColor Cyan
  $secret | npx wrangler pages secret put PASS_SECRET --project-name $PagesProject
  if ($LASTEXITCODE -ne 0) { throw "Stopped: Cloudflare didn't take the secret (exit code $LASTEXITCODE). Run this script again: it makes a new secret and sets both." }
} finally {
  if (Test-Path $envFile) { Remove-Item -Force $envFile -Confirm:$false }
  $secret = $null
}
Write-Host ""
Write-Host "Done: the same new pass secret is set in Supabase and Cloudflare (it was never shown)." -ForegroundColor Green
Write-Host "Redeploy the Pages site (scripts\deploy-pages.ps1) so it uses it."
