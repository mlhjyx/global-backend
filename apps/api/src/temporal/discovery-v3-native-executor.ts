import { ApplicationFailure } from '@temporalio/activity';
import type { Prisma } from '@prisma/client';
import { discoveryV3RunMatchesDispatch, readDiscoveryV3RunForUpdate } from '../discovery/discovery-v3-run-state';
import { companyMayUseExternalProcessing } from '../discovery/company-suppression-gate';
import { type DiscoveryV3ResultLink, withDiscoveryV3OperationScope } from '../discovery/discovery-v3-operation-scope';
import { discoveryV3Digest, DiscoveryV3OperationStore } from '../discovery/discovery-v3-operations';
import { MAX_DISCOVERY_PLAN_QUERIES, MAX_DISCOVERY_PROFILE_COMPANIES, MAX_DISCOVERY_PROVIDER_RECORDS, MAX_RUN_ENRICH_COMPANIES, MAX_STREAMING_L1_COMPANIES } from '../discovery/execution-envelope';
import { createDiscoveryV3ContactDiscovery } from '../discovery/discovery-v3-contact';
import { createDiscoveryV3PublicWebSource } from '../discovery/discovery-v3-public-web';
import { createDiscoveryV3ManufacturerEvidence } from '../discovery/manufacturer-network-v3';
import type { ManufacturerNetworkEvidence } from '../discovery/manufacturer-network-evidence';
import { upsertLeadFit } from '../discovery/fit-judge';
import { judgeCompanyFitV3 } from '../discovery/streaming/fit-v3';
import { materializeRawCompanies } from '../discovery/materialize-raw-companies';
import { narrowBySourceHints, planQuerySourceHints } from '../discovery/plan-query-sources';
import type { CompanyDiscoveryQuery, SourceClass } from '../discovery/provider-contract';
import type { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { companiesFromDiscoveryV3Proof, supportsDiscoveryV3CompanySource, type DiscoveryV3CompanySource } from '../discovery/discovery-v3-source-proofs';
import { prepareRawSourceBatch, rawSourceIngestLimits, resolveRawSourceBatchByIndex } from '../discovery/raw-source-ingestion';
import { persistPreparedRawSourceRecord } from '../discovery/raw-source-writer';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import type { DiscoveryV3WorkerExecutor } from './discovery-v3.worker-activities';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { ExecutionBroker } from '../tools/tool-contract';
import { createDiscoveryV3WebsiteProfile, discoveryV3WebsiteFitEvidence } from './discovery-v3-website-profile';

const companySourceClasses = new Set<unknown>(['company_registry', 'industry_data', 'public_intelligence', 'trade_data', 'b2b_company_person']);

function hold(code: string): never {
  throw ApplicationFailure.nonRetryable(code, code);
}

function nativeQueries(queries: Prisma.JsonValue): CompanyDiscoveryQuery[] {
  if (!Array.isArray(queries) || !queries.length || queries.length > MAX_DISCOVERY_PLAN_QUERIES) {
    return hold('DISCOVERY_V3_PLAN_UNAVAILABLE');
  }
  return queries.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return hold('DISCOVERY_V3_PLAN_INVALID');
    const { source_class, filters, keywords, priority } = item;
    if (!companySourceClasses.has(source_class)) return hold('DISCOVERY_V3_ROUTE_UNAVAILABLE');
    const hints = planQuerySourceHints(filters);
    if (!hints) return hold('DISCOVERY_V3_ROUTE_UNAVAILABLE');
    if (filters === null || typeof filters !== 'object' || Array.isArray(filters) ||
        !Array.isArray(keywords) || !keywords.every((keyword) => typeof keyword === 'string')) {
      return hold('DISCOVERY_V3_PLAN_INVALID');
    }
    return { sourceClass: source_class as SourceClass, filters,
      keywords: keywords as string[], priority: typeof priority === 'number' ? priority : 99,
      limit: Math.min(MAX_DISCOVERY_PROVIDER_RECORDS, 60) };
  }).sort((a, b) => a.priority - b.priority);
}

function frozenSources(value: Prisma.JsonValue, count: number): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length !== count) return hold('DISCOVERY_V3_FROZEN_SOURCES_INVALID');
  return value.map((keys) => {
    if (!Array.isArray(keys) || keys.length === 0 || new Set(keys).size !== keys.length ||
        !keys.every((key): key is string => typeof key === 'string' &&
          (key === 'public_web' || supportsDiscoveryV3CompanySource(key)))) {
      return hold('DISCOVERY_V3_FROZEN_SOURCES_INVALID');
    }
    return keys;
  });
}

async function commitSourceResult(
  store: DiscoveryV3OperationStore,
  command: DiscoveryV3Dispatch,
  query: CompanyDiscoveryQuery,
  provider: DiscoveryV3CompanySource,
  queryOrdinal: number,
  link: DiscoveryV3ResultLink,
  workerAttempt: number,
): Promise<void> {
  const consumerSha256 = discoveryV3Digest(['discovery-v3/raw-company', command.requestSha256, queryOrdinal, query.sourceClass]);
  await store.acknowledge(command, link.operation, link.operationId, link.resultSha256, consumerSha256, async (tx, proof, claimedAt) => {
    const companies = companiesFromDiscoveryV3Proof(provider, query, link, proof, claimedAt);
    if (companies.length === 0) return;
    const policies = await tx.sourcePolicy.findMany({
      select: { id: true, domain: true, retentionDays: true, reviewStatus: true, allowedPurpose: true, updatedAt: true },
    });
    const prepared = prepareRawSourceBatch({ providerKey: provider, records: companies.map(({ record }) => record), policies, limits: rawSourceIngestLimits() });
    const existing = await tx.rawSourceRecord.findMany({
      where: { workspaceId: command.workspaceId, runId: command.runId, providerKey: provider, ingestVersion: 'raw-source/v2' },
      select: { id: true, externalId: true, ingestKey: true, payloadHash: true, payload: true, ingestStatus: true },
    });
    const existingById = new Map(existing.map((row) => [row.id, row]));
    const existingReceipts = existing.map(({ id, externalId, ingestKey, payloadHash, payload }) =>
      ({ id, externalId, ingestKey, payloadHash, payload }));
    const rawRecordIds: string[] = [];
    const boundByIndex = new Map<number, { id: string; payloadHash: string; ingestStatus: string }>();
    for (const resolution of resolveRawSourceBatchByIndex(prepared.rows, existingReceipts)) {
      const written = resolution.kind === 'WRITE' ? await persistPreparedRawSourceRecord(tx, {
        workspaceId: command.workspaceId, runId: command.runId, sourceEntityId: null,
        providerKey: provider, sourceClass: query.sourceClass, row: resolution.row,
      }) : resolution.kind === 'EXISTING' ? existingById.get(resolution.rawRecordId) : boundByIndex.get(resolution.sourceRecordIndex);
      if (!written?.payloadHash) return hold('DISCOVERY_V3_RAW_RESULT_MISSING');
      boundByIndex.set(resolution.recordIndex, { ...written, payloadHash: written.payloadHash });
      await tx.discoveryV3RawLink.create({ data: {
        workspaceId: command.workspaceId, operationId: link.operationId, rawRecordId: written.id,
        queryOrdinal, recordIndex: companies[resolution.recordIndex]!.index, rawPayloadSha256: written.payloadHash,
      } });
      if (written.ingestStatus === 'ACCEPTED') rawRecordIds.push(written.id);
    }
    if (rawRecordIds.length) await materializeRawCompanies(tx, { ...command, rawRecordIds });
  }, workerAttempt);
}

export function createNativeDiscoveryV3Executor(deps: {
  prisma: Pick<PrismaService, 'withWorkspace'>;
  providers: Pick<DiscoveryProviderRegistry, 'routeCompanyDiscovery' | 'routeContactDiscovery'>;
  gateway: ModelGateway;
  runtimeTelemetry?: RuntimeTelemetry;
  broker?: ExecutionBroker;
}): DiscoveryV3WorkerExecutor {
  const operationStore = new DiscoveryV3OperationStore(deps.prisma);
  const profile = deps.broker ? createDiscoveryV3WebsiteProfile({ ...deps, broker: deps.broker, operationStore }) : undefined;
  const manufacturer = deps.broker ? createDiscoveryV3ManufacturerEvidence({ ...deps, broker: deps.broker, operationStore }) : undefined;
  const discoverContacts = deps.broker ? createDiscoveryV3ContactDiscovery({ ...deps, broker: deps.broker, operationStore }) : undefined;
  const publicWeb = deps.broker ? createDiscoveryV3PublicWebSource({ ...deps, broker: deps.broker, operationStore }) : undefined;
  const route = (tx: Prisma.TransactionClient, query: CompanyDiscoveryQuery) =>
    deps.providers.routeCompanyDiscovery(tx, query.sourceClass).then((adapters) =>
      narrowBySourceHints(query.filters, adapters, (adapter) => adapter.key));
  const qualify = async (command: DiscoveryV3Dispatch, companyId: string, signal: AbortSignal, workerAttempt: number,
    manufacturerEvidence?: ManufacturerNetworkEvidence) => {
    const authorizeExternalAction = () =>
      deps.prisma.withWorkspace(command.workspaceId, (tx) => companyMayUseExternalProcessing(tx, command.workspaceId, companyId));
    const loaded = await deps.prisma.withWorkspace(command.workspaceId, async (tx) => {
      const complete = await tx.discoveryCompanyJob.findFirst({
        where: { workspaceId: command.workspaceId, runId: command.runId, canonicalCompanyId: companyId, stage: 'done' },
      });
      if (complete) return null;
      if (!await companyMayUseExternalProcessing(tx, command.workspaceId, companyId)) return null;
      const company = await tx.canonicalCompany.findUnique({ where: { id: companyId, workspaceId: command.workspaceId } });
      const icp = await tx.icpDefinition.findUnique({ where: { id: command.icpId, workspaceId: command.workspaceId } });
      if (!company || !icp) return hold('DISCOVERY_V3_FIT_SUBJECT_MISSING');
      return { company, icp };
    });
    if (!loaded) return;
    const links: DiscoveryV3ResultLink[] = [];
    const judgment = await withDiscoveryV3OperationScope({
      command, store: operationStore, step: `fit/${companyId}`, signal, workerAttempt,
      onResult: (link) => links.push(link),
    }, () => judgeCompanyFitV3({
      gateway: deps.gateway, runtimeTelemetry: deps.runtimeTelemetry,
      workspaceId: command.workspaceId, runId: command.runId, authorizeExternalAction,
      icp: loaded.icp,
      company: { ...loaded.company, title: null, metaDescription: null,
        visibleText: discoveryV3WebsiteFitEvidence(loaded.company.attributes, loaded.company.domain), channelsSummary: '', manufacturerEvidence },
    }));
    signal.throwIfAborted();
    const persist = async (tx: Prisma.TransactionClient) => {
      if (!await companyMayUseExternalProcessing(tx, command.workspaceId, companyId)) return;
      await upsertLeadFit(tx, command.workspaceId, command.icpId, companyId, judgment);
      await tx.discoveryCompanyJob.createMany({ data: [{
        workspaceId: command.workspaceId, runId: command.runId, canonicalCompanyId: companyId,
        stage: 'done', verdictDeep: judgment.verdict, finishedAt: new Date(),
      }], skipDuplicates: true });
    };
    const last = links.at(-1);
    if (last) {
      await operationStore.acknowledge(
        command, last.operation, last.operationId, last.resultSha256,
        discoveryV3Digest(['discovery-v3/fit', command.requestSha256, command.icpId, companyId]),
        async (tx, proof) => {
          if (proof.schema !== 'fit-judgment/v1' || last.operation.action !== 'discovery.qualify_fit') {
            return hold('DISCOVERY_V3_RESULT_SCHEMA_MISMATCH');
          }
          await persist(tx);
        }, workerAttempt,
      );
    } else {
      // The shared fit core may resolve a peer-domain exclusion deterministically.
      if (judgment.verdict !== 'mismatch' || judgment.score !== 0) return hold('DISCOVERY_V3_FIT_RECEIPT_MISSING');
      await deps.prisma.withWorkspace(command.workspaceId, async (tx) => {
        const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
        if (!discoveryV3RunMatchesDispatch(run, command) || run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt) {
          return hold('DISCOVERY_V3_EXECUTOR_BINDING_MISMATCH');
        }
        await persist(tx);
      });
    }
  };
  return {
    async execute(command, signal, workerAttempt) {
      if (command.manufacturerNetworkRevision && !manufacturer) return hold('DISCOVERY_V3_MANUFACTURER_ROUTE_UNAVAILABLE');
      const plan = await deps.prisma.withWorkspace(command.workspaceId, async (tx) => {
        const run = await readDiscoveryV3RunForUpdate(tx, command.workspaceId, command.runId);
        if (!discoveryV3RunMatchesDispatch(run, command) || run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt) {
          return hold('DISCOVERY_V3_EXECUTOR_BINDING_MISMATCH');
        }
        const queries = nativeQueries(run.v3PlanQueries);
        const enabled = await Promise.all(queries.map((query) => route(tx, query)));
        const selected = frozenSources(run.v3SourceRoutes ?? enabled.map((adapters) => adapters.map(({ key }) => key)), queries.length);
        const routed = queries.map((query, index) => ({ query, adapters: selected[index]!.map((key) =>
          enabled[index]!.find((adapter) => adapter.key === key) ?? hold('DISCOVERY_V3_ROUTE_UNAVAILABLE')) }));
        if (run.v3SourceRoutes === null) await tx.discoveryRun.update({ where: { id: run.id }, data: {
          v3SourceRoutes: selected.map((keys) => [...keys]),
        } });
        return routed;
      });
      let queriesSucceeded = 0;
      for (const [ordinal, { query, adapters }] of plan.entries()) {
        for (const adapter of adapters) {
          const provider = adapter.key;
          signal.throwIfAborted();
          const authorizeExternalAction = () => deps.prisma.withWorkspace(command.workspaceId, async (tx) =>
            (await route(tx, query)).some(({ key }) => key === provider));
          if (provider === 'public_web') {
            if (!publicWeb) return hold('DISCOVERY_V3_ROUTE_UNAVAILABLE');
            await publicWeb(command, query, ordinal, signal, workerAttempt, authorizeExternalAction);
            continue;
          }
          if (!supportsDiscoveryV3CompanySource(provider)) return hold('DISCOVERY_V3_ROUTE_UNAVAILABLE');
          const links: DiscoveryV3ResultLink[] = [];
          const discover = () => withDiscoveryV3OperationScope({
            command, step: `query/${ordinal}/${provider}`, store: operationStore, signal, workerAttempt,
            onResult: (receipt) => links.push(receipt),
          }, () => adapter.discoverCompanies(query, {
            workspaceId: command.workspaceId, runId: command.runId, correlationId: command.runId,
            authorizeExternalAction,
          }));
          if (provider === 'channel_catalog') {
            links.push(await operationStore.channelCatalogProof(command, {
              step: `query/${ordinal}/${provider}/local`, kind: 'TOOL', ordinal: 1,
              provider: 'channel_catalog.query', action: 'channel_catalog.query', method: 'local-query',
              maxDurationMs: 1, requestSha256: discoveryV3Digest(JSON.parse(JSON.stringify(query))),
            }, workerAttempt, async () => (await discover()).records));
          } else {
            await discover();
          }
          if (links.length === 0) return hold('DISCOVERY_V3_SOURCE_RECEIPT_MISSING');
          for (const link of links) {
            signal.throwIfAborted();
            await commitSourceResult(operationStore, command, query, provider, ordinal, link, workerAttempt);
          }
        }
        queriesSucceeded++;
      }
      const { rawCount, companies } = await deps.prisma.withWorkspace(command.workspaceId, async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT DISTINCT raw.id FROM public.raw_source_record AS raw
          JOIN public.discovery_v3_raw_link AS link
            ON (link.workspace_id, link.raw_record_id, link.raw_payload_sha256) =
               (raw.workspace_id, raw.id, raw.payload_hash)
          JOIN public.discovery_v3_operation AS operation
            ON (operation.workspace_id, operation.id, operation.run_id) =
               (link.workspace_id, link.operation_id, raw.run_id)
          WHERE raw.workspace_id = ${command.workspaceId}::uuid AND raw.run_id = ${command.runId}::uuid
            AND raw.ingest_status = 'ACCEPTED' AND operation.status = 'SUCCEEDED' AND operation.ack IS NOT NULL
        `;
        const linked = await tx.identityLink.findMany({
          where: { workspaceId: command.workspaceId, canonicalType: 'company', rawRecordId: { in: rows.map(({ id }) => id) } },
          distinct: ['canonicalId'], select: { canonicalId: true }, orderBy: { canonicalId: 'asc' },
        });
        return { rawCount: rows.length, companies: linked.map(({ canonicalId }) => canonicalId) };
      });
      let websiteProfiles = 0;
      let manufacturerEvidenceCount = 0;
      let companiesWithContactDiscovery = 0;
      let contactsFound = 0;
      for (const [index, companyId] of companies.slice(0, MAX_STREAMING_L1_COMPANIES).entries()) {
        signal.throwIfAborted();
        if (profile && index < MAX_DISCOVERY_PROFILE_COMPANIES && await profile(command, companyId, signal, workerAttempt)) websiteProfiles++;
        const evidence = index < MAX_DISCOVERY_PROFILE_COMPANIES && command.manufacturerNetworkRevision
          ? await manufacturer?.(command, companyId, signal, workerAttempt) : undefined;
        if (evidence) manufacturerEvidenceCount++;
        await qualify(command, companyId, signal, workerAttempt, evidence);
        if (discoverContacts && companiesWithContactDiscovery < MAX_RUN_ENRICH_COMPANIES) {
          const outcome = await discoverContacts(command, companyId, signal, workerAttempt);
          if (outcome.status === 'DONE' || outcome.status === 'PENDING') companiesWithContactDiscovery++;
          contactsFound += outcome.contactsFound;
        }
      }
      const fitEvaluated = await deps.prisma.withWorkspace(command.workspaceId, (tx) => tx.discoveryCompanyJob.count({
        where: { workspaceId: command.workspaceId, runId: command.runId, stage: 'done' },
      }));
      return {
        status: companies.length > 0 ? 'PARTIAL' : 'DONE',
        summary: {
          queriesTotal: plan.length, queriesSucceeded, rawCount, canonicalCount: companies.length, fitEvaluated, websiteProfiles,
          manufacturerEvidenceCount, companiesWithContactDiscovery, contactsFound,
          ...(companies.length ? { nativeStage: 'contact_discovery', pendingStage: 'remaining_sources_and_contact_enrichment' } : {}),
        },
      };
    },
  };
}
