import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { lockWorkspaceSuppressionPolicy } from '../discovery/suppression-policy-lock';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from '../discovery/contact-point-verification-event';
import {
  confidenceForState,
  transitionVerificationState,
  verifiedAtStateColumns,
  type EmailVerificationState,
} from '../discovery/contact-point-verification-state';
import {
  setEmailPointConfidence,
  setEmailPointState,
} from '../discovery/contact-point-writer';

/**
 * 发送侧 bounce/complaint 回写（P1-13 引擎侧，ch02 §2.3.6.6）：gain-saas 的 SMTP transport
 * 把每条投递结果经服务令牌回写引擎，驱动四态状态机与抑制：
 *
 *  - `hard_bounce`（5xx/无效邮箱）→ INVALID（清 catch-all）+ suppression(email, bounce, PREFERENCE)；
 *  - `soft_bounce` ×3（同一地址累计）→ UNKNOWN + `next_reverify_at=+24h`（§2.3.6.6 明定，
 *    此处显式降级——软退是地址侧的负向事实，覆盖状态机「VALID 遇 unknown 不降级」的重试语义）；
 *  - `complaint` → 状态不变、confidence 归 0、新证据行 allowedActions 去 outreach +
 *    suppression(email, complaint, LEGAL)。
 *
 * 幂等：`messageId` 进事件账唯一键（provider=smtp_transport），重复回写返回 duplicate、
 * 不产生任何副作用。原始邮件地址不进证据 JSON（只有 messageId/事件/响应码）。
 */

export const CONTACT_BOUNCE_EVENTS = ['hard_bounce', 'soft_bounce', 'complaint'] as const;
export type ContactBounceEvent = (typeof CONTACT_BOUNCE_EVENTS)[number];

export const CONTACT_BOUNCE_SOFT_THRESHOLD = 3;
const PROVIDER_KEY = 'smtp_transport';

export interface ContactBounceInput {
  event: ContactBounceEvent;
  messageId: string;
  smtpCode?: string;
  receivedAt?: string;
}

export interface ContactBounceOutcome {
  action: 'invalidated' | 'recorded' | 'rescheduled' | 'suppressed' | 'duplicate';
  duplicate: boolean;
}

const EVENT_VERDICT = {
  hard_bounce: 'invalid',
  soft_bounce: 'unknown',
  complaint: 'blocked',
} as const;

function invalid(code: string, message: string): never {
  throw new BadRequestException({ error: { code, message } });
}

@Injectable()
export class ContactBounceService {
  private clock: () => Date = () => new Date();

  constructor(private readonly prisma: PrismaService) {}

  /** 测试注入时钟（不走构造参数——Nest 会把函数类型当 provider 解析）。 */
  withClock(clock: () => Date): this {
    this.clock = clock;
    return this;
  }

  async record(
    workspaceId: string,
    pointId: string,
    input: ContactBounceInput,
  ): Promise<ContactBounceOutcome> {
    if (!CONTACT_BOUNCE_EVENTS.includes(input.event)) {
      invalid('OUTREACH_BOUNCE_INVALID_EVENT', 'event must be hard_bounce|soft_bounce|complaint');
    }
    const messageId = input.messageId?.trim();
    if (!messageId || messageId.length > 256) {
      invalid('OUTREACH_BOUNCE_INVALID_MESSAGE_ID', 'messageId must be 1..256 characters');
    }
    if (input.receivedAt !== undefined && Number.isNaN(Date.parse(input.receivedAt))) {
      invalid('OUTREACH_BOUNCE_INVALID_RECEIVED_AT', 'receivedAt must be an ISO timestamp');
    }
    const attemptedAt = this.clock();

    return this.prisma.withWorkspace(workspaceId, async (tx) => {
      const point = await tx.contactPoint.findUnique({
        where: { id: pointId },
        select: {
          id: true,
          type: true,
          value: true,
          contactId: true,
          verificationState: true,
          validSince: true,
          nextReverifyAt: true,
        },
      });
      if (!point) {
        throw new NotFoundException({
          error: { code: 'CONTACT_POINT_NOT_FOUND', message: 'contact point not found' },
        });
      }
      if (point.type !== 'email') {
        throw new ConflictException({
          error: { code: 'CONTACT_BOUNCE_NOT_EMAIL', message: 'bounce events apply to email points only' },
        });
      }

      const requestHash = buildVerificationRequestHash(pointId, PROVIDER_KEY, messageId);
      const event = await recordContactPointVerificationEvent(tx, {
        workspaceId,
        contactPointId: pointId,
        providerKey: PROVIDER_KEY,
        method: 'import',
        verdict: EVENT_VERDICT[input.event],
        detail: `bounce_event:${input.event}${input.smtpCode ? `:${input.smtpCode}` : ''}`,
        costMicrousd: 0,
        actorId: 'gain-saas:smtp_transport',
        requestHash,
      });
      if (event.duplicate) return { action: 'duplicate', duplicate: true };

      const current: EmailVerificationState = point.verificationState as EmailVerificationState;
      const canonicalEmail = canonicalizeSuppressionValue('email', point.value);
      let action: ContactBounceOutcome['action'];
      let resultingState: EmailVerificationState = current;
      let resultingConfidence = confidenceForState(current);

      if (input.event === 'hard_bounce') {
        const transition = transitionVerificationState(
          { state: current, validSince: point.validSince, nextReverifyAt: point.nextReverifyAt },
          { verdict: 'invalid' },
          attemptedAt,
        );
        const columns = verifiedAtStateColumns(transition);
        await setEmailPointState(tx, {
          pointId,
          state: columns.verificationState,
          status: columns.status,
          validSince: columns.validSince,
          verifiedAt: columns.verifiedAt,
          nextReverifyAt: columns.nextReverifyAt,
          confidence: columns.confidence,
          verificationProvider: PROVIDER_KEY,
          verificationMethod: 'import',
          catchAll: 'unknown',
          catchAllClass: null,
          lastVerificationEventId: event.id,
        });
        resultingState = columns.verificationState;
        resultingConfidence = columns.confidence;
        action = 'invalidated';
      } else if (input.event === 'soft_bounce') {
        const priorSoftBounces = await tx.fieldEvidence.count({
          where: {
            entityType: 'contact',
            entityId: point.contactId,
            field: 'email.delivery',
            providerKey: PROVIDER_KEY,
            value: { path: ['event'], equals: 'soft_bounce' },
          },
        });
        if (priorSoftBounces + 1 >= CONTACT_BOUNCE_SOFT_THRESHOLD) {
          // §2.3.6.6：软退 ×3 → UNKNOWN（显式降级，覆盖状态机的 VALID 保留语义）+ 24h 重验。
          resultingState = current === 'INVALID' ? 'INVALID' : 'UNKNOWN';
          resultingConfidence = current === 'INVALID' ? 0 : Math.max(0, confidenceForState('UNKNOWN') - 10);
          await setEmailPointState(tx, {
            pointId,
            state: resultingState,
            status: resultingState === 'INVALID' ? 'INVALID' : 'UNVERIFIED',
            validSince: null,
            verifiedAt: attemptedAt,
            nextReverifyAt: new Date(attemptedAt.getTime() + 24 * 3_600_000),
            confidence: resultingConfidence,
            verificationProvider: PROVIDER_KEY,
            verificationMethod: 'import',
            lastVerificationEventId: event.id,
          });
          action = 'rescheduled';
        } else {
          action = 'recorded';
        }
      } else {
        // complaint：状态不变、confidence 归 0、可触达动作由新证据行收敛到 display/match。
        await setEmailPointConfidence(tx, {
          pointId,
          confidence: 0,
          lastVerificationEventId: event.id,
        });
        resultingConfidence = 0;
        action = 'suppressed';
      }

      // 抑制（append-only 事实）：hard_bounce=PREFERENCE（可提升/可释放），complaint=LEGAL。
      // 同一事务内先锁租户抑制策略（与人工抑制同一线性化点），再 upsert。
      if (input.event === 'hard_bounce' || input.event === 'complaint') {
        if (canonicalEmail) {
          await lockWorkspaceSuppressionPolicy(tx, workspaceId);
          const reason = input.event === 'hard_bounce' ? 'bounce' : 'complaint';
          const protectionClass = input.event === 'hard_bounce' ? 'PREFERENCE' : 'LEGAL';
          await tx.suppressionRecord.upsert({
            where: { workspaceId_type_value: { workspaceId, type: 'email', value: canonicalEmail } },
            // 抑制事实不可变；重复写只允许把保护级别升到 LEGAL。
            update: protectionClass === 'LEGAL' ? { protectionClass: 'LEGAL' } : {},
            create: {
              workspaceId,
              type: 'email',
              value: canonicalEmail,
              reason,
              protectionClass,
            },
          });
        }
      }

      // 投递证据（无 PII：只有事件/响应码/messageId/时间）。
      await tx.fieldEvidence.create({
        data: {
          workspaceId,
          entityType: 'contact',
          entityId: point.contactId,
          field: 'email.delivery',
          value: {
            event: input.event,
            smtp_code: input.smtpCode ?? null,
            message_id: messageId,
            received_at: input.receivedAt ?? null,
            resulting_state: resultingState,
          } as unknown as Prisma.InputJsonValue,
          providerKey: PROVIDER_KEY,
          license: 'public',
          allowedActions: (input.event === 'complaint'
            ? ['display', 'match']
            : resultingState === 'VALID'
              ? ['display', 'match', 'outreach']
              : ['display', 'match']) as unknown as Prisma.InputJsonValue,
          confidence: resultingConfidence / 100,
          dataClass: 'green',
        },
      });

      return { action, duplicate: false };
    });
  }
}
