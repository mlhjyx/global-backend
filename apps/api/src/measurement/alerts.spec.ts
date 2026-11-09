import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AlertSample,
  FreshnessAlertRule,
  ThresholdAlertRule,
  assertAlertRules,
  evaluateAlerts,
  evaluateFreshnessRule,
  evaluateThresholdRule,
  stratumMatches,
  summarizeAlertEvaluations,
} from "./alerts";

const RULES_PATH = fileURLToPath(
  new URL("../../../../docs/metrics/alerts/rules.v1.json", import.meta.url),
);
const DICTIONARY_DIR = fileURLToPath(
  new URL("../../../../docs/metrics/dictionary/", import.meta.url),
);

const thresholdRule: ThresholdAlertRule = {
  id: "AL-900",
  metricId: "T2-001",
  severity: "CRITICAL",
  kind: "threshold",
  owner: "data-eng",
  description: "test threshold rule",
  comparison: "below",
  bound: 0.3,
  granularity: "daily",
  aggregation: "latest",
  stratumEquals: { workspace_id: "ALL", country: "ALL" },
};

function sample(overrides: Partial<AlertSample> = {}): AlertSample {
  return {
    metricId: "T2-001",
    metricVersion: 1,
    stratum: { workspace_id: "ALL", country: "ALL" },
    bucket: "2026-11-08",
    value: 0.5,
    denominator: 400,
    granularity: "daily",
    ...overrides,
  };
}

describe("assertAlertRules", () => {
  it("accepts the checked-in rules file", () => {
    const rules = assertAlertRules(JSON.parse(readFileSync(RULES_PATH, "utf8")));
    expect(rules.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rules.map((rule) => rule.kind))).toEqual(
      new Set(["threshold", "freshness"]),
    );
  });

  it("rejects broken documents", () => {
    expect(() => assertAlertRules({ schemaVersion: "nope", rules: [] })).toThrow(
      /ALERT_RULES_INVALID/,
    );
    expect(() =>
      assertAlertRules({
        schemaVersion: "measurement-alerts/v1",
        rules: [{ ...thresholdRule, comparison: "under" }],
      }),
    ).toThrow(/ALERT_RULES_INVALID/);
    expect(() =>
      assertAlertRules({
        schemaVersion: "measurement-alerts/v1",
        rules: [{ ...thresholdRule, stratumEquals: undefined }],
      }),
    ).toThrow(/ALERT_RULES_INVALID/);
  });

  it("every checked-in rule names a metric that exists in the dictionary", () => {
    const ids = new Set<string>();
    for (const name of readdirSync(DICTIONARY_DIR).filter((file) => file.endsWith(".json"))) {
      const document = JSON.parse(readFileSync(DICTIONARY_DIR + name, "utf8")) as {
        metrics: { id: string }[];
      };
      for (const metric of document.metrics) ids.add(metric.id);
    }
    const rules = assertAlertRules(JSON.parse(readFileSync(RULES_PATH, "utf8")));
    for (const rule of rules) expect(ids.has(rule.metricId), rule.id).toBe(true);
  });
});

describe("evaluateThresholdRule", () => {
  const asOf = new Date("2026-11-09T02:00:00Z");

  it("fires below the bound on the newest bucket", () => {
    const evaluation = evaluateThresholdRule(thresholdRule, [sample({ value: 0.2 })], asOf);
    expect(evaluation.status).toBe("FIRING");
    expect(evaluation.bucket).toBe("2026-11-08");
    expect(evaluation.observedValue).toBe(0.2);
  });

  it("treats equality as OK (strict comparison) and above as OK for below-rules", () => {
    expect(evaluateThresholdRule(thresholdRule, [sample({ value: 0.3 })], asOf).status).toBe("OK");
    expect(evaluateThresholdRule(thresholdRule, [sample({ value: 0.9 })], asOf).status).toBe("OK");
  });

  it("ignores other strata, future buckets and lower metric versions in the same bucket", () => {
    const evaluation = evaluateThresholdRule(
      thresholdRule,
      [
        sample({ value: 0.01, stratum: { workspace_id: "workspace-1", country: "DE" } }),
        sample({ value: 0.01, bucket: "2026-11-10" }),
        sample({ value: 0.4, bucket: "2026-11-08" }),
        sample({ value: 0.05, metricVersion: 2, bucket: "2026-11-08" }),
      ],
      asOf,
    );
    expect(evaluation.status).toBe("FIRING");
    expect(evaluation.observedValue).toBe(0.05);
    expect(evaluation.bucket).toBe("2026-11-08");
  });

  it("averages the newest observed buckets for mean aggregation", () => {
    const meanRule: ThresholdAlertRule = {
      ...thresholdRule,
      aggregation: "mean",
      lookbackBuckets: 3,
    };
    const evaluation = evaluateThresholdRule(
      meanRule,
      [
        sample({ bucket: "2026-11-08", value: 0.2 }),
        sample({ bucket: "2026-11-07", value: 0.4 }),
        sample({ bucket: "2026-11-04", value: 0.6 }),
        sample({ bucket: "2026-11-01", value: 0.9 }),
      ],
      asOf,
    );
    expect(evaluation.status).toBe("OK");
    expect(evaluation.observedValue).toBeCloseTo(0.4, 6);
    expect(evaluation.buckets).toEqual(["2026-11-04", "2026-11-07", "2026-11-08"]);
  });

  it("reports INSUFFICIENT_DATA when the denominator is below minSample", () => {
    const evaluation = evaluateThresholdRule(
      { ...thresholdRule, minSample: 100 },
      [sample({ value: 0.01, denominator: 10 })],
      asOf,
    );
    expect(evaluation.status).toBe("INSUFFICIENT_DATA");
  });

  it("reports NO_DATA when no bucket matches the stratum", () => {
    const evaluation = evaluateThresholdRule(
      thresholdRule,
      [sample({ stratum: { workspace_id: "workspace-1", country: "DE" } })],
      asOf,
    );
    expect(evaluation.status).toBe("NO_DATA");
  });
});

describe("evaluateFreshnessRule", () => {
  const asOf = new Date("2026-11-09T12:00:00Z");
  const rule: FreshnessAlertRule = {
    id: "AL-901",
    metricId: "T0-001",
    severity: "WARNING",
    kind: "freshness",
    owner: "data-eng",
    description: "test freshness rule",
    source: "observation",
    maxAgeHours: 36,
  };

  it("fires when the newest data is older than maxAgeHours", () => {
    const evaluation = evaluateFreshnessRule(rule, new Date("2026-11-07T20:00:00Z"), asOf);
    expect(evaluation.status).toBe("FIRING");
    expect(evaluation.ageHours).toBeGreaterThan(36);
  });

  it("is OK when data is fresh and NO_DATA when nothing exists", () => {
    expect(evaluateFreshnessRule(rule, new Date("2026-11-09T10:00:00Z"), asOf).status).toBe("OK");
    expect(evaluateFreshnessRule(rule, null, asOf).status).toBe("NO_DATA");
  });
});

describe("evaluateAlerts / summarizeAlertEvaluations", () => {
  const asOf = new Date("2026-11-09T02:00:00Z");

  it("routes both rule kinds and computes the worst severity exit code", () => {
    const rules = assertAlertRules(JSON.parse(readFileSync(RULES_PATH, "utf8")));
    const evaluations = evaluateAlerts(
      rules,
      {
        thresholdSamples: [
          sample({ value: 0.01 }),
          sample({
            metricId: "T1-008",
            stratum: { provider_key: "public_web" },
            value: 0.01,
            denominator: 200,
          }),
        ],
        observationLatest: new Map([["T0-001", new Date("2026-11-08T23:59:59Z")]]),
        rollupLatest: new Map([["weekly:T2-001", new Date("2026-11-03T00:00:00Z")]]),
      },
      asOf,
    );
    expect(evaluations).toHaveLength(rules.length);
    const summary = summarizeAlertEvaluations(evaluations);
    expect(summary.firing).toBeGreaterThan(0);
    expect(summary.exitCode).toBe(20);
  });

  it("returns exit 0 with NO_DATA everywhere when there is no data", () => {
    const rules = assertAlertRules(JSON.parse(readFileSync(RULES_PATH, "utf8")));
    const evaluations = evaluateAlerts(
      rules,
      { thresholdSamples: [], observationLatest: new Map(), rollupLatest: new Map() },
      asOf,
    );
    expect(evaluations.every((evaluation) => evaluation.status === "NO_DATA")).toBe(true);
    const summary = summarizeAlertEvaluations(evaluations);
    expect(summary.exitCode).toBe(0);
    expect(summary.worstSeverity).toBeNull();
  });
});

describe("stratumMatches", () => {
  it("requires every expected key to match by string equality", () => {
    expect(stratumMatches({ workspace_id: "ALL", n: 1 }, { workspace_id: "ALL", n: "1" })).toBe(true);
    expect(stratumMatches({ workspace_id: "ALL" }, { workspace_id: "ALL", country: "ALL" })).toBe(false);
    expect(stratumMatches({ workspace_id: "ALL" }, { workspace_id: "X" })).toBe(false);
  });
});
