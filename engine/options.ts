import type { OptimizationOptions, TextureFormat, TextureLimit } from "../shared/contracts.js";
import { KilnError } from "./errors.js";

const LIMITS: readonly TextureLimit[] = [0, 1024, 2048, 4096, 8192];
const FORMATS: readonly TextureFormat[] = ["webp", "png", "jpeg", "keep"];

/**
 * Validates options coming over IPC and returns a clean copy.
 * Throws `invalid-options` listing every problem, so the UI can show them together.
 */
export function normalizeOptions(input: unknown): OptimizationOptions {
  const problems: string[] = [];
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;

  const limit = (key: string, label: string): TextureLimit => {
    const value = o[key];
    if (typeof value === "number" && (LIMITS as readonly number[]).includes(value))
      return value as TextureLimit;
    problems.push(`${label} must be Original, 1024, 2048, 4096 or 8192 px.`);
    return 0;
  };
  const quality = (key: string, label: string): number => {
    const value = o[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
      return Math.round(value);
    problems.push(`${label} must be a number from 0 to 100.`);
    return 100;
  };
  const flag = (key: string, label: string): boolean => {
    const value = o[key];
    if (typeof value === "boolean") return value;
    problems.push(`${label} must be on or off.`);
    return false;
  };

  const textureFormat = FORMATS.includes(o.textureFormat as TextureFormat)
    ? (o.textureFormat as TextureFormat)
    : undefined;
  if (!textureFormat) problems.push("Texture format must be WebP, PNG, JPEG or Keep original.");
  const meshCompression =
    o.meshCompression === "none" || o.meshCompression === "meshopt" ? o.meshCompression : undefined;
  if (!meshCompression) problems.push("Mesh compression must be None or Meshopt.");

  const ratio = o.simplifyRatio;
  const simplifyRatio =
    typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0.1 && ratio <= 1 ? ratio : 1;
  if (simplifyRatio !== ratio)
    problems.push("Simplify ratio must be between 0.1 and 1 (1 keeps the full mesh).");
  const error = o.simplifyError;
  const simplifyError =
    typeof error === "number" && Number.isFinite(error) && error >= 0 && error <= 1 ? error : 0.001;
  if (simplifyError !== error) problems.push("Simplify error must be between 0 and 1.");

  const options: OptimizationOptions = {
    colorSize: limit("colorSize", "Color map size"),
    normalSize: limit("normalSize", "Normal map size"),
    aoSize: limit("aoSize", "AO and data map size"),
    textureFormat: textureFormat ?? "webp",
    losslessTextures: flag("losslessTextures", "Lossless textures"),
    colorQuality: quality("colorQuality", "Color quality"),
    normalLossless: flag("normalLossless", "Lossless normal map"),
    normalQuality: quality("normalQuality", "Normal quality"),
    aoQuality: quality("aoQuality", "AO quality"),
    meshCompression: meshCompression ?? "meshopt",
    simplifyRatio,
    simplifyError,
    quantize: flag("quantize", "Quantization"),
    preserveMetadata: flag("preserveMetadata", "Keep metadata"),
  };
  if (problems.length) throw new KilnError("invalid-options", problems.join(" "));
  return options;
}

/** Largest size that fits `limit` without upscaling, keeping aspect ratio. `0` keeps the original. */
export function targetSize(
  width: number,
  height: number,
  limit: TextureLimit,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (limit === 0 || longest <= limit) return { width, height };
  const scale = limit / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
