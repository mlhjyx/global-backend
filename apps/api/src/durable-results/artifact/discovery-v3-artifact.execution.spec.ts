import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../tools/tool-contract';
import { projectGenericOperationResult } from '../../tools/generic-operation-projection';
import { ArtifactSubjectBindingContract } from './artifact-subject-binding.contract';
import { productArtifactMaterializerRegistry } from './generic-operation-artifact.runtime';
import { S3GenericOperationArtifactStore } from './generic-operation-artifact.store';
import { ARTIFACT_ID, BUCKET, MemoryS3Client } from './generic-operation-artifact.store.spec-helper';
import {
  DiscoveryV3ArtifactExecution,
  type DiscoveryV3ArtifactExecutionDeps,
} from './discovery-v3-artifact.execution';

const workspaceId = '44444444-4444-4444-8444-444444444444';
const identity = {
  workspaceId,
  operationId: '33333333-3333-4333-8333-333333333333',
  requestSha256: 'a'.repeat(64),
};
const subjectRef = { subjectType: 'company' as const, subjectId: '55555555-5555-4555-8555-555555555555' };
const now = new Date('2026-11-27T08:00:00.000Z');
const tool = {
  id: 'crawl4ai.fetch',
  durableResultStrategy: {
    kind: 'artifact_reference', schema: 'crawl4ai-fetch/v1', maxBytes: 300_000,
    mediaTypes: ['text/markdown'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
  },
} as unknown as Tool;
const source = { url: 'https://example.test/about?private=opaque' };
const input = {
  identity, tool, input: source, subjectRef,
  result: { data: { ...source, text: 'Synthetic page text.' }, costCents: 2 },
};

function fixture(at = now) {
  const s3 = new MemoryS3Client();
  s3.now = at;
  let clock = at;
  let subjectHold: 'TOMBSTONED' | null = null;
  let tombstoneAfterIntent = false;
  type AppendInput = Parameters<DiscoveryV3ArtifactExecutionDeps['repository']['append']>[1];
  let stored: AppendInput | undefined;
  const binding = new ArtifactSubjectBindingContract({
    async resolveExistingSubject(_tx, { workspaceId, subjectRef }) {
      return { workspaceId, ...subjectRef };
    },
    async findExecutionHold() { return subjectHold; },
  });
  const tx = {} as Prisma.TransactionClient;
  const artifacts = new DiscoveryV3ArtifactExecution({
    withWorkspace: (_workspaceId, invoke) => invoke(tx),
    binding,
    storage: new S3GenericOperationArtifactStore({ bucket: BUCKET, client: s3 }),
    materializers: productArtifactMaterializerRegistry(),
    repository: {
      async registerPromotion() {
        if (tombstoneAfterIntent) subjectHold = 'TOMBSTONED';
      },
      async authorizePromotion() {
        if (subjectHold) throw new Error('GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID');
      },
      async confirmPromotion() {},
      async lockForWrite() { return stored !== undefined; },
      async append(_tx, value) { stored = value; },
      async findExact(_tx, value) {
        return stored &&
          stored.identity.workspaceId === value.identity.workspaceId &&
          stored.identity.requestSha256 === value.identity.requestSha256 &&
          stored.subjectRef.subjectId === value.subjectRef.subjectId
          ? stored : null;
      },
    },
    now: () => clock,
    createArtifactId: () => ARTIFACT_ID,
  });
  return {
    s3, tx, artifacts,
    saved: () => stored,
    setClock: (value: Date) => { clock = value; },
    tombstone: () => { subjectHold = 'TOMBSTONED'; },
    tombstoneAfterIntent: () => { tombstoneAfterIntent = true; },
  };
}

describe('Discovery v3 Artifact execution', () => {
  it('keeps fetched text outside the result ledger and replays verified capture metadata', async () => {
    const { artifacts, s3, tx, saved } = fixture();
    const prepared = await artifacts.prepare(input);
    expect(saved()).toBeUndefined();
    expect(prepared.projection).toMatchObject({
      kind: 'tool', schema: 'discovery-v3-artifact-reference/v1',
      data: {
        schemaVersion: 'generic-operation-artifact-ref/v1', operationId: identity.operationId,
        resultSchema: 'crawl4ai-fetch/v1', mediaType: 'text/markdown',
        sizeBytes: '20', expiresAt: '2026-11-28T08:00:00.000Z',
      },
    });
    expect(JSON.stringify(prepared.projection)).not.toMatch(/Synthetic|example\.test|private|expectedFacts|subjectId|objectKey/);
    await prepared.commit(tx);
    await prepared.commit(tx);
    await prepared.cleanup();
    const replayInput = { identity, tool, subjectRef, projection: prepared.projection, resultSha256: prepared.projection.digest };
    const first = await prepared.readResult();
    const replay = await artifacts.replay(replayInput);
    expect(first).toMatchObject({
      costCents: 2,
      data: { url: 'https://example.test/about', text: 'Synthetic page text.' },
      provenance: { sourceUrl: 'https://example.test/about', fetchedAt: now.toISOString(), parserVersion: 'artifact/crawl4ai-fetch/v1' },
    });
    expect(replay).toEqual({ ...first, costCents: 0 });
    expect(saved()).toMatchObject({ subjectRef, expectedFacts: { sanitizedUrl: 'https://example.test/about' } });
    expect([...s3.objects.keys()]).toEqual([expect.stringContaining(`/final/personal-data/ws/${workspaceId}/sha256/`)]);
  });

  it('checks the receipt, subject, request, expiry and bytes before replaying', async () => {
    const { artifacts, s3, tx, setClock, tombstone } = fixture();
    const prepared = await artifacts.prepare(input);
    await prepared.commit(tx);
    await prepared.cleanup();
    const replay = { identity, tool, subjectRef, projection: prepared.projection, resultSha256: prepared.projection.digest };
    const invalid = { code: 'GENERIC_OPERATION_ARTIFACT_INVALID' };
    await expect(artifacts.replay({ ...replay, resultSha256: '0'.repeat(64) })).rejects.toMatchObject(invalid);
    await expect(artifacts.replay({ ...replay, identity: { ...identity, requestSha256: 'b'.repeat(64) } })).rejects.toMatchObject(invalid);
    await expect(artifacts.replay({ ...replay, subjectRef: { ...subjectRef, subjectId: identity.operationId } })).rejects.toMatchObject(invalid);
    const contaminated = projectGenericOperationResult({
      kind: 'tool', schema: prepared.projection.schema,
      data: { ...prepared.projection.data as object, text: 'ledger contamination' },
    });
    await expect(artifacts.replay({ ...replay, projection: contaminated, resultSha256: contaminated.digest })).rejects.toMatchObject(invalid);
    await expect(artifacts.replay({
      ...replay,
      projection: { ...prepared.projection, data: { ...prepared.projection.data as object, text: undefined } },
    })).rejects.toMatchObject(invalid);
    s3.finalReadbackChunks = [Buffer.from('altered artifact text')];
    await expect(artifacts.replay(replay)).rejects.toMatchObject(invalid);
    s3.finalReadbackChunks = null;
    setClock(new Date('2026-11-28T08:00:00.000Z'));
    const before = s3.commands.length;
    await expect(artifacts.replay(replay)).rejects.toMatchObject(invalid);
    setClock(now);
    tombstone();
    await expect(artifacts.replay(replay)).rejects.toMatchObject(invalid);
    expect(s3.commands).toHaveLength(before);
  });

  it('does not promote staged bytes after a subject is tombstoned', async () => {
    const { artifacts, s3, tombstoneAfterIntent, saved } = fixture();
    tombstoneAfterIntent();
    await expect(artifacts.prepare(input)).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID');
    expect(saved()).toBeUndefined();
    expect(s3.objects.size).toBe(0);
  });

  it('does not append a receipt after the confirmed version becomes eligible for DSR', async () => {
    const { artifacts, s3, tx, tombstone, saved } = fixture();
    const prepared = await artifacts.prepare(input);
    tombstone();
    const commands = s3.commands.length;
    await expect(prepared.commit(tx)).rejects.toMatchObject({ code: 'GENERIC_OPERATION_ARTIFACT_INVALID' });
    expect(s3.commands).toHaveLength(commands);
    await prepared.cleanup();
    expect(saved()).toBeUndefined();
    expect(s3.objects.size).toBe(1);
  });

  it('preserves the robots block fact on the empty render artifact', async () => {
    const { artifacts, tx, saved } = fixture();
    const render = {
      id: 'crawl4ai.render',
      durableResultStrategy: {
        kind: 'artifact_reference', schema: 'crawl4ai-render/v1', maxBytes: 3_000_000,
        mediaTypes: ['text/html'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
      },
    } as unknown as Tool;
    const prepared = await artifacts.prepare({
      ...input, tool: render, result: { data: { ...source, html: '', robotsBlocked: true }, costCents: 0 },
    });
    await prepared.commit(tx);
    await prepared.cleanup();
    expect(saved()).toMatchObject({
      subjectRef, expectedFacts: { sanitizedUrl: 'https://example.test/about', blocked: true },
      manifest: { sizeBytes: '0', mediaType: 'text/html' },
    });
    await expect(prepared.readResult()).resolves.toMatchObject({
      data: { url: 'https://example.test/about', html: '', robotsBlocked: true },
    });
  });

  it.each(['hunter', 'prospeo'])('binds %s finder ciphertext to the contact and keeps the address out of the result projection', async (provider) => {
    const { artifacts, tx, saved, s3 } = fixture(new Date());
    const finder = {
      id: `contact_email.find.${provider}`,
      durableResultStrategy: {
        kind: 'artifact_reference', schema: `contact-email-find-${provider}/v1`, maxBytes: 16_384,
        mediaTypes: ['application/octet-stream'], privacyClass: 'PERSONAL_DATA', ttlSeconds: 86_400,
      },
    } as unknown as Tool;
    const data = {
      status: 'hit', email: 'synthetic@example.invalid', providerConfidence: 98, acceptAll: false,
      pattern: null, reason: 'candidate_found',
    };
    const request = { ...input, tool: finder, result: { data, costCents: 0.8, costMicrousd: '8000' } };
    await expect(artifacts.prepare(request)).rejects.toMatchObject({ code: 'GENERIC_OPERATION_ARTIFACT_INVALID' });
    expect(s3.objects.size).toBe(0);

    const contactRef = { subjectType: 'contact' as const, subjectId: subjectRef.subjectId };
    const prepared = await artifacts.prepare({ ...request, subjectRef: contactRef });
    await prepared.commit(tx);
    await prepared.cleanup();
    expect(saved()).toMatchObject({ subjectRef: contactRef, expectedFacts: undefined });
    expect(JSON.stringify(prepared.projection)).not.toMatch(/synthetic|providerConfidence|subjectId/);
    const [stored] = [...s3.objects.values()];
    expect(Buffer.concat(stored.chunks).toString('utf8')).not.toContain(data.email);
    await expect(prepared.readResult()).resolves.toEqual({ data, costCents: 0.8, costMicrousd: '8000' });
  });
});
