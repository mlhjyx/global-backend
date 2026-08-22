import {
  ApplicationFailure,
  patched,
  workflowInfo,
} from "@temporalio/workflow";
import {
  PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
  PLATFORM_SCHEDULE_AUTHORITY_PATCH,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  parsePlatformExecutionBudgetBinding,
  parsePlatformScheduleAuthorityScope,
  type PlatformExecutionBudgetBinding,
  type PlatformScheduleId,
  type PlatformScheduleWorkflowInput,
} from "./platform-schedule-authority";
import type { PlatformScheduleAuthorityActivities } from "./platform-schedule-authority.activities";

function invalidInput(): never {
  throw ApplicationFailure.nonRetryable(
    "EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID",
    "EXECUTION_BUDGET_WORKFLOW_INPUT_INVALID",
  );
}

export async function admitPlatformScheduleForWorkflow(input: {
  readonly activities: PlatformScheduleAuthorityActivities;
  readonly scheduleId: PlatformScheduleId;
  readonly workflowInput?: PlatformScheduleWorkflowInput;
}): Promise<PlatformExecutionBudgetBinding | undefined> {
  if (!patched(PLATFORM_SCHEDULE_AUTHORITY_PATCH)) return undefined;
  if (
    input.workflowInput?.executionContractVersion !==
    PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION
  ) {
    invalidInput();
  }
  let executionScope;
  try {
    executionScope = parsePlatformScheduleAuthorityScope(
      input.workflowInput.executionScope,
      input.scheduleId,
    );
  } catch {
    invalidInput();
  }
  const workflowRunId = workflowInfo().runId;
  const admitted = await input.activities.admitPlatformSchedule({
    executionContractVersion: PLATFORM_SCHEDULE_AUTHORITY_CONTRACT_VERSION,
    executionScope,
    workflowRunId,
  });
  try {
    return parsePlatformExecutionBudgetBinding(admitted, {
      ...PLATFORM_SCHEDULE_AUTHORITY_SCOPES[input.scheduleId],
      workflowRunId,
    });
  } catch {
    invalidInput();
  }
}
