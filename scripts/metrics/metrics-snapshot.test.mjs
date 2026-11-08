// Structural tests for the metric snapshot runner (no database needed).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { QUERY_METRICS, SKIPPED, computationHash } from "./metrics-snapshot.mjs";

const DICTIONARY_DIR = new URL("../../docs/metrics/dictionary/", import.meta.url);
const dictionary = new Map();
for (const name of readdirSync(DICTIONARY_DIR).filter((file) => file.endsWith(".json"))) {
  const document = JSON.parse(readFileSync(new URL(name, DICTIONARY_DIR), "utf8"));
  for (const metric of document.metrics) dictionary.set(metric.id, metric);
}

test("computationHash is stable and sensitive to every input", () => {
  const base = computationHash("T2-001", 1, "DE", 43, 173);
  assert.equal(base, computationHash("T2-001", 1, "DE", 43, 173));
  assert.notEqual(base, computationHash("T2-001", 2, "DE", 43, 173));
  assert.notEqual(base, computationHash("T2-001", 1, "FR", 43, 173));
  assert.notEqual(base, computationHash("T2-001", 1, "DE", 44, 173));
  assert.match(base, /^[0-9a-f]{64}$/);
});

test("every implemented metric exists in the machine dictionary with matching version", () => {
  assert.ok(QUERY_METRICS.length >= 8);
  for (const metricId of QUERY_METRICS) {
    const metric = dictionary.get(metricId);
    assert.ok(metric, `${metricId} missing from docs/metrics/dictionary`);
    assert.equal(metric.version, 1, `${metricId} dictionary version drifted from the runner`);
  }
});

test("skipped metrics are dictionary entries with an explicit reason", () => {
  assert.equal(SKIPPED.length, 4);
  const seen = new Set();
  for (const row of SKIPPED) {
    assert.ok(dictionary.has(row.metricId), `${row.metricId} not in dictionary`);
    assert.ok(!seen.has(row.metricId), `duplicate skip ${row.metricId}`);
    seen.add(row.metricId);
    assert.ok(row.reason.length > 0 && row.detail.length > 0);
    assert.ok(!QUERY_METRICS.includes(row.metricId), `${row.metricId} both implemented and skipped`);
  }
});

test("implemented metrics use only existing sources (ACTIVE constraint)", () => {
  const sources = JSON.parse(
    readFileSync(new URL("../../docs/metrics/schemas/sources.v1.json", import.meta.url), "utf8"),
  );
  const existing = new Set(sources.sources.existing);
  for (const metricId of QUERY_METRICS) {
    const metric = dictionary.get(metricId);
    assert.ok(existing.has(metric.numerator.source), `${metricId} numerator source not existing`);
    if (metric.denominator) {
      assert.ok(existing.has(metric.denominator.source), `${metricId} denominator source not existing`);
    }
  }
});
