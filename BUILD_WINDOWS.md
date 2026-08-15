# Building Shizuha Desktop for Windows

## Prerequisites

### 1. Rust toolchain (MSVC)
Install via [rustup.rs](https://rustup.rs/):
```powershell
winget install Rustup.Rustup
rustup default stable-msvc
```

Verify:
```powershell
rustc --version
cargo --version
```

### 2. Node.js
```powershell
winget install OpenJS.NodeJS.LTS
# or
winget install fnm
fnm install 22
fnm use 22
```

### 3. WebView2
Windows 10 (1803+) and Windows 11 include WebView2 by default.
If missing, install from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### 4. Tauri CLI
```powershell
npm install -g @tauri-apps/cli
```

### 5. Visual Studio Build Tools
Install [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
with the "Desktop development with C++" workload.

Or install via winget:
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
```

Then install the C++ workload:
```powershell
vs_installer.exe modify --installPath "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended
```

## Build Steps

### 1. Install dependencies
```powershell
cd shizuha-beta
npm install
```

### 2. Build the Tauri app
```powershell
npx tauri build
```

This produces:
- **MSI installer**: `src-tauri/target/release/bundle/msi/Shizuha_0.1.0_x64_en-US.msi`
- **NSIS installer**: `src-tauri/target/release/bundle/nsis/Shizuha_0.1.0_x64-setup.exe`
- **Portable**: `src-tauri/target/release/shizuha.exe`

### 3. Development mode
```powershell
npx tauri dev
```

## CI Build (Forgejo/Origin)

The `.forgejo/workflows/build-publish-scli.yml` workflow currently builds Linux only.
A Windows Tauri build step is planned but not yet added to CI. To build for Windows,
follow the manual build steps above on a Windows dev machine.

## Authenticode Signing

Paid EV/Authenticode code signing is intentionally deferred under SCLI-138.
Unsigned builds are sufficient for local dev and testing. The unsigned `.exe`
will show a SmartScreen warning on first run — this is expected.

## Troubleshooting

### "link.exe not found"
Ensure Visual Studio Build Tools with C++ workload is installed, then launch
a fresh "Developer PowerShell for VS 2022" or run:
```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1"
```

### WebView2 runtime missing
Download and install from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### Rust MSVC toolchain not found
```powershell
rustup target add x86_64-pc-windows-msvc
```

### NSIS not found
Install NSIS from: https://nsis.sourceforge.io/Download
Or use the MSI-only build:
```powershell
npx tauri build --bundles msi
```
