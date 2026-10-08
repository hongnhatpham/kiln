import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BatchUpdate, KilnAPI, ProgressUpdate } from "../shared/contracts.js";

const api: KilnAPI = {
  chooseBatchFolder: () => ipcRenderer.invoke("kiln:choose-batch-folder"),
  planBatch: (path) => ipcRenderer.invoke("kiln:plan-batch", path),
  chooseBatchOutput: (id) => ipcRenderer.invoke("kiln:choose-batch-output", id),
  runBatch: (id, options) => ipcRenderer.invoke("kiln:run-batch", id, options),
  onBatch: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, update: BatchUpdate) => callback(update);
    ipcRenderer.on("kiln:batch", listener);
    return () => ipcRenderer.removeListener("kiln:batch", listener);
  },
  environment: () => ipcRenderer.invoke("kiln:environment"),
  chooseAsset: () => ipcRenderer.invoke("kiln:choose-asset"),
  importAsset: (path) => ipcRenderer.invoke("kiln:import-asset", path),
  optimize: (sourceId, options) => ipcRenderer.invoke("kiln:optimize", sourceId, options),
  cancel: () => ipcRenderer.invoke("kiln:cancel"),
  exportResult: (resultId) => ipcRenderer.invoke("kiln:export", resultId),
  reveal: (path) => ipcRenderer.invoke("kiln:reveal", path),
  setBlenderPath: () => ipcRenderer.invoke("kiln:blender"),
  filePath: (file) => webUtils.getPathForFile(file),
  onProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProgressUpdate) =>
      callback(progress);
    ipcRenderer.on("kiln:progress", listener);
    return () => ipcRenderer.removeListener("kiln:progress", listener);
  },
};
contextBridge.exposeInMainWorld("kiln", api);
