import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const runner = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const compile = spawn(runner, ["exec", "tsc", "-p", "tsconfig.desktop.json"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (await new Promise((resolve) => compile.on("exit", resolve))) process.exit(1);
const vite = spawn(runner, ["dev:ui"], { stdio: "inherit", shell: process.platform === "win32" });
let ready = false;
for (let tries = 0; tries < 60; tries++) {
  try {
    ready = (await fetch("http://127.0.0.1:5183/")).ok;
  } catch {}
  if (ready) break;
  await delay(500);
}
if (!ready) {
  vite.kill();
  throw new Error("The Kiln interface did not start on port 5183.");
}
const desktopEnv = { ...process.env, KILN_DEV_URL: "http://127.0.0.1:5183/" };
delete desktopEnv.ELECTRON_RUN_AS_NODE;
const electron = spawn(runner, ["exec", "electron", "."], {
  stdio: "inherit",
  env: desktopEnv,
  shell: process.platform === "win32",
});
const stop = () => {
  electron.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
electron.on("exit", (code) => {
  vite.kill();
  process.exitCode = code ?? 0;
});
