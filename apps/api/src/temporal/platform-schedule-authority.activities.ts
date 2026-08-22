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
