import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { PRESETS } from "../shared/presets.ts";
import type { OptimizationOptions, ProgressUpdate } from "../shared/contracts.ts";
import { createAssetService, type AssetService } from "../engine/service.ts";
import { decodeImage, samePixels } from "../engine/pixels.ts";
import { isKilnError } from "../engine/errors.ts";
import { createIO } from "../engine/io.ts";
import { exportFiles } from "../shared/export.ts";

const SIZE = 256;
let dir: string, service: AssetService, glbPath: string, sourceHash: string;
const progress: ProgressUpdate[] = [];
const sha = async (file: string) =>
  createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");

async function png(fill: (x: number, y: number) => number[], channels: 3 | 4) {
  const data = new Uint8Array(SIZE * SIZE * channels);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) data.set(fill(x, y), (y * SIZE + x) * channels);
  return new Uint8Array(
    await sharp(data, { raw: { width: SIZE, height: SIZE, channels } })
      .png()
      .toBuffer(),
  );
}

/** A quad drawn twice, with color (real transparency), normal, and one image shared by occlusion and emissive. */
async function buildFixture(file: string) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType("VEC3")
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]));
  const normal = doc
    .createAccessor()
    .setType("VEC3")
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]));
  const uv = doc
    .createAccessor()
    .setType("VEC2")
    .setBuffer(buffer)
    .setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]));
  const indices = doc
    .createAccessor()
    .setType("SCALAR")
    .setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]));
  const color = doc
    .createTexture("color")
    .setMimeType("image/png")
    .setImage(await png((x, y) => [x, y, (x * y) % 256, x < 64 ? 0 : 255], 4));
  const normalMap = doc
    .createTexture("normal")
    .setMimeType("image/png")
    .setImage(await png((x, y) => [128 + ((x * 3) % 60) - 30, 128 + ((y * 5) % 60) - 30, 230], 3));
  const shared = doc
    .createTexture("shared")
    .setMimeType("image/png")
    .setImage(await png((x, y) => [(x + y) % 256, 0, 0], 3));
  const material = doc
    .createMaterial("surface")
    .setBaseColorTexture(color)
    .setNormalTexture(normalMap)
    .setOcclusionTexture(shared)
    .setEmissiveTexture(shared)
    .setEmissiveFactor([1, 1, 1])
    .setRoughnessFactor(0.5)
    .setMetallicFactor(0)
    .setAlphaMode("MASK")
    .setAlphaCutoff(0.4);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setAttribute("TEXCOORD_0", uv)
    .setIndices(indices)
    .setMaterial(material);
  const mesh = doc.createMesh("quad").addPrimitive(prim);
  const scene = doc
    .createScene()
    .addChild(doc.createNode("a").setMesh(mesh))
    .addChild(doc.createNode("b").setMesh(mesh).setTranslation([2, 0, 0]));
  doc.getRoot().setDefaultScene(scene);
  doc.getRoot().setExtras({ archive: "synthetic" });
  await fs.writeFile(file, await new NodeIO().writeBinary(doc));
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-engine-"));
  glbPath = path.join(dir, "source", "fixture.glb");
  await fs.mkdir(path.dirname(glbPath));
  await buildFixture(glbPath);
  sourceHash = await sha(glbPath);
  service = await createAssetService({
    cacheDir: path.join(dir, "cache"),
    converterPath: path.resolve("resources/usd-to-gltf.py"),
    blenderPath: null,
    onProgress: (p) => progress.push(p),
  });
});
after(async () => {
  await service.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

const optimize = async (overrides: Partial<OptimizationOptions>, base = PRESETS.detailed) => {
  const { info } = await service.importAsset(glbPath, "import");
  return service.optimize(info.id, { ...base, ...overrides }, "opt");
};
const read = async (file: string) => (await createIO()).read(file);

test("imports a GLB with rendered counts, roles and an opaque id", async () => {
  const record = await service.importAsset(glbPath, "op-import");
  assert.match(record.info.id, /^[0-9a-f-]{36}$/);
  assert.equal(record.previewPath, glbPath, "self-contained GLBs preview in place");
  assert.equal(record.info.triangles, 4, "two instances of a two-triangle mesh");
  assert.equal(record.info.vertices, 8);
  assert.equal(record.info.meshCount, 1);
  assert.deepEqual(record.info.dimensions, [3, 1, 0]);
  assert.deepEqual(
    record.info.textures.map((t) => t.role),
    ["color", "normal", "other"],
  );
  assert.equal(record.info.gpuBytes, Math.round((3 * SIZE * SIZE * 4 * 4) / 3));
  assert.deepEqual(await service.getAsset(record.info.id), record);
  const stages = progress.filter((p) => p.operationId === "op-import");
  assert.equal(stages.at(-1)?.stage, "ready");
  assert.ok(
    stages.every((p, i) => i === 0 || p.percent >= stages[i - 1].percent),
    "progress only moves forward",
  );
});

test("external glTF buffers are protected from derivative export", async () => {
  const sourceDir = path.join(dir, "sidecars");
  await fs.mkdir(sourceDir);
  const bufferPath = path.join(sourceDir, "archive_public.glb");
  const input = path.join(sourceDir, "archive.gltf");
  const buffer = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  await fs.writeFile(bufferPath, buffer);
  await fs.writeFile(
    input,
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ uri: "archive_public.glb", byteLength: buffer.length }],
      bufferViews: [{ buffer: 0, byteLength: buffer.length }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  const imported = await service.importAsset(input, "import-sidecar");
  assert.deepEqual(imported.protectedSources, [input, bufferPath]);
  const result = await service.optimize(imported.info.id, PRESETS.lossless, "optimize-sidecar");
  await assert.rejects(
    exportFiles({
      modelSource: result.modelPath,
      modelPath: bufferPath,
      recipePath: path.join(sourceDir, "output.recipe.json"),
      recipe: result.recipe,
      protectedSources: imported.protectedSources,
    }),
    /original must stay intact/,
  );
  assert.deepEqual(await fs.readFile(bufferPath), buffer);
});

test("lossless preset keeps every pixel, vertex and material value", async () => {
  const result = await optimize({}, PRESETS.lossless);
  assert.equal(result.info.validationErrors, 0);
  const [src, out] = await Promise.all([read(glbPath), read(result.modelPath)]);
  const srcMat = src.getRoot().listMaterials()[0],
    outMat = out.getRoot().listMaterials()[0];
  assert.equal(outMat.getRoughnessFactor(), 0.5);
  assert.equal(outMat.getMetallicFactor(), 0);
  assert.equal(outMat.getAlphaMode(), "MASK");
  assert.equal(outMat.getAlphaCutoff(), 0.4);
  for (const slot of [
    "getBaseColorTexture",
    "getNormalTexture",
    "getOcclusionTexture",
    "getEmissiveTexture",
  ] as const) {
    const a = await decodeImage(srcMat[slot]()!.getImage()!),
      b = await decodeImage(outMat[slot]()!.getImage()!);
    assert.ok(samePixels(a, b), slot);
    assert.equal(outMat[slot]()!.getMimeType(), "image/webp");
  }
  const pos = (d: Document) =>
    Array.from(
      d.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION")!.getArray()!,
    );
  assert.deepEqual(pos(out).sort(), pos(src).sort());
  assert.ok(result.info.requiredExtensions.includes("EXT_meshopt_compression"));
  const textures = result.recipe.textures as { pixelsChanged: boolean; verifiedExact?: boolean }[];
  assert.ok(textures.every((t) => !t.pixelsChanged && t.verifiedExact));
  assert.deepEqual(await service.getResult(result.info.id), result);
  assert.equal(await sha(glbPath), sourceHash, "source untouched");
  assert.ok(!result.modelPath.startsWith(path.dirname(glbPath)), "output stays in the cache");
});

test("a texture shared by sRGB and linear roles is split before processing", async () => {
  const result = await optimize({});
  const mat = (await read(result.modelPath)).getRoot().listMaterials()[0];
  assert.notEqual(mat.getOcclusionTexture(), mat.getEmissiveTexture());
  assert.ok(result.info.warnings.some((w) => w.includes("own copy")));
});

test("JPEG never drops transparency", async () => {
  const result = await optimize({ textureFormat: "jpeg", normalLossless: false });
  const mat = (await read(result.modelPath)).getRoot().listMaterials()[0];
  assert.equal(mat.getBaseColorTexture()!.getMimeType(), "image/png");
  assert.equal(mat.getNormalTexture()!.getMimeType(), "image/jpeg");
  assert.ok(result.info.warnings.some((w) => w.includes("transparency")));
  const color = await decodeImage(mat.getBaseColorTexture()!.getImage()!);
  assert.equal(color.data[3], 0, "transparent texel kept");
});

test("resizing, quality, quantization and metadata options have real effects", async () => {
  const small = await optimize(
    { colorSize: 1024, normalSize: 1024, aoSize: 1024 },
    PRESETS.lightweight,
  );
  assert.ok(
    small.info.textures.every((t) => t.width === SIZE),
    "never upscales",
  );
  const low = await optimize({
    colorQuality: 20,
    normalLossless: false,
    normalQuality: 20,
    aoQuality: 20,
  });
  const high = await optimize({
    colorQuality: 98,
    normalLossless: false,
    normalQuality: 98,
    aoQuality: 98,
  });
  assert.ok(low.info.bytes < high.info.bytes);
  const quantized = await optimize({ quantize: true });
  assert.ok(quantized.info.requiredExtensions.includes("KHR_mesh_quantization"));
  assert.equal(quantized.info.validationErrors, 0);
  const plain = await optimize({ meshCompression: "none", preserveMetadata: false });
  assert.deepEqual(plain.info.requiredExtensions, ["EXT_texture_webp"]);
  assert.deepEqual((await read(plain.modelPath)).getRoot().getExtras(), {});
  assert.equal((plain.recipe.source as { sha256: string }).sha256, sourceHash);
});

test("refuses links outside the model folder or to the network", async () => {
  for (const [i, uri] of [
    "../secret.bin",
    "https://example.com/a.bin",
    "C:/Windows/win.ini",
    "C%3A%2FWindows%2Fwin.ini",
    "\\\\server\\share\\asset.bin",
  ].entries()) {
    const gltf = path.join(dir, "source", `link-${i}.gltf`);
    await fs.writeFile(
      gltf,
      JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri, byteLength: 4 }] }),
    );
    await assert.rejects(service.importAsset(gltf, "guard"), (e: unknown) =>
      isKilnError(e, "unsafe-path"),
    );
  }
});

test("typed errors for bad input, unknown ids and cancellation", async () => {
  await assert.rejects(service.importAsset(path.join(dir, "missing.glb"), "x"), (e: unknown) =>
    isKilnError(e, "not-found"),
  );
  const txt = path.join(dir, "notes.txt");
  await fs.writeFile(txt, "x");
  await assert.rejects(service.importAsset(txt, "x"), (e: unknown) =>
    isKilnError(e, "unsupported-format"),
  );
  await assert.rejects(service.optimize("nope", PRESETS.detailed, "x"), (e: unknown) =>
    isKilnError(e, "unknown-asset"),
  );
  const { info } = await service.importAsset(glbPath, "x");
  await assert.rejects(
    service.optimize(info.id, { ...PRESETS.detailed, colorQuality: 300 }, "x"),
    (e: unknown) => isKilnError(e, "invalid-options"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    service.optimize(info.id, PRESETS.detailed, "x", controller.signal),
    (e: unknown) => isKilnError(e, "cancelled") && (e as Error).name === "AbortError",
  );
});

test("release removes one asset and its result work directories, preserving originals", async () => {
  const source = await service.importAsset(glbPath, "release-import");
  const result = await service.optimize(source.info.id, PRESETS.detailed, "release-optimize");
  const assetDir = path.join(
    path.dirname(path.dirname(path.dirname(result.modelPath))),
    "assets",
    source.info.id,
  );
  await service.releaseAsset(source.info.id);
  assert.equal(await service.getAsset(source.info.id), undefined);
  assert.equal(await service.getResult(result.info.id), undefined);
  await assert.rejects(fs.stat(path.dirname(result.modelPath)), { code: "ENOENT" });
  await assert.rejects(fs.stat(assetDir), { code: "ENOENT" });
  assert.equal(await sha(glbPath), sourceHash);
  await service.releaseAsset(source.info.id);
});

test("release frees records even if one temporary folder cannot be removed", async (t) => {
  const source = await service.importAsset(glbPath, "release-failed-import");
  const result = await service.optimize(
    source.info.id,
    PRESETS.detailed,
    "release-failed-optimize",
  );
  const rm = fs.rm.bind(fs);
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]).endsWith(source.info.id)) throw new Error("injected cleanup failure");
    return rm(...args);
  });
  await assert.rejects(service.releaseAsset(source.info.id), /temporary model files/);
  assert.equal(await service.getAsset(source.info.id), undefined);
  assert.equal(await service.getResult(result.info.id), undefined);
  await assert.rejects(fs.stat(path.dirname(result.modelPath)), { code: "ENOENT" });
  assert.equal(await sha(glbPath), sourceHash);
});
