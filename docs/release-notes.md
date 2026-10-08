Kiln prepares archival 3D assets for public web viewing on your computer.

- Windows: download and open `Kiln-Windows-x64-Setup.exe`. It adds Kiln to the Start menu.
- macOS: paste `curl -fsSL https://github.com/hongnhatpham/kiln/releases/latest/download/install.sh | sh` into Terminal, or choose the Apple Silicon (`arm64`) or Intel (`x64`) DMG and drag Kiln into Applications.
- Linux: use the installer script from the README to install the Debian or RPM package and add Kiln to the app menu.
- The optional `install.ps1` and `install.sh` scripts install or update the app and verify SHA256 checksums. Linux uses the system package manager; Windows and macOS install for the current user.

No Node or pnpm installation is needed. GLB and glTF work immediately. Install Blender separately for USDZ and other authoring formats.

These builds are not signed with a paid developer certificate. Windows may show SmartScreen. On macOS, the DMG may need approval through System Settings > Privacy & Security; the Terminal install does not. Kiln does not disable OS security checks.

Processing remains local. Archival originals stay intact, and each export includes a reproducible recipe.
