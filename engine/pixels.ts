import sharp from "sharp";
import { KilnError } from "./errors.js";

// Pixel work for one texture: decode, role-aware resize, encode, verify.
// Everything runs on raw pixels with embedded ICC profiles ignored, because glTF treats texture values
// as data: base color is sRGB by definition and every other map is linear.

/** How a texture's pixels must be treated. `data` covers occlusion, metal/rough and other linear maps. */
export type PixelClass = "color" | "normal" | "data";
export type EncodeFormat = "webp" | "png" | "jpeg";

export interface RawImage {
  width: number;
  height: number;
  /** Always RGB or RGBA after decoding; gray inputs are expanded. */
  channels: 3 | 4;
  bits: 8 | 16;
  data: Uint8Array | Uint16Array;
}

export interface EncodePlan {
  format: EncodeFormat;
  lossless: boolean;
  quality: number;
}

const SHARP_INPUT = { ignoreIcc: true, limitInputPixels: false } as const;

function u16(buffer: Buffer): Uint16Array {
  if (buffer.byteOffset % 2 === 0)
    return new Uint16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
  return new Uint16Array(Uint8Array.from(buffer).buffer);
}
const u8 = (buffer: Buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

export const MIME_FORMAT: Record<string, EncodeFormat | undefined> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};
export const FORMAT_MIME: Record<EncodeFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export async function decodeImage(bytes: Uint8Array): Promise<RawImage> {
  try {
    const meta = await sharp(bytes, SHARP_INPUT).metadata();
    const bits = meta.depth === "ushort" || meta.depth === "short" ? 16 : 8;
    const pipeline = sharp(bytes, SHARP_INPUT);
    const { data, info } =
      bits === 16
        ? // Without an explicit 16-bit colourspace sharp hands back 8-bit values in 16-bit storage.
          await pipeline
            .toColourspace((meta.channels ?? 3) <= 2 ? "grey16" : "rgb16")
            .raw({ depth: "ushort" })
            .toBuffer({ resolveWithObject: true })
        : await pipeline.raw().toBuffer({ resolveWithObject: true });
    const pixels = bits === 16 ? u16(data) : u8(data);
    return expandChannels({
      width: info.width,
      height: info.height,
      bits,
      channels: info.channels,
      data: pixels,
    });
  } catch (error) {
    throw new KilnError(
      "texture-failed",
      "A texture could not be decoded. The file may be damaged or use an unsupported image format.",
      { cause: error },
    );
  }
}

/** Gray becomes RGB and gray+alpha becomes RGBA, so every later step handles exactly 3 or 4 channels. */
function expandChannels(img: {
  width: number;
  height: number;
  bits: 8 | 16;
  channels: number;
  data: Uint8Array | Uint16Array;
}): RawImage {
  const { channels, data } = img;
  if (channels === 3 || channels === 4) return { ...img, channels };
  if (channels !== 1 && channels !== 2)
    throw new KilnError("texture-failed", `Textures with ${channels} channels are not supported.`);
  const n = img.width * img.height;
  const outChannels = channels === 1 ? 3 : 4;
  const out = img.bits === 16 ? new Uint16Array(n * outChannels) : new Uint8Array(n * outChannels);
  for (let i = 0; i < n; i++) {
    const g = data[i * channels];
    out[i * outChannels] = g;
    out[i * outChannels + 1] = g;
    out[i * outChannels + 2] = g;
    if (channels === 2) out[i * 4 + 3] = data[i * 2 + 1];
  }
  return { width: img.width, height: img.height, bits: img.bits, channels: outChannels, data: out };
}

/** True when the image has no alpha channel or every alpha value is fully opaque. */
export function isOpaque(img: RawImage): boolean {
  if (img.channels === 3) return true;
  const max = img.bits === 16 ? 65535 : 255;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== max) return false;
  return true;
}

// sRGB transfer functions (IEC 61966-2-1).
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (l: number) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
let linear16To8: Uint8Array | undefined, linear16To16: Uint16Array | undefined;
const srgb8ToLinear16 = Uint16Array.from({ length: 256 }, (_, v) =>
  Math.round(toLinear(v / 255) * 65535),
);
let srgb16ToLinear16: Uint16Array | undefined;

/**
 * Resizes with Lanczos3 in 16-bit precision, never upscaling.
 * color: converted to linear light first (alpha premultiplied by sharp), then back to sRGB.
 * normal: the linear 0..1 encoding is filtered (equal to averaging vectors), then every texel is renormalized.
 * data: filtered as linear values, alpha handled separately so it never bleeds into data channels.
 */
export async function resizeImage(
  img: RawImage,
  width: number,
  height: number,
  cls: PixelClass,
  keep16 = false,
): Promise<RawImage> {
  if (width > img.width || height > img.height)
    throw new KilnError("texture-failed", "Textures are never upscaled.");
  const { channels } = img;
  const n = img.width * img.height;
  const work = new Uint16Array(n * channels);
  const src = img.data;
  if (cls === "color") {
    const lut =
      img.bits === 8
        ? srgb8ToLinear16
        : (srgb16ToLinear16 ??= Uint16Array.from({ length: 65536 }, (_, v) =>
            Math.round(toLinear(v / 65535) * 65535),
          ));
    for (let i = 0; i < src.length; i++)
      work[i] =
        channels === 4 && i % 4 === 3 ? (img.bits === 8 ? src[i] * 257 : src[i]) : lut[src[i]];
  } else if (img.bits === 8) {
    for (let i = 0; i < src.length; i++) work[i] = src[i] * 257;
  } else work.set(src);

  let resized: Uint16Array;
  if (channels === 4 && cls !== "color") {
    const rgb = new Uint16Array(n * 3),
      alpha = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = work[i * 4];
      rgb[i * 3 + 1] = work[i * 4 + 1];
      rgb[i * 3 + 2] = work[i * 4 + 2];
      alpha[i] = work[i * 4 + 3];
    }
    const [r, a] = await Promise.all([
      resize16(rgb, img.width, img.height, 3, width, height),
      resize16(alpha, img.width, img.height, 1, width, height),
    ]);
    resized = new Uint16Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      resized[i * 4] = r[i * 3];
      resized[i * 4 + 1] = r[i * 3 + 1];
      resized[i * 4 + 2] = r[i * 3 + 2];
      resized[i * 4 + 3] = a[i];
    }
  } else resized = await resize16(work, img.width, img.height, channels, width, height);

  const bits: 8 | 16 = keep16 && img.bits === 16 ? 16 : 8;
  const out = bits === 16 ? new Uint16Array(resized.length) : new Uint8Array(resized.length);
  if (cls === "normal") renormalize(resized, channels, out);
  else if (cls === "color") {
    const lut =
      bits === 8
        ? (linear16To8 ??= Uint8Array.from({ length: 65536 }, (_, v) =>
            Math.round(toSrgb(v / 65535) * 255),
          ))
        : (linear16To16 ??= Uint16Array.from({ length: 65536 }, (_, v) =>
            Math.round(toSrgb(v / 65535) * 65535),
          ));
    for (let i = 0; i < resized.length; i++)
      out[i] =
        channels === 4 && i % 4 === 3
          ? bits === 8
            ? Math.round(resized[i] / 257)
            : resized[i]
          : lut[resized[i]];
  } else if (bits === 8)
    for (let i = 0; i < resized.length; i++) out[i] = Math.round(resized[i] / 257);
  else out.set(resized);
  return { width, height, channels, bits, data: out };
}

async function resize16(
  data: Uint16Array,
  w: number,
  h: number,
  channels: 1 | 3 | 4,
  tw: number,
  th: number,
): Promise<Uint16Array> {
  const buffer = await sharp(data, {
    raw: { width: w, height: h, channels },
    limitInputPixels: false,
  })
    .resize(tw, th, { kernel: "lanczos3", fit: "fill" })
    .toColourspace(channels === 1 ? "grey16" : "rgb16")
    .raw({ depth: "ushort" })
    .toBuffer();
  return u16(buffer);
}

/** Decodes 16-bit tangent-space normals to vectors, makes them unit length and writes them at the output depth. */
export function renormalize(src: Uint16Array, channels: number, out: Uint8Array | Uint16Array) {
  const max = out instanceof Uint16Array ? 65535 : 255;
  for (let i = 0; i < src.length; i += channels) {
    let x = (src[i] / 65535) * 2 - 1,
      y = (src[i + 1] / 65535) * 2 - 1,
      z = (src[i + 2] / 65535) * 2 - 1;
    const length = Math.hypot(x, y, z);
    if (length < 1e-6) {
      x = 0;
      y = 0;
      z = 1;
    } else {
      x /= length;
      y /= length;
      z /= length;
    }
    out[i] = Math.round(((x + 1) / 2) * max);
    out[i + 1] = Math.round(((y + 1) / 2) * max);
    out[i + 2] = Math.round(((z + 1) / 2) * max);
    if (channels === 4) out[i + 3] = max === 255 ? Math.round(src[i + 3] / 257) : src[i + 3];
  }
}

/** 16-bit to 8-bit by rounding, for lossy targets that cannot store 16 bits. */
export function to8Bit(img: RawImage): RawImage {
  if (img.bits === 8) return img;
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(img.data[i] / 257);
  return { ...img, bits: 8, data: out };
}

export async function encodeImage(
  img: RawImage,
  plan: EncodePlan,
  cls: PixelClass,
): Promise<Uint8Array> {
  if (img.bits === 16 && plan.format !== "png")
    throw new KilnError("texture-failed", "Only PNG can store 16-bit textures.");
  let s = sharp(img.data, {
    raw: { width: img.width, height: img.height, channels: img.channels },
    limitInputPixels: false,
  });
  if (img.bits === 16) s = s.toColourspace("rgb16");
  if (plan.format === "png") s = s.png({ compressionLevel: 9 });
  else if (plan.format === "webp") {
    s = plan.lossless
      ? s.webp({ lossless: true, exact: true, effort: 4 })
      : // Sharp YUV conversion keeps chroma detail; alpha stays lossless so cutouts and masks keep their edges.
        s.webp({
          quality: plan.quality,
          effort: 5,
          smartSubsample: true,
          alphaQuality: 100,
          exact: true,
        });
  } else {
    if (plan.lossless)
      throw new KilnError("texture-failed", "JPEG cannot store textures losslessly.");
    if (img.channels === 4) {
      if (!isOpaque(img)) throw new KilnError("texture-failed", "JPEG cannot store transparency.");
      s = s.removeAlpha();
    }
    // Full chroma resolution for data, normals and high-quality color keeps fine surface detail.
    const subsample = cls === "color" && plan.quality < 90 ? "4:2:0" : "4:4:4";
    s = s.jpeg({ quality: plan.quality, mozjpeg: true, chromaSubsampling: subsample });
  }
  return u8(await s.toBuffer());
}

/** Exact comparison; a missing alpha channel counts as fully opaque. */
export function samePixels(a: RawImage, b: RawImage): boolean {
  if (a.width !== b.width || a.height !== b.height || a.bits !== b.bits) return false;
  const max = a.bits === 16 ? 65535 : 255;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 4; c++) {
      const va = c < a.channels ? a.data[i * a.channels + c] : max;
      const vb = c < b.channels ? b.data[i * b.channels + c] : max;
      if (va !== vb) return false;
    }
  }
  return true;
}
