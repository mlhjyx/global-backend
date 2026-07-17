/**
 * 精装修与 KB 摄入的触发接口（09 §2.2，镜像 demo-launcher 的 Symbol+DI 模式）：
 * builds.service / assets.controller 不直接依赖 Temporal，可独立单测。
 */

export const REFURBISH_LAUNCHER = Symbol('REFURBISH_LAUNCHER');
export const KB_INGEST_LAUNCHER = Symbol('KB_INGEST_LAUNCHER');

export interface BuildOptionsInput {
  stylePreset?: string;
  pages?: string[];
  locales?: string[];
}

export interface BuildScopeInput {
  scope: 'site' | 'page' | 'section';
  targetId?: string | null;
  options?: BuildOptionsInput;
  /** Internal immutable base for partial builds; never accepted from the public DTO. */
  baseVersionId?: string;
}

export interface RefurbishLaunchInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  scope?: BuildScopeInput;
}

export interface RefurbishLaunchResult {
  workflowId: string;
  firstExecutionRunId: string;
}

export interface RefurbishCancelResult {
  terminalStatus: 'cancelled' | 'completed' | 'failed';
}

export function refurbishWorkflowId(buildRunId: string): string {
  return `site-refurbish-${buildRunId}`;
}

export interface RefurbishLauncher {
  launchRefurbish(input: RefurbishLaunchInput): Promise<RefurbishLaunchResult>;
  /** Describe an existing deterministic execution; never starts a new workflow. */
  recoverRefurbish(input: RefurbishLaunchInput): Promise<RefurbishLaunchResult>;
  /** Request cancellation and wait until the execution chain is closed. */
  cancelRefurbish(
    buildRunId: string,
    workflowId?: string | null,
  ): Promise<RefurbishCancelResult>;
}

export interface KbIngestLaunchInput {
  workspaceId: string;
  siteId: string;
  /** 触发来源素材：workflowId 以此幂等（同一 commit 不重复起流）。 */
  assetId: string;
}

export interface KbIngestLauncher {
  launchKbIngest(input: KbIngestLaunchInput): Promise<void>;
}
