import type { SiteBuilderModelProfileId } from './model-profiles';

export const SITE_BUILDER_TASK_IDS = [
  'site_builder.brand_profile',
  'site_builder.copy',
  'site_builder.design_spec',
  'site_builder.assemble',
  'site_builder.assembly_fix',
  'site_builder.qa_summarize',
  'site_builder.seo_review',
] as const;

export type SiteBuilderTaskId = (typeof SITE_BUILDER_TASK_IDS)[number];

export interface SiteBuilderTaskRouteBinding {
  profile: SiteBuilderModelProfileId;
  maxTokens: number;
  timeoutMs: number;
  maxCostCents: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

const ASSEMBLE_TIMEOUT_MS = 180_000;
// BrandProfile can legitimately use the gateway's single schema-repair call.
// The task-shaped Sonnet matrix observed 73s + 79s for that pair, so the old
// 150s aggregate deadline aborted a successful repair three seconds early.
// 240s leaves measured headroom while bounding primary + fallback to 8 minutes,
// below the refurbish Activity's 10-minute start-to-close deadline.
const BRAND_PROFILE_TIMEOUT_MS = 240_000;

const TASK_BINDINGS = Object.freeze({
  'site_builder.brand_profile': Object.freeze({
    profile: 'structured.workspace_materials',
    maxTokens: 12_000,
    timeoutMs: BRAND_PROFILE_TIMEOUT_MS,
    maxCostCents: 40,
  }),
  'site_builder.copy': Object.freeze({
    profile: 'copy.premium',
    maxTokens: 4000,
    timeoutMs: 120_000,
    maxCostCents: 20,
    reasoningEffort: 'low',
  }),
  'site_builder.design_spec': Object.freeze({
    profile: 'structured.default',
    maxTokens: 4000,
    timeoutMs: 120_000,
    maxCostCents: 20,
  }),
  'site_builder.assemble': Object.freeze({
    profile: 'structured.default',
    maxTokens: 16_000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
    maxCostCents: 20,
  }),
  'site_builder.assembly_fix': Object.freeze({
    profile: 'structured.default',
    maxTokens: 8000,
    timeoutMs: ASSEMBLE_TIMEOUT_MS,
    maxCostCents: 20,
  }),
  'site_builder.qa_summarize': Object.freeze({
    profile: 'text.summary',
    maxTokens: 3000,
    timeoutMs: 90_000,
    maxCostCents: 20,
  }),
  'site_builder.seo_review': Object.freeze({
    profile: 'text.summary',
    maxTokens: 3000,
    timeoutMs: 90_000,
    maxCostCents: 20,
  }),
} as const satisfies Record<SiteBuilderTaskId, SiteBuilderTaskRouteBinding>);

export function getSiteBuilderTaskRouteBinding(
  taskId: SiteBuilderTaskId,
): SiteBuilderTaskRouteBinding {
  const binding = TASK_BINDINGS[taskId];
  if (!binding) throw new Error(`unknown site_builder task: ${taskId}`);
  return { ...binding };
}
