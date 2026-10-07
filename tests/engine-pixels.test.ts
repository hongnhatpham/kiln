import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import {
  decodeImage,
  encodeImage,
  isOpaque,
  resizeImage,
  samePixels,
  type RawImage,
} from "../engine/pixels.ts";

const image = (
  width: number,
  height: number,
  channels: 3 | 4,
  fill: (x: number, y: number) => number[],
): RawImage => {
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * channels);
  return { width, height, channels, bits: 8, data };
};
const encodeNormal = (v: number[]) => {
  const l = Math.hypot(...v);
  return v.map((c) => Math.round((c / l + 1) * 127.5));
};
const decodeNormal = (p: ArrayLike<number>, i: number) =>
  [0, 1, 2].map((c) => p[i + c] / 127.5 - 1);
/** Pixel offsets away from the border; Lanczos edge padding legitimately differs within 3 px of an edge. */
const interior = (img: RawImage, margin = 3) => {
  const out: number[] = [];
  for (let y = margin; y < img.height - margin; y++)
    for (let x = margin; x < img.width - margin; x++) out.push((y * img.width + x) * img.channels);
  return out;
};

test("normal maps are averaged as vectors and renormalized", async () => {
  // Alternating strong tilts left and right: a plain average would shrink toward a short, flattened vector.
  const src = image(64, 64, 3, (x) => encodeNormal(x % 2 ? [0.8, 0, 0.6] : [-0.8, 0, 0.6]));
  const out = await resizeImage(src, 32, 32, "normal");
  for (let i = 0; i < out.data.length; i += 3) {
    const [x, y, z] = decodeNormal(out.data, i);
    assert.ok(
      Math.abs(Math.hypot(x, y, z) - 1) < 0.01,
      "every texel is unit length, edges included",
    );
  }
  for (const i of interior(out)) {
    const [x, , z] = decodeNormal(out.data, i);
    assert.ok(Math.abs(x) < 0.02 && z > 0.99, "opposite tilts cancel to straight up");
  }
});

test("color maps are resized in linear light", async () => {
  const src = image(64, 64, 3, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
  const out = await resizeImage(src, 32, 32, "color");
  // Half white, half black is 50% linear light, which is sRGB 188, not the naive 128.
  for (const i of interior(out)) assert.ok(Math.abs(out.data[i] - 188) <= 1, `got ${out.data[i]}`);
});

test("flat color and data survive a resize exactly", async () => {
  const flat = image(16, 16, 4, () => [37, 140, 222, 255]);
  for (const cls of ["color", "data", "normal"] as const) {
    const out = await resizeImage(flat, 8, 8, cls);
    if (cls !== "normal") assert.deepEqual(Array.from(out.data.slice(0, 4)), [37, 140, 222, 255]);
  }
});

test("data maps keep values where alpha is zero", async () => {
  const src = image(8, 8, 4, () => [200, 100, 50, 0]);
  const out = await resizeImage(src, 4, 4, "data");
  assert.deepEqual(Array.from(out.data.slice(0, 4)), [200, 100, 50, 0]);
});

test("lossless WebP and PNG keep every pixel, including color under transparency", async () => {
  const src = image(32, 32, 4, (x, y) => [x * 7, y * 7, (x * y) % 256, (x + y) % 3 ? 255 : 0]);
  for (const format of ["webp", "png"] as const) {
    const back = await decodeImage(
      await encodeImage(src, { format, lossless: true, quality: 100 }, "color"),
    );
    assert.ok(samePixels(src, back), format);
  }
});

test("JPEG refuses transparency instead of dropping it, and drops only opaque alpha", async () => {
  const transparent = image(4, 4, 4, () => [10, 20, 30, 128]);
  assert.equal(isOpaque(transparent), false);
  await assert.rejects(
    encodeImage(transparent, { format: "jpeg", lossless: false, quality: 90 }, "color"),
    /transparency/,
  );
  await assert.rejects(
    encodeImage(transparent, { format: "jpeg", lossless: true, quality: 100 }, "color"),
    /losslessly/,
  );
  const opaque = image(4, 4, 4, () => [10, 20, 30, 255]);
  const jpeg = await encodeImage(opaque, { format: "jpeg", lossless: false, quality: 90 }, "color");
  assert.equal((await sharp(jpeg).metadata()).format, "jpeg");
});

test("quality changes the encoded size", async () => {
  const noisy = image(64, 64, 3, (x, y) => [
    (x * 37 + y * 11) % 256,
    (x * y * 13) % 256,
    ((x ^ y) * 4) % 256,
  ]);
  const low = await encodeImage(noisy, { format: "webp", lossless: false, quality: 40 }, "color");
  const high = await encodeImage(noisy, { format: "webp", lossless: false, quality: 95 }, "color");
  assert.ok(low.byteLength < high.byteLength);
});

test("16-bit PNG decodes and re-encodes at 16 bits", async () => {
  const data = new Uint16Array(4 * 4 * 3).map((_, i) => 1000 + i * 977);
  const png = await sharp(data, { raw: { width: 4, height: 4, channels: 3 } })
    .toColourspace("rgb16")
    .png()
    .toBuffer();
  const img = await decodeImage(png);
  assert.equal(img.bits, 16);
  assert.deepEqual([...img.data], [...data]);
  const back = await decodeImage(
    await encodeImage(img, { format: "png", lossless: true, quality: 100 }, "data"),
  );
  assert.ok(samePixels(img, back));
});
