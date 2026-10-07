import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const installer = resolve("install.sh").replaceAll("\\", "/");
const shellAvailable = existsSync(shell);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kiln-installer-test-"));
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "fixtures"));
  writeFileSync(
    join(directory, "bin", "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, "bin", "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n case "$1" in --output) shift; output=$1 ;; https://*) url=$1 ;; esac\n shift\ndone\ncp "$PWD/fixtures/${url##*/}" "$output"\n',
    { mode: 0o755 },
  );
  const assets = { "Kiln-Linux-x64.AppImage": "fixture executable", "Kiln.png": "fixture icon" };
  const checksums = Object.entries(assets).map(([name, content]) => {
    writeFileSync(join(directory, "fixtures", name), content);
    return `${createHash("sha256").update(content).digest("hex")}  ${name}`;
  });
  writeFileSync(join(directory, "fixtures", "SHA256SUMS.txt"), checksums.join("\n") + "\n");
  return {
    directory,
    run: (options = "") =>
      spawnSync(
        shell,
        [
          "-c",
          'export HOME="$PWD/home space" XDG_DATA_HOME="$PWD/menu space"; export PATH="$PWD/bin:$PATH"; sh "$1" ' +
            options,
          "installer-test",
          installer,
        ],
        { cwd: directory, encoding: "utf8" },
      ),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test(
  "Linux install and update verify both assets and create a FUSE-free menu entry",
  { skip: !shellAvailable },
  () => {
    const setup = fixture();
    try {
      const result = setup.run();
      assert.equal(result.status, 0, result.stderr);
      const app = join(setup.directory, "home space/.local/opt/kiln/Kiln.AppImage");
      assert.equal(readFileSync(app, "utf8"), "fixture executable");
      const desktop = readFileSync(
        join(setup.directory, "menu space/applications/kiln.desktop"),
        "utf8",
      );
      assert.match(
        desktop,
        /Exec=\/usr\/bin\/env APPIMAGE_EXTRACT_AND_RUN=1 "[^"\n]+home space\/\.local\/opt\/kiln\/Kiln.AppImage"/,
      );
      assert.match(desktop, /Icon=.*home space\/\.local\/opt\/kiln\/kiln.png/);
      assert.equal(setup.run().status, 0);
      const replacement = "updated fixture executable";
      writeFileSync(join(setup.directory, "fixtures", "Kiln-Linux-x64.AppImage"), replacement);
      const sums = join(setup.directory, "fixtures", "SHA256SUMS.txt");
      writeFileSync(
        sums,
        readFileSync(sums, "utf8").replace(
          /^[a-f0-9]{64}/,
          createHash("sha256").update(replacement).digest("hex"),
        ),
      );
      const update = setup.run();
      assert.equal(update.status, 0, update.stderr);
      assert.equal(readFileSync(app, "utf8"), replacement);
      writeFileSync(join(setup.directory, "fixtures", "Kiln.png"), "corrupt icon");
      const corrupt = setup.run();
      assert.notEqual(corrupt.status, 0);
      assert.match(corrupt.stderr, /checksum verification failed: Kiln.png/);
      assert.equal(readFileSync(app, "utf8"), replacement);
      assert.equal(
        readFileSync(join(setup.directory, "menu space/applications/kiln.desktop"), "utf8"),
        desktop,
      );
    } finally {
      setup.dispose();
    }
  },
);

test(
  "Linux installer preserves unmanaged files and rejects ambiguous checksums",
  { skip: !shellAvailable },
  () => {
    const setup = fixture();
    try {
      const installDirectory = join(setup.directory, "home space/.local/opt/kiln");
      mkdirSync(installDirectory, { recursive: true });
      writeFileSync(join(installDirectory, "original.txt"), "keep me");
      const unmanaged = setup.run();
      assert.notEqual(unmanaged.status, 0);
      assert.match(unmanaged.stderr, /unmanaged installation/);
      assert.equal(readFileSync(join(installDirectory, "original.txt"), "utf8"), "keep me");
      rmSync(installDirectory, { recursive: true });
      const sums = join(setup.directory, "fixtures", "SHA256SUMS.txt");
      writeFileSync(sums, readFileSync(sums, "utf8").repeat(2));
      const ambiguous = setup.run();
      assert.notEqual(ambiguous.status, 0);
      assert.match(ambiguous.stderr, /missing or ambiguous/);
      assert.equal(existsSync(installDirectory), false);
    } finally {
      setup.dispose();
    }
  },
);

test(
  "dry runs select supported releases without creating application folders",
  { skip: !shellAvailable },
  () => {
    const setup = fixture();
    try {
      for (const arch of ["x64", "arm64"]) {
        const result = setup.run(`--dry-run --platform macos --arch ${arch}`);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`Kiln-macOS-${arch}.zip`));
      }
      const linux = setup.run("--dry-run --platform linux --arch x64");
      assert.equal(linux.status, 0, linux.stderr);
      assert.match(linux.stdout, /Kiln-Linux-x64.AppImage/);
      assert.notEqual(setup.run("--dry-run --platform linux --arch arm64").status, 0);
      assert.equal(existsSync(join(setup.directory, "home space")), false);
      assert.equal(existsSync(join(setup.directory, "menu space")), false);
    } finally {
      setup.dispose();
    }
  },
);

test(
  "desktop Exec escapes quotes, percent placeholders, dollar signs and backticks",
  { skip: !shellAvailable },
  () => {
    const result = spawnSync(
      shell,
      [installer, "--dry-run", "--platform", "linux", "--arch", "x64"],
      {
        env: { ...process.env, HOME: '/home/a "quote" $dollar `tick` %f', XDG_DATA_HOME: "/menu" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        'Exec=/usr/bin/env APPIMAGE_EXTRACT_AND_RUN=1 "/home/a \\\\"quote\\\\" \\\\$dollar \\\\`tick\\\\` %%f/.local/opt/kiln/Kiln.AppImage"',
      ),
    );
  },
);
