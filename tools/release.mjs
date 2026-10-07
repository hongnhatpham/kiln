import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const platformAssets = {
  "windows-x64": ["Kiln-Windows-x64-Setup.exe", "Kiln-Windows-x64-Portable.exe"],
  "linux-x64": ["Kiln-Linux-x64.deb", "Kiln-Linux-x64.rpm"],
  "macos-arm64": ["Kiln-macOS-arm64.dmg", "Kiln-macOS-arm64.zip"],
  "macos-x64": ["Kiln-macOS-x64.dmg", "Kiln-macOS-x64.zip"],
};
export const binaryAssets = Object.values(platformAssets).flat();
const installerAssets = ["install.ps1", "install.sh"];

export function validateTag(tag, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || tag !== `v${version}`)
    throw new Error(`Release tag must match package version: v${version}.`);
}

export function validateAssets(assets, expected) {
  for (const name of expected) {
    const matches = assets.filter((asset) => asset.name === name);
    if (matches.length !== 1 || matches[0].size <= 0 || matches[0].size >= 2 ** 31)
      throw new Error(`Missing, empty, duplicate or oversized release asset: ${name}.`);
  }
}

export function shouldPromote(tag, releases) {
  const parts = (value) =>
    /^v\d+\.\d+\.\d+$/.test(value) ? value.slice(1).split(".").map(BigInt) : null;
  const version = parts(tag);
  if (!version) throw new Error("Latest promotion requires a stable version tag.");
  return !releases.some((item) => {
    const other = parts(item.tagName);
    if (item.isDraft || item.isPrerelease || !other) return false;
    for (let index = 0; index < 3; index++) {
      if (other[index] !== version[index]) return other[index] > version[index];
    }
    return false;
  });
}

export async function release(action, platform) {
  const tag = process.env.GITHUB_REF_NAME;
  const repo = process.env.GITHUB_REPOSITORY;
  const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  validateTag(tag, version);
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Set GITHUB_REPOSITORY.");
  const gh = (...args) =>
    execFileSync("gh", [...args, "--repo", repo], { cwd: root, encoding: "utf8" });
  const view = () => JSON.parse(gh("release", "view", tag, "--json", "isDraft,assets"));
  const list = () =>
    JSON.parse(
      execFileSync("gh", ["api", `repos/${repo}/releases`, "--paginate", "--slurp"], {
        cwd: root,
        encoding: "utf8",
      }),
    )
      .flat()
      .map((item) => ({
        tagName: item.tag_name,
        isDraft: item.draft,
        isPrerelease: item.prerelease,
      }));
  // Only modify an unpublished draft. Reruns of failed builds replace their own assets.
  if (action === "prepare") {
    const releases = list();
    const existing = releases.find((item) => item.tagName === tag);
    if (existing && !existing.isDraft)
      throw new Error("This version is already published. Use a new version tag.");
    if (!existing)
      gh(
        "release",
        "create",
        tag,
        "--draft",
        "--verify-tag",
        "--title",
        `Kiln ${tag}`,
        "--notes-file",
        "docs/release-notes.md",
      );
  } else if (action === "upload") {
    const names = platformAssets[platform];
    if (!names) throw new Error("Choose windows-x64, linux-x64, macos-arm64 or macos-x64.");
    if (!view().isDraft) throw new Error("Refusing to replace published downloads.");
    const files = names.map((name) => path.join(root, "release", name));
    validateAssets(
      await Promise.all(
        files.map(async (file) => ({
          name: path.basename(file),
          size: (await fs.stat(file)).size,
        })),
      ),
      names,
    );
    gh("release", "upload", tag, ...files, "--clobber");
  } else if (action === "publish") {
    const current = view();
    if (!current.isDraft) throw new Error("This version is already published.");
    validateAssets(current.assets, binaryAssets);
    const folder = await fs.mkdtemp(path.join(root, ".release-verify-"));
    try {
      gh(
        "release",
        "download",
        tag,
        "--dir",
        folder,
        ...binaryAssets.flatMap((name) => ["--pattern", name]),
      );
      for (const name of installerAssets)
        await fs.copyFile(path.join(root, name), path.join(folder, name));
      const names = [...binaryAssets, ...installerAssets].sort();
      const rows = await Promise.all(
        names.map(async (name) => {
          const hash = crypto.createHash("sha256");
          const handle = await fs.open(path.join(folder, name));
          try {
            for await (const chunk of handle.createReadStream()) hash.update(chunk);
          } finally {
            await handle.close();
          }
          return `${hash.digest("hex")}  ${name}\n`;
        }),
      );
      await fs.writeFile(path.join(folder, "SHA256SUMS.txt"), rows.join(""));
      gh(
        "release",
        "upload",
        tag,
        ...[...installerAssets, "SHA256SUMS.txt"].map((name) => path.join(folder, name)),
        "--clobber",
      );
      validateAssets(view().assets, [...names, "SHA256SUMS.txt"]);
      // The workflow serializes publication so this check and promotion cannot race.
      gh("release", "edit", tag, "--draft=false", `--latest=${shouldPromote(tag, list())}`);
    } finally {
      // mkdtemp creates this folder directly inside this checkout, never from user input.
      await fs.rm(folder, { recursive: true, force: true });
    }
  } else throw new Error("Choose prepare, upload or publish.");
  return { action, tag, platform, repository: repo };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  release(...process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
