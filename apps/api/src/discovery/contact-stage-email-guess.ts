/**
 * M3：发现 run 联系人阶段内的自动邮箱补全（email_guess 双闸开启后的代码路径）。
 *
 * 双闸（缺一不探测）由调用方（discoverRunContacts）与本模块共同保证：
 *  ① `data_provider.email_guess` 的 kill switch 必须 ENABLED（调用方判定）；
 *  ② 部署级 lawful basis（`decision_maker` config 的全局 interim LIA）必须存在（调用方传入）。
 * 验证器必须由 provider 路由提供（`smtp_self`）；缺失即跳过，绝不回落到未受治理的出网。
 *
 * 🔴 红线（沿用阶段⑤b 与手动路径的纪律）：
 *  - 自动路径**绝不**传 `allowPersonalWithoutBasis`——人名邮箱只靠显式 lawful basis 放行；
 *  - 每公司 ≤ `MAX_RUN_EMAIL_PROBES_PER_COMPANY`（6）次 SMTP 探测，跨该公司全部联系人共享；
 *    单次调用仍受 `MAX_EMAIL_PROBE_CANDIDATES`（8）上界约束；
 *  - 未证实（RISKY/catch-all/反枚举/不可达）只落 RISKY，allowedActions 不含 outreach；只有 SMTP
 *    RCPT 明确接受且 catch-all 已证伪时才可能 VALID；
 *  - 联系人级禁联（company/contact/email 三层）在每次探测前复核；命中的候选一个都不探。
 *
 * SMTP 出网只经注入验证器背后的 ToolBroker（`smtp.rcpt_probe`，只握手、绝不投递 DATA）。
 */
import type { PrismaService } from '../prisma/prisma.service';
import {
  EmailVerificationAdapter,
  LawfulBasis,
} from './provider-contract';
import { EmailGuesser, GuessResult } from './email-guesser';
import {
  buildGuessTargets,
  DEFAULT_MAX_GUESS_CONTACTS,
} from './email-guess-targets';
import {
  persistGuessedEmail,
  readbackGuessedEmail,
} from './email-guess-persist';
import { contactMayUseExternalProcessing } from './company-suppression-gate';
import { canonicalizeSuppressionValues } from './suppression-value';
import { applyDomainAckConsumerTransactions } from '../durable-results/domain-ack-consumer-bindings';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { MAX_EMAIL_PROBE_CANDIDATES } from './execution-envelope';
import { MAX_RUN_EMAIL_PROBES_PER_COMPANY } from '../execution-budget/contact-discovery-budget';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const SMTP_PROBE_PRODUCER = 'smtp.rcpt_probe' as const;

export interface RunEmailGuessContact {
  id: string;
  fullName: string;
  contactPoints: { type: string; value: string; status: string }[];
}

export interface RunContactEmailGuessInput {
  workspaceId: string;
  runId: string;
  /** The run's ledger account (ToolBroker attributes every physical SMTP probe to it). */
  accountKey: string;
  companyId: string;
  domain: string;
  contacts: readonly RunEmailGuessContact[];
  lawfulBasis: LawfulBasis;
  /** SMTP probes this company may spend; the D5 ceiling is applied here even if a caller asks for more. */
  maxProbes: number;
  verifier: EmailVerificationAdapter;
}

export interface RunContactEmailGuessResult {
  emaillessContacts: number;
  attempted: number;
  probes: number;
  persisted: number;
  verified: number;
  risky: number;
  blocked: number;
}

interface PendingGuess {
  contactId: string;
  result: GuessResult;
  receipts: DurableExecutionReceipt[];
}

export async function guessEmailsForRunCompany(
  deps: { prisma: PrismaService },
  input: RunContactEmailGuessInput,
): Promise<RunContactEmailGuessResult> {
  const allowance = Math.min(input.maxProbes, MAX_RUN_EMAIL_PROBES_PER_COMPANY);
  const targets = buildGuessTargets(
    [...input.contacts],
    input.domain,
    DEFAULT_MAX_GUESS_CONTACTS,
  );
  const summary: RunContactEmailGuessResult = {
    emaillessContacts: targets.emaillessTotal,
    attempted: 0,
    probes: 0,
    persisted: 0,
    verified: 0,
    risky: 0,
    blocked: 0,
  };
  if (!targets.emailless.length || !Number.isSafeInteger(allowance) || allowance < 1) {
    return summary;
  }

  const suppressedEmails = await deps.prisma.withWorkspace(input.workspaceId, async (tx) =>
    canonicalizeSuppressionValues(
      'email',
      (await tx.suppressionRecord.findMany({ where: { type: 'email' }, select: { value: true } }))
        .map((row) => row.value),
    ),
  );

  const guesser = new EmailGuesser(input.verifier);
  const pending: PendingGuess[] = [];
  for (const target of targets.emailless) {
    const remaining = allowance - summary.probes;
    if (remaining < 1) break;
    const authorized = await deps.prisma.withWorkspace(input.workspaceId, (tx) =>
      contactMayUseExternalProcessing(tx, {
        workspaceId: input.workspaceId,
        contactId: target.contactId,
      }),
    );
    if (!authorized) {
      summary.blocked += 1;
      continue;
    }
    const receipts: DurableExecutionReceipt[] = [];
    const result = await guesser.guess(
      { fullName: target.fullName, domain: input.domain, knownSamples: targets.knownSamples },
      {
        workspaceId: input.workspaceId,
        // ToolBroker 的预算/Trace 归属：run 的账本账户（联系人子账户按窗口差值隔离计量）。
        runId: input.accountKey,
        lawfulBasis: input.lawfulBasis,
        actor: `discovery-run:${input.runId}`,
        // 自动路径不传 allowPersonalWithoutBasis（红线）。
        maxProbe: Math.min(remaining, MAX_EMAIL_PROBE_CANDIDATES),
        suppressedEmails,
        authorizeCandidate: (email) =>
          deps.prisma.withWorkspace(input.workspaceId, (tx) =>
            contactMayUseExternalProcessing(tx, {
              workspaceId: input.workspaceId,
              contactId: target.contactId,
              email,
            }),
          ),
        onDurableReceipt: (producerId, receipt) => {
          if (producerId !== SMTP_PROBE_PRODUCER) {
            throw new ExecutionControlError('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
          }
          receipts.push(receipt);
        },
      },
    );
    summary.attempted += 1;
    summary.probes += result.triedCount;
    if (result.status === 'blocked') summary.blocked += 1;
    pending.push({ contactId: target.contactId, result, receipts });
  }

  if (!pending.length) return summary;

  const now = new Date();
  await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
    for (const entry of pending) {
      const outcome = await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: entry.receipts.map((receipt) => ({
          producerId: SMTP_PROBE_PRODUCER,
          receipt,
          // Raw domain-ack identities reject PII-like words (email/phone/@/token…), so the key
          // must not spell out what is being guessed.
          domainAckKey: `contact-run-guess:${entry.contactId}:${receipt.operationId}`,
          domainRevision: receipt.resultDigest,
        })),
        apply: (transaction) =>
          persistGuessedEmail(transaction, {
            workspaceId: input.workspaceId,
            contactId: entry.contactId,
            result: entry.result,
            suppressedEmails,
            // 用门**实际采用**的（已 stamp）依据（与手动/backlog 路径同一纪律）。
            lawfulBasis: entry.result.lawfulBasis ?? input.lawfulBasis,
            now,
          }),
        readback: (transaction) =>
          readbackGuessedEmail(transaction, {
            contactId: entry.contactId,
            result: entry.result,
          }),
      });
      if (!outcome.value.persisted) continue;
      summary.persisted += 1;
      if (outcome.value.status === 'VALID') summary.verified += 1;
      else summary.risky += 1;
    }
  });
  return summary;
}
