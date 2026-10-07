import type {
  AssetInfo,
  OptimizationOptions,
  PresetId,
  TextureFormat,
  TextureInfo,
  TextureLimit,
} from "../../shared/contracts.ts";
import { PRESETS } from "../../shared/presets.ts";
import { formatPixels } from "./format.ts";

export type FixedPreset = Exclude<PresetId, "custom">;
export type MapRole = "color" | "normal" | "ao";

export const PRESET_ORDER: FixedPreset[] = ["detailed", "lightweight", "lossless"];

export const PRESET_COPY: Record<FixedPreset, { name: string; purpose: string }> = {
  detailed: {
    name: "Detailed web",
    purpose: "Sharp close-ups on desktop. The default for public study.",
  },
  lightweight: { name: "Lightweight", purpose: "Quick to open on phones and slow connections." },
  lossless: {
    name: "Lossless",
    purpose: "Every pixel kept. Largest download, for archival handoff.",
  },
};

export const SIZE_CHOICES: TextureLimit[] = [0, 8192, 4096, 2048, 1024];

export const FORMAT_COPY: Record<TextureFormat, { label: string; hint: string }> = {
  webp: { label: "WebP", hint: "Smallest files. Opens in all current browsers." },
  png: { label: "PNG", hint: "Always lossless. Expect large files." },
  jpeg: { label: "JPEG", hint: "Widest support, lossy only. Risky for normal maps." },
  keep: { label: "Keep", hint: "Keeps each texture's original format." },
};

/** Viewer-facing names for glTF extensions a result may require. */
export const EXTENSION_COPY: Record<string, string> = {
  EXT_meshopt_compression: "Meshopt decoder",
  KHR_meshopt_compression: "Meshopt decoder",
  EXT_texture_webp: "WebP textures",
  KHR_mesh_quantization: "Quantized geometry",
  KHR_draco_mesh_compression: "Draco decoder",
  KHR_texture_basisu: "KTX2 textures",
  KHR_texture_transform: "Texture transforms",
  KHR_materials_emissive_strength: "Emissive strength",
};

export function presetFor(options: OptimizationOptions): PresetId {
  for (const id of PRESET_ORDER) {
    const preset = PRESETS[id];
    const same = (Object.keys(preset) as (keyof OptimizationOptions)[]).every(
      (key) => preset[key] === options[key],
    );
    if (same) return id;
  }
  return "custom";
}

/** One-line spec built from the preset values, so tuned presets describe themselves. */
export function presetSpec(options: OptimizationOptions): string {
  const size = (limit: TextureLimit) => (limit === 0 ? "original" : formatPixels(limit));
  const parts: string[] = [];
  if (options.colorSize === options.normalSize && options.normalSize === options.aoSize) {
    parts.push(
      options.colorSize === 0 ? "Original size maps" : `All maps ${size(options.colorSize)}`,
    );
  } else {
    parts.push(
      `Color ${size(options.colorSize)}`,
      `normal ${size(options.normalSize)}`,
      `AO ${size(options.aoSize)}`,
    );
  }
  if (options.losslessTextures) parts.push("lossless");
  else {
    parts.push(`quality ${options.colorQuality}`);
    if (options.normalLossless) parts.push("lossless normals");
  }
  return parts.join(", ");
}

export function roleTexture(asset: AssetInfo | null, role: MapRole): TextureInfo | undefined {
  return asset?.textures.find((texture) => texture.role === role);
}

function limitFor(options: OptimizationOptions, role: TextureInfo["role"]): TextureLimit {
  if (role === "normal") return options.normalSize;
  if (role === "ao") return options.aoSize;
  return options.colorSize;
}

/** Size of a texture after the limit is applied. Kiln never upsizes. */
export function targetSize(
  texture: Pick<TextureInfo, "width" | "height">,
  limit: TextureLimit,
): [number, number] {
  const longest = Math.max(texture.width, texture.height);
  if (limit === 0 || longest <= limit) return [texture.width, texture.height];
  const scale = limit / longest;
  return [
    Math.max(1, Math.round(texture.width * scale)),
    Math.max(1, Math.round(texture.height * scale)),
  ];
}

/** Decoded RGBA plus a full mip chain. Matches how viewers upload uncompressed textures. */
export function textureGpuBytes(width: number, height: number): number {
  return Math.round((width * height * 4 * 4) / 3);
}

/** Estimated graphics memory after optimization: source geometry cost plus resized textures. */
export function estimateGpuBytes(asset: AssetInfo, options: OptimizationOptions): number {
  const sourceTextureBytes = asset.textures.reduce(
    (sum, t) => sum + textureGpuBytes(t.width, t.height),
    0,
  );
  const geometryBytes =
    Math.max(0, asset.gpuBytes - sourceTextureBytes) * Math.max(0.01, options.simplifyRatio);
  const textureBytes = asset.textures.reduce((sum, texture) => {
    const [w, h] = targetSize(texture, limitFor(options, texture.role));
    return sum + textureGpuBytes(w, h);
  }, 0);
  return geometryBytes + textureBytes;
}

/** Extensions the exported file will likely require, before the engine reports the real list. */
export function expectedExtensions(
  asset: AssetInfo | null,
  options: OptimizationOptions,
): string[] {
  const list: string[] = [];
  if (options.meshCompression === "meshopt") list.push("EXT_meshopt_compression");
  const keepsWebp =
    options.textureFormat === "keep" && asset?.textures.some((t) => t.mimeType === "image/webp");
  if (options.textureFormat === "webp" || keepsWebp) list.push("EXT_texture_webp");
  if (options.quantize) list.push("KHR_mesh_quantization");
  return list;
}

export function viewerNeeds(extensions: string[]): string[] {
  const names = extensions.map((ext) => EXTENSION_COPY[ext] ?? ext);
  return [...new Set(names)];
}

/** Whether a lossy quality slider has any effect with these options. */
export function qualityApplies(options: OptimizationOptions, role: MapRole): boolean {
  if (options.losslessTextures || options.textureFormat === "png") return false;
  if (role === "normal" && options.normalLossless) return false;
  return true;
}

/** Plain-language risk notes shown next to the controls they belong to. */
export function normalRisk(options: OptimizationOptions): string | null {
  if (!qualityApplies(options, "normal")) return null;
  if (options.textureFormat === "jpeg") {
    return "JPEG blocks bend surface directions. Expect blotchy shading in raking light and close-ups.";
  }
  if (options.normalQuality < 90) {
    return "Low quality normal maps soften fine relief such as tool marks and weave.";
  }
  return null;
}
