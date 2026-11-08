// Unit tests for the pure helpers in lib/psql.mjs (node:test only).
//
// Run: node --test 'scripts/metrics/**/*.test.mjs'
import assert from "node:assert/strict";
import test from "node:test";

import { assertUuid, parseArgs, pct, pctInterval, ratio, toInt, wilson } from "./psql.mjs";

test("ratio returns null for an empty denominator", () => {
  assert.equal(ratio(1, 4), 0.25);
  assert.equal(ratio(0, 4), 0);
  assert.equal(ratio(3, 0), null);
});

test("wilson matches the closed-form interval for a balanced sample", () => {
  const interval = wilson(50, 100);
  assert.ok(interval.low > 0.39 && interval.low < 0.41);
  assert.ok(interval.high > 0.58 && interval.high < 0.6);
  assert.ok(interval.low < 0.5 && interval.high > 0.5);
});

test("wilson stays conservative for zero counts", () => {
  const interval = wilson(0, 274);
  assert.equal(interval.low, 0);
  assert.ok(interval.high > 0.01 && interval.high < 0.02);
  assert.equal(wilson(0, 0), null);
});

test("pct and pctInterval format with a dash on empty denominators", () => {
  assert.equal(pct(73, 403), "18.1%");
  assert.equal(pct(1, 0), "—");
  assert.match(pctInterval(50, 100), /^\[\d+\.\d%, \d+\.\d%\]$/);
  assert.equal(pctInterval(1, 0), "—");
});

test("toInt coerces Postgres decimal strings and rejects garbage", () => {
  assert.equal(toInt("42"), 42);
  assert.equal(toInt(""), 0);
  assert.equal(toInt(null), 0);
  assert.throws(() => toInt("abc"), /not a number/);
});

test("parseArgs handles bare, valued and inline flags", () => {
  assert.deepEqual(parseArgs(["--json", "--main-workspace", "abc", "--top-domains=5"]), {
    json: true,
    "main-workspace": "abc",
    "top-domains": "5",
  });
  assert.throws(() => parseArgs(["positional"]), /unexpected argument/);
});

test("assertUuid accepts UUIDs only", () => {
  assert.equal(
    assertUuid("C3584CF9-1A6B-4E7E-9B0C-C1BDCC8258E5", "workspace"),
    "c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5",
  );
  assert.throws(() => assertUuid("not-a-uuid", "workspace"), /must be a UUID/);
});
