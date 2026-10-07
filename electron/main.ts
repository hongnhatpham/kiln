import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { EngineClient } from "./worker-client.js";
import { exportFiles } from "../shared/export.js";
import type {
  AssetInfo,
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
async function importAsset(input: string): Promise<AssetInfo> {
  if (!path.isAbsolute(input)) throw new Error("Choose a local asset file.");
  return exclusive(async () => {
    const record = await engine.call<AssetRecord>("importAsset", [input, randomUUID()]);
    assets.set(record.info.id, record);
    previewFiles.set(record.info.id, record.previewPath);
    return { ...record.info, previewUrl: previewUrl(record.info.id) };
  });
}

function registerIPC() {
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
    engine.cancel();
  });
  ipcMain.handle("kiln:export", async (event, resultId: unknown): Promise<ExportReceipt | null> => {
    sender(event);
    const result = typeof resultId === "string" ? results.get(resultId) : undefined;
    if (!result) throw new Error("Optimize and inspect the result before exporting.");
    const source = assets.get(result.info.sourceId);
    if (!source) throw new Error("The source asset is no longer available.");
    const stem = [...path.parse(source.info.name).name.replace(/[<>:"/\\|?*]/g, "_")]
      .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
      .join("");
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
      if (window && !window.isDestroyed()) window.webContents.send("kiln:progress", progress);
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
