import { createHash } from 'node:crypto';

/**
 * P1-07：付费邮箱富集（finder）适配器的统一接口（计划 §2.3.4.4）。
 *
 * 与 `enrichment/verification`（验证器）分工：finder **产出**候选邮箱，验证器**裁决**候选。
 * 编排层（P1-08 富集瀑布）先过三重门（data_provider ENABLED + source_policy 已登记 +
 * 凭据配置）再调适配器；适配器自身不做 DB 访问、不写库、不判四态。
 *
 * 全部 adapter 走注入的 fetch（单测 fixture、零真实出网）；缺凭据时
 * `isConfigured()=false`，`findEmail` 诚实返回 `provider_unconfigured`（cost 0），
 * 绝不伪造命中。命中返回的邮箱明文只在进程内流转，写入器负责立即 encryptPii。
 */

export type EnrichmentProviderKey = 'hunter' | 'findymail' | 'prospeo' | 'apollo' | 'pdl';

export interface FindEmailInput {
  workspaceId: string;
  contactId: string;
  fullName: string;
  /** 已归一、无 www 的公司域名（小写）。 */
  domain: string;
  companyName?: string;
  linkedinUrl?: string;
  /** 用于幂等与计费归因（run 内触发时带）。 */
  runId?: string;
  /** 计费归属键（HTTP 侧为 Grant scope key）。 */
  accountKey: string;
}

export interface FindEmailHit {
  /** 明文，仅在进程内；写入器立即 encryptPii。 */
  email: string;
  /** Hunter 等供应商的结构化信号（脱敏：不含邮箱明文与个人字段）。 */
  providerConfidence?: number;
  /** 供应商的 accept-all 标志（Hunter domain-search 的 data.accept_all）。 */
  acceptAll?: boolean | null;
  /** 供应商返回的域名级命名 pattern（Hunter data.pattern）。 */
  pattern?: string | null;
  /** 脱敏后的证据片段（落 attempt 账；绝不写邮箱明文）。 */
  raw?: Record<string, unknown>;
}

export type FindEmailOutcome =
  | { status: 'hit'; hit: FindEmailHit; costMicrousd: number; latencyMs: number }
  | { status: 'miss'; costMicrousd: number; latencyMs: number; detail: string }
  | {
      status: 'error';
      errorCode: string;
      /** 429/5xx/超时为 true（可退避重试）；401/403/欠费/畸形体为 false。 */
      retryable: boolean;
      costMicrousd: number;
      latencyMs: number;
      detail: string;
    };

export interface EmailEnrichmentAdapter {
  readonly key: EnrichmentProviderKey;
  /** source_policy 门用的 API 域名（无协议头）。 */
  readonly domain: string;
  readonly class: 'b2b_company_person';
  /** 凭据是否完整；false 时 findEmail 返回 provider_unconfigured（cost 0）。 */
  isConfigured(): boolean;
  /** 幂等键 = sha256(contactId | providerKey | inputVersion)。 */
  requestHash(input: FindEmailInput): string;
  findEmail(input: FindEmailInput): Promise<FindEmailOutcome>;
}

/**
 * 输入版本哈希：fullName/domain/companyName/linkedinUrl 任一变化即换键——
 * 输入变了再打一次是合理的重购，输入没变的重跑必须命中本地幂等、不重扣。
 */
export function enrichmentInputVersion(
  input: Pick<FindEmailInput, 'fullName' | 'domain' | 'companyName' | 'linkedinUrl'>,
): string {
  const material = [
    input.fullName.trim(),
    input.domain.trim().toLowerCase(),
    (input.companyName ?? '').trim(),
    (input.linkedinUrl ?? '').trim(),
  ].join('|');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function enrichmentRequestHash(
  contactId: string,
  providerKey: EnrichmentProviderKey,
  input: Pick<FindEmailInput, 'fullName' | 'domain' | 'companyName' | 'linkedinUrl'>,
): string {
  return createHash('sha256')
    .update(`${contactId}|${providerKey}|${enrichmentInputVersion(input)}`, 'utf8')
    .digest('hex');
}

export function unconfiguredFindEmailOutcome(latencyMs = 0): FindEmailOutcome {
  return {
    status: 'error',
    errorCode: 'provider_unconfigured',
    retryable: false,
    costMicrousd: 0,
    latencyMs,
    detail: 'API key 未配置，跳过（不伪造命中）',
  };
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * 供应商返回值的最小校验（§2.3.4.6「返回邮箱但格式非法/域不匹配 → INVALID_PAYLOAD，
 * 不计费、下一家」）：语法必须像邮箱，且**域名必须与目标域一致**（防供应商串号）。
 * 通过时返回小写规范形，否则 null。
 */
export function normalizeEnrichedEmail(raw: unknown, expectedDomain: string): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return null;
  const at = email.lastIndexOf('@');
  const domain = email.slice(at + 1).replace(/\.+$/u, '');
  if (domain !== expectedDomain.trim().toLowerCase().replace(/^www\./u, '')) return null;
  return email;
}

/** 人名拆分（Hunter domain-search 按 first_name/last_name 匹配用）。 */
export function personNameParts(fullName: string): { first: string; last: string } | null {
  const tokens = fullName
    .split(/[\s,]+/u)
    .map((token) => normalizeNameToken(token))
    .filter((token) => token.length > 0);
  if (tokens.length < 2) return null;
  return { first: tokens[0] as string, last: tokens[tokens.length - 1] as string };
}

function normalizeNameToken(token: string): string {
  return token
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

/** 两个名字 token 等价（大小写/变音符/标点无关）。 */
export function namesMatch(left: unknown, right: string): boolean {
  if (typeof left !== 'string') return false;
  return normalizeNameToken(left) === normalizeNameToken(right);
}
