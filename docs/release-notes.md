Kiln prepares archival 3D assets for public web viewing on your computer.

- Windows: download and open `Kiln-Windows-x64-Setup.exe`. It adds Kiln to the Start menu.
- macOS: choose the Apple Silicon (`arm64`) or Intel (`x64`) DMG and drag Kiln into Applications.
- Linux: use the installer script from the README to install the AppImage and add Kiln to the app menu, or install the Debian package.
- The optional `install.ps1` and `install.sh` scripts install or update the app for the current user and verify SHA256 checksums.

No Node or pnpm installation is needed. GLB and glTF work immediately. Install Blender separately for USDZ and other authoring formats.

These initial builds are unsigned. Windows may show SmartScreen. On macOS, approve Kiln through System Settings > Privacy & Security if Gatekeeper blocks opening it. Kiln does not disable OS security checks.

Processing remains local. Archival originals stay intact, and each export includes a reproducible recipe.
