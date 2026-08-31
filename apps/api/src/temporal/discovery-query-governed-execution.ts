import { Prisma } from '@prisma/client';
import { types } from 'node:util';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  CompanyDiscoveryAdapter,
  DiscoveryResult,
} from '../discovery/provider-contract';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import type { BudgetAccountAuthorization } from '../tools/budget-store';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  parseDiscoveryCompanyResultLineage,
  type DiscoveryCompanyLineageProviderKey,
} from '../discovery/company-discovery-lineage';
import {
  buildDiscoveryQueryProviderPlan,
  finalizeDiscoveryQueryLineageCommand,
  projectDiscoveryQueryLineageAttestKey,
  type buildDiscoveryQueryLineageLookup,
} from '../discovery/discovery-query-governed-lineage';
import { discoveryCompanyDomainAckIdentity } from '../discovery/discovery-company-domain-ack';
import {
  applyPartitionedDomainAckConsumerTransactions,
  type DomainAckMaterializationFact,
} from '../durable-results/domain-ack-consumer-bindings';
import {
  prepareRawSourceBatch,
  rawPayloadHash,
  rawSourceIngestLimits,
  resolveRawSourceBatchByIndex,
  type RawSourceIngestLimits,
} from '../discovery/raw-source-ingestion';
import { persistPreparedRawSourceRecord } from '../discovery/raw-source-writer';
import {
  mergeDiscoveryQueryReceipt,
  parseDiscoveryQueryReceipt,
  type DiscoveryQueryReceipt,
} from '../discovery/discovery-query-receipt';
import {
  appendQueryLineageV2,
  attestQueryLineageV2,
} from '../discovery/discovery-query-lineage.repository';

type LineageLookup = ReturnType<typeof buildDiscoveryQueryLineageLookup>;
type GovernedProviderPlan = Extract<
  ReturnType<typeof buildDiscoveryQueryProviderPlan>,
  { mode: 'governed' }
>;
type ProviderExecution = Readonly<{
  key: string;
  r: DiscoveryResult;
  durableReceipts: readonly Readonly<{
    producerId: string;
    receipt: DurableExecutionReceipt;
  }>[];
}>;
type SettledProviderExecution = PromiseSettledResult<ProviderExecution>;
type AuxiliaryReceipt = Readonly<{
  providerKey: string;
  producerId: string;
  receipt: DurableExecutionReceipt;
}>;
type SourcePolicies = Parameters<typeof prepareRawSourceBatch>[0]['policies'];

export interface DiscoveryQueryExecutionValue {
  rawCount: number;
  quarantinedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  costCents: number;
  provider: string | null;
  budgetTruncated: boolean;
  queryReceipt?: DiscoveryQueryReceipt;
}

export type GovernedDiscoveryQueryExecutionPlan = Readonly<
  | { mode: 'legacy' }
  | {
      mode: 'governed';
      providerPlan: GovernedProviderPlan;
      auxiliaryReceipts: readonly AuxiliaryReceipt[];
    }
>;

export function buildGovernedDiscoveryQueryExecutionPlan(input: Readonly<{
  lineageEnabled: boolean;
  adapters: readonly CompanyDiscoveryAdapter[];
  settled: readonly SettledProviderExecution[];
}>): GovernedDiscoveryQueryExecutionPlan {
  if (!input.lineageEnabled) return Object.freeze({ mode: 'legacy' });
  const selectedProviders = input.adapters.map((adapter) => ({
    providerKey: adapter.key,
    lineageSchema:
      adapter.companyResultLineage === DISCOVERY_COMPANY_RESULT_LINEAGE_V1
        ? DISCOVERY_COMPANY_RESULT_LINEAGE_V1
        : null,
  }));
  if (selectedProviders.some(({ lineageSchema }) => lineageSchema === null)) {
    return Object.freeze({ mode: 'legacy' });
  }
  const providerResults = input.settled.flatMap((item) => {
    if (item.status !== 'fulfilled') {
      throw new ExecutionControlError(
        'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH',
      );
    }
    let lineage;
    try {
      lineage = parseDiscoveryCompanyResultLineage(
        item.value.r.lineage,
        item.value.key as DiscoveryCompanyLineageProviderKey,
      );
    } catch {
      throw new ExecutionControlError(
        'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH',
      );
    }
    if (lineage.recordCount !== item.value.r.records.length) {
      throw new ExecutionControlError(
        'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH',
      );
    }
    return [{
      providerKey: item.value.key,
      lineage,
      costCents: item.value.r.costCents,
    }];
  });
  const companyOperationIds = new Set(providerResults.flatMap(({ lineage }) => [
    ...lineage.attemptReceipts,
    ...lineage.receiptCoverage,
  ].map(({ receipt }) => receipt.operationId)));
  const callbackReceipts = input.settled.flatMap((item) =>
    item.status === 'fulfilled'
      ? item.value.durableReceipts.filter(({ receipt }) =>
          companyOperationIds.has(receipt.operationId))
      : [],
  );
  const auxiliaryReceipts = input.settled.flatMap((item) =>
    item.status === 'fulfilled'
      ? item.value.durableReceipts
          .filter(({ receipt }) => !companyOperationIds.has(receipt.operationId))
          .map(({ producerId, receipt }) => Object.freeze({
            providerKey: item.value.key,
            producerId,
            receipt,
          }))
      : [],
  );
  const providerPlan = buildDiscoveryQueryProviderPlan({
    selectedProviders,
    providerResults,
    callbackReceipts,
    auxiliaryOperationIds: auxiliaryReceipts.map(({ receipt }) => receipt.operationId),
  });
  if (providerPlan.mode !== 'governed') {
    throw new ExecutionControlError('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
  }
  return Object.freeze({
    mode: 'governed',
    providerPlan,
    auxiliaryReceipts: Object.freeze(auxiliaryReceipts),
  });
}

function executionValue(
  receipt: DiscoveryQueryReceipt,
  budgetTruncated: boolean,
): DiscoveryQueryExecutionValue {
  return {
    rawCount: receipt.accepted,
    quarantinedCount: receipt.quarantined,
    rejectedCount: receipt.rejected,
    duplicateCount: receipt.duplicate,
    costCents: receipt.costCents,
    provider: receipt.providers.join('+') || null,
    budgetTruncated,
    queryReceipt: receipt,
  };
}

function ownPlainErrorMessage(error: unknown): string | null {
  try {
    if (
      types.isProxy(error) ||
      !(error instanceof Error) ||
      Object.getPrototypeOf(error) !== Error.prototype
    ) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function rethrowCommitFailure(error: unknown): never {
  if (!types.isProxy(error) && error instanceof ExecutionControlError) throw error;
  const message = ownPlainErrorMessage(error);
  if (
    message !== null &&
    (
      message === 'DISCOVERY_QUERY_RECEIPT_RUN_BINDING_INVALID' ||
      message.startsWith('DISCOVERY_QUERY_RECEIPT_STORE_') ||
      message === 'DISCOVERY_QUERY_RECEIPT_DRIFT' ||
      message === 'DISCOVERY_QUERY_RECEIPT_ORDINAL_CONFLICT'
    )
  ) {
    throw new ExecutionControlError(
      'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD',
    );
  }
  if (message?.startsWith('RAW_SOURCE_')) {
    throw new ExecutionControlError(
      'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH',
    );
  }
  throw new ExecutionControlError('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE');
}

export async function commitGovernedDiscoveryQueryExecution(input: Readonly<{
  prisma: PrismaService;
  workspaceId: string;
  runId: string;
  planId: string;
  queryKey: string;
  sourceClass: string;
  settled: readonly SettledProviderExecution[];
  sourcePolicies: SourcePolicies;
  rawIngestLimits?: RawSourceIngestLimits;
  lookup: LineageLookup;
  plan: Extract<GovernedDiscoveryQueryExecutionPlan, { mode: 'governed' }>;
  budgetAuthorization: BudgetAccountAuthorization;
  budgetTruncated: boolean;
}>): Promise<DiscoveryQueryExecutionValue> {
  const companyAcknowledgements = input.plan.providerPlan.attempts.map((attempt) => ({
    producerId: attempt.producerId,
    receipt: attempt.receipt,
    ...discoveryCompanyDomainAckIdentity({
      runId: input.runId,
      providerKey: attempt.providerKey,
      operationId: attempt.receipt.operationId,
      resultDigest: attempt.receipt.resultDigest,
    }),
  }));
  const auxiliaryAcknowledgements = input.plan.auxiliaryReceipts.map((item) => ({
    producerId: item.producerId,
    receipt: item.receipt,
    domainAckKey: `${input.runId}:${input.queryKey}:${item.providerKey}:${item.receipt.operationId}`,
    domainRevision: item.receipt.resultDigest,
  }));
  const result = await input.prisma.withWorkspace(input.workspaceId, (transaction) =>
    applyPartitionedDomainAckConsumerTransactions<
      Prisma.TransactionClient,
      DiscoveryQueryExecutionValue
    >({
      transaction,
      companyAcknowledgements,
      auxiliaryAcknowledgements,
      apply: async (
        tx: Prisma.TransactionClient,
        companyFacts: readonly DomainAckMaterializationFact[],
      ) => {
        try {
        const resolutions: Array<Record<string, unknown>> = [];
        const rawReceipts: Array<Record<string, unknown>> = [];
        for (const item of input.settled) {
          if (item.status !== 'fulfilled') continue;
          const prepared = prepareRawSourceBatch({
            providerKey: item.value.key,
            records: item.value.r.records,
            policies: input.sourcePolicies,
            limits: input.rawIngestLimits ?? rawSourceIngestLimits(),
          });
          await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`raw-source:${input.workspaceId}:${input.runId}:${item.value.key}`}, 0))`);
          const existing = await tx.rawSourceRecord.findMany({
            where: { runId: input.runId, providerKey: item.value.key, ingestVersion: 'raw-source/v2' },
            select: { id: true, externalId: true, ingestKey: true, payloadHash: true, payload: true, ingestStatus: true },
          });
          const indexed = resolveRawSourceBatchByIndex(prepared.rows, existing.map(
            ({ id, externalId, ingestKey, payloadHash, payload }) =>
              ({ id, externalId, ingestKey, payloadHash, payload }),
          ));
          for (const resolution of indexed) {
            resolutions.push({ providerKey: item.value.key, ...resolution });
            if (resolution.kind === 'REUSE_BATCH') continue;
            if (resolution.kind === 'EXISTING') {
              const prior = existing.find(({ id }) => id === resolution.rawRecordId);
              if (!prior) throw new ExecutionControlError('DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH');
              rawReceipts.push({ providerKey: item.value.key, recordIndex: resolution.recordIndex,
                rawRecordId: prior.id, payloadHash: prior.payloadHash ?? rawPayloadHash(prior.payload),
                ingestStatus: prior.ingestStatus, materialization: 'EXISTING' });
              continue;
            }
            const receipt = await persistPreparedRawSourceRecord(tx, {
              workspaceId: input.workspaceId, runId: input.runId, sourceEntityId: null,
              providerKey: item.value.key, sourceClass: input.sourceClass,
              row: resolution.row, costCents: 0,
            });
            rawReceipts.push({ providerKey: item.value.key, recordIndex: resolution.recordIndex,
              rawRecordId: receipt.id, payloadHash: receipt.payloadHash,
              ingestStatus: receipt.ingestStatus,
              materialization: receipt.inserted ? 'INSERTED' : 'EXISTING' });
          }
        }
        const command = finalizeDiscoveryQueryLineageCommand({
          lookup: input.lookup, providerPlan: input.plan.providerPlan,
          resolutions, rawReceipts, budgetAuthorization: input.budgetAuthorization,
          budgetTruncated: input.budgetTruncated, ackFacts: companyFacts,
        });
        const queryReceipt = parseDiscoveryQueryReceipt(command.queryReceipt);
        await appendQueryLineageV2(tx, command);
        try {
          const rows = await tx.$queryRaw<Array<{ id: string; plan_id: string; stats: unknown }>>(
            Prisma.sql`SELECT id::text, plan_id::text, stats FROM discovery_run WHERE id=${input.runId} FOR UPDATE`,
          );
          const run = rows[0];
          if (!run || run.id !== input.runId || run.plan_id !== input.planId) {
            throw new Error('DISCOVERY_QUERY_RECEIPT_RUN_BINDING_INVALID');
          }
          await tx.discoveryRun.update({ where: { id: input.runId }, data: {
            stats: mergeDiscoveryQueryReceipt(run.stats, queryReceipt) as Prisma.InputJsonValue,
          } });
          if (queryReceipt.costCents > 0) await tx.usageLedger.create({ data: {
            workspaceId: input.workspaceId, resourceType: 'provider_call',
            quantity: queryReceipt.usageQuantity, costUsd: queryReceipt.costCents / 100,
            refType: 'discovery_run', refId: input.runId,
            meta: { ...queryReceipt },
          } });
        } catch (error) { rethrowCommitFailure(error); }
          return executionValue(queryReceipt, input.budgetTruncated);
        } catch (error) {
          rethrowCommitFailure(error);
        }
      },
      readback: async (tx: Prisma.TransactionClient) => {
        const prior = await attestQueryLineageV2(
          tx,
          projectDiscoveryQueryLineageAttestKey(input.lookup),
        );
        if (prior.status !== 'REPLAYED' || prior.budgetTruncated === null) {
          throw new ExecutionControlError('DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD');
        }
        return executionValue(prior.queryReceipt as DiscoveryQueryReceipt, prior.budgetTruncated);
      },
    }),
  );
  return result.value;
}
