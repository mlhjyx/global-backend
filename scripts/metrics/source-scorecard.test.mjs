// Unit tests for the offline source scorecard (node:test only, no database).
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateScorecard, loadRejectReasons } from "./source-scorecard.mjs";

const REASONS = loadRejectReasons();

function rawRow(provider, sourceClass, status, code, n, { cost = 0, lastSeen = "2026-11-08T00:00:00Z" } = {}) {
  return {
    provider_key: provider,
    source_class: sourceClass,
    ingest_status: status,
    disposition_code: code,
    n: String(n),
    cost_cents: String(cost),
    last_seen: lastSeen,
  };
}

const RAW_ROWS = [
  rawRow("directory", "industry_data", "ACCEPTED", "", 1158),
  rawRow("directory", "industry_data", "REJECTED", "PROVIDER_PAYLOAD_SCHEMA_INVALID", 2290),
  rawRow("directory", "industry_data", "QUARANTINED", "SOURCE_POLICY_MISSING", 868),
  rawRow("directory", "industry_data", "QUARANTINED", "PROCESSING_KEY_DRIFT", 108),
  rawRow("public_web", "public_intelligence", "ACCEPTED", "", 3015),
  rawRow("public_web", "industry_data", "ACCEPTED", "", 270, { cost: 120 }),
];

const COMPANY_ROWS = [
  { provider: "directory", companies: "556", unique_companies: "556", domain_resolved: "0" },
  { provider: "public_web", companies: "1622", unique_companies: "1600", domain_resolved: "1622" },
];

const AS_OF = "2026-11-09T00:00:00Z";

test("scorecard aggregates per provider with accept/reject rates", () => {
  const result = aggregateScorecard({
    rawRows: RAW_ROWS,
    companyRows: COMPANY_ROWS,
    rejectReasons: REASONS,
    windowDays: 30,
    asOf: AS_OF,
  });
  assert.equal(result.providers.length, 2);
  const directory = result.providers.find((row) => row.providerKey === "directory");
  assert.equal(directory.rawRecords, 4424);
  assert.equal(directory.acceptedRecords, 1158);
  assert.equal(directory.rejectedRecords, 2290);
  assert.equal(directory.quarantinedRecords, 976);
  assert.ok(Math.abs(directory.acceptRate - 1158 / 4424) < 1e-12);
  assert.ok(Math.abs(directory.rejectRate - 2290 / 4424) < 1e-12);
  assert.equal(directory.companiesCreated, 556);
  assert.equal(directory.uniqueContribution, 556);
  assert.equal(directory.domainResolved, 0);
});

test("the directory reject share splits into reason codes (74% claim)", () => {
  const result = aggregateScorecard({
    rawRows: RAW_ROWS,
    companyRows: COMPANY_ROWS,
    rejectReasons: REASONS,
    windowDays: 30,
    asOf: AS_OF,
  });
  const directory = result.providers.find((row) => row.providerKey === "directory");
  const flagged = directory.rejectedRecords + directory.quarantinedRecords;
  assert.ok(Math.abs(flagged / directory.rawRecords - 0.7383) < 0.001);
  assert.ok(Math.abs(directory.rejectReasonsShare.PROVIDER_PAYLOAD_SCHEMA_INVALID - 2290 / flagged) < 1e-12);
  assert.ok(Math.abs(directory.rejectReasonsShare.SOURCE_POLICY_MISSING - 868 / flagged) < 1e-12);
  assert.deepEqual(directory.unknownRejectCodes, []);
});

test("unknown disposition codes become a drift signal", () => {
  const result = aggregateScorecard({
    rawRows: [
      rawRow("mystery", "public_intelligence", "REJECTED", "SOMETHING_NEW", 5),
      rawRow("mystery", "public_intelligence", "ACCEPTED", "", 5),
    ],
    companyRows: [],
    rejectReasons: REASONS,
    windowDays: 7,
    asOf: AS_OF,
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "UNKNOWN_DISPOSITION_CODE");
  assert.deepEqual(result.providers[0].unknownRejectCodes, ["SOMETHING_NEW"]);
});

test("mixed source classes are reported, dominant class wins", () => {
  const result = aggregateScorecard({
    rawRows: RAW_ROWS,
    companyRows: COMPANY_ROWS,
    rejectReasons: REASONS,
    windowDays: 30,
    asOf: AS_OF,
  });
  const publicWeb = result.providers.find((row) => row.providerKey === "public_web");
  assert.equal(publicWeb.sourceClass, "public_intelligence");
  assert.deepEqual(publicWeb.mixedSourceClass, ["industry_data", "public_intelligence"]);
});

test("freshness days and cost are computed; content hash is idempotent", () => {
  const build = () =>
    aggregateScorecard({
      rawRows: RAW_ROWS,
      companyRows: COMPANY_ROWS,
      rejectReasons: REASONS,
      windowDays: 30,
      asOf: AS_OF,
    });
  const first = build();
  const second = build();
  assert.deepEqual(first.providers, second.providers); // same inputs -> same hashes
  const directory = first.providers.find((row) => row.providerKey === "directory");
  assert.equal(directory.freshnessDays, 1);
  assert.equal(directory.costCents, 0);
  assert.equal(directory.costPerValidContact, null);
  const publicWeb = first.providers.find((row) => row.providerKey === "public_web");
  assert.equal(publicWeb.costCents, 120);
  assert.match(directory.contentHash, /^[0-9a-f]{64}$/);
});

test("empty providers and providers without attribution degrade gracefully", () => {
  const result = aggregateScorecard({
    rawRows: [rawRow("brand_new", "public_intelligence", "ACCEPTED", "", 3)],
    companyRows: [],
    rejectReasons: REASONS,
    windowDays: 7,
    asOf: AS_OF,
  });
  const row = result.providers[0];
  assert.equal(row.companiesCreated, 0);
  assert.equal(row.uniqueContribution, 0);
  assert.equal(row.rejectReasonsShare && Object.keys(row.rejectReasonsShare).length, 0);
  const empty = aggregateScorecard({ rawRows: [], companyRows: [], rejectReasons: REASONS, windowDays: 7, asOf: AS_OF });
  assert.deepEqual(empty.providers, []);
  assert.deepEqual(empty.issues, []);
});
