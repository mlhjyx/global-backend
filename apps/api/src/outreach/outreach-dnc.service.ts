import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';

export const OUTREACH_DNC_REASONS = [
  'unsubscribe',
  'bounce',
  'complaint',
  'manual',
  'legal',
] as const;
export type OutreachDncReason = (typeof OUTREACH_DNC_REASONS)[number];

export const OUTREACH_DNC_MAX_EMAILS = 50;

export interface OutreachDncCheckResult {
  emailHash: string;
  suppressed: boolean;
  reasons: string[];
}

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

/**
 * DNC 检查（M2 步 11-1）：发送前同时检查
 *   1) 本 workspace 的 suppression_record（email 类型，RLS 隔离）；
 *   2) 平台级 outreach_global_suppression（租户退订/投诉跨租户生效，只存邮箱 SHA-256）。
 * 任一命中即 suppressed，调用方必须 fail closed。
 */
@Injectable()
export class OutreachDncService {
  constructor(private readonly prisma: PrismaService) {}

  canonicalEmail(raw: unknown): string {
    if (typeof raw !== 'string') {
      invalid('OUTREACH_DNC_INVALID_EMAIL', 'email must be a string');
    }
    const canonical = canonicalizeSuppressionValue('email', raw);
    if (!canonical) {
      invalid('OUTREACH_DNC_INVALID_EMAIL', 'email is not a valid address');
    }
    return canonical;
  }

  emailHash(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }

  async check(
    workspaceId: string,
    emails: readonly unknown[],
  ): Promise<OutreachDncCheckResult[]> {
    if (!Array.isArray(emails)) {
      invalid('OUTREACH_DNC_INVALID_BATCH', 'emails must be an array');
    }
    if (emails.length > OUTREACH_DNC_MAX_EMAILS) {
      invalid(
        'OUTREACH_DNC_BATCH_TOO_LARGE',
        `at most ${OUTREACH_DNC_MAX_EMAILS} emails per check`,
      );
    }
    const canonical = [...new Set(emails.map((email) => this.canonicalEmail(email)))];
    if (canonical.length === 0) return [];
    const hashes = canonical.map((email) => this.emailHash(email));

    const [tenantRows, globalRows] = await Promise.all([
      this.prisma.withWorkspace(workspaceId, (tx) =>
        tx.suppressionRecord.findMany({
          where: { type: 'email', value: { in: canonical } },
          select: { value: true, reason: true },
        }),
      ),
      this.prisma.outreachGlobalSuppression.findMany({
        where: { emailHash: { in: hashes } },
        select: { emailHash: true, reason: true },
      }),
    ]);
    const tenant = new Map(
      tenantRows.map((row) => [row.value, row.reason ?? 'manual']),
    );
    const global = new Map(globalRows.map((row) => [row.emailHash, row.reason]));

    return canonical.map((email) => {
      const emailHash = this.emailHash(email);
      const reasons = [
        ...(tenant.has(email) ? [`tenant:${tenant.get(email)}`] : []),
        ...(global.has(emailHash) ? [`global:${global.get(emailHash)}`] : []),
      ];
      return { emailHash, suppressed: reasons.length > 0, reasons };
    });
  }

  /** Record a platform-wide suppression fact; duplicate writes are no-ops (append-only). */
  async suppressGlobal(input: {
    email: unknown;
    reason: OutreachDncReason;
    source: string;
  }): Promise<void> {
    const email = this.canonicalEmail(input.email);
    if (!(OUTREACH_DNC_REASONS as readonly string[]).includes(input.reason)) {
      invalid('OUTREACH_DNC_INVALID_REASON', 'unknown suppression reason');
    }
    const source = typeof input.source === 'string' ? input.source.trim() : '';
    if (!source || source.length > 64) {
      invalid('OUTREACH_DNC_INVALID_SOURCE', 'source must be 1..64 characters');
    }
    await this.prisma.outreachGlobalSuppression.createMany({
      data: [
        {
          emailHash: this.emailHash(email),
          reason: input.reason,
          source,
        },
      ],
      skipDuplicates: true,
    });
  }
}
