import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { batchOutputs, batchUpToDate, scanBatch } from "../shared/batch.ts";
import { PRESETS } from "../shared/presets.ts";

test("scans recursively while skipping dot folders, symlinks, outputs, and public GLBs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-batch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.mkdir(path.join(root, "out"));
  await fs.writeFile(path.join(root, "a.glb"), "a");
  await fs.writeFile(path.join(root, "a_public.glb"), "old");
  await fs.writeFile(path.join(root, "nested", "b.obj"), "b");
  await fs.writeFile(path.join(root, ".hidden", "c.glb"), "c");
  await fs.writeFile(path.join(root, "out", "d.glb"), "d");
  await fs.symlink(path.join(root, "nested"), path.join(root, "link"), "junction");
  const items = await scanBatch(root, path.join(root, "out"), ["glb", "gltf", "obj"]);
  assert.deepEqual(
    items.map((i) => i.relativePath),
    ["a.glb", "nested/b.obj"],
  );
});

test("disambiguates same-folder stems deterministically", () => {
  const outputs = batchOutputs(
    [{ relativePath: "vase.glb" }, { relativePath: "vase.obj" }, { relativePath: "sub/vase.glb" }],
    "D:/out",
  );
  assert.equal(path.basename(outputs.get("vase.glb")!.modelPath), "vase_public.glb");
  assert.equal(path.basename(outputs.get("vase.obj")!.modelPath), "vase_obj_public.glb");
  assert.equal(path.basename(outputs.get("sub/vase.glb")!.modelPath), "vase_public.glb");
});

test("recognizes matching recipes and rejects changed settings", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-batch-up-to-date-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const model = path.join(root, "vase_public.glb"),
    recipe = path.join(root, "vase_public.recipe.json");
  await fs.writeFile(model, "model");
  await fs.writeFile(
    recipe,
    JSON.stringify({ source: { name: "vase.glb", bytes: 3 }, settings: PRESETS.detailed }),
  );
  assert.equal(await batchUpToDate(model, recipe, "vase.glb", 3, PRESETS.detailed), true);
  assert.equal(
    await batchUpToDate(model, recipe, "vase.glb", 3, { ...PRESETS.detailed, simplifyRatio: 0.5 }),
    false,
  );
});

test("allows source-folder output, skips unsupported formats and hidden files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-batch-same-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ["a.glb", "a_public.glb", "original_public.obj", ".hidden.glb", "ignored.txt"])
    await fs.writeFile(path.join(root, name), "x");
  const items = await scanBatch(root, root, ["glb", "gltf"]);
  assert.deepEqual(items, [
    { relativePath: "a.glb", sourceBytes: 1, status: "waiting" },
    {
      relativePath: "original_public.obj",
      sourceBytes: 1,
      status: "skipped",
      message: "Needs Blender",
    },
  ]);
});

test("collision suffixes avoid reserved and case-insensitive stems", () => {
  const items = ["vase.glb", "vase.obj", "vase_obj.glb", "VASE.stl"].map((relativePath) => ({
    relativePath,
  }));
  const a = batchOutputs(items, "out"),
    b = batchOutputs([...items].reverse(), "out");
  assert.deepEqual(a, b);
  assert.equal(new Set([...a.values()].map((output) => output.modelPath.toLowerCase())).size, 4);
});

test("up-to-date requires both files, source name and bytes, and a valid recipe", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-batch-recipe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const model = path.join(root, "model.glb"),
    recipe = path.join(root, "model.recipe.json");
  await fs.writeFile(
    recipe,
    JSON.stringify({ source: { name: "a.glb", bytes: 3 }, settings: PRESETS.detailed }),
  );
  assert.equal(await batchUpToDate(model, recipe, "a.glb", 3, PRESETS.detailed), false);
  await fs.writeFile(model, "glb");
  assert.equal(await batchUpToDate(model, recipe, "b.glb", 3, PRESETS.detailed), false);
  assert.equal(await batchUpToDate(model, recipe, "a.glb", 4, PRESETS.detailed), false);
  await fs.writeFile(recipe, "broken recipe");
  assert.equal(await batchUpToDate(model, recipe, "a.glb", 3, PRESETS.detailed), false);
});

test(
  "skips subfolders it cannot read",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-batch-"));
    const locked = path.join(root, "locked");
    await fs.mkdir(locked);
    await fs.writeFile(path.join(locked, "x.glb"), "x");
    await fs.writeFile(path.join(root, "a.glb"), "a");
    await fs.chmod(locked, 0o000);
    t.after(async () => {
      await fs.chmod(locked, 0o700);
      await fs.rm(root, { recursive: true, force: true });
    });
    const items = await scanBatch(root, `${root}_public`, ["glb"]);
    assert.deepEqual(
      items.map((i) => i.relativePath),
      ["a.glb"],
    );
  },
);
