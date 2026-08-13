import { Prisma } from '@prisma/client';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { encryptArgs, decryptResult, piiExtension, piiSpecFor } from './pii-crypto.extension';
import { encryptPii, isEncryptedPii } from './pii-crypto';

const TEST_KEY = 'b'.repeat(64);
const CONTACT = piiSpecFor('CanonicalContact')!;
const POINT = piiSpecFor('ContactPoint')!;

describe('pii-crypto.extension 入参加密', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });

  it('CanonicalContact.create：data.fullName 加密', () => {
    const args = { data: { workspaceId: 'w', fullName: 'Jane Doe', dedupeKey: 'k' } } as Record<string, unknown>;
    encryptArgs('create', args, CONTACT);
    expect(isEncryptedPii((args.data as Record<string, unknown>).fullName as string)).toBe(true);
  });

  it('ContactPoint.upsert：where 复合键 + create 的 value（email）都加密，且与 encryptPii 一致', () => {
    const args = {
      where: { contactId_type_value: { contactId: 'c', type: 'email', value: 'a@b.com' } },
      create: { workspaceId: 'w', contactId: 'c', type: 'email', value: 'a@b.com' },
      update: {},
    } as Record<string, unknown>;
    encryptArgs('upsert', args, POINT);
    const w = (args.where as Record<string, Record<string, unknown>>).contactId_type_value;
    const c = args.create as Record<string, unknown>;
    expect(w.value).toBe(encryptPii('a@b.com'));
    expect(c.value).toBe(encryptPii('a@b.com'));
    // 确定性 → where 与 create 密文一致，唯一键/幂等成立
    expect(w.value).toBe(c.value);
  });

  it('ContactPoint external_id 不加密（非 PII 类型）', () => {
    const args = {
      where: { contactId_type_value: { contactId: 'c', type: 'external_id', value: 'ch:12345' } },
      create: { contactId: 'c', type: 'external_id', value: 'ch:12345' },
      update: {},
    } as Record<string, unknown>;
    encryptArgs('upsert', args, POINT);
    expect((args.create as Record<string, unknown>).value).toBe('ch:12345');
  });
});

describe('pii-crypto.extension 结果解密', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });

  it('数组结果：每行 fullName 解密，legacy 明文不动', () => {
    const rows = [{ id: '1', fullName: encryptPii('Jane Doe') }, { id: '2', fullName: 'Legacy Plain' }];
    decryptResult(rows, CONTACT);
    expect(rows[0].fullName).toBe('Jane Doe');
    expect(rows[1].fullName).toBe('Legacy Plain');
  });

  it('单对象结果：value 解密', () => {
    const row = { id: 'p', type: 'email', value: encryptPii('x@y.com') };
    decryptResult(row, POINT);
    expect(row.value).toBe('x@y.com');
  });

  it('null 结果不抛', () => {
    expect(() => decryptResult(null, CONTACT)).not.toThrow();
  });
});

describe('pii-crypto.extension operation coverage', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
    vi.restoreAllMocks();
  });

  it('covers bulk create, update, lookup, default, and missing args', () => {
    const many = { data: [{ fullName: 'One' }, { fullName: 'Two' }] } as Record<string, unknown>;
    encryptArgs('createMany', many, CONTACT);
    expect((many.data as Array<{ fullName: string }>).every((row) => isEncryptedPii(row.fullName))).toBe(true);

    const one = { data: { fullName: 'Three' } } as Record<string, unknown>;
    encryptArgs('createManyAndReturn', one, CONTACT);
    expect(isEncryptedPii((one.data as { fullName: string }).fullName)).toBe(true);

    const update = {
      data: { value: 'a@b.com', type: 'email' },
      where: { value: 'a@b.com', type: 'email' },
    } as Record<string, unknown>;
    encryptArgs('updateMany', update, POINT);
    expect(isEncryptedPii((update.data as { value: string }).value)).toBe(true);
    expect(isEncryptedPii((update.where as { value: string }).value)).toBe(true);

    const lookup = {
      where: {
        contactId_type_value: { contactId: 'c', type: 'phone', value: '+49 30 12345678' },
      },
    } as Record<string, unknown>;
    encryptArgs('findUniqueOrThrow', lookup, POINT);
    expect(
      isEncryptedPii(
        (lookup.where as { contactId_type_value: { value: string } }).contactId_type_value.value,
      ),
    ).toBe(true);
    expect(() => encryptArgs('aggregate', {}, CONTACT)).not.toThrow();
    expect(() => encryptArgs('create', undefined, CONTACT)).not.toThrow();
  });

  it('covers every read/delete where operation and skips invalid record shapes', () => {
    for (const operation of [
      'findUnique',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'delete',
      'deleteMany',
    ]) {
      const args = { where: { fullName: 'Jane Doe' } } as Record<string, unknown>;
      encryptArgs(operation, args, CONTACT);
      expect(isEncryptedPii((args.where as { fullName: string }).fullName)).toBe(true);
    }

    for (const data of [null, { fullName: 42 }]) {
      const args = { data } as Record<string, unknown>;
      encryptArgs('create', args, CONTACT);
    }
    for (const data of [{ value: 'plain' }, { type: 'external_id', value: 'public-id' }]) {
      const args = { data: { ...data } } as Record<string, unknown>;
      encryptArgs('create', args, POINT);
      expect((args.data as { value: string }).value).toBe(data.value);
    }
  });

  it('returns no PII specification for an empty or unknown model', () => {
    expect(piiSpecFor(undefined)).toBeUndefined();
    expect(piiSpecFor('Unknown')).toBeUndefined();
  });
});

function extensionConfig() {
  return (piiExtension as unknown as (client: {
    $extends: (config: unknown) => unknown;
  }) => {
    query: {
      $allModels: {
        $allOperations: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
    client: Record<string, (...args: never[]) => Promise<unknown>>;
  })({ $extends: (config) => config });
}

describe('pii-crypto.extension Prisma wiring', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
    vi.restoreAllMocks();
  });

  it('$allOperations encrypts target models, passes through unknown models, and decrypts nested values', async () => {
    const operation = extensionConfig().query.$allModels.$allOperations;
    const args = { data: { fullName: 'Jane Doe' } };
    const query = vi.fn(async () => ({
      fullName: args.data.fullName,
      contactPoints: [{ type: 'email', value: encryptPii('jane@example.com') }],
    }));
    await expect(
      operation({ model: 'CanonicalContact', operation: 'create', args, query }),
    ).resolves.toEqual({
      fullName: 'Jane Doe',
      contactPoints: [{ type: 'email', value: 'jane@example.com' }],
    });
    expect(isEncryptedPii(query.mock.calls[0][0].data.fullName)).toBe(true);

    const passthrough = vi.fn(async () => ({ id: 'company-1' }));
    await expect(
      operation({ model: 'CanonicalCompany', operation: 'findMany', args: {}, query: passthrough }),
    ).resolves.toEqual({ id: 'company-1' });
  });

  it('withWorkspace sets the RLS context and preserves transaction options', async () => {
    const execute = vi.fn(async () => 1);
    const tx = { $executeRaw: execute };
    const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue({ $transaction: transaction } as never);
    const fn = vi.fn(async () => 'done');
    const method = extensionConfig().client.withWorkspace;
    await expect(method.call({}, 'workspace-1', fn, { timeout: 1234 })).resolves.toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(tx);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 1234 });
  });

  it('connects and disconnects through the extended Nest lifecycle', async () => {
    const context = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
    };
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue(context as never);
    const client = extensionConfig().client;
    await client.onModuleInit.call({});
    await client.onModuleDestroy.call({});
    expect(context.$connect).toHaveBeenCalledOnce();
    expect(context.$disconnect).toHaveBeenCalledOnce();
  });
});
