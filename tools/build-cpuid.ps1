# Builds the optional cpuid.exe SIMD helper for Capsule Fit and drops it at
# runtime/platforms/win32-x64/cpuid.exe so hardware detection reports real
# SIMD levels on Windows. Requires a C compiler that is already on PATH:
#   cl (MSVC, from a Developer PowerShell) or
#   gcc (MinGW-w64).
# Run from the repository root:  powershell -ExecutionPolicy Bypass -File tools/build-cpuid.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'runtime\platforms\win32-x64'
$out = Join-Path $outDir 'cpuid.exe'
$src = Join-Path $root 'tools\cpuid.c'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (Get-Command cl -ErrorAction SilentlyContinue) {
    & cl /nologo /O2 $src /Fe:$out
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Built $out with MSVC"
}
elseif (Get-Command gcc -ErrorAction SilentlyContinue) {
    & gcc -O2 -o $out $src
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Host "Built $out with gcc"
}
else {
    Write-Error 'No C compiler found on PATH (cl or gcc). Install MinGW-w64 or use an MSVC Developer PowerShell, then re-run.'
    exit 1
}

& $out