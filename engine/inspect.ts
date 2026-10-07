import {
  Document,
  ImageUtils,
  Primitive,
  Root,
  Texture,
  getBounds,
  type Node,
} from "@gltf-transform/core";
import type { InstancedMesh } from "@gltf-transform/extensions";
import type { TextureInfo } from "../shared/contracts.js";
import type { PixelClass } from "./pixels.js";

// Read-only statistics about a glTF document.

/** Texture slots holding sRGB color. Every other non-normal slot holds linear data. */
const COLOR_SLOTS = new Set([
  "baseColorTexture",
  "emissiveTexture",
  "sheenColorTexture",
  "specularColorTexture",
  "diffuseTexture",
  "specularGlossinessTexture",
]);

export interface TextureUse {
  texture: Texture;
  /** Material slot names (edge names), such as `baseColorTexture` or `clearcoatNormalTexture`. */
  slots: string[];
  classes: Set<PixelClass>;
}

export function slotClass(slot: string): PixelClass {
  if (/normal/i.test(slot)) return "normal";
  return COLOR_SLOTS.has(slot) ? "color" : "data";
}

/** Every texture with the material slots that use it. Unused textures have no slots. */
export function textureUses(doc: Document): TextureUse[] {
  const graph = doc.getGraph();
  return doc
    .getRoot()
    .listTextures()
    .map((texture) => {
      const slots = graph
        .listParentEdges(texture)
        .filter((edge) => !(edge.getParent() instanceof Root))
        .map((edge) => edge.getName());
      return { texture, slots: [...new Set(slots)], classes: new Set(slots.map(slotClass)) };
    });
}

export function reportedRole(slots: string[]): TextureInfo["role"] {
  const classes = new Set(slots.map(slotClass));
  if (classes.size !== 1) return "other";
  if (classes.has("color")) return "color";
  if (classes.has("normal")) return "normal";
  return slots.includes("occlusionTexture") ? "ao" : "other";
}

export function textureName(texture: Texture, index: number) {
  const uri = texture.getURI().split(/[\\/]/).pop();
  return texture.getName() || uri || `texture_${index}`;
}

export function textureSize(texture: Texture): [number, number] | null {
  const image = texture.getImage();
  const size = image ? ImageUtils.getSize(image, texture.getMimeType()) : null;
  return size ? [size[0], size[1]] : null;
}

export function listTextures(doc: Document): TextureInfo[] {
  return textureUses(doc).map(({ texture, slots }, i) => {
    const size = textureSize(texture);
    return {
      name: textureName(texture, i),
      role: reportedRole(slots),
      width: size?.[0] ?? 0,
      height: size?.[1] ?? 0,
      bytes: texture.getImage()?.byteLength ?? 0,
      mimeType: texture.getMimeType(),
    };
  });
}

/** Decoded RGBA8 with a full mip chain (4/3 of the base level), the way WebGL viewers upload PNG, JPEG and WebP. */
export const gpuBytes = (textures: TextureInfo[]) =>
  Math.round(textures.reduce((sum, t) => sum + t.width * t.height * 4 * (4 / 3), 0));

export function primitiveTriangles(prim: Primitive): number {
  const count = prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION")?.getCount() ?? 0;
  switch (prim.getMode()) {
    case Primitive.Mode.TRIANGLES:
      return Math.floor(count / 3);
    case Primitive.Mode.TRIANGLE_STRIP:
    case Primitive.Mode.TRIANGLE_FAN:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

export interface GeometryStats {
  /** Totals as rendered: meshes used by several nodes or GPU instances count once per instance. */
  vertices: number;
  triangles: number;
  /** Totals for the stored mesh data, each mesh counted once. */
  storedVertices: number;
  storedTriangles: number;
  meshCount: number;
  instances: number;
  dimensions: [number, number, number];
}

function instanceCount(node: Node): number {
  const instancing = node.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
  return instancing?.listAttributes()[0]?.getCount() ?? 1;
}

export function geometryStats(doc: Document): GeometryStats {
  const root = doc.getRoot();
  const meshTotals = new Map(
    root.listMeshes().map((mesh) => {
      let vertices = 0,
        triangles = 0;
      for (const prim of mesh.listPrimitives()) {
        vertices += prim.getAttribute("POSITION")?.getCount() ?? 0;
        triangles += primitiveTriangles(prim);
      }
      return [mesh, { vertices, triangles }] as const;
    }),
  );
  let vertices = 0,
    triangles = 0,
    instances = 0;
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  scene?.traverse((node) => {
    const mesh = node.getMesh();
    const totals = mesh && meshTotals.get(mesh);
    if (!totals) return;
    const count = instanceCount(node);
    instances += count;
    vertices += totals.vertices * count;
    triangles += totals.triangles * count;
  });
  let storedVertices = 0,
    storedTriangles = 0;
  for (const t of meshTotals.values()) {
    storedVertices += t.vertices;
    storedTriangles += t.triangles;
  }
  if (!scene) {
    vertices = storedVertices;
    triangles = storedTriangles;
  }
  let dimensions: [number, number, number] = [0, 0, 0];
  if (scene && instances > 0) {
    const { min, max } = getBounds(scene);
    dimensions = [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) =>
      Number.isFinite(v) ? v : 0,
    ) as [number, number, number];
  }
  return {
    vertices,
    triangles,
    storedVertices,
    storedTriangles,
    meshCount: root.listMeshes().length,
    instances,
    dimensions,
  };
}

export const usedExtensions = (doc: Document) =>
  doc
    .getRoot()
    .listExtensionsUsed()
    .map((e) => e.extensionName)
    .sort();
export const requiredExtensions = (doc: Document) =>
  doc
    .getRoot()
    .listExtensionsRequired()
    .map((e) => e.extensionName)
    .sort();

/** Extensions three.js and model-viewer load out of the box or with their standard decoders. */
const WEB_FRIENDLY = new Set([
  "EXT_meshopt_compression",
  "EXT_texture_webp",
  "KHR_mesh_quantization",
  "KHR_texture_transform",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_clearcoat",
  "KHR_materials_transmission",
  "KHR_materials_volume",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_iridescence",
  "KHR_materials_unlit",
  "KHR_lights_punctual",
  "KHR_draco_mesh_compression",
  "KHR_texture_basisu",
  "EXT_mesh_gpu_instancing",
  "KHR_materials_anisotropy",
  "KHR_materials_dispersion",
  "KHR_xmp_json_ld",
]);

const MB = 1024 * 1024;

/** Viewer-facing warnings shared by imports and results. */
export function viewerWarnings(textures: TextureInfo[], gpu: number, required: string[]): string[] {
  const warnings: string[] = [];
  const large = textures.filter((t) => Math.max(t.width, t.height) > 4096);
  if (large.length)
    warnings.push(
      `${large.length} texture${large.length > 1 ? "s are" : " is"} larger than 4096 px. Many phones cannot display textures that large.`,
    );
  if (gpu > 768 * MB)
    warnings.push(
      `Textures need about ${Math.round(gpu / MB)} MB of GPU memory once decoded. That is likely too much for phones.`,
    );
  else if (gpu > 384 * MB)
    warnings.push(
      `Textures need about ${Math.round(gpu / MB)} MB of GPU memory once decoded. Older phones may struggle.`,
    );
  const unusual = required.filter((e) => !WEB_FRIENDLY.has(e));
  if (unusual.length)
    warnings.push(
      `Requires ${unusual.join(", ")}. Check that your web viewer supports ${unusual.length > 1 ? "these extensions" : "this extension"}.`,
    );
  return warnings;
}
