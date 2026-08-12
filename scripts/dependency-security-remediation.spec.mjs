import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_SECURITY_OVERRIDES = Object.freeze({
  "brace-expansion@>=1.0.0 <2.0.0": "1.1.18",
  "brace-expansion@>=2.0.0 <3.0.0": "2.1.4",
  "fast-uri@>=3.0.0 <4.0.0": "3.1.5",
  "ip-address@>=10.0.0 <11.0.0": "10.3.1",
  "js-yaml@>=3.0.0 <4.0.0": "3.15.1",
  "js-yaml@>=4.0.0 <5.0.0": "4.3.1",
  "js-yaml@>=5.0.0 <6.0.0": "5.2.2",
  "nanoid@>=3.0.0 <4.0.0": "3.3.17",
  "postcss@>=8.0.0 <9.0.0": "8.5.23",
});

const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze([
  "brace-expansion@1.1.16",
  "brace-expansion@2.1.2",
  "fast-uri@3.1.3",
  "ip-address@10.2.0",
  "js-yaml@3.15.0",
  "js-yaml@4.2.0",
  "js-yaml@4.3.0",
  "js-yaml@5.2.1",
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "postcss@8.5.16",
  "postcss@8.5.19",
]);

test("S1 production security floors are explicit and major-scoped", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(manifest.pnpm?.overrides, EXPECTED_SECURITY_OVERRIDES);
  for (const selector of Object.keys(EXPECTED_SECURITY_OVERRIDES)) {
    assert.match(selector, /@>=\d+\.0\.0 <\d+\.0\.0$/u);
  }
});

test("the lockfile contains none of the S1 vulnerable snapshots", async () => {
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  for (const snapshot of FORBIDDEN_LOCKFILE_SNAPSHOTS) {
    assert.equal(
      new RegExp(`^  ${snapshot.replaceAll(".", "\\.")}:`, "mu").test(
        lockfile,
      ),
      false,
      `${snapshot} must not remain in the resolved dependency graph`,
    );
  }
});
