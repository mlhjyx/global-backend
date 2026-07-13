/**
 * demo v0 生成的触发口（02 §4 快速通道）。
 * IntakeService 只依赖此接口；Temporal 实现见 temporal-demo-launcher.ts，
 * 模块装配时以 provider token 注入，保持 intake 可独立单测。
 */

export const DEMO_V0_LAUNCHER = Symbol('DEMO_V0_LAUNCHER');

export interface DemoV0LaunchInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
}

export interface DemoV0Launcher {
  launchDemoV0(input: DemoV0LaunchInput): Promise<void>;
}
