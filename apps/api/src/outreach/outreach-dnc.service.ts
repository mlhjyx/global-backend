import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  assertExecutionBudgetPlatformWriterPrincipal,
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
  ScopedDatabasePrincipalError,
} from '../execution-budget/execution-budget-platform-writer.database';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { parseOutreachDncPeppers } from '../compliance/pii-crypto';

export const OUTREACH_DNC_REASONS = [
  'unsubscribe',
  'bounce',
  'complaint',
  'manual',
  'legal',
] as const;
export type OutreachDncReason = (typeof OUTREACH_DNC_REASONS)[number];

export const OUTREACH_DNC_MAX_EMAILS = 50;
const DNC_HMAC_DOMAIN_TAG = 'outreach-dnc:v1:';

export interface OutreachDncCheckResult {
  emailHash: string;
  suppressed: boolean;
  reasons: string[];
}

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

function pepperUnavailable(): never {
  throw new ServiceUnavailableException({
    error: {
      code: 'OUTREACH_DNC_PEPPER_UNAVAILABLE',
      message:
        'Global DNC suppression requires a valid 32-byte OUTREACH_DNC_HMAC_PEPPER',
    },
  });
}

/**
 * DNC 检查（M2 步 11-1；MT-P2 加固为带 pepper HMAC）：发送前同时检查
 *   1) 本 workspace 的 suppression_record（email 类型，RLS 隔离）；
 *   2) 平台级 outreach_global_suppression（以 `HMAC-SHA256(pepper, 'outreach-dnc:v1:' + canonical)`
 *      存储 64 位小写 hex，支持 `OUTREACH_DNC_HMAC_RETIRED_PEPPERS` 平滑轮换；HTTP 响应仍保留
 *      `sha256(canonical)` 作为瞬态关联键）。
 * 任一命中即 suppressed，调用方必须 fail closed。
 */
@Injectable()
export class OutreachDncService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE)
    private readonly platformWriter?: PrismaClient | null,
  ) {}

  private requirePeppers(): { activePepper: Buffer; retiredPeppers: Buffer[] } {
    try {
      return parseOutreachDncPeppers(
        process.env.OUTREACH_DNC_HMAC_PEPPER,
        process.env.OUTREACH_DNC_HMAC_RETIRED_PEPPERS,
      );
    } catch {
      pepperUnavailable();
    }
  }

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

  /** Transient HTTP correlation digest (`sha256(canonical)`) matching gain-saas `EngineOutreachDncChecker`. */
  emailHash(email: string): string {
    return createHash('sha256').update(email).digest('hex');
  }

  /** Peppered storage digest persisted in `outreach_global_suppression.email_hash`. */
  storageEmailHash(email: string, pepper?: Buffer): string {
    const key = pepper ?? this.requirePeppers().activePepper;
    return createHmac('sha256', key)
      .update(DNC_HMAC_DOMAIN_TAG)
      .update(email, 'utf8')
      .digest('hex');
  }

  /** Storage digest candidates across `[activePepper, ...retiredPeppers]` for zero-downtime rotation. */
  storageEmailHashCandidates(email: string): string[] {
    const { activePepper, retiredPeppers } = this.requirePeppers();
    const candidates = [this.storageEmailHash(email, activePepper)];
    for (const retired of retiredPeppers) {
      const digest = this.storageEmailHash(email, retired);
      if (!candidates.includes(digest)) candidates.push(digest);
    }
    return candidates;
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
    const { activePepper, retiredPeppers } = this.requirePeppers();
    const allPeppers = [activePepper, ...retiredPeppers];
    const storageHashesByEmail = new Map<string, string[]>();
    const allStorageHashes: string[] = [];
    const seenStorageHashes = new Set<string>();
    for (const email of canonical) {
      const hashesForEmail: string[] = [];
      for (const pepper of allPeppers) {
        const digest = this.storageEmailHash(email, pepper);
        if (!hashesForEmail.includes(digest)) hashesForEmail.push(digest);
        if (!seenStorageHashes.has(digest)) {
          seenStorageHashes.add(digest);
          allStorageHashes.push(digest);
        }
      }
      storageHashesByEmail.set(email, hashesForEmail);
    }

    const [tenantRows, globalRows] = await Promise.all([
      this.prisma.withWorkspace(workspaceId, (tx) =>
        tx.suppressionRecord.findMany({
          where: { type: 'email', value: { in: canonical } },
          select: { value: true, reason: true },
        }),
      ),
      this.prisma.outreachGlobalSuppression.findMany({
        where: { emailHash: { in: allStorageHashes } },
        select: { emailHash: true, reason: true },
      }),
    ]);
    const tenant = new Map(
      tenantRows.map((row) => [row.value, row.reason ?? 'manual']),
    );
    const global = new Map(globalRows.map((row) => [row.emailHash, row.reason]));

    return canonical.map((email) => {
      const emailHash = this.emailHash(email);
      const storageHashes = storageHashesByEmail.get(email) ?? [];
      const globalReasons: string[] = [];
      for (const storageHash of storageHashes) {
        const reason = global.get(storageHash);
        if (reason && !globalReasons.includes(`global:${reason}`)) {
          globalReasons.push(`global:${reason}`);
        }
      }
      const reasons = [
        ...(tenant.has(email) ? [`tenant:${tenant.get(email)}`] : []),
        ...globalReasons,
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
    const storageHash = this.storageEmailHash(email);
    if (!this.platformWriter) {
      throw new ServiceUnavailableException({
        error: {
          code: 'OUTREACH_DNC_WRITER_UNAVAILABLE',
          message:
            'Global DNC suppression requires EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE_URL',
        },
      });
    }
    try {
      await assertExecutionBudgetPlatformWriterPrincipal(
        this.platformWriter,
        'OutreachDncService',
      );
    } catch (error) {
      if (error instanceof ScopedDatabasePrincipalError) {
        throw new ServiceUnavailableException({
          error: {
            code: 'OUTREACH_DNC_WRITER_UNAVAILABLE',
            message:
              'Global DNC suppression requires a valid execution_budget_platform_writer database principal',
          },
        });
      }
      throw error;
    }
    await this.platformWriter.outreachGlobalSuppression.createMany({
      data: [
        {
          emailHash: storageHash,
          reason: input.reason,
          source,
        },
      ],
      skipDuplicates: true,
    });
  }
}
