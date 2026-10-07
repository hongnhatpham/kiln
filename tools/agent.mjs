import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [command, ...args] = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};
const pretty = args.includes("--pretty");
const print = (result) => console.log(JSON.stringify(result, null, pretty ? 2 : undefined));
const presets = ["detailed", "lightweight", "lossless"];

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
async function client() {
  const { EngineClient } = await import(pathToURL("dist/desktop/electron/worker-client.js"));
  return new EngineClient(
    {
      cacheDir: path.join(root, ".cache/agent"),
      converterPath: path.join(root, "resources/usd-to-gltf.py"),
    },
    (progress) => process.stderr.write(`${progress.stage}: ${progress.message}\n`),
  );
}
function pathToURL(file) {
  return new URL(file.replaceAll("\\", "/"), new URL("../", import.meta.url)).href;
}
async function sourcePath() {
  const input = value("--input");
  if (!input) throw new Error("Specify --input with a local 3D file.");
  const inputPath = path.resolve(input);
  if (!(await fs.stat(inputPath)).isFile()) throw new Error("The input must be a file.");
  return inputPath;
}
async function guard(output, input) {
  const { checkedOutput } = await import(pathToURL("dist/desktop/shared/export.js"));
  await checkedOutput(output, [input]);
}
async function optimize() {
  const input = await sourcePath();
  const preset = value("--preset") ?? "detailed";
  if (!presets.includes(preset)) throw new Error(`Choose a preset: ${presets.join(", ")}.`);
  const { PRESETS } = await import(pathToURL("dist/desktop/shared/presets.js"));
  const outDir = path.resolve(value("--out") ?? path.join(root, "artifacts/exports"));
  await fs.mkdir(outDir, { recursive: true });
  const engine = await client();
  try {
    const source = await engine.call("importAsset", [input, crypto.randomUUID()]);
    const result = await engine.call("optimize", [
      source.info.id,
      PRESETS[preset],
      crypto.randomUUID(),
    ]);
    const modelPath = path.join(outDir, `${path.parse(input).name}_${preset}.glb`);
    const recipePath = modelPath.replace(/\.glb$/i, ".recipe.json");
    const { exportFiles } = await import(pathToURL("dist/desktop/shared/export.js"));
    await exportFiles({
      modelSource: result.modelPath,
      modelPath,
      recipePath,
      recipe: result.recipe,
      protectedSources: source.protectedSources,
    });
    print({ source: source.info, result: result.info, modelPath, recipePath });
  } finally {
    await engine.close();
  }
}
async function smoke() {
  const input = await sourcePath();
  const outputDir = path.resolve(value("--out") ?? path.join(root, "artifacts/desktop-smoke"));
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.join(root, ".cache"), { recursive: true });
  const lockPath = path.join(root, ".cache/desktop-smoke.lock");
  let lock;
  try {
    lock = await fs.open(lockPath, "wx");
  } catch {
    const pid = Number(await fs.readFile(lockPath, "utf8").catch(() => ""));
    let active = false;
    try {
      if (pid) {
        process.kill(pid, 0);
        active = true;
      }
    } catch {}
    if (active) throw new Error("A desktop smoke check is already running. Wait for it to finish.");
    await fs.unlink(lockPath);
    lock = await fs.open(lockPath, "wx");
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  let desktop;
  const errors = [];
  try {
    const { _electron } = await import("playwright");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const beforeHash = crypto
      .createHash("sha256")
      .update(await fs.readFile(input))
      .digest("hex");
    const executable = value("--executable");
    const desktopEnv = { ...process.env };
    delete desktopEnv.ELECTRON_RUN_AS_NODE;
    delete desktopEnv.KILN_DEV_URL;
    desktop = await _electron.launch({
      executablePath: executable ? path.resolve(executable) : require("electron"),
      args: executable ? [] : [root],
      env: desktopEnv,
      timeout: 60000,
    });
    const page = await desktop.firstWindow();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.waitForFunction(() => Boolean(window.kiln), {}, { timeout: 30000 });
    if (args.includes("--exercise")) {
      await desktop.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      await page.getByRole("button", { name: "Open asset", exact: true }).click();
      await page.waitForFunction(
        () =>
          !Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Open asset",
          )?.disabled,
      );
      const invalid = path.join(outputDir, "invalid.glb");
      await fs.writeFile(invalid, "invalid GLB");
      await desktop.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, invalid);
      await page.getByRole("button", { name: "Open asset", exact: true }).click();
      await page.getByRole("alert").waitFor({ state: "visible", timeout: 30000 });
      await page.screenshot({ path: path.join(outputDir, "recoverable-error.png") });
    }
    await desktop.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, input);
    await page.screenshot({ path: path.join(outputDir, "empty.png") });
    await page.getByRole("button", { name: "Open asset", exact: true }).first().click();
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some(
          (b) => b.textContent?.trim() === "Optimize" && !b.disabled,
        ),
      {},
      { timeout: 180000 },
    );
    await page
      .getByRole("button", { name: "1:1 detail", exact: true })
      .waitFor({ state: "visible", timeout: 120000 });
    await page.screenshot({ path: path.join(outputDir, "imported.png") });
    await page.getByRole("button", { name: /^Optimize/ }).click();
    await page
      .getByRole("button", { name: /^Export/ })
      .waitFor({ state: "visible", timeout: 180000 });
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent ?? "").startsWith("Export"),
        )?.disabled,
      {},
      { timeout: 180000 },
    );
    await page.waitForFunction(
      () => !document.body.innerText.includes("Loading optimized preview"),
      {},
      { timeout: 120000 },
    );
    await page.screenshot({ path: path.join(outputDir, "optimized.png") });
    if (args.includes("--exercise")) {
      const divider = page.getByRole("slider", { name: /^Comparison divider/ });
      await divider.focus();
      await page.keyboard.press("ArrowRight");
      if ((await divider.getAttribute("aria-valuenow")) !== "52")
        throw new Error("Comparison divider keyboard interaction failed.");
      await page.getByRole("button", { name: "1:1 detail", exact: true }).click();
      await page.locator('input[name="lighting"][value="raking"]').check();
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outputDir, "detail-raking.png") });
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      const canvas = await page.locator("canvas").boundingBox();
      if (!canvas) throw new Error("The viewer canvas is missing.");
      await page.mouse.move(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.55, {
        steps: 8,
      });
      await page.mouse.up();
      await page.mouse.wheel(0, -200);
      await page.screenshot({ path: path.join(outputDir, "orbit-zoom.png") });
      await page.getByRole("button", { name: "Advanced settings", exact: true }).click();
      await page.getByRole("switch", { name: "All textures lossless", exact: true }).check();
      if (!(await page.getByText("Custom settings", { exact: false }).isVisible()))
        throw new Error("Advanced customization did not update the preset.");
      await page.screenshot({ path: path.join(outputDir, "advanced.png") });
      await page.locator('input[name="preset"][value="lightweight"]').check();
      await page.getByRole("button", { name: /^Optimize/ }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.waitForFunction(
        () => document.body.innerText.includes("Optimization cancelled"),
        {},
        { timeout: 60000 },
      );
      await page.screenshot({ path: path.join(outputDir, "cancelled.png") });
      await page.locator('input[name="preset"][value="detailed"]').check();
    }
    const output = path.join(outputDir, `${path.parse(input).name}_public.glb`);
    await guard(output, input);
    await desktop.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, output);
    await page.getByRole("button", { name: /^Export/ }).click();
    for (let i = 0; i < 100 && !(await exists(output)); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (!(await exists(output))) throw new Error("The desktop export did not write the model.");
    const recipeFile = output.replace(/\.glb$/i, ".recipe.json");
    for (let i = 0; i < 100 && !(await exists(recipeFile)); i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const recipe = JSON.parse(await fs.readFile(recipeFile, "utf8"));
    if (
      recipe.output.sha256 !==
      crypto
        .createHash("sha256")
        .update(await fs.readFile(output))
        .digest("hex")
    )
      throw new Error("The exported recipe fingerprint does not match the GLB.");
    const afterHash = crypto
      .createHash("sha256")
      .update(await fs.readFile(input))
      .digest("hex");
    if (afterHash !== beforeHash)
      throw new Error("The archival original changed during the smoke check.");
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: path.join(outputDir, "small-window.png") });
    const report = {
      input,
      output,
      originalUnchanged: true,
      bytes: (await fs.stat(output)).size,
      errors,
      checks: [
        "actual Electron import",
        "detailed preset optimization",
        "native export path and matching recipe",
        "source SHA256 unchanged",
        "desktop and smaller window captures",
        ...(args.includes("--exercise")
          ? [
              "dialog cancellation",
              "invalid-file recovery",
              "comparison divider keyboard control",
              "detail and raking light",
              "orbit and zoom",
              "advanced customization",
              "optimization cancellation",
            ]
          : []),
      ],
      limit:
        "Native file dialogs are supplied with paths by the driver. Physical device performance is not measured.",
    };
    await fs.writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
    print(report);
    if (errors.length) throw new Error("Desktop renderer errors were recorded.");
  } finally {
    await desktop?.close();
    await fs.unlink(lockPath).catch(() => {});
  }
}

try {
  switch (command) {
    case "env": {
      const engine = await client();
      try {
        print({
          ...(await engine.call("environment")),
          node: process.version,
          platform: process.platform,
          root,
        });
      } finally {
        await engine.close();
      }
      break;
    }
    case "status": {
      let rendererReady = false;
      try {
        rendererReady = (
          await fetch("http://127.0.0.1:5183/", { signal: AbortSignal.timeout(1500) })
        ).ok;
      } catch {}
      print({
        rendererReady,
        built: await exists(path.join(root, "dist/desktop/electron/main.js")),
        packages: await fs.readdir(path.join(root, "release")).catch(() => []),
      });
      break;
    }
    case "optimize":
      await optimize();
      break;
    case "smoke":
      await smoke();
      break;
    default:
      print({
        commands: {
          env: "pnpm agent env --pretty",
          status: "pnpm agent status --pretty",
          optimize:
            "pnpm agent optimize --input C:/path/model.usdz --preset detailed --out artifacts/exports",
          smoke:
            "pnpm agent smoke --input C:/path/model.usdz --out artifacts/desktop-smoke [--exercise] [--executable release/win-unpacked/Kiln.exe]",
        },
        note: "Build first with pnpm build. Commands process files locally and never overwrite the input.",
      });
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
