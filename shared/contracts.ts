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
export interface KilnAPI {
  environment(): Promise<EnvironmentInfo>;
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
