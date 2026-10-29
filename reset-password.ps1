# Reset a Bridge Register app password (e.g. forgotten admin password).
#   powershell -ExecutionPolicy Bypass -File reset-password.ps1
# Uses the API database login from server\.env, so the postgres password is
# not needed. The new password is typed here and never shown.
$ErrorActionPreference = 'Stop'
$psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe'
$envFile = Join-Path $PSScriptRoot 'server\.env'
if (-not (Test-Path $envFile)) { Write-Host 'server\.env not found - run setup-db.ps1 first.' -ForegroundColor Red; exit 1 }
$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $cfg[$Matches[1]] = $Matches[2] }
$env:PGHOST = $cfg.PGHOST; $env:PGPORT = $cfg.PGPORT; $env:PGUSER = $cfg.PGUSER; $env:PGPASSWORD = $cfg.PGPASSWORD
$db = $cfg.PGDATABASE

function Invoke-Sql([string]$sql) {
    $out = $sql | & $psql -d $db -v ON_ERROR_STOP=1 -q -tA
    if ($LASTEXITCODE) { throw 'Database command failed (see message above).' }
    $out
}
function Read-Secret([string]$prompt) {
    $s = Read-Host $prompt -AsSecureString
    [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

try {
    Write-Host "`nAccounts in the Bridge Register:" -ForegroundColor Cyan
    Invoke-Sql "SELECT format('  %-15s %-25s %-10s %s', username, full_name, role, CASE WHEN active THEN '' ELSE '(disabled)' END) FROM app_user ORDER BY username" |
        ForEach-Object { Write-Host $_ }

    $user = (Read-Host "`nUsername to reset (press Enter for ""admin"")").Trim().ToLower()
    if (-not $user) { $user = 'admin' }
    $q = $user -replace "'", "''"
    if (-not (Invoke-Sql "SELECT 1 FROM app_user WHERE username = '$q'")) { throw "No account called '$user'." }

    do {
        $p1 = Read-Secret 'New password (min 8 characters, typing is hidden)'
        $p2 = Read-Secret 'Repeat new password'
        if ($p1 -ne $p2) { Write-Host '  passwords do not match - try again' -ForegroundColor Yellow }
        elseif ($p1.Length -lt 8) { Write-Host '  too short - at least 8 characters' -ForegroundColor Yellow }
    } until ($p1 -eq $p2 -and $p1.Length -ge 8)

    $pq = $p1 -replace "'", "''"
    # New password, re-enable the account, and sign it out on every device.
    Invoke-Sql @"
SELECT set_password('$q', '$pq');
UPDATE app_user SET active = true WHERE username = '$q';
DELETE FROM api_token WHERE user_id = (SELECT id FROM app_user WHERE username = '$q');
"@ | Out-Null
    Write-Host "`nDone. Sign in at http://localhost:3000 as '$user' with the new password." -ForegroundColor Green
}
catch {
    Write-Host "`nFAILED: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.Exception.Message -like 'Database*') {
        Write-Host 'If it said "permission denied", run this once (asks for the postgres password), then try again:' -ForegroundColor Yellow
        Write-Host '  & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d bridge_registry -f db\03_grants.sql'
    }
    exit 1
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
