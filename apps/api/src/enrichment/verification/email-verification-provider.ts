import type {
  CatchAllClass,
  EmailVerificationState,
} from '../../discovery/contact-point-verification-state';

/**
 * P1-04：第三方邮箱验证器的统一适配面（MillionVerifier / ZeroBounce / Emailable …）。
 *
 * 与既有 `EmailVerificationAdapter`（discovery/provider-contract，SMTP 自建验证器）分工：
 *  - 本接口面向**付费第三方验证 API**，返回结构化四态投票 + catch-all 子类 + 成本，
 *    供验证瀑布（P1-06）按「双正规则」裁决；**单家 positive 不直接判 VALID**。
 *  - 凭据从 env 读（各 provider 自己解析）；缺省时 `isConfigured()=false`，verify 一律
 *    诚实地降级为 UNKNOWN（error='provider_unconfigured'），绝不伪造结论。
 *  - 所有调用前必须过 source_policy 门（provider.domain 已登记且未 SUSPENDED），由编排方
 *    （再验证 CLI / 富集活动）在调用前检查——适配器自身不做 DB 访问。
 */
export interface EmailVerificationRequest {
  email: string;
  /** 供应商侧超时秒数提示（MillionVerifier 支持 timeout 参数）。 */
  providerTimeoutSeconds?: number;
}

export interface EmailVerificationProviderResult {
  providerKey: string;
  /** 该 provider 单票映射出的四态（最终裁决由验证瀑布按投票矩阵做）。 */
  state: EmailVerificationState;
  /** A4 legacy catch-all 三态。 */
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  /** 基础置信分 0–100（四态基础分；编排方再叠加一致性/衰减等分量）。 */
  score: number;
  acceptAll: boolean | null;
  disposable: boolean | null;
  role: boolean | null;
  /** 供应商原始结果（result/subresult），用于事件账与排障；不含邮箱明文。 */
  detail: string;
  /** 网络/限流/畸形体/未配置 → 非空；此时 state 一律 UNKNOWN。 */
  error: string | null;
  /** 微美元；供应商侧错误（未产生一次有效验证）记 0。 */
  costMicrousd: number;
  latencyMs: number;
}

export interface EmailVerificationProvider {
  readonly key: string;
  /** source_policy 门用的 API 域名（无协议头）。 */
  readonly domain: string;
  /** 凭据/配置是否完整；false 时 verify 返回 UNKNOWN(provider_unconfigured)。 */
  isConfigured(): boolean;
  verify(request: EmailVerificationRequest): Promise<EmailVerificationProviderResult>;
}

/** 未配置/网络错误时的统一降级结果（state=UNKNOWN，绝不判 VALID/INVALID）。 */
export function unavailableProviderResult(input: {
  providerKey: string;
  error: string;
  detail?: string;
  latencyMs?: number;
}): EmailVerificationProviderResult {
  return {
    providerKey: input.providerKey,
    state: 'UNKNOWN',
    catchAll: 'unknown',
    catchAllClass: 'unknown',
    score: 20,
    acceptAll: null,
    disposable: null,
    role: null,
    detail: input.detail ?? input.error,
    error: input.error,
    costMicrousd: 0,
    latencyMs: input.latencyMs ?? 0,
  };
}
