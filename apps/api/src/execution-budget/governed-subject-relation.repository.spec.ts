import { readFile } from 'node:fs/promises';
import { types as nodeUtilTypes } from 'node:util';
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

type RepositoryModule = {
  GovernedSubjectRelationRepository: new () => {
    appendChildRelationV1(transaction: unknown, input: unknown): Promise<unknown>;
    attestChildRelationV1(transaction: unknown, input: unknown): Promise<unknown>;
  };
  GOVERNED_SUBJECT_RELATION_INVALID: string;
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE: string;
};

function validInput() {
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

function expectedValues(): unknown[] {
  const input = validInput();
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

function transaction(row: unknown | Error) {
  const queryRaw = vi.fn(async () => {
    if (row instanceof Error) throw row;
    return [row];
  });
  return { value: { $queryRaw: queryRaw }, queryRaw };
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
      'GOVERNED_SUBJECT_RELATION_INVALID',
      'GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE',
    ]) expect(`${types}\n${repository}`).toContain(token);
  });

  it('binds append to the exact 24 SQL values and returns one frozen closed result', async () => {
    const module = await loadRepository();
    const database = transaction(resultRow(false));
    const result = await new module.GovernedSubjectRelationRepository()
      .appendChildRelationV1(database.value, validInput());
    const query = capturedQuery(database.queryRaw);
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
  });

  it('binds attest to the identical 24 SQL values and requires replay=true', async () => {
    const module = await loadRepository();
    const database = transaction(resultRow(true));
    const result = await new module.GovernedSubjectRelationRepository()
      .attestChildRelationV1(database.value, validInput());
    const query = capturedQuery(database.queryRaw);
    expect(query.strings.join('')).toContain(ATTEST);
    expect(query.values).toEqual(expectedValues());
    expect(result).toMatchObject({ relationId: IDS.relationId, replay: true });
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
      const database = transaction(resultRow(false));
      await expect(repository.appendChildRelationV1(database.value, candidate))
        .rejects.toThrow(module.GOVERNED_SUBJECT_RELATION_INVALID);
      expect(database.queryRaw).not.toHaveBeenCalled();
    }
  });

  it('maps database details to stable non-leaking append and attest errors', async () => {
    const module = await loadRepository();
    const repository = new module.GovernedSubjectRelationRepository();
    const secret = new Error('private SQL row secret@example.test token');
    await expect(repository.attestChildRelationV1(transaction(secret).value, validInput()))
      .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    await expect(repository.appendChildRelationV1(transaction(secret).value, validInput()))
      .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    await expect(repository.appendChildRelationV1(transaction(secret).value, validInput()))
      .rejects.not.toThrow(/secret@example|private SQL|token/iu);
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
});
