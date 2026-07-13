import { Injectable } from '@nestjs/common';
import { TemporalClient } from '../temporal/temporal.client';
import { UNDERSTANDING_TASK_QUEUE } from '../temporal/understanding.constants';
import { DemoV0Launcher, DemoV0LaunchInput } from './demo-launcher';

/**
 * demo v0 触发的 Temporal 实现（02 §4）：workflowId 以 buildRunId 幂等，
 * 重复触发同一 run 不会并行起两条 workflow。
 */
@Injectable()
export class TemporalDemoV0Launcher implements DemoV0Launcher {
  constructor(private readonly temporal: TemporalClient) {}

  async launchDemoV0(input: DemoV0LaunchInput): Promise<void> {
    await this.temporal.client.workflow.start('demoV0Workflow', {
      taskQueue: UNDERSTANDING_TASK_QUEUE,
      workflowId: `site-demo-${input.buildRunId}`,
      args: [input],
    });
  }
}
