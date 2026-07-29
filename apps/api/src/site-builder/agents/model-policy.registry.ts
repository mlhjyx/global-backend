import {
  SITE_BUILDER_MODEL_POLICY_VERSION,
  SITE_BUILDER_MODEL_ROLLBACK_POLICY_VERSION,
} from '@global/contracts';
import type {
  DeterministicFallback,
  ModelActiveRoute,
  ModelAliasRetirementPolicy,
  ModelCandidateRoute,
  ModelCurrentRoute,
  ModelProfileDefinition,
  ModelRollbackTarget,
  ModelRouteSnapshot,
} from '@global/contracts';

import { SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID } from './model-candidate-baseline';
import { modelCandidateRoutesFromBaseline } from './model-candidate-registry';
import type { SiteBuilderTaskId } from './task-route-bindings';
import {
  SITE_BUILDER_MODEL_PROFILES,
  type SiteBuilderModelProfileId,
} from './model-profiles';

interface ProfilePolicy {
  profile: ModelProfileDefinition;
  candidates: readonly ModelCandidateRoute[];
  deterministicFallback: DeterministicFallback;
}

/**
 * Exact pre-MODEL-0 routes retained as historical provenance. They are not an
 * executable rollback policy: a provider may be retired while this snapshot
 * remains available for audit and evidence interpretation.
 */
const LEGACY_TASK_POLICIES: Record<SiteBuilderTaskId, ModelCurrentRoute> = {
  'site_builder.brand_profile': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: { primary: 'deepseek-v4-pro', fallbacks: ['glm-5.2'] },
  },
  'site_builder.copy': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: {
      primary: 'deepseek-v4-pro',
      fallbacks: ['glm-5.2', 'doubao-seed-2.0-pro'],
    },
  },
  'site_builder.design_spec': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: { primary: 'minimax-m3', fallbacks: ['doubao-seed-2.0-pro'] },
  },
  'site_builder.assemble': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: { primary: 'glm-5.2', fallbacks: ['deepseek-v4-pro'] },
  },
  'site_builder.assembly_fix': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: { primary: 'glm-5.2', fallbacks: ['deepseek-v4-pro'] },
  },
  'site_builder.qa_summarize': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: {
      primary: 'deepseek-v4-flash',
      fallbacks: ['doubao-seed-2.0-lite'],
    },
  },
  'site_builder.seo_review': {
    state: 'currentRoute',
    lifecycle: 'active',
    route: {
      primary: 'deepseek-v4-flash',
      fallbacks: ['doubao-seed-2.0-lite'],
    },
  },
};

export const BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE = Object.freeze({
  id: 'model1-brand-profile-20260719-v20',
  taskId: 'site_builder.brand_profile',
  evaluatedAt: '2026-07-18T22:08:04.248Z',
  reportSchemaVersion: 'site-builder-model1-brand-profile-report/v5',
  reportArtifactPath:
    'docs/evidence/model-routing/model1-brand-profile-20260719-v20/candidate-report.json',
  reportSha256:
    '76f30d38dc958e777b036a29f430963d185399b761e7de5d63f7189b303bad60',
  fixtureCount: 6,
  repeats: 2,
  currentRouteBaseline: Object.freeze({
    route: Object.freeze({
      primary: 'deepseek-v4-pro',
      fallbacks: Object.freeze(['glm-5.2']),
    }),
    model: 'deepseek-v4-pro',
    transport: 'openai-chat-completions',
    evaluatedAt: '2026-07-18T21:50:32.598Z',
    reportArtifactPath:
      'docs/evidence/model-routing/model1-brand-profile-20260719-v20/current-route-baseline-report.json',
    reportSha256:
      '3aa408b68978779b4a81f3696f68c761adca453e5fafa9d513bf128d41b2d69b',
    acceptedArtifacts: 12,
    hardFailures: 0,
    fallbackRuns: 0,
    p95LatencyMs: 123_099,
    attemptedInputTokens: 18_192,
    attemptedOutputTokens: 64_879,
    attemptedCostUsd: 0.06435825,
    acceptedArtifactUnitCostUsd: 0.0053631875,
    failureSlice: null,
  }),
  routes: Object.freeze([
    Object.freeze({
      model: 'gpt-5.6-terra',
      transport: 'openai-responses',
      acceptedArtifacts: 12,
      hardFailures: 0,
      p95LatencyMs: 57_449,
      inputTokens: 27_753,
      outputTokens: 15_469,
      acceptedArtifactCostUsd: 0.03014175,
    }),
    Object.freeze({
      model: 'claude-sonnet-5',
      transport: 'anthropic-messages',
      acceptedArtifacts: 12,
      hardFailures: 0,
      p95LatencyMs: 59_082,
      inputTokens: 32_384,
      outputTokens: 58_373,
      acceptedArtifactCostUsd: 0.17509446,
    }),
  ]),
  pricing: Object.freeze({
    capturedAt: '2026-07-18T13:49:52+08:00',
    source: 'https://teamorouter.com/zh/pricing',
    unit: 'USD per 1M tokens',
    rates: Object.freeze({
      'gpt-5.6-terra': Object.freeze({ input: 0.25, output: 1.5 }),
      'claude-sonnet-5': Object.freeze({ input: 0.54, output: 2.7 }),
      'deepseek-v4-pro': Object.freeze({ input: 0.435, output: 0.87 }),
    }),
  }),
});

/** Only BrandProfile has completed a task-shaped MODEL-1 promotion gate. */
const ACTIVE_TASK_POLICIES: Record<SiteBuilderTaskId, ModelActiveRoute> = {
  ...LEGACY_TASK_POLICIES,
  'site_builder.brand_profile': {
    state: 'promotedRoute',
    lifecycle: 'active',
    route: {
      primary: 'gpt-5.6-terra',
      fallbacks: ['claude-sonnet-5'],
    },
    promotionEvidenceId: BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.id,
  },
};

/**
 * Candidate-baseline profile registrations. A task promotion does not promote
 * every other task sharing that profile; candidates remain non-routable until
 * each task has its own evidence record.
 */
const PROFILE_POLICIES: Record<SiteBuilderModelProfileId, ProfilePolicy> = {
  deterministic: {
    profile: SITE_BUILDER_MODEL_PROFILES.deterministic,
    candidates: modelCandidateRoutesFromBaseline('deterministic'),
    deterministicFallback: {
      id: 'code-path',
      description: 'Execute the fixed deterministic implementation.',
    },
  },
  'structured.default': {
    profile: SITE_BUILDER_MODEL_PROFILES['structured.default'],
    candidates: modelCandidateRoutesFromBaseline('structured.default'),
    deterministicFallback: {
      id: 'safe-blueprint',
      description: 'Return the validated deterministic safe blueprint.',
    },
  },
  'structured.workspace_materials': {
    profile: SITE_BUILDER_MODEL_PROFILES['structured.workspace_materials'],
    candidates: modelCandidateRoutesFromBaseline(
      'structured.workspace_materials',
    ),
    deterministicFallback: {
      id: 'approved-company-facts',
      description:
        'Keep only evidence-bound public company facts and owner-facing gaps.',
    },
  },
  'reasoning.high': {
    profile: SITE_BUILDER_MODEL_PROFILES['reasoning.high'],
    candidates: modelCandidateRoutesFromBaseline('reasoning.high'),
    deterministicFallback: {
      id: 'safe-blueprint',
      description: 'Keep the validated deterministic safe blueprint.',
    },
  },
  'copy.premium': {
    profile: SITE_BUILDER_MODEL_PROFILES['copy.premium'],
    candidates: modelCandidateRoutesFromBaseline('copy.premium'),
    deterministicFallback: {
      id: 'approved-copy-slots',
      description: 'Use approved deterministic copy slots or omit.',
    },
  },
  'text.summary': {
    profile: SITE_BUILDER_MODEL_PROFILES['text.summary'],
    candidates: modelCandidateRoutesFromBaseline('text.summary'),
    deterministicFallback: {
      id: 'rule-summary',
      description: 'Return deterministic findings without a model summary.',
    },
  },
  'text.bulk': {
    profile: SITE_BUILDER_MODEL_PROFILES['text.bulk'],
    candidates: modelCandidateRoutesFromBaseline('text.bulk'),
    deterministicFallback: {
      id: 'batch-skip',
      description:
        'Skip the optional batch operation without manufacturing output.',
    },
  },
  'multimodal.review': {
    profile: SITE_BUILDER_MODEL_PROFILES['multimodal.review'],
    candidates: modelCandidateRoutesFromBaseline('multimodal.review'),
    deterministicFallback: {
      id: 'deterministic-qa',
      description: 'Keep deterministic QA findings only.',
    },
  },
  'image.bulk.creative': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.bulk.creative'],
    candidates: modelCandidateRoutesFromBaseline('image.bulk.creative'),
    deterministicFallback: {
      id: 'asset-or-omit',
      description: 'Use an approved asset or omit the visual.',
    },
  },
  'image.premium.design': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.premium.design'],
    candidates: modelCandidateRoutesFromBaseline('image.premium.design'),
    deterministicFallback: {
      id: 'asset-or-omit',
      description: 'Use an approved asset or omit the visual.',
    },
  },
  'image.precise_edit': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.precise_edit'],
    candidates: modelCandidateRoutesFromBaseline('image.precise_edit'),
    deterministicFallback: {
      id: 'original-sharp-variant',
      description: 'Keep the original Sharp-derived variant.',
    },
  },
  'video.primary': {
    profile: SITE_BUILDER_MODEL_PROFILES['video.primary'],
    candidates: modelCandidateRoutesFromBaseline('video.primary'),
    deterministicFallback: {
      id: 'motion-or-static',
      description: 'Use deterministic motion or a static asset.',
    },
  },
  'video.premium': {
    profile: SITE_BUILDER_MODEL_PROFILES['video.premium'],
    candidates: modelCandidateRoutesFromBaseline('video.premium'),
    deterministicFallback: {
      id: 'motion-or-static',
      description: 'Use deterministic motion or a static asset.',
    },
  },
  'speech.production': {
    profile: SITE_BUILDER_MODEL_PROFILES['speech.production'],
    candidates: modelCandidateRoutesFromBaseline('speech.production'),
    deterministicFallback: {
      id: 'omit-audio',
      description: 'Do not fabricate an audio track.',
    },
  },
  transcription: {
    profile: SITE_BUILDER_MODEL_PROFILES.transcription,
    candidates: modelCandidateRoutesFromBaseline('transcription'),
    deterministicFallback: {
      id: 'transcription-unavailable',
      description: 'Keep audio unavailable until transcription is verified.',
    },
  },
  'moderation.media': {
    profile: SITE_BUILDER_MODEL_PROFILES['moderation.media'],
    candidates: modelCandidateRoutesFromBaseline('moderation.media'),
    deterministicFallback: {
      id: 'hold-for-review',
      description: 'Hold media when no verified moderation path exists.',
    },
  },
  'embedding.private': {
    profile: SITE_BUILDER_MODEL_PROFILES['embedding.private'],
    candidates: modelCandidateRoutesFromBaseline('embedding.private'),
    deterministicFallback: {
      id: 'fail-closed',
      description: 'Do not substitute a remote embedding space.',
    },
  },
};

const EXECUTABLE_ROLLBACK_POLICIES: Record<
  SiteBuilderTaskId,
  ModelRollbackTarget
> = {
  'site_builder.brand_profile': {
    kind: 'model_route',
    route: { primary: 'deepseek-v4-pro', fallbacks: ['glm-5.2'] },
  },
  'site_builder.copy': {
    kind: 'model_route',
    route: { primary: 'deepseek-v4-pro', fallbacks: ['glm-5.2'] },
  },
  'site_builder.design_spec': {
    kind: 'deterministic_fallback',
    fallback: {
      id: 'safe-blueprint',
      description: 'Return the validated deterministic safe blueprint.',
    },
  },
  'site_builder.assemble': {
    kind: 'model_route',
    route: { primary: 'glm-5.2', fallbacks: ['deepseek-v4-pro'] },
  },
  'site_builder.assembly_fix': {
    kind: 'model_route',
    route: { primary: 'glm-5.2', fallbacks: ['deepseek-v4-pro'] },
  },
  'site_builder.qa_summarize': {
    kind: 'deterministic_fallback',
    fallback: {
      id: 'rule-summary',
      description: 'Return deterministic findings without a model summary.',
    },
  },
  'site_builder.seo_review': {
    kind: 'deterministic_fallback',
    fallback: {
      id: 'rule-summary',
      description: 'Return deterministic findings without a model summary.',
    },
  },
};

const PENDING_MODEL_RETIREMENTS = Object.freeze({
  'minimax-m3': Object.freeze({
    decision: 'pending_retirement',
    reason:
      'Replace the unchanged design_spec current route through task evidence and promotion; do not restore this channel.',
  }),
  'doubao-seed-2.0-pro': Object.freeze({
    decision: 'pending_retirement',
    reason:
      'Remove this legacy fallback through task evidence and promotion; do not restore this channel.',
  }),
  'doubao-seed-2.0-lite': Object.freeze({
    decision: 'pending_retirement',
    reason:
      'Replace summary-task fallbacks with deterministic rule-summary; do not restore this channel.',
  }),
} satisfies Record<string, ModelAliasRetirementPolicy>);

function cloneRoute(route: ModelRouteSnapshot): ModelRouteSnapshot {
  return { primary: route.primary, fallbacks: [...route.fallbacks] };
}

function cloneRollbackTarget(target: ModelRollbackTarget): ModelRollbackTarget {
  if (target.kind === 'model_route') {
    return { kind: target.kind, route: cloneRoute(target.route) };
  }
  return { kind: target.kind, fallback: { ...target.fallback } };
}

/**
 * A deliberately read-only policy registry. There is no promotion mutator in
 * MODEL-0: candidate evaluation and traffic promotion belong to MODEL-1/2.
 */
export class ModelPolicyRegistry {
  resolveActiveTaskRoute(taskId: SiteBuilderTaskId): ModelRouteSnapshot {
    return cloneRoute(ACTIVE_TASK_POLICIES[taskId].route);
  }

  getActiveTaskPolicy(taskId: SiteBuilderTaskId): ModelActiveRoute {
    const policy = ACTIVE_TASK_POLICIES[taskId];
    if (policy.state === 'promotedRoute') {
      return {
        state: policy.state,
        lifecycle: policy.lifecycle,
        route: cloneRoute(policy.route),
        promotionEvidenceId: policy.promotionEvidenceId,
      };
    }
    return {
      state: policy.state,
      lifecycle: policy.lifecycle,
      route: cloneRoute(policy.route),
    };
  }

  getLegacyTaskPolicy(taskId: SiteBuilderTaskId): ModelCurrentRoute {
    const policy = LEGACY_TASK_POLICIES[taskId];
    return {
      state: policy.state,
      lifecycle: policy.lifecycle,
      route: cloneRoute(policy.route),
    };
  }

  /**
   * Evaluation comparators are executable rollback models, not historical
   * provenance. Deterministic rollback tasks intentionally have no paid legacy
   * comparator, and retired aliases are rejected before any harness/client
   * admission can be constructed.
   */
  getEvaluationComparatorRoute(
    taskId: SiteBuilderTaskId,
  ): ModelRouteSnapshot | null {
    const target = EXECUTABLE_ROLLBACK_POLICIES[taskId];
    if (target.kind === 'deterministic_fallback') return null;
    for (const alias of [target.route.primary, ...target.route.fallbacks]) {
      if (this.getAliasRetirementPolicy(alias)) {
        throw new Error(
          `RETIRED_ALIAS_COMPARATOR_FORBIDDEN: ${taskId}:${alias}`,
        );
      }
    }
    return cloneRoute(target.route);
  }

  getExecutableRollbackPolicy(taskId: SiteBuilderTaskId): ModelRollbackTarget {
    return cloneRollbackTarget(EXECUTABLE_ROLLBACK_POLICIES[taskId]);
  }

  getAliasRetirementPolicy(alias: string): ModelAliasRetirementPolicy | null {
    const policy =
      PENDING_MODEL_RETIREMENTS[
        alias as keyof typeof PENDING_MODEL_RETIREMENTS
      ];
    return policy ? { ...policy } : null;
  }

  getProfile(profileId: SiteBuilderModelProfileId): ModelProfileDefinition {
    const profile = PROFILE_POLICIES[profileId].profile;
    return {
      ...profile,
      requiredCapabilities: [...profile.requiredCapabilities],
      dataPolicy: { ...profile.dataPolicy },
    };
  }

  getCandidates(
    profileId: SiteBuilderModelProfileId,
  ): readonly ModelCandidateRoute[] {
    return PROFILE_POLICIES[profileId].candidates.map((candidate) => ({
      ...candidate,
      route: cloneRoute(candidate.route),
    }));
  }

  getPolicyVersion(): string {
    return SITE_BUILDER_MODEL_POLICY_VERSION;
  }

  getRollbackPolicyVersion(): string {
    return SITE_BUILDER_MODEL_ROLLBACK_POLICY_VERSION;
  }

  getCandidateBaselineId(): string {
    return SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID;
  }

  getDeterministicFallback(
    profileId: SiteBuilderModelProfileId,
  ): DeterministicFallback {
    return { ...PROFILE_POLICIES[profileId].deterministicFallback };
  }
}

export const modelPolicyRegistry = new ModelPolicyRegistry();
