import { createCipheriv, createDecipheriv, createHmac } from 'node:crypto';

/**
 * 收口⑥ PII 列级加密（ADR-003 PII-rights zone）。**app 层 AES-256-GCM**，key 应用持有、绝不过 DB。
 *
 * 设计取舍：
 *  - **确定性**（IV=HMAC(key, plaintext) 派生）→ 同明文同密文，使 contact_point 的
 *    `@@unique([contactId,type,value])` 与 where-by-value upsert 在密文上仍成立（免 valueHash 重构）。
 *    代价=泄露相等性（等同 blind-index，标准可搜索加密取舍），远优于明文。GCM 以明文派生 nonce：
 *    不同明文→不同 IV（压倒性概率），无 nonce 复用灾难。
 *  - **版本前缀** `enc:v1:` 使旧明文行零破坏共存（{@link decryptPii} 检测前缀，无则原样返回=legacy）。
 *  - key 缺失时 **加密 fail-closed（抛错）**——绝不把 PII 明文落库。
 */

const PREFIX = 'enc:v1:';
const KEY_ENV = 'PII_ENCRYPTION_KEY';
const IV_LEN = 12;
const TAG_LEN = 16;

/** 解析 32 字节 key（hex64 或 base64）。未配置 → null；长度错 → 抛（配置错误要大声）。 */
function resolveKey(): Buffer | null {
  const raw = process.env[KEY_ENV];
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`${KEY_ENV} 必须解码为 32 字节（hex64 或 base64），实得 ${buf.length} 字节`);
  }
  return buf;
}

/** 已是密文（enc:v1: 前缀）。 */
export function isEncryptedPii(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** PII_ENCRYPTION_KEY 是否已配置（供启动自检/健康检查）。 */
export function piiKeyConfigured(): boolean {
  return !!process.env[KEY_ENV];
}

/** 加密明文 → `enc:v1:base64(iv|tag|ct)`。key 缺失 → 抛（fail-closed）。幂等：已加密的原样返回。 */
export function encryptPii(plaintext: string): string {
  if (isEncryptedPii(plaintext)) return plaintext;
  const key = resolveKey();
  if (!key) throw new Error(`${KEY_ENV} 未配置 — 拒绝以明文存储 PII（fail-closed）`);
  const iv = createHmac('sha256', key).update('pii-iv:v1:').update(plaintext, 'utf8').digest().subarray(0, IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** 解密。非密文（legacy 明文）→ 原样返回。篡改（GCM tag 不符）→ 抛。key 缺失且是密文 → 抛。 */
export function decryptPii(stored: string): string {
  if (!isEncryptedPii(stored)) return stored;
  const key = resolveKey();
  if (!key) throw new Error(`${KEY_ENV} 未配置 — 无法解密 PII`);
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
