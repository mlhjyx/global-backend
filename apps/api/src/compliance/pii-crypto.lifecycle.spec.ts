import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piiExtension } from './pii-crypto.extension';
import { PII_PURPOSE, encryptPii } from './pii-crypto';

const WS_A = '00000000-0000-4000-8000-0000000000aa';

// Exercise the extension registered with Prisma without opening a database connection.
interface Extension {
  client: {
    onModuleInit(): Promise<void>;
    reconnect(): Promise<unknown>;
    getReadiness(): unknown;
    onModuleDestroy(): Promise<void>;
    withWorkspace(workspace: string, callback: (tx: unknown) => Promise<unknown>, options?: object): Promise<unknown>;
  };
  query: { $allModels: { $allOperations(input: { model: string; operation: string; args: object; query: (args: object) => Promise<unknown> }): Promise<unknown> } };
}
const extension = piiExtension({ $extends: (config: unknown) => config } as never) as unknown as Extension;
const principal = { sessionUser: 'app_user', currentUser: 'app_user', rolSuper: false, rolBypassRls: false, rolCreateDb: false, rolCreateRole: false, rolReplication: false, rolInherit: true, memberships: [] };
function context() {
  const ctx = { $connect: vi.fn().mockResolvedValue(undefined), $disconnect: vi.fn().mockResolvedValue(undefined), $queryRawUnsafe: vi.fn().mockResolvedValue([principal]) };
  vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue(ctx as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return ctx;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('PII extension readiness and workspace lifecycle', () => {
  it('starts closed, verifies the app principal, and closes on shutdown', async () => {
    const ctx = context();
    expect(extension.client.getReadiness()).toEqual({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
    await extension.client.onModuleInit();
    expect(extension.client.getReadiness()).toEqual({ status: 'ready' });
    await extension.client.onModuleDestroy();
    expect(ctx.$disconnect).toHaveBeenCalledOnce();
    expect(extension.client.getReadiness()).toEqual({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
  });
  it.each(['connect', 'query'])('keeps readiness closed after %s failure and recovers on a later retry', async (stage) => {
    const ctx = context();
    (stage === 'connect' ? ctx.$connect : ctx.$queryRawUnsafe).mockRejectedValueOnce(new Error('synthetic private dependency text'));
    expect(await extension.client.reconnect()).toEqual({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('synthetic private');
    expect(await extension.client.reconnect()).toEqual({ status: 'ready' });
  });
  it.each([{ rows: [] }, { rows: [principal, principal] }, { rows: [{ ...principal, rolSuper: true }] }])('rejects missing, ambiguous, or privileged identity evidence', async ({ rows }) => {
    const ctx = context();
    ctx.$queryRawUnsafe.mockResolvedValue(rows);
    expect(await extension.client.reconnect()).toEqual({ status: 'not_ready', code: 'DATABASE_PRINCIPAL_INVALID' });
  });
  it('closes readiness even if disconnect fails', async () => {
    const ctx = context();
    await extension.client.reconnect();
    const failure = new Error('synthetic disconnect failure');
    ctx.$disconnect.mockRejectedValue(failure);
    await expect(extension.client.onModuleDestroy()).rejects.toBe(failure);
    expect(extension.client.getReadiness()).toEqual({ status: 'not_ready', code: 'DATABASE_UNAVAILABLE' });
  });
  it('sets workspace context before invoking work and preserves transaction options', async () => {
    const order: string[] = [];
    const tx = { $executeRaw: vi.fn(async () => { order.push('scope'); }) };
    const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
    vi.spyOn(Prisma, 'getExtensionContext').mockReturnValue({ $transaction: transaction } as never);
    const options = { maxWait: 10, timeout: 20 };
    expect(await extension.client.withWorkspace(WS_A, async (value) => { expect(value).toBe(tx); order.push('work'); return 'result'; }, options)).toBe('result');
    expect(order).toEqual(['scope', 'work']);
    expect(tx.$executeRaw.mock.calls[0]).toContain(WS_A);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), options);
  });
  it('decrypts included contacts and contact points for unrelated parent models', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k2: 'b'.repeat(64) } }));
    const rows = [{
      workspaceId: WS_A,
      contacts: [{ fullName: encryptPii('Synthetic Person', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME }), contactPoints: [{ type: 'email', value: encryptPii('synthetic@example.test', { workspaceId: WS_A, purpose: PII_PURPOSE.CONTACT_POINT_VALUE }) }, { type: 'external_id', value: 'ext:99' }] }],
      contact: null,
    }];
    const result = await extension.query.$allModels.$allOperations({ model: 'CanonicalCompany', operation: 'findMany', args: {}, query: async () => rows });
    expect(result).toEqual([{
      workspaceId: WS_A,
      contacts: [{ fullName: 'Synthetic Person', contactPoints: [{ type: 'email', value: 'synthetic@example.test' }, { type: 'external_id', value: 'ext:99' }] }],
      contact: null,
    }]);
  });
  it('does not falsely reject unrelated non-PII models with type/value columns, while refusing plaintext nested contacts', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k2: 'b'.repeat(64) } }));
    const suppressionRows = [{ workspaceId: WS_A, type: 'email', value: 'blocked@example.test' }];
    await expect(
      extension.query.$allModels.$allOperations({ model: 'SuppressionRecord', operation: 'findMany', args: {}, query: async () => suppressionRows }),
    ).resolves.toEqual(suppressionRows);

    const plaintextNested = [{ workspaceId: WS_A, contacts: [{ fullName: 'Unencrypted Leak' }] }];
    await expect(
      extension.query.$allModels.$allOperations({ model: 'CanonicalCompany', operation: 'findMany', args: {}, query: async () => plaintextNested }),
    ).rejects.toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
  });
  it('encrypts model writes before querying and decrypts the returned model', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k2: 'b'.repeat(64) } }));
    const enc = encryptPii('Synthetic Person', { workspaceId: WS_A, purpose: PII_PURPOSE.CANONICAL_CONTACT_FULL_NAME });
    const query = vi.fn(async (args: object) => { expect(args).toEqual({ data: { workspaceId: WS_A, fullName: enc } }); return { workspaceId: WS_A, fullName: enc }; });
    expect(await extension.query.$allModels.$allOperations({ model: 'CanonicalContact', operation: 'create', args: { data: { workspaceId: WS_A, fullName: 'Synthetic Person' } }, query })).toEqual({ workspaceId: WS_A, fullName: 'Synthetic Person' });
  });
});
