import { parentPort, workerData } from "node:worker_threads";
import { createAssetService } from "../engine/service.js";
import type { OptimizationOptions, ProgressUpdate } from "../shared/contracts.js";
import type { WorkerConfig } from "./worker-client.js";
import { registerWorkerHost, type WorkerRequest } from "./worker-host.js";

const config = workerData as WorkerConfig;
const service = await createAssetService({
  ...config,
  onProgress: (progress: ProgressUpdate) => parentPort?.postMessage({ progress }),
});
let active: AbortController | null = null;

async function handle(request: WorkerRequest) {
  const args = request.args ?? [];
  try {
    let value: unknown;
    switch (request.method) {
      case "environment":
        value = await service.environment();
        break;
      case "releaseAsset":
        value = await service.releaseAsset(String(args[0]), args[1] === true);
        break;
      case "getAsset":
        value = await service.getAsset(String(args[0]));
        break;
      case "getResult":
        value = await service.getResult(String(args[0]));
        break;
      case "setBlenderPath":
        value = await service.setBlenderPath(args[0] === null ? null : String(args[0]));
        break;
      case "importAsset":
      case "optimize": {
        if (active) throw new Error("Another optimization is still running.");
        const controller = new AbortController();
        active = controller;
        try {
          value =
            request.method === "importAsset"
              ? await service.importAsset(String(args[0]), String(args[1]), controller.signal)
              : await service.optimize(
                  String(args[0]),
                  args[1] as OptimizationOptions,
                  String(args[2]),
                  controller.signal,
                );
        } finally {
          if (active === controller) active = null;
        }
        break;
      }
      default:
        throw new Error("Unknown optimization command.");
    }
    parentPort?.postMessage({ id: request.id, value });
  } catch (error) {
    const value = error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({
      id: request.id,
      error: { name: value.name, message: value.message },
    });
  }
}

if (parentPort) registerWorkerHost(parentPort, handle, () => active?.abort());
