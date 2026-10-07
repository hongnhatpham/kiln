import { Document, NodeIO } from "@gltf-transform/core";
import { unpartition } from "@gltf-transform/functions";
import fs from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./blender.js";
import { KilnError, throwIfAborted } from "./errors.js";

// Turns any supported source into a glTF document plus a self-contained "master" GLB in the cache.
// The source file is only ever read.

export const GLTF_FORMATS = ["glb", "gltf"] as const;
export const USD_FORMATS = ["usdz", "usd", "usdc", "usda"] as const;
export const BLENDER_FORMATS = ["obj", "fbx", "ply", "stl"] as const;

export type Conversion = "none" | "packed" | "pxr-direct" | "blender-import";

export interface PreparedSource {
  document: Document;
  protectedSources: string[];
  /** GLB the preview and every optimization read. The source itself for self-contained GLBs. */
  masterPath: string;
  conversion: Conversion;
  warnings: string[];
}

export interface PrepareContext {
  io: NodeIO;
  workDir: string;
  blenderPath: string | null;
  scriptsDir: string;
  signal?: AbortSignal;
  progress: (fraction: number, message: string) => void;
}

export const formatOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/**
 * Rejects resource URIs that would read outside the model's folder or from the network.
 * Without this, a downloaded glTF could pull any local file into a published GLB.
 */
export function checkResourceUris(
  json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] },
  baseDir: string,
) {
  const base = path.resolve(baseDir);
  for (const item of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    const uri = item.uri;
    if (!uri || uri.startsWith("data:")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri)) {
      throw new KilnError(
        "unsafe-path",
        `The model links to "${uri}". Kiln only reads files stored next to the model, never from the network.`,
      );
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(uri);
    } catch {
      decoded = uri;
    }
    const resolved = path.resolve(base, decoded);
    const relative = path.relative(base, resolved);
    if (
      path.isAbsolute(decoded) ||
      path.win32.isAbsolute(decoded) ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new KilnError(
        "unsafe-path",
        `The model links to "${uri}", which is outside its folder. Move the model and its files into one folder and open it again.`,
      );
    }
  }
}

/** Reads the JSON chunk of a GLB without loading its binary data. */
export async function readGlbJson(file: string): Promise<Record<string, unknown>> {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, 20, 0);
    if (header.readUInt32LE(0) !== 0x46546c67)
      throw new KilnError("read-failed", "This file is not a valid GLB.");
    const length = header.readUInt32LE(12);
    if (header.readUInt32LE(16) !== 0x4e4f534a || length > 256 * 1024 * 1024)
      throw new KilnError("read-failed", "This GLB has an unreadable header.");
    const json = Buffer.alloc(length);
    await handle.read(json, 0, length, 20);
    return JSON.parse(json.toString("utf8")) as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

const hasExternal = (json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] }) =>
  [...(json.buffers ?? []), ...(json.images ?? [])].some(
    (item) => item.uri && !item.uri.startsWith("data:"),
  );

async function readDocument(io: NodeIO, file: string): Promise<Document> {
  try {
    return await io.read(file);
  } catch (error) {
    throw new KilnError(
      "read-failed",
      `The model could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function writeMaster(io: NodeIO, document: Document, workDir: string) {
  await document.transform(unpartition());
  const masterPath = path.join(workDir, "master.glb");
  await fs.writeFile(masterPath, await io.writeBinary(document));
  return masterPath;
}

export async function prepareSource(
  sourcePath: string,
  ctx: PrepareContext,
): Promise<PreparedSource> {
  const format = formatOf(sourcePath);
  if (format === "glb" || format === "gltf") {
    const json =
      format === "glb"
        ? await readGlbJson(sourcePath)
        : JSON.parse(await fs.readFile(sourcePath, "utf8"));
    checkResourceUris(json, path.dirname(sourcePath));
    const protectedSources = [sourcePath];
    const baseReal = await fs.realpath(path.dirname(sourcePath));
    for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (!resource.uri || resource.uri.startsWith("data:")) continue;
      const resourcePath = path.resolve(path.dirname(sourcePath), decodeURIComponent(resource.uri));
      const resourceReal = await fs.realpath(resourcePath);
      const relative = path.relative(baseReal, resourceReal);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new KilnError(
          "unsafe-path",
          "A linked model resource resolves outside its folder. Move the model and its files into one folder.",
        );
      }
      protectedSources.push(resourcePath);
    }
    ctx.progress(0.3, "Reading model");
    const document = await readDocument(ctx.io, sourcePath);
    throwIfAborted(ctx.signal);
    if (format === "glb" && !hasExternal(json))
      return {
        document,
        protectedSources,
        masterPath: sourcePath,
        conversion: "none",
        warnings: [],
      };
    ctx.progress(0.7, "Packing model into one file");
    return {
      document,
      protectedSources,
      masterPath: await writeMaster(ctx.io, document, ctx.workDir),
      conversion: "packed",
      warnings: [],
    };
  }

  const isUsd = (USD_FORMATS as readonly string[]).includes(format);
  if (!isUsd && !(BLENDER_FORMATS as readonly string[]).includes(format)) {
    throw new KilnError(
      "unsupported-format",
      `Kiln cannot open .${format} files. Use GLB, glTF, USDZ, USD, OBJ, FBX, PLY or STL.`,
    );
  }
  if (!ctx.blenderPath) {
    throw new KilnError(
      "blender-missing",
      `Opening .${format} files needs Blender on this computer. Install Blender or choose its location in Settings, then try again.`,
    );
  }

  const warnings: string[] = [];
  if (isUsd) {
    const outDir = path.join(ctx.workDir, "usd");
    const report = await runBlenderScript(ctx, "usd-to-gltf.py", [sourcePath, outDir], 0, 0.6);
    if (report.status === "ok") {
      warnings.push(...report.warnings);
      ctx.progress(0.65, "Reading converted model");
      const document = await readDocument(ctx.io, path.join(outDir, "model.gltf"));
      const masterPath = await writeMaster(ctx.io, document, ctx.workDir);
      await fs.rm(outDir, { recursive: true, force: true });
      return {
        document,
        protectedSources: [sourcePath],
        masterPath,
        conversion: "pxr-direct",
        warnings,
      };
    }
    if (report.status !== "unsupported")
      throw new KilnError(
        "conversion-failed",
        `USD conversion failed: ${report.reason ?? "unknown error"}`,
      );
    // Something the exact converter cannot map. Blender's importer is less exact but handles far more.
    warnings.push(
      `Converted with Blender's importer because ${report.reason}. Check materials and texture quality closely.`,
    );
    await fs.rm(outDir, { recursive: true, force: true });
  }

  const glb = path.join(ctx.workDir, "blender.glb");
  const report = await runBlenderScript(
    ctx,
    "blender-import.py",
    [sourcePath, glb],
    isUsd ? 0.6 : 0,
    0.9,
  );
  if (report.status !== "ok")
    throw new KilnError(
      "conversion-failed",
      `Blender could not convert this file: ${report.reason ?? "unknown error"}`,
    );
  warnings.push(...report.warnings);
  const document = await readDocument(ctx.io, glb);
  return {
    document,
    protectedSources: [sourcePath],
    masterPath: glb,
    conversion: "blender-import",
    warnings,
  };
}

interface ScriptReport {
  status: "ok" | "unsupported" | "error";
  reason?: string | null;
  warnings: string[];
}

async function runBlenderScript(
  ctx: PrepareContext,
  script: string,
  args: string[],
  from: number,
  to: number,
): Promise<ScriptReport> {
  const reportPath = path.join(ctx.workDir, `${path.parse(script).name}.report.json`);
  await fs.rm(reportPath, { force: true });
  ctx.progress(from, "Starting Blender");
  const result = await runProcess(
    ctx.blenderPath!,
    [
      "-b",
      "--factory-startup",
      "--python-exit-code",
      "1",
      "-P",
      path.join(ctx.scriptsDir, script),
      "--",
      ...args,
      reportPath,
    ],
    {
      signal: ctx.signal,
      timeoutMs: 30 * 60_000,
      onLine: (line) => {
        const match = line.match(/^KILN_PROGRESS (\d+(?:\.\d+)?) (.*)$/);
        if (match) ctx.progress(from + (to - from) * Math.min(1, Number(match[1]) / 100), match[2]);
      },
    },
  );
  try {
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as ScriptReport;
    return { ...report, warnings: report.warnings ?? [] };
  } catch {
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join(" ");
    throw new KilnError(
      "conversion-failed",
      `Blender stopped before finishing (exit code ${result.code}). ${tail}`.trim(),
    );
  }
}
