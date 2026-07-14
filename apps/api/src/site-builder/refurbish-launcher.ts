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
}

export interface RefurbishLaunchInput {
  workspaceId: string;
  siteId: string;
  buildRunId: string;
  scope?: BuildScopeInput;
}

export interface RefurbishLauncher {
  launchRefurbish(input: RefurbishLaunchInput): Promise<void>;
  /** best-effort 取消（run 状态已由 service 落库；handle 不在也不算错）。 */
  cancelRefurbish(buildRunId: string): Promise<void>;
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
