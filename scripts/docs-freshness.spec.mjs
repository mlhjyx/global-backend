import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ageInDays, freshnessVerdict, parseLastVerified } from "./docs-freshness.mjs";

const NOW = new Date("2026-11-04T12:00:00Z");

describe("docs freshness", () => {
  it("parses the 最后核验 date, with or without backticks and trailing text", () => {
    assert.equal(parseLastVerified("> 最后核验：2026-11-03T03:35Z（来源）"), "2026-11-03");
    assert.equal(parseLastVerified("> 最后核验: `2026-08-07`"), "2026-08-07");
    assert.equal(parseLastVerified("> 最后核验：origin/main@abc"), null);
    assert.equal(parseLastVerified("no metadata"), null);
  });

  it("computes age in whole UTC days", () => {
    assert.equal(ageInDays("2026-11-04", NOW), 0);
    assert.equal(ageInDays("2026-11-03", NOW), 1);
    assert.equal(ageInDays("2026-08-07", NOW), 89);
    assert.equal(ageInDays("not-a-date", NOW), null);
  });

  it("returns ok within the limit and stale beyond it", () => {
    assert.deepEqual(
      freshnessVerdict({ text: "> 最后核验：2026-11-01", now: NOW, maxAgeDays: 90 }),
      { status: "ok", code: null, date: "2026-11-01", ageDays: 3 },
    );
    const stale = freshnessVerdict({ text: "> 最后核验：2026-08-01", now: NOW, maxAgeDays: 90 });
    assert.equal(stale.status, "stale");
    assert.equal(stale.code, "DOC_STALE");
    assert.equal(stale.ageDays, 95);
  });

  it("flags missing and invalid dates instead of passing silently", () => {
    assert.equal(
      freshnessVerdict({ text: "no metadata", now: NOW }).code,
      "DOC_VERIFICATION_MISSING",
    );
  });
});
