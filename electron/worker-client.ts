import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import type { ProgressUpdate } from "../shared/contracts.js";

export type WorkerMethod =
  | "environment"
  | "importAsset"
  | "optimize"
  | "getAsset"
  | "getResult"
  | "setBlenderPath";
export interface WorkerConfig {
  cacheDir: string;
  converterPath: string;
  blenderPath?: string | null;
}
interface Reply {
  id?: string;
  value?: unknown;
  error?: { name: string; message: string };
  progress?: ProgressUpdate;
}

export class EngineClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed = false;
  private terminalError: Error | null = null;
  private closing: Promise<void> | null = null;
  private readonly exited: Promise<void>;
  private readonly shutdownTimeoutMs: number;

  constructor(
    config: WorkerConfig,
    onProgress: (progress: ProgressUpdate) => void = () => {},
    options: { worker?: Worker; shutdownTimeoutMs?: number } = {},
  ) {
    this.worker =
      options.worker ??
      new Worker(new URL("./engine-worker.js", import.meta.url), { workerData: config });
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
    this.exited = new Promise((resolve) => this.worker.once("exit", () => resolve()));
    this.worker.on("message", (reply: Reply) => {
      if (reply.progress) {
        onProgress(reply.progress);
        return;
      }
      if (!reply.id) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) {
        const error = new Error(reply.error.message);
        error.name = reply.error.name;
        pending.reject(error);
      } else pending.resolve(reply.value);
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed)
        this.fail(
          new Error(`The optimization engine stopped (code ${code}). Restart Kiln and try again.`),
        );
    });
  }

  private fail(error: Error) {
    this.terminalError ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  call<T>(method: WorkerMethod, args: unknown[] = []): Promise<T> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.closed) return Promise.reject(new Error("The optimization engine is closed."));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.worker.postMessage({ id, method, args });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cancel() {
    if (!this.closed && !this.terminalError) {
      try {
        this.worker.postMessage({ method: "cancel" });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const failed = this.terminalError !== null;
    this.fail(new Error("Kiln closed."));
    this.closing = this.shutdown(failed);
    return this.closing;
  }

  private async shutdown(failed: boolean): Promise<void> {
    if (failed) {
      await this.worker.terminate();
      return;
    }
    try {
      this.worker.postMessage({ method: "shutdown" });
    } catch {
      await this.worker.terminate();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        this.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), this.shutdownTimeoutMs);
        }),
      ]);
      if (!stopped) await this.worker.terminate();
    } finally {
      clearTimeout(timer);
    }
  }
}
