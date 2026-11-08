import { timingSafeEqual } from 'node:crypto';

/**
 * 引擎 → gain-saas 控制面的内部回调客户端（M2.1，设计 §3/§4.2）。
 *
 * 契约（gain-saas `campaign-internal.controller.ts`，服务令牌沿用 M2.0 `x-service-token` guard）：
 *  - POST  `{base}/api/internal/v1/campaign-revisions`：交付原始 CampaignPlan JSON；
 *    gain-saas 用 zod(CampaignPlan v0) 校验 + canonical plan_hash + 落 DRAFT revision。
 *    幂等键 `(jobId, plan_hash)`：重复回调返回已存在 revision。
 *  - PATCH `{base}/api/internal/v1/campaign-plan-jobs/{jobId}`：失败回写
 *    `{state:'FAILED', error, issues?}`；重复回写同状态幂等。
 *
 * 失败分类（活动层据此决定可重试与否）：
 *  - `CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED`：缺 env，运维错误，nonRetryable；
 *  - `CAMPAIGN_CONTROL_PLANE_UNAVAILABLE`：网络/超时/5xx，可重试；
 *  - `CAMPAIGN_PLAN_INVALID`：契约校验失败（HTTP 422），附 issues，nonRetryable；
 *  - `CAMPAIGN_PLAN_CALLBACK_REJECTED`：其它 4xx（job/campaign 不存在、状态冲突），nonRetryable。
 */

export const CAMPAIGN_REVISIONS_PATH = '/api/internal/v1/campaign-revisions';
export const campaignPlanJobPath = (jobId: string): string =>
  `/api/internal/v1/campaign-plan-jobs/${encodeURIComponent(jobId)}`;

export const CAMPAIGN_INTERNAL_SERVICE_TOKEN_HEADER = 'x-service-token';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export interface CampaignPlanIssue {
  readonly path: string;
  readonly message: string;
}

export type CampaignControlPlaneErrorCode =
  | 'CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED'
  | 'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE'
  | 'CAMPAIGN_PLAN_INVALID'
  | 'CAMPAIGN_PLAN_CALLBACK_REJECTED';

export class CampaignControlPlaneError extends Error {
  constructor(
    readonly code: CampaignControlPlaneErrorCode,
    message: string,
    readonly options: {
      readonly status?: number;
      readonly issues?: readonly CampaignPlanIssue[];
    } = {},
  ) {
    super(message);
    this.name = 'CampaignControlPlaneError';
  }
}

export interface DeliverCampaignRevisionInput {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly plan: unknown;
}

export interface ReportCampaignPlanJobFailureInput {
  readonly jobId: string;
  readonly workspaceId: string;
  readonly error: string;
  readonly issues?: readonly CampaignPlanIssue[];
}

export interface CampaignControlPlane {
  deliverRevision(input: DeliverCampaignRevisionInput): Promise<void>;
  reportJobFailure(input: ReportCampaignPlanJobFailureInput): Promise<void>;
}

interface ControlPlaneConfig {
  readonly baseUrl: URL;
  readonly serviceToken: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configured(env: NodeJS.ProcessEnv): ControlPlaneConfig {
  const base = (env.CAMPAIGN_CONTROL_PLANE_URL ?? '').trim();
  const token = env.CAMPAIGN_INTERNAL_SERVICE_TOKEN ?? '';
  if (!base || token.length === 0) {
    throw new CampaignControlPlaneError(
      'CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED',
      'CAMPAIGN_CONTROL_PLANE_URL / CAMPAIGN_INTERNAL_SERVICE_TOKEN 未配置',
    );
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new CampaignControlPlaneError(
      'CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED',
      'CAMPAIGN_CONTROL_PLANE_URL 不是合法 URL',
    );
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new CampaignControlPlaneError(
      'CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED',
      'CAMPAIGN_CONTROL_PLANE_URL 必须是干净的 http(s) 基地址',
    );
  }
  return { baseUrl: url, serviceToken: token };
}

/** Bounded JSON read: never buffer past the cap, never surface a foreign message. */
async function readBoundedJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return null;
  const text = await response.text().catch(() => '');
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return null;
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorCodeOf(body: Record<string, unknown> | null): string | undefined {
  const error = body?.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function issuesOf(
  body: Record<string, unknown> | null,
): CampaignPlanIssue[] | undefined {
  const error = body?.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const details = (error as Record<string, unknown>).details;
  // gain-saas 的 CAMPAIGN_PLAN_INVALID 形如 {error:{code,message,details:{issues}}}；
  // 兼容 error.issues 的扁平形态（引擎自身与既有 M2.0 调用方都用 details）。
  const raw =
    (details && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>).issues
      : undefined) ??
    (error as Record<string, unknown>).issues;
  if (!Array.isArray(raw)) return undefined;
  const issues: CampaignPlanIssue[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const path = (entry as Record<string, unknown>).path;
    const message = (entry as Record<string, unknown>).message;
    issues.push({
      path: typeof path === 'string' ? path.slice(0, 200) : '',
      message: typeof message === 'string' ? message.slice(0, 300) : '',
    });
  }
  return issues.length > 0 ? issues : undefined;
}

/** Constant-time compare; length differences fail uniformly. */
export function campaignServiceTokenMatches(
  provided: unknown,
  expected: string,
): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function unavailable(): CampaignControlPlaneError {
  return new CampaignControlPlaneError(
    'CAMPAIGN_CONTROL_PLANE_UNAVAILABLE',
    'campaign control plane is unreachable',
  );
}

async function request(
  config: ControlPlaneConfig,
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(new URL(path, config.baseUrl), {
      method,
      headers: {
        'content-type': 'application/json',
        [CAMPAIGN_INTERNAL_SERVICE_TOKEN_HEADER]: config.serviceToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailable();
  }
  return { status: response.status, body: await readBoundedJson(response) };
}

export function createHttpCampaignControlPlane(
  env: NodeJS.ProcessEnv = process.env,
): CampaignControlPlane {
  return {
    async deliverRevision(input) {
      if (
        !UUID.test(input.jobId) ||
        !UUID.test(input.workspaceId) ||
        !UUID.test(input.campaignId)
      ) {
        throw new CampaignControlPlaneError(
          'CAMPAIGN_PLAN_CALLBACK_REJECTED',
          'revision callback identity is invalid',
        );
      }
      const config = configured(env);
      const { status, body } = await request(
        config,
        'POST',
        CAMPAIGN_REVISIONS_PATH,
        {
          jobId: input.jobId,
          workspaceId: input.workspaceId,
          campaignId: input.campaignId,
          plan: input.plan,
        },
      );
      if (status === 200 || status === 201 || status === 204) return;
      if (status === 422) {
        throw new CampaignControlPlaneError(
          'CAMPAIGN_PLAN_INVALID',
          'control plane rejected the plan (CAMPAIGN_PLAN_INVALID)',
          { status, issues: issuesOf(body) },
        );
      }
      if (status >= 400 && status < 500) {
        throw new CampaignControlPlaneError(
          'CAMPAIGN_PLAN_CALLBACK_REJECTED',
          `revision callback rejected (HTTP ${status}${errorCodeOf(body) ? ` ${errorCodeOf(body)}` : ''})`,
          { status },
        );
      }
      throw unavailable();
    },

    async reportJobFailure(input) {
      if (!UUID.test(input.jobId) || !UUID.test(input.workspaceId)) {
        throw new CampaignControlPlaneError(
          'CAMPAIGN_PLAN_CALLBACK_REJECTED',
          'job report identity is invalid',
        );
      }
      const config = configured(env);
      const { status } = await request(
        config,
        'PATCH',
        campaignPlanJobPath(input.jobId),
        {
          workspaceId: input.workspaceId,
          state: 'FAILED',
          error: input.error.slice(0, 64),
          ...(input.issues ? { issues: input.issues.slice(0, 50) } : {}),
        },
      );
      // 200/204：已回写；404：job 不存在（无从回写）；409：job 已终结且状态不同——都视为终态。
      if (
        (status >= 200 && status < 300) ||
        status === 404 ||
        status === 409
      ) {
        return;
      }
      throw unavailable();
    },
  };
}
