import { Injectable } from "@nestjs/common";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { TemporalClient } from "../temporal/temporal.client";
import { UNDERSTANDING_TASK_QUEUE } from "../temporal/understanding.constants";
import {
  DemoV0Launcher,
  DemoV0LaunchInput,
  DemoV0LaunchResult,
} from "./demo-launcher";

function launchResult(
  firstExecutionRunId: string | null | undefined,
): DemoV0LaunchResult {
  if (!firstExecutionRunId?.trim()) {
    throw new Error("Temporal did not return an execution run id");
  }
  return { firstExecutionRunId };
}

/**
 * demo v0 触发的 Temporal 实现（02 §4）：workflowId 以 buildRunId 幂等，
 * 重复触发同一 run 不会并行起两条 workflow。
 */
@Injectable()
export class TemporalDemoV0Launcher implements DemoV0Launcher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchDemoV0(input: DemoV0LaunchInput): Promise<DemoV0LaunchResult> {
    const workflowId = this.workflowId(input);
    try {
      const handle = await this.temporal.client.workflow.start(
        "demoV0Workflow",
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          workflowId,
          args: [input],
          // Closed duplicate = the same build already ran; running duplicate = reuse its handle.
          // Together these policies make retry safe across an HTTP/DB ACK-loss window.
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        },
      );
      return launchResult(handle.firstExecutionRunId);
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;

      // REJECT_DUPLICATE means a closed execution already exists. Recover its chain head so
      // IntakeService can durably acknowledge the launch instead of starting a second build.
      return this.recoverDemoV0(input);
    }
  }

  async recoverDemoV0(input: DemoV0LaunchInput): Promise<DemoV0LaunchResult> {
    const description = await this.temporal.client.workflow
      .getHandle(this.workflowId(input))
      .describe();
    const firstExecutionRunId =
      description.raw.workflowExecutionInfo?.firstRunId || description.runId;
    return launchResult(firstExecutionRunId);
  }

  private workflowId(input: DemoV0LaunchInput): string {
    return `site-demo-${input.buildRunId}`;
  }
}
