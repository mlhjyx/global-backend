import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptPii,
  decryptPii,
  isEncryptedPii,
  piiKeyConfigured,
  blindContactKey,
  isBlindedContactKey,
} from './pii-crypto';

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

describe('pii-crypto · blindContactKey（联系人去重键盲化 / 收口⑥ PR #60 修补）', () => {
  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });
  afterEach(() => {
    process.env.PII_ENCRYPTION_KEY = TEST_KEY;
  });

  it('确定性：同 raw 键 → 同盲值（使 (workspace,dedupe_key) 唯一键/upsert 在盲值上成立）', () => {
    expect(blindContactKey('e:max@acme.com')).toBe(blindContactKey('e:max@acme.com'));
  });

  it('不同 raw 键 → 不同盲值（不撞键）', () => {
    expect(blindContactKey('e:a@b.com')).not.toBe(blindContactKey('e:c@d.com'));
  });

  it('前缀 bi:v1: + 不可逆：盲值不含原文 email/人名', () => {
    const raw = 'c:d:acme.com:erika mustermann';
    const blinded = blindContactKey(raw);
    expect(blinded.startsWith('bi:v1:')).toBe(true);
    expect(isBlindedContactKey(blinded)).toBe(true);
    expect(blinded).not.toContain('erika');
    expect(blinded).not.toContain('acme.com');
    expect(blinded.toLowerCase()).not.toContain('mustermann');
  });

  it('幂等：已盲化的键原样返回（回填可重跑）', () => {
    const blinded = blindContactKey('e:max@acme.com');
    expect(blindContactKey(blinded)).toBe(blinded);
  });

  it('legacy 明文键（e:/c: 前缀）不被误判为已盲化', () => {
    expect(isBlindedContactKey('e:max@acme.com')).toBe(false);
    expect(isBlindedContactKey('c:d:acme.com:max')).toBe(false);
  });

  it('域分隔：盲值 ≠ 同明文的 encryptPii 密文（不与加密 IV 派生互相关）', () => {
    const raw = 'e:max@acme.com';
    expect(blindContactKey(raw)).not.toBe(encryptPii(raw));
  });

  it('fail-closed：无 key → 盲化抛（绝不把明文键落库）', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    expect(() => blindContactKey('e:max@acme.com')).toThrow(/未配置/);
  });

  it('key 长度错 → 抛（配置错误大声，与 encryptPii 一致）', () => {
    process.env.PII_ENCRYPTION_KEY = 'abcd';
    expect(() => blindContactKey('e:x@y.com')).toThrow(/32 字节/);
  });
});
