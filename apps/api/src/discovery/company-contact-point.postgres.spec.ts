import { randomInt, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  companyContactObservation,
  persistCompanyContactPoints,
} from './company-contact-points';

// Explicitly opted-in, disposable and migrated PostgreSQL only. The owner connection (a superuser,
// which bypasses RLS) builds and removes the fixtures; every check of the table runs as app_user,
// whose session must be neither superuser nor BYPASSRLS. Synthetic `.example` companies only.
const ownerUrl = process.env.COMPANY_CONTACT_POINT_TEST_DATABASE_URL;
const appUrl = process.env.COMPANY_CONTACT_POINT_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'company_contact_point test needs both COMPANY_CONTACT_POINT_TEST_DATABASE_URL and COMPANY_CONTACT_POINT_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('company_contact_point test requires a loopback test database');
  }
}

/** The SQLSTATE PostgreSQL raised through a Prisma raw query, or null. */
function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

interface PointRow {
  workspaceId: string;
  companyId: string;
  kind: string;
  value: string;
  status: string;
  statusReason: string | null;
  dataClass: string;
  sourceKind: string;
  providerKey: string;
  parserVersion: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  updatedBy: string | null;
}

/** Lower-case letters only, so no fixture value carries a long digit run. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

describe.runIf(Boolean(ownerUrl && appUrl))('company_contact_point on PostgreSQL (BI-14)', { timeout: 60_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const suffix = letters(6);
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const company = randomUUID();
  const suppressedCompany = randomUUID();
  const domainSuppressedCompany = randomUUID();
  const otherWorkspaceCompany = randomUUID();
  const domain = `pumpen-${suffix}.example`;
  const site = `https://${domain}`;
  const suppressedDomain = `lager-${suffix}.example`;
  const seenAt = new Date('2026-10-11T09:00:00.000Z');

  const row = (overrides: Partial<PointRow> = {}): PointRow => ({
    workspaceId: workspaceA,
    companyId: company,
    kind: 'contact_page',
    value: `${site}/kontakt`,
    status: 'UNVERIFIED',
    statusReason: null,
    dataClass: 'green',
    sourceKind: 'homepage',
    providerKey: 'company_contact',
    parserVersion: 'company_contact/v1',
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    updatedBy: null,
    ...overrides,
  });

  const insert = (tx: Prisma.TransactionClient, point: PointRow) => tx.$executeRaw`
    INSERT INTO company_contact_point (id, workspace_id, company_id, kind, value, status, status_reason,
      data_class, source_kind, provider_key, parser_version, first_seen_at, last_seen_at, updated_by)
    VALUES (${randomUUID()}::uuid, ${point.workspaceId}::uuid, ${point.companyId}::uuid, ${point.kind},
      ${point.value}, ${point.status}, ${point.statusReason}, ${point.dataClass}, ${point.sourceKind},
      ${point.providerKey}, ${point.parserVersion}, ${point.firstSeenAt}, ${point.lastSeenAt}, ${point.updatedBy})`;

  const inWorkspace = <T>(workspace: string | null, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        if (workspace) await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 20_000 },
    );

  class RolledBack extends Error {}
  /** Runs `work` as app_user in `workspace`, always rolls it back, and returns the SQLSTATE it raised. */
  const failure = async (
    workspace: string | null,
    work: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<string | null> => {
    try {
      await inWorkspace(workspace, async (tx) => {
        await work(tx);
        throw new RolledBack();
      });
    } catch (error) {
      return error instanceof RolledBack ? null : sqlState(error) ?? 'other error';
    }
    return null;
  };

  const points = (workspace: string, companyId: string) =>
    inWorkspace(workspace, (tx) =>
      tx.companyContactPoint.findMany({
        where: { companyId },
        orderBy: [{ kind: 'asc' }, { value: 'asc' }],
        select: { kind: true, value: true, status: true, statusReason: true, dataClass: true, providerKey: true },
      }),
    );

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    // RLS is only proven by a principal it applies to: a superuser or BYPASSRLS session passes silently.
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('company_contact_point test must connect the app side as app_user without RLS bypass');
    }
    await owner.$transaction([
      owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
          (${company}::uuid, ${workspaceA}::uuid, ${`Pumpen ${suffix} GmbH`}, ${domain}, 'NEW',
            ${`domain:${domain}`}, now()),
          (${suppressedCompany}::uuid, ${workspaceA}::uuid, ${`Armaturen ${suffix} GmbH`},
            ${`armaturen-${suffix}.example`}, 'SUPPRESSED', ${`domain:armaturen-${suffix}.example`}, now()),
          (${domainSuppressedCompany}::uuid, ${workspaceA}::uuid, ${`Lager ${suffix} GmbH`}, ${suppressedDomain},
            'NEW', ${`domain:${suppressedDomain}`}, now()),
          (${otherWorkspaceCompany}::uuid, ${workspaceB}::uuid, ${`Ventile ${suffix} GmbH`},
            ${`ventile-${suffix}.example`}, 'NEW', ${`domain:ventile-${suffix}.example`}, now())`,
      owner.$executeRaw`
        INSERT INTO suppression_record (id, workspace_id, type, value, reason, protection_class)
        VALUES (${randomUUID()}::uuid, ${workspaceA}::uuid, 'domain', ${suppressedDomain}, 'manual', 'PREFERENCE')`,
      owner.$executeRaw`
        INSERT INTO company_contact_point (id, workspace_id, company_id, kind, value, source_kind, provider_key,
          parser_version, last_seen_at)
        VALUES (${randomUUID()}::uuid, ${workspaceB}::uuid, ${otherWorkspaceCompany}::uuid, 'contact_page',
          ${`https://ventile-${suffix}.example/kontakt`}, 'homepage', 'company_contact', 'company_contact/v1', now())`,
    ]);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      // Deleting the companies removes their points through the composite foreign key.
      await owner.$executeRaw`
        DELETE FROM canonical_company WHERE id IN (${company}::uuid, ${suppressedCompany}::uuid,
          ${domainSuppressedCompany}::uuid, ${otherWorkspaceCompany}::uuid)`;
      await owner.$executeRaw`
        DELETE FROM suppression_record WHERE workspace_id = ${workspaceA}::uuid AND value = ${suppressedDomain}`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('writes, refreshes, removes and revives points through the production writer as app_user', async () => {
    const all = {
      contactPage: `${site}/kontakt`,
      impressumPage: `${site}/impressum`,
      supplierPage: `${site}/lieferanten`,
      linkedinCompanyPage: `https://www.linkedin.com/company/pumpen-${suffix}`,
      xCompanyAccount: `https://x.com/pumpen${suffix}`,
      contactForm: `${site}/kontakt`,
      contactFormChecked: true,
    };
    // Each profile observes the site a minute after the previous one, as successive runs do.
    let profiles = 0;
    const write = (paths: typeof all) => {
      profiles += 1;
      return inWorkspace(workspaceA, (tx) =>
        persistCompanyContactPoints(tx, {
          workspaceId: workspaceA,
          companyId: company,
          observation: companyContactObservation(paths),
          seenAt: new Date(seenAt.getTime() + profiles * 60_000),
        }),
      );
    };

    await expect(write(all)).resolves.toEqual({ written: 6, removed: 0 });
    expect(await points(workspaceA, company)).toEqual(
      [
        ['contact_form', all.contactForm],
        ['contact_page', all.contactPage],
        ['impressum_page', all.impressumPage],
        ['linkedin_company_page', all.linkedinCompanyPage],
        ['supplier_page', all.supplierPage],
        ['x_company_account', all.xCompanyAccount],
      ].map(([kind, value]) => ({
        kind,
        value,
        status: 'UNVERIFIED',
        statusReason: null,
        dataClass: 'green',
        providerKey: 'company_contact',
      })),
    );

    // The supplier page left the site; the form is unknown this time and stays as it was.
    await expect(
      write({ ...all, supplierPage: null, contactForm: null, contactFormChecked: false }),
    ).resolves.toEqual({ written: 4, removed: 1 });
    const afterRemoval = await points(workspaceA, company);
    expect(afterRemoval.find((point) => point.kind === 'supplier_page')).toMatchObject({
      status: 'INVALID',
      statusReason: 'REMOVED_FROM_SITE',
    });
    expect(afterRemoval.find((point) => point.kind === 'contact_form')).toMatchObject({ status: 'UNVERIFIED' });

    // Linked again: the automatic point comes back.
    await expect(write(all)).resolves.toEqual({ written: 6, removed: 0 });
    expect((await points(workspaceA, company)).every((point) => point.status === 'UNVERIFIED')).toBe(true);
  });

  it('never moves last_seen_at backwards when an older observation commits after a newer one', async () => {
    const newer = new Date('2026-10-11T10:00:00.000Z');
    const older = new Date('2026-10-11T08:00:00.000Z');
    const paths = {
      contactPage: `${site}/kontakt`,
      impressumPage: `${site}/impressum`,
      supplierPage: null as string | null,
      linkedinCompanyPage: null,
      xCompanyAccount: null,
      contactForm: null,
      contactFormChecked: false,
    };
    const write = (seenAt: Date, observed: typeof paths) =>
      inWorkspace(workspaceA, (tx) =>
        persistCompanyContactPoints(tx, {
          workspaceId: workspaceA,
          companyId: company,
          observation: companyContactObservation(observed),
          seenAt,
        }),
      );

    // Two runs share the company: the one that observed later commits first and finds a new link.
    await write(newer, { ...paths, supplierPage: `${site}/partner-werden` });
    // The older observation commits second: no CHECK violation, no backwards move, and it does not
    // remove what the newer observation saw.
    await expect(write(older, paths)).resolves.toMatchObject({ removed: 0 });

    const rows = await inWorkspace(workspaceA, (tx) =>
      tx.companyContactPoint.findMany({
        where: { companyId: company, kind: { in: ['contact_page', 'supplier_page'] }, status: 'UNVERIFIED' },
        select: { kind: true, value: true, lastSeenAt: true },
        orderBy: { kind: 'asc' },
      }),
    );
    expect(rows).toEqual([
      { kind: 'contact_page', value: `${site}/kontakt`, lastSeenAt: newer },
      { kind: 'supplier_page', value: `${site}/partner-werden`, lastSeenAt: newer },
    ]);
  });

  it('writes nothing for a SUPPRESSED company or one a domain suppression covers', async () => {
    for (const companyId of [suppressedCompany, domainSuppressedCompany]) {
      const result = await inWorkspace(workspaceA, (tx) =>
        persistCompanyContactPoints(tx, {
          workspaceId: workspaceA,
          companyId,
          observation: companyContactObservation({
            contactPage: `${site}/kontakt`,
            impressumPage: null,
            supplierPage: null,
            linkedinCompanyPage: null,
            xCompanyAccount: null,
            contactForm: null,
            contactFormChecked: true,
          }),
          seenAt,
        }),
      );
      expect(result).toBeNull();
      expect(await points(workspaceA, companyId)).toEqual([]);
    }
  });

  it("isolates workspaces: app_user neither sees nor writes another workspace's points", async () => {
    expect(await points(workspaceA, otherWorkspaceCompany)).toEqual([]);
    expect(await points(workspaceB, otherWorkspaceCompany)).toHaveLength(1);
    expect(
      await inWorkspace(null, (tx) =>
        tx.companyContactPoint.count({ where: { companyId: otherWorkspaceCompany } })),
    ).toBe(0);

    // A row claiming workspace B written from workspace A, or without any workspace: the policy refuses it.
    expect(
      await failure(workspaceA, (tx) =>
        insert(tx, row({ workspaceId: workspaceB, companyId: otherWorkspaceCompany }))),
    ).toBe('42501');
    expect(await failure(null, (tx) => insert(tx, row({ value: `${site}/anfrage` })))).toBe('42501');
    // A point of workspace A on workspace B's company: the composite foreign key refuses it.
    expect(
      await failure(workspaceA, (tx) => insert(tx, row({ companyId: otherWorkspaceCompany }))),
    ).toBe('23503');
  });

  it('admits only green links of the six kinds, with exact LinkedIn and X shapes', async () => {
    const rejected: Array<[string, Partial<PointRow>]> = [
      ['kind outside the list', { kind: 'phone' }],
      ['amber data', { dataClass: 'amber' }],
      ['plain http', { value: `http://${domain}/kontakt` }],
      ['query string', { value: `${site}/kontakt?lang=de` }],
      ['fragment', { value: `${site}/kontakt#form` }],
      ['at sign', { value: `${site}/@kontakt` }],
      // Built at runtime so the source holds no encoded at sign.
      ['percent-encoded at sign', { value: `${site}/kontakt${'%'}${'40'}zz` }],
      ['social host on a same-site kind', { value: 'https://www.linkedin.com/in/zz-sample-slug' }],
      ['X host on a same-site kind', { kind: 'impressum_page', value: 'https://x.com/zzsample' }],
      ['twitter.com host on a same-site kind', { kind: 'supplier_page', value: 'https://mobile.twitter.com/zzsample' }],
      ['social host for the contact form', { kind: 'contact_form', value: 'https://www.linkedin.com/company/zz-sample' }],
      ['whitespace', { value: `${site}/kontakt seite` }],
      ['personal LinkedIn path', { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/in/zz-sample-slug' }],
      ['LinkedIn host not normalised', { kind: 'linkedin_company_page', value: 'https://de.linkedin.com/company/zz-sample' }],
      ['X status URL', { kind: 'x_company_account', value: 'https://x.com/zzsample/status/1' }],
      ['X on twitter.com', { kind: 'x_company_account', value: 'https://twitter.com/zzsample' }],
      ['automatic VALID', { status: 'VALID', statusReason: 'OPERATOR_CONFIRMED' }],
      ['rejection without a person', { status: 'INVALID', statusReason: 'OPERATOR_REJECTED' }],
      ['UNVERIFIED with a reason', { statusReason: 'REMOVED_FROM_SITE' }],
      ['INVALID without a reason', { status: 'INVALID' }],
      ['automatic point from an operator source', { sourceKind: 'operator' }],
      ['unversioned parser', { parserVersion: 'rules' }],
      ['last seen before first seen', { lastSeenAt: new Date('2026-10-01T00:00:00.000Z') }],
    ];
    for (const [reason, overrides] of rejected) {
      expect(await failure(workspaceA, (tx) => insert(tx, row({ value: `${site}/anfrage`, ...overrides }))), reason)
        .toBe('23514');
    }

    const admitted: Array<[string, Partial<PointRow>]> = [
      ['an operator confirmation', { status: 'VALID', statusReason: 'OPERATOR_CONFIRMED', updatedBy: 'operator-1' }],
      ['an operator point', { providerKey: 'operator', sourceKind: 'operator', updatedBy: 'operator-1' }],
      ['customer feedback', { status: 'INVALID', statusReason: 'CUSTOMER_BAD_CONTACT_PATH' }],
      ['a LinkedIn showcase page', { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/showcase/zz-sample' }],
      ['an X account', { kind: 'x_company_account', value: 'https://x.com/zz_sample_q' }],
    ];
    for (const [reason, overrides] of admitted) {
      expect(await failure(workspaceA, (tx) => insert(tx, row({ value: `${site}/anfrage`, ...overrides }))), reason)
        .toBeNull();
    }
  });

  it("lets app_user erase a company's points, and removes them with the company", async () => {
    const erased = await inWorkspace(workspaceA, async (tx) => {
      await insert(tx, row({ value: `${site}/anfrage` }));
      return tx.companyContactPoint.deleteMany({ where: { companyId: { in: [company] } } });
    });
    expect(erased.count).toBeGreaterThanOrEqual(1);
    expect(await points(workspaceA, company)).toEqual([]);

    await owner.$executeRaw`DELETE FROM canonical_company WHERE id = ${otherWorkspaceCompany}::uuid`;
    const [counted] = await owner.$queryRaw<{ remaining: bigint }[]>`
      SELECT count(*) AS remaining FROM company_contact_point WHERE company_id = ${otherWorkspaceCompany}::uuid`;
    expect(counted?.remaining).toBe(0n);
  });
});
