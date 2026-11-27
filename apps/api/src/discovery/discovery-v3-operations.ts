import { randomUUID } from 'node:crypto';
import { Prisma, type DiscoveryV3Operation } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import {
  DISCOVERY_V3_ROBOTS_PROOF, DiscoveryV3OperationError, discoveryV3Digest,
  type DiscoveryV3ClaimedOperation, type DiscoveryV3Cost, type DiscoveryV3OperationClaim,
  type DiscoveryV3OperationErrorCode, type DiscoveryV3OperationInput, type DiscoveryV3ReadbackProbeResult,
  type DiscoveryV3WireReceipt, type DiscoveryV3WireStore, type DiscoveryV3WireUsage,
} from '../durable-results/discovery-v3-operation-contract';
import type { DiscoveryV3ResultLink } from '../durable-results/discovery-v3-operation-scope';
import { isTypedProjectionSchema } from '../durable-results/durable-result-strategy';
import { parseGenericOperationProjection, projectGenericOperationResult, type GenericOperationProjection } from '../tools/generic-operation-projection';
import type { ProviderCompanyRecord } from './provider-contract';
import { ARTIFACT_RESULT_PRODUCERS } from '../durable-results/artifact/artifact-materializer.registry';
import { DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA, parseDiscoveryV3ArtifactProjection } from '../tools/discovery-v3-artifact-execution-port';
import { discoveryV3GatewayReportedCost, type DiscoveryV3GatewayEvidence, type DiscoveryV3GatewayReadbackBinding } from '../model-gateway/discovery-v3-gateway-contract';
import { PAID_MODEL_PROTOCOLS } from '../model-gateway/paid-model-settlement';
import {
  DISCOVERY_V3_FINALIZATION_RESERVE_MS,
  discoveryV3RunMatchesDispatch,
  readDiscoveryV3RunForUpdate,
} from './discovery-v3-run-state';

export {
  DISCOVERY_V3_ROBOTS_PROOF, DiscoveryV3OperationError, discoveryV3Digest,
  type DiscoveryV3ClaimedOperation, type DiscoveryV3Cost, type DiscoveryV3OperationClaim,
  type DiscoveryV3OperationInput, type DiscoveryV3WireReceipt, type DiscoveryV3WireUsage,
} from '../durable-results/discovery-v3-operation-contract';

const SHA256 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
// Same non-monetary ceilings as the existing discovery runtime. Native
// execution enforces them durably across processes for this admitted run.
const CALL_LIMITS = { MODEL: 1_000, TOOL: 2_000 };
const MAX_CONCURRENT_WIRES = 8;
export const DISCOVERY_V3_LOCAL_COMPANY_QUERY = 'discovery-v3-local-companies/v1';
export const DISCOVERY_V3_PUBLIC_WEB_SEARCH_PLAN = 'discovery-v3-public-web-search-plan/v1';
const CHANNEL_CATALOG_LOCAL_PRODUCER = 'channel_catalog.query';
const PUBLIC_WEB_SEARCH_PLAN_PRODUCER = 'public_web.search_plan';

function reject(code: DiscoveryV3OperationErrorCode): never {
  throw new DiscoveryV3OperationError(code);
}

function assertOperationInput(input: DiscoveryV3OperationInput): void {
  const labels = [[input.step, 240], [input.provider, 120], [input.action, 128], [input.method, 64]] as const;
  if ((input.kind !== 'MODEL' && input.kind !== 'TOOL') ||
      !labels.every(([value, length]) => typeof value === 'string' && value.length <= length && LABEL.test(value)) ||
      !Number.isInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 100 ||
      !SHA256.test(input.requestSha256) || !Number.isSafeInteger(input.maxDurationMs) || input.maxDurationMs < 1) {
    reject('DISCOVERY_V3_OPERATION_INVALID');
  }
}

function assertSameRequest(row: DiscoveryV3Operation, input: DiscoveryV3OperationInput): void {
  if (row.requestSha256 !== input.requestSha256 || row.provider !== input.provider || row.action !== input.action ||
      row.method !== input.method || row.deadline.getTime() - row.claimedAt.getTime() !== input.maxDurationMs) {
    reject('DISCOVERY_V3_OPERATION_CONFLICT');
  }
}

async function readBoundRun(tx: Prisma.TransactionClient, command: DiscoveryV3Dispatch) {
  const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
  if (!discoveryV3RunMatchesDispatch(run, command) || !run.v3WorkerAcceptedAt) {
    return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  return run;
}

async function dbClock(tx: Prisma.TransactionClient): Promise<Date> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp()::timestamptz(3) AS now`;
  return clock.now;
}

function validateCost(cost: DiscoveryV3Cost): void {
  if (cost.basis === 'UNKNOWN') return;
  const validAmount = Number.isSafeInteger(cost.amountMicros) && cost.amountMicros >= 0;
  if (cost.basis === 'ESTIMATED' && validAmount && cost.currency === 'USD' &&
      (cost.source === 'token' || cost.source === 'tariff')) return;
  if ((cost.basis === 'PROVIDER_REPORTED' || (cost.basis === 'CONFIRMED_ZERO' && cost.amountMicros === 0)) &&
      validAmount && /^[A-Z]{3}$/.test(cost.currency) && SHA256.test(cost.evidenceSha256)) return;
  reject('DISCOVERY_V3_OPERATION_INVALID');
}

function validateUsage(usage: DiscoveryV3WireUsage | undefined): void {
  for (const count of [usage?.inputTokens, usage?.outputTokens]) {
    if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 2_147_483_647)) {
      reject('DISCOVERY_V3_OPERATION_INVALID');
    }
  }
}

const gatewayProbePhases = new Set<string>([
  'gateway_log_observed', 'gateway_log_pending', 'gateway_log_missing', 'gateway_log_unavailable',
  'gateway_log_invalid', 'gateway_log_ambiguous',
]);

function gatewayBinding(value: DiscoveryV3GatewayReadbackBinding): DiscoveryV3GatewayReadbackBinding {
  const identity = value?.identity;
  let gateway: URL;
  try { gateway = new URL(value?.gatewayOrigin ?? ''); } catch { return reject('DISCOVERY_V3_OPERATION_INVALID'); }
  if (!identity || identity.schemaVersion !== 'site-build-settlement-wire-identity/v1' ||
      identity.physicalWireAttempt !== 1 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(identity.derivationKeyId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(identity.requestId) || !SHA256.test(identity.nonceSha256) ||
      value.gatewayOrigin.length > 240 || gateway.origin !== value.gatewayOrigin ||
      (gateway.protocol !== 'https:' && gateway.protocol !== 'http:') ||
      !SHA256.test(value.credentialSha256) || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(value.alias) ||
      !PAID_MODEL_PROTOCOLS.includes(value.protocol) || !Number.isSafeInteger(value.maxOutputTokens) ||
      value.maxOutputTokens < 1 || value.maxOutputTokens > 262_144) return reject('DISCOVERY_V3_OPERATION_INVALID');
  // Project known fields so transient credentials and nonces can never reach the journal.
  return {
    identity: { schemaVersion: identity.schemaVersion, physicalWireAttempt: identity.physicalWireAttempt,
      derivationKeyId: identity.derivationKeyId, requestId: identity.requestId, nonceSha256: identity.nonceSha256 },
    alias: value.alias, protocol: value.protocol, maxOutputTokens: value.maxOutputTokens,
    gatewayOrigin: value.gatewayOrigin, credentialSha256: value.credentialSha256,
  };
}

function assertGatewayBinding(row: DiscoveryV3Operation, binding: DiscoveryV3GatewayReadbackBinding): void {
  if (row.kind !== 'MODEL' || !row.sendAuthorizedAt || !row.gatewayReadback ||
      discoveryV3Digest(row.gatewayReadback as Prisma.InputJsonObject) !==
        discoveryV3Digest(gatewayBinding(binding) as unknown as Prisma.InputJsonObject)) {
    reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
  }
}

function gatewayEvidence(value: DiscoveryV3GatewayEvidence, binding: DiscoveryV3GatewayReadbackBinding): Prisma.InputJsonObject {
  validateUsage(value);
  if (value.requestId !== binding.identity.requestId || value.alias !== binding.alias || value.protocol !== binding.protocol ||
      !Number.isSafeInteger(value.channelId) || value.channelId < 1 || !Number.isSafeInteger(value.quotaPoints) || value.quotaPoints < 0 ||
      typeof value.inputTokens !== 'number' || typeof value.outputTokens !== 'number' || value.outputTokens > binding.maxOutputTokens ||
      !SHA256.test(value.receiptSha256) || (value.upstreamIdState !== 'observed' && value.upstreamIdState !== 'absent')) {
    return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
  }
  const charge = value.actualCharge;
  if (charge && (!/^[A-Z]{3}$/.test(charge.currency) || !Number.isSafeInteger(charge.amountMicros) || charge.amountMicros < 0)) {
    return reject('DISCOVERY_V3_OPERATION_INVALID');
  }
  return {
    requestId: value.requestId, alias: value.alias, protocol: value.protocol, channelId: value.channelId,
    quotaPoints: value.quotaPoints, inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    upstreamIdState: value.upstreamIdState, receiptSha256: value.receiptSha256,
    ...(charge ? { actualCharge: { currency: charge.currency, amountMicros: charge.amountMicros } } : {}),
  };
}

type ProvenCost = Extract<DiscoveryV3Cost, { readonly basis: 'PROVIDER_REPORTED' | 'CONFIRMED_ZERO' }>;

async function confirmedGatewayUsage(
  tx: Prisma.TransactionClient, row: DiscoveryV3Operation, cost: ProvenCost, usage?: DiscoveryV3WireUsage,
): Promise<DiscoveryV3WireUsage> {
  const probe = await tx.discoveryV3GatewayProbe.findFirst({
    where: { workspaceId: row.workspaceId, operationId: row.id, observedAt: { not: null }, phase: 'gateway_log_observed',
      evidence: { path: ['receiptSha256'], equals: cost.evidenceSha256 } },
    orderBy: { sequence: 'desc' },
    select: { evidence: true },
  });
  if (!probe?.evidence) return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
  const receipt = probe.evidence as unknown as DiscoveryV3GatewayEvidence;
  const binding = gatewayBinding(row.gatewayReadback as unknown as DiscoveryV3GatewayReadbackBinding);
  gatewayEvidence(receipt, binding);
  const confirmed = discoveryV3GatewayReportedCost(receipt);
  if (!confirmed || discoveryV3Digest(confirmed) !== discoveryV3Digest(cost) ||
      (usage?.inputTokens !== undefined && usage.inputTokens !== receipt.inputTokens) ||
      (usage?.outputTokens !== undefined && usage.outputTokens !== receipt.outputTokens)) {
    return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
  }
  return { inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens };
}

async function gatewayReceiptUsage(
  tx: Prisma.TransactionClient, row: DiscoveryV3Operation, receipt: DiscoveryV3WireReceipt,
): Promise<DiscoveryV3WireUsage | undefined> {
  const { cost, usage, outcome } = receipt;
  if (!row.gatewayReadback || cost.basis === 'UNKNOWN' || cost.basis === 'ESTIMATED') return usage;
  // The original claim holder can prove that it stopped before transport.
  if (cost.basis === 'CONFIRMED_ZERO' && cost.currency === 'USD' && outcome === 'FAILED' &&
    usage?.inputTokens === undefined && usage?.outputTokens === undefined &&
    cost.evidenceSha256 === discoveryV3Digest([row.id, row.requestSha256, 'no_wire'])) {
    const priorProbe = await tx.discoveryV3GatewayProbe.findFirst({
      where: { workspaceId: row.workspaceId, operationId: row.id }, select: { id: true },
    });
    if (!priorProbe) return usage;
  }
  return confirmedGatewayUsage(tx, row, cost, usage);
}

const pendingGatewayReadbackProbes = {
  where: { evidence: { not: Prisma.DbNull } }, orderBy: { sequence: 'desc' }, take: 2,
} as const;

function pendingGatewayReadbackWhere(command: DiscoveryV3Dispatch): Prisma.DiscoveryV3OperationWhereInput {
  return {
    workspaceId: command.workspaceId, runId: command.runId, kind: 'MODEL',
    status: { in: ['SUCCEEDED', 'FAILED', 'UNKNOWN'] },
    gatewayReadback: { not: Prisma.DbNull },
    NOT: [{ cost: { path: ['basis'], equals: 'PROVIDER_REPORTED' } }, { cost: { path: ['basis'], equals: 'CONFIRMED_ZERO' } }],
    OR: [{ gatewayProbes: { none: { sequence: 2 } } },
      { gatewayProbes: { some: { evidence: { path: ['actualCharge', 'amountMicros'], gte: 0 } } } }],
  };
}

function pendingGatewayReadback(row: Prisma.DiscoveryV3OperationGetPayload<{ include: { gatewayProbes: true } }>): {
  operation: DiscoveryV3OperationInput; operationId: string; binding: DiscoveryV3GatewayReadbackBinding;
  usage?: DiscoveryV3WireUsage; evidence?: DiscoveryV3GatewayEvidence;
} {
  return {
    operationId: row.id,
    operation: { kind: 'MODEL', action: row.action, provider: row.provider, step: row.step, ordinal: row.ordinal,
      method: row.method, requestSha256: row.requestSha256, maxDurationMs: row.deadline.getTime() - row.claimedAt.getTime() },
    binding: gatewayBinding(row.gatewayReadback as unknown as DiscoveryV3GatewayReadbackBinding),
    usage: (row.usage as DiscoveryV3WireUsage | null) ?? undefined,
    evidence: row.gatewayProbes.map(({ evidence }) => evidence as unknown as DiscoveryV3GatewayEvidence).find(({ actualCharge }) => actualCharge),
  };
}

function costObservation(cost: DiscoveryV3Cost, usage: DiscoveryV3WireUsage | null) {
  return { cost: { ...cost }, usage: {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
  } };
}

function operationWhere(command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput) {
  return { workspaceId: command.workspaceId, runId: command.runId, step: input.step, kind: input.kind, ordinal: input.ordinal };
}

async function readOperation(
  tx: Prisma.TransactionClient,
  command: DiscoveryV3Dispatch,
  input: DiscoveryV3OperationInput,
  operationId: string,
) {
  const row = await tx.discoveryV3Operation.findUnique({ where: {
    workspaceId_runId_step_kind_ordinal: operationWhere(command, input),
  } });
  if (!row || row.id !== operationId) return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  assertSameRequest(row, input);
  return row;
}

function nativeResultSchemaAllowed(projection: GenericOperationProjection, operationId: string, operation: Pick<DiscoveryV3OperationInput, 'action' | 'method'>): boolean {
  const { action, method } = operation;
  if (projection.schema === DISCOVERY_V3_ROBOTS_PROOF || method === 'robots') {
    const data = projection.data as { allowed?: unknown } | null;
    return projection.kind === 'tool' && action === 'crawl4ai.fetch' && method === 'robots' &&
      projection.schema === DISCOVERY_V3_ROBOTS_PROOF && data !== null && typeof data.allowed === 'boolean' &&
      Object.keys(data).length === 1;
  }
  if (projection.schema === DISCOVERY_V3_LOCAL_COMPANY_QUERY) {
    return projection.kind === 'tool' && action === CHANNEL_CATALOG_LOCAL_PRODUCER && method === 'local-query';
  }
  if (projection.schema === DISCOVERY_V3_PUBLIC_WEB_SEARCH_PLAN) {
    const data = projection.data as { includeSerper?: unknown } | null;
    return projection.kind === 'tool' && action === PUBLIC_WEB_SEARCH_PLAN_PRODUCER && method === 'local-query' &&
      data !== null && typeof data.includeSerper === 'boolean' && Object.keys(data).length === 1;
  }
  if (projection.schema !== DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA) return isTypedProjectionSchema(projection.schema);
  const reference = parseDiscoveryV3ArtifactProjection(projection, { operationId });
  return Object.hasOwn(ARTIFACT_RESULT_PRODUCERS, reference.resultSchema) &&
    ARTIFACT_RESULT_PRODUCERS[reference.resultSchema as keyof typeof ARTIFACT_RESULT_PRODUCERS] === action;
}

function checkedResult(row: DiscoveryV3Operation): GenericOperationProjection | null {
  if (row.result === null && row.resultSha256 === null) return null;
  const checked = parseGenericOperationProjection(row.result);
  if (checked.digest !== row.resultSha256 || checked.kind !== row.kind.toLowerCase() || !nativeResultSchemaAllowed(checked, row.id, row)) {
    return reject('DISCOVERY_V3_OPERATION_CONFLICT');
  }
  return checked;
}

async function bookUsage(
  tx: Prisma.TransactionClient,
  row: DiscoveryV3Operation,
  receipt: DiscoveryV3WireReceipt,
  finishedAt: Date,
): Promise<void> {
  if (row.method === 'local-query') return;
  const { cost, usage } = receipt;
  const costUsd = cost.basis !== 'UNKNOWN' && cost.currency === 'USD' ? cost.amountMicros / 1_000_000 : null;
  const costSource = cost.basis === 'ESTIMATED' ? (cost.source === 'token' ? 'token_estimate' : 'tariff_estimate')
    : cost.basis === 'PROVIDER_REPORTED' ? 'provider' : cost.basis === 'CONFIRMED_ZERO' ? 'confirmed_zero' : 'unknown';
  const isModel = row.kind === 'MODEL';
  const occurredAt = row.sendAuthorizedAt ?? row.claimedAt;
  const machineFacts = {
    executionContractVersion: 3, runId: row.runId, operationId: row.id, costSource,
    ...(cost.basis !== 'UNKNOWN' ? { amountMicros: cost.amountMicros, currency: cost.currency } : {}),
  };
  if (isModel) {
    const fields = {
      model: receipt.model ?? row.model ?? 'unknown',
      status: receipt.outcome === 'SUCCEEDED' ? 'OK' : 'ERROR',
      costUsd, inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      meta: machineFacts,
    };
    await tx.aiTrace.upsert({
      where: { id: row.id },
      create: {
        id: row.id, workspaceId: row.workspaceId, provider: row.provider, task: row.action, op: row.method,
        createdAt: occurredAt, latencyMs: Math.max(0, finishedAt.getTime() - occurredAt.getTime()),
        correlationId: row.runId, ...fields,
      },
      update: fields,
    });
  }
  const toolWireObserved = !isModel && (receipt.outcome === 'SUCCEEDED' || cost.basis === 'PROVIDER_REPORTED');
  const fields = {
    quantity: isModel ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) : Number(toolWireObserved),
    costUsd,
    meta: {
      ...machineFacts, provider: row.provider, action: row.action,
      usageKnown: toolWireObserved || usage?.inputTokens !== undefined || usage?.outputTokens !== undefined,
      outcome: receipt.outcome,
    },
  };
  await tx.usageLedger.upsert({
    where: { id: row.id },
    create: {
      id: row.id, workspaceId: row.workspaceId, refId: row.id, createdAt: occurredAt,
      refType: isModel ? 'ai_trace' : 'discovery_v3_operation',
      resourceType: isModel ? 'ai_tokens' : 'provider_call',
      ...fields,
    },
    update: fields,
  });
}

async function persistReceipt(
  tx: Prisma.TransactionClient, row: DiscoveryV3Operation, receipt: DiscoveryV3WireReceipt, finishedAt: Date,
): Promise<DiscoveryV3Operation> {
  const observation = costObservation(receipt.cost, receipt.usage ?? null);
  const resultSha256 = receipt.result?.digest ?? null;
  const receiptSha256 = discoveryV3Digest({
    outcome: receipt.outcome, resultSha256, model: receipt.model ?? null, ...observation,
  });
  if (row.receiptSha256 === receiptSha256 || row.recoveryReceiptSha256 === receiptSha256) return row;
  const recovering = row.status === 'UNKNOWN' && receipt.outcome !== 'UNKNOWN';
  if (row.status !== 'IN_FLIGHT' && !recovering) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
  const previousCost = row.cost as DiscoveryV3Cost | null;
  const previousUsage = row.usage as DiscoveryV3WireUsage | null;
  const previousObservation = previousCost && costObservation(previousCost, previousUsage);
  const label = previousCost?.basis;
  const keepCost = recovering && (label === 'PROVIDER_REPORTED' || label === 'CONFIRMED_ZERO' ||
    (label === 'ESTIMATED' && receipt.cost.basis === 'UNKNOWN'));
  const effectiveCost = keepCost ? previousCost! : receipt.cost;
  const effectiveUsage = {
    inputTokens: (keepCost ? previousUsage?.inputTokens ?? receipt.usage?.inputTokens
      : receipt.usage?.inputTokens ?? previousUsage?.inputTokens) ?? undefined,
    outputTokens: (keepCost ? previousUsage?.outputTokens ?? receipt.usage?.outputTokens
      : receipt.usage?.outputTokens ?? previousUsage?.outputTokens) ?? undefined,
  };
  const effectiveObservation = costObservation(effectiveCost, effectiveUsage);
  const digest = discoveryV3Digest(effectiveObservation);
  const supersedes = previousObservation && discoveryV3Digest(previousObservation);
  const written = await tx.discoveryV3Operation.update({
    where: { id: row.id },
    data: {
      status: receipt.outcome,
      ...(recovering ? { recoveredAt: finishedAt, recoveryReceiptSha256: receiptSha256 } : { finishedAt, receiptSha256 }),
      result: receipt.result as unknown as Prisma.InputJsonObject | undefined, resultSha256,
      cost: effectiveObservation.cost, usage: effectiveObservation.usage, model: receipt.model ?? row.model,
    },
  });
  if (digest !== supersedes) {
    await tx.discoveryV3CostRevision.create({ data: {
      workspaceId: row.workspaceId, operationId: row.id, digest, supersedes,
      createdAt: finishedAt, observation: effectiveObservation,
    } });
  }
  await bookUsage(tx, row, { ...receipt, cost: effectiveCost, usage: effectiveUsage }, finishedAt);
  return written;
}

const UNKNOWN_RECEIPT = { outcome: 'UNKNOWN', cost: { basis: 'UNKNOWN' } } as const;

export async function parkDiscoveryV3OpenOperations(
  tx: Prisma.TransactionClient, command: Pick<DiscoveryV3Dispatch, 'workspaceId' | 'runId'>, now: Date,
): Promise<void> {
  const unresolved = await tx.discoveryV3Operation.findMany({ where: {
    workspaceId: command.workspaceId, runId: command.runId, status: 'IN_FLIGHT',
  } });
  for (const row of unresolved) await persistReceipt(tx, row, UNKNOWN_RECEIPT, now);
}

export class DiscoveryV3OperationStore implements DiscoveryV3WireStore {
  constructor(private readonly prisma: Pick<PrismaService, 'withWorkspace'>) {}

  async claim(command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, workerAttempt = 1): Promise<DiscoveryV3OperationClaim> {
    assertOperationInput(input);
    if (input.method === 'local-query') return reject('DISCOVERY_V3_OPERATION_INVALID');
    const decision = await this.prisma.withWorkspace<DiscoveryV3OperationClaim | null>(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      const now = await dbClock(tx);
      const identity = operationWhere(command, input);
      const prior = await tx.discoveryV3Operation.findUnique({ where: { workspaceId_runId_step_kind_ordinal: identity } });
      if (prior) {
        assertSameRequest(prior, input);
        const operationId = prior.id;
        if (prior.status === 'SUCCEEDED') {
          return { status: 'REPLAY', operationId, result: checkedResult(prior), resultSha256: prior.resultSha256 };
        }
        if (prior.status === 'FAILED') return { status: 'FAILED', operationId };
        if (prior.status === 'UNKNOWN') return { status: 'UNKNOWN', operationId };
        if (prior.deadline <= now) {
          await persistReceipt(tx, prior, UNKNOWN_RECEIPT, now);
          return { status: 'UNKNOWN', operationId };
        }
        return { status: 'IN_FLIGHT', operationId };
      }
      const lastWireMs = run.v3DispatchExpiresAt!.getTime() - DISCOVERY_V3_FINALIZATION_RESERVE_MS;
      if (run.v3WorkerAttempt !== workerAttempt) return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      if (run.status !== 'RUNNING') {
        return reject('DISCOVERY_V3_OPERATION_DEADLINE');
      }
      const scope = { workspaceId: command.workspaceId, runId: command.runId };
      const unresolved = await tx.discoveryV3Operation.findFirst({ where: {
        ...scope, OR: [{ status: 'UNKNOWN' }, { status: 'IN_FLIGHT', deadline: { lte: now } }],
      } });
      if (unresolved) {
        if (unresolved.status === 'IN_FLIGHT') await persistReceipt(tx, unresolved, UNKNOWN_RECEIPT, now);
        return null;
      }
      const count = await tx.discoveryV3Operation.count({ where: { ...scope, kind: input.kind, method: { not: 'local-query' } } });
      const concurrent = await tx.discoveryV3Operation.count({ where: { ...scope, status: 'IN_FLIGHT' } });
      if (count >= CALL_LIMITS[input.kind] || concurrent >= MAX_CONCURRENT_WIRES) {
        return reject('DISCOVERY_V3_OPERATION_LIMIT');
      }
      const claimedAt = await dbClock(tx);
      const deadline = new Date(claimedAt.getTime() + input.maxDurationMs);
      if (deadline.getTime() > lastWireMs) return reject('DISCOVERY_V3_OPERATION_DEADLINE');
      const proof = randomUUID();
      const row = await tx.discoveryV3Operation.create({ data: {
        ...identity, requestSha256: input.requestSha256, provider: input.provider, action: input.action,
        claimProofSha256: discoveryV3Digest(proof),
        method: input.method, status: 'IN_FLIGHT', claimedAt, deadline,
      } });
      return { status: 'CLAIMED', operationId: row.id, deadline, proof };
    });
    return decision ?? reject('DISCOVERY_V3_OPERATION_UNRESOLVED');
  }

  /** The reviewed channel catalog is a local DB read, with a frozen proof and no wire. */
  async channelCatalogProof(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, workerAttempt: number,
    read: () => Promise<readonly ProviderCompanyRecord[]>,
  ): Promise<DiscoveryV3ResultLink> {
    if (input.kind !== 'TOOL' || input.method !== 'local-query' || input.action !== CHANNEL_CATALOG_LOCAL_PRODUCER ||
        input.provider !== CHANNEL_CATALOG_LOCAL_PRODUCER) return reject('DISCOVERY_V3_OPERATION_INVALID');
    const proof = await this.localProof(command, input, workerAttempt, DISCOVERY_V3_LOCAL_COMPANY_QUERY, async () => {
      const records = await read();
      if (records.length > 60) return reject('DISCOVERY_V3_OPERATION_LIMIT');
      return projectGenericOperationResult({ kind: 'tool', schema: DISCOVERY_V3_LOCAL_COMPANY_QUERY, data: { records } });
    });
    return proof.link;
  }

  async publicWebSearchPlan(command: DiscoveryV3Dispatch, queryOrdinal: number, workerAttempt: number, includeSerper: boolean) {
    if (!Number.isSafeInteger(queryOrdinal) || queryOrdinal < 0 || typeof includeSerper !== 'boolean') {
      return reject('DISCOVERY_V3_OPERATION_INVALID');
    }
    const input: DiscoveryV3OperationInput = {
      step: `query/${queryOrdinal}/public_web/plan`, kind: 'TOOL', ordinal: 1,
      action: PUBLIC_WEB_SEARCH_PLAN_PRODUCER, provider: PUBLIC_WEB_SEARCH_PLAN_PRODUCER,
      method: 'local-query', requestSha256: discoveryV3Digest([command.requestSha256, queryOrdinal, PUBLIC_WEB_SEARCH_PLAN_PRODUCER]),
      maxDurationMs: 1,
    };
    const { link, result } = await this.localProof(command, input, workerAttempt, DISCOVERY_V3_PUBLIC_WEB_SEARCH_PLAN, async () =>
      projectGenericOperationResult({ kind: 'tool', schema: DISCOVERY_V3_PUBLIC_WEB_SEARCH_PLAN, data: { includeSerper } }));
    return { link, includeSerper: (result.data as { includeSerper: boolean }).includeSerper };
  }

  private async localProof(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, workerAttempt: number,
    schema: string, prepare: () => Promise<GenericOperationProjection>,
  ): Promise<{ link: DiscoveryV3ResultLink; result: GenericOperationProjection }> {
    assertOperationInput(input);
    const identity = operationWhere(command, input);
    const priorProof = (row: DiscoveryV3Operation) => {
      assertSameRequest(row, input);
      const result = checkedResult(row);
      if (row.status !== 'SUCCEEDED' || row.sendAuthorizedAt || !row.resultSha256 || result?.schema !== schema) {
        return reject('DISCOVERY_V3_OPERATION_CONFLICT');
      }
      return { link: { operation: input, operationId: row.id, resultSha256: row.resultSha256 }, result };
    };
    const prior = await this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      return tx.discoveryV3Operation.findUnique({ where: { workspaceId_runId_step_kind_ordinal: identity } });
    });
    if (prior) return priorProof(prior);
    const result = await prepare();
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      if (run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt) return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      const existing = await tx.discoveryV3Operation.findUnique({ where: { workspaceId_runId_step_kind_ordinal: identity } });
      if (existing) return priorProof(existing);
      const now = await dbClock(tx);
      const row = await tx.discoveryV3Operation.create({ data: {
        ...identity, requestSha256: input.requestSha256, provider: input.provider, action: input.action,
        claimProofSha256: discoveryV3Digest(randomUUID()), method: input.method, status: 'IN_FLIGHT',
        claimedAt: now, deadline: new Date(now.getTime() + input.maxDurationMs),
      } });
      const stored = await persistReceipt(tx, row, { outcome: 'SUCCEEDED', result, cost: {
        basis: 'CONFIRMED_ZERO', currency: 'USD', amountMicros: 0,
        evidenceSha256: discoveryV3Digest([row.id, result.digest, 'local-read']),
      } }, now);
      return priorProof(stored);
    });
  }

  async authorizeSend(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, claim: DiscoveryV3ClaimedOperation, workerAttempt: number,
    readback?: DiscoveryV3GatewayReadbackBinding,
  ): Promise<number> {
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      const row = await readOperation(tx, command, input, claim.operationId);
      if (run.v3WorkerAttempt !== workerAttempt || row.claimProofSha256 !== discoveryV3Digest(claim.proof)) {
        return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      }
      const now = await dbClock(tx);
      if (run.status !== 'RUNNING' || row.deadline <= now) return reject('DISCOVERY_V3_OPERATION_DEADLINE');
      if (row.status !== 'IN_FLIGHT' || row.sendAuthorizedAt) return reject('DISCOVERY_V3_OPERATION_UNRESOLVED');
      if (readback && row.kind !== 'MODEL') return reject('DISCOVERY_V3_OPERATION_INVALID');
      await tx.discoveryV3Operation.update({ where: { id: row.id }, data: {
        sendAuthorizedAt: now,
        ...(readback ? { gatewayReadback: gatewayBinding(readback) as unknown as Prisma.InputJsonObject } : {}),
      } });
      return row.deadline.getTime() - now.getTime();
    });
  }

  async claimModelReadbackProbe(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, operationId: string,
    binding: DiscoveryV3GatewayReadbackBinding, sequence: 1 | 2,
  ): Promise<string | null> {
    if (sequence !== 1 && sequence !== 2) return reject('DISCOVERY_V3_OPERATION_INVALID');
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      const row = await readOperation(tx, command, input, operationId);
      assertGatewayBinding(row, binding);
      const now = await dbClock(tx);
      if (sequence === 2 && row.status === 'IN_FLIGHT' && row.deadline > now) return null;
      const key = { workspaceId: command.workspaceId, operationId, sequence };
      const prior = await tx.discoveryV3GatewayProbe.findUnique({ where: { workspaceId_operationId_sequence: key } });
      if (prior) return null;
      return (await tx.discoveryV3GatewayProbe.create({ data: { ...key, claimedAt: now }, select: { id: true } })).id;
    });
  }

  async recordModelReadbackProbe(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, operationId: string,
    binding: DiscoveryV3GatewayReadbackBinding, result: DiscoveryV3ReadbackProbeResult,
  ): Promise<void> {
    const { sequence, phase, httpStatusClass } = result.probe;
    if (!gatewayProbePhases.has(phase) || (httpStatusClass !== null && ![2, 4, 5].includes(httpStatusClass)) ||
        !Number.isFinite(result.observedAt?.getTime()) || (result.evidence && phase !== 'gateway_log_observed')) {
      return reject('DISCOVERY_V3_OPERATION_INVALID');
    }
    await this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      const row = await readOperation(tx, command, input, operationId);
      assertGatewayBinding(row, binding);
      const prior = await tx.discoveryV3GatewayProbe.findUnique({
        where: { workspaceId_operationId_sequence: { workspaceId: command.workspaceId, operationId, sequence } },
      });
      if (!prior || prior.id !== result.probeId) return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
      const evidence = result.evidence ? gatewayEvidence(result.evidence, binding) : undefined;
      if (prior.observedAt) {
        if (prior.phase !== phase || prior.httpStatusClass !== httpStatusClass ||
            discoveryV3Digest([prior.evidence as Prisma.InputJsonValue | null]) !== discoveryV3Digest([evidence ?? null])) {
          return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
        }
        return;
      }
      await tx.discoveryV3GatewayProbe.update({ where: { id: prior.id }, data: { phase, httpStatusClass, evidence, observedAt: await dbClock(tx) } });
    });
  }

  async listPendingModelReadbacks(command: DiscoveryV3Dispatch, limit = 16, afterOperationId?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) return reject('DISCOVERY_V3_OPERATION_INVALID');
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      const rows = await tx.discoveryV3Operation.findMany({
        where: { ...pendingGatewayReadbackWhere(command), ...(afterOperationId ? { id: { gt: afterOperationId } } : {}) },
        include: { gatewayProbes: pendingGatewayReadbackProbes },
        orderBy: { id: 'asc' }, take: limit,
      });
      return rows.map(pendingGatewayReadback);
    });
  }

  async getPendingModelReadback(command: DiscoveryV3Dispatch, operationId: string) {
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      const row = await tx.discoveryV3Operation.findFirst({
        where: { ...pendingGatewayReadbackWhere(command), id: operationId },
        include: { gatewayProbes: pendingGatewayReadbackProbes },
      });
      return row ? pendingGatewayReadback(row) : null;
    });
  }

  async finish(
    command: DiscoveryV3Dispatch, input: DiscoveryV3OperationInput, claim: DiscoveryV3ClaimedOperation, receipt: DiscoveryV3WireReceipt,
    commitArtifact?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    assertOperationInput(input);
    validateCost(receipt.cost);
    validateUsage(receipt.usage);
    let result: GenericOperationProjection | undefined;
    let rejectedResult = false;
    if (receipt.result) {
      try {
        const projection = parseGenericOperationProjection(receipt.result);
        if (receipt.outcome !== 'SUCCEEDED' || projection.kind !== input.kind.toLowerCase() ||
            !nativeResultSchemaAllowed(projection, claim.operationId, input) ||
            (projection.schema === DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA) !== Boolean(commitArtifact)) {
          reject('DISCOVERY_V3_OPERATION_INVALID');
        }
        result = projection;
      } catch {
        rejectedResult = true;
      }
    }
    await this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      await readBoundRun(tx, command);
      const row = await readOperation(tx, command, input, claim.operationId);
      if (typeof claim.proof !== 'string' || discoveryV3Digest(claim.proof) !== row.claimProofSha256) {
        return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      }
      const usage = await gatewayReceiptUsage(tx, row, receipt);
      const persisted = await persistReceipt(tx, row, { ...receipt, ...(rejectedResult ? { outcome: 'FAILED' as const } : {}), result, usage }, await dbClock(tx));
      // If the first commit's response was lost, the original receipt and artifact already exist.
      if (persisted !== row && !rejectedResult) await commitArtifact?.(tx);
    }, commitArtifact ? { maxWait: 10_000, timeout: 30_000 } : undefined);
    if (rejectedResult) reject('DISCOVERY_V3_OPERATION_INVALID');
  }

  async acknowledge(
    command: DiscoveryV3Dispatch,
    input: DiscoveryV3OperationInput,
    operationId: string,
    resultSha256: string,
    consumerSha256: string,
    consume: (tx: Prisma.TransactionClient, result: GenericOperationProjection, claimedAt: Date) => Promise<void>,
    workerAttempt?: number,
  ): Promise<boolean> {
    assertOperationInput(input);
    if (!SHA256.test(resultSha256) || !SHA256.test(consumerSha256)) return reject('DISCOVERY_V3_OPERATION_INVALID');
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      const row = await readOperation(tx, command, input, operationId);
      if (row.status !== 'SUCCEEDED' || row.resultSha256 !== resultSha256) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
      const result = checkedResult(row);
      if (!result || (row.ack && row.ack !== consumerSha256)) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
      if (row.ack) return false;
      if (workerAttempt !== undefined && (run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt)) {
        return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      }
      await consume(tx, result, row.claimedAt);
      await tx.discoveryV3Operation.update({ where: { id: row.id }, data: { ack: consumerSha256 } });
      return true;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  /** Bind all the native wire results that contributed to one domain write. */
  async acknowledgeBatch<T>(
    command: DiscoveryV3Dispatch,
    links: readonly DiscoveryV3ResultLink[],
    consumerSha256: string,
    apply: (tx: Prisma.TransactionClient, proofs: readonly GenericOperationProjection[]) => Promise<T>,
    workerAttempt: number,
  ): Promise<T | undefined> {
    const ids = new Set(links.map(({ operationId }) => operationId));
    if (!links.length || links.length > 128 || ids.size !== links.length || !SHA256.test(consumerSha256)) {
      return reject('DISCOVERY_V3_OPERATION_INVALID');
    }
    return this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      const proofs: GenericOperationProjection[] = [];
      let acknowledged = 0;
      for (const link of links) {
        assertOperationInput(link.operation);
        const row = await readOperation(tx, command, link.operation, link.operationId);
        const proof = checkedResult(row);
        if (row.status !== 'SUCCEEDED' || !proof || row.resultSha256 !== link.resultSha256 ||
            (row.ack !== null && row.ack !== consumerSha256)) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
        if (row.ack) acknowledged++;
        proofs.push(proof);
      }
      if (acknowledged === links.length) return undefined;
      if (acknowledged) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
      if (run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt) {
        return reject('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
      }
      const result = await apply(tx, proofs);
      const updated = await tx.discoveryV3Operation.updateMany({
        where: { workspaceId: command.workspaceId, runId: command.runId, id: { in: [...ids] }, ack: null },
        data: { ack: consumerSha256 },
      });
      if (updated.count !== ids.size) return reject('DISCOVERY_V3_OPERATION_CONFLICT');
      return result;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async recordCostEvidence(
    command: DiscoveryV3Dispatch,
    input: DiscoveryV3OperationInput,
    operationId: string,
    cost: ProvenCost,
    usage?: DiscoveryV3WireUsage,
    replaces?: string,
  ): Promise<void> {
    assertOperationInput(input);
    if (cost.basis !== 'PROVIDER_REPORTED' && cost.basis !== 'CONFIRMED_ZERO') return reject('DISCOVERY_V3_OPERATION_INVALID');
    validateCost(cost);
    validateUsage(usage);
    await this.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await readBoundRun(tx, command);
      let row = await readOperation(tx, command, input, operationId);
      const observedUsage = row.gatewayReadback ? await confirmedGatewayUsage(tx, row, cost, usage) : usage;
      const observedAt = await dbClock(tx);
      if (row.status === 'IN_FLIGHT' && (row.deadline <= observedAt || run.status !== 'RUNNING')) {
        row = await persistReceipt(tx, row, UNKNOWN_RECEIPT, observedAt);
      }
      if (!row.finishedAt || !row.cost || !row.usage) return reject('DISCOVERY_V3_OPERATION_UNRESOLVED');
      const priorCost = row.cost as DiscoveryV3Cost;
      const priorUsage = row.usage as DiscoveryV3WireUsage;
      const supersedes = discoveryV3Digest(costObservation(priorCost, priorUsage));
      const existing = await tx.discoveryV3CostRevision.findFirst({ where: {
        workspaceId: row.workspaceId, operationId: row.id,
        observation: { path: ['cost', 'evidenceSha256'], equals: cost.evidenceSha256 },
      } });
      if (existing) {
        const prior = existing.observation as ReturnType<typeof costObservation>;
        if (discoveryV3Digest(prior.cost) !== discoveryV3Digest(cost) ||
            (observedUsage?.inputTokens !== undefined && observedUsage.inputTokens !== prior.usage.inputTokens) ||
            (observedUsage?.outputTokens !== undefined && observedUsage.outputTokens !== prior.usage.outputTokens)) {
          return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
        }
        return;
      }
      const merged = {
        inputTokens: observedUsage?.inputTokens ?? priorUsage.inputTokens ?? undefined,
        outputTokens: observedUsage?.outputTokens ?? priorUsage.outputTokens ?? undefined,
      };
      const observation = costObservation(cost, merged);
      const digest = discoveryV3Digest(observation);
      if ((priorCost.basis === 'PROVIDER_REPORTED' || priorCost.basis === 'CONFIRMED_ZERO') &&
          (!replaces || replaces !== priorCost.evidenceSha256 || cost.evidenceSha256 === replaces)) {
        return reject('DISCOVERY_V3_OPERATION_EVIDENCE_CONFLICT');
      }
      await tx.discoveryV3CostRevision.create({ data: {
        workspaceId: row.workspaceId, operationId: row.id, digest, supersedes,
        createdAt: observedAt, observation,
      } });
      await tx.discoveryV3Operation.update({ where: { id: row.id }, data: { cost: observation.cost, usage: observation.usage } });
      await bookUsage(tx, row, { outcome: row.status as DiscoveryV3WireReceipt['outcome'], usage: merged, cost }, row.finishedAt);
    });
  }
}
