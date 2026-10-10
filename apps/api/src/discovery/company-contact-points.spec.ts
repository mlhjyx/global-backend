import { describe, expect, it, vi } from 'vitest';
import {
  COMPANY_CONTACT_PARSER_VERSION,
  COMPANY_CONTACT_PROVIDER_KEY,
  companyContactObservation,
  persistCompanyContactPoints,
} from './company-contact-points';

// Synthetic `.example` company and made-up slugs and handles only.
const WORKSPACE = '00000000-0000-4000-8000-0000000000a1';
const COMPANY = '00000000-0000-4000-8000-0000000000c3';
const SEEN_AT = new Date('2026-10-11T09:00:00.000Z');
const SITE = 'https://pumpen-handel.example';

const PATHS = {
  contactPage: `${SITE}/kontakt`,
  impressumPage: `${SITE}/impressum`,
  supplierPage: `${SITE}/lieferanten`,
  linkedinCompanyPage: 'https://www.linkedin.com/company/pumpen-handel-example',
  xCompanyAccount: 'https://x.com/pumpenhandel',
  contactForm: `${SITE}/kontakt`,
  contactFormChecked: true,
};

interface ExistingPoint {
  id: string;
  kind: string;
  value: string;
  status: string;
  statusReason: string | null;
  providerKey: string;
  updatedBy: string | null;
}

function makeTx(options: {
  company?: { status: string; name: string; domain: string | null } | null;
  suppressions?: Array<{ type: string; value: string }>;
  existing?: ExistingPoint[];
} = {}) {
  const order: string[] = [];
  const company = options.company === undefined
    ? { status: 'NEW', name: 'Pumpen Handel GmbH', domain: 'pumpen-handel.example' }
    : options.company;
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('pg_advisory_xact_lock')) {
        order.push('policy-lock');
        return [{ locked: '' }];
      }
      if (text.includes('FOR SHARE')) {
        order.push('company-for-share');
        return company ? [company] : [];
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    suppressionRecord: {
      findMany: vi.fn(async () => {
        order.push('suppressions');
        return options.suppressions ?? [];
      }),
    },
    companyContactPoint: {
      findMany: vi.fn(async () => {
        order.push('points');
        return options.existing ?? [];
      }),
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        order.push('create');
        return { count: args.data.length };
      }),
      updateMany: vi.fn(async () => {
        order.push('update');
        return { count: 1 };
      }),
    },
  };
  return { tx, order };
}

function persist(tx: unknown, observation = companyContactObservation(PATHS)) {
  return persistCompanyContactPoints(tx as never, {
    workspaceId: WORKSPACE,
    companyId: COMPANY,
    observation,
    seenAt: SEEN_AT,
  });
}

describe('companyContactObservation (BI-14)', () => {
  it('turns the found links into points and lists every kind it looked at', () => {
    expect(companyContactObservation(PATHS)).toEqual({
      points: [
        { kind: 'contact_page', value: `${SITE}/kontakt`, sourceKind: 'homepage' },
        { kind: 'impressum_page', value: `${SITE}/impressum`, sourceKind: 'homepage' },
        { kind: 'supplier_page', value: `${SITE}/lieferanten`, sourceKind: 'homepage' },
        {
          kind: 'linkedin_company_page',
          value: 'https://www.linkedin.com/company/pumpen-handel-example',
          sourceKind: 'homepage',
        },
        { kind: 'x_company_account', value: 'https://x.com/pumpenhandel', sourceKind: 'homepage' },
        { kind: 'contact_form', value: `${SITE}/kontakt`, sourceKind: 'contact_page' },
      ],
      checkedKinds: [
        'contact_page',
        'impressum_page',
        'supplier_page',
        'linkedin_company_page',
        'x_company_account',
        'contact_form',
      ],
    });
  });

  it('does not count the contact form as looked at when the contact page could not be read', () => {
    const observation = companyContactObservation({
      ...PATHS,
      supplierPage: null,
      contactForm: null,
      contactFormChecked: false,
    });
    expect(observation.points.map((point) => point.kind)).toEqual([
      'contact_page',
      'impressum_page',
      'linkedin_company_page',
      'x_company_account',
    ]);
    expect(observation.checkedKinds).not.toContain('contact_form');
    expect(observation.checkedKinds).toContain('supplier_page');
  });
});

describe('persistCompanyContactPoints (BI-14)', () => {
  it('writes new points as unverified green links from company_contact, after the policy lock and a FOR SHARE company read', async () => {
    const { tx, order } = makeTx();

    await expect(persist(tx)).resolves.toEqual({ written: 6, removed: 0 });

    expect(order).toEqual(['policy-lock', 'company-for-share', 'suppressions', 'points', 'create']);
    expect(tx.companyContactPoint.createMany).toHaveBeenCalledWith({
      data: companyContactObservation(PATHS).points.map((point) => ({
        workspaceId: WORKSPACE,
        companyId: COMPANY,
        kind: point.kind,
        value: point.value,
        status: 'UNVERIFIED',
        dataClass: 'green',
        sourceKind: point.sourceKind,
        providerKey: COMPANY_CONTACT_PROVIDER_KEY,
        parserVersion: COMPANY_CONTACT_PARSER_VERSION,
        firstSeenAt: SEEN_AT,
        lastSeenAt: SEEN_AT,
      })),
      skipDuplicates: true,
    });
    expect(COMPANY_CONTACT_PROVIDER_KEY).toBe('company_contact');
    expect(COMPANY_CONTACT_PARSER_VERSION).toBe('company_contact/v1');
  });

  it('writes nothing for a missing or SUPPRESSED company, or one a domain or name suppression covers', async () => {
    for (const options of [
      { company: null },
      { company: { status: 'SUPPRESSED', name: 'Pumpen Handel GmbH', domain: 'pumpen-handel.example' } },
      { suppressions: [{ type: 'domain', value: 'pumpen-handel.example' }] },
      { suppressions: [{ type: 'company_name', value: 'Pumpen Handel GmbH' }] },
    ]) {
      const { tx } = makeTx(options);
      await expect(persist(tx)).resolves.toBeNull();
      expect(tx.companyContactPoint.findMany).not.toHaveBeenCalled();
      expect(tx.companyContactPoint.createMany).not.toHaveBeenCalled();
      expect(tx.companyContactPoint.updateMany).not.toHaveBeenCalled();
    }
  });

  it('drops a point whose host is suppressed or that is not a link the finder stores', async () => {
    const { tx } = makeTx({ suppressions: [{ type: 'domain', value: 'shop.pumpen-handel.example' }] });
    const observation = {
      points: [
        { kind: 'contact_page' as const, value: 'https://shop.pumpen-handel.example/kontakt', sourceKind: 'homepage' as const },
        { kind: 'impressum_page' as const, value: 'https://agentur.example/impressum', sourceKind: 'homepage' as const },
        { kind: 'supplier_page' as const, value: `${SITE}/lieferanten?ref=nav`, sourceKind: 'homepage' as const },
        { kind: 'linkedin_company_page' as const, value: 'https://www.linkedin.com/in/zz-sample-slug', sourceKind: 'homepage' as const },
        { kind: 'x_company_account' as const, value: 'https://x.com/zz_unrelated_9', sourceKind: 'homepage' as const },
        { kind: 'contact_form' as const, value: `${SITE}/kontakt`, sourceKind: 'contact_page' as const },
      ],
      checkedKinds: ['contact_form' as const],
    };

    await expect(persist(tx, observation)).resolves.toEqual({ written: 1, removed: 0 });
    expect(tx.companyContactPoint.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ kind: 'contact_form', value: `${SITE}/kontakt` })],
      skipDuplicates: true,
    });
  });

  it('refreshes automatic points it sees again, revives removed ones, and never touches operator points', async () => {
    const { tx } = makeTx({
      existing: [
        { id: 'p-contact', kind: 'contact_page', value: `${SITE}/kontakt`, status: 'UNVERIFIED', statusReason: null, providerKey: 'company_contact', updatedBy: null },
        { id: 'p-impressum', kind: 'impressum_page', value: `${SITE}/impressum`, status: 'INVALID', statusReason: 'REMOVED_FROM_SITE', providerKey: 'company_contact', updatedBy: null },
        { id: 'p-supplier', kind: 'supplier_page', value: `${SITE}/lieferanten`, status: 'INVALID', statusReason: 'OPERATOR_REJECTED', providerKey: 'company_contact', updatedBy: 'operator-1' },
        { id: 'p-linkedin', kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/pumpen-handel-example', status: 'VALID', statusReason: 'OPERATOR_CONFIRMED', providerKey: 'operator', updatedBy: 'operator-1' },
      ],
    });

    await expect(persist(tx)).resolves.toEqual({ written: 6, removed: 0 });

    expect(tx.companyContactPoint.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ kind: 'x_company_account' }),
        expect.objectContaining({ kind: 'contact_form' }),
      ],
      skipDuplicates: true,
    });
    expect(tx.companyContactPoint.updateMany.mock.calls).toEqual([
      [{
        where: { id: 'p-contact', providerKey: 'company_contact', updatedBy: null, status: 'UNVERIFIED', statusReason: null },
        data: { lastSeenAt: SEEN_AT, sourceKind: 'homepage', parserVersion: 'company_contact/v1' },
      }],
      [{
        where: { id: 'p-impressum', providerKey: 'company_contact', updatedBy: null, status: 'INVALID', statusReason: 'REMOVED_FROM_SITE' },
        data: {
          lastSeenAt: SEEN_AT,
          sourceKind: 'homepage',
          parserVersion: 'company_contact/v1',
          status: 'UNVERIFIED',
          statusReason: null,
        },
      }],
    ]);
  });

  it('marks automatic points of the kinds it looked at as removed when the site no longer links them', async () => {
    const { tx } = makeTx({
      existing: [
        { id: 'p-old-contact', kind: 'contact_page', value: `${SITE}/kontaktformular`, status: 'UNVERIFIED', statusReason: null, providerKey: 'company_contact', updatedBy: null },
        { id: 'p-old-form', kind: 'contact_form', value: `${SITE}/kontaktformular`, status: 'UNVERIFIED', statusReason: null, providerKey: 'company_contact', updatedBy: null },
        { id: 'p-gone', kind: 'supplier_page', value: `${SITE}/partner-werden`, status: 'INVALID', statusReason: 'REMOVED_FROM_SITE', providerKey: 'company_contact', updatedBy: null },
        { id: 'p-operator', kind: 'contact_page', value: `${SITE}/anfrage`, status: 'UNVERIFIED', statusReason: null, providerKey: 'operator', updatedBy: 'operator-1' },
        { id: 'p-confirmed', kind: 'impressum_page', value: `${SITE}/de/impressum`, status: 'VALID', statusReason: 'OPERATOR_CONFIRMED', providerKey: 'company_contact', updatedBy: 'operator-1' },
      ],
    });
    // The contact page could not be read this time: its form stays as it was.
    const observation = companyContactObservation({
      ...PATHS,
      supplierPage: null,
      contactForm: null,
      contactFormChecked: false,
    });

    await expect(persist(tx, observation)).resolves.toEqual({ written: 4, removed: 1 });

    expect(tx.companyContactPoint.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: { in: ['p-old-contact'] },
        providerKey: 'company_contact',
        updatedBy: null,
        status: { not: 'INVALID' },
      },
      data: { status: 'INVALID', statusReason: 'REMOVED_FROM_SITE' },
    });
  });
});
