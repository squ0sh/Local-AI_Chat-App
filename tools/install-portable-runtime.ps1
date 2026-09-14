param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Kind
)
# Restores a bundled runtime binary for the current platform when it is missing
# or smaller than the release floor, using the pinned URLs and SHA-256 hashes in
# runtime\downloads.txt. Archives are always hash-checked before extraction.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try {
  $CacheDir = Join-Path $AppDir '.portable\cache'
  $BinDir = Join-Path $AppDir "runtime\platforms\$Target\$Kind"
  $Bin = Join-Path $BinDir ($(if ($Kind -eq 'node') { 'node.exe' } else { 'ollama.exe' }))
  $Floor = 5242880
  if ((Test-Path $Bin) -and ((Get-Item $Bin).Length -ge $Floor)) { exit 0 }

  New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
  $Downloads = Join-Path $AppDir 'runtime\downloads.txt'
  $Row = Get-Content $Downloads -Encoding utf8 | Where-Object { $_ -match "^$([regex]::Escape($Target))`t$([regex]::Escape($Kind))`t" } | Select-Object -First 1
  if (-not $Row) { Write-Error "No download entry for $Target $Kind." }
  $Fields = $Row -split "`t"
  $Url = $Fields[2]
  $ShaArc = $Fields[3]
  $ShaBin = $Fields[4]
  $FileName = Split-Path -Leaf $Url
  $Archive = Join-Path $CacheDir $FileName
  $usedWebRequest = $false

  if (-not (Test-Path $Archive)) {
    if ($env:LOCAL_AI_AUTO_DOWNLOADS -ne '1') {
      $ans = Read-Host "The bundled $Kind runtime for $Target is missing or unusable. Download it now? [Y/n]"
      if ($ans -notmatch '^[Yy]?$') { Write-Error 'Download skipped by the user.' }
    }
    Write-Host "  Downloading $Url ..."
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path $curl) { & $curl -fL --retry 2 -o "$Archive.tmp" $Url }
    else { Invoke-WebRequest -Uri $Url -OutFile "$Archive.tmp" -UseBasicParsing; $usedWebRequest = $true }
    Move-Item "$Archive.tmp" $Archive -Force
  }

  if ($ShaArc -and $ShaArc -ne '-') {
    $got = (Get-FileHash -Algorithm SHA256 $Archive).Hash.ToLower()
    if ($got -ne $ShaArc) {
      Remove-Item $Archive -Force
      Write-Error "Downloaded archive hash does not match the release pin ($FileName)."
    }
  }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  if ($Kind -eq 'node') {
    Copy-Item $Archive (Join-Path $BinDir 'node.exe') -Force
  } else {
    $ZipDir = Join-Path $CacheDir "$Target-$Kind-extract"
    if (Test-Path $ZipDir) { Remove-Item $ZipDir -Recurse -Force }
    Expand-Archive -LiteralPath $Archive -DestinationPath $ZipDir -Force
    Copy-Item (Join-Path $ZipDir 'ollama.exe') (Join-Path $BinDir 'ollama.exe') -Force
    if (Test-Path (Join-Path $ZipDir 'lib\ollama')) {
      New-Item -ItemType Directory -Force -Path (Join-Path $BinDir 'lib\ollama') | Out-Null
      Copy-Item (Join-Path $ZipDir 'lib\ollama\*') (Join-Path $BinDir 'lib\ollama\') -Recurse -Force
    }
    Remove-Item $ZipDir -Recurse -Force
  }

  if ($usedWebRequest) { Unblock-File -Path $Bin -ErrorAction SilentlyContinue }
  if ($ShaBin -and $ShaBin -ne '-' -and $env:LOCAL_AI_VERIFY_RUNTIMES -eq '1') {
    $gotBin = (Get-FileHash -Algorithm SHA256 $Bin).Hash.ToLower()
    if ($gotBin -ne $ShaBin) { Write-Error "Restored $Kind binary does not match its release pin." }
  }
  Write-Host "  Restored $Kind ($Target)."
  exit 0
} catch {
  Write-Error $_
  exit 1
}