import { describe, expect, it, vi } from 'vitest';
import type { BudgetReservation, BudgetStore } from '../../tools/budget-store';
import { ToolBroker } from '../../tools/tool-broker';
import { ToolRegistry } from '../../tools/tool-registry';
import { RateLimiter } from '../../tools/rate-limiter';
import { createCrawl4aiFetchTool } from '../../tools/builtin-tools';
import { GenericOperationArtifactExecution } from '../../durable-results/artifact/generic-operation-artifact.execution';
import { productArtifactMaterializerRegistry } from '../../durable-results/artifact/generic-operation-artifact.runtime';
import { manifestFor, streamed } from '../../durable-results/artifact/materializers/materializer-fixtures.spec-helper';
import type { GenericOperationArtifactReference } from '../../durable-results/artifact/artifact.types';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import type { PersistGenericOperationArtifactInput } from '../../durable-results/artifact/generic-operation-artifact.service';
import { findContactPaths } from '../website-profile/contact-paths';
import { WEBSITE_PROFILE_TASK, WebsiteProfileProvider } from './website-profile.provider';

const WS = '44444444-4444-4444-8444-444444444444';
const AUTHORITY = '22222222-2222-4222-8222-222222222222';
const OP = '33333333-3333-4333-8333-333333333333';
const subjectRef = { subjectType: 'company' as const, subjectId: '55555555-5555-4555-8555-555555555555' };
const URL = 'https://www.pumpen.example/referenzen/werk/';
const SPAN = 'Für das Werk haben wir die Kreiselpumpen ausgelegt und beschafft.';
const CREATED = '2026-08-21T00:00:00.000Z';
const context = { workspaceId: WS, runId: 'run', artifactSubject: subjectRef };

type Saved = { bytes: Uint8Array; input: PersistGenericOperationArtifactInput; reference: GenericOperationArtifactReference; receipt: DurableExecutionReceipt };
function harness(options: { projectText?: string; projectUrl?: string; unavailable?: boolean; homepageNav?: string } = {}) {
  const stored = new Map<string, Saved>();
  const settled = new Map<string, Saved>();
  const fetchHtml = vi.fn(async (url: string) => ({
    status: 200, contentType: 'text/html', body: Buffer.from('<html><body><article><h1>Pumpentechnik</h1><p>' +
      (url === (options.projectUrl ?? URL) ? options.projectText ?? SPAN.repeat(5) : 'Autorisierter Händler und Vertriebspartner. Lagerprogramm ab Lager. '.repeat(8)) +
      '</p></article>' + (options.homepageNav ?? '') + '</body></html>'),
  }));
  const tool = createCrawl4aiFetchTool({
    isAllowedByRobots: async () => true,
    fetchHttpFirst: async (url, opts) => {
      const { fetchPageHttpFirst } = await import('../../adapters/http-first-fetch');
      return fetchPageHttpFirst(url, { ...opts, fetchHtml });
    },
    crawlUrl: async () => { throw new Error('renderer must not replace exact HTML'); },
  });
  const budgetStore = {
    reserve: vi.fn(async (input: { operationKey: string }): Promise<BudgetReservation> => {
      const saved = settled.get(input.operationKey);
      return { workspaceId: WS, accountKey: 'run', operationId: OP, authorityId: AUTHORITY,
        estimatedMicrousd: 10_000n, replay: !!saved,
        ...(saved ? { replayResult: { resultStrategy: 'artifact_reference' as const, reference: saved.reference }, receipt: saved.receipt } : {}),
      };
    }),
    markResultUnknown: vi.fn(),
    release: vi.fn(),
  } as unknown as BudgetStore;
  const service = {
    persist: vi.fn(async (input: PersistGenericOperationArtifactInput) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.source.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const manifest = manifestFor(input.resultSchema, input.source.mediaType, bytes);
      const reference: GenericOperationArtifactReference = {
        schemaVersion: 'generic-operation-artifact-ref/v1', artifactId: manifest.artifactId,
        operationId: OP, resultSchema: input.resultSchema, sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes, mediaType: manifest.mediaType, expiresAt: manifest.expiresAt,
      };
      const receipt: DurableExecutionReceipt = {
        schemaVersion: 'durable-execution-receipt/v1', scopeKey: WS, authorityId: AUTHORITY,
        accountId: '66666666-6666-4666-8666-666666666666', operationId: OP,
        operationKey: 'run:tool:fetch', resultStrategy: 'artifact_reference', resultSchema: input.resultSchema,
        resultDigest: manifest.sha256, artifactId: manifest.artifactId,
        usage: { currency: 'USD', unit: 'microusd', callCount: 1 }, costBasis: 'estimated_upper_bound', status: 'SETTLED',
      };
      const saved = { bytes, input, reference, receipt };
      stored.set(reference.sha256, saved);
      // This is only the storage/budget I/O substitute; the real broker/execution/materializer are used.
      const requests = vi.mocked(budgetStore.reserve).mock.calls;
      settled.set(requests[requests.length - 1]![0].operationKey, saved);
      return { reference, durableReceipt: receipt };
    }),
    readVerified: vi.fn(async (input: { reference: GenericOperationArtifactReference }) => {
      if (options.unavailable) throw new Error('GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING');
      const saved = stored.get(input.reference.sha256)!;
      return { manifest: manifestFor(saved.input.resultSchema, saved.input.source.mediaType, saved.bytes),
        expectedFacts: saved.input.expectedFacts, body: streamed(saved.bytes) };
    }),
  };
  const artifact = new GenericOperationArtifactExecution({
    withWorkspace: async (_ws, fn) => fn({} as never),
    binding: { resolveForExecution: async () => ({ status: 'BOUND', subjectRef }) } as never,
    service: service as never, materializers: productArtifactMaterializerRegistry(),
  });
  function broker() {
    const registry = new ToolRegistry(); registry.register(tool);
    let clock = 1_000_000;
    return new ToolBroker({ registry, budgetStore, limiter: new RateLimiter(), artifactExecution: artifact,
      now: () => { clock += 10_000; return clock; } });
  }
  return { broker, fetchHtml, service };
}

async function profile(broker: ToolBroker, projectUrl = URL) {
  return new WebsiteProfileProvider({ broker }).profile({
    domain: 'pumpen.example', homeCountry: 'DE', icpContext: 'Kreiselpumpen', projectUrl,
  }, context);
}

describe('project evidence across real broker and artifact boundaries', () => {
  it('persists and replays ordinary navigation text through the existing crawl4ai-fetch/v1 materializer', async () => {
    const h = harness({ homepageNav: '<nav><a href="/kontakt">Kontakt</a><a href="/impressum">Impressum</a></nav>' });
    const broker = h.broker();
    const ctx = { ...context, taskContractId: WEBSITE_PROFILE_TASK, purpose: ['enrichment'] };
    const input = { url: 'https://pumpen.example/', maxChars: 40000 };
    const first = await broker.invoke<typeof input, { url: string; text: string; contentHash: string }>('crawl4ai.fetch', input, ctx);
    expect(first.durableReceipt?.resultSchema).toBe('crawl4ai-fetch/v1');
    expect(findContactPaths(first.data.text, 'pumpen.example')).toMatchObject({
      contactPage: 'https://pumpen.example/kontakt', impressumPage: 'https://pumpen.example/impressum' });
    expect(first.provenance?.parserVersion).toBe('artifact/crawl4ai-fetch/v1');
    const calls = h.fetchHtml.mock.calls.length;
    const second = await broker.invoke<typeof input, { url: string; text: string; contentHash: string }>('crawl4ai.fetch', input, ctx);
    expect(second.data).toEqual(first.data);
    expect(h.fetchHtml).toHaveBeenCalledTimes(calls);
  });

  it('retains exact project evidence after persistence and replay with its original artifact time', async () => {
    const h = harness();
    const first = await profile(h.broker());
    expect(first?.projectEvidence).toMatchObject({ source_url: URL, fetched_at: CREATED });
    expect(first?.projectEvidence?.spans.join(' ')).toContain(SPAN);
    const calls = h.fetchHtml.mock.calls.length;
    const second = await profile(h.broker());
    expect(second?.projectEvidence).toEqual(first?.projectEvidence);
    expect(h.fetchHtml).toHaveBeenCalledTimes(calls);
  });

  it('does not invent project evidence for a thin exact HTML page', async () => {
    const h = harness({ projectText: '' });
    expect((await profile(h.broker()))?.projectEvidence).toBeUndefined();
  });

  it('does not relabel a persisted homepage as a project whose path was not storable', async () => {
    const projectUrl = 'https://www.pumpen.example/referenzen/Werk/';
    const h = harness({ projectUrl });
    expect((await profile(h.broker(), projectUrl))?.projectEvidence).toBeUndefined();
  });

  it('does not repeat a physical fetch when the settled artifact cannot be verified', async () => {
    const h = harness();
    await profile(h.broker());
    const calls = h.fetchHtml.mock.calls.length;
    h.service.readVerified.mockRejectedValue(new Error('GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING'));
    await expect(profile(h.broker())).rejects.toThrow();
    expect(h.fetchHtml).toHaveBeenCalledTimes(calls);
  });

  it('does not fetch again after first-read verification fails following settlement', async () => {
    const h = harness({ unavailable: true });
    await expect(profile(h.broker())).rejects.toThrow();
    expect(h.service.persist).toHaveBeenCalledOnce();
    expect(h.fetchHtml).toHaveBeenCalledOnce();
    await expect(profile(h.broker())).rejects.toThrow();
    expect(h.service.persist).toHaveBeenCalledOnce();
    expect(h.fetchHtml).toHaveBeenCalledOnce();
  });
});
