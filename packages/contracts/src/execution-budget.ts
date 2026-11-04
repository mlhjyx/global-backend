export * from './platform-authority/revocation';

export const PLATFORM_EXECUTION_BUDGET_AUTHORITY_COMMAND =
  'PlatformExecutionBudgetAuthorityUpserted/v1' as const;

export const PLATFORM_EXECUTION_BUDGET_AUTHORITY_SCHEMA_VERSION =
  'execution-budget-grant/v1' as const;

export const EXECUTION_BUDGET_AUTHORITY_AUDIENCE =
  'global-backend:execution-budget' as const;

export const PLATFORM_EXECUTION_BUDGET_PURPOSES = [
  'platform.acquisition',
  'platform.intent_watch',
  'platform.sanctions',
  'platform.channel_crawl',
] as const;

export type PlatformExecutionBudgetPurpose =
  (typeof PLATFORM_EXECUTION_BUDGET_PURPOSES)[number];

/**
 * Claims carried inside the signed compact JWS. The external transport
 * registration is not part of the signed payload and is owned by the Control
 * Plane integration adapter.
 */
export interface PlatformScheduleExecutionBudgetAuthorityV1Claims {
  readonly schema_version: typeof PLATFORM_EXECUTION_BUDGET_AUTHORITY_SCHEMA_VERSION;
  readonly iss: string;
  readonly aud: typeof EXECUTION_BUDGET_AUTHORITY_AUDIENCE;
  readonly jti: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly authority_kind: 'PLATFORM_GRANT';
  readonly purpose: PlatformExecutionBudgetPurpose;
  readonly subject_type: 'schedule';
  readonly subject_id: string;
  readonly schedule_id: string;
  readonly schedule_request_sha256: string;
  readonly workflow_id: string;
  readonly workflow_run_id: string;
  readonly technical_policy_revision: string;
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly cap_per_run_microusd: string;
  readonly campaign_cap_microusd: string;
  readonly max_runs: '1';
}

/**
 * P4：渠道抓取 Grant 的签名 claim 形状。一次性绑定 request 摘要（channelId+mode+
 * pageCap 的 canonical sha256）与一个 crawlRunId；schedule 四字段不属于本形状。
 */
export interface PlatformChannelCrawlExecutionBudgetAuthorityV1Claims {
  readonly schema_version: typeof PLATFORM_EXECUTION_BUDGET_AUTHORITY_SCHEMA_VERSION;
  readonly iss: string;
  readonly aud: typeof EXECUTION_BUDGET_AUTHORITY_AUDIENCE;
  readonly jti: string;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly authority_kind: 'PLATFORM_GRANT';
  readonly purpose: 'platform.channel_crawl';
  readonly subject_type: 'source_channel';
  readonly subject_id: string;
  readonly request_sha256: string;
  readonly crawl_run_id: string;
  readonly technical_policy_revision: string;
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly cap_per_run_microusd: string;
  readonly campaign_cap_microusd: string;
  readonly max_runs: '1';
}

export type PlatformExecutionBudgetAuthorityUpsertedV1Claims =
  | PlatformScheduleExecutionBudgetAuthorityV1Claims
  | PlatformChannelCrawlExecutionBudgetAuthorityV1Claims;
