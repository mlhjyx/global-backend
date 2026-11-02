import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoveryProviderRegistry } from './provider.registry';
import { persistDiscoveredContacts } from './contact-persist';
import { assertContactDiscoveryAdapterFanout, assertContactDiscoveryResultBound } from './email-guess-targets';
import { LawfulBasis, ProviderContactRecord } from './provider-contract';
import { canonicalizeSuppressionValues, companyMatchesSuppression } from './suppression-value';
import { companyMayUseExternalProcessing } from './company-suppression-gate';
import { BudgetOperationReplayError, type BudgetStore } from '../tools/budget-store';
import { isSyntheticDiscoveryProvenance } from './evidence-license';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-authority.service';
import type { ContactDiscoveryBudgetGuard } from '../execution-budget/contact-discovery-budget';
import { ExecutionControlError, isExecutionControlError } from '../execution-budget/execution-control-error';
import { applyDomainAckConsumerTransactions } from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

const CONTACT_DISCOVERY_RECEIPT_PRODUCERS = Object.freeze([
  'crawl4ai.fetch',
  'companies_house.search',
  'inpi_rne.search',
  'google_patents.search',
  'contact.find_decision_makers',
  // M2b：社媒适配器的出网工具回执（此前这些生产者不在名单 → 回执回调会在
  // 真实 Broker 下抛 DOMAIN_ACK_CONSUMER_BINDING_MISSING，被 adapter catch 吞成静默空结果）。
  'social.search',
  'social.fetch',
  'searxng.search',
  'http.get',
] as const);
type ContactDiscoveryReceiptProducer = (typeof CONTACT_DISCOVERY_RECEIPT_PRODUCERS)[number];

function contactReceiptProducer(producerId: string): producerId is ContactDiscoveryReceiptProducer {
  return CONTACT_DISCOVERY_RECEIPT_PRODUCERS.includes(producerId as ContactDiscoveryReceiptProducer);
}

export interface ContactDiscoveryCoreDeps {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  budgetStore: BudgetStore;
}

export type ContactDiscoveryCoreBinding = Pick<ExecutionBudgetBinding, 'authorityId' | 'scopeKey' | 'accountKey'>;

export interface ContactDiscoveryCoreInput {
  workspaceId: string;
  companyId: string;
  /** Already stamped with actor + timestamp by the caller (HTTP path or run activity). */
  lawfulBasis: LawfulBasis;
  binding: ContactDiscoveryCoreBinding;
  /**
   * D7: the contact stage's own sub-budget (derived `contact.discovery` account). When the stage
   * has spent it, no further adapter starts for this company. The HTTP path omits it and stays
   * bounded by its own grant account alone.
   */
  contactBudget?: ContactDiscoveryBudgetGuard;
  /**
   * Per-execution tag (e.g. `a2` for Temporal attempt 2) appended to the model
   * correlationId so paid-operation keys never collide across activity retries —
   * a retried attempt must not inherit the previous attempt's unresolved ledger rows.
   */
  attemptTag?: string;
}

/**
 * Shared core of named-contact discovery (option B): runs every enabled contact adapter for one
 * company and persists what they return. The HTTP endpoint supplies a consumed workspace grant and
 * a caller-provided lawful basis; the discovery run supplies its own run binding and the
 * deployment-level basis from the `decision_maker` provider config.
 */
export async function discoverContactsCore(
  deps: ContactDiscoveryCoreDeps,
  input: ContactDiscoveryCoreInput,
) {
  const binding = input.binding;
    const loaded = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({
        where: { id: input.companyId },
      });
      if (!company)
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      const evidenceRows = await tx.fieldEvidence.findMany({
        where: {
          entityType: 'company',
          entityId: input.companyId,
        },
        select: { providerKey: true, license: true },
      });
      if (evidenceRows.some(isSyntheticDiscoveryProvenance)) {
        throw new ConflictException({
          error: {
            code: 'SYNTHETIC_PROVENANCE_QUARANTINED',
            message: 'historical synthetic discovery evidence is quarantined from product actions',
          },
        });
      }
      const companySuppressions = await tx.suppressionRecord.findMany({
        where: { type: { in: ['domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      if (company.status === 'SUPPRESSED' || companyMatchesSuppression(companySuppressions, company)) {
        throw new ConflictException({
          error: {
            code: 'SUPPRESSED',
            message: 'company is suppressed; contact discovery blocked',
          },
        });
      }
      const adapters = await deps.providers.routeContactDiscovery(tx as never);
      assertContactDiscoveryAdapterFanout(adapters.length);
      if (!adapters.length) {
        throw new ConflictException({
          error: {
            code: 'NO_PROVIDER',
            message: 'no contact discovery provider enabled',
          },
        });
      }
      const suppressedEmails = canonicalizeSuppressionValues(
        'email',
        (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value),
      );
      return { company, adapters, suppressedEmails };
    });

    // 事务外 fan-out：遍历全部 enabled 的联系人 adapter（decision_maker/public_web/companies_house…）。
    // 🔴 单 adapter 失败/闸门拒绝不阻断其余（fail-safe）；各自保留自己的 adapterKey。
    const perAdapter: {
      key: string;
      contacts: ProviderContactRecord[];
      costCents: number;
      durableReceipts: Array<{
        producerId: ContactDiscoveryReceiptProducer;
        receipt: DurableExecutionReceipt;
      }>;
      diagnostics?: Record<string, number>;
    }[] = [];
    const authorizeExternalAction = () =>
      deps.prisma.withWorkspace(input.workspaceId, (tx) =>
        companyMayUseExternalProcessing(tx, input.workspaceId, input.companyId),
      );
    const accountKey = binding.accountKey;
    const budgets = deps.budgetStore;
    await budgets.attestAuthorized({
      authorityId: binding.authorityId,
      scopeKey: binding.scopeKey,
      accountKey,
    });
    let budgetTruncated = false;
    for (const adapter of loaded.adapters) {
        if (input.contactBudget?.exhausted()) {
          budgetTruncated = true;
          break;
        }
        try {
          const authorized = await authorizeExternalAction();
          if (!authorized) break;
          const durableReceipts: Array<{
            producerId: ContactDiscoveryReceiptProducer;
            receipt: DurableExecutionReceipt;
          }> = [];
          const captureContactReceipt = (
            producerId: string,
            receipt: DurableExecutionReceipt,
          ): void => {
            if (!contactReceiptProducer(producerId)) {
              throw new ExecutionControlError('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
            }
            durableReceipts.push({ producerId, receipt });
          };
          const result = await adapter.discoverContacts(
            {
              name: loaded.company.name,
              domain: loaded.company.domain ?? undefined,
              country: loaded.company.country ?? undefined,
            },
            {
              workspaceId: binding.scopeKey,
              runId: accountKey,
              correlationId: input.attemptTag
                ? `${input.companyId}:${input.attemptTag}`
                : input.companyId,
              lawfulBasis: input.lawfulBasis,
              authorizeExternalAction,
              onDurableReceipt: captureContactReceipt,
              // G3 5.5：crawl4ai.fetch / http.get 等 PERSONAL_DATA 工件工具是 subject-bound——
              // 没有 company 主体就被 Broker 持有（_BINDING_HOLD），decision_maker/社媒的抓取
              // 会在真实 Broker 下静默失败。联系人发现的主体就是正在被补全的公司。
              artifactSubject: { subjectType: 'company', subjectId: input.companyId },
            },
          );
          assertContactDiscoveryResultBound(result.contacts.length);
          perAdapter.push({
            key: adapter.key,
            contacts: result.contacts,
            costCents: result.costCents,
            durableReceipts,
            ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
          });
        } catch (err) {
          // #684 残留吸收：`remnant` 表示先前的尝试留下了未结算的账本行、对上游没有断言——
          // Temporal 重试（或同 attempt 内的瞬时重试）撞上它时按「该适配器本轮跳过」吸收，
          // 绝不让一行残影把整家公司（乃至整个 run）打挂。`live` 仍是活故障，照旧上抛。
          if (err instanceof BudgetOperationReplayError && err.origin === 'remnant') {
            console.warn(
              `[discoverContacts] adapter ${adapter.key} absorbed a remnant replay row for ${input.companyId}; skipping the adapter for this attempt`,
            );
          } else if (
            isExecutionControlError(err) ||
            err instanceof Error &&
              err.message === 'DOMAIN_ACK_CONSUMER_BINDING_MISSING'
          ) throw err;
          else
            console.warn(`[discoverContacts] adapter ${adapter.key} failed for ${input.companyId}: ${String(err).slice(0, 150)}`);
        }
        const runStatus = await budgets.status({ workspaceId: binding.scopeKey, accountKey });
        input.contactBudget?.observe(runStatus.remainingMicrousd);
        if (runStatus.exhausted) break;
    }

    const adapterDiagnostics: Record<string, number> = {};
    for (const entry of perAdapter) {
      for (const [name, count] of Object.entries(entry.diagnostics ?? {})) {
        adapterDiagnostics[name] = (adapterDiagnostics[name] ?? 0) + count;
      }
    }

    const persisted = await deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const acknowledged = await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: perAdapter.flatMap((adapterResult) =>
          adapterResult.durableReceipts.map(({ producerId, receipt }) => ({
            producerId,
            receipt,
            domainAckKey:
              `contact:${loaded.company.id}:${adapterResult.key}:${receipt.operationId}`,
            domainRevision: receipt.resultDigest,
          }))),
        apply: async (transaction) => {
          // 同一 tx 内顺序 persist：后一 adapter 的 resolve 看得到前一 adapter 刚插入的行 →
          // 同一人经 resolvePersonIdentity 合并（decision_maker 的 email + CH 的 officer_id 落同一条）。
          let skippedSuppressed = 0;
          let skippedInvalid = 0;
          for (const pa of perAdapter) {
            const res = await persistDiscoveredContacts(transaction, {
              workspaceId: input.workspaceId,
              company: {
                id: loaded.company.id,
                dedupeKey: loaded.company.dedupeKey,
              },
              adapterKey: pa.key,
              contacts: pa.contacts,
              suppressedEmails: loaded.suppressedEmails,
              lawfulBasis: input.lawfulBasis,
            });
            skippedSuppressed += res.skippedSuppressed;
            skippedInvalid += res.skippedInvalid;
            if (pa.costCents > 0) {
              await transaction.usageLedger.create({
                data: {
                  workspaceId: input.workspaceId,
                  resourceType: 'provider_call',
                  quantity: pa.contacts.length,
                  costUsd: pa.costCents / 100,
                  refType: 'canonical_company',
                  refId: loaded.company.id,
                  meta: { provider: pa.key, op: 'contact_discovery' },
                },
              });
            }
          }
          const contacts = await transaction.canonicalContact.findMany({
            where: { companyId: loaded.company.id },
            include: { contactPoints: true },
          });
          return { contacts, skippedSuppressed, skippedInvalid };
        },
        readback: async (transaction) => ({
          contacts: await transaction.canonicalContact.findMany({
            where: { companyId: loaded.company.id },
            include: { contactPoints: true },
          }),
          skippedSuppressed: 0,
          skippedInvalid: 0,
        }),
      });
      return {
        ...acknowledged.value,
        ...(Object.keys(adapterDiagnostics).length ? { diagnostics: adapterDiagnostics } : {}),
      };
    });

    // Only the run path carries a sub-budget; the HTTP response shape stays as it was.
    return {
      ...persisted,
      ...(input.contactBudget ? { budgetTruncated } : {}),
    };
  }
