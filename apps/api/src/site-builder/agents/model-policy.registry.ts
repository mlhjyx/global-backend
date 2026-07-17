import { SITE_BUILDER_MODEL_POLICY_VERSION } from '@global/contracts';
import type {
  DeterministicFallback,
  ModelCandidateRoute,
  ModelCurrentRoute,
  ModelProfileDefinition,
  ModelRouteSnapshot,
} from '@global/contracts';

import type { SiteBuilderTaskId } from './task-routes';
import { SITE_BUILDER_MODEL_PROFILES, type SiteBuilderModelProfileId } from './model-profiles';

type CurrentTaskModelPolicy = ModelCurrentRoute;

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
 * Exact pre-MODEL-0 routes, moved verbatim from task-routes.ts. This map is the
 * only production input used by resolveCurrentTaskRoute; target candidates are
 * intentionally not selectable here.
 */
const CURRENT_TASK_POLICIES: Record<SiteBuilderTaskId, CurrentTaskModelPolicy> = {
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

/**
 * ADR-020 registrations. None is a promoted route: MODEL-1/2 must first prove
 * protocol capability and task-shaped quality, then explicitly change policy.
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
  resolveCurrentTaskRoute(taskId: SiteBuilderTaskId): ModelRouteSnapshot {
    return cloneRoute(CURRENT_TASK_POLICIES[taskId].route);
  }

  getCurrentTaskPolicy(taskId: SiteBuilderTaskId): ModelCurrentRoute {
    const policy = CURRENT_TASK_POLICIES[taskId];
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
