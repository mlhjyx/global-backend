import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptPii,
  decryptPii,
  isEncryptedPii,
  piiKeyConfigured,
  assertPiiKeyConfigured,
  assertPiiKeyConfiguration,
  blindContactKey,
  blindContactKeyCandidates,
  isBlindedContactKey,
  encryptPiiCandidates,
  encryptPlatformPii,
  decryptPlatformPii,
  blindPlatformKey,
  blindPlatformKeyCandidates,
  needsPiiReencryption,
  needsBlindReindex,
  reencryptPii,
  reencryptPlatformPii,
  getActivePiiKeyId,
  PII_PURPOSE,
} from './pii-crypto';
import { createCipheriv, createHmac } from 'node:crypto';

const KEY_1 = 'a'.repeat(64);
const KEY_2 = 'b'.repeat(64);
const LEGACY_KEY = 'c'.repeat(64);
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

function makeKeyring(activeKeyId: string, keys: Record<string, string>): string {
  return JSON.stringify({ activeKeyId, keys });
}

function makeLegacyV1Ciphertext(plaintext: string, hexKey = LEGACY_KEY): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = createHmac('sha256', key)
    .update('pii-iv:v1:')
    .update(plaintext, 'utf8')
    .digest()
    .subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:v1:' + Buffer.concat([iv, tag, ct]).toString('base64');
}

function makeLegacyV1Blind(rawKey: string, hexKey = LEGACY_KEY): string {
  const key = Buffer.from(hexKey, 'hex');
  const mac = createHmac('sha256', key)
    .update('pii-blind:v1:')
    .update(rawKey, 'utf8')
    .digest('hex');
  return `bi:v1:${mac}`;
}

describe('pii-crypto v2 (HKDF per-workspace DEK + AAD + Keyring)', () => {
  let prevKeyring: string | undefined;
  let prevLegacy: string | undefined;

  beforeEach(() => {
    prevKeyring = process.env.PII_KEYRING_JSON;
    prevLegacy = process.env.PII_ENCRYPTION_KEY;
    process.env.PII_KEYRING_JSON = makeKeyring('k1', { k1: KEY_1 });
    delete process.env.PII_ENCRYPTION_KEY;
  });

  afterEach(() => {
    if (prevKeyring === undefined) delete process.env.PII_KEYRING_JSON;
    else process.env.PII_KEYRING_JSON = prevKeyring;
    if (prevLegacy === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = prevLegacy;
  });

  it('往返：enc:v2:<keyId>:<iv>:<tag>:<ct> 格式且 decrypt(encrypt(x, ctx), ctx) === x', () => {
    const pt = 'Max Mustermann';
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME };
    const ct = encryptPii(pt, ctx);
    expect(isEncryptedPii(ct)).toBe(true);
    expect(ct.startsWith('enc:v2:k1:')).toBe(true);
    expect(ct.split(':')).toHaveLength(6);
    expect(decryptPii(ct, ctx)).toBe(pt);
    expect(getActivePiiKeyId()).toBe('k1');
  });

  it('确定性 vs 随机 IV：默认确定性；deterministic=false 时同明文产生不同 IV 与密文', () => {
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE };
    expect(encryptPii('a@b.com', ctx)).toBe(encryptPii('a@b.com', ctx));
    const r1 = encryptPii('a@b.com', { ...ctx, deterministic: false });
    const r2 = encryptPii('a@b.com', { ...ctx, deterministic: false });
    expect(r1).not.toBe(r2);
    expect(decryptPii(r1, ctx)).toBe('a@b.com');
    expect(decryptPii(r2, ctx)).toBe('a@b.com');
  });

  it('跨租户隔离：同明文在不同 workspaceId 下密文与盲索引完全不同，且跨租户解密必抛', () => {
    const pt = 'shared.buyer@acme.example';
    const ctA = encryptPii(pt, { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE });
    const ctB = encryptPii(pt, { workspaceId: WS_B, purpose: PII_PURPOSE.CONTACT_POINT_VALUE });
    expect(ctA).not.toBe(ctB);
    expect(() =>
      decryptPii(ctA, { workspaceId: WS_B, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    ).toThrow();
  });

  it('purpose AAD 绑定：不同 purpose 下密文不同且跨 purpose 解密必抛', () => {
    const pt = 'Max Mustermann';
    const ctName = encryptPii(pt, {
      workspaceId: WS_A,
      purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME,
    });
    const ctPoint = encryptPii(pt, {
      workspaceId: WS_A,
      purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    });
    expect(ctName).not.toBe(ctPoint);
    expect(() =>
      decryptPii(ctName, { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }),
    ).toThrow();
  });

  it('幂等：已加密（enc:v2: 或 enc:v1:）不再双重加密', () => {
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE };
    const ct2 = encryptPii('x@y.com', ctx);
    expect(encryptPii(ct2, ctx)).toBe(ct2);
    const ct1 = makeLegacyV1Ciphertext('x@y.com');
    expect(encryptPii(ct1, ctx)).toBe(ct1);
  });

  it('默认关闭静默明文回退；仅在显式 allowLegacyPlaintext 或 PII_ALLOW_LEGACY_PLAINTEXT_READ=true 时允许遗留明文读，enc:v1: 兼容解密与 v1 -> v2 重加密正常', () => {
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE };
    expect(isEncryptedPii('plain@text.com')).toBe(false);
    expect(() => decryptPii('plain@text.com', ctx)).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
    expect(() =>
      decryptPlatformPii('SCHMIDT, HANS', {
        scope: 'patent_inventor_cache',
        purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
      }),
    ).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);

    // 显式调用方迁移开关允许读 legacy 明文，但仍强制校验 workspaceId / scope
    expect(decryptPii('plain@text.com', { ...ctx, allowLegacyPlaintext: true })).toBe('plain@text.com');
    expect(() =>
      decryptPii('plain@text.com', { workspaceId: 'bad-ws', allowLegacyPlaintext: true }),
    ).toThrow(/workspaceId/);
    expect(
      decryptPlatformPii('SCHMIDT, HANS', {
        scope: 'patent_inventor_cache',
        purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
        allowLegacyPlaintext: true,
      }),
    ).toBe('SCHMIDT, HANS');

    // 环境变量迁移窗口显式开启时允许 legacy 明文读；显式 allowLegacyPlaintext=false 或未设/false 均拒绝
    const prevAllow = process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
    try {
      process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = 'true';
      expect(decryptPii('plain@text.com', ctx)).toBe('plain@text.com');
      expect(
        decryptPlatformPii('SCHMIDT, HANS', {
          scope: 'patent_inventor_cache',
          purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
        }),
      ).toBe('SCHMIDT, HANS');
      expect(() =>
        decryptPii('plain@text.com', { ...ctx, allowLegacyPlaintext: false }),
      ).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
      process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = 'false';
      expect(() => decryptPii('plain@text.com', ctx)).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
    } finally {
      if (prevAllow === undefined) delete process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
      else process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = prevAllow;
    }

    const v1 = makeLegacyV1Ciphertext('legacy@acme.example');
    expect(() => decryptPii(v1, ctx)).toThrow(/PII_ENCRYPTION_KEY/);

    process.env.PII_ENCRYPTION_KEY = LEGACY_KEY;
    expect(decryptPii(v1, ctx)).toBe('legacy@acme.example');
    expect(needsPiiReencryption(v1)).toBe(true);
    const upgraded = reencryptPii(v1, ctx);
    expect(upgraded.startsWith('enc:v2:k1:')).toBe(true);
    expect(decryptPii(upgraded, ctx)).toBe('legacy@acme.example');
    expect(needsPiiReencryption(upgraded)).toBe(false);
  });

  it('Keyring 零停机轮换：k1 -> k2 后可解旧密文、重加密为 k2，且 candidates 覆盖 k1/k2/v1', () => {
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE };
    const ctK1 = encryptPii('alice@acme.example', ctx);
    expect(ctK1.startsWith('enc:v2:k1:')).toBe(true);

    process.env.PII_KEYRING_JSON = makeKeyring('k2', { k1: KEY_1, k2: KEY_2 });
    process.env.PII_ENCRYPTION_KEY = LEGACY_KEY;

    expect(decryptPii(ctK1, ctx)).toBe('alice@acme.example');
    expect(needsPiiReencryption(ctK1)).toBe(true);
    const ctK2 = reencryptPii(ctK1, ctx);
    expect(ctK2.startsWith('enc:v2:k2:')).toBe(true);
    expect(needsPiiReencryption(ctK2)).toBe(false);

    const candidates = encryptPiiCandidates('alice@acme.example', ctx);
    expect(candidates).toEqual([
      ctK2,
      ctK1,
      makeLegacyV1Ciphertext('alice@acme.example'),
    ]);
  });

  it('篡改或格式畸形 enc:v2: 解密必抛', () => {
    const ctx = { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE };
    const ct = encryptPii('secret', ctx);
    const parts = ct.split(':');
    const tampered = [...parts.slice(0, 5), parts[5]!.slice(0, -1) + (parts[5]!.endsWith('A') ? 'B' : 'A')].join(':');
    expect(() => decryptPii(tampered, ctx)).toThrow();
    expect(() => decryptPii('enc:v2:k1:bad', ctx)).toThrow();
    expect(() => decryptPii('enc:v2:missing-key:AAAA:BBBB:CCCC', ctx)).toThrow();
  });

  it('fail-closed：缺失/畸形 PII_KEYRING_JSON 或缺失/非法 workspaceId 一律拒绝', () => {
    delete process.env.PII_KEYRING_JSON;
    expect(piiKeyConfigured()).toBe(false);
    expect(() => assertPiiKeyConfigured()).toThrow(/PII_KEYRING_JSON/);
    expect(() => encryptPii('x', { workspaceId: WS_A })).toThrow(/PII_KEYRING_JSON/);

    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k2', { k1: KEY_1 })),
    ).toThrow(/activeKeyId/);
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('bad key!', { 'bad key!': KEY_1 })),
    ).toThrow(/keyId/);
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k1', { k1: 'abcd' })),
    ).toThrow(/32 字节/);
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k1', { k1: KEY_1 }), 'bad-legacy'),
    ).toThrow(/32 字节/);
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k1', { k1: KEY_1 }), undefined, 'yes'),
    ).toThrow(/PII_ALLOW_LEGACY_PLAINTEXT_READ/);
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k1', { k1: KEY_1 }), undefined, 'false'),
    ).not.toThrow();
    expect(() =>
      assertPiiKeyConfiguration(makeKeyring('k1', { k1: KEY_1 }), undefined, 'true'),
    ).not.toThrow();

    process.env.PII_KEYRING_JSON = makeKeyring('k1', { k1: KEY_1 });
    expect(() => encryptPii('x', { workspaceId: '' })).toThrow(/workspaceId/);
    expect(() => encryptPii('x', { workspaceId: 'not-a-uuid' })).toThrow(/workspaceId/);
    expect(() => blindContactKey('e:a@b.com', { workspaceId: 'ws-1' })).toThrow(/workspaceId/);
  });

  it('blindContactKey (bi:v2:)：确定性、跨租户隔离、候选集合含多 key 与 legacy bi:v1:', () => {
    const raw = 'e:max@acme.com';
    const bA = blindContactKey(raw, { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY });
    const bB = blindContactKey(raw, { workspaceId: WS_B, purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY });
    expect(bA).toMatch(/^bi:v2:k1:[0-9a-f]{64}$/u);
    expect(bB).toMatch(/^bi:v2:k1:[0-9a-f]{64}$/u);
    expect(bA).not.toBe(bB);
    expect(isBlindedContactKey(bA)).toBe(true);
    expect(blindContactKey(bA, { workspaceId: WS_A })).toBe(bA);
    expect(isBlindedContactKey('e:max@acme.com')).toBe(false);

    process.env.PII_KEYRING_JSON = makeKeyring('k2', { k1: KEY_1, k2: KEY_2 });
    process.env.PII_ENCRYPTION_KEY = LEGACY_KEY;
    const bA2 = blindContactKey(raw, { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY });
    expect(needsBlindReindex(bA)).toBe(true);
    expect(needsBlindReindex(bA2)).toBe(false);
    expect(
      blindContactKeyCandidates(raw, { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_DEDUPE_KEY }),
    ).toEqual([bA2, bA, makeLegacyV1Blind(raw)]);
  });

  it('platform scope 加解密与盲索引：独立于 tenant scope 且校验 scope 与 purpose', () => {
    const ct = encryptPlatformPii('SCHMIDT, HANS', {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
    });
    expect(ct.startsWith('enc:v2:k1:')).toBe(true);
    expect(
      decryptPlatformPii(ct, {
        scope: 'patent_inventor_cache',
        purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
      }),
    ).toBe('SCHMIDT, HANS');
    expect(() =>
      decryptPlatformPii(ct, {
        scope: 'source_channel_record',
        purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
      }),
    ).toThrow();
    expect(() =>
      decryptPii(ct, { workspaceId: WS_A, purpose: PII_PURPOSE.PATENT_INVENTOR_NAME }),
    ).toThrow();

    const pBlind = blindPlatformKey('schmidt hans', {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_KEY,
    });
    expect(pBlind).toMatch(/^bi:v2:k1:[0-9a-f]{64}$/u);
    expect(
      blindPlatformKeyCandidates('schmidt hans', {
        scope: 'patent_inventor_cache',
        purpose: PII_PURPOSE.PATENT_INVENTOR_KEY,
      }),
    ).toContain(pBlind);

    process.env.PII_KEYRING_JSON = makeKeyring('k2', { k1: KEY_1, k2: KEY_2 });
    const reencrypted = reencryptPlatformPii(ct, {
      scope: 'patent_inventor_cache',
      purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
    });
    expect(reencrypted.startsWith('enc:v2:k2:')).toBe(true);
    expect(
      decryptPlatformPii(reencrypted, {
        scope: 'patent_inventor_cache',
        purpose: PII_PURPOSE.PATENT_INVENTOR_NAME,
      }),
    ).toBe('SCHMIDT, HANS');
  });
});
