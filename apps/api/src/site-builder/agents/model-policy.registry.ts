import { SITE_BUILDER_MODEL_POLICY_VERSION } from '@global/contracts';
import type {
  DeterministicFallback,
  ModelActiveRoute,
  ModelCandidateRoute,
  ModelCurrentRoute,
  ModelProfileDefinition,
  ModelRouteSnapshot,
} from '@global/contracts';

import type { SiteBuilderTaskId } from './task-route-bindings';
import { SITE_BUILDER_MODEL_PROFILES, type SiteBuilderModelProfileId } from './model-profiles';

interface ProfilePolicy {
  profile: ModelProfileDefinition;
  candidates: readonly ModelCandidateRoute[];
  deterministicFallback: DeterministicFallback;
}

const target = (
  primary: string,
  fallbacks: readonly string[],
  activation: ModelCandidateRoute['activation'],
  notes?: string,
): ModelCandidateRoute => ({
  state: 'targetCandidate',
  lifecycle: 'candidate',
  route: { primary, fallbacks },
  activation,
  notes,
});

/**
 * Exact pre-MODEL-0 routes, retained as task-local rollback snapshots. They are
 * never deleted when a task is promoted, so one env switch can restore the
 * previously proven route without editing code or relying on historical docs.
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
 * ADR-020 profile-level registrations. A task promotion does not promote every
 * other task sharing that profile; those candidates remain non-routable until
 * each task has its own evidence record.
 */
const PROFILE_POLICIES: Record<SiteBuilderModelProfileId, ProfilePolicy> = {
  deterministic: {
    profile: SITE_BUILDER_MODEL_PROFILES.deterministic,
    candidates: [],
    deterministicFallback: {
      id: 'code-path',
      description: 'Execute the fixed deterministic implementation.',
    },
  },
  'structured.default': {
    profile: SITE_BUILDER_MODEL_PROFILES['structured.default'],
    candidates: [target('gpt-5.6-terra', ['claude-sonnet-5'], 'requires_task_evaluation')],
    deterministicFallback: {
      id: 'safe-blueprint',
      description: 'Return the validated deterministic safe blueprint.',
    },
  },
  'structured.workspace_materials': {
    profile: SITE_BUILDER_MODEL_PROFILES['structured.workspace_materials'],
    candidates: [
      target(
        'gpt-5.6-terra',
        ['claude-sonnet-5'],
        'requires_task_evaluation',
      ),
    ],
    deterministicFallback: {
      id: 'approved-company-facts',
      description:
        'Keep only evidence-bound public company facts and owner-facing gaps.',
    },
  },
  'reasoning.high': {
    profile: SITE_BUILDER_MODEL_PROFILES['reasoning.high'],
    candidates: [target('gpt-5.6-sol', [], 'requires_task_evaluation', 'Only after two complex repair failures.')],
    deterministicFallback: {
      id: 'safe-blueprint',
      description: 'Keep the validated deterministic safe blueprint.',
    },
  },
  'copy.premium': {
    profile: SITE_BUILDER_MODEL_PROFILES['copy.premium'],
    candidates: [target('claude-sonnet-5', ['gpt-5.6-terra'], 'requires_task_evaluation')],
    deterministicFallback: {
      id: 'approved-copy-slots',
      description: 'Use approved deterministic copy slots or omit.',
    },
  },
  'text.summary': {
    profile: SITE_BUILDER_MODEL_PROFILES['text.summary'],
    candidates: [target('gemini-3.5-flash', ['gpt-5.6-terra'], 'requires_task_evaluation')],
    deterministicFallback: {
      id: 'rule-summary',
      description: 'Return deterministic findings without a model summary.',
    },
  },
  'text.bulk': {
    profile: SITE_BUILDER_MODEL_PROFILES['text.bulk'],
    candidates: [target('gemini-2.5-flash-lite', ['gpt-5.6-luna'], 'requires_task_evaluation')],
    deterministicFallback: {
      id: 'batch-skip',
      description: 'Skip the optional batch operation without manufacturing output.',
    },
  },
  'multimodal.review': {
    profile: SITE_BUILDER_MODEL_PROFILES['multimodal.review'],
    candidates: [target('gemini-3.5-flash', ['gpt-5.6-terra'], 'requires_task_evaluation')],
    deterministicFallback: {
      id: 'deterministic-qa',
      description: 'Keep deterministic QA findings only.',
    },
  },
  'image.bulk.creative': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.bulk.creative'],
    candidates: [target('gemini-3.1-flash-image', ['doubao-seedream-5.0-lite'], 'requires_media_gateway')],
    deterministicFallback: {
      id: 'asset-or-omit',
      description: 'Use an approved asset or omit the visual.',
    },
  },
  'image.premium.design': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.premium.design'],
    candidates: [target('gemini-3-pro-image', ['gpt-image-2'], 'requires_media_gateway')],
    deterministicFallback: {
      id: 'asset-or-omit',
      description: 'Use an approved asset or omit the visual.',
    },
  },
  'image.precise_edit': {
    profile: SITE_BUILDER_MODEL_PROFILES['image.precise_edit'],
    candidates: [target('gpt-image-2', [], 'requires_media_gateway')],
    deterministicFallback: {
      id: 'original-sharp-variant',
      description: 'Keep the original Sharp-derived variant.',
    },
  },
  'video.primary': {
    profile: SITE_BUILDER_MODEL_PROFILES['video.primary'],
    candidates: [target('seedance-2.0', [], 'requires_media_gateway')],
    deterministicFallback: {
      id: 'motion-or-static',
      description: 'Use deterministic motion or a static asset.',
    },
  },
  'video.premium': {
    profile: SITE_BUILDER_MODEL_PROFILES['video.premium'],
    candidates: [],
    deterministicFallback: {
      id: 'motion-or-static',
      description: 'Use deterministic motion or a static asset.',
    },
  },
  'speech.production': {
    profile: SITE_BUILDER_MODEL_PROFILES['speech.production'],
    candidates: [],
    deterministicFallback: {
      id: 'omit-audio',
      description: 'Do not fabricate an audio track.',
    },
  },
  transcription: {
    profile: SITE_BUILDER_MODEL_PROFILES.transcription,
    candidates: [],
    deterministicFallback: {
      id: 'transcription-unavailable',
      description: 'Keep audio unavailable until transcription is verified.',
    },
  },
  'moderation.media': {
    profile: SITE_BUILDER_MODEL_PROFILES['moderation.media'],
    candidates: [],
    deterministicFallback: {
      id: 'hold-for-review',
      description: 'Hold media when no verified moderation path exists.',
    },
  },
  'embedding.private': {
    profile: SITE_BUILDER_MODEL_PROFILES['embedding.private'],
    candidates: [],
    deterministicFallback: {
      id: 'fail-closed',
      description: 'Do not substitute a remote embedding space.',
    },
  },
};

function cloneRoute(route: ModelRouteSnapshot): ModelRouteSnapshot {
  return { primary: route.primary, fallbacks: [...route.fallbacks] };
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

  getProfile(profileId: SiteBuilderModelProfileId): ModelProfileDefinition {
    const profile = PROFILE_POLICIES[profileId].profile;
    return {
      ...profile,
      requiredCapabilities: [...profile.requiredCapabilities],
      dataPolicy: { ...profile.dataPolicy },
    };
  }

  getCandidates(profileId: SiteBuilderModelProfileId): readonly ModelCandidateRoute[] {
    return PROFILE_POLICIES[profileId].candidates.map((candidate) => ({
      ...candidate,
      route: cloneRoute(candidate.route),
    }));
  }

  getPolicyVersion(): string {
    return SITE_BUILDER_MODEL_POLICY_VERSION;
  }

  getDeterministicFallback(profileId: SiteBuilderModelProfileId): DeterministicFallback {
    return { ...PROFILE_POLICIES[profileId].deterministicFallback };
  }
}

export const modelPolicyRegistry = new ModelPolicyRegistry();
