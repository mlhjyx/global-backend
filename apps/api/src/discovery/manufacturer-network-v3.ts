import type { Prisma } from '@prisma/client';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { parseDiscoveryV3ArtifactProjection } from '../tools/discovery-v3-artifact-execution-port';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';
import type { ExecutionBroker, ToolResult } from '../tools/tool-contract';
import { readBuyerScenarioFromPlan } from './buyer-procurement-scenarios';
import { companyMayUseExternalProcessing } from './company-suppression-gate';
import { withDiscoveryV3OperationScope, type DiscoveryV3ResultLink } from './discovery-v3-operation-scope';
import { discoveryV3Digest, DiscoveryV3OperationError, type DiscoveryV3OperationStore } from './discovery-v3-operations';
import { discoveryV3RunMatchesDispatch } from './discovery-v3-run-state';
import type { ManufacturerNetworkEvidence } from './manufacturer-network-evidence';
import { loadReviewedManufacturerLegalNames } from './manufacturer-network-identity';
import { commitDiscoveryV3ManufacturerEvidence, loadDiscoveryV3ManufacturerEvidence, loadManufacturerSourceConfiguration } from './manufacturer-network-store';
import { ManufacturerNetworkProvider } from './providers/manufacturer-network.provider';

const projections = registerCatalogResultProjections(new TypedProjectionRegistry());
projections.freeze();

function invalid(): never {
  throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
}

function checkedLink(link: DiscoveryV3ResultLink | undefined, step: string, phase: 1 | 2): DiscoveryV3ResultLink {
  const tool = phase === 1 ? 'searxng.search' : 'crawl4ai.fetch';
  if (!link || link.operation.kind !== 'TOOL' || link.operation.step !== `${step}/tool/${phase}` ||
    link.operation.ordinal !== 1 || link.operation.action !== tool || link.operation.provider !== tool || link.operation.method !== 'invoke') {
    return invalid();
  }
  return link;
}

function fetchReference(projection: unknown, link: DiscoveryV3ResultLink) {
  return parseDiscoveryV3ArtifactProjection(projection, {
    operationId: link.operationId, resultSchema: 'crawl4ai-fetch/v1', resultSha256: link.resultSha256,
  });
}

function proveManufacturerResult(
  evidence: ManufacturerNetworkEvidence | undefined, proofs: readonly GenericOperationProjection[], fetched?: DiscoveryV3ResultLink,
): void {
  const search = proofs[0];
  if (!search || search.kind !== 'tool' || search.schema !== 'searxng-search/v1') return invalid();
  const lookup = projections.restore(search.data) as ToolResult<{ results: Array<{ url: string }> }>;
  const reference = fetched && fetchReference(proofs[1], fetched);
  if (evidence && (!reference || reference.artifactId !== evidence.artifactId || reference.operationId !== evidence.operationId ||
    reference.sha256 !== evidence.resultDigest || !lookup.data.results.some(({ url }) => url === evidence.sourceUrl))) return invalid();
}

export function createDiscoveryV3ManufacturerEvidence(deps: {
  prisma: Pick<PrismaService, 'withWorkspace'>;
  operationStore: DiscoveryV3OperationStore;
  broker: ExecutionBroker;
  now?: () => Date;
}) {
  const { prisma, broker, operationStore } = deps;
  const now = deps.now ?? (() => new Date());
  return async (command: DiscoveryV3Dispatch, companyId: string, signal: AbortSignal, workerAttempt: number): Promise<ManufacturerNetworkEvidence | undefined> => {
    if (!command.manufacturerNetworkRevision) return undefined;
    const step = `manufacturer/${companyId}`;
    const consumer = discoveryV3Digest(['discovery-v3/manufacturer', command.requestSha256, companyId]);
    const mayUse = (tx: Prisma.TransactionClient) => companyMayUseExternalProcessing(tx, command.workspaceId, companyId);
    const loadCompany = (tx: Prisma.TransactionClient) => tx.canonicalCompany.findUnique({
      where: { id: companyId, workspaceId: command.workspaceId }, select: { id: true, name: true, domain: true, country: true },
    });
    const setup = await prisma.withWorkspace(command.workspaceId, async (tx) => {
      const run = await tx.discoveryRun.findUnique({ where: { id: command.runId, workspaceId: command.workspaceId } });
      if (!discoveryV3RunMatchesDispatch(run, command) || !run.v3WorkerAcceptedAt) return invalid();
      if (readBuyerScenarioFromPlan(run.v3PlanQueries) !== 'distribution' || !await mayUse(tx)) return undefined;
      const company = await loadCompany(tx);
      if (!company?.domain || company.country !== 'DE') return undefined;
      const lookup = await tx.discoveryV3Operation.findFirst({ where: {
        workspaceId: command.workspaceId, runId: command.runId, step: `${step}/tool/1`, kind: 'TOOL', ordinal: 1,
      }, select: { ack: true } });
      if (lookup?.ack) {
        if (lookup.ack !== consumer) return invalid();
        return { evidence: await loadDiscoveryV3ManufacturerEvidence(tx, command, company, now()) };
      }
      if (run.status !== 'RUNNING' || run.v3WorkerAttempt !== workerAttempt) return invalid();
      return { company };
    });
    if (!setup) return undefined;
    if (!setup.company) return setup.evidence;
    const { company } = setup;
    const links: DiscoveryV3ResultLink[] = [];
    const provider = new ManufacturerNetworkProvider({
      now,
      loadConfiguration: () => prisma.withWorkspace(command.workspaceId, loadManufacturerSourceConfiguration),
      readIdentityAliases: (subject, refs) => prisma.withWorkspace(command.workspaceId,
        (tx) => loadReviewedManufacturerLegalNames(tx, subject, refs, now())),
      discoveryV3Wire: {
        async search(input, context) {
          const result = await broker.invoke<typeof input, { results: Array<{ url: string }> }>('searxng.search', input, context);
          if (!links.length && result.degraded) return { ...result, data: { results: [] } };
          checkedLink(links[0], step, 1);
          return result;
        },
        async fetch(input, context) {
          const result = await broker.invoke<typeof input, { url: string; text: string; contentHash: string }>('crawl4ai.fetch', input, context);
          if (links.length === 1 && result.degraded) return undefined;
          const link = checkedLink(links[1], step, 2);
          const reference = await prisma.withWorkspace(command.workspaceId, async (tx) => {
            const row = await tx.discoveryV3Operation.findUnique({ where: { workspaceId_id: { workspaceId: command.workspaceId, id: link.operationId } } });
            if (!row || row.runId !== command.runId || row.status !== 'SUCCEEDED' || row.step !== link.operation.step ||
              row.requestSha256 !== link.operation.requestSha256 || row.resultSha256 !== link.resultSha256) return invalid();
            return fetchReference(row.result, link);
          });
          if (reference.expiresAt !== result.provenance?.artifactExpiresAt) return invalid();
          return { result, artifact: { artifactId: reference.artifactId, operationId: link.operationId, resultDigest: reference.sha256 } };
        },
      },
    });
    const result = await withDiscoveryV3OperationScope({
      command, step, store: operationStore, signal, workerAttempt,
      onResult: (link) => { if (link.operation.method === 'invoke') links.push(link); },
    }, () => provider.enrichCompany({ name: company.name, domain: company.domain ?? undefined, country: company.country ?? undefined }, {
      workspaceId: command.workspaceId, runId: command.runId, manufacturerNetworkRevision: command.manufacturerNetworkRevision,
      artifactSubject: { subjectType: 'company', subjectId: companyId },
      authorizeExternalAction: () => prisma.withWorkspace(command.workspaceId, mayUse),
    }));
    if (!links.length && !result.manufacturerEvidence) return undefined;
    if (links.length > 2) return invalid();
    const lookup = checkedLink(links[0], step, 1);
    const fetched = links.length === 2 ? checkedLink(links[1], step, 2) : undefined;
    signal.throwIfAborted();
    await operationStore.acknowledgeBatch(command, links, consumer, async (tx, proofs) => {
      const evidence = result.manufacturerEvidence;
      proveManufacturerResult(evidence, proofs, fetched);
      if (evidence && fetched) await commitDiscoveryV3ManufacturerEvidence(tx, command, companyId, workerAttempt, consumer,
        lookup, fetched, evidence, now());
    }, workerAttempt);
    return prisma.withWorkspace(command.workspaceId, async (tx) => {
      if (!await mayUse(tx)) return undefined;
      const current = await loadCompany(tx);
      return current ? loadDiscoveryV3ManufacturerEvidence(tx, command, current, now()) : undefined;
    });
  };
}
