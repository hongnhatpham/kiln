# Web archival optimization

Kiln keeps processing local and leaves the archival master intact. It produces a public delivery copy and a recipe that explains how that copy was made.

## Detailed web recipe

| Component                      | Setting                              | Reason                                          |
| ------------------------------ | ------------------------------------ | ----------------------------------------------- |
| Color                          | Maximum 4096 px, WebP quality 95     | Smaller download with fine visible detail       |
| Normal                         | Maximum 4096 px, lossless WebP       | Protect relief from additional compression loss |
| Occlusion and linear data maps | Maximum 4096 px, WebP quality 90     | Preserve shading detail at lower delivery cost  |
| Geometry                       | Full mesh, lossless meshopt encoding | Keep shape and triangle count                   |
| Quantization                   | Off                                  | Avoid coordinate rounding                       |
| Metadata                       | Kept                                 | Preserve supported glTF extras and names        |

Maps are never upscaled. Color is resized in linear light. Normal vectors are filtered and renormalized. Data channels are filtered without treating their values as color. Textures shared by conflicting material roles are handled conservatively. Alpha and 16-bit inputs receive additional safeguards.

Lossless encoding means the encoder preserves the pixels it receives. Resizing still changes pixels and can soften fine detail. Use the **Lossless** preset to keep the original resolution as well. Imported authoring formats may require conversion, so that preset does not promise an exact copy of every feature in every source format.

## Inspect before publishing

Compare the outline, surface grain, seams, markings, thin parts and transparent regions. Use the same camera and lighting for the source and optimized copies. Raking light reveals normal-map changes. Look at both a whole-object view and a close-up representative of public use.

Download size and graphics memory are different. Compressed WebP is decoded by a browser; a 4K RGBA texture with mipmaps uses about 85 MiB. Three such maps need about 256 MiB before geometry and other viewer costs. For modest phones, inspect the **Lightweight** preset too. Real phone and Safari testing is still necessary for a public site's supported devices.

Exports using WebP and meshopt require compatible loaders. For Three.js, configure `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)`. The recipe lists the actual required extensions. PNG and uncompressed mesh settings provide a broader compatibility option.

The Khronos validator checks the output structure. It cannot fully validate every extension, and it cannot judge visual fidelity. Kiln reports these limits and any detected conversion issues.

## Smithsonian Cook

[Cook](https://smithsonian.github.io/dpo-cook/docs/) is a job and recipe system that coordinates external 3D tools. It does not inherently make a model smaller or more faithful than the same tools used directly. No same-model Cook benchmark was run for this project.

Cook is attractive for collection-scale jobs, batches, multiple derivatives, fallback tools and Smithsonian Voyager metadata. Kiln offers a smaller local desktop workflow focused on inspection and public web derivatives.

Cook's standard [generate-web-gltf recipe](https://github.com/smithsonian/dpo-cook/blob/master/server/recipes/generate-web-gltf.json) uses decimation, UV rebuilding and rebaking, 4096 maps, JPEG quality 59 for color and AO, quality 69 for normals, and Draco. Those defaults introduce more loss than Kiln's Detailed web preset. They may be suitable for lightweight browsing, but deserve careful close-up review for research use.

The current [Blender input dispatcher](https://github.com/smithsonian/dpo-cook/blob/master/server/scripts/BlenderConvert.py) needs an adapter for USD/USDZ input. Some Cook workflows also use commercial tools. The inspected source did not include a built-in meshopt or KTX2/Basis path.

Choose Cook when the collection workflow benefits justify its setup. For the present companion to vdrs-website, Kiln's direct local pipeline and visual comparison are the simpler fit.
