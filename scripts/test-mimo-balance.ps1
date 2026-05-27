# Local-only diagnostic: verify Xiaomi MiMo passToken -> serviceToken -> /balance flow.
# This script is for one-off testing and is NOT part of the build.
param(
  [Parameter(Mandatory=$true)]
  [string]$CredsPath
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CredsPath)) {
  throw "creds file not found: $CredsPath"
}

$creds = Get-Content -LiteralPath $CredsPath -Raw -Encoding UTF8 | ConvertFrom-Json
$passToken = $creds.passToken
$userId    = $creds.userId

if (-not $passToken -or -not $userId) {
  throw "creds JSON must contain non-empty passToken and userId"
}

function Mask-Token([string]$value) {
  if (-not $value) { return '<empty>' }
  if ($value.Length -le 12) { return ('*' * $value.Length) }
  return $value.Substring(0, 6) + '...(' + $value.Length + ' chars)...' + $value.Substring($value.Length - 4)
}

# Step 1: passToken -> sts location
Write-Host "[1/3] Exchanging passToken for sts location..." -ForegroundColor Cyan
$loginUrl = 'https://account.xiaomi.com/pass/serviceLogin?sid=api-platform&_json=true'
$cookieHeader = "passToken=$passToken; userId=$userId"
$r1 = curl.exe -s -i $loginUrl -H "Cookie: $cookieHeader" -H "User-Agent: Mozilla/5.0"
$body1 = ($r1 -join "`n") -split "`r?`n`r?`n", 2 | Select-Object -Last 1
$json1 = $body1 -replace '^&&&START&&&', '' | ConvertFrom-Json
Write-Host "  code=$($json1.code) location-set=$([bool]$json1.location)"
# Print top-level fields with masked values so we can see envelope shape
Write-Host "  --- step1 JSON keys ---"
$json1 | Get-Member -MemberType NoteProperty | ForEach-Object {
  $k = $_.Name
  $v = $json1.$k
  if ($null -eq $v) { Write-Host "    $k = <null>"; return }
  $vs = "$v"
  if ($k -in @('location')) { Write-Host "    $k = <length:$($vs.Length)>"; return }
  Write-Host "    $k = $(Mask-Token $vs)"
}
if (-not $json1.location) {
  throw "no location returned (passToken expired?)"
}
$stsUrl = $json1.location

# Compute clientSign = base64(SHA1("nonce=<nonce>&<ssecurity>"))
$nonce = $json1.nonce
$ssecurity = $json1.ssecurity
if ($nonce -and $ssecurity) {
  $signMaterial = "nonce=$nonce&$ssecurity"
  $sha = [System.Security.Cryptography.SHA1]::Create()
  $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($signMaterial))
  $clientSign = [System.Convert]::ToBase64String($bytes)
  $sha.Dispose()
  $sep = if ($stsUrl -match '\?') { '&' } else { '?' }
  $stsUrl = "$stsUrl$sep" + 'clientSign=' + [System.Uri]::EscapeDataString($clientSign)
}

# Step 2: hit sts URL, capture serviceToken
Write-Host "[2/3] Fetching sts URL..." -ForegroundColor Cyan
$r2 = curl.exe -s -i --max-redirs 0 $stsUrl -H "User-Agent: Mozilla/5.0"
$lines2 = $r2 -split "`r?`n"
$status2 = $lines2[0]
Write-Host "  $status2"
$setCookies = $lines2 | Where-Object { $_ -like 'Set-Cookie:*' }
$serviceTokenLine = $setCookies |
  Where-Object { $_ -match 'api-platform_serviceToken=' -and $_ -notmatch 'EXPIRED' } |
  Select-Object -First 1
if (-not $serviceTokenLine) {
  $serviceTokenLine = $setCookies |
    Where-Object { $_ -match 'serviceToken=' -and $_ -notmatch 'EXPIRED' } |
    Select-Object -First 1
}
if (-not $serviceTokenLine) { throw "no fresh serviceToken in Set-Cookie" }
if ($serviceTokenLine -match '^Set-Cookie:\s*([^=]+)=([^;]+)') {
  $serviceTokenName = $matches[1].Trim()
  $serviceToken = $matches[2]
  if ($serviceToken.StartsWith('"') -and $serviceToken.EndsWith('"')) {
    $serviceToken = $serviceToken.Substring(1, $serviceToken.Length - 2)
  }
  Write-Host "  cookie name: $serviceTokenName, value length: $($serviceToken.Length)"
} else {
  throw "could not parse Set-Cookie line"
}

# Step 3: call /api/v1/balance
Write-Host "[3/3] Calling platform.xiaomimimo.com/api/v1/balance..." -ForegroundColor Cyan
$balanceCookie = "$serviceTokenName=$serviceToken; userId=$userId"
$r3 = curl.exe -s -i 'https://platform.xiaomimimo.com/api/v1/balance' `
  -H "Cookie: $balanceCookie" -H "User-Agent: Mozilla/5.0"
$status = ($r3 -split "`r?`n")[0]
$body3 = ($r3 -join "`n") -split "`r?`n`r?`n", 2 | Select-Object -Last 1
Write-Host "  $status"
Write-Host "  Body: $body3"
