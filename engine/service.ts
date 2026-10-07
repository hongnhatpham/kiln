import { VERSION as GLTF_TRANSFORM_VERSION } from "@gltf-transform/core";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type {
  AssetInfo,
  OptimizationOptions,
  OptimizationResult,
  ProgressUpdate,
} from "../shared/contracts.js";
import { discoverBlender, probeBlender } from "./blender.js";
import {
  BLENDER_FORMATS,
  GLTF_FORMATS,
  USD_FORMATS,
  formatOf,
  prepareSource,
  type Conversion,
} from "./convert.js";
import { KilnError, throwIfAborted } from "./errors.js";
import { processGeometry, stripMetadata } from "./geometry.js";
import {
  geometryStats,
  gpuBytes,
  listTextures,
  requiredExtensions,
  usedExtensions,
  viewerWarnings,
} from "./inspect.js";
import { createIO } from "./io.js";
import { normalizeOptions } from "./options.js";
import { processTextures } from "./textures.js";
import { validateGlb } from "./validate.js";

export const ENGINE_VERSION = "0.1.0";

export interface AssetServiceConfig {
  /** Folder the engine owns. Everything it writes stays below `<cacheDir>/engine`. */
  cacheDir: string;
  /** Path to `resources/usd-to-gltf.py`. Its folder also holds `blender-import.py`. */
  converterPath: string;
  blenderPath?: string | null;
  onProgress: (progress: ProgressUpdate) => void;
}
export interface AssetRecord {
  info: Omit<AssetInfo, "previewUrl">;
  previewPath: string;
  protectedSources: string[];
}
export interface ResultRecord {
  info: Omit<OptimizationResult, "previewUrl">;
  modelPath: string;
  recipe: Record<string, unknown>;
}
export interface EngineEnvironment {
  blenderPath: string | null;
  supportedFormats: string[];
}

interface SourceState {
  record: AssetRecord;
  sourcePath: string;
  masterPath: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  conversion: Conversion;
  conversionWarnings: string[];
}

const STALE_MS = 24 * 60 * 60 * 1000;

export async function createAssetService(config: AssetServiceConfig) {
  const io = await createIO();
  const engineDir = path.join(path.resolve(config.cacheDir), "engine");
  const sessionDir = path.join(engineDir, `session-${randomUUID()}`);
  const scriptsDir = path.dirname(path.resolve(config.converterPath));
  const sources = new Map<string, SourceState>();
  const results = new Map<string, ResultRecord>();
  let blenderPath: string | null = null;
  let blenderVersion: string | null = null;

  await fs.mkdir(sessionDir, { recursive: true });
  await sweepStaleSessions(engineDir, sessionDir);

  async function useBlender(candidate: string | null | undefined) {
    const version = candidate ? await probeBlender(candidate) : null;
    if (version) {
      blenderPath = candidate!;
      blenderVersion = version;
      return true;
    }
    return false;
  }
  if (!(await useBlender(config.blenderPath))) await useBlender(await discoverBlender());

  function environment(): EngineEnvironment {
    const formats: string[] = [...GLTF_FORMATS];
    if (blenderPath) formats.push(...USD_FORMATS, ...BLENDER_FORMATS);
    return { blenderPath, supportedFormats: formats };
  }

  /** Progress that only moves forward within one operation. */
  function reporter(operationId: string) {
    let last = 0;
    return (stage: ProgressUpdate["stage"], percent: number, message: string) => {
      last = Math.max(last, Math.min(100, Math.round(percent)));
      config.onProgress({ operationId, stage, percent: last, message });
    };
  }

  async function guard<T>(dir: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (error instanceof KilnError) throw error;
      throw new KilnError("read-failed", error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
  }

  async function importAsset(
    sourcePath: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<AssetRecord> {
    const progress = reporter(operationId);
    progress("importing", 0, "Opening file");
    const resolved = path.resolve(sourcePath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isFile())
      throw new KilnError(
        "not-found",
        "That file could not be found. It may have been moved or deleted.",
      );
    const format = formatOf(resolved);
    if (!environment().supportedFormats.includes(format)) {
      const needsBlender = ([...USD_FORMATS, ...BLENDER_FORMATS] as string[]).includes(format);
      throw needsBlender
        ? new KilnError(
            "blender-missing",
            `Opening .${format} files needs Blender on this computer. Install Blender or choose its location, then try again.`,
          )
        : new KilnError(
            "unsupported-format",
            `Kiln cannot open .${format} files. Use GLB, glTF, USDZ, USD, OBJ, FBX, PLY or STL.`,
          );
    }
    const id = randomUUID();
    const workDir = path.join(sessionDir, "assets", id);
    await fs.mkdir(workDir, { recursive: true });
    return guard(workDir, async () => {
      progress("importing", 2, "Fingerprinting source");
      const sha256 = await hashFile(resolved, signal);
      throwIfAborted(signal);
      const prepared = await prepareSource(resolved, {
        io,
        workDir,
        blenderPath,
        scriptsDir,
        signal,
        progress: (f, message) => progress("importing", 10 + f * 75, message),
      });
      throwIfAborted(signal);
      progress("importing", 90, "Inspecting model");
      const doc = prepared.document;
      const stats = geometryStats(doc);
      const textures = listTextures(doc);
      const gpu = gpuBytes(textures);
      const required = requiredExtensions(doc);
      const warnings = [...prepared.warnings, ...viewerWarnings(textures, gpu, required)];
      if (required.includes("KHR_draco_mesh_compression"))
        warnings.push(
          "Uses Draco geometry compression. Kiln decodes it and can write meshopt instead.",
        );
      if (stats.instances === 0) warnings.push("The model has no visible geometry in its scene.");
      const info: AssetRecord["info"] = {
        id,
        name: path.basename(resolved),
        sourcePath: resolved,
        sourceBytes: stat.size,
        vertices: stats.vertices,
        triangles: stats.triangles,
        meshCount: stats.meshCount,
        materials: doc.getRoot().listMaterials().length,
        dimensions: stats.dimensions,
        textures,
        gpuBytes: gpu,
        warnings,
      };
      const record: AssetRecord = {
        info,
        previewPath: prepared.masterPath,
        protectedSources: prepared.protectedSources,
      };
      sources.set(id, {
        record,
        sourcePath: resolved,
        masterPath: prepared.masterPath,
        sha256,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        conversion: prepared.conversion,
        conversionWarnings: prepared.warnings,
      });
      progress("ready", 100, "Ready");
      return record;
    });
  }

  async function optimize(
    assetId: string,
    input: OptimizationOptions,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ResultRecord> {
    const options = normalizeOptions(input);
    const source = sources.get(assetId);
    if (!source) throw new KilnError("unknown-asset", "Open the asset again before optimizing.");
    const started = performance.now();
    const progress = reporter(operationId);
    progress("importing", 0, "Loading model");
    if (source.masterPath === source.sourcePath) {
      const stat = await fs.stat(source.sourcePath).catch(() => null);
      if (!stat || stat.size !== source.size || stat.mtimeMs !== source.mtimeMs) {
        throw new KilnError(
          "source-changed",
          "The source file changed or moved since it was opened. Open it again to continue.",
        );
      }
    }
    const id = randomUUID();
    const workDir = path.join(sessionDir, "results", id);
    await fs.mkdir(workDir, { recursive: true });
    return guard(workDir, async () => {
      const doc = await io.read(source.masterPath);
      const before = geometryStats(doc);
      const beforeTextures = listTextures(doc);
      throwIfAborted(signal);

      progress("textures", 5, "Processing textures");
      const textureStage = await processTextures(
        doc,
        options,
        (f, m) => progress("textures", 5 + f * 65, m),
        signal,
      );
      throwIfAborted(signal);

      progress("geometry", 72, "Processing geometry");
      const geometry = await processGeometry(doc, options);
      const metadataCleared = options.preserveMetadata ? 0 : stripMetadata(doc);
      throwIfAborted(signal);

      progress("geometry", 80, "Writing GLB");
      const bytes = await io.writeBinary(doc);
      const modelPath = path.join(workDir, "model.glb");
      await fs.writeFile(modelPath, bytes);
      throwIfAborted(signal);

      progress("validating", 88, "Validating with the Khronos glTF Validator");
      const validation = await validateGlb(bytes);
      const after = geometryStats(doc);
      const textures = listTextures(doc);
      const gpu = gpuBytes(textures);
      const required = requiredExtensions(doc);
      const warnings = [
        ...textureStage.warnings,
        ...geometry.notes,
        ...viewerWarnings(textures, gpu, required),
      ];
      if (required.includes("EXT_meshopt_compression"))
        warnings.push(
          "Needs a viewer with meshopt support. In three.js, call GLTFLoader.setMeshoptDecoder(MeshoptDecoder).",
        );
      if (validation.errors)
        warnings.push(
          `The Khronos validator found ${validation.errors} error${validation.errors > 1 ? "s" : ""}. Some viewers may refuse this file.`,
        );
      if (options.simplifyRatio < 1)
        warnings.push(
          `Simplified to ${after.triangles.toLocaleString("en-US")} triangles from ${before.triangles.toLocaleString("en-US")}.`,
        );

      const info: ResultRecord["info"] = {
        id,
        sourceId: assetId,
        name: source.record.info.name,
        bytes: bytes.byteLength,
        triangles: after.triangles,
        vertices: after.vertices,
        textures,
        gpuBytes: gpu,
        elapsedMs: Math.round(performance.now() - started),
        options,
        warnings,
        validationErrors: validation.errors,
        requiredExtensions: required,
      };
      const recipe = {
        schema: "kiln-recipe/1",
        createdAt: new Date().toISOString(),
        engine: {
          kilnEngine: ENGINE_VERSION,
          gltfTransform: GLTF_TRANSFORM_VERSION,
          sharp: sharp.versions.sharp,
          libvips: sharp.versions.vips,
          libwebp: sharp.versions.webp,
          mozjpeg: sharp.versions.mozjpeg,
          validator: validation.validator,
          blender:
            source.conversion === "pxr-direct" || source.conversion === "blender-import"
              ? blenderVersion
              : null,
        },
        source: {
          name: source.record.info.name,
          format: formatOf(source.sourcePath),
          bytes: source.size,
          sha256: source.sha256,
          conversion: source.conversion,
          conversionWarnings: source.conversionWarnings,
        },
        settings: options,
        rules: {
          colorMaps:
            "base color, emissive and other sRGB maps follow color size and quality; resized in linear light",
          normalMaps:
            "follow normal size; resized as vectors and renormalized; lossless when normalLossless or losslessTextures is on",
          dataMaps: "occlusion, metal/rough and other linear maps follow AO size and quality",
          losslessTextures:
            "every re-encoded texture is lossless (WebP lossless or PNG); quality values are ignored",
          sameFormat:
            "textures already in the chosen format at the chosen size keep their original bytes",
          upscaling: "never",
        },
        textures: textureStage.recipes,
        geometry: { ...geometry, before: pickCounts(before), after: pickCounts(after) },
        materials: {
          count: doc.getRoot().listMaterials().length,
          preserved:
            "all material factors, alpha modes, samplers, texture transforms and extensions are kept; only texture images change",
          notes: textureStage.warnings.filter((w) => w.includes("role")),
        },
        metadata: options.preserveMetadata
          ? "kept"
          : { extrasCleared: metadataCleared, kept: "names, copyright" },
        output: {
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          usedExtensions: usedExtensions(doc),
          requiredExtensions: required,
          gpuBytesEstimate: gpu,
          textureBytes: textures.reduce((s, t) => s + t.bytes, 0),
          sourceTextureBytes: beforeTextures.reduce((s, t) => s + t.bytes, 0),
        },
        validation,
        warnings,
      };
      const record: ResultRecord = { info, modelPath, recipe };
      results.set(id, record);
      progress("ready", 100, "Ready");
      return record;
    });
  }

  return {
    environment: async (): Promise<EngineEnvironment> => environment(),
    async setBlenderPath(file: string | null): Promise<EngineEnvironment> {
      if (file === null) {
        blenderPath = null;
        blenderVersion = null;
        await useBlender(await discoverBlender());
      } else if (!(await useBlender(path.resolve(file)))) {
        throw new KilnError(
          "blender-invalid",
          "This file was not recognized as Blender. Choose the Blender application and try again.",
        );
      }
      return environment();
    },
    importAsset,
    optimize,
    getAsset: async (id: string): Promise<AssetRecord | undefined> => sources.get(id)?.record,
    getResult: async (id: string): Promise<ResultRecord | undefined> => results.get(id),
    /** Deletes this session's cache. Source files are never inside it. */
    async dispose() {
      sources.clear();
      results.clear();
      await fs.rm(sessionDir, { recursive: true, force: true });
    },
  };
}

export type AssetService = Awaited<ReturnType<typeof createAssetService>>;

const pickCounts = (s: ReturnType<typeof geometryStats>) => ({
  vertices: s.vertices,
  triangles: s.triangles,
  storedVertices: s.storedVertices,
  storedTriangles: s.storedTriangles,
  meshes: s.meshCount,
});

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    throwIfAborted(signal);
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** Removes session folders left by crashed runs. Only touches `session-<uuid>` folders older than a day. */
async function sweepStaleSessions(engineDir: string, current: string) {
  const entries = await fs.readdir(engineDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(engineDir, entry.name);
      if (!entry.isDirectory() || full === current || !/^session-[0-9a-f-]{36}$/.test(entry.name))
        return;
      const stat = await fs.stat(full).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_MS)
        await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    }),
  );
}
