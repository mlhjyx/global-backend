import { Injectable } from '@nestjs/common';
import { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import {
  KbIngestLauncher,
  KbIngestLaunchInput,
  RefurbishLauncher,
  RefurbishLaunchInput,
} from './refurbish-launcher';

/**
 * 精装修触发的 Temporal 实现（09 §2.2）：workflowId 以 buildRunId 幂等，
 * 重复触发同一 run 不会并行起两条 workflow（镜像 demo v0 先例）。
 */
@Injectable()
export class TemporalRefurbishLauncher implements RefurbishLauncher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchRefurbish(input: RefurbishLaunchInput): Promise<void> {
    await this.temporal.client.workflow.start('refurbishWorkflow', {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: `site-refurbish-${input.buildRunId}`,
      args: [input],
    });
  }

  async cancelRefurbish(buildRunId: string): Promise<void> {
    const handle = this.temporal.client.workflow.getHandle(`site-refurbish-${buildRunId}`);
    await handle.cancel();
  }
}

/**
 * KB 摄入触发的 Temporal 实现：workflowId 以 assetId 幂等——每次 commit 恰起一条，
 * activity 内按 siteId 扫全部 queued（天然把并发 commit 的文档一起消化）。
 */
@Injectable()
export class TemporalKbIngestLauncher implements KbIngestLauncher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchKbIngest(input: KbIngestLaunchInput): Promise<void> {
    await this.temporal.client.workflow.start('kbIngestWorkflow', {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: `site-kb-${input.assetId}`,
      args: [{ workspaceId: input.workspaceId, siteId: input.siteId }],
    });
  }
}
