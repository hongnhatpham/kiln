# Kiln

Kiln prepares archival 3D assets for public web viewing. It is a local desktop companion to [vdrs-website](https://github.com/hongnhatpham/vdrs-website).

Open a model, choose a quality preset, inspect the result, and export a GLB with its processing recipe. Your archival original stays intact. Processing and previews run on your computer.

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

The Windows portable application is written to `release/`. Agent commands and examples are listed by `pnpm agent --help`.

## Quality choices

- **Detailed web:** 4K color, normal and occlusion maps, high-quality color compression, lossless resized normals, and the full mesh. Start here for surface detail and close-ups.
- **Lightweight:** smaller maps for faster public viewing. Inspect important details before choosing it.
- **Lossless:** preserve original texture resolution and pixels, with lossless geometry compression.
- **Custom:** independently set texture sizes and quality, texture format, mesh compression, simplification, quantization and metadata handling.

WebP and meshopt exports require a compatible web viewer. The export recipe records the required extensions and all processing settings. Smaller downloads do not always mean less GPU memory; texture resolution controls that cost too.

## Local data

Source models, optimized exports, local caches and verification screenshots are excluded from Git. The application does not upload models or use an AI service.

## Use the desktop app

1. Open the Windows portable executable. GLB and glTF work immediately. Install Blender locally for USDZ and other authoring formats, then use **Locate Blender** if it is not detected.
2. Open or drop a model. Start with **Detailed web** for fine surface detail.
3. Use **Advanced settings** to change the map sizes, encoding, mesh settings and metadata policy.
4. Optimize, then inspect the source and result together. Orbit, zoom, move the comparison divider and use raking light to inspect relief.
5. Export. Kiln saves a GLB and a matching `.recipe.json` with settings, source fingerprint, tool versions, validation and output fingerprint.

Keep your master file as the archival record. Public derivatives are delivery copies. Inspect every important region before publishing: a preset cannot determine which details matter to your research.

See [the optimization recipe and Cook comparison](docs/optimization.md).

See [verification and coverage limits](docs/verification.md).
