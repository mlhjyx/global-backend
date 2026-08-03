import { describe, expect, it } from 'vitest';

import {
  getModelCandidateCatalogEntry,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
} from './model-candidate-baseline';
import { modelPolicyRegistry } from './model-policy.registry';
import { SITE_BUILDER_MODEL_PROFILES } from './model-profiles';
import {
  getSiteBuilderTaskRouteBinding,
  SITE_BUILDER_TASK_IDS,
} from './task-route-bindings';
import { resolveTaskRoute } from './task-routes';

const aliasesFor = (profile: string) =>
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools
    .find((pool) => pool.profile === profile)
    ?.candidates.map((candidate) => candidate.alias) ?? [];

describe('Site Builder model candidate baseline', () => {
  it('uses a candidateBaselineId independent from execution policy v3', () => {
    expect(SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID).toBe(
      'site-builder-model-candidate-baseline/2026-08-04-v1',
    );
    expect(modelPolicyRegistry.getCandidateBaselineId()).toBe(
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    );
    expect(modelPolicyRegistry.getPolicyVersion()).toBe(
      'site-builder-model-policy/v3',
    );
    expect(SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID).not.toContain(
      modelPolicyRegistry.getPolicyVersion(),
    );
    expect(
      resolveTaskRoute('site_builder.brand_profile').policy,
    ).not.toHaveProperty('candidateBaselineId');
  });

  it('freezes the exact initial text evaluation pools', () => {
    expect({
      structuredWorkspace: aliasesFor('structured.workspace_materials'),
      structured: aliasesFor('structured.default'),
      reasoning: aliasesFor('reasoning.high'),
      copy: aliasesFor('copy.premium'),
      summary: aliasesFor('text.summary'),
      bulk: aliasesFor('text.bulk'),
      multimodal: aliasesFor('multimodal.review'),
    }).toEqual({
      structuredWorkspace: ['gpt-5.6-terra', 'claude-sonnet-5', 'gpt-5.5'],
      structured: ['gpt-5.6-terra', 'gpt-5.5', 'claude-sonnet-5'],
      reasoning: ['gpt-5.6-sol', 'gpt-5.5', 'claude-sonnet-5'],
      copy: ['claude-sonnet-5', 'gpt-5.5', 'gpt-5.6-terra'],
      summary: ['gpt-5.6-luna', 'claude-sonnet-5', 'gpt-5.6-terra'],
      bulk: ['gpt-5.4-mini', 'gpt-5.6-luna', 'gpt-5.4'],
      multimodal: ['gpt-5.6-sol', 'claude-sonnet-5', 'gpt-5.6-terra'],
    });
    expect(getModelCandidateCatalogEntry('gemini-3.5-flash').status).toBe(
      'deferred',
    );
    expect(
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.some((pool) =>
        pool.candidates.some(
          (candidate) => candidate.alias === 'gemini-3.5-flash',
        ),
      ),
    ).toBe(false);
  });

  it('encodes capability-probe admission as closed machine data', () => {
    const candidates =
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.flatMap(
        (pool) =>
          pool.candidates.map((candidate) => ({
            profile: pool.profile,
            alias: candidate.alias,
            preflight: candidate.preflight,
          })),
      );
    expect(
      candidates
        .filter((candidate) => candidate.preflight === 'capability_probe')
        .map(({ profile, alias }) => ({ profile, alias })),
    ).toEqual([
      { profile: 'structured.workspace_materials', alias: 'gpt-5.5' },
      { profile: 'structured.default', alias: 'gpt-5.5' },
      { profile: 'reasoning.high', alias: 'gpt-5.5' },
      { profile: 'copy.premium', alias: 'gpt-5.5' },
    ]);
    expect(
      candidates.every(
        (candidate) =>
          candidate.preflight === 'none' ||
          candidate.preflight === 'capability_probe',
      ),
    ).toBe(true);
  });

  it('freezes precise media aliases, preview/deferred states, and expected protocols', () => {
    expect({
      imageBulk: aliasesFor('image.bulk.creative'),
      imagePremium: aliasesFor('image.premium.design'),
      imageEdit: aliasesFor('image.precise_edit'),
      video: aliasesFor('video.primary'),
    }).toEqual({
      imageBulk: ['gemini-3.1-flash-image-preview', 'gpt-image-2'],
      imagePremium: ['gpt-image-2-4k', 'gemini-3-pro-image-preview'],
      imageEdit: ['gpt-image-2'],
      video: [
        'seedance-2-5s',
        'seedance-2-10s',
        'seedance-2-15s',
        'grok-video-1.0',
        'grok-video-1.5',
      ],
    });
    expect(
      getModelCandidateCatalogEntry('gemini-3.1-flash-image-preview'),
    ).toMatchObject({
      status: 'preview',
      expectedProtocols: ['openai-images-generations'],
    });
    expect(getModelCandidateCatalogEntry('gpt-image-2')).toMatchObject({
      status: 'runnable',
      expectedProtocols: ['openai-images-generations', 'openai-images-edits'],
    });
    for (const alias of aliasesFor('video.primary')) {
      expect(getModelCandidateCatalogEntry(alias)).toMatchObject({
        status: 'deferred',
        expectedProtocols: ['openai-videos'],
      });
    }
  });

  it('derives every non-runtime registry target exactly from the machine baseline', () => {
    for (const profile of Object.keys(SITE_BUILDER_MODEL_PROFILES) as Array<
      keyof typeof SITE_BUILDER_MODEL_PROFILES
    >) {
      const baselinePool =
        SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.find(
          (pool) => pool.profile === profile,
        );
      const registered = modelPolicyRegistry.getCandidates(profile);
      expect(
        registered.map((candidate) => ({
          alias: candidate.route.primary,
          fallbacks: candidate.route.fallbacks,
          state: candidate.state,
          lifecycle: candidate.lifecycle,
          activation: candidate.activation,
        })),
      ).toEqual(
        baselinePool?.candidates.map((candidate) => ({
          alias: candidate.alias,
          fallbacks: [],
          state: 'targetCandidate',
          lifecycle:
            getModelCandidateCatalogEntry(candidate.alias).status === 'preview'
              ? 'preview_only'
              : 'candidate',
          activation: baselinePool.activation,
        })) ?? [],
      );
    }
  });

  it('keeps task-to-profile evaluation pools aligned with current task bindings', () => {
    expect(
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.taskEvaluationPools.map(
        ({ taskId }) => taskId,
      ),
    ).toEqual(SITE_BUILDER_TASK_IDS);
    for (const {
      taskId,
      profile,
    } of SITE_BUILDER_MODEL_CANDIDATE_BASELINE.taskEvaluationPools) {
      expect(getSiteBuilderTaskRouteBinding(taskId).profile).toBe(profile);
    }
  });

  it('keeps active model routes and the deterministic retirement target explicit', () => {
    expect(
      Object.fromEntries(
        SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
          const policy = modelPolicyRegistry.getActiveTaskPolicy(taskId);
          return policy.state === 'deterministicFallback'
            ? []
            : [[taskId, policy.route]];
        }),
      ),
    ).toEqual({
      'site_builder.brand_profile': {
        primary: 'gpt-5.6-terra',
        fallbacks: ['claude-sonnet-5'],
      },
      'site_builder.copy': {
        primary: 'deepseek-v4-pro',
        fallbacks: ['glm-5.2'],
      },
      'site_builder.assemble': {
        primary: 'glm-5.2',
        fallbacks: ['deepseek-v4-pro'],
      },
      'site_builder.assembly_fix': {
        primary: 'glm-5.2',
        fallbacks: ['deepseek-v4-pro'],
      },
      'site_builder.qa_summarize': {
        primary: 'deepseek-v4-flash',
        fallbacks: [],
      },
      'site_builder.seo_review': {
        primary: 'deepseek-v4-flash',
        fallbacks: [],
      },
    });
    expect(
      modelPolicyRegistry.getActiveTaskPolicy('site_builder.design_spec'),
    ).toMatchObject({
      state: 'deterministicFallback',
      lifecycle: 'active',
      fallback: { id: 'safe-blueprint' },
    });
    expect(
      resolveTaskRoute('site_builder.brand_profile', {
        SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE: 'true',
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      primary: 'deepseek-v4-pro',
      fallbacks: ['glm-5.2'],
      policy: {
        routeState: 'currentRoute',
        source: 'rollback_override',
      },
    });
    expect(resolveTaskRoute('site_builder.brand_profile').policy).toMatchObject(
      {
        policyVersion: 'site-builder-model-policy/v3',
        routeState: 'promotedRoute',
        promotionEvidenceId: 'model1-brand-profile-20260719-v20',
      },
    );
  });

  it('keeps legacy-only and unavailable candidates out of active routing', () => {
    const activeAliases = new Set(
      SITE_BUILDER_TASK_IDS.flatMap((taskId) => {
        const policy = modelPolicyRegistry.getActiveTaskPolicy(taskId);
        return policy.state === 'deterministicFallback'
          ? []
          : [policy.route.primary, ...policy.route.fallbacks];
      }),
    );
    const candidateAliases = new Set(
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.flatMap(
        (pool) => pool.candidates.map((candidate) => candidate.alias),
      ),
    );
    for (const model of SITE_BUILDER_MODEL_CANDIDATE_BASELINE.models) {
      if (model.status === 'legacy-only') {
        expect(candidateAliases.has(model.alias)).toBe(false);
      }
      if (model.status === 'deferred' || model.status === 'preview') {
        expect(activeAliases.has(model.alias)).toBe(false);
      }
    }
  });

  it('records production envelopes, extended diagnostics, and separate late/invalid classes', () => {
    expect(
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.evaluationPolicy,
    ).toMatchObject({
      ordering: [
        'quality',
        'structure',
        'factuality',
        'stability',
        'p95_latency',
        'accepted_artifact_cost',
      ],
      taskWindow: 'production_task_envelope',
      diagnosticWindow: 'extended_observation_after_runtime_envelope',
      qualityValidLateClass: 'quality_valid_runtime_late',
      contentInvalidClass: 'content_invalid',
      absoluteStop: 'pre_dispatch_campaign_budget_plus_per_call_cap',
    });
  });
});
