import assert from "node:assert/strict";
import { once } from "node:events";
import { MessageChannel, Worker } from "node:worker_threads";
import { test } from "node:test";
import { EngineClient } from "../electron/worker-client.ts";
import { registerWorkerHost } from "../electron/worker-host.ts";
import { runProcess } from "../engine/blender.ts";

const config = { cacheDir: "", converterPath: "" };
function worker(code: string) {
  return new Worker(`const { parentPort } = require('node:worker_threads'); ${code}`, {
    eval: true,
  });
}

test("dead worker rejects pending and future calls immediately", { timeout: 5000 }, async () => {
  const engine = new EngineClient(config, undefined, {
    worker: worker("parentPort.on('message', () => { throw new Error('engine failed'); });"),
  });
  await assert.rejects(engine.call("environment"), /engine failed/);
  await assert.rejects(engine.call("environment"), /engine failed/);
  engine.cancel();
  await engine.close();
});

test("unexpected clean worker exit is terminal for future calls", { timeout: 5000 }, async () => {
  const engine = new EngineClient(config, undefined, {
    worker: worker("parentPort.on('message', () => process.exit(0));"),
  });
  await assert.rejects(engine.call("environment"), /stopped/);
  await assert.rejects(engine.call("environment"), /stopped/);
  await engine.close();
});

test("close allows cooperative cleanup and is idempotent", { timeout: 5000 }, async () => {
  const instance = worker(
    "parentPort.on('message', request => { if (request.method === 'shutdown') setTimeout(() => { parentPort.postMessage({ cleaned: true }); parentPort.close(); }, 50); });",
  );
  const engine = new EngineClient(config, undefined, { worker: instance, shutdownTimeoutMs: 2000 });
  let cleaned = false;
  instance.on("message", (message) => {
    if (message.cleaned) cleaned = true;
  });
  const pending = assert.rejects(engine.call("environment"), /Kiln closed/);
  const closed = engine.close();
  assert.equal(engine.close(), closed);
  await closed;
  await pending;
  assert.equal(cleaned, true);
  await assert.rejects(engine.call("environment"), /Kiln closed/);
});

test("close has a bounded fallback for an unresponsive worker", { timeout: 5000 }, async () => {
  const instance = worker("parentPort.on('message', () => {});");
  const engine = new EngineClient(config, undefined, { worker: instance, shutdownTimeoutMs: 50 });
  await engine.close();
  assert.equal(instance.threadId, -1);
});

test(
  "host shutdown waits for aborted subprocess to exit and ignores subsequent work",
  { timeout: 10000 },
  async () => {
    const { port1, port2 } = new MessageChannel();
    const controller = new AbortController();
    let pid = 0,
      settled = false,
      calls = 0;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    registerWorkerHost(
      port1,
      async () => {
        calls++;
        try {
          await runProcess(
            process.execPath,
            ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
            {
              signal: controller.signal,
              onLine: (line) => {
                pid = Number(line);
                started();
              },
            },
          );
        } catch (error) {
          assert.equal((error as Error).message, "Cancelled.");
        } finally {
          settled = true;
        }
      },
      () => controller.abort(),
    );
    port2.postMessage({ method: "importAsset" });
    await ready;
    const closed = once(port2, "close");
    port2.postMessage({ method: "shutdown" });
    port2.postMessage({ method: "environment" });
    await closed;
    assert.equal(settled, true);
    assert.equal(calls, 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  },
);
