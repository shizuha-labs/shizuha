set -e
VERSION=0.1.0
NODE_VERSION=22.14.0
RG_VERSION=14.1.1
FD_VERSION=10.2.0
ROOT=/home/phoenix/work/shizuha-stack
SRC=$ROOT/shizuha
DATA=/home/phoenix/work/rt
W=/tmp/winbuild
STAGE=$W/shizuha-$VERSION-win-x64
CACHE=$W/.cache
rm -rf "$STAGE"; mkdir -p "$STAGE/bin" "$STAGE/lib" "$STAGE/dist" "$CACHE"

echo "[1] node.exe (win-x64)"
[ -f "$CACHE/node-win.zip" ] || curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip" -o "$CACHE/node-win.zip"
( cd "$W" && unzip -oq "$CACHE/node-win.zip" "node-v$NODE_VERSION-win-x64/node.exe" )
cp "$W/node-v$NODE_VERSION-win-x64/node.exe" "$STAGE/bin/node.exe"

echo "[2] bundle + web"
cp "$DATA/dist/shizuha.min.js" "$STAGE/lib/shizuha.js"
[ -d "$SRC/dist/web" ] && cp -r "$SRC/dist/web" "$STAGE/dist/web" || echo "  (no web ui)"

echo "[3] node_modules (win32/x64 prebuilt deps)"
cp "$SRC/rt-build/package.json" "$STAGE/lib/package.json"
[ -f "$SRC/rt-build/package-lock.json" ] && cp "$SRC/rt-build/package-lock.json" "$STAGE/lib/package-lock.json"
( cd "$STAGE/lib" && npm_config_platform=win32 npm_config_arch=x64 npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3 )
echo "  better-sqlite3 .node: $(file "$STAGE/lib/node_modules/better-sqlite3/build/Release/better_sqlite3.node" 2>/dev/null | grep -o 'MS Windows' || echo MISSING)"

echo "[4] rg.exe + fd.exe (win msvc)"
[ -f "$CACHE/rg-win.zip" ] || curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/ripgrep-$RG_VERSION-x86_64-pc-windows-msvc.zip" -o "$CACHE/rg-win.zip"
( cd "$W" && unzip -oq "$CACHE/rg-win.zip" && find . -name rg.exe -exec cp {} "$STAGE/bin/rg.exe" \; )
[ -f "$CACHE/fd-win.zip" ] || curl -fsSL "https://github.com/sharkdp/fd/releases/download/v$FD_VERSION/fd-v$FD_VERSION-x86_64-pc-windows-msvc.zip" -o "$CACHE/fd-win.zip"
( cd "$W" && unzip -oq "$CACHE/fd-win.zip" && find . -name fd.exe -exec cp {} "$STAGE/bin/fd.exe" \; )
echo "  rg.exe=$([ -f "$STAGE/bin/rg.exe" ] && echo yes) fd.exe=$([ -f "$STAGE/bin/fd.exe" ] && echo yes)"

echo "[5] wrapper bin/shizuha.cmd"
printf '@echo off\r\nsetlocal\r\nset "PATH=%%~dp0;%%PATH%%"\r\nif not defined SHIZUHA_BASH_PATH if exist "%%ProgramFiles%%\\Git\\bin\\bash.exe" set "SHIZUHA_BASH_PATH=%%ProgramFiles%%\\Git\\bin\\bash.exe"\r\n"%%~dp0node.exe" "%%~dp0..\\lib\\shizuha.js" %%*\r\n' > "$STAGE/bin/shizuha.cmd"

echo "[6] bundled install.ps1"
cat > "$STAGE/install.ps1" <<'PS1'
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
$ShizuhaDir = if ($env:SHIZUHA_DIR) { $env:SHIZUHA_DIR } else { "$env:USERPROFILE\.shizuha" }
$BinDir = if ($env:BIN_DIR) { $env:BIN_DIR } else { "$env:LOCALAPPDATA\shizuha\bin" }
New-Item -ItemType Directory -Force -Path $ShizuhaDir | Out-Null
foreach ($d in @('bin','lib','dist')) {
  if (Test-Path "$Root\$d") {
    Remove-Item -Recurse -Force "$ShizuhaDir\$d" -ErrorAction SilentlyContinue
    Copy-Item -Recurse -Force "$Root\$d" "$ShizuhaDir\$d"
  }
}
if (Test-Path "$Root\VERSION") { Copy-Item -Force "$Root\VERSION" "$ShizuhaDir\VERSION" }
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
"@echo off`r`n`"$ShizuhaDir\bin\shizuha.cmd`" %*" | Set-Content -Path "$BinDir\shizuha.cmd" -Encoding ASCII
$UserPath = [Environment]::GetEnvironmentVariable("PATH","User")
if ($UserPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("PATH","$BinDir;$UserPath","User")
  $env:PATH = "$BinDir;$env:PATH"
}
PS1

echo "[7] VERSION + zip"
echo "$VERSION" > "$STAGE/VERSION"
( cd "$W" && rm -f "$DATA/releases/shizuha-$VERSION-win-x64.zip" && zip -rqX "$DATA/releases/shizuha-$VERSION-win-x64.zip" "shizuha-$VERSION-win-x64" )
echo "[done] $(ls -lh "$DATA/releases/shizuha-$VERSION-win-x64.zip" | awk '{print $5}') zip"
echo "=== zip top-level contents ==="
unzip -l "$DATA/releases/shizuha-$VERSION-win-x64.zip" | grep -E 'shizuha-0.1.0-win-x64/(bin|lib|dist|install|VERSION)' | head -20
