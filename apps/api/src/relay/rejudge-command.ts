import { WorkflowIdReusePolicy } from "@temporalio/client";
import type { Duration } from "@temporalio/common";
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from "../execution-budget/execution-budget-binding";
import { ICP_REJUDGE_MAX_COMPANIES_LIMIT } from "../execution-budget/icp-rejudge-budget-request";
import {
  REJUDGE_EXECUTION_TIMEOUT,
  REJUDGE_WORKFLOW,
} from "../temporal/understanding.constants";
import { formatTenantWorkflowId } from "../temporal/tenant-workflow-id";
import { resolveCustomerTaskQueue } from "../temporal/tenant-task-queues";
import { NonRetryableOutboxCommandError } from "./discovery-run-command";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RejudgeWorkflowBatch {
  readonly index: number;
  readonly companyIds: readonly string[];
}

export interface RejudgeWorkflowInput {
  readonly rejudgeId: string;
  readonly workspaceId: string;
  readonly icpId: string;
  readonly executionContractVersion: 2;
  readonly budgetBinding: ExecutionBudgetBinding;
  readonly batches: readonly RejudgeWorkflowBatch[];
  readonly refreshCorroboration: boolean;
  readonly refreshWebsiteProfile: boolean;
}

function park(): never {
  throw new NonRetryableOutboxCommandError(
    "EXECUTION_BUDGET_OUTBOX_COMMAND_PARKED",
  );
}

function parseBatches(value: unknown): readonly RejudgeWorkflowBatch[] {
  if (!Array.isArray(value) || value.length === 0) park();
  let totalCompanies = 0;
  const batches: RejudgeWorkflowBatch[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) park();
    const record = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.index) ||
      (record.index as number) < 0 ||
      !Array.isArray(record.companyIds) ||
      record.companyIds.length === 0
    ) {
      park();
    }
    const companyIds: string[] = [];
    for (const id of record.companyIds) {
      if (typeof id !== "string" || !UUID.test(id)) park();
      companyIds.push(id.toLowerCase());
    }
    totalCompanies += companyIds.length;
    if (totalCompanies > ICP_REJUDGE_MAX_COMPANIES_LIMIT) park();
    batches.push({ index: record.index as number, companyIds });
  }
  return batches;
}

export function parseRejudgeOutboxCommand(ev: {
  schemaVersion: number;
  workspaceId: string;
  aggregateId: string;
  payload: unknown;
}): RejudgeWorkflowInput {
  if (ev.schemaVersion !== 2) park();
  if (!ev.payload || typeof ev.payload !== "object" || Array.isArray(ev.payload)) {
    park();
  }
  const payload = ev.payload as Record<string, unknown>;
  if (
    typeof payload.rejudgeId !== "string" ||
    !UUID.test(payload.rejudgeId) ||
    payload.workspaceId !== ev.workspaceId ||
    payload.icpId !== ev.aggregateId ||
    payload.executionContractVersion !== 2 ||
    typeof payload.refreshCorroboration !== "boolean" ||
    typeof payload.refreshWebsiteProfile !== "boolean"
  ) {
    park();
  }
  let budgetBinding: ExecutionBudgetBinding;
  try {
    budgetBinding = parseExecutionBudgetBinding(payload.budgetBinding, {
      scopeKey: ev.workspaceId,
      purpose: "icp.rejudge",
      subjectType: "icp",
    });
  } catch {
    park();
  }
  if (budgetBinding.subjectId !== ev.aggregateId) park();

  return {
    rejudgeId: payload.rejudgeId,
    workspaceId: ev.workspaceId,
    icpId: ev.aggregateId,
    executionContractVersion: 2,
    budgetBinding,
    batches: parseBatches(payload.batches),
    refreshCorroboration: payload.refreshCorroboration,
    refreshWebsiteProfile: payload.refreshWebsiteProfile,
  };
}

export async function dispatchRejudgeCommand(
  ev: {
    schemaVersion: number;
    workspaceId: string;
    aggregateId: string;
    payload: unknown;
  },
  startWorkflow: (
    workflowType: string,
    options: {
      taskQueue: string;
      workflowId: string;
      args: unknown[];
      workflowIdReusePolicy?: WorkflowIdReusePolicy;
      workflowExecutionTimeout?: Duration;
    },
    what: string,
  ) => Promise<void>,
): Promise<void> {
  const command = parseRejudgeOutboxCommand(ev);
  await startWorkflow(
    REJUDGE_WORKFLOW,
    {
      taskQueue: resolveCustomerTaskQueue("batch"),
      workflowId: formatTenantWorkflowId(command.workspaceId, "rejudge", command.rejudgeId),
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowExecutionTimeout: REJUDGE_EXECUTION_TIMEOUT,
      args: [command],
    },
    `rejudge workflow ${command.rejudgeId} for icp ${command.icpId}`,
  );
}
