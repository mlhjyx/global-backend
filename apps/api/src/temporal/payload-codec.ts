import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Payload, PayloadCodec } from '@temporalio/common';

export const AES_GCM_PAYLOAD_ENCODING = 'binary/encrypted-aes-256-gcm' as const;
const ENCODING_BYTES = Buffer.from(AES_GCM_PAYLOAD_ENCODING, 'utf8');
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const VALID_KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type TemporalPayloadCodecMode = 'off' | 'optional' | 'enforce';

export interface TemporalPayloadKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

function decodeKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  const buf = /^[0-9a-f]{64}$/iu.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (buf.length !== AES_256_KEY_BYTES) {
    throw new Error('TEMPORAL_PAYLOAD_CODEC_KEY_INVALID_LENGTH');
  }
  return buf;
}

export function parseTemporalPayloadKeyring(
  env: NodeJS.ProcessEnv = process.env,
): TemporalPayloadKeyring | null {
  const jsonRaw = env.TEMPORAL_PAYLOAD_CODEC_KEYS_JSON?.trim();
  const singleRaw = env.TEMPORAL_PAYLOAD_CODEC_KEY?.trim();
  const keys = new Map<string, Buffer>();

  if (jsonRaw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch {
      throw new Error('TEMPORAL_PAYLOAD_CODEC_KEYS_JSON_INVALID');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('TEMPORAL_PAYLOAD_CODEC_KEYS_JSON_INVALID');
    }
    for (const [keyId, secret] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VALID_KEY_ID_RE.test(keyId) || typeof secret !== 'string') {
        throw new Error('TEMPORAL_PAYLOAD_CODEC_KEY_ENTRY_INVALID');
      }
      keys.set(keyId, decodeKeyMaterial(secret));
    }
  } else if (singleRaw) {
    const defaultId = env.TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID?.trim() || 'v1';
    if (!VALID_KEY_ID_RE.test(defaultId)) {
      throw new Error('TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID_INVALID');
    }
    keys.set(defaultId, decodeKeyMaterial(singleRaw));
  }

  if (keys.size === 0) return null;

  const requestedActive = env.TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID?.trim();
  const activeKeyId = requestedActive || [...keys.keys()][0]!;
  if (!keys.has(activeKeyId)) {
    throw new Error('TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_MISSING');
  }
  return { activeKeyId, keys };
}

export function resolveTemporalPayloadCodecMode(
  env: NodeJS.ProcessEnv = process.env,
): TemporalPayloadCodecMode {
  const raw = env.TEMPORAL_PAYLOAD_CODEC_MODE?.trim().toLowerCase();
  if (raw === 'enforce') return 'enforce';
  if (raw === 'optional') return 'optional';
  if (raw === 'off') return 'off';
  // Default: activate transparently when keyring is configured, stay off otherwise.
  return env.TEMPORAL_PAYLOAD_CODEC_KEYS_JSON?.trim() ||
    env.TEMPORAL_PAYLOAD_CODEC_KEY?.trim()
    ? 'optional'
    : 'off';
}

function serializePayloadRecord(payload: Payload): Buffer {
  const metadata: Record<string, string> = {};
  if (payload.metadata) {
    for (const [k, v] of Object.entries(payload.metadata)) {
      metadata[k] = Buffer.from(v).toString('base64');
    }
  }
  return Buffer.from(
    JSON.stringify({
      m: metadata,
      d: payload.data ? Buffer.from(payload.data).toString('base64') : null,
    }),
    'utf8',
  );
}

function deserializePayloadRecord(plaintext: Buffer): Payload {
  const parsed = JSON.parse(plaintext.toString('utf8')) as {
    m?: Record<string, string>;
    d?: string | null;
  };
  const metadata: Record<string, Uint8Array> = Object.create(null);
  if (parsed.m && typeof parsed.m === 'object' && !Array.isArray(parsed.m)) {
    for (const [k, v] of Object.entries(parsed.m)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (typeof v === 'string') {
        metadata[k] = Buffer.from(v, 'base64');
      }
    }
  }
  return {
    metadata,
    ...(typeof parsed.d === 'string' ? { data: Buffer.from(parsed.d, 'base64') } : {}),
  };
}

/**
 * AES-256-GCM Temporal `PayloadCodec` with keyring rotation support.
 * - `encode`: encrypts every Temporal workflow/activity payload with a random
 *   96-bit IV, 128-bit auth tag, and AAD binding encoding + keyId.
 * - `decode`: decrypts `binary/encrypted-aes-256-gcm` payloads using the
 *   embedded `encryption-key-id`; in `optional` mode passes through legacy
 *   unencrypted payloads during rolling upgrades, while `enforce` rejects
 *   unencrypted payloads fail-closed.
 */
export class AesGcmPayloadCodec implements PayloadCodec {
  private readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;
  private readonly allowLegacyPlaintextDecode: boolean;

  constructor(
    keyring: TemporalPayloadKeyring,
    options?: { readonly allowLegacyPlaintextDecode?: boolean },
  ) {
    if (!keyring.keys.has(keyring.activeKeyId)) {
      throw new Error('TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_MISSING');
    }
    this.activeKeyId = keyring.activeKeyId;
    this.keys = new Map(keyring.keys);
    this.allowLegacyPlaintextDecode = options?.allowLegacyPlaintextDecode ?? true;
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    const key = this.keys.get(this.activeKeyId)!;
    const keyIdBytes = Buffer.from(this.activeKeyId, 'utf8');
    const aad = Buffer.from(`${AES_GCM_PAYLOAD_ENCODING}:${this.activeKeyId}`, 'utf8');
    return payloads.map((payload) => {
      const plaintext = serializePayloadRecord(payload);
      const iv = randomBytes(IV_LENGTH_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return {
        metadata: {
          encoding: ENCODING_BYTES,
          'encryption-key-id': keyIdBytes,
        },
        data: Buffer.concat([iv, authTag, ciphertext]),
      };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding
        ? Buffer.from(payload.metadata.encoding).toString('utf8')
        : '';
      if (encoding !== AES_GCM_PAYLOAD_ENCODING) {
        if (this.allowLegacyPlaintextDecode) return payload;
        throw new Error('TEMPORAL_PAYLOAD_UNENCRYPTED_REJECTED');
      }
      const keyIdRaw = payload.metadata?.['encryption-key-id'];
      if (!keyIdRaw) {
        throw new Error('TEMPORAL_PAYLOAD_KEY_ID_MISSING');
      }
      const keyId = Buffer.from(keyIdRaw).toString('utf8');
      const key = this.keys.get(keyId);
      if (!key) {
        throw new Error(`TEMPORAL_PAYLOAD_KEY_UNKNOWN:${keyId}`);
      }
      const rawData = payload.data ? Buffer.from(payload.data) : Buffer.alloc(0);
      if (rawData.length < IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES) {
        throw new Error('TEMPORAL_PAYLOAD_CIPHERTEXT_TRUNCATED');
      }
      const iv = rawData.subarray(0, IV_LENGTH_BYTES);
      const authTag = rawData.subarray(
        IV_LENGTH_BYTES,
        IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES,
      );
      const ciphertext = rawData.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
      const aad = Buffer.from(`${AES_GCM_PAYLOAD_ENCODING}:${keyId}`, 'utf8');
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: AUTH_TAG_LENGTH_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return deserializePayloadRecord(plaintext);
    });
  }
}

/**
 * Resolves the optional Temporal `PayloadCodec` from environment variables.
 * - `off`: returns `undefined` (zero runtime impact in tests/unencrypted dev).
 * - `optional`: returns `AesGcmPayloadCodec` allowing legacy plaintext decode when keys are set, or `undefined` if no keys are configured.
 * - `enforce`: fails closed (`throw`) if keys are missing or malformed, and rejects unencrypted payloads on decode.
 */
export function resolveTemporalPayloadCodec(
  env: NodeJS.ProcessEnv = process.env,
): AesGcmPayloadCodec | undefined {
  const mode = resolveTemporalPayloadCodecMode(env);
  if (mode === 'off') return undefined;
  const keyring = parseTemporalPayloadKeyring(env);
  if (!keyring) {
    if (mode === 'enforce') {
      throw new Error('TEMPORAL_PAYLOAD_CODEC_KEYS_REQUIRED');
    }
    return undefined;
  }
  return new AesGcmPayloadCodec(keyring, {
    allowLegacyPlaintextDecode: mode !== 'enforce',
  });
}
