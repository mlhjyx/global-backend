import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { piiExtension } from './pii-crypto.extension';
import { encryptPii } from './pii-crypto';

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
    expect(await extension.client.withWorkspace('workspace-a', async (value) => { expect(value).toBe(tx); order.push('work'); return 'result'; }, options)).toBe('result');
    expect(order).toEqual(['scope', 'work']);
    expect(tx.$executeRaw.mock.calls[0]).toContain('workspace-a');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), options);
  });
  it('decrypts included contacts and contact points for unrelated parent models', async () => {
    vi.stubEnv('PII_ENCRYPTION_KEY', 'b'.repeat(64));
    const rows = [{ contacts: [{ fullName: encryptPii('Synthetic Person'), contactPoints: [{ value: encryptPii('synthetic@example.test') }] }], contact: null }];
    const result = await extension.query.$allModels.$allOperations({ model: 'CanonicalCompany', operation: 'findMany', args: {}, query: async () => rows });
    expect(result).toEqual([{ contacts: [{ fullName: 'Synthetic Person', contactPoints: [{ value: 'synthetic@example.test' }] }], contact: null }]);
  });
  it('encrypts model writes before querying and decrypts the returned model', async () => {
    vi.stubEnv('PII_ENCRYPTION_KEY', 'b'.repeat(64));
    const query = vi.fn(async (args: object) => { expect(args).toEqual({ data: { fullName: encryptPii('Synthetic Person') } }); return { fullName: encryptPii('Synthetic Person') }; });
    expect(await extension.query.$allModels.$allOperations({ model: 'CanonicalContact', operation: 'create', args: { data: { fullName: 'Synthetic Person' } }, query })).toEqual({ fullName: 'Synthetic Person' });
  });
});
