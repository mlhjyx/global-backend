import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptPii, decryptPii, isEncryptedPii, piiKeyConfigured } from './pii-crypto';

const TEST_KEY = 'a'.repeat(64); // 32 字节 hex

describe('pii-crypto', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });
  afterEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });

  it('往返：decrypt(encrypt(x)) === x', () => {
    const pt = 'Max Mustermann';
    const ct = encryptPii(pt);
    expect(isEncryptedPii(ct)).toBe(true);
    expect(ct.startsWith('enc:v1:')).toBe(true);
    expect(decryptPii(ct)).toBe(pt);
  });

  it('确定性：同明文同密文（使 contact_point 唯一键在密文上成立）', () => {
    expect(encryptPii('a@b.com')).toBe(encryptPii('a@b.com'));
  });

  it('不同明文 → 不同密文', () => {
    expect(encryptPii('a@b.com')).not.toBe(encryptPii('c@d.com'));
  });

  it('幂等：已加密的原样返回（不双重加密）', () => {
    const ct = encryptPii('x@y.com');
    expect(encryptPii(ct)).toBe(ct);
  });

  it('legacy 明文：decrypt 非密文原样返回', () => {
    expect(decryptPii('plain@text.com')).toBe('plain@text.com');
    expect(isEncryptedPii('plain@text.com')).toBe(false);
  });

  it('篡改检测：改一位密文 → 解密抛（GCM tag）', () => {
    const ct = encryptPii('secret');
    const tampered = ct.slice(0, -2) + (ct.endsWith('A') ? 'B' : 'A') + '=';
    expect(() => decryptPii(tampered)).toThrow();
  });

  it('fail-closed：无 key → 加密抛（绝不明文落库）', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    expect(piiKeyConfigured()).toBe(false);
    expect(() => encryptPii('x')).toThrow(/未配置/);
  });

  it('无 key 但解 legacy 明文不抛（非密文无需 key）', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    expect(decryptPii('plain')).toBe('plain');
  });

  it('key 长度错 → 抛（配置错误大声）', () => {
    process.env.PII_ENCRYPTION_KEY = 'abcd';
    expect(() => encryptPii('x')).toThrow(/32 字节/);
  });
});
