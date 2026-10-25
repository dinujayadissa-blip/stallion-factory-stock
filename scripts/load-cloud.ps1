# Loads the real factory data into the cloud database and, if asked, makes owner logins - with only the
# database password and the service key typed (never shown, never on a command line, gone when it ends).
#
#   powershell -ExecutionPolicy Bypass -File scripts\load-cloud.ps1 -Ref <ref> -From <factory.db> -Photos <photos folder> [-Wipe] [-AddOwner <username>]
#
#   -Wipe              empty the cloud data first (needed for a second load, e.g. cut-over after the trial)
#   -AddOwner <name>   afterwards make an owner login with that username (asks for the name and password)
#
# The database address is built here from the project ref and the password (session pooler, port 5432, which
# the copy needs), trying Supabase's two Sydney pooler hosts and keeping the one that connects. The source
# database is only read (scripts/copy-to-cloud.js copies it to a temp folder first).
param(
  [Parameter(Mandatory = $true)][string]$Ref,
  [Parameter(Mandatory = $true)][string]$From,
  [string]$Photos = '',
  [switch]$Wipe,
  [string]$AddOwner = ''
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path $From)) { throw "No database at -From $From" }
if ($Photos -and -not (Test-Path $Photos)) { throw "No photos folder at -Photos $Photos" }

function Read-Secret([string]$prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$names = @('DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY')
try {
  $pw = Read-Secret 'Database password (from your password manager; nothing is shown)'
  if (-not $pw) { throw 'No password typed. Nothing was done.' }
  $enc = [Uri]::EscapeDataString($pw)
  $pw = $null
  $found = $false
  foreach ($h in @('aws-0-ap-southeast-2.pooler.supabase.com', 'aws-1-ap-southeast-2.pooler.supabase.com')) {
    $env:DATABASE_URL = "postgresql://postgres.${Ref}:$enc@${h}:5432/postgres"
    Write-Host "Trying the database at $h ..."
    node scripts/check-db.mjs
    if ($LASTEXITCODE -eq 0) { $found = $true; break }
  }
  $enc = $null
  if (-not $found) { throw 'Could not log in to the database (see the reason above). If it says "password authentication failed", the password is wrong: check it, or reset it in Supabase > Project Settings > Database.' }

  if ($Photos) {
    $env:SUPABASE_URL = "https://$Ref.supabase.co"
    $env:SUPABASE_SERVICE_ROLE_KEY = Read-Secret 'Service key (Supabase > Project Settings > API Keys; nothing is shown)'
    if (-not $env:SUPABASE_SERVICE_ROLE_KEY) { throw 'No service key typed. Nothing was copied.' }
  }

  Write-Host ""
  Write-Host "== Copying the data (it checks every figure; any mismatch puts nothing in)" -ForegroundColor Cyan
  $copyArgs = @('scripts/copy-to-cloud.js', '--from', $From, '--to', 'env')
  if ($Photos) { $copyArgs += @('--photos', $Photos) }
  if ($Wipe) { $copyArgs += '--wipe' }
  node @copyArgs
  if ($LASTEXITCODE -ne 0) { throw "Stopped: the copy did not finish (exit code $LASTEXITCODE). The cloud data was left as it was." }

  if ($AddOwner) {
    Write-Host ""
    Write-Host "== Owner login '$AddOwner' (type the person's name, then the password twice)" -ForegroundColor Cyan
    node scripts/users.js add $AddOwner owner
    if ($LASTEXITCODE -ne 0) { throw "Stopped: the login was not made (exit code $LASTEXITCODE)." }
  }
  Write-Host ""
  Write-Host "Done." -ForegroundColor Green
} finally {
  foreach ($n in $names) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
}
