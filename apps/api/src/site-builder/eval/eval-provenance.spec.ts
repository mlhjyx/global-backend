import { describe, expect, it } from 'vitest';

import { resolveTaskRoute } from '../agents/task-routes';
import {
  assertEvaluationReportPathAvailable,
  assertUniqueEvaluationValues,
  classifyEvaluationOutcome,
  inspectEvaluationMatrix,
  inspectEvaluationSourceBundle,
  isExactUpstreamModelResolution,
  routeForModelEvaluation,
  routeForTaskEvaluation,
  sanitizeGatewayBaseUrl,
  sha256Bytes,
} from './eval-provenance';

describe('routeForModelEvaluation', () => {
  it('removes active promotion provenance from an independent candidate run', () => {
    const active = resolveTaskRoute('site_builder.brand_profile', {});
    expect(active.policy.routeState).toBe('promotedRoute');
    expect(active.policy.promotionEvidenceId).toBeTruthy();

    const candidate = routeForModelEvaluation(active, 'deepseek-v4-pro');

    expect(candidate).toMatchObject({
      primary: 'deepseek-v4-pro',
      fallbacks: [],
      profile: active.profile,
      maxTokens: active.maxTokens,
      timeoutMs: active.timeoutMs,
      maxCostCents: active.maxCostCents,
      policy: {
        routeState: 'currentRoute',
        lifecycle: 'active',
        source: 'env_override',
        route: { primary: 'deepseek-v4-pro', fallbacks: [] },
      },
    });
    expect(candidate.policy).not.toHaveProperty('promotionEvidenceId');
  });

  it('builds the BrandProfile candidate route without active promotion registry state', () => {
    const candidate = routeForTaskEvaluation(
      'site_builder.brand_profile',
      'gpt-5.6-terra',
    );

    expect(candidate).toMatchObject({
      primary: 'gpt-5.6-terra',
      fallbacks: [],
      profile: 'structured.workspace_materials',
      maxTokens: 12_000,
      timeoutMs: 240_000,
      maxCostCents: 40,
      dataPolicy: {
        personalData: 'workspace_controlled',
        dataScope: 'workspace_site_materials',
      },
      policy: {
        policyVersion: 'site-builder-model-policy/v3',
        routeState: 'currentRoute',
        source: 'env_override',
        route: { primary: 'gpt-5.6-terra', fallbacks: [] },
      },
    });
    expect(candidate.policy).not.toHaveProperty('promotionEvidenceId');
  });
});

describe('MODEL evaluation provenance guards', () => {
  it('detects source edits made while a paid evaluation is running', () => {
    const start = [{ path: 'task.ts', sha256: 'a'.repeat(64) }];
    expect(inspectEvaluationSourceBundle(start, start)).toMatchObject({
      stable: true,
    });
    expect(
      inspectEvaluationSourceBundle(start, [
        { path: 'task.ts', sha256: 'b'.repeat(64) },
      ]),
    ).toMatchObject({ stable: false });
  });

  it('rejects an occupied report path before any paid model call', async () => {
    await expect(
      assertEvaluationReportPathAvailable(
        '/tmp/existing-eval-report.json',
        async () => true,
      ),
    ).rejects.toThrow(/report path already exists/i);
    await expect(
      assertEvaluationReportPathAvailable(
        '/tmp/new-eval-report.json',
        async () => false,
      ),
    ).resolves.toBeUndefined();
  });

  it('sanitizes gateway URL credentials, query and fragment while retaining the API base path', () => {
    expect(
      sanitizeGatewayBaseUrl(
        'https://user:secret@gateway.example:8443/new-api/v1?token=secret#fragment',
      ),
    ).toBe('https://gateway.example:8443/new-api/v1');
  });

  it('rejects duplicate model or fixture identifiers before paid calls', () => {
    expect(() =>
      assertUniqueEvaluationValues('MODEL_EVAL_MODELS', ['terra', 'terra']),
    ).toThrow(/duplicate.*terra/i);
    expect(() =>
      assertUniqueEvaluationValues('MODEL_EVAL_FIXTURES', ['a', 'b']),
    ).not.toThrow();
  });

  it('hashes exact bytes and detects duplicate or missing matrix rows', () => {
    expect(sha256Bytes(Buffer.from([0, 255]))).not.toBe(
      sha256Bytes(Buffer.from([0, 254])),
    );
    expect(
      inspectEvaluationMatrix(['terra'], ['a', 'b'], 1, [
        { model: 'terra', fixtureId: 'a', attempt: 1 },
        { model: 'terra', fixtureId: 'a', attempt: 1 },
      ]),
    ).toMatchObject({
      complete: false,
      duplicateKeys: ['terra\u0000a\u00001'],
      missingKeys: ['terra\u0000b\u00001'],
      unexpectedKeys: [],
    });
  });

  it('accepts only an upstream-reported model that exactly matches the request', () => {
    expect(
      isExactUpstreamModelResolution({
        requestedModel: 'gpt-5.6-terra',
        resolvedModel: 'gpt-5.6-terra',
        reportedModel: 'gpt-5.6-terra',
        modelResolutionSource: 'upstream_response',
      }),
    ).toBe(true);
    expect(
      isExactUpstreamModelResolution({
        requestedModel: 'gpt-5.6-terra',
        resolvedModel: 'other-model',
        reportedModel: 'other-model',
        modelResolutionSource: 'upstream_response',
      }),
    ).toBe(false);
    expect(
      isExactUpstreamModelResolution({
        requestedModel: 'gpt-5.6-terra',
        resolvedModel: 'gpt-5.6-terra',
        modelResolutionSource: 'requested_fallback',
      }),
    ).toBe(false);
  });

  it('accepts a complete baseline without misrepresenting it as promotion evidence', () => {
    expect(
      classifyEvaluationOutcome({
        evidenceRole: 'baseline',
        diagnosticsEnabled: false,
        preflightPassed: true,
        sourceStable: true,
        matrixComplete: true,
        artifactFailures: 0,
        provenanceExact: true,
      }),
    ).toEqual({
      status: 'completed_baseline',
      promotionEligible: false,
      shouldFail: false,
    });

    expect(
      classifyEvaluationOutcome({
        evidenceRole: 'baseline',
        diagnosticsEnabled: false,
        preflightPassed: true,
        sourceStable: true,
        matrixComplete: true,
        artifactFailures: 1,
        provenanceExact: true,
      }),
    ).toMatchObject({ status: 'completed_with_failures', shouldFail: true });
  });
});
