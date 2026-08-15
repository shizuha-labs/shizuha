# Build Shizuha Desktop for Windows
# Run from the repo root: powershell -File scripts/build-windows-tauri.ps1

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)

Write-Host "=== Shizuha Windows Desktop Build ===" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot" -ForegroundColor Gray

# Step 1: Check prerequisites
Write-Host "`n[1/5] Checking prerequisites..." -ForegroundColor Yellow

$rust = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rust) {
    Write-Host "ERROR: Rust not found. Install from https://rustup.rs/" -ForegroundColor Red
    exit 1
}
Write-Host "  Rust: $(& rustc --version)" -ForegroundColor Green

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "ERROR: Node.js not found." -ForegroundColor Red
    exit 1
}
Write-Host "  Node: $(& node --version)" -ForegroundColor Green

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "ERROR: npm not found." -ForegroundColor Red
    exit 1
}
Write-Host "  npm: $(& npm --version)" -ForegroundColor Green

# Step 2: Install npm dependencies
Write-Host "`n[2/5] Installing npm dependencies..." -ForegroundColor Yellow
Set-Location $RepoRoot
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: npm install failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done." -ForegroundColor Green

# Step 3: Build frontend
Write-Host "`n[3/5] Building frontend..." -ForegroundColor Yellow
npm run build:tauri
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Frontend build failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done." -ForegroundColor Green

# Step 4: Build Tauri app
Write-Host "`n[4/5] Building Tauri app..." -ForegroundColor Yellow
npx tauri build --bundles msi,nsis
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Tauri build failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Done." -ForegroundColor Green

# Step 5: Report artifacts
Write-Host "`n[5/5] Build artifacts:" -ForegroundColor Yellow
$targetDir = "$RepoRoot/src-tauri/target/release"
$msiFiles = Get-ChildItem "$targetDir/bundle/msi/*.msi" -ErrorAction SilentlyContinue
$nsisFiles = Get-ChildItem "$targetDir/bundle/nsis/*.exe" -ErrorAction SilentlyContinue
$exeFile = Get-ChildItem "$targetDir/shizuha.exe" -ErrorAction SilentlyContinue

if ($msiFiles) {
    Write-Host "  MSI: $($msiFiles.FullName)" -ForegroundColor Green
}
if ($nsisFiles) {
    Write-Host "  NSIS: $($nsisFiles.FullName)" -ForegroundColor Green
}
if ($exeFile) {
    Write-Host "  Portable: $($exeFile.FullName)" -ForegroundColor Green
}

Write-Host "`n=== Build complete ===" -ForegroundColor Cyan
