param(
    [switch]$SkipInstall,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$TauriArgs
)

$ErrorActionPreference = 'Stop'

Set-Location $PSScriptRoot

Write-Host ""
Write-Host "========================================"
Write-Host "   Meetily Local Windows Build"
Write-Host "========================================"
Write-Host ""

$workspaceRoot = Split-Path $PSScriptRoot -Parent
$releaseExe = Join-Path $workspaceRoot 'target\release\meetily.exe'

$runningMeetily = Get-CimInstance Win32_Process -Filter "Name = 'meetily.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq $releaseExe) }

if ($runningMeetily) {
    Write-Host "Stopping running Meetily instance to unlock the release binary..."
    $runningMeetily | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
    }
    Write-Host ""
}

$cargoBin = Join-Path $HOME '.cargo\bin'
if (Test-Path $cargoBin) {
    $env:Path = "$cargoBin;$env:Path"
}

$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'

$libclangCandidates = @(
    $env:LIBCLANG_PATH,
    (Join-Path $env:USERPROFILE 'AppData\Roaming\Python\Python314\site-packages\clang\native'),
    'C:\Program Files\LLVM\bin'
) | Where-Object { $_ }

$resolvedLibclangPath = $libclangCandidates | Where-Object {
    (Test-Path (Join-Path $_ 'libclang.dll')) -or (Test-Path (Join-Path $_ 'clang.dll'))
} | Select-Object -First 1

if (-not $resolvedLibclangPath) {
    throw "Unable to find libclang. Install LLVM or Python libclang first, or set LIBCLANG_PATH manually."
}

$env:LIBCLANG_PATH = $resolvedLibclangPath

Write-Host "Using LIBCLANG_PATH=$($env:LIBCLANG_PATH)"
Write-Host "Using local Tauri config override: src-tauri/tauri.local.build.json"
Write-Host ""

if (-not $SkipInstall -and -not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
    Write-Host "Installing frontend dependencies..."
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
    Write-Host ""
}

$command = @('exec', 'tauri', 'build', '-c', 'src-tauri/tauri.local.build.json') + $TauriArgs

Write-Host "Running: pnpm $($command -join ' ')"
Write-Host ""

& pnpm @command
exit $LASTEXITCODE