import { Prisma, type PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetUnsettledOperationsError,
  PostgresBudgetStore,
  UnavailableBudgetStore,
} from './budget-store';
import { BudgetLedger, InMemoryBudgetStoreAdapter } from '@global/test-support';
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from '../durable-results/artifact/artifact.types';
import { projectGenericOperationResult } from './generic-operation-projection';

const SAFE_PLATFORM_PRINCIPAL = Object.freeze({
  sessionUser: 'global_platform_writer',
  currentUser: 'global_platform_writer',
  canLogin: true,
  superuser: false,
  bypassRls: false,
  createDb: false,
  createRole: false,
  replication: false,
  inherit: true,
  memberships: ['execution_budget_platform_writer'],
});
const TEST_WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const PROVIDER_REPORTED_FACTS = Object.freeze({
  usage: Object.freeze({
    currency: 'USD' as const,
    unit: 'microusd' as const,
    callCount: 1,
    chargedMicrousd: '10000',
    upperBoundMicrousd: '30000',
  }),
  costBasis: 'provider_reported' as const,
});
const ARTIFACT_REFERENCE: GenericOperationArtifactReference = Object.freeze({
  schemaVersion: 'generic-operation-artifact-ref/v1',
  artifactId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
  operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  resultSchema: 'http-get/v1',
  sha256: 'ab'.padEnd(64, '0'),
  sizeBytes: '123',
  mediaType: 'text/html',
  expiresAt: '2026-08-22T12:00:00.000Z',
});
const ARTIFACT_MANIFEST: GenericOperationArtifactManifest = Object.freeze({
  schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  artifactId: ARTIFACT_REFERENCE.artifactId,
  scopeKind: 'workspace',
  workspaceId: TEST_WORKSPACE_ID,
  authorityId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
  operationId: ARTIFACT_REFERENCE.operationId,
  resultSchema: ARTIFACT_REFERENCE.resultSchema,
  objectKey: `generic-operation-results/v1/sha256/${ARTIFACT_REFERENCE.sha256.slice(0, 2)}/${ARTIFACT_REFERENCE.sha256}`,
  sha256: ARTIFACT_REFERENCE.sha256,
  sizeBytes: ARTIFACT_REFERENCE.sizeBytes,
  mediaType: ARTIFACT_REFERENCE.mediaType,
  privacyClass: 'CONFIDENTIAL_TENANT',
  sourceDigest: null,
  createdAt: '2026-08-21T12:00:00.000Z',
  expiresAt: ARTIFACT_REFERENCE.expiresAt,
});
const ARTIFACT_SNAPSHOT = Object.freeze({
  manifest: ARTIFACT_MANIFEST,
  expectedFacts: Object.freeze({
    status: 200,
    ok: true,
    sanitizedUrl: 'https://example.com/final',
    blocked: null,
  }),
});

function fakePrisma(rows: unknown[][]): PrismaService {
  const queue = [...rows];
  return {
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({
        $queryRaw: vi.fn(async () => queue.shift() ?? []),
      } as never)),
  } as unknown as PrismaService;
}

function rawQueryMarkerError(marker: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('raw query failed', {
    code: 'P2010',
    clientVersion: 'test',
    meta: { code: 'P0001', message: `ERROR: ${marker}` },
  });
}

describe('PostgresBudgetStore', () => {
  it.each([1n, 9_999n, 10_000n, 9_223_372_036_854_775_807n])(
    'reserves exact additive microusd BIGINT boundary %s',
    async (estimatedMicrousd) => {
      const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
      const prisma = {
        withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
          $queryRaw: vi.fn(async (query) => {
            queries.push(query);
            return [{
              kind: 'EXECUTE',
              operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
              reserved_microusd: estimatedMicrousd,
              remaining_microusd: 0n,
              status: 'RESERVED',
            }];
          }),
        } as never)),
      } as unknown as PrismaService;
      const store = new PostgresBudgetStore(prisma);

      await expect(store.reserve({
        workspaceId: TEST_WORKSPACE_ID,
        accountKey: 'legacy-unbound',
        operationKey: `boundary:${estimatedMicrousd}`,
        estimatedMicrousd,
      })).resolves.toMatchObject({ estimatedMicrousd });
      expect(queries[0]?.strings?.join('')).toContain(
        'reserve_tool_budget',
      );
      expect(queries[0]?.values).toContain(estimatedMicrousd);
    },
  );

  it('rejects microusd overflow before persistence', async () => {
    const prisma = fakePrisma([]);
    const store = new PostgresBudgetStore(prisma);
    await expect(store.reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'legacy-unbound',
      operationKey: 'overflow',
      estimatedMicrousd: 9_223_372_036_854_775_808n,
    })).rejects.toBeInstanceOf(RangeError);
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    { observedMicrousd: 7_500n, chargedMicrousd: 7_500n, capVariance: false },
    { observedMicrousd: 10_001n, chargedMicrousd: 10_000n, capVariance: true },
  ])(
    'settles exact additive provider cost $observedMicrousd',
    async ({ observedMicrousd, chargedMicrousd, capVariance }) => {
      const store = new PostgresBudgetStore(fakePrisma([[
        {
          charged_microusd: chargedMicrousd,
          observed_microusd: observedMicrousd,
          cap_variance: capVariance,
          status: 'SETTLED',
          replay: false,
        },
      ]]));
      await expect(store.settle({
        workspaceId: TEST_WORKSPACE_ID,
        accountKey: 'legacy-unbound',
        operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        estimatedMicrousd: 10_000n,
        replay: false,
      }, observedMicrousd)).resolves.toEqual({
        chargedMicrousd,
        observedMicrousd,
        capVariance,
        replay: false,
      });
    },
  );

  it('reconstructs a ledger-authored durable receipt from the locked settle row', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        charged_microusd: BigInt(1) * 10_000n,
        observed_microusd: BigInt(1) * 10_000n,
        reserved_microusd: BigInt(3) * 10_000n,
        cap_variance: false,
        status: 'SETTLED',
        replay: false,
        account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        operation_key: 'workspace:model:taxonomy.normalize:request-1',
        result_schema_version: projection.schemaVersion,
        result_schema: projection.schema,
        result_digest: projection.digest,
        result_json: projection,
        receipt_usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '10000',
          upperBoundMicrousd: '30000',
        },
        receipt_cost_basis: 'provider_reported',
      },
    ]]));

    await expect(store.settle({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: BigInt(3) * 10_000n,
      replay: false,
    }, BigInt(1) * 10_000n, projection, PROVIDER_REPORTED_FACTS)).resolves.toMatchObject({
      chargedMicrousd: BigInt(1) * 10_000n,
      observedMicrousd: BigInt(1) * 10_000n,
      receipt: {
        scopeKey: TEST_WORKSPACE_ID,
        authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        accountId: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
        operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        operationKey: 'workspace:model:taxonomy.normalize:request-1',
        resultStrategy: 'typed_projection',
        resultSchema: 'taxonomy-code/v1',
        resultDigest: projection.digest,
        usage: {
          callCount: 1,
          chargedMicrousd: '10000',
          upperBoundMicrousd: '30000',
        },
        costBasis: 'provider_reported',
      },
    });
  });

  it('does not infer receipt cost basis or usage from charged cents when ledger receipt facts are absent', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        charged_microusd: BigInt(2) * 10_000n,
        observed_microusd: BigInt(2) * 10_000n,
        reserved_microusd: BigInt(9) * 10_000n,
        cap_variance: false,
        status: 'SETTLED',
        replay: false,
        account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        operation_key: 'workspace:model:taxonomy.normalize:request-1',
        result_schema_version: projection.schemaVersion,
        result_schema: projection.schema,
        result_digest: projection.digest,
        result_json: projection,
      },
    ]]));

    await expect(store.settle({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: BigInt(9) * 10_000n,
      replay: false,
    }, BigInt(2) * 10_000n, projection)).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED');
  });

  it('rejects cents receipt reconstruction when the locked row omits or drifts from caller projection facts', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const common = {
      charged_microusd: BigInt(1) * 10_000n,
      observed_microusd: BigInt(1) * 10_000n,
      reserved_microusd: BigInt(3) * 10_000n,
      cap_variance: false,
      status: 'SETTLED',
      replay: false,
      account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
      authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      operation_key: 'workspace:model:taxonomy.normalize:request-1',
      receipt_usage: PROVIDER_REPORTED_FACTS.usage,
      receipt_cost_basis: PROVIDER_REPORTED_FACTS.costBasis,
    };
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: common.operation_id,
      estimatedMicrousd: BigInt(3) * 10_000n,
      replay: false,
    };

    await expect(new PostgresBudgetStore(fakePrisma([[
      common,
    ]])).settle(
      reservation,
      10_000n,
      projection,
      PROVIDER_REPORTED_FACTS,
    )).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');

    await expect(new PostgresBudgetStore(fakePrisma([[
      {
        ...common,
        result_schema_version: projection.schemaVersion,
        result_schema: projection.schema,
        result_digest: 'b'.repeat(64),
        result_json: projection,
      },
    ]])).settle(
      reservation,
      10_000n,
      projection,
      PROVIDER_REPORTED_FACTS,
    )).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
  });

  it('fails closed for locked projection JSON, receipt metadata, fact, and parser drift', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { codes: ['CPV-123'] }, provider: 'new-api', model: 'gpt' } },
    });
    const differentProjection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { codes: ['CPV-999'] }, provider: 'new-api', model: 'gpt' } },
    });
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: BigInt(3) * 10_000n,
      replay: false,
    };
    const common = {
      charged_microusd: BigInt(1) * 10_000n,
      observed_microusd: BigInt(1) * 10_000n,
      reserved_microusd: BigInt(3) * 10_000n,
      cap_variance: false,
      status: 'SETTLED',
      replay: false,
      account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
      authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      operation_id: reservation.operationId,
      operation_key: 'workspace:model:taxonomy.normalize:request-1',
      result_schema_version: projection.schemaVersion,
      result_schema: projection.schema,
      result_digest: projection.digest,
      result_json: projection,
      receipt_usage: PROVIDER_REPORTED_FACTS.usage,
      receipt_cost_basis: PROVIDER_REPORTED_FACTS.costBasis,
    };
    const settle = (row: Record<string, unknown>) => new PostgresBudgetStore(
      fakePrisma([[row]]),
    ).settle(reservation, 10_000n, projection, PROVIDER_REPORTED_FACTS);

    await expect(settle({
      ...common,
      result_json: differentProjection,
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
    await expect(settle({
      ...common,
      account_id: undefined,
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
    await expect(settle({
      ...common,
      receipt_usage: {
        ...PROVIDER_REPORTED_FACTS.usage,
        chargedMicrousd: '9999',
      },
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
    await expect(settle({
      ...common,
      result_json: { malformed: true },
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
  });

  it('rejects receipt facts without a durable projection and native projections without facts', async () => {
    const store = new PostgresBudgetStore(fakePrisma([]));
    const centsReservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: BigInt(1) * 10_000n,
      replay: false,
    };
    await expect(store.settle(
      centsReservation,
      0n,
      undefined,
      PROVIDER_REPORTED_FACTS,
    )).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID');

    const projection = projectGenericOperationResult({
      kind: 'model', schema: 'taxonomy-code/v1', data: { code: 'CPV-123' },
    });
    await expect(store.settle({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: 10_000n,
      replay: false,
    }, 1n, projection)).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED');
  });

  it('reconstructs receipt usage and cost basis only from explicit locked ledger facts', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        charged_microusd: BigInt(2) * 10_000n,
        observed_microusd: BigInt(2) * 10_000n,
        reserved_microusd: BigInt(9) * 10_000n,
        cap_variance: false,
        status: 'SETTLED',
        replay: false,
        account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        operation_key: 'workspace:model:taxonomy.normalize:request-1',
        result_schema_version: projection.schemaVersion,
        result_schema: projection.schema,
        result_digest: projection.digest,
        result_json: projection,
        receipt_usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          inputTokens: 7,
          outputTokens: 3,
          chargedMicrousd: '777',
          upperBoundMicrousd: '90000',
        },
        receipt_cost_basis: 'token_pricing',
      },
    ]]));

    await expect(store.settle({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: BigInt(9) * 10_000n,
      replay: false,
    }, BigInt(2) * 10_000n, projection, {
      usage: {
        currency: 'USD',
        unit: 'microusd',
        callCount: 1,
        inputTokens: 7,
        outputTokens: 3,
        chargedMicrousd: '777',
        upperBoundMicrousd: '90000',
      },
      costBasis: 'token_pricing',
    })).resolves.toMatchObject({
      receipt: {
        usage: {
          chargedMicrousd: '777',
          upperBoundMicrousd: '90000',
        },
        costBasis: 'token_pricing',
      },
    });
  });

  it('ships the final authority-only microusd wrappers at Task 6 cutover', async () => {
    const [receiptMigration, migration] = await Promise.all([
      readFile(new URL(
        '../../../../packages/db/prisma/migrations/20260823000000_execution_domain_ack/migration.sql',
        import.meta.url,
      ), 'utf8'),
      readFile(new URL(
        '../../../../packages/db/prisma/migrations/20260824120000_execution_budget_authority_cutover/migration.sql',
        import.meta.url,
      ), 'utf8'),
    ]);

    expect(receiptMigration).toContain('"receipt_usage" JSONB');
    expect(receiptMigration).toContain('"receipt_cost_basis" VARCHAR(40)');
    expect(migration).toContain('CREATE FUNCTION reserve_tool_budget');
    expect(migration).toContain('CREATE FUNCTION settle_tool_budget');
    expect(migration).toContain('reserve_tool_budget');
    expect(migration).toContain('settle_tool_budget');
    expect(migration).not.toContain('open_authorized_tool_budget_microusd');
    const budgetStore = await readFile(new URL('./budget-store.ts', import.meta.url), 'utf8');
    expect(budgetStore).toContain('reserve_tool_budget');
    expect(budgetStore).toContain('settle_tool_budget');
    expect(budgetStore).toMatch(/SELECT \* FROM reserve_tool_budget\(/);
    expect(budgetStore).toMatch(/SELECT \* FROM settle_tool_budget\(/);
  });

  it('persists and reconstructs explicit receipt facts on the native microusd path', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const facts = {
      usage: {
        currency: 'USD' as const,
        unit: 'microusd' as const,
        callCount: 1,
        inputTokens: 7,
        outputTokens: 3,
        chargedMicrousd: '777',
        upperBoundMicrousd: '10000',
      },
      costBasis: 'token_pricing' as const,
    };
    const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async (query) => {
          queries.push(query);
          return [{
            charged_microusd: 777n,
            observed_microusd: 777n,
            reserved_microusd: 10_000n,
            cap_variance: false,
            status: 'SETTLED',
            replay: false,
            account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
            authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
            operation_key: 'workspace:model:taxonomy.normalize:request-1',
            result_schema_version: projection.schemaVersion,
            result_schema: projection.schema,
            result_digest: projection.digest,
            result_json: projection,
            receipt_usage: facts.usage,
            receipt_cost_basis: facts.costBasis,
          }];
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.settle({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: 10_000n,
      replay: false,
    }, 777n, projection, facts)).resolves.toMatchObject({
      receipt: {
        resultSchema: 'taxonomy-code/v1',
        usage: facts.usage,
        costBasis: 'token_pricing',
      },
    });
    expect(queries[0]?.strings?.join('')).toContain(
      'settle_tool_budget',
    );
    expect(queries[0]?.values).toContain(JSON.stringify(facts.usage));
    expect(queries[0]?.values).toContain(facts.costBasis);
  });

  it('rejects microusd receipt reconstruction unless the complete locked row byte-matches the submitted projection', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const facts = {
      usage: {
        currency: 'USD' as const,
        unit: 'microusd' as const,
        callCount: 1,
        inputTokens: 7,
        outputTokens: 3,
        chargedMicrousd: '777',
        upperBoundMicrousd: '10000',
      },
      costBasis: 'token_pricing' as const,
    };
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      estimatedMicrousd: 10_000n,
      replay: false,
    };
    const common = {
      charged_microusd: 777n,
      observed_microusd: 777n,
      reserved_microusd: 10_000n,
      cap_variance: false,
      status: 'SETTLED',
      replay: false,
      account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
      authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      operation_id: reservation.operationId,
      operation_key: 'workspace:model:taxonomy.normalize:request-1',
      receipt_usage: facts.usage,
      receipt_cost_basis: facts.costBasis,
    };

    await expect(new PostgresBudgetStore(fakePrisma([[
      common,
    ]])).settle(
      reservation,
      777n,
      projection,
      facts,
    )).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');

    await expect(new PostgresBudgetStore(fakePrisma([[
      {
        ...common,
        result_schema_version: projection.schemaVersion,
        result_schema: 'fit-judgment/v1',
        result_digest: projection.digest,
        result_json: projection,
      },
    ]])).settle(
      reservation,
      777n,
      projection,
      facts,
    )).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
  });

  it('reconstructs the same durable receipt for a replay reservation', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        kind: 'REPLAY',
        operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        operation_key: 'workspace:model:taxonomy.normalize:request-1',
        reserved_microusd: BigInt(3) * 10_000n,
        remaining_microusd: BigInt(7) * 10_000n,
        charged_microusd: BigInt(1) * 10_000n,
        observed_microusd: BigInt(1) * 10_000n,
        status: 'SETTLED',
        account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        result_schema_version: projection.schemaVersion,
        result_schema: projection.schema,
        result_digest: projection.digest,
        result_json: projection,
        receipt_usage: {
          currency: 'USD',
          unit: 'microusd',
          callCount: 1,
          chargedMicrousd: '10000',
          upperBoundMicrousd: '30000',
        },
        receipt_cost_basis: 'provider_reported',
      },
    ]]));

    const reservation = await store.reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationKey: 'workspace:model:taxonomy.normalize:request-1',
      estimatedMicrousd: BigInt(3) * 10_000n,
    });

    expect(reservation).toMatchObject({
      replay: true,
      replayResult: { resultStrategy: 'typed_projection', projection },
      receipt: {
        operationId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        resultDigest: projection.digest,
        usage: {
          chargedMicrousd: '10000',
          upperBoundMicrousd: '30000',
        },
      },
    });
  });

  it('rejects cents and microusd replay rows whose locked operation key drifts from the reservation', async () => {
    const projection = projectGenericOperationResult({
      kind: 'model',
      schema: 'taxonomy-code/v1',
      data: { result: { data: { code: 'CPV-123' }, provider: 'new-api', model: 'gpt' } },
    });
    const common = {
      kind: 'REPLAY' as const,
      operation_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
      operation_key: 'different-operation-key',
      status: 'SETTLED',
      account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
      authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      result_schema_version: projection.schemaVersion,
      result_schema: projection.schema,
      result_digest: projection.digest,
      result_json: projection,
      receipt_usage: PROVIDER_REPORTED_FACTS.usage,
      receipt_cost_basis: PROVIDER_REPORTED_FACTS.costBasis,
    };

    await expect(new PostgresBudgetStore(fakePrisma([[
      {
        ...common,
        reserved_microusd: BigInt(3) * 10_000n,
        remaining_microusd: BigInt(7) * 10_000n,
        charged_microusd: BigInt(1) * 10_000n,
        observed_microusd: BigInt(1) * 10_000n,
      },
    ]])).reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationKey: 'expected-operation-key',
      estimatedMicrousd: BigInt(3) * 10_000n,
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');

    await expect(new PostgresBudgetStore(fakePrisma([[
      {
        ...common,
        reserved_microusd: 30_000n,
        remaining_microusd: 70_000n,
        charged_microusd: 10_000n,
        observed_microusd: 10_000n,
      },
    ]])).reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'run-1',
      operationKey: 'expected-operation-key',
      estimatedMicrousd: 30_000n,
    })).rejects.toThrow('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
  });

  it('keeps authority-bound accounts nonspendable on the additive API', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw rawQueryMarkerError(
            'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
          );
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    await expect(store.reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'authority-bound',
      operationKey: 'blocked',
      estimatedMicrousd: 1n,
    })).rejects.toEqual(
      new ExecutionBudgetGrantError(
        'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      ),
    );
  });

  it('reports exact microusd budget denial without number conversion', async () => {
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        kind: 'DENIED',
        operation_id: null,
        reserved_microusd: 0n,
        remaining_microusd: 9_999n,
      },
    ]]));
    await expect(store.reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'legacy-unbound',
      operationKey: 'denied',
      estimatedMicrousd: 10_000n,
    })).rejects.toEqual(
      new BudgetExceededError(
        'legacy-unbound',
        10_000n,
        9_999n,
      ),
    );
  });

  it('releases, reads, and closes the additive microusd lifecycle', async () => {
    const prisma = fakePrisma([
      [{
        charged_microusd: 0n,
        observed_microusd: 0n,
        cap_variance: false,
        status: 'RELEASED',
        replay: false,
      }],
      [{
        remaining_microusd: 9_999n,
        exhausted: false,
        ref_count: 1,
      }],
      [{ close_tool_budget: true }],
    ]);
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'legacy-unbound',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedMicrousd: 1n,
      replay: false,
    };
    await expect(store.release(reservation)).resolves.toEqual({
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      capVariance: false,
      replay: false,
    });
    await expect(store.status({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: reservation.accountKey,
    })).resolves.toEqual({
      remainingMicrousd: 9_999n,
      exhausted: false,
      open: true,
    });
    await expect(store.close({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: reservation.accountKey,
      force: true,
    })).resolves.toBeUndefined();
  });

  it('reports an absent additive microusd status as closed', async () => {
    const store = new PostgresBudgetStore(fakePrisma([[]]));
    await expect(store.status({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'missing',
    })).resolves.toEqual({
      remainingMicrousd: 0n,
      exhausted: false,
      open: false,
    });
  });

  it('opens an authority-bound account without accepting or sending a caller amount', async () => {
    const queries: Array<{ strings?: readonly string[]; values?: readonly unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async (query) => {
          queries.push(query);
          return [{
            account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
            generation: 2,
            authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            authorized_cap_microusd: 2_000_000n,
          }];
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: TEST_WORKSPACE_ID,
      accountKey: 'icp:design:req',
      replayScope: true,
    })).resolves.toEqual({
      accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      authorizedCapMicrousd: 2_000_000n,
      generation: 2,
    });

    const serializedQuery = queries[0]?.strings?.join('') ?? '';
    expect(serializedQuery).toContain('open_tool_budget');
    expect(serializedQuery).not.toMatch(/capCents|capMicrousd|amount/i);
    expect(queries[0]?.values).toEqual([
      'e03abddd-1307-47cb-a731-7e7a786615a0',
      '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      'icp:design:req',
      true,
    ]);
  });

  it('does not treat the legacy owner connection as the platform authority writer', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]));

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'acquisition-hourly:run-1',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    expect(ownerDb.$transaction).not.toHaveBeenCalled();
  });

  it('opens platform authority only through the separately injected writer connection', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([SAFE_PLATFORM_PRINCIPAL])
      .mockResolvedValueOnce([{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
        generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        authorized_cap_microusd: 1_000_000n,
      }]);
    const platformWriter = {
      $transaction: vi.fn(async (fn) => fn({
        $executeRawUnsafe: vi.fn(async () => 0),
        $queryRaw: queryRaw,
      } as never)),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]), platformWriter);

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'acquisition-hourly:run-1',
    })).resolves.toMatchObject({ authorizedCapMicrousd: 1_000_000n });
    expect(ownerDb.$transaction).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(
      (queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] }).strings?.join(''),
    ).toContain('pg_auth_members');
    expect(
      (queryRaw.mock.calls[1]?.[0] as { strings?: readonly string[] }).strings?.join(''),
    ).toContain('open_tool_budget');
  });

  it('admits a platform schedule run atomically through the writer with no caller cap or owner fallback', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([SAFE_PLATFORM_PRINCIPAL])
      .mockResolvedValueOnce([{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
        generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        authorized_cap_microusd: 1_000_000n,
        campaign_cap_microusd: 10_000_000n,
        max_runs: 10n,
        replay: false,
      }]);
    const platformWriter = {
      $transaction: vi.fn(async (fn) => fn({
        $executeRawUnsafe: vi.fn(async () => 0),
        $queryRaw: queryRaw,
      } as never)),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]), platformWriter);
    const input = {
      purpose: 'platform.acquisition' as const,
      subjectType: 'schedule' as const,
      subjectId: 'acq-sweep',
      scheduleId: 'acq-sweep',
      requestSha256: '5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e',
      workflowRunId: 'workflow-run-1',
      accountKey: 'platform:5e960ccef72129aa32bdd9464c9d7b546e5ed6dd7a639caad46df77edea3448e:workflow-run-1',
    };

    await expect(store.admitPlatformRun(input)).resolves.toEqual({
      accountId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      authorizedCapMicrousd: 1_000_000n,
      generation: 1,
      replay: false,
    });

    expect(ownerDb.$transaction).not.toHaveBeenCalled();
    expect(platformWriter.$transaction).toHaveBeenCalledOnce();
    const admission = queryRaw.mock.calls[1]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    expect(admission.strings?.join('')).toContain('admit_platform_execution_budget_run_v1');
    expect(admission.strings?.join('')).not.toMatch(/cap|workspace/i);
    expect(admission.values).toEqual([
      input.purpose,
      input.subjectType,
      input.subjectId,
      input.scheduleId,
      input.requestSha256,
      input.workflowRunId,
      input.accountKey,
    ]);
  });

  it('does not use the legacy owner connection when the platform writer is absent', async () => {
    const ownerDb = {
      $transaction: vi.fn(async () => []),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]));

    await expect(store.admitPlatformRun({
      purpose: 'platform.sanctions',
      subjectType: 'schedule',
      subjectId: 'sanctions-refresh',
      scheduleId: 'sanctions-refresh',
      requestSha256: '50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe',
      workflowRunId: 'workflow-run-1',
      accountKey: 'platform:50b8dfae274bb16a825147c648f46789ea0eb291b3d32964c8bacf385340dffe:workflow-run-1',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    expect(ownerDb.$transaction).not.toHaveBeenCalled();
  });

  it('attests an existing authority account without calling the holder-incrementing open function', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{
      account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      generation: 1,
      authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      authorized_cap_microusd: 1_000_000n,
    }]);
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({ $queryRaw: queryRaw } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    const input = {
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: TEST_WORKSPACE_ID,
      accountKey: 'icp:design:req',
    };
    const retries = await Promise.all(
      Array.from({ length: 20 }, () => store.attestAuthorized(input)),
    );
    expect(retries).toHaveLength(20);
    expect(retries[0]).toMatchObject({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      generation: 1,
    });

    const sql = (queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] }).strings?.join('') ?? '';
    expect(sql).toContain('attest_authorized_tool_budget_v1');
    expect(sql).not.toContain('open_tool_budget');
    expect(queryRaw).toHaveBeenCalledTimes(20);
  });

  it('rejects an unsafe platform principal before authorized open', async () => {
    const queryRaw = vi.fn().mockResolvedValueOnce([{
      ...SAFE_PLATFORM_PRINCIPAL,
      memberships: [
        'execution_budget_platform_writer',
        'runtime_worker',
      ],
    }]);
    const platformWriter = {
      $transaction: vi.fn(async (fn) => fn({
        $executeRawUnsafe: vi.fn(async () => 0),
        $queryRaw: queryRaw,
      } as never)),
    } as unknown as PrismaClient;
    const store = new PostgresBudgetStore(fakePrisma([]), platformWriter);

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'acquisition-hourly:run-1',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError(
        'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
      ),
    );
    expect(queryRaw).toHaveBeenCalledOnce();
  });

  it('maps the authority lifecycle fence to one non-leaking unavailable error', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw rawQueryMarkerError(
            'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
          );
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'authority-bound',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedMicrousd: BigInt(1) * 10_000n,
      replay: false,
    };
    const expected = new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    );

    await expect(store.open({
      authorityId: '89528818-13ab-4a46-9dfd-6fbcdba6943e',
      scopeKey: reservation.workspaceId,
      accountKey: reservation.accountKey,
    })).rejects.toEqual(expected);
    await expect(store.reserve({
      workspaceId: reservation.workspaceId,
      accountKey: reservation.accountKey,
      operationKey: 'operation',
      estimatedMicrousd: BigInt(1) * 10_000n,
    })).rejects.toEqual(expected);
    await expect(store.settle(reservation, BigInt(1) * 10_000n)).rejects.toEqual(expected);
    await expect(store.release(reservation)).rejects.toEqual(expected);
    await expect(store.status({
      workspaceId: reservation.workspaceId,
      accountKey: reservation.accountKey,
    })).rejects.toEqual(expected);
    await expect(store.close({
      workspaceId: reservation.workspaceId,
      accountKey: reservation.accountKey,
    })).rejects.toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain(
      'EXECUTION_BUDGET_AUTHORITY_LIFECYCLE_UNAVAILABLE',
    );
  });

  it.each([
    'EXECUTION_BUDGET_GRANT_INVALID',
    'EXECUTION_BUDGET_GRANT_EXPIRED',
    'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    'EXECUTION_BUDGET_GRANT_REUSED',
    'EXECUTION_BUDGET_AUTHORITY_REVOKED',
    'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
  ] as const)('maps authorized-open SQL marker %s without leaking database detail', async (marker) => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw rawQueryMarkerError(marker);
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: TEST_WORKSPACE_ID,
      accountKey: 'icp:design:req',
    })).rejects.toEqual(new ExecutionBudgetGrantError(marker));
  });

  it('trusts unsettled-operation markers only from the structured raw-query error', async () => {
    const input = {
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
    };
    const fake = (failure: Error) => new PostgresBudgetStore({
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => {
          throw failure;
        }),
      } as never)),
    } as unknown as PrismaService);

    await expect(
      fake(new Error('TOOL_BUDGET_UNSETTLED_OPERATIONS')).open(input),
    ).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
    await expect(
      fake(rawQueryMarkerError('TOOL_BUDGET_UNSETTLED_OPERATIONS')).open(input),
    ).rejects.toBeInstanceOf(BudgetUnsettledOperationsError);
  });

  it.each([
    { name: 'missing row', rows: [] },
    {
      name: 'multiple rows',
      rows: [
        {
          account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
        },
        {
          account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
        },
      ],
    },
    {
      name: 'malformed account UUID',
      rows: [{
        account_id: 'not-an-account', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'non-positive generation',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 0,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'unsafe generation',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: Number.MAX_SAFE_INTEGER + 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'malformed authority UUID',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: 'not-an-authority', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'wrong authority UUID',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07', authorized_cap_microusd: 1n,
      }],
    },
    {
      name: 'non-bigint cap',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 1,
      }],
    },
    {
      name: 'non-positive cap',
      rows: [{
        account_id: '89528818-13ab-4a46-9dfd-6fbcdba6943e', generation: 1,
        authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b', authorized_cap_microusd: 0n,
      }],
    },
  ])('fails authorized open closed for $name', async ({ rows }) => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async () => rows),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'icp:design:req',
    })).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
  });

  it.each([
    {
      name: 'malformed authority UUID',
      input: {
        authorityId: 'not-an-authority',
        scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      },
      code: 'EXECUTION_BUDGET_GRANT_INVALID',
    },
    {
      name: 'malformed workspace scope',
      input: {
        authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        scopeKey: 'EXECUTION_BUDGET_GRANT_EXPIRED',
      },
      code: 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    },
  ] as const)('rejects $name before authorized-open persistence', async ({ input, code }) => {
    const prisma = fakePrisma([]);
    const store = new PostgresBudgetStore(prisma);

    await expect(store.open({
      ...input,
      accountKey: 'icp:design:req',
    })).rejects.toEqual(new ExecutionBudgetGrantError(code));
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it('maps an atomic reservation into a durable handle', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([
        [
          {
            kind: 'EXECUTE',
            operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            reserved_microusd: BigInt(12) * 10_000n,
            remaining_microusd: BigInt(88) * 10_000n,
            status: 'RESERVED',
          },
        ],
      ]),
    );

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run-1',
        operationKey: 'tool:v1:request-1',
        estimatedMicrousd: BigInt(12) * 10_000n,
      }),
    ).resolves.toEqual({
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-1',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedMicrousd: BigInt(12) * 10_000n,
      replay: false,
    });
  });

  it('fails closed when the account is absent and preserves a budget denial', async () => {
    const unavailable = new PostgresBudgetStore(
      fakePrisma([[{ kind: 'ACCOUNT_UNAVAILABLE', operation_id: null, reserved_microusd: BigInt(0) * 10_000n, remaining_microusd: BigInt(0) * 10_000n }]]),
    );
    await expect(
      unavailable.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'missing', operationKey: 'op', estimatedMicrousd: BigInt(1) * 10_000n }),
    ).rejects.toBeInstanceOf(BudgetAccountUnavailableError);

    const exceeded = new PostgresBudgetStore(
      fakePrisma([[{ kind: 'DENIED', operation_id: null, reserved_microusd: BigInt(0) * 10_000n, remaining_microusd: BigInt(3) * 10_000n }]]),
    );
    await expect(
      exceeded.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedMicrousd: BigInt(9) * 10_000n }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('maps the database account guard to the stable unavailable-account error', async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw new Error('TOOL_BUDGET_ACCOUNT_UNAVAILABLE');
          }),
        } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'missing',
        operationKey: 'op',
        estimatedMicrousd: BigInt(1) * 10_000n,
      }),
    ).rejects.toBeInstanceOf(BudgetAccountUnavailableError);
  });

  it('settles through the database and reports an observed cap variance', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[{ charged_microusd: BigInt(10) * 10_000n, observed_microusd: BigInt(14) * 10_000n, cap_variance: true, status: 'SETTLED' }]]),
    );
    await expect(
      store.settle(
        {
          workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
          accountKey: 'run-1',
          operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          estimatedMicrousd: BigInt(10) * 10_000n,
          replay: false,
        },
        140_000n,
      ),
    ).resolves.toEqual({ chargedMicrousd: BigInt(10) * 10_000n, observedMicrousd: BigInt(14) * 10_000n, capVariance: true, replay: false });
  });

  it('releases a reservation without charging when execution never starts', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[{ charged_microusd: BigInt(0) * 10_000n, observed_microusd: BigInt(0) * 10_000n, cap_variance: false, status: 'RELEASED' }]]),
    );
    await expect(
      store.release({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run-1',
        operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
        estimatedMicrousd: BigInt(10) * 10_000n,
        replay: false,
      }),
    ).resolves.toMatchObject({ chargedMicrousd: BigInt(0) * 10_000n, observedMicrousd: BigInt(0) * 10_000n, replay: false });
  });

  it('preserves explicit database replay facts for repeated settle and release', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([
        [{ charged_microusd: BigInt(7) * 10_000n, observed_microusd: BigInt(7) * 10_000n, cap_variance: false, status: 'SETTLED', replay: true }],
        [{ charged_microusd: BigInt(0) * 10_000n, observed_microusd: BigInt(0) * 10_000n, cap_variance: false, status: 'RELEASED', replay: true }],
      ]),
    );
    const reservation = {
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'run-1',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      estimatedMicrousd: BigInt(7) * 10_000n,
      replay: false,
    };

    await expect(store.settle(reservation, BigInt(7) * 10_000n)).resolves.toMatchObject({ replay: true });
    await expect(store.release(reservation)).resolves.toMatchObject({ replay: true });
  });

  it('marks an existing operation as replay and rejects unsafe inputs', async () => {
    const projection = projectGenericOperationResult({
      kind: 'tool', schema: 'bounded-tool/v1', data: { ok: true },
    });
    const store = new PostgresBudgetStore(
      fakePrisma([[
        {
          kind: 'REPLAY',
          operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          reserved_microusd: BigInt(5) * 10_000n,
          remaining_microusd: BigInt(10) * 10_000n,
          status: 'RESERVED',
          result_json: projection,
          operation_key: 'op',
          account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
          authority_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          result_schema_version: projection.schemaVersion,
          result_schema: projection.schema,
          result_digest: projection.digest,
          receipt_usage: {
            currency: 'USD', unit: 'microusd', callCount: 1,
            upperBoundMicrousd: '50000',
          },
          receipt_cost_basis: 'estimated_upper_bound',
        },
      ]]),
    );
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedMicrousd: BigInt(5) * 10_000n }),
    ).resolves.toMatchObject({
      replay: true,
      replayResult: { resultStrategy: 'typed_projection', projection },
    });
    await expect(
      store.open({
        authorityId: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
        scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: '',
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run', operationKey: 'op', estimatedMicrousd: -1n }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('passes an approved projection into the atomic settlement function', async () => {
    const queries: Array<{ values?: unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) => fn({
        $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
          queries.push(query);
          return [{
            charged_microusd: BigInt(1) * 10_000n,
            observed_microusd: BigInt(1) * 10_000n,
            cap_variance: false,
            status: 'SETTLED',
            replay: false,
            operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
            operation_key: 'op',
            account_id: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
            authority_id: '1b3d6096-b924-4bc8-bb4f-8436efb37b07',
            result_schema_version: 'generic-operation-projection/v1',
            result_schema: 'fit-judgment/v1',
            result_digest: projection.digest,
            result_json: projection,
            receipt_usage: {
              currency: 'USD', unit: 'microusd', callCount: 1,
              upperBoundMicrousd: '10000',
            },
            receipt_cost_basis: 'estimated_upper_bound',
          }];
        }),
      } as never)),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const projection = projectGenericOperationResult({
      kind: 'model', schema: 'fit-judgment/v1', data: { verdict: 'match' },
    });

    await store.settle({
      workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run',
      operationId: '42c863b9-7c7e-4d28-8678-60ef9a20219b', estimatedMicrousd: BigInt(1) * 10_000n, replay: false,
    }, BigInt(1) * 10_000n, projection, {
      usage: {
        currency: 'USD', unit: 'microusd', callCount: 1,
        upperBoundMicrousd: '10000',
      },
      costBasis: 'estimated_upper_bound',
    });

    expect(queries[0]?.values).toEqual(expect.arrayContaining([
      projection.schemaVersion, projection.schema, projection.digest,
    ]));
  });

  it('records zero-cost operations for durable idempotency without consuming budget', async () => {
    const store = new PostgresBudgetStore(
      fakePrisma([[
        {
          kind: 'EXECUTE',
          operation_id: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
          reserved_microusd: BigInt(0) * 10_000n,
          remaining_microusd: BigInt(10) * 10_000n,
          status: 'RESERVED',
        },
      ]]),
    );

    await expect(
      store.reserve({
        workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0',
        accountKey: 'run',
        operationKey: 'free-operation',
        estimatedMicrousd: BigInt(0) * 10_000n,
      }),
    ).resolves.toMatchObject({ estimatedMicrousd: BigInt(0) * 10_000n, replay: false });
  });

  it('requires the authority writer connection for the platform scope', async () => {
    const store = new PostgresBudgetStore(fakePrisma([]));
    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'platform',
      accountKey: 'sweep',
    })).rejects.toMatchObject({
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    });
  });
});

describe('UnavailableBudgetStore', () => {
  it('never treats a missing authoritative store as unlimited budget', async () => {
    const store = new UnavailableBudgetStore('postgres not configured');
    await expect(
      store.reserve({ workspaceId: 'e03abddd-1307-47cb-a731-7e7a786615a0', accountKey: 'run-1', operationKey: 'op', estimatedMicrousd: BigInt(1) * 10_000n }),
    ).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });

  it('fails every lifecycle operation closed', async () => {
    const store = new UnavailableBudgetStore();
    const reservation = { workspaceId: 'w', accountKey: 'a', operationId: 'o', estimatedMicrousd: BigInt(1) * 10_000n, replay: false };
    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: 'e03abddd-1307-47cb-a731-7e7a786615a0',
      accountKey: 'a',
    })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.settle(reservation, BigInt(1) * 10_000n)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.markResultUnknown(reservation)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.loadResultUnknownArtifact(
      reservation,
      ARTIFACT_MANIFEST.authorityId,
    )).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.settleArtifactManifest(reservation, 1, ARTIFACT_SNAPSHOT)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.release(reservation)).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.status({ workspaceId: 'w', accountKey: 'a' })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
    await expect(store.close({ workspaceId: 'w', accountKey: 'a' })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });

  it('fails authorized open directly without fabricating an account', async () => {
    const store = new UnavailableBudgetStore();
    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: TEST_WORKSPACE_ID,
      accountKey: 'authority-bound',
    })).rejects.toMatchObject({ code: 'BUDGET_STORE_UNAVAILABLE' });
  });
});

describe('InMemoryBudgetStoreAdapter', () => {
  it('remains available only through explicit test injection', async () => {
    const ledger = new BudgetLedger();
    ledger.open('run', 10);
    const store = new InMemoryBudgetStoreAdapter(ledger);
    const reservation = await store.reserve({ workspaceId: 'w', accountKey: 'run', operationKey: 'op', estimatedMicrousd: BigInt(4) * 10_000n });
    await expect(store.status({ workspaceId: 'w', accountKey: 'run' })).resolves.toMatchObject({ remainingMicrousd: BigInt(6) * 10_000n, open: true });
    await expect(store.settle(reservation, BigInt(3) * 10_000n)).resolves.toMatchObject({ chargedMicrousd: BigInt(3) * 10_000n });
    const released = await store.reserve({ workspaceId: 'w', accountKey: 'run', operationKey: 'op-2', estimatedMicrousd: BigInt(2) * 10_000n });
    await expect(store.release(released)).resolves.toMatchObject({ chargedMicrousd: BigInt(0) * 10_000n });
    await store.close({ workspaceId: 'w', accountKey: 'run', force: true });
    await expect(store.status({ workspaceId: 'w', accountKey: 'run' })).resolves.toMatchObject({ open: false });
  });

  it('cannot emulate an externally signed authority account', async () => {
    const store = new InMemoryBudgetStoreAdapter(new BudgetLedger());
    await expect(store.open({
      authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
      scopeKey: TEST_WORKSPACE_ID,
      accountKey: 'authority-bound',
    })).rejects.toThrow('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
  });

  it('cannot emulate artifact RESULT_UNKNOWN or durable reference settlement', async () => {
    const store = new InMemoryBudgetStoreAdapter(new BudgetLedger());
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: 'artifact-account',
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedMicrousd: BigInt(17) * 10_000n,
      replay: false,
    };

    await expect(store.markResultUnknown(reservation)).rejects.toThrow('BUDGET_STORE_UNAVAILABLE');
    await expect(
      store.settleArtifactManifest(reservation, 130_000n, ARTIFACT_SNAPSHOT),
    ).rejects.toThrow('BUDGET_STORE_UNAVAILABLE');
  });
});
