import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const COMPILED_ROOT = resolve(
  ROOT,
  "apps/api/dist/platform-authority",
);

test("compiled API retains and loads the exact GrowthOS policy bytes", async () => {
  const bytes = await readFile(
    resolve(COMPILED_ROOT, "platform-authority-policy-matrix-v1.json"),
  );
  assert.equal(bytes.byteLength, 3121);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1",
  );

  const runtime = await import(
    resolve(COMPILED_ROOT, "platform-authority-policy-asset.js")
  );
  assert.equal(
    runtime.loadVerifiedPlatformAuthorityPolicyAsset().sha256,
    "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1",
  );
});
