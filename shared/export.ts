import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const normalize = (value: string) =>
  process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Protect every imported original, including symlink paths and hard-link aliases. */
export async function checkedOutput(output: string, sources: readonly string[]): Promise<void> {
  let outputReal: string;
  let outputStat;
  try {
    outputReal = await fs.realpath(output);
    outputStat = await fs.stat(output, { bigint: true });
  } catch (error) {
    if (!missing(error)) throw error;
    outputReal = path.join(await fs.realpath(path.dirname(output)), path.basename(output));
  }
  for (const source of sources) {
    const sourceReal = await fs.realpath(source);
    const sourceStat = await fs.stat(source, { bigint: true });
    if (
      normalize(outputReal) === normalize(sourceReal) ||
      (outputStat && outputStat.dev === sourceStat.dev && outputStat.ino === sourceStat.ino)
    ) {
      throw new Error("Choose a different filename. Your archival original must stay intact.");
    }
  }
}

export interface ExportFiles {
  modelSource: string;
  modelPath: string;
  recipePath: string;
  recipe: unknown;
  protectedSources: readonly string[];
}

/** Stage both files, retain the old pair, and restore it if either replacement fails. */
export async function exportFiles(files: ExportFiles): Promise<void> {
  const { modelSource, modelPath, recipePath, recipe, protectedSources } = files;
  if (normalize(modelPath) === normalize(recipePath))
    throw new Error("Model and recipe need different filenames.");
  await checkedOutput(modelPath, protectedSources);
  await checkedOutput(recipePath, protectedSources);
  const suffix = `.kiln-${randomUUID()}`;
  const entries = [modelPath, recipePath].map((output) => ({
    output,
    temp: `${output}${suffix}.tmp`,
    backup: `${output}${suffix}.bak`,
    backedUp: false,
    installed: false,
  }));
  let committed = false;
  try {
    await fs.copyFile(modelSource, entries[0].temp, fs.constants.COPYFILE_EXCL);
    await fs.writeFile(entries[1].temp, JSON.stringify(recipe, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    // Check again after staging, immediately before changing destinations.
    await checkedOutput(modelPath, protectedSources);
    await checkedOutput(recipePath, protectedSources);
    for (const entry of entries) {
      try {
        const stat = await fs.lstat(entry.output);
        if (!stat.isFile() && !stat.isSymbolicLink())
          throw new Error("Choose a file destination for the export.");
        await fs.rename(entry.output, entry.backup);
        entry.backedUp = true;
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    for (const entry of entries) {
      await fs.rename(entry.temp, entry.output);
      entry.installed = true;
    }
    committed = true;
  } catch (error) {
    const failures: unknown[] = [];
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) await fs.unlink(entry.output);
        if (entry.backedUp) await fs.rename(entry.backup, entry.output);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Export failed and an existing file could not be restored. Backup files were retained.",
      );
    throw error;
  } finally {
    await Promise.allSettled(entries.map((entry) => fs.unlink(entry.temp)));
    if (committed)
      await Promise.allSettled(
        entries.filter((entry) => entry.backedUp).map((entry) => fs.unlink(entry.backup)),
      );
  }
}
