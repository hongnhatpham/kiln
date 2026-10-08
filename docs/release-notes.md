Kiln prepares archival 3D assets for public web viewing on your computer.

## New in 0.3.0

- **Preview a folder as it processes.** Click any finished model in the folder list to compare it with its original on the stage, even while the rest are still processing. The preview shows the exported web copy itself.
- **Step through every result.** Use the arrows under the model, or the Left and Right keys, to move from one finished model to the next. The view, surface and lighting stay the same, so models are easy to compare. Press Esc to close.
- **Make room for the preview or the list.** Drag the line between them to share the space, or hide either one. A hidden list still shows which model is processing, and a hidden preview keeps its arrows and reopens on the same view.

## Install

- Windows: download and open `Kiln-Windows-x64-Setup.exe`. It adds Kiln to the Start menu.
- macOS: paste `curl -fsSL https://github.com/hongnhatpham/kiln/releases/latest/download/install.sh | sh` into Terminal, or choose the Apple Silicon (`arm64`) or Intel (`x64`) DMG and drag Kiln into Applications.
- Linux: use the installer script from the README to install the Debian or RPM package and add Kiln to the app menu.
- The optional `install.ps1` and `install.sh` scripts install or update the app and verify SHA256 checksums. Linux uses the system package manager; Windows and macOS install for the current user.

No Node or pnpm installation is needed. GLB and glTF work immediately. Install Blender separately for USDZ and other authoring formats.

These builds are not signed with a paid developer certificate. Windows may show SmartScreen. On macOS, the DMG may need approval through System Settings > Privacy & Security; the Terminal install does not. Kiln does not disable OS security checks.

Processing remains local. Archival originals stay intact, and each export includes a reproducible recipe.
