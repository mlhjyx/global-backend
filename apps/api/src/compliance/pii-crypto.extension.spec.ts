import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decryptNestedResult,
  decryptResult,
  encryptArgs,
  encryptFieldEvidenceValue,
  isEncryptedFieldEvidenceValue,
  piiExtension,
  piiSpecFor,
} from './pii-crypto.extension';
import { encryptPii, isEncryptedPii } from './pii-crypto';

const TEST_KEY = 'b'.repeat(64);
const CONTACT = piiSpecFor('CanonicalContact')!;
const POINT = piiSpecFor('ContactPoint')!;
const EVIDENCE = piiSpecFor('FieldEvidence')!;

describe('pii-crypto.extension 入参加密', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.DEPLOYMENT_STAGE;
    delete process.env.NODE_ENV;
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
    vi.restoreAllMocks();
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

  it.each(['amber', 'red'])(
    'FieldEvidence %s：整个 value 经统一 writer 加密为版本化 envelope',
    (dataClass) => {
      const args = {
        data: {
          workspaceId: 'w',
          entityType: 'contact',
          entityId: 'c',
          field: 'email.verification',
          dataClass,
          value: {
            email: 'jane@example.com',
            providerExcerpt: 'RCPT jane@example.com accepted',
          },
        },
      } as Record<string, unknown>;
      encryptArgs('create', args, EVIDENCE);
      const value = (args.data as Record<string, unknown>).value as Record<
        string,
        unknown
      >;
      expect(value.schemaVersion).toBe('field-evidence-pii/v1');
      expect(isEncryptedPii(value.ciphertext as string)).toBe(true);
      expect(JSON.stringify(value)).not.toContain('jane@example.com');
    },
  );

  it('FieldEvidence green：公司事实不加密，保持可查询 provenance', () => {
    const value = { product: 'industrial pump' };
    const args = {
      data: { dataClass: 'green', value },
    } as Record<string, unknown>;
    encryptArgs('create', args, EVIDENCE);
    expect((args.data as Record<string, unknown>).value).toEqual(value);
  });

  it('FieldEvidence contact 缺分级时保守提升为 red 并加密', () => {
    const args = {
      data: {
        entityType: 'contact',
        field: 'identity.merge',
        value: { match_rule: 'external_id' },
      },
    } as Record<string, unknown>;
    encryptArgs('create', args, EVIDENCE);
    const data = args.data as Record<string, unknown>;
    expect(data.dataClass).toBe('red');
    expect(isEncryptedFieldEvidenceValue(data.value)).toBe(true);
  });

  it('canonical JSON 使对象键序稳定，并拒绝非 JSON 数值/类型', () => {
    expect(
      encryptFieldEvidenceValue({ b: [2, true], a: null }).ciphertext,
    ).toBe(encryptFieldEvidenceValue({ a: null, b: [2, true] }).ciphertext);
    expect(() => encryptFieldEvidenceValue({ value: Number.NaN })).toThrow(
      /FIELD_EVIDENCE_JSON_INVALID/,
    );
    expect(() => encryptFieldEvidenceValue(1n)).toThrow(
      /FIELD_EVIDENCE_JSON_INVALID/,
    );
  });

  it('验证 envelope 结构、幂等重放以及 legacy 非 envelope', () => {
    const encrypted = encryptFieldEvidenceValue({ value: 'x' });
    expect(isEncryptedFieldEvidenceValue(encrypted)).toBe(true);
    expect(encryptFieldEvidenceValue(encrypted)).toBe(encrypted);
    expect(isEncryptedFieldEvidenceValue(null)).toBe(false);
    expect(isEncryptedFieldEvidenceValue([])).toBe(false);
    expect(
      isEncryptedFieldEvidenceValue({
        schemaVersion: 'wrong',
        ciphertext: encrypted.ciphertext,
      }),
    ).toBe(false);
    expect(isEncryptedFieldEvidenceValue({ schemaVersion: 'field-evidence-pii/v1' })).toBe(false);
  });

  it('覆盖 createMany/update/find/default/no-args 的统一加密分派', () => {
    const many = {
      data: [
        { fullName: 'One' },
        { fullName: 'Two' },
      ],
    } as Record<string, unknown>;
    encryptArgs('createMany', many, CONTACT);
    expect(
      (many.data as Array<{ fullName: string }>).every((row) =>
        isEncryptedPii(row.fullName),
      ),
    ).toBe(true);

    const one = { data: { fullName: 'Three' } } as Record<string, unknown>;
    encryptArgs('createManyAndReturn', one, CONTACT);
    expect(isEncryptedPii((one.data as { fullName: string }).fullName)).toBe(
      true,
    );

    const update = {
      data: { value: 'a@b.com', type: 'email' },
      where: { value: 'a@b.com', type: 'email' },
    } as Record<string, unknown>;
    encryptArgs('updateMany', update, POINT);
    expect(isEncryptedPii((update.data as { value: string }).value)).toBe(true);
    expect(isEncryptedPii((update.where as { value: string }).value)).toBe(true);

    const lookup = {
      where: {
        contactId_type_value: {
          contactId: 'c',
          type: 'phone',
          value: '+49 30 12345678',
        },
      },
    } as Record<string, unknown>;
    encryptArgs('findMany', lookup, POINT);
    expect(
      isEncryptedPii(
        (
          lookup.where as {
            contactId_type_value: { value: string };
          }
        ).contactId_type_value.value,
      ),
    ).toBe(true);
    expect(() => encryptArgs('aggregate', {}, CONTACT)).not.toThrow();
    expect(() => encryptArgs('create', undefined, CONTACT)).not.toThrow();
  });

  it('跳过非对象、无字符串值、缺 type 与非 PII type', () => {
    const missing = { data: null } as Record<string, unknown>;
    encryptArgs('create', missing, CONTACT);
    const numberValue = { data: { fullName: 42 } } as Record<string, unknown>;
    encryptArgs('create', numberValue, CONTACT);
    expect((numberValue.data as { fullName: number }).fullName).toBe(42);

    for (const data of [
      { value: 'plain' },
      { type: 'external_id', value: 'public-id' },
    ]) {
      const args = { data: { ...data } } as Record<string, unknown>;
      encryptArgs('create', args, POINT);
      expect((args.data as { value: string }).value).toBe(data.value);
    }
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

  it('FieldEvidence 版本化 envelope 解密回原 JSON value', () => {
    const args = {
      data: {
        dataClass: 'red',
        value: { email: 'jane@example.com', nested: { lawfulBasis: 'LIA-1' } },
      },
    } as Record<string, unknown>;
    encryptArgs('create', args, EVIDENCE);
    const row = {
      id: 'e1',
      dataClass: 'red',
      value: (args.data as Record<string, unknown>).value,
    };
    decryptResult(row, EVIDENCE);
    expect(row.value).toEqual({
      email: 'jane@example.com',
      nested: { lawfulBasis: 'LIA-1' },
    });
  });

  it('嵌套 company/contact/contactPoints 结果递归解密', () => {
    const result = {
      contacts: [
        {
          fullName: encryptPii('Jane Doe'),
          contactPoints: [
            { type: 'email', value: encryptPii('jane@example.com') },
          ],
        },
      ],
    };
    decryptNestedResult(result);
    expect(result.contacts[0]).toMatchObject({
      fullName: 'Jane Doe',
      contactPoints: [{ value: 'jane@example.com' }],
    });
    expect(() => decryptNestedResult(null)).not.toThrow();
  });

  it('未知/空 model 无 PII spec', () => {
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
  });

  afterEach(() => {
    delete process.env.DEPLOYMENT_STAGE;
    delete process.env.NODE_ENV;
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
    vi.restoreAllMocks();
  });

  it('$allOperations 加密目标 model、透传未知 model，并解密嵌套结果', async () => {
    const operation = extensionConfig().query.$allModels.$allOperations;
    const args = { data: { fullName: 'Jane Doe' } };
    const query = vi.fn(async () => ({ fullName: args.data.fullName }));
    await expect(
      operation({ model: 'CanonicalContact', operation: 'create', args, query }),
    ).resolves.toEqual({ fullName: 'Jane Doe' });
    expect(isEncryptedPii(query.mock.calls[0][0].data.fullName)).toBe(true);

    const passthrough = vi.fn(async () => ({ id: 'company-1' }));
    await expect(
      operation({ model: 'CanonicalCompany', operation: 'findMany', args: {}, query: passthrough }),
    ).resolves.toEqual({ id: 'company-1' });
  });

  it('withWorkspace sets the RLS context inside the supplied transaction', async () => {
    const execute = vi.fn(async () => 1);
    const tx = { $executeRaw: execute };
    const transaction = vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue({
      $transaction: transaction,
    } as never);
    const fn = vi.fn(async () => 'done');
    const method = extensionConfig().client.withWorkspace;
    await expect(method.call({}, 'workspace-1', fn)).resolves.toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(tx);
  });

  it('development lifecycle connects without privileged-role probing and destroys cleanly', async () => {
    process.env.DEPLOYMENT_STAGE = 'development';
    const context = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(),
    };
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue(context as never);
    const client = extensionConfig().client;
    await client.onModuleInit.call({});
    expect(context.$connect).toHaveBeenCalledTimes(1);
    expect(context.$queryRawUnsafe).not.toHaveBeenCalled();
    await client.onModuleDestroy.call({});
    expect(context.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('pilot lifecycle requires a valid key and safe app role; unsafe role disconnects', async () => {
    process.env.DEPLOYMENT_STAGE = 'pilot';
    const context = {
      $connect: vi.fn(async () => undefined),
      $disconnect: vi.fn(async () => undefined),
      $queryRawUnsafe: vi.fn(async () => [
        {
          roleName: 'app_user',
          superuser: false,
          bypassRls: true,
          databaseOwnerMember: false,
          ownsApplicationRelations: false,
        },
      ]),
    };
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue(context as never);
    await expect(extensionConfig().client.onModuleInit.call({})).rejects.toThrow(
      /APP_DATABASE_ROLE_UNSAFE/,
    );
    expect(context.$disconnect).toHaveBeenCalledTimes(1);

    delete process.env.PII_ENCRYPTION_KEY;
    context.$connect.mockClear();
    await expect(extensionConfig().client.onModuleInit.call({})).rejects.toThrow(
      /PII_ENCRYPTION_KEY_REQUIRED/,
    );
    expect(context.$connect).not.toHaveBeenCalled();
  });
});
