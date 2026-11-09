// Unit tests for the weekly/monthly report renderer (node:test only).
import assert from "node:assert/strict";
import test from "node:test";

import { aggregateRow, buildReport, indexObservations, isoWeekLabel, renderMarkdown } from "./report.mjs";

function observation(metricId, dim, numerator, denominator, { value = null, ci = null, status = "OK" } = {}) {
  return {
    schemaVersion: "metric-observation/v1",
    metricId,
    metricVersion: 1,
    stratum: dim === "ALL" ? { country: "ALL" } : { country: dim },
    window: { type: "snapshot", cadence: "weekly" },
    numerator,
    denominator,
    value: value ?? (denominator > 0 ? numerator / denominator : null),
    ci,
    status,
    computedAt: "2026-11-09T00:00:00Z",
    computationHash: "0".repeat(64),
  };
}

const SNAPSHOT = {
  generatedAt: "2026-11-09T00:00:00Z",
  observations: [
    observation("T0-001", "ALL", 0, 403, { ci: { low: 0, high: 0.009, method: "wilson" } }),
    observation("T0-002", "ALL", 0, 403, { ci: { low: 0, high: 0.009, method: "wilson" } }),
    observation("T2-001", "ALL", 73, 403, { ci: { low: 0.147, high: 0.222, method: "wilson" } }),
    observation("T2-001", "DE", 43, 173),
    observation("T2-001", "AT", 5, 14),
    observation("T2-005", "ALL", 4, 403),
    observation("T2-008", "ALL", 375, 403, { ci: { low: 0.81, high: 1.07, method: "bootstrap" } }),
    observation("T1-008", "ALL", 4485, 8148),
    observation("T1-008", "public_web", 3015, 3306),
    observation("T1-008", "directory", 1158, 4424),
    observation("T1-008", "ted", 25, 95),
    observation("T1-009", "ALL", 3663, 3663),
    observation("T1-009", "PROVIDER_PAYLOAD_SCHEMA_INVALID", 2408, 3663),
    observation("T1-009", "SOURCE_POLICY_MISSING", 868, 3663),
    observation("T1-009", "PROCESSING_KEY_DRIFT", 387, 3663),
  ],
  skipped: [
    { metricId: "T2-002", reason: "NO_ADJUDICATED_VERDICTS", detail: "0 条邮箱级裁决" },
    { metricId: "T2-003", reason: "NO_ADJUDICATED_VERDICTS", detail: "无 catch-all 判定" },
    { metricId: "T2-004", reason: "NO_ADJUDICATED_VERDICTS", detail: "无裁决" },
    { metricId: "T2-009", reason: "EMPTY_DENOMINATOR", detail: "VALID=0" },
  ],
};

test("isoWeekLabel produces ISO week labels", () => {
  assert.equal(isoWeekLabel(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(isoWeekLabel(new Date("2026-11-09T00:00:00Z")), "2026-W46");
});

test("aggregateRow prefers the ALL stratum", () => {
  const rows = [observation("T2-001", "DE", 43, 173), observation("T2-001", "ALL", 73, 403)];
  assert.equal(aggregateRow(rows).denominator, 403);
});

test("weekly report renders north star, reachability and sources", () => {
  const report = buildReport({
    observations: indexObservations([SNAPSHOT]),
    skipped: SNAPSHOT.skipped,
    kind: "weekly",
    period: "2026-W46",
    generatedAt: "2026-11-09T00:00:00Z",
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /VRIC_1000_STRICT = 0\.0/);
  assert.match(markdown, /分子 0 \/ 账户 403/);
  assert.match(markdown, /email 覆盖率（match 账户，任意状态） = 18\.1%/);
  assert.match(markdown, /73\/403/);
  assert.match(markdown, /email VALID 率（已尝试验证）：不可测（NO_ADJUDICATED_VERDICTS/);
  assert.match(markdown, /源接受率最好：public_web 91\.2%/);
  assert.match(markdown, /拒收原因 Top3：PROVIDER_PAYLOAD_SCHEMA_INVALID 65\.7%/);
  assert.match(markdown, /召回率 company_recall_vs_frame：未测/);
  assert.doesNotMatch(markdown, /成本对账/);
});

test("small denominators are flagged as 样本不足", () => {
  const report = buildReport({
    observations: indexObservations([
      { observations: [observation("T2-005", "ALL", 1, 12)] },
    ]),
    kind: "weekly",
    period: "2026-W46",
    generatedAt: "2026-11-09T00:00:00Z",
  });
  assert.match(renderMarkdown(report), /样本不足 n<30/);
});

test("monthly reports add recall/golden and cost sections", () => {
  const report = buildReport({
    observations: indexObservations([SNAPSHOT]),
    skipped: SNAPSHOT.skipped,
    kind: "monthly",
    period: "2026-11",
    generatedAt: "2026-11-09T00:00:00Z",
  });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /## 6\. 召回与金标（月度）/);
  assert.match(markdown, /## 7\. 成本对账（月度）/);
  assert.match(markdown, /cost_per_valid_contact：无分母/);
});

test("missing metrics are listed instead of being faked", () => {
  const report = buildReport({ observations: indexObservations([{ observations: [] }]), kind: "weekly", period: "2026-W46", generatedAt: "2026-11-09T00:00:00Z" });
  const markdown = renderMarkdown(report);
  assert.match(markdown, /VRIC_1000_STRICT：未接线/);
  assert.match(markdown, /缺失观测/);
  assert.ok(report.missingMetrics.includes("T0-001"));
  assert.doesNotMatch(markdown, /= 0\.0%/);
});

test("the rendered report is deterministic for fixed inputs", () => {
  const build = () =>
    buildReport({
      observations: indexObservations([SNAPSHOT]),
      skipped: SNAPSHOT.skipped,
      kind: "weekly",
      period: "2026-W46",
      generatedAt: "2026-11-09T00:00:00Z",
    });
  assert.equal(renderMarkdown(build()), renderMarkdown(build()));
});
