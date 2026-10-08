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
type Manager = "apt-get" | "dnf" | "zypper";

function fixture(managers: Manager[] = ["apt-get"], root = false) {
  const directory = mkdtempSync(join(tmpdir(), "kiln-installer-test-"));
  mkdirSync(join(directory, "bin"));
  mkdirSync(join(directory, "fixtures"));
  const script = (name: string, body: string) =>
    writeFileSync(join(directory, "bin", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Isolate PATH so unsupported distributions cannot discover a real host package manager.
  const utilities = ["sh", "awk", "sha256sum", "mktemp", "rm", "cp"];
  const paths = spawnSync(
    shell,
    ["-c", 'for tool in "$@"; do command -v "$tool"; done', "tools", ...utilities],
    {
      encoding: "utf8",
    },
  );
  assert.equal(paths.status, 0, paths.stderr);
  const locations = paths.stdout.trim().split(/\r?\n/);
  utilities.forEach((name, index) => {
    const log = name === "sha256sum" ? 'printf "verify\\n" >> "$PWD/events"\n' : "";
    script(name, `${log}exec '${locations[index]}' "$@"`);
  });
  script("uname", 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
  script("id", `echo ${root ? "0" : "1000"}`);
  script("sudo", 'printf "sudo\\n" >> "$PWD/events"\nexec "$@"');
  script(
    "curl",
    'while [ "$#" -gt 0 ]; do\n case "$1" in --output) shift; output=$1 ;; https://*) url=$1 ;; esac\n shift\ndone\nprintf "download %s\\n" "${url##*/}" >> "$PWD/events"\ncp "$PWD/fixtures/${url##*/}" "$output"',
  );
  for (const manager of managers) {
    script(
      manager,
      `printf '%s %s %s\\n' '${manager}' "$1" "$2" >> "$PWD/events"\n[ "$#" = 2 ] && [ "$1" = install ] || exit 1\ncase "$2" in /*) ;; *) exit 1 ;; esac\ncp "$2" "$PWD/installed-package"`,
    );
  }
  const assets = { "Kiln-Linux-x64.deb": "fixture deb", "Kiln-Linux-x64.rpm": "fixture rpm" };
  function release(contents = assets) {
    const checksums = Object.entries(contents).map(([name, content]) => {
      writeFileSync(join(directory, "fixtures", name), content);
      return `${createHash("sha256").update(content).digest("hex")}  ${name}`;
    });
    writeFileSync(join(directory, "fixtures", "SHA256SUMS.txt"), checksums.join("\n") + "\n");
  }
  release();
  return {
    directory,
    release,
    events: () =>
      existsSync(join(directory, "events"))
        ? readFileSync(join(directory, "events"), "utf8").trim().split("\n")
        : [],
    run: (...options: string[]) =>
      spawnSync(
        shell,
        [
          "-c",
          'export HOME="$PWD/home space" TMPDIR="$PWD"; export PATH="$PWD/bin"; exec sh "$@"',
          "installer-test",
          installer,
          ...options,
        ],
        { cwd: directory, encoding: "utf8" },
      ),
    /** Runs the script the way `curl ... | sh` does, from standard input. */
    pipe: (script = readFileSync(installer, "utf8")) =>
      spawnSync(
        shell,
        ["-c", 'export HOME="$PWD/home space" TMPDIR="$PWD"; export PATH="$PWD/bin"; exec sh -s'],
        { cwd: directory, encoding: "utf8", input: script },
      ),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const manager of ["apt-get", "dnf", "zypper"] as const) {
  test(
    `${manager} installs and updates the verified native package`,
    { skip: !shellAvailable },
    () => {
      const setup = fixture([manager]);
      try {
        const extension = manager === "apt-get" ? "deb" : "rpm";
        const asset = `Kiln-Linux-x64.${extension}`;
        const result = setup.run();
        assert.equal(result.status, 0, result.stderr);
        const events = setup.events();
        assert.deepEqual(events.slice(0, 4), [
          `download ${asset}`,
          "download SHA256SUMS.txt",
          "verify",
          "sudo",
        ]);
        assert.match(
          events[4]!,
          new RegExp(`^${manager} install /.+/${asset.replaceAll(".", "\\.")}$`),
        );
        assert.equal(
          readFileSync(join(setup.directory, "installed-package"), "utf8"),
          `fixture ${extension}`,
        );
        setup.release({ "Kiln-Linux-x64.deb": "updated deb", "Kiln-Linux-x64.rpm": "updated rpm" });
        const update = setup.run();
        assert.equal(update.status, 0, update.stderr);
        assert.equal(
          readFileSync(join(setup.directory, "installed-package"), "utf8"),
          `updated ${extension}`,
        );
        assert.equal(
          setup.events().filter((event) => event.startsWith(`${manager} install `)).length,
          2,
        );
        assert.equal(existsSync(join(setup.directory, "home space")), false);
      } finally {
        setup.dispose();
      }
    },
  );
}

test(
  "installs when piped from curl, and a cut-off download runs nothing",
  { skip: !shellAvailable },
  () => {
    const setup = fixture(["apt-get"]);
    try {
      const script = readFileSync(installer, "utf8");
      const truncated = setup.pipe(script.slice(0, script.lastIndexOf('main "$@"') - 40));
      assert.notEqual(truncated.status, 0);
      assert.deepEqual(setup.events(), []);
      const result = setup.pipe();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(setup.directory, "installed-package"), "utf8"), "fixture deb");
    } finally {
      setup.dispose();
    }
  },
);

test(
  "root uses apt-get directly when several managers are available",
  { skip: !shellAvailable },
  () => {
    const setup = fixture(["apt-get", "dnf", "zypper"], true);
    try {
      const result = setup.run();
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(setup.events().slice(0, 3), [
        "download Kiln-Linux-x64.deb",
        "download SHA256SUMS.txt",
        "verify",
      ]);
      assert.match(setup.events()[3]!, /^apt-get install /);
      assert.equal(setup.events().includes("sudo"), false);
    } finally {
      setup.dispose();
    }
  },
);

test(
  "unsupported distributions fail before downloading or installing",
  { skip: !shellAvailable },
  () => {
    const setup = fixture([]);
    try {
      const result = setup.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Debian\/Ubuntu.*Fedora\/RHEL.*openSUSE/);
      assert.deepEqual(setup.events(), []);
    } finally {
      setup.dispose();
    }
  },
);

for (const invalid of ["mismatched", "ambiguous", "missing"] as const) {
  test(`${invalid} checksum prevents package installation`, { skip: !shellAvailable }, () => {
    const setup = fixture();
    try {
      const sums = join(setup.directory, "fixtures", "SHA256SUMS.txt");
      if (invalid === "mismatched") {
        writeFileSync(join(setup.directory, "fixtures", "Kiln-Linux-x64.deb"), "corrupt package");
      } else {
        writeFileSync(sums, invalid === "ambiguous" ? readFileSync(sums, "utf8").repeat(2) : "");
      }
      const result = setup.run();
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        invalid === "mismatched" ? /checksum verification failed/ : /missing or ambiguous/,
      );
      assert.equal(
        setup.events().some((event) => event === "sudo" || event.startsWith("apt-get install ")),
        false,
      );
      assert.equal(existsSync(join(setup.directory, "installed-package")), false);
    } finally {
      setup.dispose();
    }
  });
}

test(
  "dry runs select Linux packages and macOS zips without mutation or network",
  { skip: !shellAvailable },
  () => {
    const setup = fixture();
    try {
      for (const arch of ["x64", "arm64"]) {
        const result = setup.run("--dry-run", "--platform", "macos", "--arch", arch);
        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(`Kiln-macOS-${arch}.zip`));
        assert.match(result.stdout, /home space\/Applications\/Kiln.app/);
      }
      const linux = setup.run("--dry-run", "--platform", "linux", "--arch", "x64");
      assert.equal(linux.status, 0, linux.stderr);
      assert.match(linux.stdout, /apt-get install .*Kiln-Linux-x64.deb/);
      const unsupported = setup.run("--dry-run", "--platform", "linux", "--arch", "arm64");
      assert.notEqual(unsupported.status, 0);
      assert.match(unsupported.stderr, /x64 only/);
      assert.deepEqual(setup.events(), []);
      assert.equal(existsSync(join(setup.directory, "home space")), false);
      assert.equal(existsSync(join(setup.directory, "installed-package")), false);
      assert.equal(existsSync(join(setup.directory, "SHA256SUMS.txt")), false);
    } finally {
      setup.dispose();
    }
  },
);
