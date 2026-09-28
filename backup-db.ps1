# Full backup of the bridge_registry database (all tables, users and history).
#   powershell -ExecutionPolicy Bypass -File backup-db.ps1
# Asks for the postgres password. Saves to backups\ (ignored by git: the file
# contains password hashes, so keep it private - not on GitHub).
# Restore:  pg_restore -U postgres -d bridge_registry --clean backups\<file>.dump
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'backups'
New-Item -ItemType Directory -Force $dir | Out-Null
$file = Join-Path $dir ("bridge_registry_{0:yyyyMMdd_HHmm}.dump" -f (Get-Date))
& 'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe' -h localhost -U postgres -Fc -d bridge_registry -f $file
if ($LASTEXITCODE) { Write-Host 'Backup failed' -ForegroundColor Red; exit 1 }
Write-Host "Backup saved: $file ($([math]::Round((Get-Item $file).Length / 1KB)) KB)" -ForegroundColor Green
