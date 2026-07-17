import { Injectable } from '@nestjs/common';
import {
  CancelledFailure,
  WorkflowFailedError,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import {
  KbIngestLauncher,
  KbIngestLaunchInput,
  RefurbishLauncher,
  RefurbishCancelResult,
  RefurbishLaunchInput,
  RefurbishLaunchResult,
  refurbishWorkflowId,
} from './refurbish-launcher';

const parsedCancelWaitMs = Number(
  process.env.SITE_BUILD_CANCEL_WAIT_MS ?? 30_000,
);
const CANCEL_WAIT_MS =
  Number.isFinite(parsedCancelWaitMs) && parsedCancelWaitMs > 0
    ? Math.min(parsedCancelWaitMs, 120_000)
    : 30_000;

async function waitForClose<T>(result: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Temporal cancellation close wait timed out')),
          CANCEL_WAIT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closedStatus(
  result: Promise<unknown>,
): Promise<RefurbishCancelResult> {
  try {
    await waitForClose(result);
    return { terminalStatus: 'completed' };
  } catch (error) {
    if (error instanceof WorkflowFailedError) {
      return {
        terminalStatus:
          error.cause instanceof CancelledFailure ? 'cancelled' : 'failed',
      };
    }
    throw error;
  }
}

function launchResult(
  workflowId: string,
  firstExecutionRunId: string | null | undefined,
): RefurbishLaunchResult {
  if (!firstExecutionRunId?.trim()) {
    throw new Error('Temporal did not return an execution run id');
  }
  return { workflowId, firstExecutionRunId };
}

/**
 * 精装修触发的 Temporal 实现（09 §2.2）：workflowId 以 buildRunId 幂等，
 * 重复触发同一 run 不会并行起两条 workflow（镜像 demo v0 先例）。
 */
@Injectable()
export class TemporalRefurbishLauncher implements RefurbishLauncher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchRefurbish(
    input: RefurbishLaunchInput,
  ): Promise<RefurbishLaunchResult> {
    const workflowId = refurbishWorkflowId(input.buildRunId);
    try {
      const handle = await this.temporal.client.workflow.start(
        'refurbishWorkflow',
        {
          taskQueue: UNDERSTANDING_TASK_QUEUE,
          workflowId,
          args: [input],
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
        },
      );
      return launchResult(workflowId, handle.firstExecutionRunId);
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      return this.recoverRefurbish(input);
    }
  }

  async recoverRefurbish(
    input: RefurbishLaunchInput,
  ): Promise<RefurbishLaunchResult> {
    const workflowId = refurbishWorkflowId(input.buildRunId);
    const description = await this.temporal.client.workflow
      .getHandle(workflowId)
      .describe();
    return launchResult(
      workflowId,
      description.raw.workflowExecutionInfo?.firstRunId || description.runId,
    );
  }

  async cancelRefurbish(
    buildRunId: string,
    workflowId?: string | null,
  ): Promise<RefurbishCancelResult> {
    const handle = this.temporal.client.workflow.getHandle(
      workflowId ?? refurbishWorkflowId(buildRunId),
    );
    try {
      await handle.cancel();
    } catch {
      // The execution may have closed between the DB read and cancel RPC. result() distinguishes
      // a truly closed chain from transport uncertainty; the latter times out and remains 502.
    }
    return closedStatus(handle.result());
  }
}

/**
 * KB 摄入触发的 Temporal 实现：workflowId 与 input 都以 assetId 绑定。
 * 一条 workflow 只处理一份素材；周期 recovery sweep 另行捞 due/过期 lease。
 */
@Injectable()
export class TemporalKbIngestLauncher implements KbIngestLauncher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchKbIngest(input: KbIngestLaunchInput): Promise<void> {
    await this.temporal.client.workflow.start('kbIngestWorkflow', {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: `site-kb-${input.assetId}`,
      args: [input],
    });
  }
}
