import { describe, expect, it } from 'vitest';
import {
  COPY_EVALUATION_V2_PLAN,
  validateCopyEvaluationV2Plan,
} from './copy-evaluation-v2';

describe('Copy Evaluation v2 admission plan', () => {
  it('keeps dispatch blocked and records zero observed paid activity', () => {
    expect(COPY_EVALUATION_V2_PLAN.executionStatus).toBe(
      'BLOCKED_BEFORE_CAPABILITY_PILOT',
    );
    expect(COPY_EVALUATION_V2_PLAN.dispatchAuthorization).toBe(
      'NOT_AUTHORIZED',
    );
    expect(COPY_EVALUATION_V2_PLAN.observedModelWireCalls).toBe(0);
    expect(COPY_EVALUATION_V2_PLAN.observedModelCost).toEqual({
      CNY: 0,
      USD: 0,
    });
  });

  it('freezes Terra, Sol, and Sonnet without claiming the current baseline admits them', () => {
    expect(
      COPY_EVALUATION_V2_PLAN.candidates.map((candidate) => ({
        alias: candidate.alias,
        protocol: candidate.protocol,
        reasoning: candidate.reasoning,
      })),
    ).toEqual([
      {
        alias: 'gpt-5.6-terra',
        protocol: 'openai_responses',
        reasoning: 'medium',
      },
      {
        alias: 'gpt-5.6-sol',
        protocol: 'openai_responses',
        reasoning: 'high',
      },
      {
        alias: 'claude-sonnet-5',
        protocol: 'anthropic_messages',
        reasoning: 'medium',
      },
    ]);
    expect(COPY_EVALUATION_V2_PLAN.candidateAdmission).toMatchObject({
      profile: 'copy.premium',
      status: 'BLOCKED_ON_CANDIDATE_REBASELINE',
      currentAliases: ['claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra'],
      requiredAliases: [
        'gpt-5.6-terra',
        'gpt-5.6-sol',
        'claude-sonnet-5',
      ],
    });
  });

  it('binds the future matrix to the production task and evaluator while requiring expansion', () => {
    expect(COPY_EVALUATION_V2_PLAN.taskContract).toMatchObject({
      taskId: 'site_builder.copy',
      currentVersion: 'site-builder-task-contract/site_builder.copy/v1',
      requiredVersion: 'site-builder-task-contract/site_builder.copy/v2',
      status: 'BLOCKED_ON_CONTEXT_V2',
      missingContext: [
        'audience',
        'brand_voice',
        'prohibited_assertions',
        'cta_policy',
      ],
    });
    expect(COPY_EVALUATION_V2_PLAN.creativeOutputAdmission).toEqual({
      currentPolicy: 'neutral_copy_is_server_canonicalized',
      requiredPolicy: 'validated_non_factual_copy_is_preserved',
      status: 'BLOCKED_ON_PRODUCTION_CANONICALIZER_V2',
    });
    expect(COPY_EVALUATION_V2_PLAN.fixtureAdmission).toMatchObject({
      currentFixtureIds: ['copy-factual-claims', 'copy-neutral-budget'],
      currentFixtureCount: 2,
      requiredFixtureCount: 6,
      repeats: 2,
      status: 'BLOCKED_ON_FIXTURE_EXPANSION',
    });
    expect(COPY_EVALUATION_V2_PLAN.requiredContext).toEqual([
      'claim_snapshot',
      'slot_contract',
      'locale',
      'audience',
      'brand_voice',
      'prohibited_assertions',
      'character_budget',
      'cta_policy',
    ]);
  });

  it('separates the three-call pilot from the later task-shaped matrix', () => {
    expect(COPY_EVALUATION_V2_PLAN.capabilityPilot).toMatchObject({
      plannedExecutions: 3,
      maximumWireCalls: 6,
      status: 'NOT_AUTHORIZED',
    });
    expect(COPY_EVALUATION_V2_PLAN.taskMatrix).toMatchObject({
      plannedExecutions: 36,
      maximumWireCalls: 72,
      status: 'BLOCKED_BEFORE_PILOT_RESULT',
    });
    expect(COPY_EVALUATION_V2_PLAN.decisionBoundaries).toEqual([
      'capability_pilot_dispatch_requires_separate_user_authorization',
      'task_matrix_dispatch_requires_separate_user_authorization',
      'promotion_requires_separate_pr_and_user_authorization',
      'runtime_route_adoption_requires_separate_pr_and_user_authorization',
    ]);
  });

  it('keeps hard validity gates separate from scored copy quality', () => {
    expect(COPY_EVALUATION_V2_PLAN.hardGates).toEqual([
      'schema',
      'claim_provenance',
      'prohibited_assertions',
      'character_budget',
      'cta_policy',
    ]);
    expect(COPY_EVALUATION_V2_PLAN.scoredDimensions).toEqual([
      'language_quality',
      'brand_voice',
      'cta_quality',
      'cross_locale_quality',
      'stability',
    ]);
    expect(() =>
      validateCopyEvaluationV2Plan(COPY_EVALUATION_V2_PLAN),
    ).not.toThrow();
  });

  it.each([
    ['candidate', (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
      ...plan,
      candidates: plan.candidates.slice(1),
    })],
    ['pilot', (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
      ...plan,
      capabilityPilot: { ...plan.capabilityPilot, maximumWireCalls: 7 },
    })],
    ['fixture', (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
      ...plan,
      fixtureAdmission: { ...plan.fixtureAdmission, requiredFixtureCount: 2 },
    })],
    ['context', (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
      ...plan,
      requiredContext: plan.requiredContext.slice(1),
    })],
    ['gate', (plan: typeof COPY_EVALUATION_V2_PLAN) => ({
      ...plan,
      hardGates: plan.hardGates.slice(1),
    })],
  ])('rejects %s drift before any future dispatcher can consume the plan', (_name, mutate) => {
    expect(() => validateCopyEvaluationV2Plan(mutate(COPY_EVALUATION_V2_PLAN))).toThrow(
      'COPY_EVALUATION_V2_PLAN_DRIFT',
    );
  });
});
