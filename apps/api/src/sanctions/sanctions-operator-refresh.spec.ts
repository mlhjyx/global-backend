import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { PublicHttpResponse } from '../adapters/guarded-http';
import { parseOfacXml } from '../adapters/ofac-xml';
import type { ExecutionBroker } from '../tools/tool-contract';
import { toDesiredEntity } from './sanctions-refresh.service';
import type { PublicHttpRequester } from './sanctions-operator-download';
import {
  SANCTIONS_OPERATOR_DEFAULT_TIMEOUT_SECONDS,
  SANCTIONS_OPERATOR_SOURCE_KEYS,
  assertSanctionsOwnerRole,
  formatSanctionsOperatorReport,
  parseSanctionsOperatorArgs,
  planSanctionsRefresh,
  readDatabaseRole,
  runSanctionsOperatorRefresh,
  type DatabaseRoleFacts,
} from './sanctions-operator-refresh';

/*
 * Operator (B0) refresh orchestration: owner-only, official endpoints only, dry run without
 * writes, writes through SanctionsRefreshService's unreceipted owner path. Names are invented.
 */

const SDN_URL = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
const CONSOLIDATED_URL =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/CONSOLIDATED.XML';
const EU_URL =
  'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw';

const SDN_XML = `<sdnList>
  <publshInformation><Publish_Date>10/09/2026</Publish_Date><Record_Count>3</Record_Count></publshInformation>
  <sdnEntry><uid>71001</uid><lastName>MIRAGE TOOLING LLC</lastName><sdnType>Entity</sdnType><programList><program>IRAN</program></programList></sdnEntry>
  <sdnEntry><uid>71002</uid><lastName>CHIMERA BANK</lastName><sdnType>Entity</sdnType><programList><program>SDGT</program></programList></sdnEntry>
  <sdnEntry><uid>71003</uid><firstName>Invented</firstName><lastName>PERSONA EPSILON</lastName><sdnType>Individual</sdnType></sdnEntry>
</sdnList>`;
const CONSOLIDATED_XML = `<sdnList>
  <publshInformation><Publish_Date>09/14/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry><uid>72001</uid><lastName>SPECTRAL OIL REFINERY</lastName><sdnType>Entity</sdnType><programList><program>SSI</program></programList></sdnEntry>
  <sdnEntry><uid>72002</uid><firstName>Imagined</firstName><lastName>PERSONA ZETA</lastName><sdnType>Individual</sdnType></sdnEntry>
</sdnList>`;
const EU_XML = `<export generationDate="2026-09-22T20:01:34.799+02:00">
  <sanctionEntity logicalId="73001"><subjectType code="enterprise"/><nameAlias wholeName="PHANTOM GRAIN TERMINAL" strong="true"/></sanctionEntity>
  <sanctionEntity logicalId="73002"><subjectType code="person"/><nameAlias wholeName="Ficticia Nemova" strong="true"/></sanctionEntity>
</export>`;
const BODY_BY_URL = new Map([
  [SDN_URL, SDN_XML],
  [CONSOLIDATED_URL, CONSOLIDATED_XML],
  [EU_URL, EU_XML],
]);

const SOURCE_ROWS = [
  { id: '00000000-0000-4000-8000-0000000000e1', key: 'eu_fsf', url: EU_URL, format: 'eu_fsf_xml', config: null, status: 'DISABLED' },
  { id: '00000000-0000-4000-8000-0000000000c1', key: 'ofac_consolidated', url: CONSOLIDATED_URL, format: 'ofac_sdn_xml', config: null, status: 'DISABLED' },
  { id: '00000000-0000-4000-8000-0000000000a1', key: 'ofac_sdn', url: SDN_URL, format: 'ofac_sdn_xml', config: null, status: 'DISABLED' },
];

const OWNER: DatabaseRoleFacts = { role: 'global', superuser: true, ownsSanctionsTables: true };

function guardedAnswer(url: string): PublicHttpResponse {
  const body = Buffer.from(BODY_BY_URL.get(url) ?? '', 'utf8');
  return {
    status: 200,
    ok: true,
    headers: { 'content-type': url === EU_URL ? 'application/xml' : 'text/xml' },
    body,
    text: body.toString('utf8'),
    finalUrl: url === EU_URL ? url : 'https://bucket.s3.us-gov-west-1.amazonaws.com/x.xml?X-Amz-Signature=temporary',
  };
}

interface FakeOwnerOptions {
  role?: DatabaseRoleFacts;
  rows?: typeof SOURCE_ROWS;
  existing?: Map<string, { externalId: string; contentHash: string; withdrawnAt: Date | null }[]>;
}

function fakeOwner(options: FakeOwnerOptions = {}) {
  const role = options.role ?? OWNER;
  const rows = options.rows ?? SOURCE_ROWS;
  const writes: string[] = [];
  const write = (name: string) => vi.fn(async () => {
    writes.push(name);
    return { count: 1 };
  });
  const tx = {
    sanctionsEntity: { createMany: write('entity.createMany'), update: write('entity.update'), updateMany: write('entity.updateMany') },
    sanctionsSource: { update: write('source.update(tx)') },
  };
  const db = {
    $queryRaw: vi.fn(async () => [{ role: role.role, superuser: role.superuser, owned_tables: role.ownsSanctionsTables ? 2 : 0 }]),
    sanctionsSource: {
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        rows.filter((row) => where.key.in.includes(row.key)).sort((a, b) => a.key.localeCompare(b.key))),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('not found');
        return row;
      }),
      update: write('source.update'),
    },
    sanctionsEntity: {
      findMany: vi.fn(async ({ where }: { where: { sourceId: string } }) => options.existing?.get(where.sourceId) ?? []),
      createMany: write('entity.createMany(bare)'),
      update: write('entity.update(bare)'),
      updateMany: write('entity.updateMany(bare)'),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  return { db, tx, writes, client: db as unknown as PrismaClient };
}

const noPause = async (): Promise<void> => undefined;

const allowPolicy = (): Pick<ExecutionBroker, 'checkSourcePolicy'> => ({
  checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
});

describe('parseSanctionsOperatorArgs', () => {
  it('requires an explicit source selection', () => {
    expect(() => parseSanctionsOperatorArgs([])).toThrow(/--source/);
    expect(() => parseSanctionsOperatorArgs(['--dry-run'])).toThrow(/--source/);
  });

  it('expands all to the three official sources in key order', () => {
    expect(parseSanctionsOperatorArgs(['--source=all'])).toEqual({
      kind: 'run',
      options: {
        sourceKeys: ['eu_fsf', 'ofac_consolidated', 'ofac_sdn'],
        dryRun: false,
        timeoutMs: SANCTIONS_OPERATOR_DEFAULT_TIMEOUT_SECONDS * 1000,
      },
    });
    expect(SANCTIONS_OPERATOR_SOURCE_KEYS).toEqual(['eu_fsf', 'ofac_consolidated', 'ofac_sdn']);
  });

  it('takes a de-duplicated comma list, a dry run and a bounded deadline', () => {
    expect(parseSanctionsOperatorArgs(['--source=ofac_sdn,eu_fsf,ofac_sdn', '--dry-run', '--timeout-seconds=120'])).toEqual({
      kind: 'run',
      options: { sourceKeys: ['eu_fsf', 'ofac_sdn'], dryRun: true, timeoutMs: 120_000 },
    });
    expect(parseSanctionsOperatorArgs(['--source', 'ofac_consolidated'])).toMatchObject({
      options: { sourceKeys: ['ofac_consolidated'] },
    });
  });

  it.each([
    [['--source=un_consolidated']],
    [['--source=']],
    [['--source=all,ofac_sdn']],
    [['--source=ofac_sdn', '--timeout-seconds=5']],
    [['--source=ofac_sdn', '--timeout-seconds=1801']],
    [['--source=ofac_sdn', '--timeout-seconds=abc']],
    [['--source=ofac_sdn', '--enable']],
    [['--source=ofac_sdn', 'extra']],
  ])('refuses %j', (argv) => {
    expect(() => parseSanctionsOperatorArgs(argv)).toThrow(/SANCTIONS_OPERATOR_USAGE/);
  });

  it('answers help', () => {
    expect(parseSanctionsOperatorArgs(['--help'])).toEqual({ kind: 'help' });
  });
});

describe('database owner guard', () => {
  it('reads the connected role, superuser flag and ownership of both sanctions tables', async () => {
    const { db } = fakeOwner({ role: { role: 'global', superuser: false, ownsSanctionsTables: true } });
    await expect(readDatabaseRole(db as never)).resolves.toEqual({ role: 'global', superuser: false, ownsSanctionsTables: true });
  });

  it('refuses the runtime app_user with a message that names DATABASE_URL', () => {
    expect(() => assertSanctionsOwnerRole({ role: 'app_user', superuser: false, ownsSanctionsTables: false }))
      .toThrow(/SANCTIONS_OPERATOR_OWNER_REQUIRED.*app_user.*DATABASE_URL/s);
    expect(() => assertSanctionsOwnerRole({ role: 'app_user', superuser: true, ownsSanctionsTables: true }))
      .toThrow(/SANCTIONS_OPERATOR_OWNER_REQUIRED/);
  });

  it('refuses any other role that neither is a superuser nor owns the sanctions tables', () => {
    expect(() => assertSanctionsOwnerRole({ role: 'runtime_worker_login', superuser: false, ownsSanctionsTables: false }))
      .toThrow(/SANCTIONS_OPERATOR_OWNER_REQUIRED.*runtime_worker_login/s);
  });

  it('accepts a superuser or the owner of the sanctions tables', () => {
    expect(() => assertSanctionsOwnerRole(OWNER)).not.toThrow();
    expect(() => assertSanctionsOwnerRole({ role: 'migration_owner', superuser: false, ownsSanctionsTables: true })).not.toThrow();
  });
});

describe('planSanctionsRefresh', () => {
  it('predicts adds, updates, unchanged rows and withdrawals from a read only', async () => {
    const parsed = parseOfacXml(SDN_XML);
    const unchanged = toDesiredEntity(parsed.entities[0]!, '2026-10-09');
    const existing = [
      { externalId: unchanged.externalId, contentHash: unchanged.contentHash, withdrawnAt: null },
      { externalId: '71002', contentHash: 'outdated', withdrawnAt: null },
      { externalId: '70999', contentHash: 'gone', withdrawnAt: null },
    ];
    const findMany = vi.fn(async () => existing);

    const plan = await planSanctionsRefresh({ sanctionsEntity: { findMany } } as never, 'source-id', parsed, new Date('2026-10-10T00:00:00Z'));

    expect(findMany).toHaveBeenCalledWith({
      where: { sourceId: 'source-id' },
      select: { externalId: true, contentHash: true, withdrawnAt: true },
    });
    expect(plan).toEqual({ listVersion: '2026-10-09', existingActive: 3, added: 0, updated: 1, unchanged: 1, withdrawn: 1, shrinkGuardTripped: false });
  });

  it('flags a parse the shrink guard would refuse', async () => {
    const existing = Array.from({ length: 10 }, (_, index) => ({ externalId: `x${index}`, contentHash: 'h', withdrawnAt: null }));
    const plan = await planSanctionsRefresh(
      { sanctionsEntity: { findMany: vi.fn(async () => existing) } } as never,
      'source-id',
      parseOfacXml(SDN_XML),
    );
    expect(plan.shrinkGuardTripped).toBe(true);
  });
});

describe('runSanctionsOperatorRefresh', () => {
  it('refuses app_user before reading a source or touching the network', async () => {
    const { db, client, writes } = fakeOwner({ role: { role: 'app_user', superuser: false, ownsSanctionsTables: false } });
    const request = vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url));

    await expect(runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, sleep: noPause },
      { sourceKeys: ['ofac_sdn'], dryRun: true, timeoutMs: 60_000 },
    )).rejects.toThrow(/SANCTIONS_OPERATOR_OWNER_REQUIRED/);

    expect(db.sanctionsSource.findMany).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses the whole run before any download when one selected row is not an official endpoint', async () => {
    const rows = SOURCE_ROWS.map((row) => (row.key === 'eu_fsf' ? { ...row, url: 'https://lists.attacker.example/eu.xml' } : row));
    const { client, writes } = fakeOwner({ rows });
    const request = vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url));

    await expect(runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, sleep: noPause },
      { sourceKeys: ['eu_fsf', 'ofac_sdn'], dryRun: false, timeoutMs: 60_000 },
    )).rejects.toThrow(/SANCTIONS_OPERATOR_SOURCE_NOT_OFFICIAL/);
    expect(request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses a selected source whose row is missing instead of seeding it', async () => {
    const { client } = fakeOwner({ rows: SOURCE_ROWS.filter((row) => row.key !== 'ofac_consolidated') });
    await expect(runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request: vi.fn<PublicHttpRequester>() },
      { sourceKeys: ['ofac_consolidated'], dryRun: true, timeoutMs: 60_000 },
    )).rejects.toThrow(/SANCTIONS_OPERATOR_SOURCE_MISSING.*ofac_consolidated/s);
  });

  it('dry run downloads, parses and plans every source and writes nothing', async () => {
    const { client, writes } = fakeOwner();
    const request = vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url));
    const log = vi.fn();

    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, log, sleep: noPause },
      { sourceKeys: [...SANCTIONS_OPERATOR_SOURCE_KEYS], dryRun: true, timeoutMs: 60_000 },
    );

    expect(writes).toEqual([]);
    expect(request.mock.calls.map(([url]) => url)).toEqual([EU_URL, CONSOLIDATED_URL, SDN_URL]);
    expect(report).toMatchObject({ ok: true, mode: 'dry-run', role: 'global' });
    expect(report.sources).toEqual([
      expect.objectContaining({
        key: 'eu_fsf', status: 'DRY_RUN',
        census: expect.objectContaining({ publishDate: '2026-09-22', kept: 1, dropped: { person: 1 } }),
        plan: expect.objectContaining({ added: 1, withdrawn: 0, shrinkGuardTripped: false }),
      }),
      expect.objectContaining({
        key: 'ofac_consolidated', status: 'DRY_RUN',
        census: expect.objectContaining({ publishDate: '2026-09-14', kept: 1, dropped: { Individual: 1 } }),
      }),
      expect.objectContaining({
        key: 'ofac_sdn', status: 'DRY_RUN',
        census: expect.objectContaining({ publishDate: '2026-10-09', kept: 2, dropped: { Individual: 1 } }),
        plan: expect.objectContaining({ added: 2 }),
      }),
    ]);
    expect(log).toHaveBeenCalled();
  });

  it('dry run reports a list the shrink guard would refuse as a failure, with its counts', async () => {
    const sdnId = SOURCE_ROWS.find((row) => row.key === 'ofac_sdn')!.id;
    const existing = new Map([[sdnId, Array.from({ length: 10 }, (_, index) => ({
      externalId: `7090${index}`, contentHash: 'stored', withdrawnAt: null,
    }))]]);
    const { client, writes } = fakeOwner({ existing });

    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request: vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url)) },
      { sourceKeys: ['ofac_sdn'], dryRun: true, timeoutMs: 60_000 },
    );

    expect(writes).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.sources[0]).toMatchObject({
      key: 'ofac_sdn',
      status: 'FAILED',
      error: 'SANCTIONS_OPERATOR_SHRINK_GUARD_WOULD_REFUSE: parsed 2 vs active 10',
      census: { kept: 2 },
      plan: { shrinkGuardTripped: true, withdrawn: 10, added: 2 },
    });
    expect(formatSanctionsOperatorReport(report).join('\n')).toContain('shrink guard WOULD REFUSE');
  });

  it('dry run reports a failed download and keeps going without writing', async () => {
    const { client, writes } = fakeOwner();
    const request = vi.fn<PublicHttpRequester>(async (url) => {
      if (url === SDN_URL) throw new Error('public_http_timeout');
      return guardedAnswer(url);
    });

    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, sleep: noPause },
      { sourceKeys: ['ofac_consolidated', 'ofac_sdn'], dryRun: true, timeoutMs: 60_000 },
    );

    expect(writes).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.sources.map((source) => [source.key, source.status, source.error])).toEqual([
      ['ofac_consolidated', 'DRY_RUN', undefined],
      ['ofac_sdn', 'FAILED', 'SANCTIONS_OPERATOR_DOWNLOAD_FAILED: public_http_timeout'],
    ]);
  });

  it('writes through the owner transaction of the refresh service and never the status column', async () => {
    const { db, client, writes } = fakeOwner();
    const request = vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url));

    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, sleep: noPause },
      { sourceKeys: ['ofac_sdn'], dryRun: false, timeoutMs: 60_000 },
    );

    expect(report).toMatchObject({ ok: true, mode: 'write' });
    expect(report.sources).toEqual([
      expect.objectContaining({
        key: 'ofac_sdn', status: 'DONE',
        summary: expect.objectContaining({ status: 'DONE', total: 2, added: 2, publishDate: '2026-10-09' }),
        census: expect.objectContaining({ kept: 2, dropped: { Individual: 1 } }),
        download: expect.objectContaining({ finalHost: 'bucket.s3.us-gov-west-1.amazonaws.com' }),
      }),
    ]);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(writes).toEqual(['entity.createMany', 'source.update(tx)']);
    for (const call of [...db.sanctionsSource.update.mock.calls]) expect(JSON.stringify(call)).not.toContain('"status"');
  });

  it('marks only the failed source FAILED, keeps refreshing the others and reports failure', async () => {
    const { db, client } = fakeOwner();
    // A socket reset carries Node's extra own fields; the service would treat that shape as a
    // control failure and stop, so the download port must hand it over as a plain failure.
    const reset = Object.assign(new Error('read ECONNRESET'), { errno: -104, code: 'ECONNRESET', syscall: 'read' });
    const request = vi.fn<PublicHttpRequester>(async (url) => {
      if (url === EU_URL) throw reset;
      return guardedAnswer(url);
    });

    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request, sleep: noPause },
      { sourceKeys: ['eu_fsf', 'ofac_sdn'], dryRun: false, timeoutMs: 60_000 },
    );

    expect(report.ok).toBe(false);
    expect(report.sources.map((source) => [source.key, source.status])).toEqual([['eu_fsf', 'FAILED'], ['ofac_sdn', 'DONE']]);
    expect(report.sources[0]!.error).toBe('SANCTIONS_OPERATOR_DOWNLOAD_FAILED: ECONNRESET');
    expect(db.sanctionsSource.update).toHaveBeenCalledWith({
      where: { id: SOURCE_ROWS[0]!.id },
      data: { lastRefreshedAt: expect.any(Date), lastFetchStatus: 'FAILED' },
    });
  });
});

describe('formatSanctionsOperatorReport', () => {
  it('prints counts and dates per source without URLs, query strings or names', async () => {
    const { client } = fakeOwner();
    const report = await runSanctionsOperatorRefresh(
      { owner: client, sourcePolicy: allowPolicy(), request: vi.fn<PublicHttpRequester>(async (url) => guardedAnswer(url)) },
      { sourceKeys: [...SANCTIONS_OPERATOR_SOURCE_KEYS], dryRun: true, timeoutMs: 60_000 },
    );

    const text = formatSanctionsOperatorReport(report).join('\n');

    expect(text).toContain('ofac_sdn');
    expect(text).toContain('2026-10-09');
    expect(text).toMatch(/kept 2/);
    expect(text).toMatch(/Individual 1/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/X-Amz|token=/);
    expect(text.toLowerCase()).not.toMatch(/persona|ficticia|nemova|invented|imagined/);
  });
});
