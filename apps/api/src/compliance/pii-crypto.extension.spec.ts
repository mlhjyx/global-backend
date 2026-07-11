import { describe, it, expect, beforeEach } from 'vitest';
import { encryptArgs, decryptResult, piiSpecFor } from './pii-crypto.extension';
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
