import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { extractPublicContacts } from '../adapters/contact-extractor';
import { isPdfDocumentUrl } from '../adapters/pdf-url-guard';
import { discoveryV3RobotsAllowsPath } from '../adapters/discovery-v3-robots';
import { DiscoveryV3ArtifactRepository } from '../durable-results/artifact/discovery-v3-artifact.repository';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import { resolveStreamingContactDiscoveryLawfulBasis } from '../temporal/streaming-contact-enrichment';
import type { HttpGetInput, HttpGetOutput } from '../tools/source-tools';
import type { ExecutionBroker, ToolContext } from '../tools/tool-contract';
import { companyMayUseExternalProcessing } from './company-suppression-gate';
import { stampLawfulBasis } from './compliance/email-verification-gate';
import {
  assertContactDiscoveryCompanyProvenance,
  persistContactDiscoveryAdapter,
  readAndAuditContactDiscovery,
} from './contact-discovery-core';
import { withDiscoveryV3OperationScope, type DiscoveryV3ResultLink } from './discovery-v3-operation-scope';
import { discoveryV3Digest, type DiscoveryV3OperationStore } from './discovery-v3-operations';
import { assertContactDiscoveryResultBound } from './email-guess-targets';
import { MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES } from './execution-envelope';
import { collectCompanyChannels, type ImpressumPage } from './impressum/collect-company-channels';
import { isCompanyWebsitePageUrl, legalPageCandidates, rankLegalPageLinks } from './impressum/find-legal-pages';
import { stripHtml } from './impressum/impressum-extract';
import type { DiscoveryProviderRegistry } from './provider.registry';
import { extractAnchorsFromHtml } from './providers/decision-maker.provider';
import { buildPublicContacts } from './providers/public-web.provider';
import { isPdfBodyContent } from './streaming/raw-html-parser';
import { canonicalizeSuppressionValues } from './suppression-value';

const PROVIDER = 'public_web';
const FETCH_TOOL = 'http.get';
const FETCH_SCHEMA = 'http-get/v1';
const MAX_PAGE_TEXT_LENGTH = 40_000;
const MAX_PAGE_HTML_LENGTH = 300_000;
const MAX_ROBOTS_BYTES = 100 * 1024;
const SKIPPED = { status: 'SKIPPED', contactsFound: 0 } as const;
const PENDING = { status: 'PENDING', contactsFound: 0 } as const;
const POLICY_CHANGED = new Error('DISCOVERY_V3_CONTACT_POLICY_CHANGED');

interface CapturedContactProof {
  readonly url: string;
  readonly status: number;
  readonly ok: boolean;
  readonly bodySha256: string;
  readonly receipt: DiscoveryV3ResultLink;
}

export interface DiscoveryV3ContactStageResult {
  readonly status: 'DONE' | 'SKIPPED' | 'PENDING';
  readonly contactsFound: number;
}

export function createDiscoveryV3ContactDiscovery(deps: {
  prisma: Pick<PrismaService, 'withWorkspace'>;
  providers: Pick<DiscoveryProviderRegistry, 'routeContactDiscovery'>;
  operationStore: DiscoveryV3OperationStore;
  broker: ExecutionBroker;
}) {
  const { prisma, providers, operationStore, broker } = deps;
  const artifacts = new DiscoveryV3ArtifactRepository();

  async function readCurrentBasis(tx: Prisma.TransactionClient) {
    const adapters = await providers.routeContactDiscovery(tx);
    if (!adapters.some(({ key }) => key === PROVIDER)) return undefined;
    const policy = await tx.dataProvider.findUnique({ where: { key: 'decision_maker' }, select: { config: true } });
    return resolveStreamingContactDiscoveryLawfulBasis(process.env.CONTACT_DISCOVERY_RUN_LAWFUL_BASIS, policy?.config);
  }

  return async (
    command: DiscoveryV3Dispatch, companyId: string, signal: AbortSignal, workerAttempt: number,
  ): Promise<DiscoveryV3ContactStageResult> => {
    signal.throwIfAborted();
    const { workspaceId, runId } = command;
    const jobScope = { workspaceId, runId, canonicalCompanyId: companyId, stage: 'done', verdictDeep: 'match' };
    const readJob = (tx: Prisma.TransactionClient) => tx.discoveryCompanyJob.findFirst({
      where: {
        ...jobScope,
        run: {
          status: 'RUNNING', executionContractVersion: 3, v3WorkerAttempt: workerAttempt,
          planId: command.planId, icpId: command.icpId, v3AttemptId: command.attemptId,
          v3RequestSha256: command.requestSha256, v3TaskQueue: command.taskQueue,
          v3ManufacturerRevision: command.manufacturerNetworkRevision ?? null,
          v3DispatchExpiresAt: new Date(command.dispatchExpiresAt),
        },
      },
      select: { id: true, streamingL2ContactsCreated: true },
    });
    const checkedCompany = async (tx: Prisma.TransactionClient) => {
      if (!await companyMayUseExternalProcessing(tx, workspaceId, companyId)) return null;
      await assertContactDiscoveryCompanyProvenance(tx, companyId);
      return tx.canonicalCompany.findUnique({ where: { id: companyId, workspaceId } });
    };
    const loaded = await prisma.withWorkspace(workspaceId, async (tx) => {
      const job = await readJob(tx);
      if (!job || job.streamingL2ContactsCreated !== null) return { job } as const;
      const [company, basis] = await Promise.all([checkedCompany(tx), readCurrentBasis(tx)]);
      const suppressedEmails = canonicalizeSuppressionValues('email', (await tx.suppressionRecord.findMany({
        where: { type: 'email' }, select: { value: true },
      })).map(({ value }) => value));
      return { job, company, basis, suppressedEmails } as const;
    });
    if (!loaded.job) return SKIPPED;
    if (loaded.job.streamingL2ContactsCreated !== null) {
      return { status: 'DONE', contactsFound: loaded.job.streamingL2ContactsCreated };
    }
    const { company, basis, suppressedEmails } = loaded;
    if (!company) return SKIPPED;
    const domain = company.domain;
    if (!basis || !domain || !suppressedEmails) return PENDING;

    const startUrl = `https://${domain}/`;
    if (!isCompanyWebsitePageUrl(startUrl, domain)) return PENDING;
    const origin = new URL(startUrl).origin;
    const step = `contacts/${companyId}/${PROVIDER}`;
    const subjectRef = { subjectType: 'company', subjectId: companyId } as const;
    const context: ToolContext = {
      workspaceId, runId, correlationId: companyId, artifactSubject: subjectRef,
      taskContractId: 'contact.find_decision_makers', purpose: ['discovery', 'enrichment'],
      authorizeExternalAction: () => prisma.withWorkspace(workspaceId, async (tx) =>
        (await checkedCompany(tx))?.domain === domain &&
        Boolean(await readJob(tx)) &&
        JSON.stringify(await readCurrentBasis(tx)) === JSON.stringify(basis)),
    };
    const receipts: DiscoveryV3ResultLink[] = [];
    const captures: CapturedContactProof[] = [];
    const fetchPage = async (url: string, timeoutMs: number) => {
      signal.throwIfAborted();
      const before = receipts.length;
      const { data } = await broker.invoke<HttpGetInput, HttpGetOutput>(FETCH_TOOL, { url, timeoutMs }, context);
      const receipt = receipts[before];
      if (!receipt) return null;
      if (
        receipts.length !== before + 1 || receipt.operation.action !== FETCH_TOOL ||
        receipt.operation.provider !== FETCH_TOOL || receipt.operation.kind !== 'TOOL' ||
        !receipt.operation.step.startsWith(`${step}/tool/`) || !data.finalUrl || data.blocked ||
        !isCompanyWebsitePageUrl(data.finalUrl, domain) || new URL(data.finalUrl).origin !== origin
      ) throw new Error('DISCOVERY_V3_CONTACT_ARTIFACT_INVALID');
      const captured = {
        url: data.finalUrl, status: data.status, ok: data.ok, receipt,
        bodySha256: createHash('sha256').update(data.text, 'utf8').digest('hex'),
      };
      captures.push(captured);
      return { ...captured, body: data.text };
    };

    const pages = await withDiscoveryV3OperationScope({
      command, step, store: operationStore, signal, workerAttempt, onResult: (receipt) => receipts.push(receipt),
    }, async () => {
      const robotsUrl = new URL('/robots.txt', origin).toString();
      const robots = await fetchPage(robotsUrl, 5_000);
      if (!robots || robots.url !== robotsUrl || Buffer.byteLength(robots.body, 'utf8') > MAX_ROBOTS_BYTES) return null;
      const noRules = robots.status === 404 || robots.status === 410;
      if (!noRules && (!robots.ok || robots.status !== 200 || robots.body.includes('\uFFFD'))) return null;
      const allowed = (url: string) => {
        const parsed = new URL(url);
        if (parsed.origin !== origin || !isCompanyWebsitePageUrl(url, domain)) return false;
        try {
          return noRules || discoveryV3RobotsAllowsPath(robots.body, `${parsed.pathname}${parsed.search}`);
        } catch {
          return false;
        }
      };
      if (!allowed(startUrl)) return null;

      const home = await fetchPage(startUrl, 12_000);
      if (!home?.ok || !home.body || isPdfBodyContent(home.body)) return null;
      const linked = extractAnchorsFromHtml(home.body, home.url);
      const candidates = legalPageCandidates(home.url, linked, { maxPages: MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES });
      const pageText = (body: string) => stripHtml(body.slice(0, MAX_PAGE_HTML_LENGTH)).slice(0, MAX_PAGE_TEXT_LENGTH);
      const sources = [{ url: home.url, text: pageText(home.body) }];
      const channels: ImpressumPage[] = [];
      for (const candidate of candidates) {
        if (!allowed(candidate.url) || isPdfDocumentUrl(candidate.url)) continue;
        const page = await fetchPage(candidate.url, 12_000);
        if (!page?.ok || !page.body || isPdfBodyContent(page.body)) continue;
        const text = pageText(page.body);
        sources.push({ url: page.url, text });
        const actualKind = rankLegalPageLinks([page.url])[0]?.kind;
        if (actualKind === candidate.kind) {
          channels.push({ kind: actualKind, url: page.url, html: page.body.slice(0, MAX_PAGE_HTML_LENGTH), text });
        }
      }
      return { sources, channels };
    });
    signal.throwIfAborted();
    if (!pages) return PENDING;

    // The application receives the PII only from the verified subject-bound
    // artifact reader. The linking operation rows keep the closed reference.
    const { sources, channels } = pages;
    const observations = extractPublicContacts(sources);
    const contacts = buildPublicContacts(domain, observations.filter(({ type }) => type === 'email'),
      observations.find(({ type }) => type === 'phone')?.value);
    assertContactDiscoveryResultBound(contacts.length);
    const companyChannels = collectCompanyChannels({ domain, country: company.country ?? undefined, pages: channels })
      .filter(({ channel, emailType }) => channel !== 'email' || (emailType !== undefined &&
        emailType !== 'personal' && emailType !== 'other'));
    const actorId = `discovery-run:${runId}`;
    const lawfulBasis = stampLawfulBasis(basis, actorId, new Date().toISOString());
    const consumer = discoveryV3Digest(['discovery-v3/contact-public-web', command.requestSha256, companyId]);
    try {
      const contactsFound = await operationStore.acknowledgeBatch(command, receipts, consumer, async (tx, proofs) => {
        signal.throwIfAborted();
        const current = await checkedCompany(tx);
        if (current?.domain !== domain || JSON.stringify(await readCurrentBasis(tx)) !== JSON.stringify(basis) ||
            !(await readJob(tx))) throw POLICY_CHANGED;
        for (const [index, page] of captures.entries()) {
          const { operationId, operation, resultSha256 } = page.receipt;
          const artifact = await artifacts.findExact(tx, {
            identity: { workspaceId, operationId, requestSha256: operation.requestSha256 },
            subjectRef, projection: proofs[index]!, resultSha256,
          });
          const facts = artifact?.expectedFacts;
          if (artifact?.manifest.resultSchema !== FETCH_SCHEMA ||
              artifact.manifest.sha256 !== page.bodySha256 ||
              !facts || !('status' in facts) || facts.status !== page.status || facts.ok !== page.ok ||
              facts.blocked !== null || facts.sanitizedUrl !== page.url) {
            throw new Error('DISCOVERY_V3_CONTACT_ARTIFACT_INVALID');
          }
        }
        const persisted = await persistContactDiscoveryAdapter(tx, {
          workspaceId, company: current, adapterKey: PROVIDER, contacts, companyChannels, suppressedEmails, lawfulBasis,
        });
        if (persisted.suppressed) throw POLICY_CHANGED;
        const saved = await readAndAuditContactDiscovery(tx, {
          workspaceId, companyId, lawfulBasis,
          audit: { actorId, actorKind: 'system', purpose: 'contact_discovery', correlationId: runId },
        });
        const updated = await tx.discoveryCompanyJob.updateMany({
          where: { ...jobScope, streamingL2ContactsCreated: null },
          data: { streamingL2ContactsCreated: saved.length },
        });
        if (updated.count !== 1) throw POLICY_CHANGED;
        return saved.length;
      }, workerAttempt);
      const committed = contactsFound ??
        (await prisma.withWorkspace(workspaceId, readJob))?.streamingL2ContactsCreated;
      return committed === null || committed === undefined ? PENDING : { status: 'DONE', contactsFound: committed };
    } catch (error) {
      if (error === POLICY_CHANGED) return PENDING;
      throw error;
    }
  };
}
