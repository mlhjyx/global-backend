import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BRAND_PROFILE_EVALUATOR_RUBRIC,
  BRAND_PROFILE_EVALUATOR_VERSION,
  evaluateBrandProfileOutput,
  prepareBrandProfileEvalFixture,
  type BrandProfileEvalFixture,
} from './brand-profile-eval';
import type { BrandProfileOutput } from '../agents/brand-profile';
import {
  canonicalJson,
  EvaluationDeadlineError,
  runWithEvaluationDeadline,
  sha256CanonicalJson,
  snapshotEvaluationExecutionPolicy,
  routeForTaskEvaluation,
} from './eval-provenance';

const richFixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/golden-companies/brand-profile/industrial-pump-rich.json', import.meta.url), 'utf8'),
) as BrandProfileEvalFixture;

const fixtureDirectory = new URL('../../../test/fixtures/golden-companies/brand-profile/', import.meta.url);
const bootstrapFixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map(
    (name) =>
      JSON.parse(readFileSync(new URL(`../../../test/fixtures/golden-companies/brand-profile/${name}`, import.meta.url), 'utf8')) as BrandProfileEvalFixture,
  );

function outputFor(
  prepared: ReturnType<typeof prepareBrandProfileEvalFixture>,
): BrandProfileOutput {
  const intake = prepared.frozenSources.get('intake-1');
  const catalog = prepared.frozenSources.get('catalog-1');
  if (!intake || !catalog) throw new Error('test fixture source missing');
  return {
    valueProps: ['Seal-less transfer for corrosive process media.'],
    keywords: ['magnetic drive pumps'],
    glossary: [],
    differentiators: [],
    competitors: [],
    gaps: [],
    factSheet: [
      {
        key: 'products',
        value: 'Magnetic drive pumps',
        evidence: {
          sourceType: 'intake',
          sourceId: 'intake-1',
          contentHash: intake.contentHash,
          quote: 'magnetic drive pumps',
        },
      },
      {
        key: 'dosing_pressure',
        value: 'The DP dosing series supports discharge pressure up to 160 bar.',
        evidence: {
          sourceType: 'upload',
          sourceId: 'catalog-1',
          contentHash: catalog.contentHash,
          quote: 'supports discharge pressure up to 160 bar',
        },
      },
    ],
  };
}

describe('BrandProfile MODEL-1 fixture evaluator', () => {
  it('exposes a versioned, hashable evaluator contract for model reports', () => {
    expect(BRAND_PROFILE_EVALUATOR_VERSION).toBe('brand-profile-evaluator/10');
    expect(canonicalJson({ b: 2, a: [true, null] })).toBe('{"a":[true,null],"b":2}');
    expect(canonicalJson({ ä: 3, z: 2, A: 1 })).toBe('{"A":1,"z":2,"ä":3}');
    expect(sha256CanonicalJson({ b: 2, a: [true, null] })).toBe(
      sha256CanonicalJson({ a: [true, null], b: 2 }),
    );
    expect(BRAND_PROFILE_EVALUATOR_RUBRIC.acceptedFactGate).toContain('EvidenceRefV2');
    expect(sha256CanonicalJson(outputFor(prepareBrandProfileEvalFixture(richFixture)))).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshotEvaluationExecutionPolicy(routeForTaskEvaluation('site_builder.brand_profile', 'gpt-5.6-terra'))).toMatchObject({
      maxTokens: 12_000,
      timeoutMs: 240_000,
      maxCostCents: 40,
      reasoningEffort: null,
      modelPolicy: { profile: 'structured.workspace_materials' },
    });
  });

  it('fails closed and aborts an evaluator probe that exceeds its deadline', async () => {
    let signal: AbortSignal | undefined;
    await expect(
      runWithEvaluationDeadline(1, async (receivedSignal) => {
        signal = receivedSignal;
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toBeInstanceOf(EvaluationDeadlineError);
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the documented six-fixture bootstrap coverage intact', () => {
    expect(bootstrapFixtures).toHaveLength(6);
    expect(new Set(bootstrapFixtures.map((fixture) => fixture.industry))).toEqual(
      new Set(['automotive components', 'industrial pumps', 'laboratory instruments']),
    );
    expect(bootstrapFixtures.filter((fixture) => fixture.materialCompleteness === 'sparse')).toHaveLength(3);
    expect(bootstrapFixtures.filter((fixture) => fixture.materialCompleteness === 'rich')).toHaveLength(3);
    expect(bootstrapFixtures.some((fixture) => fixture.targetMarkets.includes('DE'))).toBe(true);
    expect(bootstrapFixtures.every((fixture) => fixture.schemaVersion === 'brand-profile-eval-fixture/v1')).toBe(true);
  });

  it('prepares hash-bound production-shaped sources and accepts a fully grounded artifact', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    expect(prepared.input.intakeSource.sourceId).toBe('intake-1');
    expect(prepared.input.kbSources).toHaveLength(1);
    expect(prepared.input.targetMarkets).toEqual(['DE', 'NL', 'AT']);

    expect(evaluateBrandProfileOutput(prepared, outputFor(prepared))).toEqual({
      acceptedArtifact: true,
      acceptedFactCount: 2,
      rejectedFactCount: 0,
      missingAcceptedTerms: [],
      forbiddenOutputTerms: [],
    });
  });

  it('rejects a model-produced fact whose evidence hash does not match the frozen source', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    const output = outputFor(prepared);
    output.factSheet[0].evidence!.contentHash = '0'.repeat(64);

    const outcome = evaluateBrandProfileOutput(prepared, output);
    expect(outcome.acceptedArtifact).toBe(false);
    expect(outcome.rejectedFactCount).toBe(1);
  });

  it('rejects an otherwise grounded output that invents a fixture-forbidden assertion', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    const output = outputFor(prepared);
    output.valueProps.push('ISO 9001 certified process pump supply.');

    const outcome = evaluateBrandProfileOutput(prepared, output);
    expect(outcome.acceptedArtifact).toBe(false);
    expect(outcome.forbiddenOutputTerms).toEqual(['ISO 9001']);
  });

  it('does not allow a source quote or fact label to satisfy a required value the model did not assert', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    const output = outputFor(prepared);
    output.factSheet[1].key = 'maximum pressure (160 bar)';
    output.factSheet[1].value = 'The DP dosing series supports discharge pressure up to 300 bar.';

    const outcome = evaluateBrandProfileOutput(prepared, output);
    expect(outcome.acceptedArtifact).toBe(false);
    expect(outcome.rejectedFactCount).toBe(1);
    expect(outcome.missingAcceptedTerms).toEqual(['160 bar']);
  });

  it('handles schema-legal omissions of optional enrichment sections without crashing', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    const output = outputFor(prepared);
    delete (output as Partial<BrandProfileOutput>).glossary;
    delete (output as Partial<BrandProfileOutput>).differentiators;
    delete (output as Partial<BrandProfileOutput>).competitors;

    expect(evaluateBrandProfileOutput(prepared, output).acceptedArtifact).toBe(true);
  });

  it('does not treat a gap question as a publishable forbidden assertion', () => {
    const prepared = prepareBrandProfileEvalFixture(richFixture);
    const output = outputFor(prepared);
    output.gaps.push({ field: 'certification', question: 'Can you provide ISO 9001 evidence?' });

    expect(evaluateBrandProfileOutput(prepared, output).acceptedArtifact).toBe(true);
  });

  it('does not treat an evidence quote as a publishable forbidden assertion', () => {
    const fixture = structuredClone(richFixture);
    fixture.assertions.forbiddenOutputTerms = ['corrosive process media'];
    const prepared = prepareBrandProfileEvalFixture(fixture);
    const output = outputFor(prepared);
    output.valueProps = ['Grounded operating data for chemical processing.'];
    const catalog = prepared.frozenSources.get('catalog-1');
    if (!catalog) throw new Error('catalog fixture source missing');
    output.factSheet.push({
      key: 'operating_design',
      value: 'Seal-less transfer',
      evidence: {
        sourceType: 'upload',
        sourceId: 'catalog-1',
        contentHash: catalog.contentHash,
        quote:
          'the MX magnetic drive series is designed for seal-less transfer of corrosive process media',
      },
    });

    expect(evaluateBrandProfileOutput(prepared, output).acceptedArtifact).toBe(true);
  });
});
