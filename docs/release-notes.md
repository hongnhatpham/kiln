Kiln prepares archival 3D assets for public web viewing on your computer.

## New in 0.2.0

- **Process a whole folder.** Drop a folder or choose Process a folder. Kiln optimizes every model inside it and its subfolders, saves the results in a matching `_public` folder, and skips models that are already up to date.
- **Clay and Wire views.** Switch the stage to Clay to see the shape without textures, or Wire to see every triangle edge. Use them to check how much detail is lost when you remove triangles.
- **macOS no longer reports Kiln as damaged.** macOS builds now carry a valid signature, so macOS shows the normal approval prompt instead.

## Install

- Windows: download and open `Kiln-Windows-x64-Setup.exe`. It adds Kiln to the Start menu.
- macOS: paste `curl -fsSL https://github.com/hongnhatpham/kiln/releases/latest/download/install.sh | sh` into Terminal, or choose the Apple Silicon (`arm64`) or Intel (`x64`) DMG and drag Kiln into Applications.
- Linux: use the installer script from the README to install the Debian or RPM package and add Kiln to the app menu.
- The optional `install.ps1` and `install.sh` scripts install or update the app and verify SHA256 checksums. Linux uses the system package manager; Windows and macOS install for the current user.

No Node or pnpm installation is needed. GLB and glTF work immediately. Install Blender separately for USDZ and other authoring formats.

These builds are not signed with a paid developer certificate. Windows may show SmartScreen. On macOS, the DMG may need approval through System Settings > Privacy & Security; the Terminal install does not. Kiln does not disable OS security checks.

Processing remains local. Archival originals stay intact, and each export includes a reproducible recipe.
