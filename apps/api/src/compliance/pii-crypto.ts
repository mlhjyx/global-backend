import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * PII 列级加密 v2（MT-P2）：每租户 HKDF-SHA256 派生 DEK/IV_KEY/BI_KEY + `workspaceId` AAD +
 * Keyring 零停机轮换（`enc:v2:<keyId>:<ivB64>:<tagB64>:<ctB64>` 与 `bi:v2:<keyId>:<hex64>`）。
 *
 * 设计要点：
 *  - KEK 由 `PII_KEYRING_JSON` 持有，绝不过 DB；按 `ws:<workspaceId>`（或 `platform:<scope>`）盐值
 *    经 HKDF-SHA256 派生每作用域 32 字节子密钥，并将 `pii:v2:<scopeLabel>:<purpose>` 绑定为 GCM AAD；
 *  - 确定性模式（默认，供唯一键与等值检索）以 `HMAC-SHA256(IV_KEY, 'pii-iv:v2:' || AAD || '\0' || plaintext)[0..12]`
 *    派生 IV；随机模式（`deterministic: false`，供 `source_channel_record` 等非检索字段）使用 12 字节随机 IV；
 *  - 保留可选 `PII_ENCRYPTION_KEY` 仅用于兼容读取/候选检索遗留 `enc:v1:` / `bi:v1:`（绝不用于 v2 写入）。
 */

const V1_PREFIX = 'enc:v1:';
const V2_PREFIX = 'enc:v2:';
const V1_BLIND_PREFIX = 'bi:v1:';
const V2_BLIND_PREFIX = 'bi:v2:';
const V1_BLIND_LABEL = 'pii-blind:v1:';
const KEYRING_ENV = 'PII_KEYRING_JSON';
const LEGACY_KEY_ENV = 'PII_ENCRYPTION_KEY';
const LEGACY_PLAINTEXT_READ_ENV = 'PII_ALLOW_LEGACY_PLAINTEXT_READ';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/u;
const HEX64_RE = /^[0-9a-f]{64}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64_32B_RE = /^[A-Za-z0-9+/]{43}=$/u;
const BASE64_STD_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const FORBIDDEN_KEY_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RETIRED_DNC_PEPPERS = 16;
const MAX_CACHED_SCOPE_SUBKEYS = 4096;

export const PII_PURPOSE = Object.freeze({
  DEFAULT: 'default',
  CANONICAL_CONTACT_FULL_NAME: 'CanonicalContact.fullName',
  CONTACT_POINT_VALUE: 'ContactPoint.value',
  FIELD_EVIDENCE_VALUE: 'FieldEvidence.value',
  CONTACT_EMAIL_FIND_PAYLOAD: 'ContactEmailFind.payload',
  PATENT_INVENTOR_NAME: 'PatentInventorCache.inventorName',
  SOURCE_CHANNEL_CONTACT_NAME: 'SourceChannelRecord.contactName',
  SOURCE_CHANNEL_CONTACT_TITLE: 'SourceChannelRecord.contactTitle',
  SOURCE_CHANNEL_EMAIL: 'SourceChannelRecord.email',
  SOURCE_CHANNEL_PHONE: 'SourceChannelRecord.phone',
  CONTACT_DEDUPE_KEY: 'CanonicalContact.dedupeKey',
  DOMAIN_BLIND_KEY: 'ContactPoint.domainBlindKey',
  PATENT_INVENTOR_KEY: 'PatentInventorCache.inventorNameKey',
  PHYSICAL_FINGERPRINT: 'EnrichmentSafety.physicalFingerprint',
} as const);

export type PlatformPiiScope =
  | 'patent_inventor_cache'
  | 'source_channel_record'
  | 'enrichment_fingerprint';

const ALLOWED_PLATFORM_SCOPES = new Set<PlatformPiiScope>([
  'patent_inventor_cache',
  'source_channel_record',
  'enrichment_fingerprint',
]);

export interface TenantPiiContext {
  workspaceId: string;
  purpose?: string;
  deterministic?: boolean;
  /** 仅显式迁移回填期允许透传遗留明文；默认关闭（fail-closed，拒绝静默明文回退）。 */
  allowLegacyPlaintext?: boolean;
}

export interface PlatformPiiContext {
  scope: PlatformPiiScope;
  purpose?: string;
  deterministic?: boolean;
  /** 仅显式迁移回填期允许透传遗留明文；默认关闭（fail-closed，拒绝静默明文回退）。 */
  allowLegacyPlaintext?: boolean;
}

interface ParsedKeyring {
  activeKeyId: string;
  keys: Map<string, Buffer>;
}

interface DerivedSubkeys {
  dek: Buffer;
  ivKey: Buffer;
  biKey: Buffer;
}

let cachedKeyringRaw: string | undefined;
let cachedKeyring: ParsedKeyring | undefined;
const subkeyCache = new WeakMap<Buffer, Map<string, DerivedSubkeys>>();

/** 严格解码 32 字节密钥（hex64 或 base64）；未配置返回 null，格式或长度错误抛错且不泄露密钥原文。 */
export function decodeSecret32(raw: string | undefined, label: string): Buffer | null {
  if (raw === undefined || raw === '') return null;
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/u.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else if (BASE64_32B_RE.test(raw)) {
    buf = Buffer.from(raw, 'base64');
  } else {
    throw new Error(`${label} 必须解码为 32 字节（hex64 或 base64）`);
  }
  if (buf.length !== 32) {
    throw new Error(`${label} 必须解码为 32 字节（hex64 或 base64），实得 ${buf.length} 字节`);
  }
  return buf;
}

/** 校验并解析 `OUTREACH_DNC_HMAC_PEPPER` 与可选 `OUTREACH_DNC_HMAC_RETIRED_PEPPERS`。 */
export function parseOutreachDncPeppers(
  pepperRaw: string | undefined,
  retiredRaw?: string,
): { activePepper: Buffer; retiredPeppers: Buffer[] } {
  const activePepper = decodeSecret32(
    pepperRaw?.trim(),
    'OUTREACH_DNC_HMAC_PEPPER',
  );
  if (!activePepper) {
    throw new Error('OUTREACH_DNC_HMAC_PEPPER 未配置');
  }
  const retiredPeppers: Buffer[] = [];
  if (retiredRaw && retiredRaw.trim().length > 0) {
    const entries = retiredRaw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (entries.length > MAX_RETIRED_DNC_PEPPERS) {
      throw new Error(
        `OUTREACH_DNC_HMAC_RETIRED_PEPPERS 最多允许 ${MAX_RETIRED_DNC_PEPPERS} 个轮换密钥`,
      );
    }
    for (const [index, entry] of entries.entries()) {
      const decoded = decodeSecret32(
        entry,
        `OUTREACH_DNC_HMAC_RETIRED_PEPPERS[${index}]`,
      );
      if (decoded) retiredPeppers.push(decoded);
    }
  }
  return { activePepper, retiredPeppers };
}

/** 启动就绪探针校验 DNC HMAC pepper（不泄露任何密钥材料）。 */
export function assertOutreachDncPepperConfiguration(
  pepperRaw: string | undefined,
  retiredRaw?: string,
): void {
  parseOutreachDncPeppers(pepperRaw, retiredRaw);
}

function parsePiiKeyring(rawJson: string | undefined): ParsedKeyring {
  if (!rawJson || !rawJson.trim()) {
    throw new Error(`${KEYRING_ENV} 未配置 — 拒绝以明文处理 PII（fail-closed）`);
  }
  if (rawJson === cachedKeyringRaw && cachedKeyring) {
    return cachedKeyring;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`${KEYRING_ENV} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${KEYRING_ENV} 必须是包含 activeKeyId 与 keys 的对象`);
  }
  const obj = parsed as Record<string, unknown>;
  const activeKeyId = obj.activeKeyId;
  if (
    typeof activeKeyId !== 'string' ||
    !KEY_ID_RE.test(activeKeyId) ||
    FORBIDDEN_KEY_IDS.has(activeKeyId)
  ) {
    throw new Error(`${KEYRING_ENV}.activeKeyId 缺失或不符合 keyId 规范`);
  }
  const rawKeys = obj.keys;
  if (!rawKeys || typeof rawKeys !== 'object' || Array.isArray(rawKeys)) {
    throw new Error(`${KEYRING_ENV}.keys 必须是非空对象`);
  }
  const keys = new Map<string, Buffer>();
  for (const [keyId, secret] of Object.entries(rawKeys as Record<string, unknown>)) {
    if (!KEY_ID_RE.test(keyId) || FORBIDDEN_KEY_IDS.has(keyId)) {
      throw new Error(`${KEYRING_ENV}.keys 包含非法 keyId`);
    }
    if (typeof secret !== 'string') {
      throw new Error(`${KEYRING_ENV}.keys[${keyId}] 必须是字符串`);
    }
    const decoded = decodeSecret32(secret, `${KEYRING_ENV}.keys[${keyId}]`);
    if (!decoded) {
      throw new Error(`${KEYRING_ENV}.keys[${keyId}] 不能为空`);
    }
    keys.set(keyId, decoded);
  }
  if (keys.size === 0 || !keys.has(activeKeyId)) {
    throw new Error(`${KEYRING_ENV}.activeKeyId 未在 keys 中定义`);
  }
  const result = { activeKeyId, keys };
  cachedKeyringRaw = rawJson;
  cachedKeyring = result;
  return result;
}

function resolveLegacyV1Key(raw?: string): Buffer | null {
  const value = raw === undefined ? process.env[LEGACY_KEY_ENV] : raw;
  return decodeSecret32(value, LEGACY_KEY_ENV);
}

function assertValidWorkspaceId(workspaceId: string): string {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    throw new Error('PII 操作需要合法 UUID workspaceId（fail-closed）');
  }
  return workspaceId.toLowerCase();
}

function assertValidPlatformScope(scope: PlatformPiiScope): PlatformPiiScope {
  if (!ALLOWED_PLATFORM_SCOPES.has(scope)) {
    throw new Error(`未知平台 PII scope: ${String(scope)}`);
  }
  return scope;
}

function normalizePurpose(purpose: string | undefined): string {
  const value = purpose ?? PII_PURPOSE.DEFAULT;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    /[\s\0:]/u.test(value)
  ) {
    throw new Error('PII purpose 非法');
  }
  return value;
}

function scopeLabelForTenant(workspaceId: string): string {
  return `ws:${assertValidWorkspaceId(workspaceId)}`;
}

function scopeLabelForPlatform(scope: PlatformPiiScope): string {
  return `platform:${assertValidPlatformScope(scope)}`;
}

function deriveSubkeys(kek: Buffer, scopeLabel: string): DerivedSubkeys {
  let byScope = subkeyCache.get(kek);
  if (!byScope) {
    byScope = new Map();
    subkeyCache.set(kek, byScope);
  }
  const existing = byScope.get(scopeLabel);
  if (existing) return existing;

  const salt = Buffer.from(scopeLabel, 'utf8');
  const dek = Buffer.from(hkdfSync('sha256', kek, salt, Buffer.from('pii-dek:v2', 'utf8'), 32));
  const ivKey = Buffer.from(
    hkdfSync('sha256', kek, salt, Buffer.from('pii-iv-key:v2', 'utf8'), 32),
  );
  const biKey = Buffer.from(
    hkdfSync('sha256', kek, salt, Buffer.from('pii-blind-key:v2', 'utf8'), 32),
  );
  const derived = { dek, ivKey, biKey };
  if (byScope.size >= MAX_CACHED_SCOPE_SUBKEYS) {
    const oldestKey = byScope.keys().next().value;
    if (oldestKey !== undefined) byScope.delete(oldestKey);
  }
  byScope.set(scopeLabel, derived);
  return derived;
}

function buildAad(scopeLabel: string, purpose: string): Buffer {
  return Buffer.from(`pii:v2:${scopeLabel}:${purpose}`, 'utf8');
}

function encryptV2WithKey(
  plaintext: string,
  keyId: string,
  kek: Buffer,
  scopeLabel: string,
  purpose: string,
  deterministic: boolean,
): string {
  const { dek, ivKey } = deriveSubkeys(kek, scopeLabel);
  const aad = buildAad(scopeLabel, purpose);
  const iv = deterministic
    ? createHmac('sha256', ivKey)
        .update('pii-iv:v2:')
        .update(aad)
        .update('\0')
        .update(plaintext, 'utf8')
        .digest()
        .subarray(0, IV_LEN)
    : randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V2_PREFIX}${keyId}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function encryptLegacyV1(plaintext: string, key: Buffer): string {
  const iv = createHmac('sha256', key)
    .update('pii-iv:v1:')
    .update(plaintext, 'utf8')
    .digest()
    .subarray(0, IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V1_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

function decryptLegacyV1(stored: string): string {
  const key = resolveLegacyV1Key();
  if (!key) throw new Error(`${LEGACY_KEY_ENV} 未配置 — 无法解密 v1 PII`);
  const payload = stored.slice(V1_PREFIX.length);
  if (!payload || !BASE64_STD_RE.test(payload)) {
    throw new Error('enc:v1 密文格式非法');
  }
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error('enc:v1 密文长度非法');
  }
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function decryptV2(stored: string, scopeLabel: string, purpose: string): string {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== 'v2') {
    throw new Error('enc:v2 密文格式非法');
  }
  const [, , keyId, ivB64, tagB64, ctB64] = parts;
  if (!keyId || !KEY_ID_RE.test(keyId) || FORBIDDEN_KEY_IDS.has(keyId)) {
    throw new Error('enc:v2 keyId 非法');
  }
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const kek = keyring.keys.get(keyId);
  if (!kek) {
    throw new Error('enc:v2 keyId 未在 PII_KEYRING_JSON 中注册');
  }
  if (
    !ivB64 ||
    !tagB64 ||
    ctB64 === undefined ||
    !BASE64_STD_RE.test(ivB64) ||
    !BASE64_STD_RE.test(tagB64) ||
    !BASE64_STD_RE.test(ctB64)
  ) {
    throw new Error('enc:v2 payload 非合法 base64');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('enc:v2 IV 或 GCM tag 长度非法');
  }
  const { dek } = deriveSubkeys(kek, scopeLabel);
  const aad = buildAad(scopeLabel, purpose);
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function blindV2WithKey(
  rawKey: string,
  keyId: string,
  kek: Buffer,
  scopeLabel: string,
  purpose: string,
): string {
  const { biKey } = deriveSubkeys(kek, scopeLabel);
  const mac = createHmac('sha256', biKey)
    .update('pii-blind:v2:')
    .update(purpose)
    .update('\0')
    .update(rawKey, 'utf8')
    .digest('hex');
  return `${V2_BLIND_PREFIX}${keyId}:${mac}`;
}

function blindLegacyV1(rawKey: string, key: Buffer): string {
  const mac = createHmac('sha256', key)
    .update(V1_BLIND_LABEL)
    .update(rawKey, 'utf8')
    .digest('hex');
  return `${V1_BLIND_PREFIX}${mac}`;
}

/** 已是密文（`enc:v1:` 或 `enc:v2:` 前缀）。 */
export function isEncryptedPii(value: string): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(V2_PREFIX) || value.startsWith(V1_PREFIX))
  );
}

/** 已盲化（`bi:v1:` 或 `bi:v2:` 前缀）。legacy 明文键返回 false。 */
export function isBlindedContactKey(value: string): boolean {
  return (
    typeof value === 'string' &&
    (value.startsWith(V2_BLIND_PREFIX) || value.startsWith(V1_BLIND_PREFIX))
  );
}

/** 当前 `PII_KEYRING_JSON` 是否已配置且合法（并验证可选遗留 `PII_ENCRYPTION_KEY`）。 */
export function piiKeyConfigured(): boolean {
  try {
    assertPiiKeyConfigured();
    return true;
  } catch {
    return false;
  }
}

/** 是否显式开启了迁移期遗留明文读（默认 false，严禁静默明文回退）。 */
export function legacyPlaintextReadAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[LEGACY_PLAINTEXT_READ_ENV]?.trim().toLowerCase() === 'true';
}

function assertValidLegacyPlaintextFlag(raw: string | undefined): void {
  if (raw === undefined || raw.trim() === '') return;
  const normalized = raw.trim().toLowerCase();
  if (normalized !== 'true' && normalized !== 'false') {
    throw new Error(`${LEGACY_PLAINTEXT_READ_ENV} 必须为 true 或 false`);
  }
}

/** 校验当前环境（或显式传入）的 Keyring 配置与可选遗留 v1 密钥。 */
export function assertPiiKeyConfigured(
  keyringJson?: string,
  legacyV1Key?: string,
  allowLegacyPlaintextRaw?: string,
): void {
  assertPiiKeyConfiguration(
    keyringJson === undefined ? process.env[KEYRING_ENV] : keyringJson,
    legacyV1Key === undefined ? process.env[LEGACY_KEY_ENV] : legacyV1Key,
    allowLegacyPlaintextRaw === undefined
      ? process.env[LEGACY_PLAINTEXT_READ_ENV]
      : allowLegacyPlaintextRaw,
  );
}

/** 校验显式传入的运行期 PII 密钥配置（不回退 process.env）。 */
export function assertPiiKeyConfiguration(
  keyringJson: string | undefined,
  legacyV1Key?: string,
  allowLegacyPlaintextRaw?: string,
): void {
  parsePiiKeyring(keyringJson);
  if (legacyV1Key !== undefined && legacyV1Key !== '') {
    resolveLegacyV1Key(legacyV1Key);
  }
  assertValidLegacyPlaintextFlag(allowLegacyPlaintextRaw);
}

/** 返回当前活跃 Keyring 的 `activeKeyId`。 */
export function getActivePiiKeyId(): string {
  return parsePiiKeyring(process.env[KEYRING_ENV]).activeKeyId;
}

/** 租户作用域加密 → `enc:v2:<activeKeyId>:<ivB64>:<tagB64>:<ctB64>`（幂等）。 */
export function encryptPii(plaintext: string, ctx: TenantPiiContext): string {
  if (isEncryptedPii(plaintext)) return plaintext;
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForTenant(ctx.workspaceId);
  const purpose = normalizePurpose(ctx.purpose);
  const kek = keyring.keys.get(keyring.activeKeyId)!;
  return encryptV2WithKey(
    plaintext,
    keyring.activeKeyId,
    kek,
    scopeLabel,
    purpose,
    ctx.deterministic ?? true,
  );
}

/** 租户作用域解密（支持 `enc:v2:` 与 `enc:v1:`；默认关闭静默明文回退，跨租户/跨用途必抛）。 */
export function decryptPii(stored: string, ctx: TenantPiiContext): string {
  const scopeLabel = scopeLabelForTenant(ctx.workspaceId);
  const purpose = normalizePurpose(ctx.purpose);
  if (!isEncryptedPii(stored)) {
    if (ctx.allowLegacyPlaintext ?? legacyPlaintextReadAllowed()) {
      return stored;
    }
    throw new Error(
      'PII_PLAINTEXT_FALLBACK_FORBIDDEN: 拒绝静默回退读取明文 PII（需 enc:v2:/enc:v1: 密文或显式开启迁移期读取）',
    );
  }
  if (stored.startsWith(V1_PREFIX)) {
    return decryptLegacyV1(stored);
  }
  return decryptV2(stored, scopeLabel, purpose);
}

/** 返回全部活跃/轮换中（及可选遗留 v1）确定性密文候选，用于密钥轮换期等值查询。 */
export function encryptPiiCandidates(
  plaintext: string,
  ctx: Omit<TenantPiiContext, 'deterministic'> & { includeLegacyV1?: boolean },
): string[] {
  if (isEncryptedPii(plaintext)) return [plaintext];
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForTenant(ctx.workspaceId);
  const purpose = normalizePurpose(ctx.purpose);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };
  add(
    encryptV2WithKey(
      plaintext,
      keyring.activeKeyId,
      keyring.keys.get(keyring.activeKeyId)!,
      scopeLabel,
      purpose,
      true,
    ),
  );
  for (const [keyId, kek] of keyring.keys.entries()) {
    if (keyId === keyring.activeKeyId) continue;
    add(encryptV2WithKey(plaintext, keyId, kek, scopeLabel, purpose, true));
  }
  if (ctx.includeLegacyV1 ?? true) {
    const legacyKey = resolveLegacyV1Key();
    if (legacyKey) add(encryptLegacyV1(plaintext, legacyKey));
  }
  return candidates;
}

/** 租户作用域盲索引 → `bi:v2:<activeKeyId>:<hex64>`（幂等）。 */
export function blindContactKey(
  rawKey: string,
  ctx: Omit<TenantPiiContext, 'deterministic'>,
): string {
  if (isBlindedContactKey(rawKey)) return rawKey;
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForTenant(ctx.workspaceId);
  const purpose = normalizePurpose(ctx.purpose);
  return blindV2WithKey(
    rawKey,
    keyring.activeKeyId,
    keyring.keys.get(keyring.activeKeyId)!,
    scopeLabel,
    purpose,
  );
}

/** 租户作用域盲索引候选集（遍历 Keyring 全部密钥 + 可选遗留 `bi:v1:`），供轮换期抑制/去重查找。 */
export function blindContactKeyCandidates(
  rawKey: string,
  ctx: Omit<TenantPiiContext, 'deterministic'> & { includeLegacyV1?: boolean },
): string[] {
  if (isBlindedContactKey(rawKey)) return [rawKey];
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForTenant(ctx.workspaceId);
  const purpose = normalizePurpose(ctx.purpose);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };
  add(
    blindV2WithKey(
      rawKey,
      keyring.activeKeyId,
      keyring.keys.get(keyring.activeKeyId)!,
      scopeLabel,
      purpose,
    ),
  );
  for (const [keyId, kek] of keyring.keys.entries()) {
    if (keyId === keyring.activeKeyId) continue;
    add(blindV2WithKey(rawKey, keyId, kek, scopeLabel, purpose));
  }
  if (ctx.includeLegacyV1 ?? true) {
    const legacyKey = resolveLegacyV1Key();
    if (legacyKey) add(blindLegacyV1(rawKey, legacyKey));
  }
  return candidates;
}

/** 平台共享表作用域加密（`patent_inventor_cache` / `source_channel_record` / `enrichment_fingerprint`）。 */
export function encryptPlatformPii(plaintext: string, ctx: PlatformPiiContext): string {
  if (isEncryptedPii(plaintext)) return plaintext;
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForPlatform(ctx.scope);
  const purpose = normalizePurpose(ctx.purpose);
  const kek = keyring.keys.get(keyring.activeKeyId)!;
  return encryptV2WithKey(
    plaintext,
    keyring.activeKeyId,
    kek,
    scopeLabel,
    purpose,
    ctx.deterministic ?? true,
  );
}

/** 平台共享表作用域解密（支持 `enc:v2:` 与 `enc:v1:`；默认关闭静默明文回退）。 */
export function decryptPlatformPii(stored: string, ctx: PlatformPiiContext): string {
  const scopeLabel = scopeLabelForPlatform(ctx.scope);
  const purpose = normalizePurpose(ctx.purpose);
  if (!isEncryptedPii(stored)) {
    if (ctx.allowLegacyPlaintext ?? legacyPlaintextReadAllowed()) {
      return stored;
    }
    throw new Error(
      'PII_PLAINTEXT_FALLBACK_FORBIDDEN: 拒绝静默回退读取明文 PII（需 enc:v2:/enc:v1: 密文或显式开启迁移期读取）',
    );
  }
  if (stored.startsWith(V1_PREFIX)) {
    return decryptLegacyV1(stored);
  }
  return decryptV2(stored, scopeLabel, purpose);
}

/** 平台作用域盲索引 → `bi:v2:<activeKeyId>:<hex64>`。 */
export function blindPlatformKey(
  rawKey: string,
  ctx: Omit<PlatformPiiContext, 'deterministic'>,
): string {
  if (isBlindedContactKey(rawKey)) return rawKey;
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForPlatform(ctx.scope);
  const purpose = normalizePurpose(ctx.purpose);
  return blindV2WithKey(
    rawKey,
    keyring.activeKeyId,
    keyring.keys.get(keyring.activeKeyId)!,
    scopeLabel,
    purpose,
  );
}

/** 平台作用域盲索引候选集（遍历 Keyring 全部密钥 + 可选遗留 `bi:v1:`）。 */
export function blindPlatformKeyCandidates(
  rawKey: string,
  ctx: Omit<PlatformPiiContext, 'deterministic'> & { includeLegacyV1?: boolean },
): string[] {
  if (isBlindedContactKey(rawKey)) return [rawKey];
  const keyring = parsePiiKeyring(process.env[KEYRING_ENV]);
  const scopeLabel = scopeLabelForPlatform(ctx.scope);
  const purpose = normalizePurpose(ctx.purpose);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (!seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  };
  add(
    blindV2WithKey(
      rawKey,
      keyring.activeKeyId,
      keyring.keys.get(keyring.activeKeyId)!,
      scopeLabel,
      purpose,
    ),
  );
  for (const [keyId, kek] of keyring.keys.entries()) {
    if (keyId === keyring.activeKeyId) continue;
    add(blindV2WithKey(rawKey, keyId, kek, scopeLabel, purpose));
  }
  if (ctx.includeLegacyV1 ?? true) {
    const legacyKey = resolveLegacyV1Key();
    if (legacyKey) add(blindLegacyV1(rawKey, legacyKey));
  }
  return candidates;
}

/** 判断密文是否需要升级/重加密（明文、`enc:v1:` 或非 activeKeyId 的 `enc:v2:`）。 */
export function needsPiiReencryption(stored: string, activeKeyId?: string): boolean {
  if (!isEncryptedPii(stored)) return true;
  if (stored.startsWith(V1_PREFIX)) return true;
  const parts = stored.split(':');
  if (parts.length !== 6) return true;
  const targetKeyId = activeKeyId ?? getActivePiiKeyId();
  return parts[2] !== targetKeyId;
}

/** 判断盲索引是否需要升级/重算（明文键、`bi:v1:` 或非 activeKeyId 的 `bi:v2:`）。 */
export function needsBlindReindex(stored: string, activeKeyId?: string): boolean {
  if (!isBlindedContactKey(stored)) return true;
  if (stored.startsWith(V1_BLIND_PREFIX)) return true;
  const parts = stored.split(':');
  if (parts.length !== 4 || !HEX64_RE.test(parts[3] ?? '')) return true;
  const targetKeyId = activeKeyId ?? getActivePiiKeyId();
  return parts[2] !== targetKeyId;
}

/** 租户密文重加密到当前 `activeKeyId`（已使用 activeKeyId 的确定性/随机密文可直接幂等跳过时由调用方先判 `needsPiiReencryption`）。 */
export function reencryptPii(stored: string, ctx: TenantPiiContext): string {
  const plaintext = decryptPii(stored, ctx);
  return encryptPii(plaintext, ctx);
}

/** 平台密文重加密到当前 `activeKeyId`。 */
export function reencryptPlatformPii(stored: string, ctx: PlatformPiiContext): string {
  const plaintext = decryptPlatformPii(stored, ctx);
  return encryptPlatformPii(plaintext, ctx);
}
