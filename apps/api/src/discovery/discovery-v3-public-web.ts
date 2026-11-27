import type { Prisma } from '@prisma/client';
import {
  resolveBraveSearchApiKey, resolveExaApiKey, resolveGoogleMapsApiKey, resolveSerperApiKey,
} from '../adapters/search-providers';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import type { SearxngSearchOutput } from '../tools/builtin-tools';
import { parseGenericOperationProjection, type GenericOperationProjection } from '../tools/generic-operation-projection';
import type { SearchProviderOutput, SerperSearchToolInput } from '../tools/search-provider-tools';
import type { ExecutionBroker, ToolContext } from '../tools/tool-contract';
import { loadMaterializableCompanyState } from './company-suppression-gate';
import type { DiscoveryV3OperationStore } from './discovery-v3-operations';
import { discoveryV3Digest } from './discovery-v3-operations';
import { type DiscoveryV3ResultLink, withDiscoveryV3OperationScope } from './discovery-v3-operation-scope';
import {
  type DiscoveryV3PublicWebCandidate, PUBLIC_WEB_MODEL_SCHEMA, publicWebModelScope, publicWebReceiptCandidates,
  publicWebReceiptMismatch, publicWebRecordFromModelReceipt,
} from './discovery-v3-public-web-receipts';
import { materializeRawCompanies } from './materialize-raw-companies';
import { companyIdentity } from './identity';
import type { CompanyDiscoveryQuery, DiscoveryOptions } from './provider-contract';
import {
  buildSearchQueries, type ExtractedCompany, publicWebCompanyExtractionRequest, resolveTargetCountryIso, searchLanguageFor,
} from './providers/public-web.provider';
import { governingPolicy, prepareRawSourceBatch, rawSourceIngestLimits, resolveRawSourceBatchByIndex } from './raw-source-ingestion';
import { persistPreparedRawSourceRecord } from './raw-source-writer';
import { sourcePolicyAllowsDiscovery } from './source-policy-scope';

type WorkspacePrisma = Pick<PrismaService, 'withWorkspace'>;
type ScopedModel = { candidate: DiscoveryV3PublicWebCandidate; link: DiscoveryV3ResultLink };
type SearchProof = { link: DiscoveryV3ResultLink; projection: GenericOperationProjection };
type QueryState = {
  command: DiscoveryV3Dispatch;
  query: CompanyDiscoveryQuery;
  ordinal: number;
  signal: AbortSignal;
  workerAttempt: number;
};
type SourceDependencies = {
  prisma: WorkspacePrisma;
  broker: ExecutionBroker;
  gateway: ModelGateway;
  operationStore: DiscoveryV3OperationStore;
  runtimeTelemetry?: RuntimeTelemetry;
};

const policySelect = { id: true, domain: true, retentionDays: true, reviewStatus: true, allowedPurpose: true, updatedAt: true } as const;

function unavailable(): never {
  throw new Error('DISCOVERY_V3_PUBLIC_WEB_SEARCH_ROUTE_UNAVAILABLE');
}

function unboundSearchConfigured(): boolean {
  return Boolean(resolveBraveSearchApiKey() || resolveExaApiKey() || resolveGoogleMapsApiKey());
}

async function policyAllowsCandidate(
  tx: Prisma.TransactionClient, workspaceId: string, candidate: DiscoveryV3PublicWebCandidate,
): Promise<boolean> {
  const host = new URL(candidate.sourceUrl).hostname;
  const policy = governingPolicy({ host, hostname: host.replace(/^www\./u, '') }, 'public_web', candidate.domain,
    await tx.sourcePolicy.findMany({ select: policySelect }));
  if (policy?.reviewStatus !== 'APPROVED' || !sourcePolicyAllowsDiscovery(policy.allowedPurpose)) return false;
  const subject = { name: candidate.domain, domain: candidate.domain };
  return (await loadMaterializableCompanyState(tx, workspaceId, companyIdentity(subject).dedupeKey, subject)).allowed;
}

async function readSearchProofs(
  tx: Prisma.TransactionClient, command: DiscoveryV3Dispatch, links: readonly DiscoveryV3ResultLink[],
): Promise<SearchProof[]> {
  const rows = await tx.discoveryV3Operation.findMany({
    where: { workspaceId: command.workspaceId, runId: command.runId, id: { in: links.map(({ operationId }) => operationId) }, status: 'SUCCEEDED' },
    select: { id: true, result: true, resultSha256: true, step: true, requestSha256: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return links.map((link) => {
    const row = byId.get(link.operationId);
    if (!row || row.resultSha256 !== link.resultSha256 || row.step !== link.operation.step ||
      row.requestSha256 !== link.operation.requestSha256) return publicWebReceiptMismatch();
    return { link, projection: parseGenericOperationProjection(row.result) };
  });
}

async function readCandidateOptions(tx: Prisma.TransactionClient, command: DiscoveryV3Dispatch): Promise<DiscoveryOptions> {
  const accepted = await tx.rawSourceRecord.findMany({
    where: { workspaceId: command.workspaceId, runId: command.runId, providerKey: 'public_web', ingestStatus: 'ACCEPTED' },
    select: { externalId: true },
  });
  const blocked = await tx.sourcePolicy.findMany({ where: { reviewStatus: 'SUSPENDED' }, select: { domain: true } });
  return {
    knownExternalIds: accepted.flatMap(({ externalId }) => externalId ? [externalId] : []),
    blockedDomains: blocked.map(({ domain }) => domain.toLowerCase().replace(/^www\./u, '')),
  };
}

async function collectSearchLinks(
  deps: SourceDependencies, state: QueryState, searches: readonly string[], context: ToolContext, includeSerper: boolean,
): Promise<DiscoveryV3ResultLink[]> {
  const links: DiscoveryV3ResultLink[] = [];
  const language = searchLanguageFor(state.query);
  const country = resolveTargetCountryIso(state.query);
  for (const [index, search] of searches.entries()) {
    await withDiscoveryV3OperationScope({
      ...state, store: deps.operationStore, step: `query/${state.ordinal}/public_web/search/${index + 1}`,
      onResult: (link) => links.push(link),
    }, async () => {
      const expected = links.length + (includeSerper ? 2 : 1);
      await deps.broker.invoke<{ q: string; language: string }, SearxngSearchOutput>('searxng.search', { q: search, language }, context);
      if (includeSerper) {
        await deps.broker.invoke<SerperSearchToolInput, SearchProviderOutput>('serper.search', {
          query: search, num: 10, ...(country ? { gl: country.toLowerCase() } : {}), hl: language,
        }, context);
      }
      if (links.length !== expected) unavailable();
    });
  }
  return links;
}

async function readDomainModel(
  deps: SourceDependencies, state: QueryState, candidate: DiscoveryV3PublicWebCandidate, authorizeRoute: () => Promise<boolean>,
): Promise<ScopedModel | undefined> {
  if (!await authorizeRoute()) unavailable();
  const candidateAllowed = () => deps.prisma.withWorkspace(state.command.workspaceId,
    (tx) => policyAllowsCandidate(tx, state.command.workspaceId, candidate));
  const authorizeExternalAction = async () => (await authorizeRoute()) &&
    candidateAllowed();
  if (!await candidateAllowed()) return undefined;
  const links: DiscoveryV3ResultLink[] = [];
  await withDiscoveryV3OperationScope({
    ...state, store: deps.operationStore, step: publicWebModelScope(state.ordinal, candidate.domain),
    onResult: (link) => links.push(link),
  }, () => executeStructuredTaskWithRuntime<ExtractedCompany>(deps.gateway,
    publicWebCompanyExtractionRequest(candidate.domain, candidate.evidenceText, state.query), {
      workspaceId: state.command.workspaceId, runId: state.command.runId, correlationId: state.command.runId,
      authorizeExternalAction, durableResultSchema: PUBLIC_WEB_MODEL_SCHEMA,
    }, { telemetry: deps.runtimeTelemetry }));
  if (links.length !== 1) return publicWebReceiptMismatch();
  return { candidate, link: links[0]! };
}

async function consumeResultProofs(
  tx: Prisma.TransactionClient, state: QueryState, searchProofs: readonly SearchProof[],
  scopedModels: readonly ScopedModel[], modelProofs: readonly GenericOperationProjection[],
  candidateOptions: DiscoveryOptions,
): Promise<void> {
  const { command, query, ordinal } = state;
  const candidates = publicWebReceiptCandidates(query, ordinal, searchProofs, candidateOptions);
  const operations = await tx.discoveryV3Operation.findMany({
    where: { workspaceId: command.workspaceId, runId: command.runId,
      id: { in: searchProofs.map(({ link }) => link.operationId) } },
    select: { id: true, claimedAt: true },
  });
  const timestamps = new Map(operations.map(({ id, claimedAt }) => [id, claimedAt]));
  const proven = scopedModels.flatMap(({ candidate, link }, index) => {
    const verified = candidates.get(candidate.domain);
    if (!verified || verified.evidenceText !== candidate.evidenceText || verified.sourceUrl !== candidate.sourceUrl ||
      verified.sourceLink.operationId !== candidate.sourceLink.operationId) return publicWebReceiptMismatch();
    const observedAt = timestamps.get(verified.sourceLink.operationId);
    if (!observedAt || !modelProofs[index]) return publicWebReceiptMismatch();
    const record = publicWebRecordFromModelReceipt(query, ordinal, verified, { link, projection: modelProofs[index] }, observedAt);
    return record ? [{ record, link }] : [];
  }).slice(0, query.limit);
  if (!proven.length) return;
  const policies = await tx.sourcePolicy.findMany({ select: policySelect });
  const prepared = prepareRawSourceBatch({
    providerKey: 'public_web', records: proven.map(({ record }) => record), policies, limits: rawSourceIngestLimits(),
  });
  const existing = await tx.rawSourceRecord.findMany({
    where: { workspaceId: command.workspaceId, runId: command.runId, providerKey: 'public_web', ingestVersion: 'raw-source/v2' },
    select: { id: true, externalId: true, ingestKey: true, payloadHash: true, payload: true },
  });
  const rawRecordIds: string[] = [];
  for (const resolution of resolveRawSourceBatchByIndex(prepared.rows, existing)) {
    if (resolution.kind !== 'WRITE' || !resolution.row.contentHash || !resolution.row.sourceUrl) continue;
    const raw = await persistPreparedRawSourceRecord(tx, {
      workspaceId: command.workspaceId, runId: command.runId, sourceEntityId: null,
      providerKey: 'public_web', sourceClass: query.sourceClass, row: resolution.row,
    });
    await tx.discoveryV3RawLink.create({ data: {
      workspaceId: command.workspaceId, operationId: proven[resolution.recordIndex]!.link.operationId, rawRecordId: raw.id,
      queryOrdinal: ordinal, recordIndex: 0, rawPayloadSha256: raw.payloadHash,
    } });
    if (raw.ingestStatus === 'ACCEPTED') rawRecordIds.push(raw.id);
  }
  if (rawRecordIds.length) await materializeRawCompanies(tx, { ...command, rawRecordIds });
}

export function createDiscoveryV3PublicWebSource(deps: SourceDependencies) {
  return async (
    command: DiscoveryV3Dispatch, query: CompanyDiscoveryQuery, ordinal: number,
    signal: AbortSignal, workerAttempt: number, authorizeExternalAction: () => Promise<boolean>,
  ): Promise<void> => {
    const state = { command, query, ordinal, signal, workerAttempt };
    const searches = buildSearchQueries(query);
    const includeSerper = Boolean(searches.length && resolveSerperApiKey());
    const consumer = discoveryV3Digest(['discovery-v3/public-web-source', command.requestSha256, ordinal]);
    const interruptedConsumer = discoveryV3Digest(['discovery-v3/public-web-interrupted', command.requestSha256, ordinal]);
    const plan = await deps.operationStore.publicWebSearchPlan(command, ordinal, workerAttempt, includeSerper);
    const prior = await deps.prisma.withWorkspace(command.workspaceId, (tx) => tx.discoveryV3Operation.findFirst({
      where: { workspaceId: command.workspaceId, runId: command.runId, id: plan.link.operationId }, select: { ack: true },
    }));
    if (prior?.ack === consumer) return;
    if (prior?.ack === interruptedConsumer) throw new Error('DISCOVERY_V3_PUBLIC_WEB_INTERRUPTED');
    if (!prior || prior.ack) return publicWebReceiptMismatch();
    // Pin the optional route and hold when dispatch would no longer reproduce it.
    // Already consumed results above are always read-only, even with changed configuration.
    const authorizeRoute = async () => !unboundSearchConfigured() &&
      plan.includeSerper === Boolean(searches.length && resolveSerperApiKey()) && await authorizeExternalAction();
    if (!await authorizeRoute()) unavailable();
    const context = { workspaceId: command.workspaceId, runId: command.runId, correlationId: command.runId,
      taskContractId: 'discovery.extract_company', purpose: 'discovery' as const, authorizeExternalAction: authorizeRoute };
    const searchLinks = await collectSearchLinks(deps, state, searches, context, plan.includeSerper);
    const { delivered, candidateOptions } = await deps.prisma.withWorkspace(command.workspaceId, async (tx) => ({
      delivered: await readSearchProofs(tx, command, searchLinks),
      candidateOptions: await readCandidateOptions(tx, command),
    }));
    const models: ScopedModel[] = [];
    let interrupted: { cause: unknown } | undefined;
    try {
      const candidates = publicWebReceiptCandidates(query, ordinal, delivered, candidateOptions);
      for (const candidate of candidates.values()) {
        const model = await readDomainModel(deps, state, candidate, authorizeRoute);
        if (model) models.push(model);
      }
    } catch (cause) {
      if (!models.length) throw cause;
      interrupted = { cause };
    }
    const links = [plan.link, ...searchLinks, ...models.map(({ link }) => link)];
    const ack = interrupted ? interruptedConsumer : consumer;
    await deps.operationStore.acknowledgeBatch(command, links, ack, (tx, proofs) =>
      consumeResultProofs(tx, state, searchLinks.map((link, index) => ({ link, projection: proofs[index + 1]! })),
        models, proofs.slice(searchLinks.length + 1), candidateOptions), workerAttempt);
    if (interrupted) throw interrupted.cause;
  };
}
