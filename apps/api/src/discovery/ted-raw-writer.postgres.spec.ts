import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mapNoticeToRecords } from './providers/ted.provider';
import { prepareRawSourceBatch, type PreparedRawSourceRow } from './raw-source-ingestion';
import { persistPreparedRawSourceRecord } from './raw-source-writer';

// Reuse the CI's explicit disposable Postgres opt-in; never accepts the live test DB.
const enabled = process.env.RAW_SOURCE_POLICY_DATABASE_TEST === '1';
const ownerUrl = process.env.RAW_SOURCE_POLICY_TEST_DATABASE_URL;
const appUrl = process.env.RAW_SOURCE_POLICY_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) throw new Error('TED writer test requires both disposable URLs');
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (url.protocol !== 'postgresql:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/global_test') throw new Error('TED writer test requires loopback global_test');
}
const ROLLBACK = new Error('TED fixture rollback');
type Payload = { attributes: { ted: Record<string, unknown> } } & Record<string, unknown>;

describe.runIf(enabled)('TED role metadata through the actual PostgreSQL writer', { timeout: 60_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;
  let priorProvider: string | null;
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const policyId = randomUUID();

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const existing = await owner.sourcePolicy.findUnique({ where: { domain: 'api.ted.europa.eu' } });
    if (existing) throw new Error('TED policy already exists; use the dedicated disposable database');
    const provider = await owner.dataProvider.findUnique({ where: { key: 'ted' } });
    priorProvider = provider?.status ?? null;
    await owner.dataProvider.upsert({ where: { key: 'ted' }, update: { status: 'ENABLED' },
      create: { key: 'ted', class: 'public_intelligence', status: 'ENABLED' } });
    await owner.sourcePolicy.create({ data: { id: policyId, domain: 'api.ted.europa.eu',
      sourceType: 'official_website', accessMode: 'api', allowedPurpose: ['discovery'],
      retentionDays: 365, reviewStatus: 'APPROVED', notes: 'TED raw writer regression fixture' } });
    await owner.$executeRaw`INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,materialization_contract_version)
      VALUES (${runId}::uuid,${workspaceId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,
      'RUNNING','discovery-company-materialization/v1')`;
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.$executeRaw`DELETE FROM discovery_run WHERE id=${runId}::uuid`;
      await owner.sourcePolicy.deleteMany({ where: { id: policyId } });
      if (priorProvider === null) await owner.dataProvider.deleteMany({ where: { key: 'ted' } });
      else if (priorProvider !== undefined) await owner.dataProvider.update({ where: { key: 'ted' }, data: { status: priorProvider } });
    } finally { await Promise.all([owner.$disconnect(), app?.$disconnect()]); }
  });

  async function prepared(): Promise<PreparedRawSourceRow> {
    const record = mapNoticeToRecords({ publicationNumber: '123456-2026',
      publicationDate: '2026-11-19', noticeType: 'can-standard', cpvCodes: ['42122000'],
      buyerNames: ['Fixture Municipality'], buyerCountries: ['DEU'],
      winners: [{ name: 'Fixture Pump Company', country: 'NLD', identifier: 'NL-REG-ALPHA' }],
    }, '2026-11-19T00:00:00.000Z')[0]!;
    const policies = await app.sourcePolicy.findMany();
    const row = prepareRawSourceBatch({ providerKey: 'ted', records: [record], policies }).rows[0]!;
    expect(row.ingestStatus).toBe('ACCEPTED');
    return row;
  }

  async function inApp<T>(run: (tx: Prisma.TransactionClient) => Promise<T>, tenant = workspaceId): Promise<T> {
    let result: T;
    await app.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.current_workspace_id',${tenant},true)`;
      result = await run(tx);
      throw ROLLBACK;
    }).catch(error => { if (error !== ROLLBACK) throw error; });
    return result!;
  }

  const write = (tx: Prisma.TransactionClient, row: PreparedRawSourceRow) => persistPreparedRawSourceRecord(tx,
    { workspaceId, runId, sourceEntityId: null, providerKey: 'ted', sourceClass: 'public_intelligence', row });

  it('keeps buyer/winner relationships and winner country through mapper, prepare, app_user and readback', async () => {
    const row = await prepared();
    await inApp(async tx => {
      const receipt = await write(tx, row);
      const stored = await tx.rawSourceRecord.findUniqueOrThrow({ where: { id: receipt.id } });
      expect(stored.payload).toEqual(row.payload);
      expect(stored.payload).toMatchObject({ country: 'NL', attributes: { ted: {
        self_role: 'winner', relationships: [
          { role: 'buyer', country: 'DE' }, { role: 'winner', country: 'NL', identifier: 'NL-REG-ALPHA' },
        ],
      } } });
      expect(JSON.stringify(stored.payload)).not.toContain('Fixture Municipality');
      expect((await write(tx, row)).id).toBe(receipt.id);
      expect((await write(tx, row)).inserted).toBe(false);
    });
  });

  it.each([['self_role'], ['relationships'], ['self_role', 'relationships']])('keeps legacy records without %j', async (...keys) => {
    const row = await prepared();
    const payload = structuredClone(row.payload) as Payload;
    for (const key of keys) delete payload.attributes.ted[key];
    await inApp(tx => write(tx, { ...row, payload }));
  });

  it.each([
    { self_role: null }, { self_role: 'supplier' }, { self_role: ['winner'] },
    { relationships: null }, { relationships: [] }, { relationships: [null] },
    { relationships: [{}] }, { relationships: [{ role: null }] },
    { relationships: [{ role: 'supplier' }] },
    { relationships: [{ role: 'winner', country: 'DEU' }] },
    { relationships: [{ role: 'winner', country: 'de' }] },
    { relationships: [{ role: 'winner', country: null }] },
    { relationships: [{ role: 'winner', name: 'Unminimized Name' }] },
    { relationships: [{ role: 'winner', email: 'person@example.invalid' }] },
    { relationships: [{ role: 'winner', identifier: '5551234567' }] },
    { relationships: [{ role: 'winner', identifier: 'Bearer abcdefghijklmnopqrstuvwxyz' }] },
    { relationships: Array.from({ length: 21 }, () => ({ role: 'buyer' })) },
    { relationships: [{ role: 'winner', extra: { nested: { nested: { nested: true } } } }] },
  ])('rejects forged role metadata at the database boundary: %j', async patch => {
    const row = await prepared();
    const payload = structuredClone(row.payload) as Payload;
    Object.assign(payload.attributes.ted, patch);
    await expect(inApp(tx => write(tx, { ...row, payload }))).rejects.toThrow(/RAW_SOURCE_WRITER_PAYLOAD_/u);
  });

  it('accepts the existing effective 20-item bound', async () => {
    const row = await prepared();
    const payload = structuredClone(row.payload) as Payload;
    payload.attributes.ted.relationships = Array.from({ length: 20 }, () => ({ role: 'buyer', country: 'DE' }));
    await inApp(tx => write(tx, { ...row, payload }));
  });

  it('does not bypass a suspended source policy for valid role metadata', async () => {
    const row = await prepared();
    await owner.sourcePolicy.update({ where: { id: policyId }, data: { reviewStatus: 'SUSPENDED' } });
    try { await expect(inApp(tx => write(tx, row))).rejects.toThrow(/RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u); }
    finally { await owner.sourcePolicy.update({ where: { id: policyId }, data: { reviewStatus: 'APPROVED' } }); }
  });

  it('cannot write another workspace even with otherwise valid metadata', async () => {
    const row = await prepared();
    await expect(inApp(tx => write(tx, row), randomUUID())).rejects.toThrow(/RAW_SOURCE_WRITER_DENIED/u);
  });
});
