import type { OptimizationOptions, PresetId } from "./contracts.js";
const base: OptimizationOptions = {
  colorSize: 4096,
  normalSize: 4096,
  aoSize: 4096,
  textureFormat: "webp",
  losslessTextures: false,
  colorQuality: 95,
  normalLossless: true,
  normalQuality: 95,
  aoQuality: 90,
  meshCompression: "meshopt",
  simplifyRatio: 1,
  simplifyError: 0.001,
  quantize: false,
  preserveMetadata: true,
};
export const PRESETS: Record<Exclude<PresetId, "custom">, OptimizationOptions> = {
  detailed: { ...base },
  lightweight: {
    ...base,
    colorSize: 2048,
    normalSize: 2048,
    aoSize: 1024,
    colorQuality: 85,
    aoQuality: 85,
  },
  lossless: {
    ...base,
    colorSize: 0,
    normalSize: 0,
    aoSize: 0,
    colorQuality: 100,
    normalQuality: 100,
    aoQuality: 100,
    losslessTextures: true,
  },
};
