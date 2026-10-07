import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Release automation runs directly in Node before dependency installation.
import { validateTag, validateAssets, binaryAssets, shouldPromote } from "../tools/release.mjs";

test("release version must match a stable package tag", () => {
  validateTag("v0.1.1", "0.1.1");
  for (const tag of ["main", "v0.1.0", "v0.1.1-beta", undefined])
    assert.throws(() => validateTag(tag, "0.1.1"));
  assert.throws(() => validateTag("v0.1.1-beta", "0.1.1-beta"));
});

test("all native release downloads must exist and fit GitHub's asset limit", () => {
  const assets = binaryAssets.map((name: string) => ({ name, size: 123 }));
  validateAssets(assets, binaryAssets);
  assert.throws(() => validateAssets(assets.slice(1), binaryAssets));
  assert.throws(() => validateAssets([...assets, assets[0]], binaryAssets));
  for (const size of [0, 2 ** 31])
    assert.throws(() => validateAssets([{ ...assets[0], size }, ...assets.slice(1)], binaryAssets));
});

test("a late older build never replaces a newer stable download", () => {
  const published = (tagName: string) => ({ tagName, isDraft: false, isPrerelease: false });
  assert.equal(shouldPromote("v0.1.2", [published("v0.1.3")]), false);
  assert.equal(shouldPromote("v0.1.10", [published("v0.1.9")]), true);
  assert.equal(shouldPromote("v0.1.2", [{ ...published("v0.1.3"), isDraft: true }]), true);
  assert.equal(shouldPromote("v0.1.2", [{ ...published("v0.1.3"), isPrerelease: true }]), true);
  assert.equal(shouldPromote("v0.1.2", [published("v1.0.0")]), false);
  assert.equal(shouldPromote("v0.1.2", []), true);
});
