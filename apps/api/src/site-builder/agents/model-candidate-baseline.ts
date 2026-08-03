import rawBaseline from './model-candidate-baseline.json';
import {
  SITE_BUILDER_MODEL_PROFILES,
  type SiteBuilderModelProfileId,
} from './model-profiles';
import {
  SITE_BUILDER_TASK_IDS,
  type SiteBuilderTaskId,
} from './task-route-bindings';

export const MODEL_CANDIDATE_STATUSES = [
  'runnable',
  'deferred',
  'preview',
  'legacy-only',
] as const;

export type ModelCandidateStatus = (typeof MODEL_CANDIDATE_STATUSES)[number];

export const MODEL_CANDIDATE_DOMAINS = [
  'text',
  'image',
  'video',
  'embedding',
] as const;

export type ModelCandidateDomain = (typeof MODEL_CANDIDATE_DOMAINS)[number];

export const MODEL_CANDIDATE_PROTOCOLS = [
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generate-content',
  'openai-images-generations',
  'openai-images-edits',
  'openai-videos',
  'openai-embeddings',
] as const;

export type ModelCandidateProtocol = (typeof MODEL_CANDIDATE_PROTOCOLS)[number];

export const MODEL_CANDIDATE_PREFLIGHTS = ['none', 'capability_probe'] as const;

export type ModelCandidatePreflight =
  (typeof MODEL_CANDIDATE_PREFLIGHTS)[number];

export interface ModelCandidateCatalogEntry {
  alias: string;
  domain: ModelCandidateDomain;
  status: ModelCandidateStatus;
  expectedProtocols: readonly ModelCandidateProtocol[];
  boundary: string;
}

export interface ModelProfileCandidate {
  alias: string;
  expectedProtocol: ModelCandidateProtocol;
  preflight: ModelCandidatePreflight;
  gate: string;
}

export interface ModelProfileCandidatePool {
  profile: SiteBuilderModelProfileId;
  activation: 'requires_task_evaluation' | 'requires_media_gateway';
  candidates: readonly ModelProfileCandidate[];
}

export interface ModelTaskEvaluationPool {
  taskId: SiteBuilderTaskId;
  profile: SiteBuilderModelProfileId;
}

interface ModelCandidateBaseline {
  schemaVersion: 'site-builder-model-candidate-baseline/v1';
  candidateBaselineId: string;
  effectiveDate: string;
  scope: 'non_runtime_evaluation_candidates';
  statusDefinitions: Readonly<Record<ModelCandidateStatus, string>>;
  models: readonly ModelCandidateCatalogEntry[];
  profileCandidatePools: readonly ModelProfileCandidatePool[];
  taskEvaluationPools: readonly ModelTaskEvaluationPool[];
  evaluationPolicy: {
    ordering: readonly string[];
    taskWindow: string;
    diagnosticWindow: string;
    qualityValidLateClass: string;
    contentInvalidClass: string;
    absoluteStop: string;
    promotionRule: string;
  };
  followUpPrs: readonly {
    order: number;
    name: string;
    output: string;
  }[];
  documentationPolicy: {
    canonicalDocument: string;
    requiredBaselineIdReferences: readonly string[];
    activeRouteDocuments: readonly string[];
    registrySource: string;
  };
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`invalid model candidate baseline: ${message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, path: string): asserts value is string {
  invariant(
    typeof value === 'string' && value.length > 0,
    `${path} must be a non-empty string`,
  );
}

function assertStringArray(
  value: unknown,
  path: string,
): asserts value is string[] {
  invariant(
    Array.isArray(value) && value.length > 0,
    `${path} must be a non-empty array`,
  );
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
}

function assertCandidateBaseline(
  value: unknown,
): asserts value is ModelCandidateBaseline {
  invariant(isRecord(value), 'root must be an object');
  invariant(
    value.schemaVersion === 'site-builder-model-candidate-baseline/v1',
    'schemaVersion must be site-builder-model-candidate-baseline/v1',
  );
  assertString(value.candidateBaselineId, 'candidateBaselineId');
  invariant(
    /^site-builder-model-candidate-baseline\/[0-9]{4}-[0-9]{2}-[0-9]{2}-v[1-9][0-9]*$/.test(
      value.candidateBaselineId,
    ),
    'candidateBaselineId must be date-versioned and independent of execution policy versions',
  );
  assertString(value.effectiveDate, 'effectiveDate');
  invariant(
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value.effectiveDate),
    'effectiveDate must be YYYY-MM-DD',
  );
  invariant(
    value.candidateBaselineId.includes(value.effectiveDate),
    'candidateBaselineId date must match effectiveDate',
  );
  invariant(
    value.scope === 'non_runtime_evaluation_candidates',
    'scope must be non_runtime_evaluation_candidates',
  );
  invariant(
    isRecord(value.statusDefinitions),
    'statusDefinitions must be an object',
  );
  for (const status of MODEL_CANDIDATE_STATUSES) {
    assertString(
      value.statusDefinitions[status],
      `statusDefinitions.${status}`,
    );
  }
  invariant(
    Object.keys(value.statusDefinitions).length ===
      MODEL_CANDIDATE_STATUSES.length,
    'statusDefinitions must declare exactly the four baseline states',
  );

  invariant(
    Array.isArray(value.models) && value.models.length > 0,
    'models must be non-empty',
  );
  const aliases = new Map<string, ModelCandidateCatalogEntry>();
  for (const [index, rawModel] of value.models.entries()) {
    invariant(isRecord(rawModel), `models[${index}] must be an object`);
    assertString(rawModel.alias, `models[${index}].alias`);
    invariant(
      !aliases.has(rawModel.alias),
      `duplicate model alias ${rawModel.alias}`,
    );
    invariant(
      MODEL_CANDIDATE_DOMAINS.includes(rawModel.domain as ModelCandidateDomain),
      `models[${index}].domain is unknown`,
    );
    invariant(
      MODEL_CANDIDATE_STATUSES.includes(
        rawModel.status as ModelCandidateStatus,
      ),
      `models[${index}].status is unknown`,
    );
    assertStringArray(
      rawModel.expectedProtocols,
      `models[${index}].expectedProtocols`,
    );
    for (const protocol of rawModel.expectedProtocols) {
      invariant(
        MODEL_CANDIDATE_PROTOCOLS.includes(protocol as ModelCandidateProtocol),
        `models[${index}] has unknown protocol ${protocol}`,
      );
    }
    invariant(
      new Set(rawModel.expectedProtocols).size ===
        rawModel.expectedProtocols.length,
      `models[${index}].expectedProtocols must be unique`,
    );
    assertString(rawModel.boundary, `models[${index}].boundary`);
    aliases.set(
      rawModel.alias,
      rawModel as unknown as ModelCandidateCatalogEntry,
    );
  }

  invariant(
    Array.isArray(value.profileCandidatePools),
    'profileCandidatePools must be an array',
  );
  const profilePools = new Set<string>();
  for (const [index, rawPool] of value.profileCandidatePools.entries()) {
    invariant(
      isRecord(rawPool),
      `profileCandidatePools[${index}] must be an object`,
    );
    assertString(rawPool.profile, `profileCandidatePools[${index}].profile`);
    invariant(
      rawPool.profile in SITE_BUILDER_MODEL_PROFILES,
      `profileCandidatePools[${index}].profile is unknown`,
    );
    invariant(
      !profilePools.has(rawPool.profile),
      `duplicate profile candidate pool ${rawPool.profile}`,
    );
    profilePools.add(rawPool.profile);
    invariant(
      rawPool.activation === 'requires_task_evaluation' ||
        rawPool.activation === 'requires_media_gateway',
      `profileCandidatePools[${index}].activation is unknown`,
    );
    invariant(
      Array.isArray(rawPool.candidates) && rawPool.candidates.length > 0,
      `profileCandidatePools[${index}].candidates must be non-empty`,
    );
    const poolAliases = new Set<string>();
    for (const [candidateIndex, rawCandidate] of rawPool.candidates.entries()) {
      invariant(
        isRecord(rawCandidate),
        `profileCandidatePools[${index}].candidates[${candidateIndex}] must be an object`,
      );
      assertString(
        rawCandidate.alias,
        `profileCandidatePools[${index}].candidates[${candidateIndex}].alias`,
      );
      invariant(
        !poolAliases.has(rawCandidate.alias),
        `duplicate ${rawCandidate.alias} in profile ${rawPool.profile}`,
      );
      poolAliases.add(rawCandidate.alias);
      const catalogEntry = aliases.get(rawCandidate.alias);
      invariant(
        catalogEntry,
        `profile ${rawPool.profile} references unknown alias ${rawCandidate.alias}`,
      );
      invariant(
        catalogEntry.status !== 'legacy-only',
        `legacy-only alias ${rawCandidate.alias} cannot enter a target pool`,
      );
      assertString(
        rawCandidate.expectedProtocol,
        `profileCandidatePools[${index}].candidates[${candidateIndex}].expectedProtocol`,
      );
      invariant(
        catalogEntry.expectedProtocols.includes(
          rawCandidate.expectedProtocol as ModelCandidateProtocol,
        ),
        `profile ${rawPool.profile} protocol ${rawCandidate.expectedProtocol} is not registered for ${rawCandidate.alias}`,
      );
      invariant(
        MODEL_CANDIDATE_PREFLIGHTS.includes(
          rawCandidate.preflight as ModelCandidatePreflight,
        ),
        `profileCandidatePools[${index}].candidates[${candidateIndex}].preflight is unknown`,
      );
      assertString(
        rawCandidate.gate,
        `profileCandidatePools[${index}].candidates[${candidateIndex}].gate`,
      );
    }
  }

  invariant(
    Array.isArray(value.taskEvaluationPools),
    'taskEvaluationPools must be an array',
  );
  const taskIds = new Set<string>();
  for (const [index, rawTaskPool] of value.taskEvaluationPools.entries()) {
    invariant(
      isRecord(rawTaskPool),
      `taskEvaluationPools[${index}] must be an object`,
    );
    assertString(rawTaskPool.taskId, `taskEvaluationPools[${index}].taskId`);
    assertString(rawTaskPool.profile, `taskEvaluationPools[${index}].profile`);
    invariant(
      SITE_BUILDER_TASK_IDS.includes(rawTaskPool.taskId as SiteBuilderTaskId),
      `taskEvaluationPools[${index}].taskId is unknown`,
    );
    invariant(
      !taskIds.has(rawTaskPool.taskId),
      `duplicate task evaluation pool ${rawTaskPool.taskId}`,
    );
    taskIds.add(rawTaskPool.taskId);
    invariant(
      profilePools.has(rawTaskPool.profile),
      `task ${rawTaskPool.taskId} references profile without a candidate pool`,
    );
  }
  invariant(
    SITE_BUILDER_TASK_IDS.every((taskId) => taskIds.has(taskId)),
    'taskEvaluationPools must cover every current Site Builder task exactly once',
  );

  invariant(
    isRecord(value.evaluationPolicy),
    'evaluationPolicy must be an object',
  );
  assertStringArray(
    value.evaluationPolicy.ordering,
    'evaluationPolicy.ordering',
  );
  invariant(
    new Set(value.evaluationPolicy.ordering).size ===
      value.evaluationPolicy.ordering.length,
    'evaluationPolicy.ordering must be unique',
  );
  for (const key of [
    'taskWindow',
    'diagnosticWindow',
    'qualityValidLateClass',
    'contentInvalidClass',
    'absoluteStop',
    'promotionRule',
  ] as const) {
    assertString(value.evaluationPolicy[key], `evaluationPolicy.${key}`);
  }

  invariant(
    Array.isArray(value.followUpPrs) && value.followUpPrs.length > 0,
    'followUpPrs must be a non-empty array',
  );
  const followUpOrders = new Set<number>();
  let previousFollowUpOrder = 0;
  for (const [index, rawFollowUp] of value.followUpPrs.entries()) {
    invariant(isRecord(rawFollowUp), `followUpPrs[${index}] must be an object`);
    invariant(
      Number.isInteger(rawFollowUp.order) &&
        (rawFollowUp.order as number) > previousFollowUpOrder &&
        !followUpOrders.has(rawFollowUp.order as number),
      `followUpPrs[${index}].order must be a unique positive ascending integer`,
    );
    previousFollowUpOrder = rawFollowUp.order as number;
    followUpOrders.add(previousFollowUpOrder);
    assertString(rawFollowUp.name, `followUpPrs[${index}].name`);
    assertString(rawFollowUp.output, `followUpPrs[${index}].output`);
  }
  invariant(
    isRecord(value.documentationPolicy),
    'documentationPolicy must be an object',
  );
  assertString(
    value.documentationPolicy.canonicalDocument,
    'documentationPolicy.canonicalDocument',
  );
  assertStringArray(
    value.documentationPolicy.requiredBaselineIdReferences,
    'documentationPolicy.requiredBaselineIdReferences',
  );
  invariant(
    new Set(value.documentationPolicy.requiredBaselineIdReferences).size ===
      value.documentationPolicy.requiredBaselineIdReferences.length,
    'documentationPolicy.requiredBaselineIdReferences must be unique',
  );
  assertStringArray(
    value.documentationPolicy.activeRouteDocuments,
    'documentationPolicy.activeRouteDocuments',
  );
  invariant(
    new Set(value.documentationPolicy.activeRouteDocuments).size ===
      value.documentationPolicy.activeRouteDocuments.length,
    'documentationPolicy.activeRouteDocuments must be unique',
  );
  assertString(
    value.documentationPolicy.registrySource,
    'documentationPolicy.registrySource',
  );
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

assertCandidateBaseline(rawBaseline);
const validatedBaseline: ModelCandidateBaseline = rawBaseline;

export const SITE_BUILDER_MODEL_CANDIDATE_BASELINE =
  deepFreeze(validatedBaseline);

export const SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID =
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE.candidateBaselineId;

export function getModelCandidateCatalogEntry(
  alias: string,
): ModelCandidateCatalogEntry {
  const entry = SITE_BUILDER_MODEL_CANDIDATE_BASELINE.models.find(
    (model) => model.alias === alias,
  );
  if (!entry) throw new Error(`unknown model candidate alias: ${alias}`);
  return entry;
}

export function getModelProfileCandidatePool(
  profile: SiteBuilderModelProfileId,
): ModelProfileCandidatePool | null {
  return (
    SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.find(
      (pool) => pool.profile === profile,
    ) ?? null
  );
}
