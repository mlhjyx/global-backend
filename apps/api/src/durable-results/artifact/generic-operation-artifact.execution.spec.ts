import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetReservation } from '../../tools/budget-store';
import type { Tool } from '../../tools/tool-contract';
import type { DurableResultStrategy } from '../durable-result-strategy';
import type { DurableExecutionReceipt } from '../durable-execution-receipt';
import { GenericOperationArtifactExecution } from './generic-operation-artifact.execution';
import { productArtifactMaterializerRegistry } from './generic-operation-artifact.runtime';
import { manifestFor } from './materializers/materializer-fixtures.spec-helper';
import type { PersistGenericOperationArtifactInput } from './generic-operation-artifact.service';

const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const AUTHORITY_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const COMPANY_ID = '55555555-5555-4555-8555-555555555555';
const ARTIFACT_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-25T00:00:00.000Z');
const subjectRef = { subjectType: 'company' as const, subjectId: COMPANY_ID };

const STRATEGIES: Record<string, DurableResultStrategy> = {
  'crawl4ai-fetch/v1': {
    kind: 'artifact_reference', schema: 'crawl4ai-fetch/v1', maxBytes: 300_000,
    mediaTypes: ['text/markdown'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
  },
  'crawl4ai-render/v1': {
    kind: 'artifact_reference', schema: 'crawl4ai-render/v1', maxBytes: 3_000_000,
    mediaTypes: ['text/html'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
  },
  'http-get/v1': {
    kind: 'artifact_reference', schema: 'http-get/v1', maxBytes: 3_000_000,
    mediaTypes: ['text/plain'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
  },
};

function toolFor(schema: string, id = 'crawl4ai.fetch'): Tool {
  return { id, durableResultStrategy: STRATEGIES[schema] } as unknown as Tool;
}

function reservation(overrides: Partial<BudgetReservation> = {}): BudgetReservation {
  return {
    workspaceId: WORKSPACE_ID,
    accountKey: 'run',
    operationId: OPERATION_ID,
    estimatedMicrousd: 10_000n,
    authorityId: AUTHORITY_ID,
    replay: false,
    ...overrides,
  };
}

function receipt(schema: string): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: WORKSPACE_ID,
    authorityId: AUTHORITY_ID,
    accountId: '66666666-6666-4666-8666-666666666666',
    operationId: OPERATION_ID,
    operationKey: 'run:tool:x',
    resultStrategy: 'artifact_reference',
    resultSchema: schema,
    resultDigest: 'a'.repeat(64),
    artifactId: ARTIFACT_ID,
    usage: { currency: 'USD', unit: 'microusd', callCount: 1, chargedMicrousd: '10000', upperBoundMicrousd: '10000' },
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  };
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function harness(decision: unknown = { status: 'BOUND', subjectRef }) {
  const persisted: Array<PersistGenericOperationArtifactInput & { bytes: Uint8Array }> = [];
  const tx = {} as Prisma.TransactionClient;
  const withWorkspace = vi.fn(async (_workspaceId: string, fn: (t: Prisma.TransactionClient) => Promise<unknown>) => fn(tx));
  const contract = { resolveForExecution: vi.fn(async () => decision) };
  const service = {
    persist: vi.fn(async (input: PersistGenericOperationArtifactInput) => {
      persisted.push({ ...input, bytes: await collect(input.source.body) });
      return { reference: {} as never, durableReceipt: receipt(input.resultSchema) };
    }),
    readVerified: vi.fn(),
  };
  const execution = new GenericOperationArtifactExecution({
    withWorkspace: withWorkspace as never,
    binding: contract as never,
    service: service as never,
    materializers: productArtifactMaterializerRegistry(),
    now: () => NOW,
  });
  return { execution, withWorkspace, contract, service, persisted, tx };
}

async function replayedData(
  schema: string,
  persisted: PersistGenericOperationArtifactInput & { bytes: Uint8Array },
): Promise<unknown> {
  const manifest = manifestFor(schema, persisted.source.mediaType, persisted.bytes);
  const body = (async function* () {
    if (persisted.bytes.byteLength > 0) yield persisted.bytes;
  })();
  return productArtifactMaterializerRegistry().materialize(
    schema as never, body, manifest, persisted.expectedFacts,
  );
}

describe('GenericOperationArtifactExecution.admit', () => {
  it('resolves the subject for execution inside one RLS workspace transaction', async () => {
    const { execution, withWorkspace, contract, tx } = harness();
    await expect(execution.admit({ workspaceId: WORKSPACE_ID, resultSchema: 'crawl4ai-fetch/v1', subjectRef }))
      .resolves.toEqual({ status: 'BOUND', subjectRef });
    expect(withWorkspace).toHaveBeenCalledWith(WORKSPACE_ID, expect.any(Function));
    expect(contract.resolveForExecution).toHaveBeenCalledWith(tx, {
      resultSchema: 'crawl4ai-fetch/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, subjectRef,
    });
  });

  it.each([
    [{ status: 'DENIED', reason: 'SUBJECT_TOMBSTONED' }, 'SUBJECT_TOMBSTONED'],
    [{ status: 'DENIED', reason: 'SUBJECT_SUPPRESSED' }, 'SUBJECT_SUPPRESSED'],
    [{ status: 'DENIED', reason: 'SUBJECT_BINDING_INVALID' }, 'SUBJECT_BINDING_INVALID'],
    [{ status: 'SUBJECT_BINDING_HOLD', reason: 'CANONICAL_SUBJECT_UNAVAILABLE' }, 'SUBJECT_BINDING_HOLD'],
  ])('maps %o to a denial', async (decision, reason) => {
    const { execution } = harness(decision);
    await expect(execution.admit({ workspaceId: WORKSPACE_ID, resultSchema: 'crawl4ai-fetch/v1', subjectRef }))
      .resolves.toEqual({ status: 'DENIED', reason });
  });
});

describe('GenericOperationArtifactExecution.persist', () => {
  it('persists a scrubbed crawl4ai page bound to the subject and returns exactly what replay materializes', async () => {
    const { execution, persisted } = harness();
    const result = await execution.persist({
      reservation: reservation(),
      tool: toolFor('crawl4ai-fetch/v1'),
      input: { url: 'https://www.pumpen-handel.example/impressum' },
      result: {
        data: {
          url: 'https://www.pumpen-handel.example/impressum',
          text: 'Pumpen Großhandel GmbH\r\n\r\n\r\nKontakt: info@pumpen-handel.example',
          contentHash: 'raw',
        },
        costCents: 1,
      },
      subjectRef,
    });

    const call = persisted[0]!;
    expect(call).toMatchObject({
      authorityId: AUTHORITY_ID,
      resultSchema: 'crawl4ai-fetch/v1',
      privacyClass: 'PERSONAL_DATA',
      subjectRef,
      maxBytes: 300_000,
      observedMicrousd: 10_000n,
      expiresAt: '2026-09-26T00:00:00.000Z',
      source: expect.objectContaining({ mediaType: 'text/markdown' }),
    });
    const text = new TextDecoder().decode(call.bytes);
    expect(text).not.toContain('info@pumpen-handel.example');
    expect(result.durableReceipt?.artifactId).toBe(ARTIFACT_ID);
    expect(result.costCents).toBe(1);
    expect(result.data).toEqual(await replayedData('crawl4ai-fetch/v1', call));
  });

  it('falls back to the site origin when the page path cannot be persisted as a sanitized fact', async () => {
    const { execution, persisted } = harness();
    const result = await execution.persist({
      reservation: reservation(),
      tool: toolFor('crawl4ai-fetch/v1'),
      input: { url: 'https://www.pumpen-handel.example/Impressum?lang=de' },
      result: {
        data: { url: 'https://www.pumpen-handel.example/Impressum?lang=de', text: 'Impressum', contentHash: 'x' },
        costCents: 1,
      },
      subjectRef,
    });
    expect((result.data as { url: string }).url).toBe('https://www.pumpen-handel.example/');
    expect(result.data).toEqual(await replayedData('crawl4ai-fetch/v1', persisted[0]!));
  });

  it('round-trips rendered HTML and a robots-blocked render', async () => {
    const { execution, persisted } = harness();
    const tool = toolFor('crawl4ai-render/v1', 'crawl4ai.render');
    const rendered = await execution.persist({
      reservation: reservation(), tool, subjectRef,
      input: { url: 'https://pumpen.example/' },
      result: { data: { url: 'https://pumpen.example/', html: '<html><body>Pumpen</body></html>', headers: { server: 'x' } }, costCents: 1 },
    });
    expect(rendered.data).toEqual(await replayedData('crawl4ai-render/v1', persisted[0]!));
    const blocked = await execution.persist({
      reservation: reservation(), tool, subjectRef,
      input: { url: 'https://pumpen.example/' },
      result: { data: { url: 'https://pumpen.example/', html: '', headers: {}, robotsBlocked: true }, costCents: 0 },
    });
    expect(blocked.data).toEqual({ url: 'https://pumpen.example/', html: '', robotsBlocked: true });
    expect(blocked.data).toEqual(await replayedData('crawl4ai-render/v1', persisted[1]!));
  });

  it('round-trips an http.get response', async () => {
    const { execution, persisted } = harness();
    const result = await execution.persist({
      reservation: reservation(), tool: toolFor('http-get/v1', 'http.get'), subjectRef,
      input: { url: 'https://pumpen.example/karriere' },
      result: {
        data: { status: 200, ok: true, mediaType: 'text/plain', text: 'Stellen', finalUrl: 'https://pumpen.example/karriere' },
        costCents: 0,
      },
    });
    expect(result.data).toEqual(await replayedData('http-get/v1', persisted[0]!));
  });

  it('refuses to persist without the reservation authority or an unsupported schema', async () => {
    const { execution, service } = harness();
    await expect(execution.persist({
      reservation: reservation({ authorityId: undefined }), tool: toolFor('crawl4ai-fetch/v1'), subjectRef,
      input: { url: 'https://pumpen.example/' },
      result: { data: { url: 'https://pumpen.example/', text: 'x', contentHash: 'x' }, costCents: 1 },
    })).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    await expect(execution.persist({
      reservation: reservation(), tool: { id: 'sanctions.download', durableResultStrategy: { kind: 'artifact_reference', schema: 'sanctions-download/v1' } } as never,
      subjectRef, input: {}, result: { data: {}, costCents: 0 },
    })).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(service.persist).not.toHaveBeenCalled();
  });
});

describe('GenericOperationArtifactExecution.replay', () => {
  it('materializes the settled artifact reference from verified storage bytes', async () => {
    const { execution, service, persisted } = harness();
    await execution.persist({
      reservation: reservation(), tool: toolFor('crawl4ai-fetch/v1'), subjectRef,
      input: { url: 'https://pumpen.example/' },
      result: { data: { url: 'https://pumpen.example/', text: 'Pumpen Vertrieb', contentHash: 'x' }, costCents: 1 },
    });
    const stored = persisted[0]!;
    const manifest = manifestFor('crawl4ai-fetch/v1', 'text/markdown', stored.bytes);
    service.readVerified.mockResolvedValue({
      manifest,
      expectedFacts: stored.expectedFacts,
      body: (async function* () { yield stored.bytes; })(),
    });
    const reference = {
      schemaVersion: 'generic-operation-artifact-ref/v1', artifactId: ARTIFACT_ID, operationId: OPERATION_ID,
      resultSchema: 'crawl4ai-fetch/v1', sha256: manifest.sha256, sizeBytes: manifest.sizeBytes,
      mediaType: 'text/markdown', expiresAt: manifest.expiresAt,
    };
    const replay = await execution.replay({
      reservation: reservation({
        replay: true,
        replayResult: { resultStrategy: 'artifact_reference', reference } as never,
        receipt: receipt('crawl4ai-fetch/v1'),
      }),
      tool: toolFor('crawl4ai-fetch/v1'),
    });
    expect(service.readVerified).toHaveBeenCalledWith({
      scopeKind: 'workspace', workspaceId: WORKSPACE_ID, authorityId: AUTHORITY_ID, reference,
    });
    expect(replay).toEqual({
      data: { url: 'https://pumpen.example/', text: 'Pumpen Vertrieb', contentHash: expect.any(String) },
      costCents: 0,
      durableReceipt: receipt('crawl4ai-fetch/v1'),
    });
  });

  it('fails closed for a replay without an artifact reference', async () => {
    const { execution } = harness();
    await expect(execution.replay({
      reservation: reservation({ replay: true }), tool: toolFor('crawl4ai-fetch/v1'),
    })).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
