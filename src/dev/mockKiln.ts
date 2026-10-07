import type {
  AssetInfo,
  KilnAPI,
  OptimizationOptions,
  OptimizationResult,
  ProgressUpdate,
  TextureInfo,
} from "../../shared/contracts.ts";

/**
 * Development-only stand-in for the Electron bridge. It never fakes geometry: previews are real GLB
 * files served from a local folder you pass in the URL, for example
 *   ?assets=http://127.0.0.1:8098/&source=reference/model.glb&optimized=model_public.glb
 * Stats are fixed sample numbers for a single-mesh scan with three 8K maps. Nothing is optimized here.
 * `&fail=import|optimize|export` rehearses errors. Never bundled: `loadApi` imports it only in dev without a preload.
 */
export function createMockKiln(params: URLSearchParams): KilnAPI {
  const base = params.get("assets") ?? "";
  const sourceUrl = params.get("source") ? new URL(params.get("source")!, base).href : "";
  const optimizedUrl = params.get("optimized")
    ? new URL(params.get("optimized")!, base).href
    : sourceUrl;
  const fail = params.get("fail");
  const listeners = new Set<(progress: ProgressUpdate) => void>();
  let cancelled = false;
  const files = new Map<string, File>();

  const tex = (
    name: string,
    role: TextureInfo["role"],
    size: number,
    bytes: number,
    mimeType: string,
  ): TextureInfo => ({
    name,
    role,
    width: size,
    height: size,
    bytes,
    mimeType,
  });
  const gpu = (size: number) => Math.round((size * size * 16) / 3);

  const asset = (name: string, previewUrl: string): AssetInfo => ({
    id: "mock-source",
    name,
    sourcePath: `/scans/${name}`,
    sourceBytes: 139_307_972,
    previewUrl,
    vertices: 56_684,
    triangles: 99_999,
    meshCount: 1,
    materials: 1,
    dimensions: [0.931, 0.618, 0.876],
    textures: [
      tex("color", "color", 8192, 53_454_587, "image/png"),
      tex("normal", "normal", 8192, 56_256_726, "image/png"),
      tex("ao", "ao", 8192, 27_356_604, "image/png"),
    ],
    gpuBytes: gpu(8192) * 3 + 2_400_000,
    warnings: [
      "3 textures are larger than 4096 px. Many phones cannot display textures that large.",
      "Textures need about 1024 MB of GPU memory once decoded. That is likely too much for phones.",
    ],
  });

  async function run(operationId: string, stages: ProgressUpdate["stage"][], ms: number) {
    cancelled = false;
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      if (cancelled) throw new Error("Cancelled.");
      const stage = stages[Math.min(stages.length - 1, Math.floor((i / steps) * stages.length))];
      const message = {
        importing: "Reading source",
        textures: "Encoding textures",
        geometry: "Compressing geometry",
        validating: "Validating",
        ready: "Done",
      }[stage];
      listeners.forEach((listener) =>
        listener({ operationId, stage, percent: Math.round((i / steps) * 100), message }),
      );
      await new Promise((resolve) => setTimeout(resolve, ms / steps));
    }
  }

  const size = (limit: number) => (limit === 0 ? 8192 : Math.min(8192, limit));

  return {
    async environment() {
      return {
        version: "dev",
        platform: "browser",
        blenderPath: null,
        supportedFormats: ["glb", "gltf", "usdz", "obj", "fbx", "ply", "stl"],
      };
    },
    async chooseAsset() {
      if (!sourceUrl) throw new Error("Mock needs ?assets=...&source=... to load a real model.");
      await run("import", ["importing"], 900);
      return asset(sourceUrl.split("/").pop() ?? "model.glb", sourceUrl);
    },
    async importAsset(path) {
      if (fail === "import") {
        await run("import", ["importing"], 600);
        throw new Error(
          "Error invoking remote method 'kiln:import-asset': Error: Blender is needed to read FBX files. Locate Blender and try again.",
        );
      }
      await run("import", ["importing"], 900);
      const file = files.get(path);
      const url = file ? URL.createObjectURL(file) : sourceUrl;
      return asset(file?.name ?? path.split(/[/\\]/).pop() ?? "model.glb", url);
    },
    async optimize(sourceId, options: OptimizationOptions): Promise<OptimizationResult> {
      await run("optimize", ["textures", "geometry", "validating", "ready"], 2400);
      if (fail === "optimize")
        throw new Error(
          "Error invoking remote method 'kiln:optimize': Error: Texture encoder ran out of memory.",
        );
      const textures = [
        tex(
          "color",
          "color",
          size(options.colorSize),
          options.losslessTextures ? 34_010_802 : 2_854_094,
          "image/webp",
        ),
        tex(
          "normal",
          "normal",
          size(options.normalSize),
          options.normalLossless ? 9_429_478 : 4_100_000,
          "image/webp",
        ),
        tex(
          "ao",
          "ao",
          size(options.aoSize),
          options.losslessTextures ? 19_484_810 : 1_234_038,
          "image/webp",
        ),
      ];
      return {
        id: `mock-result-${Date.now()}`,
        sourceId,
        name: "model_public.glb",
        previewUrl: optimizedUrl,
        bytes: textures.reduce((sum, t) => sum + t.bytes, 1_452_000),
        triangles: Math.round(99_999 * options.simplifyRatio),
        vertices: Math.round(56_684 * options.simplifyRatio),
        textures,
        gpuBytes: textures.reduce((sum, t) => sum + gpu(t.width), 2_400_000),
        elapsedMs: 41_800,
        options,
        warnings: [
          "Needs a viewer with meshopt support. In three.js, call GLTFLoader.setMeshoptDecoder(MeshoptDecoder).",
        ],
        validationErrors: 0,
        requiredExtensions: ["EXT_meshopt_compression", "EXT_texture_webp"],
      };
    },
    async cancel() {
      cancelled = true;
    },
    async exportResult() {
      if (fail === "export")
        throw new Error("Choose a different filename. Your archival original must stay intact.");
      return {
        modelPath: "/exports/model_public.glb",
        recipePath: "/exports/model_public.recipe.json",
      };
    },
    async reveal() {},
    async setBlenderPath() {
      return {
        version: "dev",
        platform: "browser",
        blenderPath: "/apps/blender/blender",
        supportedFormats: ["glb", "gltf", "usdz", "obj", "fbx", "ply", "stl"],
      };
    },
    filePath(file) {
      const key = `mock-file:${file.name}`;
      files.set(key, file);
      return key;
    },
    onProgress(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}
