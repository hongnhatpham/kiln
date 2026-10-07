import { Document } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { quantize, reorder, simplify, weld } from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import type { OptimizationOptions } from "../shared/contracts.js";

// The geometry stage. With the defaults (ratio 1, no quantization) every vertex value is kept bit for bit:
// reorder only changes vertex and triangle order, and meshopt without filters is lossless byte compression.

/** Bit depths used when quantization is on. Generous for close-ups: 16-bit UVs stay sub-texel on 8K maps. */
export const QUANTIZE_BITS = {
  quantizePosition: 16,
  quantizeNormal: 12,
  quantizeTexcoord: 16,
  quantizeColor: 8,
  quantizeWeight: 8,
  quantizeGeneric: 12,
} as const;

export interface GeometryRecipe {
  simplify: { ratio: number; error: number } | null;
  quantize: typeof QUANTIZE_BITS | null;
  compression: "none" | "meshopt";
  meshoptMethod: "quantize" | "filter" | null;
  exactValues: boolean;
  notes: string[];
}

export async function processGeometry(
  doc: Document,
  o: OptimizationOptions,
): Promise<GeometryRecipe> {
  const notes: string[] = [];
  const used = (name: string) =>
    doc
      .getRoot()
      .listExtensionsUsed()
      .find((e) => e.extensionName === name);

  // Decoded Draco data is written uncompressed or as meshopt; Kiln does not re-encode Draco.
  const draco = used("KHR_draco_mesh_compression");
  if (draco) {
    draco.dispose();
    notes.push("Draco geometry was decoded. Its original quantization is kept as plain values.");
  }

  if (o.simplifyRatio < 1) {
    // Weld merges only bit-identical vertices, so simplification sees real topology instead of split seams.
    await doc.transform(
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: o.simplifyRatio, error: o.simplifyError }),
    );
  }
  if (o.quantize) await doc.transform(quantize({ ...QUANTIZE_BITS }));

  const meshopt = used(EXTMeshoptCompression.EXTENSION_NAME);
  let method: GeometryRecipe["meshoptMethod"] = null;
  if (o.meshCompression === "meshopt") {
    await doc.transform(reorder({ encoder: MeshoptEncoder, target: "size" }));
    method = o.quantize ? "filter" : "quantize";
    ((meshopt as EXTMeshoptCompression | undefined) ?? doc.createExtension(EXTMeshoptCompression))
      .setRequired(true)
      .setEncoderOptions({
        method: o.quantize
          ? EXTMeshoptCompression.EncoderMethod.FILTER
          : EXTMeshoptCompression.EncoderMethod.QUANTIZE,
      });
  } else meshopt?.dispose();

  return {
    simplify: o.simplifyRatio < 1 ? { ratio: o.simplifyRatio, error: o.simplifyError } : null,
    quantize: o.quantize ? QUANTIZE_BITS : null,
    compression: o.meshCompression,
    meshoptMethod: method,
    exactValues: o.simplifyRatio === 1 && !o.quantize,
    notes,
  };
}

/** Removes extras and XMP metadata. Names, copyright and the asset generator line stay. */
export function stripMetadata(doc: Document): number {
  const root = doc.getRoot();
  let cleared = 0;
  const lists = [
    root.listAccessors(),
    root.listAnimations(),
    root.listBuffers(),
    root.listCameras(),
    root.listMaterials(),
    root.listMeshes(),
    root.listNodes(),
    root.listScenes(),
    root.listSkins(),
    root.listTextures(),
    root.listMeshes().flatMap((m) => m.listPrimitives()),
    [root],
  ];
  for (const list of lists)
    for (const prop of list) {
      if (Object.keys(prop.getExtras()).length) {
        prop.setExtras({});
        cleared++;
      }
    }
  const xmp = root.listExtensionsUsed().find((e) => e.extensionName === "KHR_xmp_json_ld");
  if (xmp) {
    xmp.dispose();
    cleared++;
  }
  return cleared;
}
