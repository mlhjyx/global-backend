import { readFile } from 'node:fs/promises';
import { types as nodeUtilTypes } from 'node:util';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const repositoryUrl = new URL('./governed-subject-relation.repository.ts', import.meta.url);
const typesUrl = new URL('./governed-subject-relation.types.ts', import.meta.url);
const APPEND = 'append_workspace_governed_child_relation_v1';
const ATTEST = 'attest_workspace_governed_child_relation_v1';
const IDS = Object.freeze({
  workspaceId: '10000000-0000-4000-8000-000000000001',
  authorityId: '20000000-0000-4000-8000-000000000001',
  accountId: '30000000-0000-4000-8000-000000000001',
  operationId: '40000000-0000-4000-8000-000000000001',
  operationSubjectId: '50000000-0000-4000-8000-000000000001',
  childId: '60000000-0000-4000-8000-000000000001',
  childSubjectId: '70000000-0000-4000-8000-000000000001',
  relationId: '80000000-0000-4000-8000-000000000001',
  sourceId: '90000000-0000-4000-8000-000000000001',
});
const ACK = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);
const CONTRACT = 'c'.repeat(64);
const SQL_CASTS = [
  'uuid', 'uuid', 'uuid', 'uuid', 'integer', 'char(64)', 'char(64)',
  'varchar(191)', 'uuid', 'varchar(16)', 'varchar(191)', 'uuid', 'uuid',
  'varchar(191)', 'uuid', 'varchar(16)', 'varchar(191)', 'uuid',
  'varchar(200)', 'varchar(32)', 'varchar(64)', 'uuid', 'char(64)', 'char(64)',
] as const;
const STABLE_ERRORS = [
  'GOVERNED_OPERATION_SUBJECT_INVALID',
  'GOVERNED_SUBJECT_INVALID',
  'GOVERNED_SUBJECT_RELATION_INVALID',
  'GOVERNED_SUBJECT_RELATION_CONFLICT',
  'GOVERNED_SUBJECT_TOMBSTONED',
  'GOVERNED_SUBJECT_AUTHORITY_REVOKED',
  'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE',
] as const;

type RepositoryModule = {
  GovernedSubjectRelationRepository: new () => {
    appendChildRelationV1(transaction: unknown, input: unknown): Promise<unknown>;
    attestChildRelationV1(transaction: unknown, input: unknown): Promise<unknown>;
  };
  GOVERNED_SUBJECT_RELATION_INVALID: string;
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE: string;
} & Record<(typeof STABLE_ERRORS)[number], string>;

type TestInput = {
  workspaceId: string;
  authorityId: string;
  accountId: string;
  operationId: string;
  operationGeneration: number;
  ackId: string;
  resultDigest: string;
  rootSubjectType: string;
  rootSubjectId: string;
  rootDataClass: string;
  rootDsrSubjectType: string | null;
  rootDsrSubjectId: string | null;
  parentGovernedSubjectId: string | null;
  childSubjectType: string;
  childSubjectId: string;
  childDataClass: string;
  childDsrSubjectType: string | null;
  childDsrSubjectId: string | null;
  relationKey: string;
  relationKind: string;
  sourceRef: { namespace: string; uuid: string | null; sha256: string | null };
  contractSha256: string;
};

function validInput(): TestInput {
  return {
    workspaceId: IDS.workspaceId,
    authorityId: IDS.authorityId,
    accountId: IDS.accountId,
    operationId: IDS.operationId,
    operationGeneration: 1,
    ackId: ACK,
    resultDigest: DIGEST,
    rootSubjectType: 'tool_operation',
    rootSubjectId: IDS.operationId,
    rootDataClass: 'NON_PERSONAL',
    rootDsrSubjectType: null,
    rootDsrSubjectId: null,
    parentGovernedSubjectId: null,
    childSubjectType: 'materialized_record',
    childSubjectId: IDS.childId,
    childDataClass: 'NON_PERSONAL',
    childDsrSubjectType: null,
    childDsrSubjectId: null,
    relationKey: 'record:0',
    relationKind: 'MATERIALIZED_CHILD',
    sourceRef: {
      namespace: 'source_record',
      uuid: IDS.sourceId,
      sha256: null,
    },
    contractSha256: CONTRACT,
  };
}

function expectedValues(input: TestInput = validInput()): unknown[] {
  return [
    input.workspaceId, input.authorityId, input.accountId, input.operationId,
    input.operationGeneration, input.ackId, input.resultDigest,
    input.rootSubjectType, input.rootSubjectId, input.rootDataClass,
    input.rootDsrSubjectType, input.rootDsrSubjectId,
    input.parentGovernedSubjectId, input.childSubjectType, input.childSubjectId,
    input.childDataClass, input.childDsrSubjectType, input.childDsrSubjectId,
    input.relationKey, input.relationKind, input.sourceRef.namespace,
    input.sourceRef.uuid, input.sourceRef.sha256, input.contractSha256,
  ];
}

async function loadRepository(): Promise<RepositoryModule> {
  try {
    return await import(repositoryUrl.href) as RepositoryModule;
  } catch {
    throw new Error('GOVERNED_SUBJECT_RELATION_REPOSITORY_MISSING');
  }
}

function transactionRows(rows: readonly unknown[] | Error) {
  const queryRaw = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const executeRaw = vi.fn();
  const queryRawUnsafe = vi.fn();
  const executeRawUnsafe = vi.fn();
  return {
    value: {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe,
    },
    queryRaw,
    executeRaw,
    queryRawUnsafe,
    executeRawUnsafe,
  };
}

function transaction(row: unknown | Error) {
  return transactionRows(row instanceof Error ? row : [row]);
}

function resultRow(replay: boolean) {
  return {
    operation_subject_id: IDS.operationSubjectId,
    parent_subject_id: IDS.operationSubjectId,
    child_subject_id: IDS.childSubjectId,
    relation_id: IDS.relationId,
    replay,
  };
}

function capturedQuery(queryRaw: ReturnType<typeof vi.fn>) {
  const query = queryRaw.mock.calls[0]?.[0] as {
    strings: readonly string[];
    values: readonly unknown[];
  };
  expect(query).toBeDefined();
  return query;
}

function assertSingleSelect(
  database: ReturnType<typeof transactionRows>,
  functionName: string,
): void {
  expect(database.queryRaw).toHaveBeenCalledOnce();
  expect(database.executeRaw).not.toHaveBeenCalled();
  expect(database.queryRawUnsafe).not.toHaveBeenCalled();
  expect(database.executeRawUnsafe).not.toHaveBeenCalled();
  const query = capturedQuery(database.queryRaw);
  expect(query.values).toHaveLength(24);
  expect(query.strings).toHaveLength(25);
  validateTaggedSelect(query, functionName);
}

function validateTaggedSelect(
  query: { strings: readonly string[]; values: readonly unknown[] },
  functionName: string,
): void {
  if (query.values.length !== 24 || query.strings.length !== 25) {
    throw new Error('INVALID_TAGGED_SELECT_ARITY');
  }
  const sql = query.strings.join('?').replace(/\s+/g, ' ').trim();
  const expected = `SELECT * FROM public.${functionName}(${SQL_CASTS.map((cast) => `?::${cast}`).join(',')})`;
  if (sql !== expected && sql !== `${expected};`) throw new Error('INVALID_TAGGED_SELECT_SHAPE');
  if ((sql.match(/\?/gu) ?? []).length !== 24) throw new Error('INVALID_TAGGED_SELECT_PLACEHOLDERS');
}

function databaseMarker(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('redacted database marker', {
    code: 'P2010',
    clientVersion: 'task2-test',
    meta: { code: 'P0001', message: `ERROR: ${code}` },
  });
}

function exactClosed(value: unknown, keys: readonly string[]): boolean {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every((key) =>
      typeof key === 'string' && keys.includes(key) &&
      descriptors[key]?.enumerable === true && 'value' in descriptors[key]);
  } catch {
    return false;
  }
}

describe('GovernedSubjectRelationRepository Task 2 contract', () => {
  it('publishes the exact source surface without Nest or runtime registration', async () => {
    const [repository, types] = await Promise.all([
      readFile(repositoryUrl, 'utf8'),
      readFile(typesUrl, 'utf8'),
    ]);
    expect(repository).toContain('class GovernedSubjectRelationRepository');
    expect(repository).toContain('appendChildRelationV1');
    expect(repository).toContain('attestChildRelationV1');
    expect(repository).toContain(APPEND);
    expect(repository).toContain(ATTEST);
    expect(repository).not.toMatch(/@Injectable|@Module|Temporal|Worker/iu);
    for (const token of [
      'GovernedSubjectRelationInput', 'GovernedSubjectRelationResult',
      ...STABLE_ERRORS,
    ]) expect(`${types}\n${repository}`).toContain(token);
  });

  it('binds append to the exact 24 SQL values and returns one frozen closed result', async () => {
    const module = await loadRepository();
    const database = transaction(resultRow(false));
    const result = await new module.GovernedSubjectRelationRepository()
      .appendChildRelationV1(database.value, validInput());
    const query = capturedQuery(database.queryRaw);
    assertSingleSelect(database, APPEND);
    expect(query.strings.join('')).toContain(APPEND);
    expect(query.values).toEqual(expectedValues());
    expect(result).toEqual({
      operationSubjectId: IDS.operationSubjectId,
      parentSubjectId: IDS.operationSubjectId,
      childSubjectId: IDS.childSubjectId,
      relationId: IDS.relationId,
      replay: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('accepts both strict boolean replay outcomes for append while attest remains replay-only', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    await expect(repository.appendChildRelationV1(
      transaction(resultRow(false)).value, validInput(),
    )).resolves.toMatchObject({ replay: false });
    await expect(repository.appendChildRelationV1(
      transaction(resultRow(true)).value, validInput(),
    )).resolves.toMatchObject({ replay: true });
    await expect(repository.attestChildRelationV1(
      transaction(resultRow(false)).value, validInput(),
    )).rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
  });

  it('binds attest to the identical 24 SQL values and requires replay=true', async () => {
    const module = await loadRepository();
    const database = transaction(resultRow(true));
    const result = await new module.GovernedSubjectRelationRepository()
      .attestChildRelationV1(database.value, validInput());
    const query = capturedQuery(database.queryRaw);
    assertSingleSelect(database, ATTEST);
    expect(query.strings.join('')).toContain(ATTEST);
    expect(query.values).toEqual(expectedValues());
    expect(result).toEqual({
      operationSubjectId: IDS.operationSubjectId,
      parentSubjectId: IDS.operationSubjectId,
      childSubjectId: IDS.childSubjectId,
      relationId: IDS.relationId,
      replay: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('rejects proxy, accessor, symbol and extra fields before SQL at both object levels', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const inputKeys = Object.keys(validInput());
    const sourceKeys = Object.keys(validInput().sourceRef);
    const accessor = validInput() as Record<string, unknown>;
    Object.defineProperty(accessor, 'workspaceId', { enumerable: true, get: () => IDS.workspaceId });
    const withSymbol = Object.assign(validInput(), { [Symbol('hidden')]: true });
    const sourceAccessor = validInput();
    Object.defineProperty(sourceAccessor.sourceRef, 'uuid', { enumerable: true, get: () => IDS.sourceId });
    const candidates = [
      { ...validInput(), extra: true },
      new Proxy(validInput(), {}),
      accessor,
      withSymbol,
      { ...validInput(), sourceRef: { ...validInput().sourceRef, extra: true } },
      { ...validInput(), sourceRef: new Proxy(validInput().sourceRef, {}) },
      sourceAccessor,
    ];
    expect(exactClosed(validInput(), inputKeys)).toBe(true);
    expect(exactClosed(validInput().sourceRef, sourceKeys)).toBe(true);
    for (const candidate of candidates) {
      for (const method of ['appendChildRelationV1', 'attestChildRelationV1'] as const) {
        const database = transaction(resultRow(method === 'attestChildRelationV1'));
        await expect(repository[method](database.value, candidate))
          .rejects.toThrow(module.GOVERNED_SUBJECT_RELATION_INVALID);
        expect(database.queryRaw).not.toHaveBeenCalled();
      }
    }
  });

  it('enforces the complete semantic input contract identically before append and attest SQL', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const personal = {
      ...validInput(),
      childDataClass: 'PERSONAL',
      childDsrSubjectType: 'person',
      childDsrSubjectId: '61000000-0000-4000-8000-000000000099',
    };
    const invalid = [
      { ...validInput(), workspaceId: 'not-a-uuid' },
      { ...validInput(), authorityId: 'not-a-uuid' },
      { ...validInput(), accountId: 'not-a-uuid' },
      { ...validInput(), operationId: 'not-a-uuid' },
      { ...validInput(), operationGeneration: 0 },
      { ...validInput(), operationGeneration: 1.5 },
      { ...validInput(), operationGeneration: 2_147_483_648 },
      { ...validInput(), ackId: ACK.toUpperCase() },
      { ...validInput(), resultDigest: 'b'.repeat(63) },
      { ...validInput(), contractSha256: CONTRACT.toUpperCase() },
      { ...validInput(), parentGovernedSubjectId: 'not-a-uuid' },
      { ...validInput(), childSubjectType: 'Bad-Type' },
      { ...validInput(), childDataClass: 'UNKNOWN' },
      { ...validInput(), childDsrSubjectType: 'Bad-Type' },
      { ...validInput(), relationKey: 'Bad Key' },
      { ...validInput(), relationKind: 'ARBITRARY_EDGE' },
      { ...validInput(), sourceRef: { ...validInput().sourceRef, namespace: 'Bad-Type' } },
      { ...validInput(), sourceRef: { namespace: 'source_record', uuid: null, sha256: null } },
      { ...validInput(), sourceRef: { namespace: 'source_record', uuid: IDS.sourceId, sha256: CONTRACT } },
      { ...validInput(), sourceRef: { namespace: 'source_record', uuid: null, sha256: CONTRACT.toUpperCase() } },
      { ...personal, childDsrSubjectType: null },
      { ...personal, childDsrSubjectId: null },
      { ...validInput(), childDsrSubjectType: 'person', childDsrSubjectId: IDS.sourceId },
      { ...validInput(), childSubjectType: 'confusable＿namespace' },
    ];
    for (const candidate of invalid) {
      for (const method of ['appendChildRelationV1', 'attestChildRelationV1'] as const) {
        const database = transaction(resultRow(method === 'attestChildRelationV1'));
        await expect(repository[method](database.value, candidate))
          .rejects.toThrow(module.GOVERNED_SUBJECT_RELATION_INVALID);
        expect(database.queryRaw).not.toHaveBeenCalled();
      }
    }
  });

  it('maps every invalid canonical root field to the operation-subject error before SQL', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const roots = [
      { ...validInput(), rootSubjectType: 'other' },
      { ...validInput(), rootSubjectId: IDS.childId },
      { ...validInput(), rootDataClass: 'PERSONAL' },
      { ...validInput(), rootDsrSubjectType: 'person' },
      { ...validInput(), rootDsrSubjectId: IDS.sourceId },
    ];
    for (const input of roots) {
      for (const method of ['appendChildRelationV1', 'attestChildRelationV1'] as const) {
        const database = transaction(resultRow(method === 'attestChildRelationV1'));
        await expect(repository[method](database.value, input))
          .rejects.toThrow(module.GOVERNED_OPERATION_SUBJECT_INVALID);
        expect(database.queryRaw).not.toHaveBeenCalled();
      }
    }
  });

  it('accepts the PERSONAL DSR and SHA-source union without changing SQL order', async () => {
    const module = await loadRepository();
    const input = {
      ...validInput(),
      parentGovernedSubjectId: IDS.operationSubjectId,
      childDataClass: 'PERSONAL',
      childDsrSubjectType: 'person',
      childDsrSubjectId: '61000000-0000-4000-8000-000000000099',
      relationKind: 'DERIVED_FROM',
      sourceRef: { namespace: 'source_digest', uuid: null, sha256: CONTRACT },
    };
    for (const [method, replay] of [
      ['appendChildRelationV1', false],
      ['attestChildRelationV1', true],
    ] as const) {
      const database = transaction(resultRow(replay));
      await new module.GovernedSubjectRelationRepository()[method](database.value, input);
      assertSingleSelect(database, method === 'appendChildRelationV1' ? APPEND : ATTEST);
      expect(capturedQuery(database.queryRaw).values).toEqual(expectedValues(input));
    }
  });

  it('rejects zero/multi/open/malformed result rows and opposite replay semantics', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const accessor = resultRow(false) as Record<string, unknown>;
    Object.defineProperty(accessor, 'relation_id', {
      enumerable: true,
      get: () => IDS.relationId,
    });
    const symbol = Object.assign(resultRow(false), { [Symbol('hidden')]: true });
    const { relation_id: _removed, ...missingRelationId } = resultRow(false);
    const appendRows = [
      [],
      [resultRow(false), resultRow(false)],
      [missingRelationId],
      [{ ...resultRow(false), extra: true }],
      [new Proxy(resultRow(false), {})],
      [accessor],
      [symbol],
      [{ ...resultRow(false), operation_subject_id: 'not-a-uuid' }],
      [{ ...resultRow(false), parent_subject_id: 'not-a-uuid' }],
      [{ ...resultRow(false), child_subject_id: 'not-a-uuid' }],
      [{ ...resultRow(false), relation_id: 'not-a-uuid' }],
      [{ ...resultRow(false), replay: 'false' }],
    ];
    for (const rows of appendRows) {
      await expect(repository.appendChildRelationV1(transactionRows(rows).value, validInput()))
        .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    }
    await expect(repository.attestChildRelationV1(
      transactionRows([resultRow(false)]).value,
      validInput(),
    )).rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    for (const rows of [
      [],
      [resultRow(true), resultRow(true)],
      [{ ...resultRow(true), extra: true }],
      [{ ...resultRow(true), relation_id: 'not-a-uuid' }],
      [{ ...resultRow(true), replay: 1 }],
    ]) {
      await expect(repository.attestChildRelationV1(transactionRows(rows).value, validInput()))
        .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    }
  });

  it('snapshots the complete input before awaiting SQL to close mutation TOCTOU', async () => {
    const module = await loadRepository();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let captured: { strings: readonly string[]; values: readonly unknown[] } | undefined;
    const queryRaw = vi.fn(async (query: typeof captured) => {
      captured = query;
      await gate;
      return [resultRow(false)];
    });
    const database = {
      value: {
        $queryRaw: queryRaw,
        $executeRaw: vi.fn(),
        $queryRawUnsafe: vi.fn(),
        $executeRawUnsafe: vi.fn(),
      },
    };
    const input = validInput();
    const original = expectedValues();
    const pending = new module.GovernedSubjectRelationRepository()
      .appendChildRelationV1(database.value, input);
    input.childSubjectId = '60000000-0000-4000-8000-000000000099';
    input.sourceRef.uuid = '90000000-0000-4000-8000-000000000099';
    input.relationKey = 'record:mutated';
    release();
    await expect(pending).resolves.toMatchObject({ replay: false });
    expect(captured?.values).toEqual(original);
  });

  it('maps database details to stable non-leaking append and attest errors', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    for (const code of STABLE_ERRORS) {
      expect(module[code]).toBe(code);
      for (const method of ['appendChildRelationV1', 'attestChildRelationV1'] as const) {
        await expect(repository[method](transaction(databaseMarker(code)).value, validInput()))
          .rejects.toThrow(code);
      }
    }
    for (const message of [
      `DETAIL: ERROR: ${module.GOVERNED_SUBJECT_TOMBSTONED}`,
      `ERROR: prefix ${module.GOVERNED_SUBJECT_TOMBSTONED}`,
      `ERROR: ${module.GOVERNED_SUBJECT_TOMBSTONED} suffix`,
      `ERROR: ${module.GOVERNED_SUBJECT_TOMBSTONED}\nERROR: ${module.GOVERNED_SUBJECT_RELATION_INVALID}`,
    ]) {
      const marker = new Prisma.PrismaClientKnownRequestError('redacted', {
        code: 'P2010', clientVersion: 'task2-test',
        meta: { code: 'P0001', message },
      });
      await expect(repository.appendChildRelationV1(transaction(marker).value, validInput()))
        .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    }
    const spoofed = new Error(`ERROR: ${module.GOVERNED_SUBJECT_TOMBSTONED}`);
    await expect(repository.appendChildRelationV1(transaction(spoofed).value, validInput()))
      .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    const secret = new Error('private SQL row secret@example.test token');
    await expect(repository.attestChildRelationV1(transaction(secret).value, validInput()))
      .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    await expect(repository.appendChildRelationV1(transaction(secret).value, validInput()))
      .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    await expect(repository.appendChildRelationV1(transaction(secret).value, validInput()))
      .rejects.not.toThrow(/secret@example|private SQL|token/iu);
  });

  it('reads Prisma markers only through own data descriptors and rejects hostile reflection', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const stable = module.GOVERNED_SUBJECT_TOMBSTONED;
    const hostilePayload = 'private-marker-payload@example.test';
    const marker = () => databaseMarker(stable);
    const accessor = (level: 'code' | 'meta' | 'meta.code' | 'meta.message') => {
      const error = marker();
      if (level === 'code' || level === 'meta') {
        Object.defineProperty(error, level, {
          configurable: true, enumerable: true,
          get: () => { throw new Error(hostilePayload); },
        });
      } else {
        const meta = { code: 'P0001', message: `ERROR: ${stable}` };
        Object.defineProperty(meta, level.slice(5), {
          configurable: true, enumerable: true,
          get: () => { throw new Error(hostilePayload); },
        });
        Object.defineProperty(error, 'meta', {
          configurable: true, enumerable: true, value: meta,
        });
      }
      return error;
    };
    const proxyError = new Proxy(marker(), {});
    const proxyMeta = marker();
    Object.defineProperty(proxyMeta, 'meta', {
      configurable: true, enumerable: true,
      value: new Proxy({ code: 'P0001', message: `ERROR: ${stable}` }, {}),
    });
    const secretData = marker();
    Object.defineProperty(secretData, 'meta', {
      configurable: true, enumerable: true,
      value: { code: 'P0001', message: `ERROR: ${stable} ${hostilePayload}` },
    });
    const hostile = [
      accessor('code'), accessor('meta'), accessor('meta.code'), accessor('meta.message'),
      proxyError, proxyMeta, secretData,
    ];
    for (const error of hostile) {
      for (const method of ['appendChildRelationV1', 'attestChildRelationV1'] as const) {
        const failure = repository[method](transactionRows(error).value, validInput());
        await expect(failure).rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
        await expect(failure).rejects.not.toThrow(/private-marker|payload@example/iu);
      }
    }
  });

  it('mutation vectors prove closed-object validation rejects every reflective bypass', () => {
    const keys = Object.keys(validInput());
    expect(exactClosed(validInput(), keys)).toBe(true);
    expect(exactClosed({ ...validInput(), extra: true }, keys)).toBe(false);
    expect(exactClosed(new Proxy(validInput(), {}), keys)).toBe(false);
    const symbol = Object.assign(validInput(), { [Symbol('x')]: true });
    expect(exactClosed(symbol, keys)).toBe(false);
    const accessor = validInput() as Record<string, unknown>;
    Object.defineProperty(accessor, 'workspaceId', { enumerable: true, get: () => IDS.workspaceId });
    expect(exactClosed(accessor, keys)).toBe(false);
  });

  it('mutation vectors require one exact public 24-placeholder SELECT and no trailing SQL', () => {
    const expected = `SELECT * FROM public.${APPEND}(${SQL_CASTS.map((cast) => `?::${cast}`).join(',')});`;
    const query = (sql: string, valueCount = 24) => ({
      strings: sql.split('?'),
      values: Array.from({ length: valueCount }, (_, index) => index),
    });
    expect(() => validateTaggedSelect(query(expected), APPEND)).not.toThrow();
    expect(() => validateTaggedSelect(query(expected.replace('public.', '')), APPEND))
      .toThrow('INVALID_TAGGED_SELECT_SHAPE');
    expect(() => validateTaggedSelect(query(`${expected} SELECT 1`), APPEND))
      .toThrow('INVALID_TAGGED_SELECT_SHAPE');
    expect(() => validateTaggedSelect(query(`${expected} -- trailing comment`), APPEND))
      .toThrow('INVALID_TAGGED_SELECT_SHAPE');
    expect(() => validateTaggedSelect(
      query(expected.replace(');', ',?::uuid);'), 25),
      APPEND,
    ))
      .toThrow('INVALID_TAGGED_SELECT_ARITY');
  });
});
