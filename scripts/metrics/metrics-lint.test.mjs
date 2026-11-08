// Unit tests for the metric dictionary linter (node:test only).
import assert from "node:assert/strict";
import test from "node:test";

import { lintDictionary, loadDictionaryDirectory, validateMetric } from "./metrics-lint.mjs";

const { sources, files } = loadDictionaryDirectory();
const registry = {
  all: new Set(Object.values(sources.sources).flat()),
  level: new Map(Object.entries(sources.sources).flatMap(([level, names]) => names.map((name) => [name, level]))),
};

function validMetric(overrides = {}) {
  return {
    schemaVersion: "metric-definition/v1",
    id: "T2-999",
    name: "test_metric",
    tier: "T2",
    unit: "ratio",
    owner: "data-eng",
    status: "ACTIVE",
    version: 1,
    effectiveFrom: "2026-11-09",
    exprStatus: "PENDING",
    definition: "A sufficiently long test definition.",
    numerator: { expr: "count(*) filter (where x)", source: "contact_point" },
    denominator: { expr: "count(*)", source: "lead" },
    exclusions: ["none"],
    window: { type: "rolling", days: 30 },
    strata: ["country"],
    ci: { method: "wilson" },
    changelog: [{ version: 1, at: "2026-11-09", breaking: false, note: "first" }],
    ...overrides,
  };
}

function codesFor(metric, fileTier = "T2") {
  return validateMetric(metric, { fileTier, registry }).map((item) => item.code);
}

test("the checked-in dictionary passes with 44 metrics", () => {
  const { issues, summary } = lintDictionary(files, { sources });
  assert.deepEqual(issues, []);
  assert.equal(summary.metrics, 44);
  assert.equal(summary.files, 6);
  assert.equal(summary.byTier.T0, 2);
  assert.equal(summary.byTier.GUARDRAIL, 10);
});

test("exprStatus is required and must be CHECKED or PENDING", () => {
  assert.ok(codesFor(validMetric({ exprStatus: "DONE" })).includes("EXPR_STATUS_INVALID"));
  assert.ok(codesFor(validMetric({ exprStatus: undefined })).includes("EXPR_STATUS_INVALID"));
  assert.equal(codesFor(validMetric({ exprStatus: "CHECKED" })).length, 0);
});

test("unknown fields are rejected (typo guard)", () => {
  assert.ok(codesFor(validMetric({ numerator_source: "x" })).includes("UNKNOWN_FIELD"));
});

test("id and tier rules catch prefix/file mismatches", () => {
  assert.ok(codesFor(validMetric({ id: "T9-001" })).includes("ID_INVALID"));
  assert.ok(codesFor(validMetric({ id: "G-001" })).includes("TIER_PREFIX_MISMATCH"));
  assert.ok(codesFor(validMetric(), "T1").includes("TIER_FILE_MISMATCH"));
  assert.ok(codesFor(validMetric({ name: "Bad Name" })).includes("NAME_INVALID"));
});

test("sources must be registered and ACTIVE may only use existing ones", () => {
  assert.ok(
    codesFor(validMetric({ numerator: { expr: "x", source: "not_a_table" } })).includes("SOURCE_UNKNOWN"),
  );
  assert.ok(
    codesFor(validMetric({ numerator: { expr: "x", source: "outreach_send" } })).includes(
      "ACTIVE_SOURCE_NOT_EXISTING",
    ),
  );
  assert.equal(
    codesFor(validMetric({ status: "DRAFT", numerator: { expr: "x", source: "outreach_send" } })).filter((code) =>
      code.includes("SOURCE"),
    ).length,
    0,
  );
});

test("ratio metrics need a denominator and a CI method", () => {
  assert.ok(codesFor(validMetric({ denominator: null })).includes("DENOMINATOR_MISSING"));
  assert.ok(codesFor(validMetric({ ci: { method: "none" } })).includes("CI_INVALID"));
  assert.equal(codesFor(validMetric({ tier: "GUARDRAIL", id: "G-999", ci: { method: "none" } }), "GUARDRAIL").length, 0);
});

test("window, strata and ci vocabularies are closed", () => {
  assert.ok(codesFor(validMetric({ window: { type: "rolling" } })).includes("WINDOW_INVALID"));
  assert.ok(codesFor(validMetric({ window: { type: "snapshot" } })).includes("WINDOW_INVALID"));
  assert.ok(codesFor(validMetric({ strata: ["planet"] })).includes("STRATA_INVALID"));
  assert.ok(codesFor(validMetric({ ci: { method: "t-test" } })).includes("CI_INVALID"));
});

test("changelog must run 1..version without gaps and end at version", () => {
  assert.ok(
    codesFor(validMetric({ version: 3, changelog: [{ version: 1, at: "2026-11-09", breaking: false, note: "a" }] })).includes(
      "CHANGELOG_LATEST_MISMATCH",
    ),
  );
  assert.ok(
    codesFor(
      validMetric({
        version: 3,
        changelog: [
          { version: 1, at: "2026-11-09", breaking: false, note: "a" },
          { version: 3, at: "2026-11-09", breaking: false, note: "c" },
        ],
      }),
    ).includes("CHANGELOG_VERSION_GAP"),
  );
  assert.ok(codesFor(validMetric({ changelog: [] })).includes("CHANGELOG_MISSING"));
  assert.ok(
    codesFor(validMetric({ changelog: [{ version: 1, at: "2026-13-40", breaking: false, note: "a" }] })).includes(
      "CHANGELOG_DATE_INVALID",
    ),
  );
});

test("cross-file duplicate ids are rejected", () => {
  const first = { path: "a.json", document: { schemaVersion: "metric-dictionary/v1", tier: "T2", metrics: [validMetric()] } };
  const second = {
    path: "b.json",
    document: { schemaVersion: "metric-dictionary/v1", tier: "T2", metrics: [validMetric({ name: "other_name" })] },
  };
  const { issues } = lintDictionary([first, second], { sources });
  assert.ok(issues.some((item) => item.code === "ID_DUPLICATE"));
});

test("a mutated checked-in file fails the lint (gate must bite)", () => {
  const mutated = files.map((file) => ({ ...file, document: structuredClone(file.document) }));
  mutated[0].document.metrics[0].version = 2;
  const { issues } = lintDictionary(mutated, { sources });
  assert.ok(issues.length > 0);
  assert.ok(issues.some((item) => item.code === "CHANGELOG_LATEST_MISMATCH"));
});
