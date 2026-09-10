<#
.SYNOPSIS
  Sinh file public/map-keys.json tu file .env kieu Vite cua du an DMS.

.DESCRIPTION
  Du an DMS goc (Vue + Vite) giu key trong .env duoi dang VITE_GG_ID /
  VITE_VTMAP_KEY. Script nay doc cac bien do va ghi ra file cau hinh runtime
  cua demo Angular, de khong phai copy-paste key bang tay (de lo qua clipboard,
  lich su terminal, hay lo commit).

  File dich la public/map-keys.json - da duoc gitignore, va duoc app fetch luc
  chay nen KHONG can build lai khi doi key, chi can F5.

  Script KHONG in gia tri key ra man hinh - chi in do dai de kiem tra.

.PARAMETER EnvFile
  Duong dan toi file .env nguon.

.EXAMPLE
  ./scripts/sync-env.ps1 -EnvFile "..\..\dms.webapp\.env.development"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EnvFile
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EnvFile)) {
  throw "Khong tim thay file env: $EnvFile"
}

# Parse .env: bo qua dong trong / dong comment, tach theo dau '=' dau tien,
# go bo dau nhay bao quanh gia tri neu co.
$map = @{}
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  $trimmed = $line.Trim()
  if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
  $idx = $trimmed.IndexOf('=')
  if ($idx -lt 1) { continue }
  $key = $trimmed.Substring(0, $idx).Trim()
  $val = $trimmed.Substring($idx + 1).Trim().Trim('"').Trim("'")
  $map[$key] = $val
}

function Get-EnvValue([string]$name) {
  if ($map.ContainsKey($name)) { return $map[$name] }
  return ''
}

$googleKey = Get-EnvValue 'VITE_GG_ID'
$vtmapKey = Get-EnvValue 'VITE_VTMAP_KEY'
$googleMapId = Get-EnvValue 'VITE_GG_MAP_ID'
if ($googleMapId -eq '') { $googleMapId = 'DEMO_MAP_ID' }

# Chan gia tri la: key hop le chi gom chu, so va mot vai ky tu an toan.
foreach ($pair in @(@('VITE_GG_ID', $googleKey), @('VITE_VTMAP_KEY', $vtmapKey))) {
  if ($pair[1] -ne '' -and $pair[1] -notmatch '^[A-Za-z0-9_\-\.]+$') {
    throw "Gia tri cua $($pair[0]) chua ky tu la, dung lai de tranh sinh file hong."
  }
}

$outFile = Join-Path $PSScriptRoot '..\public\map-keys.json'

# Dung ConvertTo-Json de tu escape gia tri, khong noi chuoi bang tay.
$payload = [ordered]@{
  _sinh_luc     = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
  _nguon        = [System.IO.Path]::GetFileName($EnvFile)
  _canh_bao     = 'File nay chua key that - da gitignore, DUNG COMMIT.'
  googleMapsKey = $googleKey
  googleMapId   = $googleMapId
  vtmapKey      = $vtmapKey
}

# Ghi UTF-8 KHONG BOM: BOM lam nhieu bo parse JSON (ke ca ConvertFrom-Json cua
# chinh PowerShell 5.1) bao "Invalid JSON primitive".
$json = $payload | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($outFile), $json, $utf8NoBom)

Write-Host "Da ghi: $([System.IO.Path]::GetFullPath($outFile))"
Write-Host ("  googleMapsKey : {0} ky tu" -f $googleKey.Length)
Write-Host ("  vtmapKey      : {0} ky tu" -f $vtmapKey.Length)
Write-Host ("  googleMapId   : {0}" -f $googleMapId)
Write-Host ""
Write-Host "Chay demo: npm start   (khong can co --configuration nao)"
