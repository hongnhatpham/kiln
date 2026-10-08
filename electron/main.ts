import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineClient } from "./worker-client.js";
import { normalizeOptions } from "../engine/options.js";
import {
  scanBatch,
  defaultBatchOutput,
  batchOutputs,
  batchUpToDate,
  sanitizeStem,
} from "../shared/batch.js";
import { exportFiles } from "../shared/export.js";
import type {
  AssetInfo,
  BatchItem,
  BatchPlan,
  BatchUpdate,
  EnvironmentInfo,
  ExportReceipt,
  OptimizationOptions,
  OptimizationResult,
} from "../shared/contracts.js";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "kiln",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
const here = path.dirname(fileURLToPath(import.meta.url));
interface AssetRecord {
  info: Omit<AssetInfo, "previewUrl">;
  previewPath: string;
  protectedSources: string[];
}
interface ResultRecord {
  info: Omit<OptimizationResult, "previewUrl">;
  modelPath: string;
  recipe: Record<string, unknown>;
}
let window: BrowserWindow | null = null;
let engine: EngineClient;
let busy = false;
const previewFiles = new Map<string, string>();
const revealable = new Set<string>();
const assets = new Map<string, AssetRecord>();
const results = new Map<string, ResultRecord>();
const batches = new Map<string, BatchPlan>();
let batchCancelled = false;
let runningBatch: string | null = null;
/** While a folder runs, opening and optimizing a model share one bar: opening fills the first quarter. */
let progressSpan: [number, number] | null = null;
const normalize = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const previewUrl = (id: string) => `kiln://asset/${encodeURIComponent(id)}.glb`;

async function settings() {
  try {
    return JSON.parse(
      await fs.readFile(path.join(app.getPath("userData"), "settings.json"), "utf8"),
    ) as { blenderPath?: string };
  } catch {
    return {};
  }
}
async function environment(): Promise<EnvironmentInfo> {
  const value =
    await engine.call<Pick<EnvironmentInfo, "blenderPath" | "supportedFormats">>("environment");
  return { ...value, version: app.getVersion(), platform: process.platform };
}
function sender(event: Electron.IpcMainInvokeEvent) {
  if (!window || event.sender !== window.webContents)
    throw new Error("This action is only available in Kiln.");
}
async function exclusive<T>(operation: () => Promise<T>) {
  if (busy)
    throw new Error("Another operation is running. Finish or cancel it before starting another.");
  busy = true;
  try {
    return await operation();
  } finally {
    busy = false;
  }
}
/** Close a finished model's preview: its source leaves the engine and its files stop being served. */
async function dropPreview(item: BatchItem) {
  const preview = item.preview;
  if (!preview) return;
  delete item.preview;
  previewFiles.delete(preview.asset.id);
  previewFiles.delete(preview.result.id);
  await engine.call("releaseAsset", [preview.asset.id]).catch((error) => console.error(error));
}
/** Previews last until another file or folder is opened, so converted sources do not pile up. */
async function dropBatchPreviews() {
  if (runningBatch) return;
  for (const plan of batches.values()) for (const item of plan.items) await dropPreview(item);
}
async function importAsset(input: string): Promise<AssetInfo> {
  if (!path.isAbsolute(input)) throw new Error("Choose a local asset file.");
  return exclusive(async () => {
    await dropBatchPreviews();
    const record = await engine.call<AssetRecord>("importAsset", [input, randomUUID()]);
    assets.set(record.info.id, record);
    previewFiles.set(record.info.id, record.previewPath);
    return { ...record.info, previewUrl: previewUrl(record.info.id) };
  });
}

async function planBatch(input: unknown): Promise<BatchPlan> {
  if (typeof input !== "string" || !path.isAbsolute(input))
    throw new Error("Choose a local folder of models.");
  const sourceDir = path.resolve(input),
    outputDir = defaultBatchOutput(sourceDir);
  await dropBatchPreviews();
  const plan: BatchPlan = {
    id: randomUUID(),
    sourceDir,
    outputDir,
    items: await scanBatch(sourceDir, outputDir, (await environment()).supportedFormats),
  };
  batches.set(plan.id, plan);
  return plan;
}
function batchPlan(id: unknown): BatchPlan {
  const plan = typeof id === "string" ? batches.get(id) : undefined;
  if (!plan) throw new Error("Choose a folder before processing.");
  return plan;
}
function emitBatch(plan: BatchPlan, index: number, operationId?: string) {
  const update: BatchUpdate = { batchId: plan.id, index, item: plan.items[index], operationId };
  if (window && !window.isDestroyed()) window.webContents.send("kiln:batch", update);
}
async function runBatch(plan: BatchPlan, input: unknown): Promise<BatchPlan> {
  const options = normalizeOptions(input);
  return exclusive(async () => {
    runningBatch = plan.id;
    batchCancelled = false;
    const outputs = batchOutputs(plan.items, plan.outputDir);
    // Earlier previews stay viewable until their model is processed again.
    for (let index = 0; index < plan.items.length; index++) {
      const item = plan.items[index];
      item.status = "waiting";
      delete item.message;
      delete item.modelPath;
      delete item.outputBytes;
      delete item.warnings;
      emitBatch(plan, index);
    }
    try {
      for (let index = 0; index < plan.items.length; index++) {
        if (batchCancelled) break;
        const item = plan.items[index];
        const operationId = randomUUID();
        let source: AssetRecord | undefined;
        const update = async (changes: Partial<typeof item>, keepPreview = false) => {
          if (!keepPreview) await dropPreview(item);
          delete item.message;
          delete item.modelPath;
          delete item.outputBytes;
          delete item.warnings;
          Object.assign(item, changes);
          emitBatch(plan, index, operationId);
        };
        try {
          const inputPath = path.join(plan.sourceDir, item.relativePath);
          const { modelPath, recipePath } = outputs.get(item.relativePath)!;
          item.sourceBytes = (await fs.stat(inputPath)).size;
          if (batchCancelled) break;
          const supported = (await environment()).supportedFormats;
          if (batchCancelled) break;
          if (!supported.includes(path.extname(inputPath).slice(1).toLowerCase())) {
            await update({ status: "skipped", message: "Needs Blender" });
            continue;
          }
          if (
            await batchUpToDate(
              modelPath,
              recipePath,
              path.basename(inputPath),
              item.sourceBytes,
              options,
            )
          ) {
            revealable.add(normalize(modelPath));
            revealable.add(normalize(plan.outputDir));
            // A preview made with these same settings still shows this output.
            await update(
              { status: "skipped", message: "Already up to date" },
              !!item.preview && isDeepStrictEqual(item.preview.result.options, options),
            );
            continue;
          }
          await update({ status: "processing" });
          progressSpan = [0, 25];
          source = await engine.call<AssetRecord>("importAsset", [inputPath, operationId]);
          progressSpan = [25, 100];
          if (batchCancelled) throw new Error("Cancelled.");
          const result = await engine.call<ResultRecord>("optimize", [
            source.info.id,
            options,
            operationId,
          ]);
          if (batchCancelled) throw new Error("Cancelled.");
          await fs.mkdir(path.dirname(modelPath), { recursive: true });
          if (batchCancelled) throw new Error("Cancelled.");
          await exportFiles({
            modelSource: result.modelPath,
            modelPath,
            recipePath,
            recipe: {
              ...result.recipe,
              source: {
                ...(result.recipe.source as Record<string, unknown>),
                relativePath: item.relativePath,
              },
              app: "Kiln",
              version: app.getVersion(),
              exportedAt: new Date().toISOString(),
            },
            protectedSources: [
              ...source.protectedSources,
              ...[...assets.values()].flatMap((asset) => asset.protectedSources),
            ],
          });
          revealable.add(normalize(modelPath));
          revealable.add(normalize(recipePath));
          revealable.add(normalize(plan.outputDir));
          // Compare against the exported file itself, so the preview is exactly what was saved.
          previewFiles.set(source.info.id, source.previewPath);
          previewFiles.set(result.info.id, modelPath);
          await update({
            status: "done",
            modelPath,
            outputBytes: result.info.bytes,
            warnings: result.info.warnings.length,
            preview: {
              asset: { ...source.info, previewUrl: previewUrl(source.info.id) },
              result: { ...result.info, previewUrl: previewUrl(result.info.id) },
            },
          });
        } catch (error) {
          const cancelled =
            batchCancelled || (error instanceof Error && error.name === "AbortError");
          await update({
            status: cancelled ? "cancelled" : "failed",
            message: cancelled
              ? "Cancelled."
              : error instanceof Error
                ? error.message
                : "This model could not be processed. Try opening it separately.",
          });
          if (cancelled) break;
        } finally {
          if (source) {
            try {
              // A finished model keeps its source open for the preview. Its web copy is on disk.
              await engine.call("releaseAsset", [source.info.id, item.status === "done"]);
            } catch (error) {
              // Cleanup must not erase a committed export or change cancellation into failure.
              const message =
                error instanceof Error
                  ? error.message
                  : "The temporary model files could not be removed.";
              item.message = [item.message, message].filter(Boolean).join(" ");
              emitBatch(plan, index, operationId);
            }
          }
        }
      }
      return plan;
    } finally {
      runningBatch = null;
      progressSpan = null;
    }
  });
}

function registerIPC() {
  ipcMain.handle("kiln:plan-batch", async (event, input: unknown) => {
    sender(event);
    return planBatch(input);
  });
  ipcMain.handle("kiln:choose-batch-folder", async (event) => {
    sender(event);
    const choice = await dialog.showOpenDialog(window!, {
      title: "Choose a folder of models",
      properties: ["openDirectory"],
    });
    return choice.canceled || !choice.filePaths[0] ? null : planBatch(choice.filePaths[0]);
  });
  ipcMain.handle("kiln:choose-batch-output", async (event, id: unknown) => {
    sender(event);
    const plan = batchPlan(id);
    if (runningBatch === plan.id)
      throw new Error("Wait for folder processing to finish before changing its output.");
    const choice = await dialog.showOpenDialog(window!, {
      title: "Choose the output folder",
      defaultPath: plan.outputDir,
      properties: ["openDirectory", "createDirectory"],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    if (runningBatch === plan.id)
      throw new Error("Wait for folder processing to finish before changing its output.");
    const outputDir = path.resolve(choice.filePaths[0]);
    const items = await scanBatch(
      plan.sourceDir,
      outputDir,
      (await environment()).supportedFormats,
    );
    if (runningBatch === plan.id)
      throw new Error("Wait for folder processing to finish before changing its output.");
    for (const item of plan.items) await dropPreview(item);
    plan.outputDir = outputDir;
    plan.items = items;
    return plan;
  });
  ipcMain.handle("kiln:run-batch", async (event, id: unknown, options: unknown) => {
    sender(event);
    return runBatch(batchPlan(id), options);
  });

  ipcMain.handle("kiln:environment", async (event) => {
    sender(event);
    return environment();
  });
  ipcMain.handle("kiln:choose-asset", async (event) => {
    sender(event);
    const choice = await dialog.showOpenDialog(window!, {
      title: "Open an archival asset",
      properties: ["openFile"],
      filters: [
        {
          name: "3D assets",
          extensions: ["glb", "gltf", "usdz", "usd", "usdc", "usda", "obj", "fbx", "ply", "stl"],
        },
      ],
    });
    return choice.canceled || !choice.filePaths[0] ? null : importAsset(choice.filePaths[0]);
  });
  ipcMain.handle("kiln:import-asset", async (event, input: unknown) => {
    sender(event);
    if (typeof input !== "string") throw new Error("Choose a local asset file.");
    return importAsset(input);
  });
  ipcMain.handle(
    "kiln:optimize",
    async (event, sourceId: unknown, options: OptimizationOptions) => {
      sender(event);
      if (typeof sourceId !== "string" || !assets.has(sourceId))
        throw new Error("Open an asset before optimizing.");
      return exclusive(async () => {
        const result = await engine.call<ResultRecord>("optimize", [
          sourceId,
          options,
          randomUUID(),
        ]);
        results.set(result.info.id, result);
        previewFiles.set(result.info.id, result.modelPath);
        return { ...result.info, previewUrl: previewUrl(result.info.id) };
      });
    },
  );
  ipcMain.handle("kiln:cancel", (event) => {
    sender(event);
    if (runningBatch) batchCancelled = true;
    engine.cancel();
  });
  ipcMain.handle("kiln:export", async (event, resultId: unknown): Promise<ExportReceipt | null> => {
    sender(event);
    const result = typeof resultId === "string" ? results.get(resultId) : undefined;
    if (!result) throw new Error("Optimize and inspect the result before exporting.");
    const source = assets.get(result.info.sourceId);
    if (!source) throw new Error("The source asset is no longer available.");
    const stem = sanitizeStem(path.parse(source.info.name).name);
    const choice = await dialog.showSaveDialog(window!, {
      title: "Export for the web",
      defaultPath: path.join(app.getPath("downloads"), `${stem}_public.glb`),
      filters: [{ name: "Web 3D model", extensions: ["glb"] }],
      properties: ["showOverwriteConfirmation"],
    });
    if (choice.canceled || !choice.filePath) return null;
    const modelPath = choice.filePath.toLowerCase().endsWith(".glb")
      ? choice.filePath
      : `${choice.filePath}.glb`;
    const recipePath = `${modelPath.slice(0, -4)}.recipe.json`;
    await exportFiles({
      modelSource: result.modelPath,
      modelPath,
      recipePath,
      recipe: {
        ...result.recipe,
        app: "Kiln",
        version: app.getVersion(),
        exportedAt: new Date().toISOString(),
      },
      protectedSources: [...assets.values()].flatMap((asset) => asset.protectedSources),
    });
    revealable.add(normalize(modelPath));
    revealable.add(normalize(recipePath));
    return { modelPath, recipePath };
  });
  ipcMain.handle("kiln:reveal", (event, value: unknown) => {
    sender(event);
    if (typeof value !== "string" || !revealable.has(normalize(value)))
      throw new Error("Export the result before opening its folder.");
    shell.showItemInFolder(value);
  });
  ipcMain.handle("kiln:blender", async (event) => {
    sender(event);
    const choice = await dialog.showOpenDialog(window!, {
      title: "Choose Blender",
      properties: ["openFile"],
      filters:
        process.platform === "win32" ? [{ name: "Blender executable", extensions: ["exe"] }] : [],
    });
    if (choice.canceled || !choice.filePaths[0]) return environment();
    await engine.call("setBlenderPath", [choice.filePaths[0]]);
    const value = await environment();
    if (!value.blenderPath)
      throw new Error(
        "This file was not recognized as Blender. Choose the Blender application and try again.",
      );
    await fs.mkdir(app.getPath("userData"), { recursive: true });
    await fs.writeFile(
      path.join(app.getPath("userData"), "settings.json"),
      JSON.stringify({ blenderPath: value.blenderPath }),
      "utf8",
    );
    return value;
  });
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    title: "Kiln",
    icon: path.join(
      app.isPackaged ? process.resourcesPath : app.getAppPath(),
      "resources",
      "kiln.png",
    ),
    backgroundColor: "#f6f5f1",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const devURL = process.env.KILN_DEV_URL;
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== devURL && !url.startsWith("file:")) event.preventDefault();
  });
  if (devURL) {
    const parsed = new URL(devURL);
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
      throw new Error("Kiln development runs on the local machine.");
    await window.loadURL(devURL);
  } else await window.loadFile(path.join(here, "../../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}

async function boot() {
  await app.whenReady();
  const configured = await settings();
  engine = new EngineClient(
    {
      cacheDir: path.join(app.getPath("userData"), "cache"),
      converterPath: path.join(
        app.isPackaged ? process.resourcesPath : app.getAppPath(),
        "resources",
        "usd-to-gltf.py",
      ),
      blenderPath: configured.blenderPath,
    },
    (progress) => {
      const [from, to] = progressSpan ?? [0, 100];
      const percent = Math.round(from + (progress.percent * (to - from)) / 100);
      if (window && !window.isDestroyed())
        window.webContents.send("kiln:progress", { ...progress, percent });
    },
  );
  protocol.handle("kiln", async (request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.pathname.slice(1).replace(/\.glb$/, ""));
    const file = url.hostname === "asset" ? previewFiles.get(id) : undefined;
    if (!file) return new Response("Asset unavailable", { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  registerIPC();
  await createWindow();
  app.on("activate", () => {
    if (!window) void createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let shutdownComplete = false;
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void engine
      .close()
      .catch((error) => console.error(error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
}

void boot().catch((error) => {
  console.error(error);
  app.exit(1);
});
