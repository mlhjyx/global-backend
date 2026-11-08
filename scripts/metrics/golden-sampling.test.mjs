// Unit tests for the golden-set sampling scaffold (node:test only).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createRng } from "./lib/prng.mjs";
import {
  allocateProportional,
  parsePoolCsv,
  sampleDataset,
  validateDatasetConfig,
} from "./golden-sampling.mjs";

const ACCOUNTS_FIXTURE = new URL("./fixtures/golden-pool.accounts.sample.csv", import.meta.url);
const CONTACTS_FIXTURE = new URL("./fixtures/golden-pool.contacts.sample.csv", import.meta.url);

const MANIFEST = {
  schemaVersion: "golden-sampling-manifest/v1",
  goldenSet: "golden-discovery/v1",
  seed: "20261108",
  datasets: [
    {
      key: "accounts",
      purpose: "test",
      totalQuota: 25,
      quota: { anchor: 5, rolling: 15, challenge: 5 },
      strata: ["country"],
    },
  ],
};

test("parsePoolCsv reads the fixture and rejects missing columns", () => {
  const { rows, skipped } = parsePoolCsv(readFileSync(ACCOUNTS_FIXTURE, "utf8"));
  assert.equal(rows.length, 62);
  assert.equal(skipped, 0);
  assert.throws(() => parsePoolCsv("ref,layer\nx,rolling\n"), /missing column "stratum"/);
});

test("parsePoolCsv skips rows with unknown layers or blank refs", () => {
  const { rows, skipped } = parsePoolCsv("ref,layer,stratum\na,rolling,DE\nb,weekly,DE\n,rolling,DE\n");
  assert.equal(rows.length, 1);
  assert.equal(skipped, 2);
});

test("validateDatasetConfig checks quotas, totals and seed", () => {
  assert.deepEqual(validateDatasetConfig(MANIFEST, "accounts").issues, []);
  const missing = validateDatasetConfig(MANIFEST, "nope");
  assert.equal(missing.issues[0].code, "DATASET_MISSING");
  const mismatch = validateDatasetConfig(
    { ...MANIFEST, datasets: [{ ...MANIFEST.datasets[0], totalQuota: 999 }] },
    "accounts",
  );
  assert.ok(mismatch.issues.some((item) => item.code === "QUOTA_SUM_MISMATCH"));
  const noSeed = validateDatasetConfig({ ...MANIFEST, seed: "" }, "accounts");
  assert.ok(noSeed.issues.some((item) => item.code === "SEED_MISSING"));
});

test("allocateProportional distributes exactly and respects availability", () => {
  const counts = new Map([
    ["a", 30],
    ["b", 10],
    ["c", 5],
  ]);
  const allocation = allocateProportional(counts, 20);
  assert.equal(Object.values(allocation).reduce((sum, value) => sum + value, 0), 20);
  assert.ok(allocation.a >= allocation.b);
  assert.ok(allocation.b >= allocation.c);
  for (const [stratum, available] of counts) {
    assert.ok(allocation[stratum] <= available, `${stratum} over-allocated`);
  }
});

test("allocateProportional caps at the pool and keeps the 5-per-stratum floor", () => {
  const counts = new Map([
    ["big", 100],
    ["small", 6],
  ]);
  const allocation = allocateProportional(counts, 50);
  assert.equal(allocation.small >= 5, true);
  assert.equal(allocation.big + allocation.small, 50);
  const capped = allocateProportional(counts, 200);
  assert.deepEqual(capped, { big: 100, small: 6 });
});

test("sampleDataset is deterministic for a fixed seed and tracks underfill", () => {
  const { rows } = parsePoolCsv(readFileSync(ACCOUNTS_FIXTURE, "utf8"));
  const dataset = MANIFEST.datasets[0];
  const first = sampleDataset({ rows, manifest: MANIFEST, dataset, rng: createRng(MANIFEST.seed, "accounts") });
  const second = sampleDataset({ rows, manifest: MANIFEST, dataset, rng: createRng(MANIFEST.seed, "accounts") });
  assert.deepEqual(first.sampled, second.sampled);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.sampled.length, 25);
  assert.deepEqual(first.underfill, []);
  const perLayer = new Map();
  for (const row of first.sampled) perLayer.set(row.layer, (perLayer.get(row.layer) ?? 0) + 1);
  assert.equal(perLayer.get("anchor"), 5);
  assert.equal(perLayer.get("rolling"), 15);
  assert.equal(perLayer.get("challenge"), 5);
});

test("underfilled strata are reported, not backfilled", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({
    ref: `x-${index}`,
    layer: "rolling",
    stratum: "only",
  }));
  const dataset = { key: "accounts", quota: { anchor: 0, rolling: 10, challenge: 0 } };
  const result = sampleDataset({ rows, manifest: MANIFEST, dataset, rng: createRng("20261108", "x") });
  assert.equal(result.sampled.length, 6);
  assert.equal(result.underfill.length, 1);
  assert.deepEqual(result.underfill[0], { layer: "rolling", requested: 10, sampled: 6, available: 6 });
});

test("contacts fixture covers email, phone and both channels", () => {
  const { rows } = parsePoolCsv(readFileSync(CONTACTS_FIXTURE, "utf8"));
  const channels = new Set(rows.map((row) => row.stratum.split("|")[2]));
  assert.deepEqual([...channels].sort(), ["both", "email", "phone"]);
});
