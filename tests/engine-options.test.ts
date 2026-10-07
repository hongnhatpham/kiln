import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS } from "../shared/presets.ts";
import { normalizeOptions, targetSize } from "../engine/options.ts";
import { isKilnError } from "../engine/errors.ts";

test("every preset is valid as-is", () => {
  for (const preset of Object.values(PRESETS)) assert.deepEqual(normalizeOptions(preset), preset);
});

test("rejects out-of-range values with every problem listed", () => {
  const bad = {
    ...PRESETS.detailed,
    colorQuality: 101,
    simplifyRatio: 0.05,
    normalSize: 3000,
    losslessTextures: "yes",
  };
  assert.throws(
    () => normalizeOptions(bad),
    (error: unknown) => {
      assert.ok(isKilnError(error, "invalid-options"));
      for (const word of [
        "Color quality",
        "Simplify ratio",
        "Normal map size",
        "Lossless textures",
      ])
        assert.match(error.message, new RegExp(word));
      return true;
    },
  );
  assert.throws(
    () => normalizeOptions({ ...PRESETS.detailed, textureFormat: "avif" }),
    /Texture format/,
  );
  assert.throws(() => normalizeOptions(null), /must be/);
});

test("rounds quality and keeps valid edge values", () => {
  const o = normalizeOptions({
    ...PRESETS.detailed,
    colorQuality: 89.6,
    simplifyRatio: 0.1,
    aoQuality: 0,
  });
  assert.equal(o.colorQuality, 90);
  assert.equal(o.simplifyRatio, 0.1);
  assert.equal(o.aoQuality, 0);
});

test("texture sizes never upscale and keep aspect ratio", () => {
  assert.deepEqual(targetSize(8192, 8192, 4096), { width: 4096, height: 4096 });
  assert.deepEqual(targetSize(8192, 4096, 2048), { width: 2048, height: 1024 });
  assert.deepEqual(targetSize(1000, 500, 4096), { width: 1000, height: 500 });
  assert.deepEqual(targetSize(8192, 8192, 0), { width: 8192, height: 8192 });
});
