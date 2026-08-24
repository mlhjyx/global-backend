import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BudgetReservation, BudgetStore } from '../../tools/budget-store';
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GenericOperationArtifactError,
  type ArtifactSource,
  type GenericOperationArtifactManifest,
} from './artifact.types';
import type { GenericOperationArtifactRepository } from './generic-operation-artifact.repository';
import {
  ArtifactStorageError,
  type GenericOperationArtifactStore,
  type StagedArtifact,
  type StoredArtifact,
} from './generic-operation-artifact.store';
import {
  ARTIFACT_STAGING_CLEANUP_FAILED,
  GenericOperationArtifactService,
} from './generic-operation-artifact.service';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const OPERATION_ID = '89528818-13ab-4a46-9dfd-6fbcdba6943e';
const ARTIFACT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';
const CREATED_AT = '2026-08-21T12:00:00.000Z';
const EXPIRES_AT = '2026-08-22T12:00:00.000Z';
const BODY = new TextEncoder().encode('verified artifact bytes');
const SHA256 = createHash('sha256').update(BODY).digest('hex');
const OBJECT_KEY = `generic-operation-results/v1/sha256/${SHA256.slice(0, 2)}/${SHA256}`;

const reservation: BudgetReservation = Object.freeze({
  workspaceId: WORKSPACE_ID,
  accountKey: 'artifact-account',
  operationId: OPERATION_ID,
  estimatedCents: 17,
  replay: false,
});
const recoveryReservation: BudgetReservation = Object.freeze({
  ...reservation,
  replay: true,
});

const staged: StagedArtifact = Object.freeze({
  artifactId: ARTIFACT_ID,
  stagingKey: `generic-operation-results/v1/staging/${ARTIFACT_ID}`,
  sha256: SHA256,
  sizeBytes: String(BODY.byteLength),
  mediaType: 'text/plain',
  sourceDigest: null,
  resultSchema: 'http-get/v1',
  privacyClass: 'CONFIDENTIAL_TENANT',
});

const stored: StoredArtifact = Object.freeze({
  objectKey: OBJECT_KEY,
  sha256: SHA256,
  sizeBytes: String(BODY.byteLength),
  mediaType: 'text/plain',
  resultSchema: 'http-get/v1',
  privacyClass: 'CONFIDENTIAL_TENANT',
});

const manifest: GenericOperationArtifactManifest = Object.freeze({
  schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  artifactId: ARTIFACT_ID,
  scopeKind: 'workspace',
  workspaceId: WORKSPACE_ID,
  authorityId: AUTHORITY_ID,
  operationId: OPERATION_ID,
  resultSchema: 'http-get/v1',
  objectKey: OBJECT_KEY,
  sha256: SHA256,
  sizeBytes: String(BODY.byteLength),
  mediaType: 'text/plain',
  privacyClass: 'CONFIDENTIAL_TENANT',
  sourceDigest: null,
  createdAt: CREATED_AT,
  expiresAt: EXPIRES_AT,
});
const expectedFacts = Object.freeze({
  status: 200,
  ok: true,
  sanitizedUrl: 'https://example.com/final',
  blocked: null,
});
const snapshot = Object.freeze({ manifest, expectedFacts });

async function* bytes(value = BODY): AsyncIterable<Uint8Array> {
  yield value;
}

function source(onRead?: () => void): ArtifactSource {
  return Object.freeze({
    mediaType: 'text/plain',
    body: (async function* () {
      onRead?.();
      yield BODY;
    })(),
  });
}

function dependencies(overrides: {
  stage?: GenericOperationArtifactStore['stage'];
  promote?: GenericOperationArtifactStore['promote'];
  inspect?: GenericOperationArtifactStore['inspect'];
  read?: GenericOperationArtifactStore['read'];
  deleteStaging?: GenericOperationArtifactStore['deleteStaging'];
  findExact?: GenericOperationArtifactRepository['findExact'];
  findByOperation?: GenericOperationArtifactRepository['findByOperation'];
  loadResultUnknownArtifact?: BudgetStore['loadResultUnknownArtifact'];
} = {}) {
  const order: string[] = [];
  const store = {
    stage: vi.fn(overrides.stage ?? (async (input) => {
      order.push('stage');
      for await (const _chunk of input.source.body) {
        // The fake consumes the producer once, matching the real streaming store.
      }
      return staged;
    })),
    promote: vi.fn(overrides.promote ?? (async () => {
      order.push('promote');
      return stored;
    })),
    inspect: vi.fn(overrides.inspect ?? (async () => {
      order.push('inspect');
      return stored;
    })),
    read: vi.fn(overrides.read ?? (async () => {
      order.push('read');
      return bytes();
    })),
    deleteStaging: vi.fn(overrides.deleteStaging ?? (async () => {
      order.push('cleanup');
    })),
    checkReadiness: vi.fn(),
  } satisfies GenericOperationArtifactStore;
  const repository = {
    findExact: vi.fn(overrides.findExact ?? (async () => snapshot)),
    findByOperation: vi.fn(overrides.findByOperation ?? (async () => snapshot)),
  } as unknown as GenericOperationArtifactRepository;
  const budgetStore = {
    markResultUnknown: vi.fn(async () => {
      order.push('unknown');
      return { reservedCents: reservation.estimatedCents, replay: false };
    }),
    loadResultUnknownArtifact: vi.fn(overrides.loadResultUnknownArtifact ?? (async () => {
      order.push('load-expected');
      return snapshot;
    })),
    settleArtifactManifest: vi.fn(async () => {
      order.push('atomic-settle');
      return {
        chargedCents: reservation.estimatedCents,
        observedCents: 13,
        capVariance: false,
        replay: false,
      };
    }),
  } as unknown as BudgetStore;
  const logger = { warn: vi.fn() };
  const service = new GenericOperationArtifactService(
    repository,
    store,
    budgetStore,
    {
      createArtifactId: () => ARTIFACT_ID,
      now: () => new Date(CREATED_AT),
      logger,
    },
  );
  return { service, store, repository, budgetStore, logger, order };
}

function persistInput() {
  return {
    reservation,
    authorityId: AUTHORITY_ID,
    source: source(),
    maxBytes: 1_000,
    resultSchema: 'http-get/v1',
    privacyClass: 'CONFIDENTIAL_TENANT' as const,
    expiresAt: EXPIRES_AT,
    actualCents: 13,
    expectedFacts,
  };
}

describe('GenericOperationArtifactService', () => {
  it('requires a bounded subject only for PERSONAL_DATA before reading the producer', async () => {
    let producerReads = 0;
    const deps = dependencies();
    const personal = {
      ...persistInput(),
      privacyClass: 'PERSONAL_DATA' as const,
      source: source(() => {
        producerReads += 1;
      }),
    };

    await expect(deps.service.persist(personal)).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });
    await expect(deps.service.persist({
      ...persistInput(),
      subjectRef: {
        subjectType: 'contact' as const,
        subjectId: 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72',
      },
    })).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });

    expect(producerReads).toBe(0);
    expect(deps.store.stage).not.toHaveBeenCalled();
  });

  it('settles PERSONAL_DATA with only the exact bounded subject reference', async () => {
    const personalStaged = Object.freeze({
      ...staged,
      privacyClass: 'PERSONAL_DATA' as const,
    });
    const personalStored = Object.freeze({
      ...stored,
      privacyClass: 'PERSONAL_DATA' as const,
    });
    const deps = dependencies({
      stage: async (input) => {
        for await (const _chunk of input.source.body) {
          // Consume the one bounded producer stream.
        }
        return personalStaged;
      },
      promote: async () => personalStored,
      inspect: async () => personalStored,
    });
    const subjectRef = Object.freeze({
      subjectType: 'contact' as const,
      subjectId: 'b8b3ee5c-fbb8-42ef-a382-9c10c16dca72',
    });

    await expect(deps.service.persist({
      ...persistInput(),
      privacyClass: 'PERSONAL_DATA',
      subjectRef,
    })).resolves.toMatchObject({ artifactId: ARTIFACT_ID });

    expect(deps.budgetStore.settleArtifactManifest).toHaveBeenCalledWith(
      reservation,
      13,
      expect.objectContaining({
        manifest: expect.objectContaining({ privacyClass: 'PERSONAL_DATA' }),
      }),
      subjectRef,
    );
  });

  it('persists in the exact ordered protocol and returns a closed reference', async () => {
    const deps = dependencies();

    await expect(deps.service.persist(persistInput())).resolves.toEqual({
      schemaVersion: 'generic-operation-artifact-ref/v1',
      artifactId: ARTIFACT_ID,
      operationId: OPERATION_ID,
      resultSchema: 'http-get/v1',
      sha256: SHA256,
      sizeBytes: String(BODY.byteLength),
      mediaType: 'text/plain',
      expiresAt: EXPIRES_AT,
    });
    expect(deps.order).toEqual([
      'stage',
      'promote',
      'inspect',
      'read',
      'atomic-settle',
      'cleanup',
    ]);
    expect(deps.budgetStore.markResultUnknown).not.toHaveBeenCalled();
  });

  it.each([
    'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN',
    'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN',
  ] as const)('marks %s RESULT_UNKNOWN without consuming the producer twice', async (code) => {
    let producerReads = 0;
    const deps = dependencies({
      stage: async (input) => {
        deps.order.push('stage');
        for await (const _chunk of input.source.body) {
          // Consume the one physical producer result before losing the ACK.
        }
        if (code === 'GENERIC_OPERATION_ARTIFACT_STAGE_ACK_UNKNOWN') {
          throw new ArtifactStorageError(code);
        }
        return staged;
      },
      promote: async () => {
        deps.order.push('promote');
        throw new ArtifactStorageError(code);
      },
    });

    await expect(deps.service.persist({
      ...persistInput(),
      source: source(() => {
        producerReads += 1;
      }),
    })).rejects.toMatchObject({ code });

    expect(producerReads).toBe(1);
    expect(deps.budgetStore.markResultUnknown).toHaveBeenCalledOnce();
    expect(deps.budgetStore.settleArtifactManifest).not.toHaveBeenCalled();
    expect(deps.store.stage).toHaveBeenCalledOnce();
    expect(deps.store.promote).toHaveBeenCalledTimes(
      code === 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN' ? 1 : 0,
    );
    expect(deps.budgetStore.markResultUnknown).toHaveBeenCalledWith(
      reservation,
      code === 'GENERIC_OPERATION_ARTIFACT_PROMOTE_ACK_UNKNOWN'
        ? snapshot
        : undefined,
    );
  });

  it('does not mark a pre-ack storage denial RESULT_UNKNOWN', async () => {
    const failure = new ArtifactStorageError(
      'GENERIC_OPERATION_ARTIFACT_SIZE_LIMIT_EXCEEDED',
    );
    const deps = dependencies({
      stage: async () => {
        throw failure;
      },
    });

    await expect(deps.service.persist(persistInput())).rejects.toBe(failure);
    expect(deps.budgetStore.markResultUnknown).not.toHaveBeenCalled();
    expect(deps.store.promote).not.toHaveBeenCalled();
  });

  it('rejects replay reservations before reading a producer or touching storage', async () => {
    let producerReads = 0;
    const deps = dependencies();

    await expect(deps.service.persist({
      ...persistInput(),
      reservation: { ...reservation, replay: true },
      source: source(() => {
        producerReads += 1;
      }),
    })).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });
    expect(producerReads).toBe(0);
    expect(deps.store.stage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['cross-schema', {
      sanitizedUrl: 'https://example.com/',
      contentHash: 'a'.repeat(24),
    }],
    ['raw PII', {
      status: 200,
      ok: true,
      sanitizedUrl: 'https://example.com/person@example.com',
      blocked: null,
    }],
    ['numeric-only host', {
      status: 200,
      ok: true,
      sanitizedUrl: 'https://127.0.0.1/',
      blocked: null,
    }],
    ['digit-heavy path', {
      status: 200,
      ok: true,
      sanitizedUrl: 'https://example.com/2026/08/22/123',
      blocked: null,
    }],
  ])('rejects %s expected facts before consuming or staging a producer result', async (_name, invalidFacts) => {
    let producerReads = 0;
    const deps = dependencies();

    await expect(deps.service.persist({
      ...persistInput(),
      expectedFacts: invalidFacts,
      source: source(() => {
        producerReads += 1;
      }),
    })).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });

    expect(producerReads).toBe(0);
    expect(deps.store.stage).not.toHaveBeenCalled();
    expect(deps.store.promote).not.toHaveBeenCalled();
    expect(deps.budgetStore.markResultUnknown).not.toHaveBeenCalled();
    expect(deps.budgetStore.settleArtifactManifest).not.toHaveBeenCalled();
  });

  it('derives platform scope without accepting a workspace id', async () => {
    const deps = dependencies();
    const platformReservation = Object.freeze({
      ...reservation,
      workspaceId: 'platform',
    });

    await expect(deps.service.persist({
      ...persistInput(),
      reservation: platformReservation,
    })).resolves.toMatchObject({ artifactId: ARTIFACT_ID });
    expect(deps.budgetStore.settleArtifactManifest).toHaveBeenCalledWith(
      platformReservation,
      13,
      expect.objectContaining({
        manifest: expect.objectContaining({
          scopeKind: 'platform',
          workspaceId: null,
          authorityId: AUTHORITY_ID,
        }),
        expectedFacts,
      }),
    );
  });

  it('recovers only the database-bound immutable object and atomically appends and settles it', async () => {
    const deps = dependencies();

    await expect(deps.service.recoverUnknown({
      reservation: recoveryReservation,
      authorityId: AUTHORITY_ID,
      actualCents: 13,
    })).resolves.toMatchObject({
      artifactId: ARTIFACT_ID,
      operationId: OPERATION_ID,
      sha256: SHA256,
    });

    expect(deps.store.stage).not.toHaveBeenCalled();
    expect(deps.store.promote).not.toHaveBeenCalled();
    expect(deps.store.inspect).toHaveBeenCalledWith(SHA256, undefined);
    expect(deps.order).toEqual([
      'load-expected',
      'inspect',
      'read',
      'atomic-settle',
      'cleanup',
    ]);
  });

  it.each([
    { name: 'absent', inspected: null },
    {
      name: 'mismatched',
      inspected: { ...stored, sizeBytes: String(BODY.byteLength + 1) },
    },
  ])('fails recovery closed when the expected object is $name', async ({ inspected }) => {
    const deps = dependencies({ inspect: async () => inspected });

    await expect(deps.service.recoverUnknown({
      reservation: recoveryReservation,
      authorityId: AUTHORITY_ID,
      actualCents: 13,
    })).rejects.toEqual(
      new GenericOperationArtifactError('GENERIC_OPERATION_ARTIFACT_INVALID'),
    );
    expect(deps.store.stage).not.toHaveBeenCalled();
    expect(deps.store.promote).not.toHaveBeenCalled();
    expect(deps.budgetStore.settleArtifactManifest).not.toHaveBeenCalled();
  });

  it('ignores caller-supplied substitute facts and uses only the database-bound expectation', async () => {
    const deps = dependencies();
    const hostileRecoveryInput = {
      reservation: recoveryReservation,
      authorityId: AUTHORITY_ID,
      expected: {
        ...manifest,
        sha256: 'ff'.repeat(32),
        body: 'forbidden',
      },
      actualCents: 13,
    };

    await expect(
      deps.service.recoverUnknown(hostileRecoveryInput),
    ).resolves.toMatchObject({ sha256: SHA256 });
    expect(deps.store.inspect).toHaveBeenCalledWith(SHA256, undefined);
    expect(deps.store.inspect).not.toHaveBeenCalledWith('ff'.repeat(32), undefined);
  });

  it('keeps a stage ACK unknown without a known digest permanently unrecoverable', async () => {
    const deps = dependencies({
      loadResultUnknownArtifact: async () => null,
    });

    await expect(deps.service.recoverUnknown({
      reservation: recoveryReservation,
      authorityId: AUTHORITY_ID,
      actualCents: 13,
    })).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });
    expect(deps.store.inspect).not.toHaveBeenCalled();
    expect(deps.budgetStore.settleArtifactManifest).not.toHaveBeenCalled();
  });

  it('returns success and logs only a bounded code when staging cleanup fails', async () => {
    const deps = dependencies({
      deleteStaging: async () => {
        deps.order.push('cleanup');
        throw new Error('endpoint and credential detail must not escape');
      },
    });

    await expect(deps.service.persist(persistInput())).resolves.toMatchObject({
      artifactId: ARTIFACT_ID,
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      ARTIFACT_STAGING_CLEANUP_FAILED,
    );
    expect(deps.logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('credential'),
    );
  });

  it('returns a manifest-bound verified stream and rejects corrupt bytes while reading', async () => {
    const deps = dependencies({
      read: async () => bytes(new TextEncoder().encode('corrupt')),
    });
    const reference = {
      schemaVersion: 'generic-operation-artifact-ref/v1' as const,
      artifactId: ARTIFACT_ID,
      operationId: OPERATION_ID,
      resultSchema: 'http-get/v1',
      sha256: SHA256,
      sizeBytes: String(BODY.byteLength),
      mediaType: 'text/plain',
      expiresAt: EXPIRES_AT,
    };

    const verified = await deps.service.readVerified({
      scopeKind: 'workspace',
      workspaceId: WORKSPACE_ID,
      authorityId: AUTHORITY_ID,
      reference,
    });

    await expect((async () => {
      for await (const _chunk of verified.body) {
        // Drain to force digest and size verification.
      }
    })()).rejects.toEqual(
      new GenericOperationArtifactError('GENERIC_OPERATION_ARTIFACT_INVALID'),
    );
    expect(verified.manifest).toEqual(manifest);
    expect(verified.expectedFacts).toEqual(expectedFacts);
  });

  it('streams a verified read without buffering it in the service', async () => {
    const deps = dependencies();
    const reference = {
      schemaVersion: 'generic-operation-artifact-ref/v1' as const,
      artifactId: ARTIFACT_ID,
      operationId: OPERATION_ID,
      resultSchema: 'http-get/v1',
      sha256: SHA256,
      sizeBytes: String(BODY.byteLength),
      mediaType: 'text/plain',
      expiresAt: EXPIRES_AT,
    };
    const verified = await deps.service.readVerified({
      scopeKind: 'workspace',
      workspaceId: WORKSPACE_ID,
      authorityId: AUTHORITY_ID,
      reference,
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of verified.body) chunks.push(chunk);
    expect(chunks).toEqual([BODY]);
  });

  it.each([
    { name: 'absent manifest', findExact: async () => null, inspect: undefined },
    {
      name: 'expired manifest',
      findExact: async () => ({
        manifest: { ...manifest, expiresAt: CREATED_AT },
        expectedFacts,
      }),
      inspect: undefined,
    },
    {
      name: 'mismatched object',
      findExact: async () => snapshot,
      inspect: async () => ({ ...stored, mediaType: 'application/json' }),
    },
  ])('fails readVerified closed for $name', async ({ findExact, inspect }) => {
    const deps = dependencies({
      findExact: findExact as GenericOperationArtifactRepository['findExact'],
      ...(inspect
        ? { inspect: inspect as GenericOperationArtifactStore['inspect'] }
        : {}),
    });

    await expect(deps.service.readVerified({
      scopeKind: 'workspace',
      workspaceId: WORKSPACE_ID,
      authorityId: AUTHORITY_ID,
      reference: {
        schemaVersion: 'generic-operation-artifact-ref/v1',
        artifactId: ARTIFACT_ID,
        operationId: OPERATION_ID,
        resultSchema: 'http-get/v1',
        sha256: SHA256,
        sizeBytes: String(BODY.byteLength),
        mediaType: 'text/plain',
        expiresAt: EXPIRES_AT,
      },
    })).rejects.toMatchObject({
      code: 'GENERIC_OPERATION_ARTIFACT_INVALID',
    });
  });

  it('maps an unbounded read stream failure to the one artifact error', async () => {
    const failingBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('unbounded transport detail');
        },
      }),
    };
    const deps = dependencies({
      read: async () => failingBody,
    });

    await expect(deps.service.persist(persistInput())).rejects.toEqual(
      new GenericOperationArtifactError('GENERIC_OPERATION_ARTIFACT_INVALID'),
    );
    expect(deps.budgetStore.settleArtifactManifest).not.toHaveBeenCalled();
  });
});
