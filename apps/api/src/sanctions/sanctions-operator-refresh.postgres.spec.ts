import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PublicHttpResponse } from '../adapters/guarded-http';
import type { PrismaService } from '../prisma/prisma.service';
import { UnavailableRateLimitStore } from '../tools/redis-rate-limit-store';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';
import type { PublicHttpRequester } from './sanctions-operator-download';
import { runSanctionsOperatorRefresh, type SanctionsOperatorOptions } from './sanctions-operator-refresh';
import { SanctionsScreeningService } from './sanctions-screening.service';
import { SANCTIONS_SOURCE_SEEDS, seedSanctions } from './sanctions-seed';

/*
 * Operator (B0) refresh against a migrated PostgreSQL: the owner connection writes the three
 * official sources through SanctionsRefreshService's unreceipted transaction, only entities land,
 * the refresh metadata moves while `status` never does, a repeat writes nothing new, a failure
 * inside the write leaves the previous list intact, and app_user is refused. The network is a
 * fake that serves synthetic lists (every name invented); the real guarded adapter is covered by
 * its own tests.
 *
 * Explicitly opted-in, disposable and migrated PostgreSQL only:
 * SANCTIONS_OPERATOR_REFRESH_DATABASE_TEST=1 with an owner URL and an app_user URL, both on a
 * loopback host and a test database name. Rows this suite creates are removed afterwards.
 */
const enabled = process.env.SANCTIONS_OPERATOR_REFRESH_DATABASE_TEST === '1';
const ownerUrl = process.env.SANCTIONS_OPERATOR_REFRESH_TEST_DATABASE_URL;
const appUrl = process.env.SANCTIONS_OPERATOR_REFRESH_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) {
  throw new Error(
    'SANCTIONS_OPERATOR_REFRESH_DATABASE_TEST=1 needs SANCTIONS_OPERATOR_REFRESH_TEST_DATABASE_URL and SANCTIONS_OPERATOR_REFRESH_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !['/global_test', '/sanctions_operator_refresh_test'].includes(url.pathname)
  ) {
    throw new Error('sanctions operator refresh test requires a loopback test database');
  }
}

const KEYS = ['eu_fsf', 'ofac_consolidated', 'ofac_sdn'] as const;
const URL_BY_KEY = new Map(SANCTIONS_SOURCE_SEEDS.map((seed) => [seed.key, seed.url]));
const POLICY_DOMAINS = ['sanctionslistservice.ofac.treas.gov', 'webgate.ec.europa.eu'];
const OFAC_DOMAIN = 'sanctionslistservice.ofac.treas.gov';
const FAIL_FUNCTION = 'sanctions_operator_refresh_spec_fail_done';
const FAIL_TRIGGER = 'sanctions_operator_refresh_spec_fail_done';

const PEOPLE = ['persona theta', 'notaperson', 'persona iota', 'fakeforename', 'persona kappa', 'ficta', 'nonexista', 'personova'];

const ofacList = (publishDate: string, entries: string) => `<?xml version="1.0" standalone="yes"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation><Publish_Date>${publishDate}</Publish_Date><Record_Count>0</Record_Count></publshInformation>
${entries}
</sdnList>`;
const entity = (uid: string, name: string, program: string, country = 'Iran') =>
  `  <sdnEntry><uid>${uid}</uid><lastName>${name}</lastName><sdnType>Entity</sdnType><programList><program>${program}</program></programList><addressList><address><uid>${uid}0</uid><country>${country}</country></address></addressList></sdnEntry>`;
const person = (uid: string, first: string, last: string) =>
  `  <sdnEntry><uid>${uid}</uid><firstName>${first}</firstName><lastName>${last}</lastName><sdnType>Individual</sdnType><programList><program>SDGT</program></programList><dateOfBirthList><dateOfBirthItem><uid>${uid}1</uid><dateOfBirth>1960</dateOfBirth></dateOfBirthItem></dateOfBirthList></sdnEntry>`;
const craft = (uid: string, name: string, type: 'Vessel' | 'Aircraft') =>
  `  <sdnEntry><uid>${uid}</uid><lastName>${name}</lastName><sdnType>${type}</sdnType><programList><program>IRAN</program></programList></sdnEntry>`;

const SDN_V1 = ofacList('10/01/2026', [
  entity('60001', 'ILLUSORY ALLOYS COMPANY', 'IRAN'),
  entity('60002', 'MYTHIC PETROCHEMICAL TRADING', 'IRAN-EO13846'),
  entity('60003', 'SPURIOUS SHIPPING AGENCY', 'SDGT', 'Syria'),
  person('60004', 'Notaperson', 'PERSONA THETA'),
  person('60005', 'Fakeforename', 'PERSONA IOTA'),
  craft('60006', 'IMAGINARY STAR', 'Vessel'),
  craft('60007', 'EP-FAKE1', 'Aircraft'),
].join('\n'));
const SDN_V2 = ofacList('10/08/2026', [
  entity('60001', 'ILLUSORY ALLOYS COMPANY', 'IRAN'),
  entity('60003', 'SPURIOUS SHIPPING AGENCY', 'SYRIA-EO13894', 'Syria'),
  entity('60008', 'CHIMERICAL DRONE WORKS', 'IRAN-CON-ARMS-EO'),
  person('60004', 'Notaperson', 'PERSONA THETA'),
].join('\n'));
const SDN_V3 = ofacList('10/09/2026', [
  entity('60001', 'ILLUSORY ALLOYS COMPANY', 'IRAN'),
  entity('60003', 'SPURIOUS SHIPPING AGENCY', 'SYRIA-EO13894', 'Syria'),
  entity('60008', 'CHIMERICAL DRONE WORKS', 'IRAN-CON-ARMS-EO'),
  entity('60009', 'APOCRYPHAL MINING LLC', 'RUSSIA-EO14024', 'Russia'),
].join('\n'));
const CONSOLIDATED_V1 = ofacList('09/14/2026', [
  entity('61001', 'VIRTUAL GAS DISTRIBUTION', 'SSI', 'Russia'),
  entity('61002', 'FABRICATED DEFENSE HOLDING', 'UKRAINE-EO13662', 'Russia'),
  person('61003', 'Ficta', 'PERSONA KAPPA'),
].join('\n'));
const EU_V1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-09-22T20:01:34.799+02:00" globalFileId="900003">
  <sanctionEntity euReferenceNumber="EU.9003.01" logicalId="62001">
    <regulation programme="RUS" logicalId="1"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="PRETEND AVIATION PLANT JSC" strong="true" logicalId="2"/>
    <nameAlias wholeName="PAP JSC" strong="false" logicalId="3"/>
    <address countryDescription="RUSSIAN FEDERATION" country="RU" logicalId="4"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9003.02" logicalId="62002">
    <regulation programme="RUS" logicalId="5"/>
    <subjectType code="person" classificationCode="P"/>
    <nameAlias firstName="Nonexista" lastName="Personova" wholeName="Nonexista Personova" strong="true" logicalId="6"/>
    <birthdate birthdate="1971-02-03" logicalId="7"/>
  </sanctionEntity>
  <sanctionEntity euReferenceNumber="EU.9003.03" logicalId="62003">
    <regulation programme="BLR" logicalId="8"/>
    <subjectType code="enterprise" classificationCode="E"/>
    <nameAlias wholeName="HYPOTHETICAL FERTILISER EXPORT" strong="true" logicalId="9"/>
  </sanctionEntity>
</export>`;

interface EntitySnapshot {
  key: string;
  id: string;
  externalId: string;
  primaryName: string;
  aliases: unknown;
  programs: unknown;
  contentHash: string;
  listVersion: string;
  firstSeenAt: Date;
  withdrawnAt: Date | null;
}

describe.runIf(enabled)('Sanctions operator refresh on PostgreSQL', { timeout: 120_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const createdSources: string[] = [];
  const createdPolicies: string[] = [];
  const statusBefore = new Map<string, string>();
  const lists = new Map<string, string>();
  const request = vi.fn<PublicHttpRequester>(async (url): Promise<PublicHttpResponse> => {
    const body = Buffer.from(lists.get(url) ?? '', 'utf8');
    const ofac = url.includes('ofac.treas.gov');
    return {
      status: 200,
      ok: true,
      headers: { 'content-type': ofac ? 'text/xml' : 'application/xml' },
      body,
      text: body.toString('utf8'),
      finalUrl: ofac ? 'https://published-lists.s3.us-gov-west-1.amazonaws.com/list.xml?X-Amz-Signature=test' : url,
    };
  });

  const serve = (key: string, xml: string) => lists.set(URL_BY_KEY.get(key)!, xml);
  const run = (db: PrismaClient, options: Partial<SanctionsOperatorOptions> = {}) =>
    runSanctionsOperatorRefresh(
      {
        owner: db,
        sourcePolicy: buildToolBroker({
          sourcePolicyReader: sourcePolicyReaderFrom(db),
          limiter: new UnavailableRateLimitStore('spec'),
        }),
        request,
      },
      { sourceKeys: [...KEYS], dryRun: false, timeoutMs: 60_000, ...options },
    );

  async function entities(): Promise<EntitySnapshot[]> {
    return owner.$queryRaw<EntitySnapshot[]>`
      SELECT s.key, e.id::text AS id, e.external_id AS "externalId", e.primary_name AS "primaryName",
             e.aliases, e.programs, e.content_hash AS "contentHash", e.list_version AS "listVersion",
             e.first_seen_at AS "firstSeenAt", e.withdrawn_at AS "withdrawnAt"
        FROM sanctions_entity e JOIN sanctions_source s ON s.id = e.source_id
       WHERE s.key IN ('eu_fsf', 'ofac_consolidated', 'ofac_sdn')
       ORDER BY s.key, e.external_id`;
  }

  async function sources() {
    return owner.sanctionsSource.findMany({
      where: { key: { in: [...KEYS] } },
      orderBy: { key: 'asc' },
      select: {
        key: true, status: true, recordCount: true, publishDate: true, lastRefreshedAt: true, lastFetchStatus: true,
      },
    });
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const prior = await owner.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM sanctions_entity e JOIN sanctions_source s ON s.id = e.source_id
       WHERE s.key IN ('eu_fsf', 'ofac_consolidated', 'ofac_sdn')`;
    if (prior[0]!.count !== 0) {
      throw new Error('the test database already holds official sanctions entities; use a fresh disposable database');
    }
    const existingSources = new Set((await owner.sanctionsSource.findMany({ select: { key: true } })).map((row) => row.key));
    const existingPolicies = new Set(
      (await owner.sourcePolicy.findMany({ where: { domain: { in: POLICY_DOMAINS } }, select: { domain: true } }))
        .map((row) => row.domain),
    );
    await seedSanctions(owner);
    createdSources.push(...KEYS.filter((key) => !existingSources.has(key)));
    createdPolicies.push(...POLICY_DOMAINS.filter((domain) => !existingPolicies.has(domain)));
    for (const row of await sources()) statusBefore.set(row.key, row.status);
    serve('ofac_sdn', SDN_V1);
    serve('ofac_consolidated', CONSOLIDATED_V1);
    serve('eu_fsf', EU_V1);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON sanctions_source`);
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FAIL_FUNCTION}()`);
      await owner.$executeRaw`
        DELETE FROM sanctions_entity e USING sanctions_source s
         WHERE s.id = e.source_id AND s.key IN ('eu_fsf', 'ofac_consolidated', 'ofac_sdn')`;
      await owner.sanctionsSource.deleteMany({ where: { key: { in: createdSources } } });
      await owner.sourcePolicy.deleteMany({ where: { domain: { in: createdPolicies } } });
    } finally {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    }
  });

  it('refuses the runtime app_user before it reads a source or downloads anything', async () => {
    await expect(run(app)).rejects.toThrow(/SANCTIONS_OPERATOR_OWNER_REQUIRED.*app_user/s);
    expect(request).not.toHaveBeenCalled();
    expect(await entities()).toEqual([]);
  });

  it('dry run downloads, counts and plans every list without writing a row', async () => {
    const before = await sources();

    const report = await run(owner, { dryRun: true });

    expect(report.ok).toBe(true);
    expect(report.sources.map((source) => [source.key, source.status, source.census?.kept, source.census?.dropped, source.plan?.added]))
      .toEqual([
        ['eu_fsf', 'DRY_RUN', 2, { person: 1 }, 2],
        ['ofac_consolidated', 'DRY_RUN', 2, { Individual: 1 }, 2],
        ['ofac_sdn', 'DRY_RUN', 3, { Individual: 2, Vessel: 1, Aircraft: 1 }, 3],
      ]);
    expect(await entities()).toEqual([]);
    expect(await sources()).toEqual(before);
  });

  it('writes entities only, records the refresh metadata and leaves status untouched', async () => {
    const started = new Date(Date.now() - 1_000);

    const report = await run(owner);

    expect(report.ok).toBe(true);
    expect(report.sources.map((source) => [source.key, source.status, source.summary?.added])).toEqual([
      ['eu_fsf', 'DONE', 2],
      ['ofac_consolidated', 'DONE', 2],
      ['ofac_sdn', 'DONE', 3],
    ]);
    const rows = await entities();
    expect(rows.map((row) => [row.key, row.externalId])).toEqual([
      ['eu_fsf', '62001'], ['eu_fsf', '62003'],
      ['ofac_consolidated', '61001'], ['ofac_consolidated', '61002'],
      ['ofac_sdn', '60001'], ['ofac_sdn', '60002'], ['ofac_sdn', '60003'],
    ]);
    const stored = JSON.stringify(rows).toLowerCase();
    for (const name of PEOPLE) expect(stored).not.toContain(name);
    const personIds = await owner.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM sanctions_entity
       WHERE external_id IN ('60004', '60005', '60006', '60007', '61003', '62002')`;
    expect(personIds[0]!.count).toBe(0);

    const after = await sources();
    expect(after.map((row) => [row.key, row.recordCount, row.publishDate?.toISOString().slice(0, 10), row.lastFetchStatus]))
      .toEqual([
        ['eu_fsf', 2, '2026-09-22', 'DONE'],
        ['ofac_consolidated', 2, '2026-09-14', 'DONE'],
        ['ofac_sdn', 3, '2026-10-01', 'DONE'],
      ]);
    for (const row of after) {
      expect(row.lastRefreshedAt!.getTime()).toBeGreaterThanOrEqual(started.getTime());
      expect(row.status).toBe(statusBefore.get(row.key));
    }
  });

  it('a second run of the same lists adds, changes and withdraws nothing', async () => {
    const before = await entities();

    const report = await run(owner);

    expect(report.ok).toBe(true);
    for (const source of report.sources) {
      expect(source.summary).toMatchObject({ status: 'DONE', added: 0, updated: 0, withdrawn: 0 });
      expect(source.summary!.unchanged).toBe(source.summary!.total);
    }
    expect(await entities()).toEqual(before);
    expect((await sources()).map((row) => row.status)).toEqual(KEYS.map((key) => statusBefore.get(key)));
  });

  it('a newer list adds, updates and withdraws through the same versioning', async () => {
    serve('ofac_sdn', SDN_V2);

    const report = await run(owner, { sourceKeys: ['ofac_sdn'] });

    expect(report.sources).toEqual([
      expect.objectContaining({
        key: 'ofac_sdn', status: 'DONE',
        summary: expect.objectContaining({ added: 1, updated: 1, unchanged: 1, withdrawn: 1, total: 3, publishDate: '2026-10-08' }),
        census: expect.objectContaining({ kept: 3, dropped: { Individual: 1 } }),
      }),
    ]);
    const sdn = (await entities()).filter((row) => row.key === 'ofac_sdn');
    expect(sdn.map((row) => [row.externalId, row.listVersion, row.withdrawnAt === null])).toEqual([
      ['60001', '2026-10-08', true],
      ['60002', '2026-10-01', false],
      ['60003', '2026-10-08', true],
      ['60008', '2026-10-08', true],
    ]);
    expect(sdn.find((row) => row.externalId === '60003')!.programs).toEqual(['SYRIA-EO13894']);
    const row = (await sources()).find((candidate) => candidate.key === 'ofac_sdn')!;
    expect([row.recordCount, row.publishDate?.toISOString().slice(0, 10), row.status]).toEqual([3, '2026-10-08', statusBefore.get('ofac_sdn')]);
  });

  it('a failure inside the write rolls the whole list back and marks the source FAILED', async () => {
    const before = await entities();
    const sourceBefore = (await sources()).find((row) => row.key === 'ofac_sdn')!;
    await owner.$executeRawUnsafe(`
      CREATE FUNCTION ${FAIL_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected failure before commit';
      END $$`);
    await owner.$executeRawUnsafe(`
      CREATE TRIGGER ${FAIL_TRIGGER} BEFORE UPDATE ON sanctions_source
      FOR EACH ROW WHEN (NEW.last_fetch_status = 'DONE') EXECUTE FUNCTION ${FAIL_FUNCTION}()`);
    serve('ofac_sdn', SDN_V3);
    try {
      // A database failure is not an ordinary list failure: the service marks the source FAILED
      // and stops the run rather than guessing (fail closed).
      await expect(run(owner, { sourceKeys: ['ofac_sdn'] })).rejects.toThrow(/injected failure before commit/);
    } finally {
      await owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON sanctions_source`);
      await owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FAIL_FUNCTION}()`);
      serve('ofac_sdn', SDN_V2);
    }
    expect(await entities()).toEqual(before);
    const sourceAfter = (await sources()).find((row) => row.key === 'ofac_sdn')!;
    expect(sourceAfter).toMatchObject({
      status: sourceBefore.status,
      recordCount: sourceBefore.recordCount,
      publishDate: sourceBefore.publishDate,
      lastFetchStatus: 'FAILED',
    });
  });

  it('a suspended source policy refuses the download and keeps the stored list', async () => {
    const before = await entities();
    request.mockClear();
    await owner.sourcePolicy.update({ where: { domain: OFAC_DOMAIN }, data: { reviewStatus: 'SUSPENDED' } });
    try {
      const report = await run(owner, { sourceKeys: ['ofac_consolidated'] });

      expect(report.sources[0]).toMatchObject({ key: 'ofac_consolidated', status: 'FAILED' });
      expect(report.sources[0]!.error).toMatch(/SANCTIONS_OPERATOR_SOURCE_POLICY_SUSPENDED/);
      expect(request).not.toHaveBeenCalled();
    } finally {
      await owner.sourcePolicy.update({ where: { domain: OFAC_DOMAIN }, data: { reviewStatus: 'APPROVED' } });
    }
    expect(await entities()).toEqual(before);
  });

  it('re-running after failures restores DONE without changing a stored row', async () => {
    const before = await entities();
    expect((await sources()).map((row) => row.lastFetchStatus)).toEqual(['DONE', 'FAILED', 'FAILED']);

    const report = await run(owner);

    expect(report.ok).toBe(true);
    for (const source of report.sources) {
      expect(source.summary).toMatchObject({ status: 'DONE', added: 0, updated: 0, withdrawn: 0 });
    }
    expect(await entities()).toEqual(before);
    expect((await sources()).map((row) => [row.lastFetchStatus, row.status])).toEqual(
      KEYS.map((key) => ['DONE', statusBefore.get(key)]),
    );
  });

  it('the documented enable step, and only it, puts the refreshed rows into the app_user screening index', async () => {
    const index = new SanctionsScreeningService(app as unknown as PrismaService);
    await index.rebuildIndex();
    const disabledEverywhere = [...statusBefore.values()].every((status) => status === 'DISABLED');
    if (disabledEverywhere) expect(index.isActive()).toBe(false);

    try {
      const enabled = await owner.$executeRaw`
        UPDATE sanctions_source SET status = 'ENABLED', updated_at = now()
         WHERE key IN ('ofac_sdn', 'ofac_consolidated', 'eu_fsf')
           AND last_fetch_status = 'DONE' AND record_count > 0`;
      expect(enabled).toBe(3);
      await index.rebuildIndex();

      expect(index.isActive()).toBe(true);
      expect(index.screen('Pretend Aviation Plant JSC', 'RU').status).toBe('potential_match');
      expect(index.screen('Persona Kappa', null).status).toBe('clear');
    } finally {
      for (const [key, status] of statusBefore) {
        await owner.sanctionsSource.update({ where: { key }, data: { status } });
      }
    }
    await index.rebuildIndex();
    if (disabledEverywhere) expect(index.isActive()).toBe(false);
  });
});
