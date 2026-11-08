// Unit tests for the two-frame capture-recapture scaffold (node:test only).
//
// Run: node --test scripts/metrics/
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  chapman,
  dedupeFrame,
  diagnostics,
  entityKeys,
  estimateTwoFrames,
  lincolnPetersen,
  matchFrames,
  normalizeCountry,
  normalizeDomain,
  normalizeName,
  parseCsv,
  readFrame,
} from "./capture-recapture.mjs";

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
