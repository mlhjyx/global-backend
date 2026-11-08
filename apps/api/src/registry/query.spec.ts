import { describe, expect, it } from 'vitest';
import {
  REGISTRY_QUERY_DEFAULT_LIMIT,
  REGISTRY_QUERY_MAX_LIMIT,
  RegistryQueryError,
  buildRegistryEntityQuery,
  employeeCountForBand,
  parseRegistryQueryFilters,
  registryQueryRationale,
  toProviderCompanyRecord,
  type RegistryQueryRow,
} from './query';

describe('parseRegistryQueryFilters', () => {
  it('normalizes a full filter set', () => {
    const filters = parseRegistryQueryFilters({
      source_hint: 'registry_frame',
      country: 'de',
      scheme: 'de_hrb',
      nace_prefix: ['28.13', '2812', '28'],
      employee_band: ['10-49', '50-249'],
      legal_form: ['GmbH', 'AG'],
      status: 'ACTIVE',
      postal_prefix: '8',
      limit: 120,
    });
    expect(filters).toEqual({
      country: 'DE',
      scheme: 'de_hrb',
      nacePrefixes: ['28.13', '2812', '28'],
      employeeBands: ['10-49', '50-249'],
      legalForms: ['gmbh', 'ag'],
      status: 'ACTIVE',
      postalPrefix: '8',
      limit: 120,
    });
  });

  it('applies defaults for a minimal query', () => {
    const filters = parseRegistryQueryFilters({ country: 'GB' });
    expect(filters).toMatchObject({
      country: 'GB',
      scheme: null,
      status: 'ACTIVE',
      limit: REGISTRY_QUERY_DEFAULT_LIMIT,
      postalPrefix: null,
      nacePrefixes: [],
    });
  });

  it('fails closed on unknown keys, bad values and out-of-range limits', () => {
    const expectIssues = (input: unknown, match: RegExp) => {
      try {
        parseRegistryQueryFilters(input);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(RegistryQueryError);
        expect((error as RegistryQueryError).issues.join('\n')).toMatch(match);
      }
    };
    expectIssues({ country: 'DE', keyword: 'pump' }, /未知 filter：keyword/u);
    expectIssues({ country: 'Germany' }, /country/u);
    expectIssues({ country: 'DE', nace_prefix: ['2'] }, /nace_prefix/u);
    expectIssues({ country: 'DE', nace_prefix: ['28133'] }, /nace_prefix/u);
    expectIssues({ country: 'DE', employee_band: ['100-249'] }, /employee_band/u);
    expectIssues({ country: 'DE', status: 'LIVE' }, /status/u);
    expectIssues({ country: 'DE', limit: 0 }, /limit/u);
    expectIssues({ country: 'DE', limit: REGISTRY_QUERY_MAX_LIMIT + 1 }, /limit/u);
    expectIssues({ country: 'DE', source_hint: 'public_web' }, /source_hint/u);
    expectIssues({ country: 'DE', scheme: 'DE-HRB' }, /scheme/u);
    expectIssues({ country: 'DE', postal_prefix: 'ABCD' }, /postal_prefix/u);
  });
});

describe('buildRegistryEntityQuery', () => {
  it('compiles filters into a parameterized, deterministic query', () => {
    const filters = parseRegistryQueryFilters({
      country: 'DE',
      nace_prefix: ['2813'],
      employee_band: ['10-49'],
      legal_form: ['GmbH'],
      postal_prefix: '8',
      limit: 7,
    });
    expect(buildRegistryEntityQuery(filters)).toEqual({
      where: {
        country: 'DE',
        status: 'ACTIVE',
        withdrawnAt: null,
        lastSnapshot: { status: 'PARSED' },
        OR: [{ nace: { startsWith: '2813' } }],
        employeeBand: { in: ['10-49'] },
        legalForm: { in: ['gmbh'], mode: 'insensitive' },
        postalCode: { startsWith: '8' },
      },
      orderBy: [{ scheme: 'asc' }, { regNumber: 'asc' }],
      take: 7,
    });
  });

  it('omits optional predicates when the filters are empty', () => {
    const query = buildRegistryEntityQuery(parseRegistryQueryFilters({ country: 'GB' }));
    expect(query.where).toEqual({
      country: 'GB',
      status: 'ACTIVE',
      withdrawnAt: null,
      lastSnapshot: { status: 'PARSED' },
    });
  });
});

describe('employeeCountForBand', () => {
  it('returns band midpoints per ch03 §3.9.13', () => {
    expect(employeeCountForBand('0')).toBe(0);
    expect(employeeCountForBand('1-9')).toBe(5);
    expect(employeeCountForBand('10-49')).toBe(25);
    expect(employeeCountForBand('50-249')).toBe(120);
    expect(employeeCountForBand('250+')).toBe(500);
    expect(employeeCountForBand(null)).toBeUndefined();
  });
});

describe('toProviderCompanyRecord', () => {
  const row: RegistryQueryRow = {
    scheme: 'de_hrb',
    regNumber: 'HRB 12345',
    country: 'DE',
    name: 'Muster Pumpen GmbH',
    region: 'Bayern',
    nace: '28.13',
    naceVersion: 'NACE-2.1',
    employeeBand: '10-49',
    legalForm: 'gmbh',
    status: 'ACTIVE',
    website: null,
    identifiers: [{ scheme: 'de_ust', value: 'DE291499156' }],
    lastSnapshotId: 'snap-1',
    sourceFrame: { frameKey: 'de_offeneregister', licence: 'CC-BY-4.0' },
  };

  it('maps a registry row to the provider contract with provenance attributes', () => {
    const record = toProviderCompanyRecord(row);
    expect(record).toMatchObject({
      externalId: 'de_hrb:HRB 12345',
      name: 'Muster Pumpen GmbH',
      country: 'DE',
      region: 'Bayern',
      employeeCount: 25,
      identifier: { scheme: 'de_hrb', value: 'HRB 12345' },
      license: 'CC-BY-4.0',
      attributes: {
        registry: {
          scheme: 'de_hrb',
          regNumber: 'HRB 12345',
          status: 'ACTIVE',
          legalForm: 'gmbh',
          nace: '28.13',
          naceVersion: 'NACE-2.1',
          employeeBand: '10-49',
          identifiers: [{ scheme: 'de_ust', value: 'DE291499156' }],
          frameKey: 'de_offeneregister',
          snapshotId: 'snap-1',
        },
      },
    });
    expect(record.domain).toBeUndefined();
  });

  it('keeps a source-provided website as the normalized domain', () => {
    const record = toProviderCompanyRecord({ ...row, website: 'https://www.Muster-Pumpen.de/kontakt' });
    expect(record.domain).toBe('muster-pumpen.de');
  });
});

describe('registryQueryRationale', () => {
  it('records the enumeration scope for the plan receipt', () => {
    const withScheme = parseRegistryQueryFilters({ country: 'DE', scheme: 'de_hrb', limit: 50 });
    expect(registryQueryRationale(withScheme)).toBe('本地注册库 frame 枚举（de_hrb，limit 50）');
    const withoutScheme = parseRegistryQueryFilters({ country: 'GB' });
    expect(registryQueryRationale(withoutScheme)).toBe(
      `本地注册库 frame 枚举（GB，limit ${REGISTRY_QUERY_DEFAULT_LIMIT}）`,
    );
  });
});
