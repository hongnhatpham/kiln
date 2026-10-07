# Kiln

Kiln prepares archival 3D assets for public web viewing. It is a local desktop companion to [vdrs-website](https://github.com/hongnhatpham/vdrs-website).

Open a model, choose a quality preset, inspect the result, and export a GLB with its processing recipe. Your archival original stays intact. Processing and previews run on your computer.

## Install

Download from [the latest release](https://github.com/hongnhatpham/kiln/releases/latest). No Node, pnpm or developer tools are needed.

| System               | Easiest installation                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Windows 10/11, x64   | Open `Kiln-Windows-x64-Setup.exe`. The installer adds Kiln to the Start menu.                                         |
| macOS, Apple Silicon | Open `Kiln-macOS-arm64.dmg` and drag Kiln to Applications.                                                            |
| macOS, Intel         | Open `Kiln-macOS-x64.dmg` and drag Kiln to Applications.                                                              |
| Linux, x64           | Run the script below. It chooses the Debian/Ubuntu `.deb` or Fedora/RHEL/openSUSE `.rpm` and installs the menu entry. |

### Install with a script

These scripts install or update Kiln, verify the release checksum, and add it to your app menu. Windows and macOS install for your user account. Linux uses your normal package manager and may ask for your administrator password. They do not make Kiln run automatically at login.

**Windows, PowerShell:**

```powershell
Invoke-WebRequest https://github.com/hongnhatpham/kiln/releases/latest/download/install.ps1 -OutFile "$env:TEMP\kiln-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\kiln-install.ps1"
```

**macOS or Linux, Terminal:**

```sh
curl -fL https://github.com/hongnhatpham/kiln/releases/latest/download/install.sh -o /tmp/kiln-install.sh
sh /tmp/kiln-install.sh
```

You can inspect the downloaded script before running it. Add `-DryRun` on Windows or `--dry-run` on macOS/Linux to see its paths. Run the same command again to update to the latest release, with Kiln closed.

Script installations on Windows and macOS live in `%LOCALAPPDATA%\Programs\Kiln` or `~/Applications/Kiln.app`. To remove one, delete that app and its Kiln menu shortcut. Windows Setup and Linux packages use their normal system uninstallers. Choose either Windows Setup or the script; close Kiln before updating.

Initial builds are unsigned. Windows may show SmartScreen; macOS may require approval in **System Settings > Privacy & Security** after trying to open Kiln. The scripts preserve OS security checks. Linux needs a desktop environment; its package manager installs the required libraries. Linux ARM and native Windows ARM packages are not included yet.

GLB and glTF processing is built in. Install [Blender](https://www.blender.org/download/) separately for USDZ and other authoring formats. Kiln detects it or lets you choose it through **Locate Blender**.

## Develop

Use Node 24 or later and pnpm.

```sh
pnpm install
pnpm dev
```

GLB and glTF processing is built in. USDZ and other authoring formats use a local Blender installation. Kiln detects Blender or lets you choose it. No separate Python installation is needed.

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm package
```

Applications for your current operating system are written to `release/`. GitHub Actions builds Windows x64, Linux x64, macOS Intel and macOS Apple Silicon on native runners, then exercises each packaged app with a synthetic model. Tagged releases publish all installers and checksums together. Agent commands and examples are listed by `pnpm agent --help`.

## Quality choices

- **Detailed web:** 4K color, normal and occlusion maps, high-quality color compression, lossless resized normals, and the full mesh. Start here for surface detail and close-ups.
- **Lightweight:** smaller maps for faster public viewing. Inspect important details before choosing it.
- **Lossless:** preserve original texture resolution and pixels, with lossless geometry compression.
- **Custom:** independently set texture sizes and quality, texture format, mesh compression, simplification, quantization and metadata handling.

WebP and meshopt exports require a compatible web viewer. The export recipe records the required extensions and all processing settings. Smaller downloads do not always mean less GPU memory; texture resolution controls that cost too.

## Local data

Source models, optimized exports, local caches and verification screenshots are excluded from Git. The application does not upload models or use an AI service.

## Use the desktop app

1. Open Kiln from your Start menu, Applications or Linux app menu. GLB and glTF work immediately. Install Blender locally for USDZ and other authoring formats, then use **Locate Blender** if it is not detected.
2. Open or drop a model. Start with **Detailed web** for fine surface detail.
3. Use **Advanced settings** to change the map sizes, encoding, mesh settings and metadata policy.
4. Optimize, then inspect the source and result together. Orbit, zoom, move the comparison divider and use raking light to inspect relief.
5. Export. Kiln saves a GLB and a matching `.recipe.json` with settings, source fingerprint, tool versions, validation and output fingerprint.

Keep your master file as the archival record. Public derivatives are delivery copies. Inspect every important region before publishing: a preset cannot determine which details matter to your research.

See [the optimization recipe and Cook comparison](docs/optimization.md).

See [verification and coverage limits](docs/verification.md).
