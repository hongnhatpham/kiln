import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KilnError } from "./errors.js";

// Blender discovery. Windows locations are tested; macOS and Linux follow Blender's documented
// install layouts but have not been exercised yet.

async function isFile(file: string) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Sorts "Blender 5.2" style folder names newest first. */
function byVersionDesc(a: string, b: string) {
  const v = (s: string) => (s.match(/\d+(?:\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
  const [x, y] = [v(a), v(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

async function versionedInstalls(root: string, prefix: string, exe: string) {
  try {
    const names = (await fs.readdir(root))
      .filter((n) => n.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort(byVersionDesc);
    return names.map((n) => path.join(root, n, exe));
  } catch {
    return [];
  }
}

export async function blenderCandidates(): Promise<string[]> {
  const list: string[] = [];
  if (process.env.KILN_BLENDER) list.push(process.env.KILN_BLENDER);
  const exe = process.platform === "win32" ? "blender.exe" : "blender";
  if (process.platform === "win32") {
    for (const base of [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ]) {
      if (base)
        list.push(
          ...(await versionedInstalls(path.join(base, "Blender Foundation"), "Blender", exe)),
        );
    }
    for (const base of [process.env["ProgramFiles(x86)"], process.env.ProgramFiles]) {
      if (base) list.push(path.join(base, "Steam", "steamapps", "common", "Blender", exe));
    }
  } else if (process.platform === "darwin") {
    list.push(
      "/Applications/Blender.app/Contents/MacOS/Blender",
      path.join(os.homedir(), "Applications/Blender.app/Contents/MacOS/Blender"),
    );
  } else {
    list.push(
      "/usr/bin/blender",
      "/usr/local/bin/blender",
      "/snap/bin/blender",
      "/var/lib/flatpak/exports/bin/org.blender.Blender",
    );
    list.push(...(await versionedInstalls("/opt", "blender", "blender")));
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter))
    if (dir) list.push(path.join(dir, exe));
  return [...new Set(list)];
}

/** Runs `blender --version` to confirm the file really is Blender. Returns the version line or null. */
export async function probeBlender(file: string): Promise<string | null> {
  if (!(await isFile(file))) return null;
  try {
    const { stdout, code } = await runProcess(file, ["--factory-startup", "--version"], {
      timeoutMs: 30_000,
    });
    const line = stdout.split(/\r?\n/).find((l) => /^Blender \d/.test(l.trim()));
    return code === 0 && line ? line.trim() : null;
  } catch {
    return null;
  }
}

export async function discoverBlender(): Promise<string | null> {
  for (const candidate of await blenderCandidates())
    if (await probeBlender(candidate)) return candidate;
  return null;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns a process, keeping the tail of its output. Aborting kills it and throws `cancelled`. */
export function runProcess(
  file: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new KilnError("cancelled", "Cancelled."));
      return;
    }
    // Blender's bundled Python must not pick up a system Python's paths or user site packages.
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: "1" };
    delete env.PYTHONPATH;
    delete env.PYTHONHOME;
    const child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let stdout = "",
      stderr = "",
      partial = "";
    const keep = (s: string) => (s.length > 200_000 ? s.slice(-200_000) : s);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = keep(stdout + chunk);
      if (!opts.onLine) return;
      const lines = (partial + chunk).split(/\r?\n/);
      partial = lines.pop() ?? "";
      lines.forEach(opts.onLine);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = keep(stderr + chunk);
    });
    let aborted = false,
      timedOut = false;
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, opts.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (aborted) reject(new KilnError("cancelled", "Cancelled."));
      else if (timedOut)
        reject(new KilnError("conversion-failed", "Blender took too long and was stopped."));
      else resolve({ code, stdout, stderr });
    });
  });
}
