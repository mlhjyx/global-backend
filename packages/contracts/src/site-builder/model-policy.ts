/**
 * Shared model-policy vocabulary. A profile describes required task semantics,
 * never a provider or model name; provider names belong to a policy snapshot.
 */
export const MODEL_ROUTE_STATES = ['currentRoute', 'evaluatedCandidate', 'targetCandidate', 'promotedRoute'] as const;

export type ModelRouteState = (typeof MODEL_ROUTE_STATES)[number];

export const MODEL_CAPABILITIES = [
  'text_generation',
  'structured_output',
  'reasoning',
  'multilingual_copy',
  'vision_review',
  'image_generation',
  'image_editing',
  'video_generation',
  'speech_generation',
  'transcription',
  'media_moderation',
  'embedding',
  'private_local_embedding',
] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

/**
 * Data-handling constraints that travel with a semantic profile. They are a
 * declaration for the gateway and audit trail, not a claim that a candidate
 * has passed a regional/compliance validation.
 */
export interface ModelDataPolicy {
  /** No Site Builder call may bypass the configured OpenAI-compatible gateway. */
  transport: 'new_api_only' | 'none';
  /** Current known handling location for the selected route. */
  region: 'gateway_controlled' | 'private_local' | 'not_applicable';
  /** Site Builder tasks must not send personal data to model providers. */
  personalData: 'forbidden';
  /** The non-personal data scope a profile is allowed to process. */
  dataScope: 'company_facts_only' | 'not_applicable';
}

export interface ModelProfileDefinition {
  id: string;
  requiredCapabilities: readonly ModelCapability[];
  dataPolicy: ModelDataPolicy;
  description: string;
}

export interface ModelRouteSnapshot {
  primary: string;
  fallbacks: readonly string[];
}

export interface ModelCurrentRoute {
  state: 'currentRoute';
  lifecycle: 'active';
  route: ModelRouteSnapshot;
}

/** Candidate registration is deliberately not a traffic-switch instruction. */
export type ModelCandidateActivation = 'registry_only' | 'requires_task_evaluation' | 'requires_media_gateway';

export interface ModelCandidateRoute {
  state: Exclude<ModelRouteState, 'currentRoute'>;
  /** Candidates remain non-routable until MODEL-1/2 records an explicit promotion. */
  lifecycle: 'candidate' | 'preview_only' | 'active';
  route: ModelRouteSnapshot;
  activation: ModelCandidateActivation;
  notes?: string;
}

export const SITE_BUILDER_MODEL_POLICY_VERSION = 'site-builder-model-policy/v1' as const;

/**
 * Immutable-at-execution evidence of the resolved policy. `route` is the
 * requested model snapshot, rather than a provider's opaque alias expansion.
 */
export interface ModelExecutionPolicySnapshot {
  policyVersion: string;
  profile: string;
  routeState: 'currentRoute';
  lifecycle: 'active';
  source: 'registry' | 'env_override';
  dataPolicy: ModelDataPolicy;
  maxCostCents: number;
  route: ModelRouteSnapshot;
}

/** Per-attempt extension of the policy snapshot persisted in ai_trace.meta. */
export interface ModelExecutionTrace extends ModelExecutionPolicySnapshot {
  fallbackIndex: number;
}

export interface DeterministicFallback {
  id: string;
  description: string;
}
