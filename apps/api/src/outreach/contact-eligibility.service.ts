import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { encryptPii } from '../compliance/pii-crypto';
import type { EmailVerificationState } from '../discovery/contact-point-verification-state';
import {
  DEFAULT_CATCH_ALL_SEND_POLICY,
  catchAllSendTier,
  type CatchAllSendTier,
} from '../enrichment/verification/catch-all-policy';

/**
 * 联系人可触达性查询（P1-16 引擎侧，ch02 §2.3.10.2）：gain-saas 发送门在批次提交前
 * 问「这批邮箱在引擎里的四态是什么」——发送门此前只查同意/法域/DNC，不知道
 * `contact_point` 是 VALID 还是 RISKY，人工填一条 RISKY 也能发（当前发送开关关闭，
 * 风险为零；本端点把缺口先修在引擎侧）。
 *
 * 口径（与写入器一致）：
 *  - 先按 suppression 同一规范化（小写、trim）canonicalize，再用确定性 `encryptPii`
 *    在 `contact_point.value`（密文）上做等值匹配——密文相等即同邮箱；
 *  - 只返回 `emailHash`（sha256(canonical)，与 DNC 端点同口径），不回传明文邮箱/姓名；
 *  - 未找到 → `found=false, state=UNKNOWN`（调用方必须 fail closed）；
 *  - 同一邮箱命中多条点时取**最强状态**（VALID > CATCH_ALL_RISKY > UNKNOWN > INVALID）——
 *    发送面对的是地址本身，任一 VALID 观测即证明地址可达；
 *  - `catchAllPolicy`：灰度策略表（P1-13）尚未落地，引擎侧一律返回 mode=OFF、
 *    allowed=false（§2.3.6.1：策略不存在 = 一律拒发），score 档位随附供 SaaS 展示。
 */

export const CONTACT_ELIGIBILITY_MAX_EMAILS = 50;

export interface ContactEligibilityPolicy {
  mode: 'OFF' | 'SHADOW' | 'LIMITED' | 'ON';
  minScore: number;
  allowed: boolean;
  tier: CatchAllSendTier;
}

export interface ContactEligibilityResult {
  emailHash: string;
  found: boolean;
  state: EmailVerificationState;
  /** contact_point.confidence（0–100；未找到为 null）。 */
  score: number | null;
  allowedActions: string[];
  catchAllPolicy: ContactEligibilityPolicy | null;
}

const STATE_RANK: Record<EmailVerificationState, number> = {
  VALID: 3,
  CATCH_ALL_RISKY: 2,
  UNKNOWN: 1,
  INVALID: 0,
};

const ALLOWED_ACTIONS: Record<EmailVerificationState, string[]> = {
  VALID: ['display', 'match', 'outreach'],
  CATCH_ALL_RISKY: ['display', 'match'],
  UNKNOWN: ['display', 'match'],
  INVALID: ['display', 'match'],
};

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

@Injectable()
export class ContactEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  canonicalEmail(raw: unknown): string {
    if (typeof raw !== 'string') {
      invalid('OUTREACH_ELIGIBILITY_INVALID_EMAIL', 'email must be a string');
    }
    const canonical = canonicalizeSuppressionValue('email', raw);
    if (!canonical) {
      invalid('OUTREACH_ELIGIBILITY_INVALID_EMAIL', 'email is not a valid address');
    }
    return canonical;
  }

  emailHash(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }

  /**
   * 批量查询（≤50，与 DNC 同上限）。workspace 由调用方（服务令牌端点）显式给出；
   * 查询走 withWorkspace → RLS 强制租户隔离。
   */
  async check(workspaceId: string, emails: readonly unknown[]): Promise<ContactEligibilityResult[]> {
    if (!Array.isArray(emails)) {
      invalid('OUTREACH_ELIGIBILITY_INVALID_BATCH', 'emails must be an array');
    }
    if (emails.length > CONTACT_ELIGIBILITY_MAX_EMAILS) {
      invalid(
        'OUTREACH_ELIGIBILITY_BATCH_TOO_LARGE',
        `at most ${CONTACT_ELIGIBILITY_MAX_EMAILS} emails per check`,
      );
    }
    const canonical = [...new Set(emails.map((email) => this.canonicalEmail(email)))];
    if (canonical.length === 0) return [];

    // 确定性加密 → 密文等值匹配（与 contact_point 写入路径同一把 key）。用原始 SQL 而不是
    // Prisma 委托：PII 扩展的 encryptWhere 只加密**字符串** where.value，`{ in: [...] }`
    // 数组不会被加密（会拿明文数组比对密文列，永远 0 命中）；原始 SELECT 由 RLS 兜底租户隔离。
    const ciphertextToEmail = new Map<string, string>();
    for (const email of canonical) {
      ciphertextToEmail.set(encryptPii(email), email);
    }
    const ciphertexts = [...ciphertextToEmail.keys()];
    const rows = await this.prisma.withWorkspace(workspaceId, (tx) =>
      tx.$queryRaw<Array<{ value: string; verification_state: string; confidence: number | null }>>`
        SELECT value, verification_state, confidence
        FROM contact_point
        WHERE type = 'email' AND value IN (${Prisma.join(ciphertexts)})`,
    );
    const strongest = new Map<string, { state: EmailVerificationState; score: number | null }>();
    for (const row of rows) {
      const email = ciphertextToEmail.get(row.value);
      if (!email) continue; // 理论不可达：查询按密文集过滤
      const state = row.verification_state as EmailVerificationState;
      const existing = strongest.get(email);
      if (!existing || STATE_RANK[state] > STATE_RANK[existing.state]) {
        strongest.set(email, { state, score: row.confidence ?? null });
      }
    }

    return canonical.map((email) => {
      const hit = strongest.get(email);
      const state = hit?.state ?? 'UNKNOWN';
      const catchAllPolicy: ContactEligibilityPolicy | null =
        state === 'CATCH_ALL_RISKY'
          ? {
              // P1-13 的 catch_all_send_policy 表尚未落地：策略不存在 = 一律拒发。
              mode: 'OFF',
              minScore: DEFAULT_CATCH_ALL_SEND_POLICY.grayMinScore,
              allowed: false,
              tier: catchAllSendTier(hit?.score ?? 0),
            }
          : null;
      return {
        emailHash: this.emailHash(email),
        found: hit !== undefined,
        state,
        score: hit ? hit.score : null,
        allowedActions: hit ? ALLOWED_ACTIONS[state] : [],
        catchAllPolicy,
      };
    });
  }
}
