import { ApplicationFailure } from "@temporalio/workflow";

/** Replay fixture only; excluded from the product TypeScript build. */
export async function failureBoundaryReplayFixture(): Promise<never> {
  throw ApplicationFailure.nonRetryable(
    "synthetic-history-secret",
    "INPUT_INVALID",
    { diagnostic: "synthetic-history-secret" },
  );
}

export { backlogSweepWorkflow } from "../backlog.workflow";
