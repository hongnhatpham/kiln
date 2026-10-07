# Kiln

**Kiln turns large 3D scans into smaller files for the web, with control over the detail people come to see.**

Everything happens on your own computer. Your original file is never changed, and nothing is uploaded.

Kiln is the desktop companion to [vdrs-website](https://github.com/hongnhatpham/vdrs-website).

### [Download Kiln](https://github.com/hongnhatpham/kiln/releases/latest)

Free for Windows, macOS and Linux. No other software is needed to get started.

## Install

Go to [the download page](https://github.com/hongnhatpham/kiln/releases/latest) and pick the file for your computer.

| Your computer                         | Download this file           | Then                                                          |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| Windows 10 or 11, Intel/AMD           | `Kiln-Windows-x64-Setup.exe` | Open it and follow the steps. Kiln appears in the Start menu. |
| Mac with Apple Silicon (M1 and later) | `Kiln-macOS-arm64.dmg`       | Open it and drag Kiln into Applications.                      |
| Mac with an Intel processor           | `Kiln-macOS-x64.dmg`         | Open it and drag Kiln into Applications.                      |
| Ubuntu, Debian, Mint                  | `Kiln-Linux-x64.deb`         | Open it with your software installer.                         |
| Fedora, RHEL, openSUSE                | `Kiln-Linux-x64.rpm`         | Open it with your software installer.                         |

**Not sure which Mac you have?** Click the Apple menu, then **About This Mac**. If it says **Chip: Apple M1** (or M2, M3 and so on), choose Apple Silicon. If it says **Processor: Intel**, choose Intel.

### The first time you open Kiln

Kiln is not yet signed with a paid developer certificate, so your computer may ask you to confirm that you trust it when opening a new version.

- **Windows:** if you see "Windows protected your PC", click **More info**, then **Run anyway**.
- **macOS:** if Kiln is blocked, open **System Settings > Privacy & Security**, scroll down and click **Open Anyway**.

You can check each download against `SHA256SUMS.txt` on the download page.

## Use Kiln in five steps

1. **Open a model.** Drop a file into the Kiln window, or click **Choose file**. Kiln works on a copy.
2. **Choose a quality.** Start with **Detailed web**. It keeps fine surface detail sharp for close study.
3. **Optimize.** Click **Optimize** and wait for the result.
4. **Compare up close.** Drag the divider to see the original and the result side by side. Zoom in, try **1:1 detail**, and switch to **Raking** light to reveal bumps and carving. Check every area that matters to you.
5. **Export.** Click **Export GLB**. Kiln saves two files next to each other: the web-ready model and its recipe.

### What you get

- **The `.glb` file** is the web-ready model. Upload this to your website or viewer.
- **The `.recipe.json` file** is a receipt. It records every setting, the tools used and a fingerprint of both the original and the result, so anyone can see exactly how the file was made, or make it again.

### Quality choices

- **Detailed web:** sharp close-ups on a desktop. The best place to start.
- **Lightweight:** quicker to open on phones and slow connections. Check fine details before choosing it.
- **Lossless:** every pixel kept. The largest download, for handing files to another archive.
- **Custom:** open **Advanced settings** to choose texture sizes, compression and more.

## Good to know

**Keep your original.** The file you open is your archival master. Kiln never changes it. The exported GLB is a lighter copy for the public, so store the original safely and treat the GLB as a delivery copy.

**Your files stay private.** Kiln does all of its work on your computer. It does not upload your models or use any AI service.

**Which files work?** GLB and glTF files work straight away. For USDZ, FBX, OBJ, PLY and STL files, install the free [Blender](https://www.blender.org/download/) app as well. Kiln finds it on its own, or you can point to it with **Locate Blender**.

**No 3D preview?** Some computers, such as virtual machines or remote desktops, cannot show 3D graphics. Kiln tells you when this happens. You can still optimize and export, but inspect the result on another computer before you publish it.

**A preset cannot know what matters to you.** Always look closely at the important parts of your object before you publish.

<details>
<summary><strong>Install or update from the command line</strong></summary>

These scripts download the latest version, check it against the published checksum, and add Kiln to your app menu. Run the same command again later to update. Close Kiln first.

**Windows (PowerShell):**

```powershell
Invoke-WebRequest https://github.com/hongnhatpham/kiln/releases/latest/download/install.ps1 -OutFile "$env:TEMP\kiln-install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\kiln-install.ps1"
```

**macOS or Linux (Terminal):**

```sh
curl -fL https://github.com/hongnhatpham/kiln/releases/latest/download/install.sh -o /tmp/kiln-install.sh
sh /tmp/kiln-install.sh
```

- You can read the script before running it. Add `-DryRun` (Windows) or `--dry-run` (macOS and Linux) to preview what it would do.
- Windows and macOS scripts install for your user account only, in `%LOCALAPPDATA%\Programs\Kiln` or `~/Applications/Kiln.app`. To remove Kiln, delete that folder or app and its menu shortcut.
- On Linux the script uses your normal package manager, which may ask for your password. Remove Kiln the same way you remove other packages.
- Pick either the Windows Setup file or the script, not both.
- The scripts keep your computer's normal security checks in place and never make Kiln start at login.
- A portable Windows version (`Kiln-Windows-x64-Portable.exe`) runs without installing. Mac `.zip` files are also provided.
- Linux on ARM and Windows on ARM are not supported yet. Linux needs a desktop environment.

</details>

<details>
<summary><strong>Technical details</strong></summary>

**Detailed web** uses 4K color, normal and occlusion maps, high-quality color compression, lossless resized normal maps, and the full mesh. **Lossless** keeps the original texture resolution and pixels with lossless geometry compression. **Custom** sets texture sizes and quality, texture format, mesh compression, simplification, quantization and metadata handling independently.

WebP and meshopt exports need a compatible web viewer. The recipe lists the required glTF extensions. A smaller download does not always mean less graphics memory; texture resolution controls that cost too.

The recipe records all settings, the source fingerprint, tool versions, validation results and the output fingerprint.

- [Optimization recipe and comparison with Cook](docs/optimization.md)
- [Verification and coverage limits](docs/verification.md)

</details>

## For developers

<details>
<summary><strong>Build and test Kiln</strong></summary>

Use Node 24 or later and pnpm.

```sh
pnpm install
pnpm dev
```

GLB and glTF processing is built in. USDZ and other authoring formats use a local Blender installation, which Kiln detects or lets you choose. No separate Python installation is needed.

```sh
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm package
```

`pnpm package` writes apps for your current operating system to `release/`. GitHub Actions builds Windows x64, Linux x64, macOS Intel and macOS Apple Silicon on native runners, then exercises each packaged app with a synthetic model. Tagged releases publish all installers and checksums together. Agent commands are listed by `pnpm agent --help`.

See [automatic releases on a free GitHub account](docs/releases.md). Push a tag matching the package version to build, verify and publish the next release. No large Actions artifacts or paid signing service are needed.

Source models, optimized exports, local caches and verification screenshots are excluded from Git.

</details>
