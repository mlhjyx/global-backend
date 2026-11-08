// Unit tests for the two-frame capture-recapture scaffold (node:test only).
//
// Run: node --test scripts/metrics/
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCaptureMatrix,
  candidateModels,
  chapman,
  dedupeFrame,
  diagnostics,
  entityKeys,
  estimateMultiFrame,
  estimateTwoFrames,
  fitLogLinear,
  lincolnPetersen,
  matchFrames,
  normalizeCountry,
  normalizeDomain,
  normalizeName,
  pairRecaptures,
  parseCsv,
  readFrame,
} from "./capture-recapture.mjs";
import { createRng } from "./lib/prng.mjs";

test("parseCsv handles BOM, CRLF, quoted commas and escaped quotes", () => {
  const text = '﻿name,country,domain\r\n"ACME, Inc.",US,acme.com\r\n"Hmm ""Quoted"" GmbH",DE,\r\n';
  const { headers, records } = parseCsv(text);
  assert.deepEqual(headers, ["name", "country", "domain"]);
  assert.equal(records.length, 2);
  assert.equal(records[0].name, "ACME, Inc.");
  assert.equal(records[1].name, 'Hmm "Quoted" GmbH');
  assert.equal(records[1].domain, "");
});

test("parseCsv skips fully empty lines", () => {
  const { records } = parseCsv("name\n\nfoo\n   \nbar\n");
  assert.deepEqual(records.map((record) => record.name), ["foo", "bar"]);
});

test("normalizeDomain strips scheme, www, port, path and trailing dot", () => {
  assert.equal(normalizeDomain("https://www.Foo.de/path?q=1"), "foo.de");
  assert.equal(normalizeDomain("http://foo.de:8080/"), "foo.de");
  assert.equal(normalizeDomain("FOO.DE."), "foo.de");
  assert.equal(normalizeDomain("  "), "");
});

test("normalizeName folds umlauts, legal forms and punctuation", () => {
  assert.equal(normalizeName("Müller & Söhne GmbH & Co. KG"), "mueller and soehne");
  assert.equal(normalizeName("Straße AG"), "strasse");
  assert.equal(normalizeName("ACME, Inc."), "acme");
  assert.equal(normalizeName("Beispiel Handel GmbH"), "beispiel handel");
  // A legal-form-only name keeps at least one token.
  assert.equal(normalizeName("GmbH"), "gmbh");
});

test("normalizeCountry folds 德国 to DE and uppercases ISO-2", () => {
  assert.equal(normalizeCountry("德国"), "DE");
  assert.equal(normalizeCountry("de"), "DE");
  assert.equal(normalizeCountry("Germany"), "DE");
  assert.equal(normalizeCountry(""), "");
});

test("entityKeys builds labelled keys in priority order", () => {
  const keys = entityKeys({
    name: "Muster Pumpen GmbH",
    country: "DE",
    domain: "https://www.muster-pumpen.de",
    registry_id: "HRB 12345",
  });
  assert.deepEqual(keys, [
    "domain:muster-pumpen.de",
    "registry:hrb 12345",
    "name:muster pumpen|DE",
  ]);
  assert.deepEqual(entityKeys({ name: "", country: "DE" }), []);
});

test("dedupeFrame drops duplicate primaries and counts keyless rows", () => {
  const { entities, duplicates, keyless } = dedupeFrame([
    { domain: "a.de" },
    { domain: "A.de" },
    { name: "", country: "" },
  ]);
  assert.equal(entities.length, 1);
  assert.equal(duplicates, 1);
  assert.equal(keyless, 1);
});

test("matchFrames counts n1, n2, m11 and the observed union", () => {
  const a = [
    { domain: "a.de" },
    { domain: "b.de" },
    { domain: "c.de" },
  ];
  const b = [
    { domain: "b.de" },
    { domain: "c.de" },
    { domain: "d.de" },
  ];
  const result = matchFrames(a, b);
  assert.equal(result.n1, 3);
  assert.equal(result.n2, 3);
  assert.equal(result.m11, 2);
  assert.equal(result.observedUnion, 4);
  assert.equal(result.ambiguousMatches, 0);
});

test("matchFrames keeps matching one-to-one when two A entities share one B entity", () => {
  const a = [
    { name: "Muster Pumpen", country: "DE", domain: "muster-pumpen.de" },
    { name: "Muster Pumpen", country: "DE", domain: "muster-pumpen-holding.de" },
  ];
  const b = [{ name: "Muster Pumpen GmbH", country: "DE" }];
  const result = matchFrames(a, b);
  assert.equal(result.m11, 1);
  assert.equal(result.duplicateMatches, 1);
});

test("matchFrames falls back to normalized name+country", () => {
  const a = [{ name: "Muster Pumpen GmbH", country: "DE" }];
  const b = [{ name: "Muster Pumpen", country: "de" }];
  const result = matchFrames(a, b);
  assert.equal(result.m11, 1);
});

test("matchFrames flags many-to-one ambiguous matches", () => {
  // B keeps two distinct entities (distinct domains) that collapse to the
  // same normalised name+country key; A carries only that key.
  const a = [{ name: "Muster Pumpen GmbH", country: "DE" }];
  const b = [
    { name: "Muster Pumpen", country: "DE", domain: "muster-pumpen.de" },
    { name: "Muster Pumpen GmbH", country: "DE", domain: "muster-pumpen-holding.de" },
  ];
  const result = matchFrames(a, b);
  assert.equal(result.n2, 2);
  assert.equal(result.m11, 1);
  assert.equal(result.ambiguousMatches, 1);
});

test("chapman matches the textbook small-sample formula", () => {
  const result = chapman(100, 100, 20);
  assert.ok(Math.abs(result.nHat - 484.7619) < 0.001);
  assert.ok(Math.abs(result.se - 82.031) < 0.01);
  assert.ok(result.ci95[0] >= 180);
  assert.ok(result.ci95[1] > result.nHat);
  assert.ok(Math.abs(result.cvApprox - 1 / Math.sqrt(20)) < 1e-12);
});

test("chapman returns null without recapture and rejects impossible counts", () => {
  assert.equal(chapman(10, 10, 0), null);
  assert.equal(chapman(0, 10, 0), null);
  assert.throws(() => chapman(5, 10, 6), /cannot exceed/);
});

test("lincolnPetersen is the uncorrected estimator", () => {
  assert.equal(lincolnPetersen(100, 100, 20), 500);
  assert.equal(lincolnPetersen(100, 100, 0), null);
});

test("diagnostics blocks estimation below m11=5 and warns below 25", () => {
  const blocked = diagnostics({ n1: 100, n2: 100, m11: 4 });
  assert.ok(blocked.some((gate) => gate.code === "M11_TOO_SMALL" && !gate.ok));
  const warned = diagnostics({ n1: 100, n2: 100, m11: 10 });
  assert.ok(warned.some((gate) => gate.code === "M11_LOW_RECAPTURE" && !gate.ok));
  const ok = diagnostics({ n1: 100, n2: 100, m11: 30 });
  assert.ok(ok.some((gate) => gate.code === "M11_OK" && gate.ok));
});

test("estimateTwoFrames end-to-end: reportable estimate with coverage", () => {
  const a = Array.from({ length: 100 }, (_, index) => ({ domain: `a${index}.de` }));
  const b = Array.from({ length: 100 }, (_, index) => ({ domain: `a${index + 80}.de` }));
  const result = estimateTwoFrames(a, b);
  assert.equal(result.counts.n1, 100);
  assert.equal(result.counts.n2, 100);
  assert.equal(result.counts.m11, 20);
  assert.equal(result.reportable, true);
  assert.ok(result.estimate);
  assert.ok(result.coverage > 0 && result.coverage < 1);
  // m11 = 20 sits in the 5–24 band: reportable, but CV ≈ 22% is a warning.
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].code, "M11_LOW_RECAPTURE");
});

test("estimateTwoFrames withholds N̂ when m11 < 5", () => {
  const a = Array.from({ length: 10 }, (_, index) => ({ domain: `a${index}.de` }));
  const b = Array.from({ length: 10 }, (_, index) => ({ domain: `a${index + 9}.de` }));
  const result = estimateTwoFrames(a, b);
  assert.equal(result.counts.m11, 1);
  assert.equal(result.reportable, false);
  assert.equal(result.estimate, null);
  assert.equal(result.coverage, null);
});

test("readFrame + estimate work from real CSV files", () => {
  const directory = mkdtempSync(join(tmpdir(), "cr-scaffold-"));
  try {
    const frameA = join(directory, "a.csv");
    const frameB = join(directory, "b.csv");
    writeFileSync(
      frameA,
      "name,country,domain\nMuster Pumpen GmbH,DE,muster-pumpen.de\nBeispiel Handel GmbH,DE,beispiel-handel.de\n",
    );
    writeFileSync(
      frameB,
      "name,country,domain\nMuster Pumpen,DE,www.muster-pumpen.de\nAndere Firma AG,DE,andere-firma.de\n",
    );
    const a = readFrame(frameA);
    const b = readFrame(frameB);
    assert.equal(a.records.length, 2);
    const result = estimateTwoFrames(a.records, b.records);
    assert.equal(result.counts.m11, 1);
    assert.equal(result.reportable, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readFrame rejects CSVs without recognised columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "cr-scaffold-"));
  try {
    const path = join(directory, "bad.csv");
    writeFileSync(path, "foo,bar\n1,2\n");
    assert.throws(() => readFrame(path), /no recognised columns/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── multi-frame (log-linear) ────────────────────────────────────────────────

function simulateFrames(probabilities, population, rng) {
  const frames = probabilities.map((_, index) => ({ label: `F${index + 1}`, records: [] }));
  for (let entity = 0; entity < population; entity += 1) {
    probabilities.forEach((probability, frameIndex) => {
      if (rng() < probability) frames[frameIndex].records.push({ domain: `sim-${entity}.de` });
    });
  }
  return frames;
}

test("buildCaptureMatrix merges records by key and tracks patterns", () => {
  const frames = [
    { label: "A", records: [{ domain: "one.de" }, { domain: "two.de" }] },
    { label: "B", records: [{ domain: "two.de" }, { domain: "three.de" }] },
    { label: "C", records: [{ domain: "one.de" }, { domain: "three.de" }] },
  ];
  const matrix = buildCaptureMatrix(frames);
  assert.equal(matrix.k, 3);
  assert.equal(matrix.observed, 3);
  assert.deepEqual(matrix.nPerFrame, [2, 2, 2]);
  assert.equal(matrix.patterns.get(0b101), 1); // one.de in A and C
  assert.equal(matrix.patterns.get(0b011), 1); // two.de in A and B
  assert.equal(matrix.patterns.get(0b110), 1); // three.de in B and C
  const pairs = pairRecaptures(matrix.patterns, 3);
  assert.deepEqual(pairs.map((pair) => pair.count), [1, 1, 1]);
});

test("buildCaptureMatrix counts duplicates and keyless rows per frame", () => {
  const frames = [
    { label: "A", records: [{ domain: "dup.de" }, { domain: "dup.de" }, { name: "" }] },
    { label: "B", records: [{ domain: "dup.de" }] },
    { label: "C", records: [{ domain: "dup.de" }] },
  ];
  const matrix = buildCaptureMatrix(frames);
  assert.equal(matrix.duplicates[0], 1);
  assert.equal(matrix.keyless[0], 1);
  assert.equal(matrix.observed, 1);
});

test("candidateModels lists 8 models and only the saturated one has df=0", () => {
  const models = candidateModels(3);
  assert.equal(models.length, 8);
  const patterns = new Map([
    [0b001, 10],
    [0b010, 8],
    [0b011, 4],
    [0b100, 6],
    [0b101, 3],
    [0b110, 2],
    [0b111, 1],
  ]);
  for (const model of models) {
    const fit = fitLogLinear(patterns, 3, model.terms);
    assert.equal(fit.df, model.name === "saturated" ? 0 : fit.df);
    assert.ok(fit.g2 >= 0);
    if (model.name !== "saturated") assert.ok(fit.df > 0);
  }
});

test("log-linear recovers a known population under independence (seeded)", () => {
  const rng = createRng("recovery-test", "simulate");
  const frames = simulateFrames([0.5, 0.4, 0.3], 20000, rng);
  const result = estimateMultiFrame(frames, { bootstrap: 200, seed: "recovery-test" });
  assert.equal(result.reportable, true);
  // AIC may pick a pairwise-interaction model on sampling noise; what must hold
  // is that the estimate and its bootstrap interval recover the true N.
  assert.notEqual(result.chosen.name, "saturated");
  assert.ok(Math.abs(result.nHat - 20000) / 20000 < 0.08, `N̂=${result.nHat} too far from 20000`);
  assert.ok(
    result.bootstrap.ci95[0] <= 20000 && 20000 <= result.bootstrap.ci95[1],
    `95% CI [${result.bootstrap.ci95}] misses the true population 20000`,
  );
  assert.ok(result.coverage > 0 && result.coverage < 1);
  assert.ok(result.modelSpread < 0.3);
});

test("bootstrap intervals are deterministic for a fixed seed", () => {
  const rng = createRng("determinism", "simulate");
  const frames = simulateFrames([0.5, 0.4, 0.3], 5000, rng);
  const first = estimateMultiFrame(frames, { bootstrap: 100, seed: "fixed" });
  const second = estimateMultiFrame(frames, { bootstrap: 100, seed: "fixed" });
  assert.deepEqual(first.bootstrap.ci95, second.bootstrap.ci95);
  assert.equal(first.nHat, second.nHat);
});

test("thin pairwise overlap blocks the estimate", () => {
  const frames = [
    { label: "A", records: Array.from({ length: 20 }, (_, i) => ({ domain: `a-${i}.de` })) },
    { label: "B", records: Array.from({ length: 20 }, (_, i) => ({ domain: `b-${i}.de` })) },
    {
      label: "C",
      records: [
        { domain: "a-0.de" },
        { domain: "b-0.de" },
        { domain: "c-0.de" },
      ],
    },
  ];
  const result = estimateMultiFrame(frames, { bootstrap: 50, seed: "thin" });
  assert.equal(result.reportable, false);
  assert.ok(result.diagnostics.some((gate) => gate.code === "PAIR_TOO_SMALL"));
  assert.equal(result.nHat, null);
});

test("estimateMultiFrame requires at least three frames", () => {
  const frames = [
    { label: "A", records: [{ domain: "a.de" }] },
    { label: "B", records: [{ domain: "a.de" }] },
  ];
  assert.throws(() => estimateMultiFrame(frames), /at least 3 frames/);
});
