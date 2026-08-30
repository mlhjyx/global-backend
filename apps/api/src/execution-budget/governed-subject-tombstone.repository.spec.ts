import { readFile } from 'node:fs/promises';
import { types as nodeUtilTypes } from 'node:util';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

const repositoryUrl = new URL('./governed-subject-relation.repository.ts', import.meta.url);
const typesUrl = new URL('./governed-subject-relation.types.ts', import.meta.url);
const FUNCTION = 'tombstone_workspace_governed_subject_v1';
const IDS = Object.freeze({
  workspace: '10000000-0000-4000-8000-000000000001',
  subject: '20000000-0000-4000-8000-000000000001',
  request: '30000000-0000-4000-8000-000000000001',
  audit: '40000000-0000-4000-8000-000000000001',
});
const OUTCOMES = [
  'FENCE_CREATED', 'REPLAYED', 'AUDIT_APPENDED_WITH_EXISTING_FENCE',
] as const;

type RepositoryModule = {
  GovernedSubjectRelationRepository: new () => {
    tombstoneSubjectV1(transaction: unknown, input: unknown): Promise<unknown>;
  };
  GOVERNED_SUBJECT_INVALID: string;
  GOVERNED_SUBJECT_RELATION_CONFLICT: string;
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE: string;
};

function input() {
  return {
    workspaceId: IDS.workspace,
    governedSubjectId: IDS.subject,
    deletionRequestId: IDS.request,
  };
}

function row(outcome: (typeof OUTCOMES)[number] = 'FENCE_CREATED') {
  return {
    governed_subject_id: IDS.subject,
    tombstoned_at: new Date('2026-08-30T00:00:00.000Z'),
    audit_id: IDS.audit,
    outcome,
  };
}

async function load(): Promise<RepositoryModule> {
  const module = await import(repositoryUrl.href) as Partial<RepositoryModule>;
  if (typeof module.GovernedSubjectRelationRepository !== 'function') {
    throw new Error('GOVERNED_SUBJECT_TOMBSTONE_REPOSITORY_MISSING');
  }
  const instance = new module.GovernedSubjectRelationRepository();
  if (typeof instance.tombstoneSubjectV1 !== 'function') {
    throw new Error('GOVERNED_SUBJECT_TOMBSTONE_REPOSITORY_MISSING');
  }
  return module as RepositoryModule;
}

function transaction(result: unknown) {
  const queryRaw = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const executeRaw = vi.fn();
  const queryRawUnsafe = vi.fn();
  const executeRawUnsafe = vi.fn();
  return {
    value: { $queryRaw: queryRaw, $executeRaw: executeRaw, $queryRawUnsafe: queryRawUnsafe,
      $executeRawUnsafe: executeRawUnsafe },
    queryRaw, executeRaw, queryRawUnsafe, executeRawUnsafe,
  };
}

function exactClosed(value: unknown, keys: readonly string[]): boolean {
  try {
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every((key) =>
      typeof key === 'string' && keys.includes(key) &&
      descriptors[key]?.enumerable === true && 'value' in descriptors[key]);
  } catch {
    return false;
  }
}

function marker(message: string) {
  return new Prisma.PrismaClientKnownRequestError('redacted', {
    code: 'P2010', clientVersion: 'task3-red', meta: { code: 'P0001', message },
  });
}

describe('GovernedSubjectRelationRepository Task 3 tombstone contract', () => {
  it('declares the exact closed immutable tombstone input and result types', async () => {
    const source = await readFile(typesUrl, 'utf8');
    const body = (name: string) => new RegExp(`export interface ${name} \\{([^]*?)\\n\\}`, 'u')
      .exec(source)?.[1]?.replace(/\s+/gu, ' ').trim();
    expect(body('GovernedSubjectTombstoneInput')).toBe(
      'readonly workspaceId: string; readonly governedSubjectId: string; readonly deletionRequestId: string;',
    );
    expect(body('GovernedSubjectTombstoneResult')).toBe(
      'readonly governedSubjectId: string; readonly tombstonedAt: string; readonly auditId: string; readonly outcome: GovernedSubjectTombstoneOutcome;',
    );
    expect(source).toMatch(/export type GovernedSubjectTombstoneOutcome\s*=\s*'FENCE_CREATED'\s*\|\s*'REPLAYED'\s*\|\s*'AUDIT_APPENDED_WITH_EXISTING_FENCE';/u);
  });

  it('mutation-proves closed input and result shapes reject reflective bypasses', () => {
    const inputKeys = ['workspaceId', 'governedSubjectId', 'deletionRequestId'];
    const resultKeys = ['governedSubjectId', 'tombstonedAt', 'auditId', 'outcome'];
    expect(exactClosed(input(), inputKeys)).toBe(true);
    expect(exactClosed({ ...input(), extra: true }, inputKeys)).toBe(false);
    expect(exactClosed(new Proxy(input(), {}), inputKeys)).toBe(false);
    const accessor = input() as Record<string, unknown>;
    Object.defineProperty(accessor, 'workspaceId', { enumerable: true, get: () => IDS.workspace });
    expect(exactClosed(accessor, inputKeys)).toBe(false);
    expect(exactClosed({ ...input(), [Symbol('x')]: true }, inputKeys)).toBe(false);
    expect(exactClosed({
      governedSubjectId: IDS.subject, tombstonedAt: '2026-08-30T00:00:00.000Z', auditId: IDS.audit,
      outcome: 'FENCE_CREATED',
    }, resultKeys)).toBe(true);
  });

  it('executes one exact public three-parameter tagged SELECT and freezes the result', async () => {
    const module = await load();
    const databaseRow = row();
    const database = transaction([databaseRow]);
    const result = await new module.GovernedSubjectRelationRepository()
      .tombstoneSubjectV1(database.value, input());
    expect(result).toEqual({
      governedSubjectId: IDS.subject,
      tombstonedAt: '2026-08-30T00:00:00.000Z',
      auditId: IDS.audit,
      outcome: 'FENCE_CREATED',
    });
    expect(Object.isFrozen(result)).toBe(true);
    databaseRow.tombstoned_at.setUTCFullYear(2037);
    expect(result).toMatchObject({ tombstonedAt: '2026-08-30T00:00:00.000Z' });
    const query = database.queryRaw.mock.calls[0]?.[0] as {
      strings: readonly string[]; values: readonly unknown[];
    };
    expect(query.values).toEqual([IDS.workspace, IDS.subject, IDS.request]);
    expect(database.queryRaw).toHaveBeenCalledOnce();
    expect(database.executeRaw).not.toHaveBeenCalled();
    expect(database.queryRawUnsafe).not.toHaveBeenCalled();
    expect(database.executeRawUnsafe).not.toHaveBeenCalled();
    expect(query.strings).toHaveLength(4);
    expect(query.strings.join('?').replace(/\s+/gu, ' ').trim()).toBe(
      `SELECT * FROM public.${FUNCTION}(?::uuid,?::uuid,?::uuid)`,
    );
  });

  it('accepts only the three exact outcomes and one closed typed row', async () => {
    const module = await load();
    const repository = new module.GovernedSubjectRelationRepository();
    for (const outcome of OUTCOMES) {
      await expect(repository.tombstoneSubjectV1(transaction([row(outcome)]).value, input()))
        .resolves.toMatchObject({ outcome });
    }
    class DateSubclass extends Date {}
    const accessor = row() as Record<string, unknown>;
    Object.defineProperty(accessor, 'outcome', { enumerable: true, get: () => 'FENCE_CREATED' });
    const symbol = { ...row(), [Symbol('x')]: true };
    const invalidDate = new Date(Number.NaN);
    for (const invalid of [[], [row(), row()], [{ ...row(), extra: true }],
      [{ governed_subject_id: IDS.subject, tombstoned_at: row().tombstoned_at,
        audit_id: IDS.audit }], [{ ...row(), outcome: 'CREATED' }],
      [{ ...row(), governed_subject_id: 'bad' }], [{ ...row(), audit_id: 'bad' }],
      [{ ...row(), tombstoned_at: 'not-date' }], [{ ...row(), tombstoned_at: invalidDate }],
      [{ ...row(), tombstoned_at: new DateSubclass() }],
      [{ ...row(), tombstoned_at: new Proxy(row().tombstoned_at, {}) }],
      [new Proxy(row(), {})], [accessor], [symbol]]) {
      await expect(repository.tombstoneSubjectV1(transaction(invalid).value, input()))
        .rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    }
  });

  it('snapshots input and trusted Date before awaiting SQL to close mutation TOCTOU', async () => {
    const module = await load();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const database = transaction([row()]);
    database.queryRaw.mockImplementationOnce(async () => {
      await gate;
      return [row()];
    });
    const value = input();
    const pending = new module.GovernedSubjectRelationRepository()
      .tombstoneSubjectV1(database.value, value);
    value.workspaceId = '10000000-0000-4000-8000-000000000099';
    value.governedSubjectId = '20000000-0000-4000-8000-000000000099';
    release();
    await expect(pending).resolves.toMatchObject({
      governedSubjectId: IDS.subject, tombstonedAt: '2026-08-30T00:00:00.000Z',
    });
    const query = database.queryRaw.mock.calls[0]?.[0] as { values: readonly unknown[] };
    expect(query.values).toEqual([IDS.workspace, IDS.subject, IDS.request]);
  });

  it('rejects invalid UUIDs, extras, accessors, symbols and proxies before SQL', async () => {
    const module = await load();
    const repository = new module.GovernedSubjectRelationRepository();
    const vectors: unknown[] = [
      { ...input(), workspaceId: 'bad' }, { ...input(), governedSubjectId: 'bad' },
      { ...input(), deletionRequestId: 'bad' }, { ...input(), extra: true },
      new Proxy(input(), {}), { ...input(), [Symbol('x')]: true },
    ];
    const accessor = input() as Record<string, unknown>;
    Object.defineProperty(accessor, 'deletionRequestId', {
      enumerable: true, get: () => IDS.request,
    });
    vectors.push(accessor);
    for (const value of vectors) {
      const database = transaction([row()]);
      await expect(repository.tombstoneSubjectV1(database.value, value))
        .rejects.toThrow(module.GOVERNED_SUBJECT_INVALID);
      expect(database.queryRaw).not.toHaveBeenCalled();
    }
  });

  it('maps only exact descriptor-safe database markers without leaking hostile content', async () => {
    const module = await load();
    const repository = new module.GovernedSubjectRelationRepository();
    for (const code of [module.GOVERNED_SUBJECT_INVALID, module.GOVERNED_SUBJECT_RELATION_CONFLICT]) {
      await expect(repository.tombstoneSubjectV1(
        transaction(marker(`ERROR: ${code}`)).value, input(),
      )).rejects.toThrow(code);
    }
    const payload = 'hostile-marker-payload@example.test';
    const accessor = marker(`ERROR: ${module.GOVERNED_SUBJECT_INVALID}`);
    Object.defineProperty(accessor, 'meta', {
      configurable: true, enumerable: true,
      get: () => { throw new Error(payload); },
    });
    for (const error of [
      new Proxy(marker(`ERROR: ${module.GOVERNED_SUBJECT_INVALID}`), {}), accessor,
      marker(`ERROR: ${module.GOVERNED_SUBJECT_INVALID} ${payload}`), new Error(payload),
    ]) {
      const failure = repository.tombstoneSubjectV1(transaction(error).value, input());
      await expect(failure).rejects.toThrow(module.GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
      await expect(failure).rejects.not.toThrow(/hostile-marker|payload@example/iu);
    }
  });
});
