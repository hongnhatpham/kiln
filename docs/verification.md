# Kiln 0.1 verification

Verified on Windows 11 with Blender 5.2.

- Type checks, lint and formatting pass.
- All 30 logic tests pass, including texture vector handling, linear-light color resize, transparent pixels, 16-bit PNG, material preservation, shared texture roles, source sidecars, hard links, export rollback and cooperative shutdown.
- Actual Electron workflows cover GLB and USDZ import, optimization, source/result comparison, close-up and raking-light views, orbit and zoom, keyboard divider control, custom settings, error recovery, cancellation and export with a matching recipe fingerprint.
- Original files remain byte-identical after the desktop workflows.
- A representative 139 MB USDZ becomes a 15.2 MB public GLB through the app, retaining all 99,999 triangles and 56,684 vertices. Khronos validation reports zero errors.
- The direct USD conversion matches the independently checked reference geometry, UVs, material values, transforms and original texture bytes.
- Independent visual review accepted both the interface and the app's derivative. Whole-object views and fine close-ups remain close to the original. Extreme magnification shows expected fine-grain softening from the 8K to 4K resize.
- A synthetic OBJ exercises the Blender fallback importer successfully.
- The packaged Windows application passes the full USDZ workflow and interaction checks. Its bundled renderer matches the verified build.
- The portable executable extracts, opens the real interface and connects to its packaged processing engine successfully.

The verification artifacts stay local in `artifacts/`. Agent commands reproduce desktop checks without publishing source assets.

## Coverage limits

Native file dialog paths are supplied by the desktop test driver; the real processing, preview and export code runs normally. No real phone, Safari, macOS or Linux acceptance test was performed. Other authoring formats and every possible USD feature have not been exhaustively tested. Blender fallback conversion can approximate materials, and Kiln reports that trade-off.

Texture memory figures estimate decoded RGBA with mipmaps. Actual device memory and performance vary. Structural validation and image comparisons complement human inspection; they do not certify research suitability for every asset.
