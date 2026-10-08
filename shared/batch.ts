import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { BatchItem, OptimizationOptions } from "./contracts.js";

export const MODEL_FORMATS = [
  "glb",
  "gltf",
  "usdz",
  "usd",
  "usdc",
  "usda",
  "obj",
  "fbx",
  "ply",
  "stl",
];
const canonical = (p: string) =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
export function inside(file: string, dir: string): boolean {
  const relative = path.relative(canonical(dir), canonical(file));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
export function sanitizeStem(name: string): string {
  return [...name.replace(/[<>:"/\\|?*]/g, "_")]
    .map((c) => (c.charCodeAt(0) < 32 ? "_" : c))
    .join("");
}
export function defaultBatchOutput(sourceDir: string): string {
  return path.join(path.dirname(sourceDir), `${path.basename(sourceDir)}_public`);
}
/** Public GLBs are derivatives, including when output equals source. Never scan them again. */
export async function scanBatch(
  sourceDir: string,
  outputDir: string,
  supported: readonly string[],
): Promise<BatchItem[]> {
  if (!path.isAbsolute(sourceDir) || !(await fs.stat(sourceDir).catch(() => null))?.isDirectory())
    throw new Error("Choose a local folder of models.");
  const items: BatchItem[] = [];
  // Resolve aliases so a selected output folder cannot be scanned through another path.
  const sourceReal = await fs.realpath(sourceDir);
  const outputReal = await fs.realpath(outputDir).catch(() => path.resolve(outputDir));
  const excludeOutput = canonical(sourceReal) !== canonical(outputReal);
  async function walk(dir: string) {
    // Skip subfolders the user cannot read, such as system folders on an external drive.
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch((error: unknown) => (dir === sourceDir ? Promise.reject(error) : []));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name);
      if (excludeOutput && inside(await fs.realpath(file), outputReal)) continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const parsed = path.parse(entry.name),
          format = parsed.ext.slice(1).toLowerCase();
        if (
          !MODEL_FORMATS.includes(format) ||
          (format === "glb" && parsed.name.toLowerCase().endsWith("_public"))
        )
          continue;
        const available = supported.includes(format);
        items.push({
          relativePath: path.relative(sourceDir, file).split(path.sep).join("/"),
          sourceBytes: (await fs.stat(file)).size,
          status: available ? "waiting" : "skipped",
          ...(available ? {} : { message: "Needs Blender" }),
        });
      }
    }
  }
  await walk(sourceDir);
  return items.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}
/** Reserve plain stems first, then allocate suffixes without colliding with another source's stem. */
export function batchOutputs(
  items: readonly Pick<BatchItem, "relativePath">[],
  outputDir: string,
): Map<string, { modelPath: string; recipePath: string }> {
  const outputs = new Map<string, { modelPath: string; recipePath: string }>();
  const used = new Set<string>();
  const sorted = [...items].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
  const key = (dir: string, stem: string) => `${dir}/${stem}`.toLowerCase();
  // Reserving natural stems also protects names such as vase_obj.glb.
  const reserved = new Set(
    sorted.map((item) => {
      const p = path.posix.parse(item.relativePath);
      return key(p.dir, sanitizeStem(p.name));
    }),
  );
  for (const item of sorted) {
    const p = path.posix.parse(item.relativePath),
      base = sanitizeStem(p.name);
    let stem = base;
    if (used.has(key(p.dir, stem))) {
      const suffix = `${base}_${p.ext.slice(1).toLowerCase()}`;
      stem = suffix;
      let n = 2;
      while (used.has(key(p.dir, stem)) || reserved.has(key(p.dir, stem)))
        stem = `${suffix}_${n++}`;
    }
    used.add(key(p.dir, stem));
    const modelPath = path.join(outputDir, p.dir, `${stem}_public.glb`);
    outputs.set(item.relativePath, {
      modelPath,
      recipePath: modelPath.slice(0, -4) + ".recipe.json",
    });
  }
  return outputs;
}
export async function batchUpToDate(
  modelPath: string,
  recipePath: string,
  name: string,
  bytes: number,
  options: OptimizationOptions,
): Promise<boolean> {
  try {
    if (!(await fs.stat(modelPath)).isFile()) return false;
    const recipe = JSON.parse(await fs.readFile(recipePath, "utf8"));
    return (
      recipe.source?.name === name &&
      recipe.source?.bytes === bytes &&
      isDeepStrictEqual(recipe.settings, options)
    );
  } catch {
    return false;
  }
}
