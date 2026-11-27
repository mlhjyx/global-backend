import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { ArtifactExecutionAdmission } from '../../tools/artifact-execution-port';
import {
  DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA,
  parseDiscoveryV3ArtifactProjection,
  type DiscoveryV3ArtifactExecutionPort,
  type DiscoveryV3ArtifactIdentity,
  type PrepareDiscoveryV3ArtifactInput,
  type PreparedDiscoveryV3Artifact,
  type ReplayDiscoveryV3ArtifactInput,
} from '../../tools/discovery-v3-artifact-execution-port';
import { projectGenericOperationResult } from '../../tools/generic-operation-projection';
import type { Tool, ToolResult } from '../../tools/tool-contract';
import { parseArtifactExpectedFactsForResultSchema } from './artifact-expected-facts';
import { contentAddressedObjectKey } from './artifact-key';
import {
  artifactProducerIdForResultSchema,
  type ArtifactMaterializerRegistry,
} from './artifact-materializer.registry';
import type { ArtifactSubjectBindingContract } from './artifact-subject-binding.contract';
import {
  DISCOVERY_V3_ARTIFACT_MANIFEST_SCHEMA,
  GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  invalidGenericOperationArtifact as invalid,
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
  missingGenericOperationArtifactObject,
} from './artifact.types';
import type { DiscoveryV3ArtifactRepository } from './discovery-v3-artifact.repository';
import { parseDiscoveryV3ArtifactManifest } from './generic-operation-artifact.repository';
import type { GenericOperationArtifactStore, StoredArtifact } from './generic-operation-artifact.store';
import {
  bytesOfArtifact,
  record,
  stringField,
  workspaceArtifactPayload,
  workspaceArtifactSchema,
} from './workspace-artifact-payload';

const STORAGE_IO_TIMEOUT_MS = 20_000;
const READ_TRANSACTION_TIMEOUT_MS = 30_000;
const PERSONAL_DATA = 'PERSONAL_DATA';
const MAX_PERSONAL_DATA_TTL_SECONDS = 86_400;
const logger = new Logger('DiscoveryV3ArtifactExecution');

export interface DiscoveryV3ArtifactExecutionDeps {
  readonly withWorkspace: <T>(
    workspaceId: string, invoke: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeout: number },
  ) => Promise<T>;
  readonly binding: Pick<ArtifactSubjectBindingContract, 'resolveForExecution'>;
  readonly storage: Pick<GenericOperationArtifactStore, 'stage' | 'promote' | 'inspect' | 'read' | 'deleteStaging'>;
  readonly materializers: Pick<ArtifactMaterializerRegistry, 'materialize'>;
  readonly repository: Pick<DiscoveryV3ArtifactRepository, 'registerPromotion' | 'authorizePromotion' |
    'confirmPromotion' | 'lockForWrite' | 'append' | 'findExact'>;
  readonly now?: () => Date;
  readonly createArtifactId?: () => string;
}

function artifactStrategy<I, O>(tool: Tool<I, O>) {
  const schema = workspaceArtifactSchema(tool as Tool);
  const strategy = tool.durableResultStrategy;
  if (strategy.kind !== 'artifact_reference' || strategy.privacyClass !== PERSONAL_DATA ||
      artifactProducerIdForResultSchema(schema) !== tool.id ||
      !Number.isSafeInteger(strategy.maxBytes) || strategy.maxBytes <= 0 ||
      !Number.isSafeInteger(strategy.ttlSeconds) || strategy.ttlSeconds <= 0 ||
      strategy.ttlSeconds > MAX_PERSONAL_DATA_TTL_SECONDS) return invalid();
  return { schema, strategy };
}

function assertIdentity(identity: DiscoveryV3ArtifactIdentity): void {
  if (!isCanonicalArtifactUuid(identity.workspaceId) ||
      !isCanonicalArtifactUuid(identity.operationId) ||
      !isCanonicalArtifactSha256(identity.requestSha256)) invalid();
}

function storageSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(STORAGE_IO_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function matchesStored(
  actual: StoredArtifact,
  expected: Readonly<{ objectKey: string; sha256: string; sizeBytes: string }>,
): boolean {
  return actual.objectKey === expected.objectKey && actual.sha256 === expected.sha256 &&
    actual.sizeBytes === expected.sizeBytes && actual.privacyClass === PERSONAL_DATA;
}

export class DiscoveryV3ArtifactExecution implements DiscoveryV3ArtifactExecutionPort {
  private readonly now: () => Date;
  private readonly createArtifactId: () => string;

  constructor(private readonly deps: DiscoveryV3ArtifactExecutionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.createArtifactId = deps.createArtifactId ?? randomUUID;
  }

  async admit(input: Parameters<DiscoveryV3ArtifactExecutionPort['admit']>[0]): Promise<ArtifactExecutionAdmission> {
    const decision = await this.deps.withWorkspace(input.workspaceId, (tx) =>
      this.deps.binding.resolveForExecution(tx, { ...input, scopeKind: 'workspace' }),
    );
    if (decision.status === 'BOUND') return { status: 'BOUND', subjectRef: decision.subjectRef };
    return {
      status: 'DENIED',
      reason: decision.status === 'SUBJECT_BINDING_HOLD' ? 'SUBJECT_BINDING_HOLD' : decision.reason,
    };
  }

  async prepare<I, O>(input: PrepareDiscoveryV3ArtifactInput<I, O>): Promise<PreparedDiscoveryV3Artifact<O>> {
    const identity = Object.freeze({ ...input.identity });
    assertIdentity(identity);
    const { schema, strategy } = artifactStrategy(input.tool);
    const scope = { scopeKind: 'workspace', workspaceId: identity.workspaceId } as const;
    const admitted = await this.admit({ workspaceId: identity.workspaceId, resultSchema: schema, subjectRef: input.subjectRef });
    if (admitted.status !== 'BOUND') return invalid();
    const subjectRef = admitted.subjectRef;
    const payload = workspaceArtifactPayload(schema, input.input, input.result.data, identity.workspaceId);
    const expectedFacts = parseArtifactExpectedFactsForResultSchema(schema, payload.expectedFacts);
    if (!strategy.mediaTypes.includes(payload.mediaType)) return invalid();
    const artifactId = this.createArtifactId();
    const capturedAt = this.now();
    const expiresAt = new Date(capturedAt.getTime() + strategy.ttlSeconds * 1_000).toISOString();
    const cleanup = async () => {
      try {
        await this.deps.storage.deleteStaging(artifactId);
      } catch {
        logger.warn('GENERIC_OPERATION_ARTIFACT_STAGING_CLEANUP_FAILED');
      }
    };
    try {
      const staged = await this.deps.storage.stage({
        artifactId, resultSchema: schema, privacyClass: PERSONAL_DATA, maxBytes: strategy.maxBytes,
        source: { body: bytesOfArtifact(payload.body), mediaType: payload.mediaType },
        signal: storageSignal(input.signal),
      });
      if (staged.artifactId !== artifactId || staged.resultSchema !== schema ||
          staged.privacyClass !== PERSONAL_DATA || staged.mediaType !== payload.mediaType ||
          staged.sourceDigest !== null) return invalid();
      const manifest = parseDiscoveryV3ArtifactManifest({
        schemaVersion: DISCOVERY_V3_ARTIFACT_MANIFEST_SCHEMA,
        ...scope, artifactId, operationId: identity.operationId, resultSchema: schema,
        objectKey: contentAddressedObjectKey(staged.sha256, PERSONAL_DATA, scope),
        sha256: staged.sha256, sizeBytes: staged.sizeBytes, mediaType: staged.mediaType,
        privacyClass: PERSONAL_DATA, sourceDigest: null, createdAt: capturedAt.toISOString(), expiresAt,
      });
      await this.deps.materializers.materialize(schema, bytesOfArtifact(payload.body), manifest, expectedFacts);
      const projection = projectGenericOperationResult({
        kind: 'tool', schema: DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA,
        data: {
          schemaVersion: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
          artifactId, operationId: identity.operationId, resultSchema: schema,
          sha256: manifest.sha256, sizeBytes: manifest.sizeBytes, mediaType: manifest.mediaType, expiresAt,
        },
      });
      const binding = { identity, subjectRef, projection, resultSha256: projection.digest };
      // Commit the intent before storage can write the final key. Then record the
      // acknowledged version under the same subject and object locks before
      // returning a closure that atomically settles the operation and manifest.
      await this.deps.withWorkspace(identity.workspaceId, (tx) => this.deps.repository.registerPromotion(tx, binding));
      const versionId = await this.deps.withWorkspace(identity.workspaceId, async (tx) => {
        input.signal?.throwIfAborted();
        await this.deps.repository.authorizePromotion(tx, binding);
        const stored = await this.deps.storage.promote(staged, {
          scope, retainUntil: expiresAt, requireAcknowledgedWrite: true, signal: storageSignal(input.signal),
        });
        if (!matchesStored(stored, manifest)) return invalid();
        await this.deps.repository.confirmPromotion(tx, binding, stored.versionId);
        return stored.versionId;
      }, { timeout: READ_TRANSACTION_TIMEOUT_MS });
      const { costCents, costMicrousd, providerCharge } = input.result;
      return {
        projection,
        commit: async (tx) => {
          input.signal?.throwIfAborted();
          const decision = await this.deps.binding.resolveForExecution(tx, { ...scope, resultSchema: schema, subjectRef });
          if (decision.status !== 'BOUND') return invalid();
          if (await this.deps.repository.lockForWrite(tx, binding)) return;
          await this.deps.repository.append(tx, { ...binding, manifest, expectedFacts, versionId });
        },
        readResult: async () => {
          const result = await this.replay({ ...binding, tool: input.tool, signal: input.signal });
          return {
            ...result, costCents,
            ...(costMicrousd === undefined ? {} : { costMicrousd }),
            ...(providerCharge ? { providerCharge } : {}),
          };
        },
        cleanup,
      };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async replay<I, O>(input: ReplayDiscoveryV3ArtifactInput<I, O>): Promise<ToolResult<O>> {
    const { identity, subjectRef } = input;
    assertIdentity(identity);
    const { schema, strategy } = artifactStrategy(input.tool);
    const reference = parseDiscoveryV3ArtifactProjection(input.projection, {
      operationId: identity.operationId, resultSchema: schema, resultSha256: input.resultSha256,
    });
    if (Date.parse(reference.expiresAt) <= this.now().getTime() ||
        BigInt(reference.sizeBytes) > BigInt(strategy.maxBytes) ||
        !strategy.mediaTypes.includes(reference.mediaType)) return invalid();
    const scope = { scopeKind: 'workspace', workspaceId: identity.workspaceId } as const;
    return this.deps.withWorkspace(identity.workspaceId, async (tx) => {
      const admitted = await this.deps.binding.resolveForExecution(tx, { ...scope, resultSchema: schema, subjectRef });
      if (admitted.status !== 'BOUND') return invalid();
      const snapshot = await this.deps.repository.findExact(tx, { ...input, subjectRef: admitted.subjectRef });
      if (!snapshot) return invalid();
      const manifest = parseDiscoveryV3ArtifactManifest(snapshot.manifest);
      if (manifest.workspaceId !== identity.workspaceId || manifest.operationId !== reference.operationId ||
          manifest.artifactId !== reference.artifactId || manifest.resultSchema !== reference.resultSchema ||
          manifest.sha256 !== reference.sha256 || manifest.sizeBytes !== reference.sizeBytes ||
          manifest.mediaType !== reference.mediaType || manifest.expiresAt !== reference.expiresAt ||
          Date.parse(manifest.expiresAt) <= this.now().getTime()) return invalid();
      const options = { scope, objectKey: manifest.objectKey };
      const signal = storageSignal(input.signal);
      const stored = await this.deps.storage.inspect(reference.sha256, PERSONAL_DATA, signal, options);
      if (!stored) return missingGenericOperationArtifactObject();
      if (!matchesStored(stored, manifest)) return invalid();
      const body = await this.deps.storage.read(reference.sha256, PERSONAL_DATA, signal, options);
      const data = await this.deps.materializers.materialize<O>(schema, body, manifest, snapshot.expectedFacts);
      signal.throwIfAborted();
      if (Date.parse(manifest.expiresAt) <= this.now().getTime()) return invalid();
      const page = schema === 'crawl4ai-fetch/v1' ? record(data) : undefined;
      return {
        data, costCents: 0,
        ...(page ? { provenance: {
          sourceUrl: stringField(page.url), fetchedAt: manifest.createdAt, artifactExpiresAt: manifest.expiresAt,
          contentHash: stringField(page.contentHash), parserVersion: 'artifact/crawl4ai-fetch/v1',
        } } : {}),
      };
    }, { timeout: READ_TRANSACTION_TIMEOUT_MS });
  }
}
