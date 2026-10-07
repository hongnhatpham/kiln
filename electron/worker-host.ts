import type { MessagePort } from "node:worker_threads";

export interface WorkerRequest {
  id?: string;
  method: string;
  args?: unknown[];
}

/** Stop accepting requests, abort active work, then close only once cleanup settles. */
export function registerWorkerHost(
  port: MessagePort,
  handle: (request: WorkerRequest) => Promise<void>,
  cancel: () => void,
): void {
  let shuttingDown = false;
  const running = new Set<Promise<void>>();
  port.on("message", (request: WorkerRequest) => {
    if (request.method === "shutdown") {
      if (shuttingDown) return;
      shuttingDown = true;
      cancel();
      void Promise.allSettled(running).then(() => port.close());
      return;
    }
    if (shuttingDown) return;
    if (request.method === "cancel") {
      cancel();
      return;
    }
    const operation = handle(request);
    running.add(operation);
    void operation.then(
      () => running.delete(operation),
      () => running.delete(operation),
    );
  });
}
