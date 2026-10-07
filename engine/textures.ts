import { Document, Root, Texture } from "@gltf-transform/core";
import { EXTTextureWebP } from "@gltf-transform/extensions";
import type { OptimizationOptions, TextureLimit } from "../shared/contracts.js";
import { throwIfAborted } from "./errors.js";
import {
  reportedRole,
  slotClass,
  textureName,
  textureSize,
  textureUses,
  type TextureUse,
} from "./inspect.js";
import { targetSize } from "./options.js";
import {
  FORMAT_MIME,
  MIME_FORMAT,
  decodeImage,
  encodeImage,
  isOpaque,
  resizeImage,
  samePixels,
  to8Bit,
  type EncodeFormat,
  type PixelClass,
  type RawImage,
} from "./pixels.js";

// The texture stage: decides per texture what to do from its material roles and the options,
// then resizes and encodes. Material settings, samplers and texture transforms are never touched.

export interface TextureRecipe {
  name: string;
  role: string;
  slots: string[];
  before: { width: number; height: number; mimeType: string; bytes: number };
  after: { width: number; height: number; mimeType: string; bytes: number };
  action: "kept" | "re-encoded" | "resized";
  encoding: { format: string; lossless: boolean; quality: number | null } | null;
  pixelsChanged: boolean;
  /** Set when lossless output was decoded again and compared with the source pixels. */
  verifiedExact?: boolean;
  notes: string[];
}

interface ClassSettings {
  limit: TextureLimit;
  lossless: boolean;
  quality: number;
}

export function classSettings(cls: PixelClass, o: OptimizationOptions): ClassSettings {
  if (cls === "color")
    return { limit: o.colorSize, lossless: o.losslessTextures, quality: o.colorQuality };
  if (cls === "normal")
    return {
      limit: o.normalSize,
      lossless: o.losslessTextures || o.normalLossless,
      quality: o.normalQuality,
    };
  return { limit: o.aoSize, lossless: o.losslessTextures, quality: o.aoQuality };
}

/**
 * Gives every processing class its own texture copy when one image is used in incompatible roles,
 * for example as base color (sRGB) and occlusion (linear). Returns notes for the report.
 * Packed maps used only by compatible roles, such as occlusion plus metal/rough, stay shared.
 * A slot that cannot be reassigned leaves the texture shared; processTexture then keeps it unchanged.
 */
export function splitConflictingTextures(doc: Document): string[] {
  const notes: string[] = [];
  const graph = doc.getGraph();
  for (const use of textureUses(doc)) {
    if (use.classes.size < 2) continue;
    const label = use.texture.getName() || "A texture";
    const [, ...others] = [...use.classes];
    const edges = graph
      .listParentEdges(use.texture)
      .filter((edge) => !(edge.getParent() instanceof Root))
      .map((edge) => ({
        slot: edge.getName(),
        parent: edge.getParent() as unknown as Record<string, unknown>,
      }));
    const setterFor = (e: (typeof edges)[number]) =>
      e.parent[`set${e.slot[0].toUpperCase()}${e.slot.slice(1)}`];
    if (
      edges.some((e) => others.includes(slotClass(e.slot)) && typeof setterFor(e) !== "function")
    ) {
      notes.push(
        `"${label}" is used in conflicting roles that Kiln cannot separate, so it was kept unchanged.`,
      );
      continue;
    }
    for (const cls of others) {
      const copy = use.texture.clone().setName(`${use.texture.getName() || "texture"}_${cls}`);
      for (const e of edges)
        if (slotClass(e.slot) === cls) (setterFor(e) as (t: Texture) => void).call(e.parent, copy);
    }
    notes.push(
      `"${label}" was used as ${[...use.classes].join(" and ")}, so each role got its own copy and is processed correctly.`,
    );
  }
  return notes;
}

export interface TextureStageResult {
  recipes: TextureRecipe[];
  warnings: string[];
}

export async function processTextures(
  doc: Document,
  options: OptimizationOptions,
  progress: (fraction: number, message: string) => void,
  signal?: AbortSignal,
): Promise<TextureStageResult> {
  const warnings = splitConflictingTextures(doc);
  const uses = textureUses(doc);
  const recipes: TextureRecipe[] = [];
  const counts = { jpegAlpha: 0, jpegLossless: 0, depth: 0, undecodable: 0, unused: 0 };

  for (let i = 0; i < uses.length; i++) {
    throwIfAborted(signal);
    const use = uses[i];
    const name = textureName(use.texture, i);
    progress(i / uses.length, `Processing texture ${i + 1} of ${uses.length}: ${name}`);
    const recipe = await processTexture(use, name, options, counts);
    recipes.push(recipe);
  }
  progress(1, "Textures ready");

  if (counts.jpegAlpha)
    warnings.push(
      `${counts.jpegAlpha} texture${counts.jpegAlpha > 1 ? "s have" : " has"} transparency that JPEG cannot store, so PNG was used instead.`,
    );
  if (counts.jpegLossless)
    warnings.push(
      `JPEG cannot be lossless, so ${counts.jpegLossless} texture${counts.jpegLossless > 1 ? "s were" : " was"} saved as PNG to keep every pixel.`,
    );
  if (counts.depth)
    warnings.push(
      `${counts.depth} texture${counts.depth > 1 ? "s were" : " was"} reduced from 16-bit to 8-bit color. Turn on lossless textures to keep 16-bit PNG.`,
    );
  if (counts.undecodable)
    warnings.push(
      `${counts.undecodable} texture${counts.undecodable > 1 ? "s use" : " uses"} a format Kiln cannot edit (such as KTX2) and ${counts.undecodable > 1 ? "were" : "was"} kept unchanged.`,
    );

  // EXT_texture_webp must be present exactly when a WebP texture remains.
  const hasWebP = doc
    .getRoot()
    .listTextures()
    .some((t) => t.getMimeType() === "image/webp");
  const existing = doc
    .getRoot()
    .listExtensionsUsed()
    .find((e) => e.extensionName === EXTTextureWebP.EXTENSION_NAME);
  if (hasWebP) (existing ?? doc.createExtension(EXTTextureWebP)).setRequired(true);
  else existing?.dispose();
  return { recipes, warnings };
}

async function processTexture(
  use: TextureUse,
  name: string,
  o: OptimizationOptions,
  counts: Record<string, number>,
): Promise<TextureRecipe> {
  const { texture } = use;
  const image = texture.getImage();
  const mimeType = texture.getMimeType();
  const size = textureSize(texture) ?? [0, 0];
  const before = { width: size[0], height: size[1], mimeType, bytes: image?.byteLength ?? 0 };
  const base: TextureRecipe = {
    name,
    role: reportedRole(use.slots),
    slots: use.slots,
    before,
    after: before,
    action: "kept",
    encoding: null,
    pixelsChanged: false,
    notes: [],
  };
  const sourceFormat = MIME_FORMAT[mimeType];
  if (!image || !use.classes.size)
    return { ...base, notes: ["Not used by any material, kept unchanged."] };
  if (!sourceFormat) {
    counts.undecodable++;
    return { ...base, notes: [`${mimeType} cannot be edited, kept unchanged.`] };
  }
  if (use.classes.size > 1)
    return { ...base, notes: ["Used in conflicting roles, kept unchanged to stay safe."] };

  const cls = [...use.classes][0];
  const settings = classSettings(cls, o);
  const target = targetSize(before.width, before.height, settings.limit);
  const resize = target.width !== before.width || target.height !== before.height;
  let format: EncodeFormat = o.textureFormat === "keep" ? sourceFormat : o.textureFormat;

  // Same format at the same size: keep the original bytes. Re-encoding lossy files again only adds loss,
  // and lossless re-encoding of the same format gains little for a long encode.
  if (!resize && format === sourceFormat)
    return {
      ...base,
      notes: ["Already in the chosen format at the chosen size, kept byte for byte."],
    };
  // A lossless request on a JPEG at its original size: the JPEG bytes are the exact pixels and far smaller than a lossless copy.
  if (!resize && settings.lossless && sourceFormat === "jpeg")
    return {
      ...base,
      notes: [
        "Kept the original JPEG: a lossless copy would hold the same pixels in a larger file.",
      ],
    };

  const source = await decodeImage(image);
  const notes: string[] = [];
  if (format === "jpeg" && settings.lossless) {
    format = "png";
    counts.jpegLossless++;
    notes.push("Saved as PNG because JPEG cannot be lossless.");
  }
  if (format === "jpeg" && !isOpaque(source)) {
    format = "png";
    counts.jpegAlpha++;
    notes.push("Saved as PNG to keep transparency.");
  }
  const keep16 = source.bits === 16 && settings.lossless;
  if (keep16 && format !== "png") {
    format = "png";
    notes.push("Saved as 16-bit PNG, the only web format that keeps 16-bit data.");
  }
  if (source.bits === 16 && !keep16) counts.depth++;

  let pixels: RawImage = resize
    ? await resizeImage(source, target.width, target.height, cls, keep16)
    : source;
  if (!keep16) pixels = to8Bit(pixels);
  const lossless = format === "png" || settings.lossless;
  const quality = lossless ? null : settings.quality;
  const encoded = await encodeImage(pixels, { format, lossless, quality: quality ?? 100 }, cls);

  let verifiedExact: boolean | undefined;
  if (lossless && !resize && source.bits === pixels.bits) {
    verifiedExact = samePixels(source, await decodeImage(encoded));
    if (!verifiedExact) throw new Error(`Lossless encoding changed pixels in ${name}.`);
  }
  texture.setImage(encoded).setMimeType(FORMAT_MIME[format]);
  const uri = texture.getURI();
  if (uri)
    texture.setURI(uri.replace(/\.[^./\\]+$/, "") + "." + (format === "jpeg" ? "jpg" : format));
  if (resize && cls === "normal")
    notes.push("Normals averaged as vectors and renormalized to unit length.");
  if (resize && cls === "color")
    notes.push("Resized in linear light, then converted back to sRGB.");
  return {
    ...base,
    after: {
      width: pixels.width,
      height: pixels.height,
      mimeType: FORMAT_MIME[format],
      bytes: encoded.byteLength,
    },
    action: resize ? "resized" : "re-encoded",
    encoding: { format, lossless, quality },
    pixelsChanged: resize || !lossless || source.bits !== pixels.bits,
    verifiedExact,
    notes,
  };
}
