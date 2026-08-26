import { getTask } from '../ai-tasks/task-registry';
import {
  MAX_EMAIL_GUESS_CONTACTS,
  MAX_EMAIL_PROBE_CANDIDATES,
  MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
} from '../discovery/execution-envelope';
import {
  MAX_QUERY_PLAN_INDUSTRY_TERMS,
  MAX_QUERY_PLAN_TARGET_COUNTRIES,
} from '../discovery/icp-to-cpv';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';
import { smtpRcptProbeTool } from '../tools/builtin-tools';
import type { Tool } from '../tools/tool-contract';
import type { WorkspaceExecutionBudgetRequest } from './execution-budget-request-scope';
import {
  WorkspaceTechnicalBudgetQuoteError,
  type WorkspaceTechnicalBudgetEnvelope,
  type WorkspaceTechnicalBudgetModelPolicy,
  type WorkspaceTechnicalBudgetPolicy,
  type WorkspaceTechnicalBudgetToolPolicy,
} from './workspace-technical-budget-quote';

export const WORKSPACE_EXECUTION_QUOTE_OPERATIONS = Object.freeze([
  'POST /companies',
  'POST /companies/:companyId/icps',
  'POST /icps/:icpId/query-plans',
  'POST /query-plans/:planId/execute',
  'POST /canonical-companies/:id/discover-contacts',
  'POST /canonical-companies/:id/guess-emails',
  'POST /contact-points/:pointId/verify',
] as const satisfies readonly WorkspaceExecutionBudgetRequest['operation'][]);

const MICROUSD_PER_CENT = 10_000n;
const REPRESENTATION_MINIMUM_MICROUSD = 1n;
const TAXONOMY_INDUSTRY_PASSES = 2;
const TAXONOMY_PRODUCT_REFINEMENTS = 2;

function unavailable(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
  );
}

function invalid(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_INVALID',
  );
}

function model(
  taskId: string,
  logicalInvocations: number,
): WorkspaceTechnicalBudgetModelPolicy {
  const task = getTask(taskId);
  if (
    !task ||
    !Number.isSafeInteger(logicalInvocations) ||
    logicalInvocations < 1 ||
    !Number.isSafeInteger(task.maxCostCents) ||
    (task.maxCostCents ?? 0) < 1 ||
    !Number.isSafeInteger(task.maxOutputTokens) ||
    task.maxOutputTokens < 1 ||
    typeof task.model !== 'string' ||
    task.model.length < 1
  ) {
    return unavailable();
  }
  return Object.freeze({
    taskId,
    requestedAlias: task.model,
    logicalInvocations,
    structuredWireUpperBound: MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND,
    maxCostCents: task.maxCostCents!,
    maxOutputTokens: task.maxOutputTokens,
  });
}

function tool(
  contract: Tool<unknown, unknown>,
  maxPhysicalInvocations: number,
): WorkspaceTechnicalBudgetToolPolicy {
  if (
    !Number.isSafeInteger(maxPhysicalInvocations) ||
    maxPhysicalInvocations < 1 ||
    !Number.isSafeInteger(contract.cost.estimatedCents) ||
    contract.cost.estimatedCents < 0
  ) {
    return unavailable();
  }
  return Object.freeze({
    toolId: contract.id,
    version: contract.version,
    maxPhysicalInvocations,
    estimatedCents: contract.cost.estimatedCents,
    costUnit: contract.cost.unit,
  });
}

function positiveBound(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid();
  }
  return value as number;
}

function emailGuessBounds(body: unknown): Readonly<{
  contacts: number;
  probesPerContact: number;
}> {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return invalid();
  }
  const record = (body ?? {}) as Record<string, unknown>;
  return Object.freeze({
    contacts: positiveBound(
      record.maxContacts,
      MAX_EMAIL_GUESS_CONTACTS,
      MAX_EMAIL_GUESS_CONTACTS,
    ),
    probesPerContact: positiveBound(
      record.maxProbe,
      MAX_EMAIL_PROBE_CANDIDATES,
      MAX_EMAIL_PROBE_CANDIDATES,
    ),
  });
}

function policy(
  request: WorkspaceExecutionBudgetRequest,
  models: readonly WorkspaceTechnicalBudgetModelPolicy[],
  tools: readonly WorkspaceTechnicalBudgetToolPolicy[],
  executionLimits: Readonly<Record<string, number>>,
): WorkspaceTechnicalBudgetPolicy {
  return Object.freeze({
    schemaVersion: 'workspace-execution-envelope/v1',
    requestScopeVersion: 'workspace-execution-budget-request-scope/v1',
    operation: request.operation,
    costBasis: 'backend_reservation_ceiling',
    currency: 'USD',
    unit: 'microusd',
    microUsdPerCent: MICROUSD_PER_CENT.toString(),
    representationMinimumMicrousd:
      REPRESENTATION_MINIMUM_MICROUSD.toString(),
    models: Object.freeze([...models]),
    tools: Object.freeze([...tools]),
    executionLimits: Object.freeze({ ...executionLimits }),
  });
}

function capMicrousd(value: WorkspaceTechnicalBudgetPolicy): bigint {
  const modelCents = value.models.reduce(
    (sum, item) =>
      sum +
      BigInt(item.logicalInvocations) *
        BigInt(item.structuredWireUpperBound) *
        BigInt(item.maxCostCents),
    0n,
  );
  const toolCents = value.tools.reduce(
    (sum, item) =>
      sum + BigInt(item.maxPhysicalInvocations) * BigInt(item.estimatedCents),
    0n,
  );
  const calculated = (modelCents + toolCents) * MICROUSD_PER_CENT;
  return calculated > 0n ? calculated : REPRESENTATION_MINIMUM_MICROUSD;
}

function ready(
  request: WorkspaceExecutionBudgetRequest,
  models: readonly WorkspaceTechnicalBudgetModelPolicy[],
  tools: readonly WorkspaceTechnicalBudgetToolPolicy[],
  executionLimits: Readonly<Record<string, number>>,
): WorkspaceTechnicalBudgetEnvelope {
  const manifest = policy(request, models, tools, executionLimits);
  return Object.freeze({
    requiredCapMicrousd: capMicrousd(manifest),
    policy: manifest,
  });
}

export function resolveWorkspaceTechnicalBudgetEnvelope(
  request: WorkspaceExecutionBudgetRequest,
): WorkspaceTechnicalBudgetEnvelope {
  switch (request.operation) {
    case 'POST /companies/:companyId/icps':
      return ready(request, [model('icp.design', 1)], [], {
        modelLogicalInvocations: 1,
      });
    case 'POST /icps/:icpId/query-plans': {
      const taxonomyLogicalInvocations =
        MAX_QUERY_PLAN_INDUSTRY_TERMS * TAXONOMY_INDUSTRY_PASSES +
        MAX_QUERY_PLAN_TARGET_COUNTRIES +
        TAXONOMY_PRODUCT_REFINEMENTS;
      return ready(
        request,
        [
          model('discovery.query_plan', 1),
          model('taxonomy.normalize', taxonomyLogicalInvocations),
        ],
        [],
        {
          industryTermsPerPass: MAX_QUERY_PLAN_INDUSTRY_TERMS,
          targetCountries: MAX_QUERY_PLAN_TARGET_COUNTRIES,
          taxonomyIndustryPasses: TAXONOMY_INDUSTRY_PASSES,
          taxonomyProductRefinements: TAXONOMY_PRODUCT_REFINEMENTS,
        },
      );
    }
    case 'POST /canonical-companies/:id/guess-emails': {
      const bounds = emailGuessBounds(request.body);
      const invocations = bounds.contacts * bounds.probesPerContact;
      return ready(
        request,
        [],
        [tool(smtpRcptProbeTool as Tool<unknown, unknown>, invocations)],
        {
          contacts: bounds.contacts,
          probesPerContact: bounds.probesPerContact,
          mxDnsReads: invocations,
          smtpRcptCommands: invocations * 2,
        },
      );
    }
    case 'POST /contact-points/:pointId/verify':
      return ready(
        request,
        [],
        [
          tool(
            smtpRcptProbeTool as Tool<unknown, unknown>,
            MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          ),
        ],
        {
          verifierInvocations: MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          mxDnsReads: MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          smtpRcptCommands:
            MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET * 2,
        },
      );
    case 'POST /companies':
    case 'POST /query-plans/:planId/execute':
    case 'POST /canonical-companies/:id/discover-contacts':
      return unavailable();
  }
}
