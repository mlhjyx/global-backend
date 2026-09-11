import type { PlatformEgressOperation } from "../platform-authority/platform-egress-operation";
import {
  ApplicationFailure,
  Context as ActivityContext,
} from "@temporalio/activity";
import { ExecutionBudgetGrantError } from "../execution-budget/execution-budget-authority.types";
import {
  BudgetStoreUnavailableError,
  type BudgetStore,
  UnavailableBudgetStore,
} from "../tools/budget-store";
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  parsePlatformExecutionBudgetBinding,
  parsePlatformScheduleAuthorityScope,
  platformScheduleAccountKey,
  type PlatformExecutionBudgetBinding,
  type PlatformScheduleAuthorityActivityInput,
  type PlatformScheduleAuthorityScope,
  type PlatformScheduleId,
} from "./platform-schedule-authority";
import type { PlatformEgressFence } from "../platform-authority/platform-egress-fence";
import type { PlatformEgressBinding } from "../platform-authority/platform-egress-fence";

export interface AdmitPlatformScheduleInput {
  readonly executionContractVersion?: 1;
  readonly executionScope?: PlatformScheduleAuthorityScope;
  readonly workflowRunId: string;
}

function nonRetryable(code: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(code, code);
}

function safeAuthorityFailure(error: unknown): ApplicationFailure {
  if (error instanceof ExecutionBudgetGrantError) {
    return nonRetryable(error.code);
  }
  if (error instanceof BudgetStoreUnavailableError) {
    return nonRetryable("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");
  }
  return nonRetryable("EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE");
}

function activityWorkflowRunId(
  injected?: () => string | undefined,
): string | undefined {
  try {
    return (
      injected?.() ?? ActivityContext.current().info.workflowExecution?.runId
    );
  } catch {
    return undefined;
  }
}

function activityWorkflowId(): string | undefined {
  try {
    return ActivityContext.current().info.workflowExecution?.workflowId;
  } catch {
    return undefined;
  }
}

/**
 * Build the only platform physical-wire dispatcher exposed to activities.
 * Workflow identity is read from Temporal and policy/expiry are resolved by
 * the durable authority port; no activity argument can forge either value.
 */
export function platformEgressDispatcher(input: {
  readonly fence: PlatformEgressFence;
  readonly binding: PlatformExecutionBudgetBinding;
  readonly workflowId?: string;
}): {
  authorizeAndDispatch: <T>(
    operation: PlatformEgressOperation,
    executePhysicalWire: () => Promise<T>,
  ) => Promise<T>;
} {
  const workflowId = input.workflowId ?? activityWorkflowId();
  if (!workflowId) {
    return {
      authorizeAndDispatch: async () => {
        throw nonRetryable("PLATFORM_EGRESS_WORKFLOW_ID_UNAVAILABLE");
      },
    };
  }
  const binding: PlatformEgressBinding = {
    authorityId: input.binding.authorityId,
    scheduleId: input.binding.scheduleId,
    workflowId,
    workflowRunId: input.binding.workflowRunId,
    scheduleRequestSha256: input.binding.requestSha256,
    accountKey: input.binding.accountKey,
  };
  return {
    authorizeAndDispatch: (operation, executePhysicalWire) =>
      input.fence.authorizeAndDispatchPlatformEgress(
        binding,
        operation,
        executePhysicalWire,
      ),
  };
}

export function createPlatformScheduleAuthorityActivities(deps: {
  budgetStore?: BudgetStore;
}) {
  const budgets =
    deps.budgetStore ??
    new UnavailableBudgetStore(
      "platform schedule authority requires an authoritative BudgetStore",
    );
  return {
    async admitPlatformSchedule(
      input: AdmitPlatformScheduleInput,
    ): Promise<PlatformExecutionBudgetBinding> {
      try {
        if (
          input.executionContractVersion !==
          PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION
        ) {
          throw new Error("invalid contract version");
        }
        const executionScope = parsePlatformScheduleAuthorityScope(
          input.executionScope,
        );
        const accountKey = platformScheduleAccountKey(
          executionScope,
          input.workflowRunId,
        );
        const admitted = await budgets.admitPlatformRun({
          ...executionScope,
          workflowRunId: input.workflowRunId,
          accountKey,
        });
        return parsePlatformExecutionBudgetBinding({
          authorityId: admitted.authorityId,
          scopeKey: "platform",
          accountKey,
          ...executionScope,
          workflowRunId: input.workflowRunId,
          admissionReplay: admitted.replay,
        });
      } catch (error) {
        if (error instanceof ApplicationFailure) throw error;
        throw safeAuthorityFailure(error);
      }
    },
  };
}

export async function attestPlatformScheduleActivity(input: {
  readonly args: PlatformScheduleAuthorityActivityInput;
  readonly budgetStore: BudgetStore;
  readonly scheduleId: PlatformScheduleId;
  readonly activityRunId?: () => string | undefined;
}): Promise<PlatformExecutionBudgetBinding> {
  try {
    if (
      input.args.executionContractVersion !==
      PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION
    ) {
      throw nonRetryable("EXECUTION_BUDGET_LEGACY_HISTORY_PARKED");
    }
    const workflowRunId = activityWorkflowRunId(input.activityRunId);
    if (!workflowRunId) {
      throw nonRetryable("EXECUTION_BUDGET_LEGACY_HISTORY_PARKED");
    }
    const binding = parsePlatformExecutionBudgetBinding(
      input.args.executionBudget,
      {
        ...parsePlatformScheduleAuthorityScope(
          PLATFORM_SCHEDULE_AUTHORITY_SCOPES[input.scheduleId],
          input.scheduleId,
        ),
        workflowRunId,
      },
    );
    await input.budgetStore.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey: binding.accountKey,
    });
    return binding;
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    throw safeAuthorityFailure(error);
  }
}

export type PlatformScheduleAuthorityActivities = ReturnType<
  typeof createPlatformScheduleAuthorityActivities
>;
