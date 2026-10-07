import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkedOutput, exportFiles } from "../shared/export.ts";

async function fixture(t: import("node:test").TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kiln-host-export-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, "archive-a.glb"),
    b = path.join(dir, "archive-b.glb");
  await fs.writeFile(a, "original a");
  await fs.writeFile(b, "original b");
  return { dir, a, b };
}

test("protects every archival source and its hard links", async (t) => {
  const { dir, a, b } = await fixture(t);
  const alias = path.join(dir, "alias.glb");
  await fs.link(a, alias);
  await assert.rejects(checkedOutput(a, [b, a]), /archival original/);
  await assert.rejects(checkedOutput(alias, [b, a]), /archival original/);
  await assert.rejects(
    exportFiles({
      modelSource: b,
      modelPath: alias,
      recipePath: path.join(dir, "export.recipe.json"),
      recipe: {},
      protectedSources: [a, b],
    }),
    /archival original/,
  );
  assert.equal(await fs.readFile(a, "utf8"), "original a");
  await checkedOutput(path.join(dir, "new.glb"), [a, b]);
});

test("protects originals reached through an aliased parent directory", async (t) => {
  const { dir, a } = await fixture(t);
  const alias = `${dir}-alias`;
  await fs.symlink(dir, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.unlink(alias));
  await assert.rejects(checkedOutput(path.join(alias, path.basename(a)), [a]), /archival original/);
});

test("exports and replaces model and recipe as a pair", async (t) => {
  const { dir, a, b } = await fixture(t);
  const modelPath = path.join(dir, "public.glb"),
    recipePath = path.join(dir, "public.recipe.json");
  const options = {
    modelSource: b,
    modelPath,
    recipePath,
    recipe: { version: 1 },
    protectedSources: [a, b],
  };
  await exportFiles(options);
  await fs.writeFile(modelPath, "old model");
  await fs.writeFile(recipePath, "old recipe");
  await exportFiles(options);
  assert.equal(await fs.readFile(modelPath, "utf8"), "original b");
  assert.deepEqual(JSON.parse(await fs.readFile(recipePath, "utf8")), { version: 1 });
  assert.deepEqual((await fs.readdir(dir)).sort(), [
    "archive-a.glb",
    "archive-b.glb",
    "public.glb",
    "public.recipe.json",
  ]);
});

test("restores the existing pair when the second replacement fails", async (t) => {
  const { dir, a, b } = await fixture(t);
  const modelPath = path.join(dir, "public.glb"),
    recipePath = path.join(dir, "public.recipe.json");
  await fs.writeFile(modelPath, "old model");
  await fs.writeFile(recipePath, "old recipe");
  const rename = fs.rename.bind(fs);
  const mock = t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (from.endsWith(".tmp") && to === recipePath)
      throw new Error("injected recipe replacement failure");
    return rename(from, to);
  });
  await assert.rejects(
    exportFiles({ modelSource: b, modelPath, recipePath, recipe: {}, protectedSources: [a, b] }),
    /injected/,
  );
  mock.mock.restore();
  assert.equal(await fs.readFile(modelPath, "utf8"), "old model");
  assert.equal(await fs.readFile(recipePath, "utf8"), "old recipe");
  assert.deepEqual((await fs.readdir(dir)).sort(), [
    "archive-a.glb",
    "archive-b.glb",
    "public.glb",
    "public.recipe.json",
  ]);
});

test("removes a newly installed model if its recipe replacement fails", async (t) => {
  const { dir, a, b } = await fixture(t);
  const modelPath = path.join(dir, "public.glb"),
    recipePath = path.join(dir, "public.recipe.json");
  const rename = fs.rename.bind(fs);
  const mock = t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (from.endsWith(".tmp") && to === recipePath) throw new Error("injected failure");
    return rename(from, to);
  });
  await assert.rejects(
    exportFiles({ modelSource: b, modelPath, recipePath, recipe: {}, protectedSources: [a, b] }),
    /injected/,
  );
  mock.mock.restore();
  await assert.rejects(fs.stat(modelPath), { code: "ENOENT" });
  await assert.rejects(fs.stat(recipePath), { code: "ENOENT" });
});
