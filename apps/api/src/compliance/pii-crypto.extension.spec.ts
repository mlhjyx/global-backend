import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptArgs,
  decryptResult,
  piiSpecFor,
  runWithWorkspacePiiContext,
} from './pii-crypto.extension';
import { encryptPii, isEncryptedPii, PII_PURPOSE } from './pii-crypto';

const KEY_1 = 'b'.repeat(64);
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';
const CONTACT = piiSpecFor('CanonicalContact')!;
const POINT = piiSpecFor('ContactPoint')!;

describe('pii-crypto.extension 入参加密', () => {
  let prevKeyring: string | undefined;

  beforeEach(() => {
    prevKeyring = process.env.PII_KEYRING_JSON;
    process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1 } });
  });

  afterEach(() => {
    if (prevKeyring === undefined) delete process.env.PII_KEYRING_JSON;
    else process.env.PII_KEYRING_JSON = prevKeyring;
  });

  it('CanonicalContact.create：data.fullName 加密且绑定 data.workspaceId', () => {
    const args = { data: { workspaceId: WS_A, fullName: 'Jane Doe', dedupeKey: 'k' } } as Record<string, unknown>;
    encryptArgs('create', args, CONTACT);
    const encrypted = (args.data as Record<string, unknown>).fullName as string;
    expect(isEncryptedPii(encrypted)).toBe(true);
    expect(encrypted).toBe(
      encryptPii('Jane Doe', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME }),
    );
  });

  it('ContactPoint.upsert：where 复合键 + create 的 value（email）都加密，且与 encryptPii 一致', () => {
    const args = {
      where: { contactId_type_value: { contactId: 'c', type: 'email', value: 'a@b.com' } },
      create: { workspaceId: WS_A, contactId: 'c', type: 'email', value: 'a@b.com' },
      update: {},
    } as Record<string, unknown>;
    encryptArgs('upsert', args, POINT);
    const w = (args.where as Record<string, Record<string, unknown>>).contactId_type_value;
    const c = args.create as Record<string, unknown>;
    const expected = encryptPii('a@b.com', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE });
    expect(w.value).toBe(expected);
    expect(c.value).toBe(expected);
  });

  it('ALS 上下文传播：findUnique { id } / update { where: { id } } 无显式 workspaceId 时走 ALS', () => {
    const args = { where: { fullName: 'Jane Doe' } } as Record<string, unknown>;
    runWithWorkspacePiiContext(WS_A, () => {
      encryptArgs('findMany', args, CONTACT);
    });
    expect((args.where as Record<string, unknown>).fullName).toBe(
      encryptPii('Jane Doe', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME }),
    );
  });

  it('ALS 与显式 workspaceId 冲突时 fail-closed 抛错；缺失 workspaceId 时 fail-closed 抛错', () => {
    expect(() =>
      runWithWorkspacePiiContext(WS_A, () => {
        encryptArgs('create', { data: { workspaceId: WS_B, fullName: 'Jane Doe' } }, CONTACT);
      }),
    ).toThrow(/PII_WORKSPACE_CONTEXT_MISMATCH/);

    expect(() =>
      encryptArgs('create', { data: { fullName: 'Jane Doe' } }, CONTACT),
    ).toThrow(/PII_WORKSPACE_REQUIRED/);
  });

  it('ContactPoint external_id 不加密（非 PII 类型）', () => {
    const args = {
      where: { contactId_type_value: { contactId: 'c', type: 'external_id', value: 'ch:12345' } },
      create: { workspaceId: WS_A, contactId: 'c', type: 'external_id', value: 'ch:12345' },
      update: {},
    } as Record<string, unknown>;
    encryptArgs('upsert', args, POINT);
    expect((args.create as Record<string, unknown>).value).toBe('ch:12345');
  });
});

describe('pii-crypto.extension 结果解密', () => {
  let prevKeyring: string | undefined;

  beforeEach(() => {
    prevKeyring = process.env.PII_KEYRING_JSON;
    process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1 } });
  });

  afterEach(() => {
    if (prevKeyring === undefined) delete process.env.PII_KEYRING_JSON;
    else process.env.PII_KEYRING_JSON = prevKeyring;
  });

  it('数组结果：每行 fullName 解密，默认拒绝明文回退，仅迁移开关开启时放行遗留明文；跨租户密文必抛', () => {
    const ctA = encryptPii('Jane Doe', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME });
    const encryptedRows = [{ id: '1', workspaceId: WS_A, fullName: ctA }];
    decryptResult(encryptedRows, CONTACT);
    expect(encryptedRows[0].fullName).toBe('Jane Doe');

    expect(() =>
      decryptResult([{ id: '2', workspaceId: WS_A, fullName: 'Legacy Plain' }], CONTACT),
    ).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);

    expect(() =>
      decryptResult([{ id: '2p', workspaceId: WS_A, type: 'email', value: 'plain@example.test' }], POINT),
    ).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);

    const externalRow = [{ id: '3p', workspaceId: WS_A, type: 'external_id', value: 'ch:12345' }];
    decryptResult(externalRow, POINT);
    expect(externalRow[0].value).toBe('ch:12345');

    const prevAllow = process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
    try {
      process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = 'true';
      const legacyRows = [
        { id: '1', workspaceId: WS_A, fullName: ctA },
        { id: '2', workspaceId: WS_A, fullName: 'Legacy Plain' },
      ];
      decryptResult(legacyRows, CONTACT);
      expect(legacyRows[0].fullName).toBe('Jane Doe');
      expect(legacyRows[1].fullName).toBe('Legacy Plain');
    } finally {
      if (prevAllow === undefined) delete process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
      else process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = prevAllow;
    }

    expect(() =>
      decryptResult([{ id: '3', workspaceId: WS_B, fullName: ctA }], CONTACT),
    ).toThrow();
  });

  it('单对象结果：value 解密（支持 row.workspaceId 或 ALS）', () => {
    const row = {
      id: 'p',
      type: 'email',
      value: encryptPii('x@y.com', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    };
    runWithWorkspacePiiContext(WS_A, () => {
      decryptResult(row, POINT);
    });
    expect(row.value).toBe('x@y.com');
  });

  it('null 结果不抛', () => {
    expect(() => decryptResult(null, CONTACT)).not.toThrow();
  });
});

describe('pii-crypto.extension 数据库 principal 读取', () => {
  it('casts PostgreSQL role memberships to Prisma-decodable text[]', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'pii-crypto.extension.ts'),
      'utf8',
    );
    expect(source).toContain('session_user::text AS "sessionUser"');
    expect(source).toContain('current_user::text AS "currentUser"');
    expect(source).toContain(
      'array_agg(granted.rolname::text ORDER BY granted.rolname)',
    );
    expect(source).toMatch(
      /GROUP BY principal\.oid,\s+principal\.rolsuper,\s+principal\.rolbypassrls,\s+principal\.rolcreatedb,\s+principal\.rolcreaterole,\s+principal\.rolreplication,\s+principal\.rolinherit/u,
    );
  });
});

describe('pii-crypto.extension lookup and bulk write preservation', () => {
  let prevKeyring: string | undefined;

  beforeEach(() => {
    prevKeyring = process.env.PII_KEYRING_JSON;
    process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: 'k1', keys: { k1: KEY_1 } });
  });

  afterEach(() => {
    if (prevKeyring === undefined) delete process.env.PII_KEYRING_JSON;
    else process.env.PII_KEYRING_JSON = prevKeyring;
  });

  it.each(['createMany', 'createManyAndReturn'])('%s encrypts both bulk rows and a single record', (operation) => {
    const rows = {
      data: [
        { workspaceId: WS_A, type: 'email', value: 'one@example.test' },
        { workspaceId: WS_A, type: 'external_id', value: 'external-1' },
      ],
    };
    encryptArgs(operation, rows, POINT);
    expect(rows.data[0].value).toBe(
      encryptPii('one@example.test', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    );
    expect(rows.data[1].value).toBe('external-1');
    const single = { data: { workspaceId: WS_A, fullName: 'Synthetic Person' } };
    encryptArgs(operation, single, CONTACT);
    expect(single.data.fullName).toBe(
      encryptPii('Synthetic Person', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME }),
    );
  });

  it.each(['update', 'updateMany'])('%s keeps lookup and replacement encrypted consistently', (operation) => {
    const args = {
      where: { workspaceId: WS_A, type: 'email', value: 'old@example.test' },
      data: { workspaceId: WS_A, type: 'email', value: 'new@example.test' },
    };
    encryptArgs(operation, args, POINT);
    expect(args.where.value).toBe(
      encryptPii('old@example.test', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    );
    expect(args.data.value).toBe(
      encryptPii('new@example.test', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    );
  });

  it.each(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'delete', 'deleteMany'])('%s encrypts a direct name lookup', (operation) => {
    const args = { where: { workspaceId: WS_A, fullName: 'Synthetic Person' } };
    encryptArgs(operation, args, CONTACT);
    expect(args.where.fullName).toBe(
      encryptPii('Synthetic Person', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME }),
    );
  });

  it('keeps non-PII and missing-type lookups unchanged', () => {
    for (const where of [{ type: 'external_id', value: 'external-1' }, { value: 'unclassified' }]) {
      const original = { ...where };
      encryptArgs('findFirst', { where }, POINT);
      expect(where).toEqual(original);
    }
    const args = { data: { value: 'unclassified' } };
    encryptArgs('create', args, POINT);
    expect(args.data.value).toBe('unclassified');
  });

  it('preserves absent optional arguments, non-string fields and unsupported operations', () => {
    expect(() => encryptArgs('findMany', undefined, CONTACT)).not.toThrow();
    expect(() => encryptArgs('create', { data: null }, CONTACT)).not.toThrow();
    expect(() => encryptArgs('findMany', {}, CONTACT)).not.toThrow();
    const args = { data: { fullName: null }, where: { id: 'contact-1' } };
    encryptArgs('update', args, CONTACT);
    expect(args.data.fullName).toBeNull();
    const other = { data: { fullName: 'untouched' } };
    encryptArgs('aggregate', other, CONTACT);
    expect(other.data.fullName).toBe('untouched');
    expect(piiSpecFor(undefined)).toBeUndefined();
    expect(piiSpecFor('UnrelatedModel')).toBeUndefined();
  });
});
