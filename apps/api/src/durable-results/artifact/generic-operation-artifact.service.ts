import { createHash, randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import { Logger } from '@nestjs/common';
import type {
  BudgetReservation,
  BudgetStore,
} from '../../tools/budget-store';
import { artifactExecutionReceiptFacts } from '../execution-receipt-facts';
import { contentAddressedObjectKey } from './artifact-key';
import {
  parseArtifactExpectedFactsForResultSchema,
  type ArtifactExpectedFacts,
  type GenericOperationArtifactSnapshot,
} from './artifact-expected-facts';
import { parseArtifactReference } from './artifact-reference.schema';
import type {
  GenericOperationArtifactBinding,
  GenericOperationArtifactRepository,
} from './generic-operation-artifact.repository';
import {
  ArtifactStorageError,
  type GenericOperationArtifactStore,
  type StoredArtifact,
} from './generic-operation-artifact.store';
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  GenericOperationArtifactError,
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
  type ArtifactPrivacyClass,
  type ArtifactScopeKind,
  type ArtifactSource,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from './artifact.types';

export const ARTIFACT_STAGING_CLEANUP_FAILED =
  'GENERIC_OPERATION_ARTIFACT_STAGING_CLEANUP_FAILED' as const;

const MANIFEST_KEYS = new Set([
  'schemaVersion',
  'artifactId',
  'scopeKind',
  'workspaceId',
  'authorityId',
  'operationId',
  'resultSchema',
  'objectKey',
  'sha256',
  'sizeBytes',
  'mediaType',
  'privacyClass',
  'sourceDigest',
  'createdAt',
  'expiresAt',
]);
const PRIVACY_CLASSES = new Set<ArtifactPrivacyClass>([
  'PUBLIC_ORGANIZATION',
  'CONFIDENTIAL_TENANT',
  'PERSONAL_DATA',
]);
const DEFAULT_LOGGER = new Logger('GenericOperationArtifactService');

export interface GenericOperationArtifactServiceLogger {
  warn(code: typeof ARTIFACT_STAGING_CLEANUP_FAILED): void;
}

export interface GenericOperationArtifactServiceOptions {
  readonly createArtifactId?: () => string;
  readonly now?: () => Date;
  readonly logger?: GenericOperationArtifactServiceLogger;
}

export interface PersistGenericOperationArtifactInput {
  readonly reservation: BudgetReservation;
  readonly authorityId: string;
  readonly source: ArtifactSource;
  readonly maxBytes: number;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
  readonly expiresAt: string;
  readonly actualCents: number;
  /** Small closed facts captured from the same physical operation result. */
  readonly expectedFacts?: unknown;
  readonly signal?: AbortSignal;
}

export interface RecoverUnknownGenericOperationArtifactInput {
  readonly reservation: BudgetReservation;
  readonly authorityId: string;
  readonly actualCents: number;
  readonly signal?: AbortSignal;
}

export interface ReadVerifiedGenericOperationArtifactInput {
  readonly scopeKind: ArtifactScopeKind;
  readonly workspaceId: string | null;
  readonly authorityId: string;
  readonly reference: GenericOperationArtifactReference;
  readonly signal?: AbortSignal;
}

export interface VerifiedGenericOperationArtifact {
  readonly manifest: GenericOperationArtifactManifest;
  readonly expectedFacts: ArtifactExpectedFacts | undefined;
  readonly body: AsyncIterable<Uint8Array>;
}

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? value
    : null;
}

function assertReservationBinding(
  reservation: BudgetReservation,
  authorityId: string,
  allowReplay = false,
): GenericOperationArtifactBinding {
  if (
    (!allowReplay && reservation.replay) ||
    !isCanonicalArtifactUuid(reservation.operationId) ||
    !isCanonicalArtifactUuid(authorityId)
  ) {
    return invalid();
  }
  if (reservation.workspaceId === 'platform') {
    return Object.freeze({
      scopeKind: 'platform',
      workspaceId: null,
      authorityId,
      operationId: reservation.operationId,
      resultSchema: '',
    });
  }
  if (!isCanonicalArtifactUuid(reservation.workspaceId)) return invalid();
  return Object.freeze({
    scopeKind: 'workspace',
    workspaceId: reservation.workspaceId,
    authorityId,
    operationId: reservation.operationId,
    resultSchema: '',
  });
}

function sameStoredArtifact(
  actual: StoredArtifact | null,
  expected: Pick<
    GenericOperationArtifactManifest,
    'objectKey' | 'sha256' | 'sizeBytes' | 'mediaType' | 'resultSchema' | 'privacyClass'
  >,
): actual is StoredArtifact {
  return Boolean(
    actual &&
      actual.objectKey === expected.objectKey &&
      actual.sha256 === expected.sha256 &&
      actual.sizeBytes === expected.sizeBytes &&
      actual.mediaType === expected.mediaType &&
      actual.resultSchema === expected.resultSchema &&
      actual.privacyClass === expected.privacyClass,
  );
}

function referenceFromManifest(
  manifest: GenericOperationArtifactManifest,
): GenericOperationArtifactReference {
  return parseArtifactReference({
    schemaVersion: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
    artifactId: manifest.artifactId,
    operationId: manifest.operationId,
    resultSchema: manifest.resultSchema,
    sha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    mediaType: manifest.mediaType,
    expiresAt: manifest.expiresAt,
  });
}

function snapshotExpectedManifest(
  value: GenericOperationArtifactManifest,
  reservation: BudgetReservation,
  authorityId: string,
  allowReplay = false,
): GenericOperationArtifactManifest {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== MANIFEST_KEYS.size ||
      ownKeys.some((key) => typeof key !== 'string' || !MANIFEST_KEYS.has(key)) ||
      ownKeys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })
    ) {
      return invalid();
    }

    const binding = assertReservationBinding(
      reservation,
      authorityId,
      allowReplay,
    );
    const reference = referenceFromManifest(value);
    const createdAt = canonicalTimestamp(value.createdAt);
    if (
      value.schemaVersion !== GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA ||
      value.scopeKind !== binding.scopeKind ||
      value.workspaceId !== binding.workspaceId ||
      value.authorityId !== authorityId ||
      value.operationId !== reservation.operationId ||
      value.objectKey !== contentAddressedObjectKey(reference.sha256) ||
      !PRIVACY_CLASSES.has(value.privacyClass) ||
      (value.sourceDigest !== null &&
        !isCanonicalArtifactSha256(value.sourceDigest)) ||
      createdAt === null ||
      Date.parse(reference.expiresAt) <= Date.parse(createdAt)
    ) {
      return invalid();
    }
    return Object.freeze({ ...value, createdAt });
  } catch (error) {
    if (error instanceof GenericOperationArtifactError) throw error;
    return invalid();
  }
}

function buildManifest(
  input: PersistGenericOperationArtifactInput,
  stored: StoredArtifact,
  artifactId: string,
  createdAt: string,
  sourceDigest: string | null,
): GenericOperationArtifactManifest {
  const binding = assertReservationBinding(input.reservation, input.authorityId);
  const expiresAt = canonicalTimestamp(input.expiresAt);
  if (!expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt)) {
    return invalid();
  }
  return snapshotExpectedManifest(
    {
      schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
      artifactId,
      scopeKind: binding.scopeKind,
      workspaceId: binding.workspaceId,
      authorityId: input.authorityId,
      operationId: input.reservation.operationId,
      resultSchema: stored.resultSchema,
      objectKey: stored.objectKey,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      mediaType: stored.mediaType,
      privacyClass: stored.privacyClass,
      sourceDigest,
      createdAt,
      expiresAt,
    },
    input.reservation,
    input.authorityId,
  );
}

function buildSnapshot(
  manifest: GenericOperationArtifactManifest,
  expectedFacts: unknown,
): GenericOperationArtifactSnapshot {
  return Object.freeze({
    manifest,
    expectedFacts: parseArtifactExpectedFactsForResultSchema(
      manifest.resultSchema,
      expectedFacts,
    ),
  });
}

export class GenericOperationArtifactService {
  private readonly createArtifactId: () => string;
  private readonly now: () => Date;
  private readonly logger: GenericOperationArtifactServiceLogger;

  constructor(
    private readonly repository: GenericOperationArtifactRepository,
    private readonly store: GenericOperationArtifactStore,
    private readonly budgetStore: BudgetStore,
    options: GenericOperationArtifactServiceOptions = {},
  ) {
    this.createArtifactId = options.createArtifactId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? {
      warn: (code) => DEFAULT_LOGGER.warn(code),
    };
  }

  async persist(
    input: PersistGenericOperationArtifactInput,
  ): Promise<GenericOperationArtifactReference> {
    assertReservationBinding(input.reservation, input.authorityId);
    const expectedFacts = parseArtifactExpectedFactsForResultSchema(
      input.resultSchema,
      input.expectedFacts,
    );
    const artifactId = this.createArtifactId();
    if (!isCanonicalArtifactUuid(artifactId)) return invalid();

    let staged;
    try {
      staged = await this.store.stage({
        artifactId,
        source: input.source,
        maxBytes: input.maxBytes,
        resultSchema: input.resultSchema,
        privacyClass: input.privacyClass,
        signal: input.signal,
      });
    } catch (error) {
      await this.markUnknownOnAmbiguousWrite(error, input.reservation);
      throw error;
    }
    if (
      staged.artifactId !== artifactId ||
      staged.resultSchema !== input.resultSchema ||
      staged.privacyClass !== input.privacyClass ||
      staged.mediaType !== input.source.mediaType ||
      staged.sourceDigest !== (input.source.sourceDigest ?? null)
    ) {
      return invalid();
    }

    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return invalid();
    const manifest = buildManifest(
      input,
      {
        objectKey: contentAddressedObjectKey(staged.sha256),
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        mediaType: staged.mediaType,
        resultSchema: staged.resultSchema,
        privacyClass: staged.privacyClass,
      },
      staged.artifactId,
      now.toISOString(),
      staged.sourceDigest,
    );
    const snapshot = buildSnapshot(manifest, expectedFacts);

    let promoted: StoredArtifact;
    try {
      promoted = await this.store.promote(staged);
    } catch (error) {
      await this.markUnknownOnAmbiguousWrite(
        error,
        input.reservation,
        snapshot,
      );
      throw error;
    }
    if (!sameStoredArtifact(promoted, {
      ...staged,
      objectKey: contentAddressedObjectKey(staged.sha256),
    })) {
      return invalid();
    }

    const inspected = await this.store.inspect(promoted.sha256, input.signal);
    if (!sameStoredArtifact(inspected, promoted)) return invalid();
    await this.drainVerifiedBody(promoted, input.signal);

    const reference = referenceFromManifest(manifest);
    await this.budgetStore.settleArtifactManifest(
      input.reservation,
      input.actualCents,
      snapshot,
      artifactExecutionReceiptFacts({
        resultSchema: manifest.resultSchema,
        reservedMicrousd: BigInt(input.reservation.estimatedCents) * 10_000n,
      }),
    );
    await this.cleanup(staged.artifactId);
    return reference;
  }

  async recoverUnknown(
    input: RecoverUnknownGenericOperationArtifactInput,
  ): Promise<GenericOperationArtifactReference> {
    assertReservationBinding(input.reservation, input.authorityId, true);
    const loaded = await this.budgetStore.loadResultUnknownArtifact(
      input.reservation,
      input.authorityId,
    );
    if (loaded === null) return invalid();
    const expected = snapshotExpectedManifest(
      loaded.manifest,
      input.reservation,
      input.authorityId,
      true,
    );
    const snapshot = buildSnapshot(expected, loaded.expectedFacts);
    const inspected = await this.store.inspect(expected.sha256, input.signal);
    if (!sameStoredArtifact(inspected, expected)) return invalid();
    await this.drainVerifiedBody(expected, input.signal);

    const reference = referenceFromManifest(expected);
    await this.budgetStore.settleArtifactManifest(
      input.reservation,
      input.actualCents,
      snapshot,
      artifactExecutionReceiptFacts({
        resultSchema: expected.resultSchema,
        reservedMicrousd: BigInt(input.reservation.estimatedCents) * 10_000n,
      }),
    );
    await this.cleanup(expected.artifactId);
    return reference;
  }

  async readVerified(
    input: ReadVerifiedGenericOperationArtifactInput,
  ): Promise<VerifiedGenericOperationArtifact> {
    const reference = parseArtifactReference(input.reference);
    if (!isCanonicalArtifactUuid(input.authorityId)) return invalid();
    const snapshot = await this.repository.findExact({
      scopeKind: input.scopeKind,
      workspaceId: input.workspaceId,
      authorityId: input.authorityId,
      reference,
    });
    if (
      !snapshot ||
      Date.parse(snapshot.manifest.expiresAt) <= this.now().getTime()
    ) {
      return invalid();
    }
    const inspected = await this.store.inspect(reference.sha256, input.signal);
    if (!sameStoredArtifact(inspected, snapshot.manifest)) return invalid();
    const body = await this.store.read(reference.sha256, input.signal);
    return Object.freeze({
      manifest: snapshot.manifest,
      expectedFacts: snapshot.expectedFacts,
      body: this.verifiedBody(body, snapshot.manifest, input.signal),
    });
  }

  private async markUnknownOnAmbiguousWrite(
    error: unknown,
    reservation: BudgetReservation,
    expected?: GenericOperationArtifactSnapshot,
  ): Promise<void> {
    if (
      error instanceof ArtifactStorageError &&
      (error.code === 'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN' ||
        error.code === 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN')
    ) {
      await this.budgetStore.markResultUnknown(reservation, expected);
    }
  }

  private async drainVerifiedBody(
    expected: Pick<GenericOperationArtifactManifest, 'sha256' | 'sizeBytes'>,
    signal?: AbortSignal,
  ): Promise<void> {
    const body = await this.store.read(expected.sha256, signal);
    for await (const _chunk of this.verifiedBody(body, expected, signal)) {
      // Drain before manifest append so only byte-verified objects become durable facts.
    }
  }

  private async *verifiedBody(
    body: AsyncIterable<Uint8Array>,
    expected: Pick<GenericOperationArtifactManifest, 'sha256' | 'sizeBytes'>,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const hash = createHash('sha256');
    let sizeBytes = 0n;
    try {
      for await (const chunk of body) {
        if (signal?.aborted || !(chunk instanceof Uint8Array)) return invalid();
        sizeBytes += BigInt(chunk.byteLength);
        if (sizeBytes > BigInt(expected.sizeBytes)) return invalid();
        hash.update(chunk);
        yield chunk;
      }
      if (
        sizeBytes.toString() !== expected.sizeBytes ||
        hash.digest('hex') !== expected.sha256
      ) {
        return invalid();
      }
    } catch (error) {
      if (
        error instanceof GenericOperationArtifactError ||
        error instanceof ArtifactStorageError
      ) {
        throw error;
      }
      return invalid();
    }
  }

  private async cleanup(artifactId: string): Promise<void> {
    try {
      await this.store.deleteStaging(artifactId);
    } catch {
      this.logger.warn(ARTIFACT_STAGING_CLEANUP_FAILED);
    }
  }
}
