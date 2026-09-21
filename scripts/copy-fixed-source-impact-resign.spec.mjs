import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyResign,
  updateGovernanceRecord,
} from "./copy-fixed-source-impact-resign.mjs";

const receipt = Object.freeze({
  status: "STALE_HOLD",
  current_source_fingerprint: "a".repeat(64),
  drifted_paths: ["package.json", "pnpm-lock.yaml"],
  dispatch_authorization: "NOT_AUTHORIZED",
  stale_scope: "SCOPE_V2",
});

test("a fingerprint-only move is re-signable without review", () => {
  assert.deepEqual(
    classifyResign(receipt, { ...receipt, current_source_fingerprint: "b".repeat(64) }),
    { kind: "HASH_ONLY", changed: [] },
  );
  assert.deepEqual(classifyResign(receipt, { ...receipt }), {
    kind: "UNCHANGED",
    changed: [],
  });
});

test("any eligibility field change requires explicit acceptance", () => {
  for (const [field, value] of [
    ["status", "CURRENT"],
    ["drifted_paths", ["package.json"]],
    ["drifted_paths", ["pnpm-lock.yaml", "package.json"]],
    ["stale_scope", "SCOPE_V3"],
    ["dispatch_authorization", "AUTHORIZED"],
  ]) {
    assert.deepEqual(
      classifyResign(receipt, {
        ...receipt,
        current_source_fingerprint: "b".repeat(64),
        [field]: value,
      }),
      { kind: "ELIGIBILITY_CHANGED", changed: [field] },
      field,
    );
  }
  const { stale_scope: _removed, ...withoutScope } = receipt;
  assert.deepEqual(classifyResign(receipt, withoutScope), {
    kind: "ELIGIBILITY_CHANGED",
    changed: ["stale_scope"],
  });
});

test("the governance record rewrites exactly its two digest rows", () => {
  const record = [
    "| Field | Value |",
    "| --- | --- |",
    `| Current source fingerprint | \`${"1".repeat(64)}\` |`,
    `| Eligibility receipt SHA-256 | \`${"2".repeat(64)}\` |`,
    "",
  ].join("\n");
  const updated = updateGovernanceRecord(record, "c".repeat(64), "d".repeat(64));
  assert.match(updated, new RegExp(`Current source fingerprint \\| \`${"c".repeat(64)}\``));
  assert.match(updated, new RegExp(`Eligibility receipt SHA-256 \\| \`${"d".repeat(64)}\``));
  assert.equal(updated.split("\n").length, record.split("\n").length);
});

test("the governance record rejects missing, duplicated or malformed digests", () => {
  const row = `| Current source fingerprint | \`${"1".repeat(64)}\` |`;
  const sha = `| Eligibility receipt SHA-256 | \`${"2".repeat(64)}\` |`;
  assert.throws(() => updateGovernanceRecord(sha, "c".repeat(64), "d".repeat(64)), /ROW_COUNT: Current/);
  assert.throws(
    () => updateGovernanceRecord([row, row, sha].join("\n"), "c".repeat(64), "d".repeat(64)),
    /ROW_COUNT: Current/,
  );
  assert.throws(() => updateGovernanceRecord([row, sha].join("\n"), "C".repeat(64), "d".repeat(64)), /DIGEST_INVALID/);
});
