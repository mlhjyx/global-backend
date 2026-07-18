import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { getTask } from '../../ai-tasks/task-registry';
import { BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE } from './model-policy.registry';
import { resolveTaskRoute } from './task-routes';

interface EvaluationSummary {
  model: string;
  transport: string;
  runs: number;
  acceptedArtifacts: number;
  hardFailures: number;
  p95LatencyMs: number;
  attemptedTokenTotals: {
    inputTokens: number;
    outputTokens: number;
  };
}

interface EvaluationReport {
  schemaVersion: string;
  generatedAt: string;
  evidenceRole: 'candidate' | 'baseline';
  status: string;
  promotionEligible: boolean;
  fixtureCount: number;
  repeats: number;
  sourceIntegrity: {
    startBundleSha256: string;
    endBundleSha256: string;
    stable: boolean;
    changedPaths: string[];
  };
  matrixIntegrity: {
    expectedRunCount: number;
    actualRunCount: number;
    complete: boolean;
    duplicateKeys: string[];
    missingKeys: string[];
    unexpectedKeys: string[];
  };
  probes: Array<{
    requestedModel: string;
    reportedModel: string;
    resolvedModel: string;
    modelResolutionSource: string;
    accepted: boolean;
  }>;
  runs: Array<{
    requestedModel: string;
    reportedModel: string;
    resolvedModel: string;
    modelResolutionSource: string;
    acceptedArtifact: boolean;
  }>;
  summary: EvaluationSummary[];
}

function artifactBytes(repoRelativePath: string): Buffer {
  return readFileSync(
    new URL(`../../../../../${repoRelativePath}`, import.meta.url),
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseReport(bytes: Buffer): EvaluationReport {
  return JSON.parse(bytes.toString('utf8')) as EvaluationReport;
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (!value || typeof value !== 'object') return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.push(key);
    collectKeys(child, keys);
  }
  return keys;
}

const FORBIDDEN_REPORT_PAYLOAD_KEYS = new Set([
  'apiKey',
  'authorization',
  'credential',
  'content',
  'output',
  'prompt',
  'response',
]);

function forbiddenReportPayloadKeys(value: unknown): string[] {
  return collectKeys(value).filter((key) =>
    FORBIDDEN_REPORT_PAYLOAD_KEYS.has(key),
  );
}

describe('BrandProfile MODEL-1 immutable evidence artifacts', () => {
  it('keeps the exact candidate and current-route report bytes addressable by path + SHA-256', () => {
    const evidence = BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE;
    const candidateBytes = artifactBytes(evidence.reportArtifactPath);
    const baselineBytes = artifactBytes(
      evidence.currentRouteBaseline.reportArtifactPath,
    );

    expect(sha256(candidateBytes)).toBe(evidence.reportSha256);
    expect(sha256(baselineBytes)).toBe(
      evidence.currentRouteBaseline.reportSha256,
    );

    const candidate = parseReport(candidateBytes);
    expect(candidate).toMatchObject({
      schemaVersion: evidence.reportSchemaVersion,
      generatedAt: evidence.evaluatedAt,
      evidenceRole: 'candidate',
      status: 'completed_eligible',
      promotionEligible: true,
      fixtureCount: evidence.fixtureCount,
      repeats: evidence.repeats,
    });
    expect(candidate.runs).toHaveLength(
      evidence.fixtureCount * evidence.repeats * evidence.routes.length,
    );
    for (const route of evidence.routes) {
      expect(candidate.summary).toContainEqual(
        expect.objectContaining({
          model: route.model,
          transport: route.transport,
          runs: route.acceptedArtifacts,
          acceptedArtifacts: route.acceptedArtifacts,
          hardFailures: route.hardFailures,
          p95LatencyMs: route.p95LatencyMs,
          attemptedTokenTotals: {
            inputTokens: route.inputTokens,
            outputTokens: route.outputTokens,
          },
        }),
      );
    }

    const baseline = parseReport(baselineBytes);
    expect(baseline).toMatchObject({
      schemaVersion: evidence.reportSchemaVersion,
      generatedAt: evidence.currentRouteBaseline.evaluatedAt,
      evidenceRole: 'baseline',
      status: 'completed_baseline',
      promotionEligible: false,
      fixtureCount: evidence.fixtureCount,
      repeats: evidence.repeats,
    });
    expect(baseline.runs).toHaveLength(
      evidence.fixtureCount * evidence.repeats,
    );
    expect(baseline.summary).toContainEqual(
      expect.objectContaining({
        model: evidence.currentRouteBaseline.model,
        transport: evidence.currentRouteBaseline.transport,
        runs:
          evidence.currentRouteBaseline.acceptedArtifacts +
          evidence.currentRouteBaseline.hardFailures,
        acceptedArtifacts: evidence.currentRouteBaseline.acceptedArtifacts,
        hardFailures: evidence.currentRouteBaseline.hardFailures,
        p95LatencyMs: evidence.currentRouteBaseline.p95LatencyMs,
        attemptedTokenTotals: {
          inputTokens: evidence.currentRouteBaseline.attemptedInputTokens,
          outputTokens: evidence.currentRouteBaseline.attemptedOutputTokens,
        },
      }),
    );

    expect(candidate.sourceIntegrity).toEqual(baseline.sourceIntegrity);
    expect(candidate.sourceIntegrity).toMatchObject({
      stable: true,
      changedPaths: [],
    });
    expect(candidate.sourceIntegrity.startBundleSha256).toBe(
      candidate.sourceIntegrity.endBundleSha256,
    );
    for (const report of [candidate, baseline]) {
      expect(report.matrixIntegrity).toMatchObject({
        complete: true,
        duplicateKeys: [],
        missingKeys: [],
        unexpectedKeys: [],
      });
      expect(report.matrixIntegrity.actualRunCount).toBe(
        report.matrixIntegrity.expectedRunCount,
      );
      expect(report.probes.every((probe) => probe.accepted)).toBe(true);
      expect(
        report.probes.every(
          (probe) =>
            probe.modelResolutionSource === 'upstream_response' &&
            probe.reportedModel === probe.resolvedModel,
        ),
      ).toBe(true);
      expect(report.runs.every((run) => run.acceptedArtifact)).toBe(true);
      expect(
        report.runs.every(
          (run) =>
            run.modelResolutionSource === 'upstream_response' &&
            run.reportedModel === run.resolvedModel,
        ),
      ).toBe(true);
    }
    expect(
      candidate.runs.every(
        (run) => run.requestedModel === run.reportedModel,
      ),
    ).toBe(true);
    expect(
      candidate.probes.every(
        (probe) => probe.requestedModel === probe.reportedModel,
      ),
    ).toBe(true);
  });

  it('stores only hashes/metrics/errors, never model正文、prompt 或 credentials', () => {
    const evidence = BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE;
    for (const path of [
      evidence.reportArtifactPath,
      evidence.currentRouteBaseline.reportArtifactPath,
    ]) {
      const report = parseReport(artifactBytes(path));
      expect(forbiddenReportPayloadKeys(report)).toEqual([]);
    }
  });

  it('detects even one forbidden payload key instead of requiring the whole set', () => {
    expect(
      forbiddenReportPayloadKeys({ run: { content: 'model正文' } }),
    ).toEqual(['content']);
  });
});

describe('BrandProfile generic AI Task contract', () => {
  it('derives route-bearing fields from task-routes instead of freezing a second model snapshot', () => {
    const contract = getTask('site_builder.brand_profile');
    const route = resolveTaskRoute('site_builder.brand_profile');

    expect(contract).toBeDefined();
    expect({
      model: contract?.model,
      timeoutMs: contract?.timeoutMs,
      maxCostCents: contract?.maxCostCents,
    }).toEqual({
      model: route.primary,
      timeoutMs: route.timeoutMs,
      maxCostCents: route.maxCostCents,
    });
  });
});
