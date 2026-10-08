export type TextureLimit = 0 | 1024 | 2048 | 4096 | 8192;
export type TextureFormat = "webp" | "png" | "jpeg" | "keep";
export type PresetId = "detailed" | "lightweight" | "lossless" | "custom";
export interface OptimizationOptions {
  colorSize: TextureLimit;
  normalSize: TextureLimit;
  aoSize: TextureLimit;
  textureFormat: TextureFormat;
  losslessTextures: boolean;
  colorQuality: number;
  normalLossless: boolean;
  normalQuality: number;
  aoQuality: number;
  meshCompression: "none" | "meshopt";
  simplifyRatio: number;
  simplifyError: number;
  quantize: boolean;
  preserveMetadata: boolean;
}
export interface TextureInfo {
  name: string;
  role: "color" | "normal" | "ao" | "other";
  width: number;
  height: number;
  bytes: number;
  mimeType: string;
}
export interface AssetInfo {
  id: string;
  name: string;
  sourcePath: string;
  sourceBytes: number;
  previewUrl: string;
  vertices: number;
  triangles: number;
  meshCount: number;
  materials: number;
  dimensions: [number, number, number];
  textures: TextureInfo[];
  gpuBytes: number;
  warnings: string[];
}
export interface OptimizationResult {
  id: string;
  sourceId: string;
  name: string;
  bytes: number;
  previewUrl: string;
  triangles: number;
  vertices: number;
  textures: TextureInfo[];
  gpuBytes: number;
  elapsedMs: number;
  options: OptimizationOptions;
  warnings: string[];
  validationErrors: number;
  requiredExtensions: string[];
}
export interface ProgressUpdate {
  operationId: string;
  stage: "importing" | "textures" | "geometry" | "validating" | "ready";
  percent: number;
  message: string;
}
export interface EnvironmentInfo {
  version: string;
  platform: string;
  blenderPath: string | null;
  supportedFormats: string[];
}
export interface ExportReceipt {
  modelPath: string;
  recipePath: string;
}
/**
 * Folder processing. One folder is scanned recursively and every model in it is optimized with the
 * same settings, one at a time. Outputs mirror the subfolder layout inside `outputDir`.
 */
export type BatchItemStatus =
  | "waiting"
  | "processing"
  | "done"
  | "skipped"
  | "failed"
  | "cancelled";
export interface BatchItem {
  /** Path below the chosen folder, with forward slashes, e.g. "site-a/vase.glb". */
  relativePath: string;
  sourceBytes: number;
  status: BatchItemStatus;
  /** Set when status is "done": the exported GLB and its size. */
  modelPath?: string;
  outputBytes?: number;
  /** Count of result warnings worth a second look, when status is "done". */
  warnings?: number;
  /** Plain-language reason for "skipped" ("Already up to date", "Needs Blender") or "failed". */
  message?: string;
}
export interface BatchPlan {
  id: string;
  sourceDir: string;
  outputDir: string;
  items: BatchItem[];
}
export interface BatchUpdate {
  batchId: string;
  /** Index into `BatchPlan.items`. */
  index: number;
  item: BatchItem;
  /** `ProgressUpdate.operationId` of the work on this item, so per-file progress can be matched. */
  operationId?: string;
}

export interface KilnAPI {
  environment(): Promise<EnvironmentInfo>;
  /** Opens a folder picker and scans it. Null when the user cancels. */
  chooseBatchFolder(): Promise<BatchPlan | null>;
  /** Scans a folder the user dropped onto the window. */
  planBatch(folderPath: string): Promise<BatchPlan>;
  /** Opens a folder picker for the output folder and returns the updated plan. Null when cancelled. */
  chooseBatchOutput(batchId: string): Promise<BatchPlan | null>;
  /**
   * Processes the plan in order. Every item is a candidate again on each run (Blender support and the
   * up-to-date check are re-evaluated), so a re-run after a settings change, failure or cancel does the
   * right thing. Resolves with the final plan, also after `cancel()`.
   */
  runBatch(batchId: string, options: OptimizationOptions): Promise<BatchPlan>;
  onBatch(callback: (update: BatchUpdate) => void): () => void;
  chooseAsset(): Promise<AssetInfo | null>;
  importAsset(path: string): Promise<AssetInfo>;
  optimize(sourceId: string, options: OptimizationOptions): Promise<OptimizationResult>;
  cancel(): Promise<void>;
  exportResult(resultId: string): Promise<ExportReceipt | null>;
  reveal(path: string): Promise<void>;
  setBlenderPath(): Promise<EnvironmentInfo>;
  filePath(file: File): string;
  onProgress(callback: (progress: ProgressUpdate) => void): () => void;
}
