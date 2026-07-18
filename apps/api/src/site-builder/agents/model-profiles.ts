import type { ModelDataPolicy, ModelProfileDefinition } from '@global/contracts';

const NO_MODEL_DATA_POLICY = Object.freeze({
  transport: 'none',
  region: 'not_applicable',
  personalData: 'forbidden',
  dataScope: 'not_applicable',
} as const satisfies ModelDataPolicy);

const GATEWAY_COMPANY_FACTS_ONLY = Object.freeze({
  transport: 'new_api_only',
  region: 'gateway_controlled',
  personalData: 'forbidden',
  dataScope: 'company_facts_only',
} as const satisfies ModelDataPolicy);

const GATEWAY_WORKSPACE_SITE_MATERIALS = Object.freeze({
  transport: 'new_api_only',
  region: 'gateway_controlled',
  personalData: 'workspace_controlled',
  dataScope: 'workspace_site_materials',
} as const satisfies ModelDataPolicy);

const PRIVATE_LOCAL_EMBEDDING_POLICY = Object.freeze({
  transport: 'new_api_only',
  region: 'private_local',
  personalData: 'forbidden',
  dataScope: 'company_facts_only',
} as const satisfies ModelDataPolicy);

/**
 * Stable semantic profiles for Site Builder tasks. These declare what a task
 * needs; they do not assert that a provider currently supplies that capability.
 */
const profiles = {
  deterministic: {
    id: 'deterministic',
    requiredCapabilities: [],
    dataPolicy: NO_MODEL_DATA_POLICY,
    description: 'Pure code path; never resolves to a provider model.',
  },
  'structured.default': {
    id: 'structured.default',
    requiredCapabilities: ['text_generation', 'structured_output'],
    dataPolicy: GATEWAY_WORKSPACE_SITE_MATERIALS,
    description:
      'Evidence-constrained structured text over tenant-controlled Site Builder material; deterministic publication gates remain authoritative.',
  },
  'reasoning.high': {
    id: 'reasoning.high',
    requiredCapabilities: ['text_generation', 'structured_output', 'reasoning'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Explicit, exceptional complex-repair escalation only.',
  },
  'copy.premium': {
    id: 'copy.premium',
    requiredCapabilities: ['text_generation', 'multilingual_copy'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Fact-constrained multilingual marketing copy.',
  },
  'text.summary': {
    id: 'text.summary',
    requiredCapabilities: ['text_generation', 'structured_output'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Low-authority summaries; deterministic gates retain control.',
  },
  'text.bulk': {
    id: 'text.bulk',
    requiredCapabilities: ['text_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Low-risk batch classification and rewrite tasks.',
  },
  'multimodal.review': {
    id: 'multimodal.review',
    requiredCapabilities: ['text_generation', 'vision_review', 'structured_output'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Screenshot and media findings only; cannot directly rewrite a site.',
  },
  'image.bulk.creative': {
    id: 'image.bulk.creative',
    requiredCapabilities: ['image_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Non-factual hero and abstract visual generation.',
  },
  'image.premium.design': {
    id: 'image.premium.design',
    requiredCapabilities: ['image_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Small-volume, high-value marketing compositions.',
  },
  'image.precise_edit': {
    id: 'image.precise_edit',
    requiredCapabilities: ['image_editing'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Mask-outside edits with product identity protection.',
  },
  'video.primary': {
    id: 'video.primary',
    requiredCapabilities: ['video_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Future image-to-video capability with static fallback.',
  },
  'video.premium': {
    id: 'video.premium',
    requiredCapabilities: ['video_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Future premium video work; no current Site Builder consumer.',
  },
  'speech.production': {
    id: 'speech.production',
    requiredCapabilities: ['speech_generation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Future voice generation; no current Site Builder consumer.',
  },
  transcription: {
    id: 'transcription',
    requiredCapabilities: ['transcription'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Future audio transcription; no current Site Builder consumer.',
  },
  'moderation.media': {
    id: 'moderation.media',
    requiredCapabilities: ['media_moderation'],
    dataPolicy: GATEWAY_COMPANY_FACTS_ONLY,
    description: 'Future media safety review; no current Site Builder consumer.',
  },
  'embedding.private': {
    id: 'embedding.private',
    requiredCapabilities: ['embedding', 'private_local_embedding'],
    dataPolicy: PRIVATE_LOCAL_EMBEDDING_POLICY,
    description: 'Private BGE-M3 knowledge-base embeddings.',
  },
} as const satisfies Record<string, ModelProfileDefinition>;

// `as const` is compile-time only. The registry holds these objects for the
// process lifetime, so protect the exported policy from runtime mutation too.
for (const profile of Object.values(profiles)) {
  Object.freeze(profile.requiredCapabilities);
  Object.freeze(profile);
}

export const SITE_BUILDER_MODEL_PROFILES = Object.freeze(profiles);

export type SiteBuilderModelProfileId = keyof typeof SITE_BUILDER_MODEL_PROFILES;
