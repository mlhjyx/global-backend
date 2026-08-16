import { describe, expect, it } from 'vitest';
import { OrganizationIdentityInputDriftError, resolveOrganizationIdentityForRaw } from './organization-identity-resolver';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function identityTx() {
  const state = {
    companies: [] as any[],
    identifiers: [] as any[],
    links: [] as any[],
    conflicts: [] as any[],
    parties: [] as any[],
    mappings: [] as any[],
  };
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const tx = {
    $queryRaw: async () => [{ locked: true }],
    $executeRaw: async () => 1,
    canonicalCompany: {
      findUnique: async ({ where }: any) => {
        if (where.id) return state.companies.find((item) => item.id === where.id) ?? null;
        const key = where.workspaceId_dedupeKey;
        return state.companies.find((item) => item.workspaceId === key.workspaceId && item.dedupeKey === key.dedupeKey) ?? null;
      },
      upsert: async ({ where, update, create }: any) => {
        const key = where.workspaceId_dedupeKey;
        const existing = state.companies.find((item) => item.workspaceId === key.workspaceId && item.dedupeKey === key.dedupeKey);
        if (existing) {
          existing.version += update.version?.increment ?? 0;
          return existing;
        }
        const company = { id: nextId('company'), version: 1, ...create };
        state.companies.push(company);
        return company;
      },
      update: async ({ where, data }: any) => {
        const company = state.companies.find((item) => item.id === where.id);
        company.version += data.version?.increment ?? 0;
        return company;
      },
    },
    organizationCanonicalMapping: {
      findFirst: async ({ where }: any) =>
        state.mappings.find(
          (item) =>
            item.workspaceId === where.workspaceId &&
            item.sourceCompanyId === where.sourceCompanyId &&
            item.status === 'ACTIVE',
        ) ?? null,
      findMany: async ({ where }: any) =>
        state.mappings.filter((item) => {
          if (where.sourceCompanyId?.in && !where.sourceCompanyId.in.includes(item.sourceCompanyId)) return false;
          if (where.canonicalCompanyId && item.canonicalCompanyId !== where.canonicalCompanyId) return false;
          return item.status === 'ACTIVE';
        }),
    },
    organizationIdentifier: {
      findMany: async ({ where }: any) =>
        state.identifiers.filter((item) => {
          if (item.workspaceId !== where.workspaceId || item.status !== where.status) return false;
          if (where.companyId?.in && !where.companyId.in.includes(item.companyId)) return false;
          if (
            where.OR &&
            !where.OR.some(
              (candidate: any) =>
                candidate.scheme === item.scheme &&
                candidate.jurisdiction === item.jurisdiction &&
                (candidate.normalizedValue === undefined || candidate.normalizedValue === item.normalizedValue),
            )
          )
            return false;
          return true;
        }),
      findFirst: async ({ where }: any) =>
        state.identifiers.find(
          (item) =>
            item.workspaceId === where.workspaceId &&
            item.scheme === where.scheme &&
            item.jurisdiction === where.jurisdiction &&
            item.normalizedValue === where.normalizedValue &&
            item.status === where.status,
        ) ?? null,
      create: async ({ data }: any) => {
        const identifier = { id: nextId('identifier'), status: 'ACTIVE', ...data };
        state.identifiers.push(identifier);
        return identifier;
      },
      update: async ({ where }: any) => state.identifiers.find((item) => item.id === where.id),
    },
    identityLink: {
      findMany: async ({ where }: any) =>
        state.links.filter(
          (item) =>
            item.workspaceId === where.workspaceId &&
            item.rawRecordId === where.rawRecordId &&
            item.resolverVersion === where.resolverVersion,
        ),
      findFirst: async ({ where }: any) =>
        state.links.find(
          (item) =>
            item.workspaceId === where.workspaceId &&
            item.canonicalType === where.canonicalType &&
            item.canonicalId === where.canonicalId &&
            item.rawRecordId === where.rawRecordId,
        ) ?? null,
      create: async ({ data }: any) => {
        const link = { id: nextId('link'), ...data };
        state.links.push(link);
        return link;
      },
      update: async ({ where, data }: any) => {
        const link = state.links.find((item) => item.id === where.id);
        Object.assign(link, data);
        return link;
      },
    },
    organizationIdentityConflict: {
      upsert: async ({ where, create }: any) => {
        const fingerprint = where.workspaceId_fingerprint.fingerprint;
        const existing = state.conflicts.find((item) => item.fingerprint === fingerprint);
        if (existing) return existing;
        const conflict = { id: nextId('conflict'), status: 'OPEN', revision: 1, ...create };
        state.conflicts.push(conflict);
        return conflict;
      },
    },
    organizationIdentityConflictParty: {
      createMany: async ({ data }: any) => {
        state.parties.push(...data);
        return { count: data.length };
      },
    },
  };
  return { tx: tx as never, state };
}

describe('organization identity resolver scenarios', () => {
  it('binds a DENUE organization by name and country without inventing a strong identifier', async () => {
    const { tx, state } = identityTx();

    const result = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-denue-no-authority',
      providerKey: 'mexico_denue',
      record: { name: 'Industrias Ejemplo', country: 'MX', region: 'JAL' },
    });

    expect(result).toMatchObject({ kind: 'bound', replayed: false });
    expect(state.companies).toHaveLength(1);
    expect(state.identifiers).toEqual([]);
  });

  it('rechecks the raw receipt after the authority lock so concurrent replay creates one identity link', async () => {
    const { tx, state } = identityTx();
    let lockCalls = 0;
    let releaseSecond!: () => void;
    const secondMayEnter = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    (tx as any).$executeRaw = async () => {
      lockCalls += 1;
      if (lockCalls === 2) await secondMayEnter;
      return 1;
    };
    const input = {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-concurrent',
      providerKey: 'sandbox',
      record: { name: 'Concurrent GmbH', domain: 'concurrent.example' },
    };

    const firstPromise = resolveOrganizationIdentityForRaw(tx, input);
    const secondPromise = resolveOrganizationIdentityForRaw(tx, input);
    const first = await firstPromise;
    releaseSecond();
    const second = await secondPromise;

    expect(first).toMatchObject({ kind: 'bound', replayed: false });
    expect(second).toMatchObject({ kind: 'bound', replayed: true });
    expect(state.links).toHaveLength(1);
    expect(state.companies).toHaveLength(1);
  });

  it('resolves a replayed active raw link to the current merge root', async () => {
    const { tx, state } = identityTx();
    const input = {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-before-merge',
      providerKey: 'sandbox',
      record: { name: 'Alias GmbH', domain: 'alias.example' },
    };
    const first = await resolveOrganizationIdentityForRaw(tx, input);
    expect(first.kind).toBe('bound');
    if (first.kind !== 'bound') throw new Error('expected bound identity');
    state.mappings.push({
      workspaceId: WORKSPACE_ID,
      sourceCompanyId: first.companyId,
      canonicalCompanyId: 'company-root',
      status: 'ACTIVE',
    });

    await expect(resolveOrganizationIdentityForRaw(tx, input)).resolves.toMatchObject({
      kind: 'bound',
      companyId: 'company-root',
      replayed: true,
    });
  });

  it('does not attach a second Wikidata QID to a company matched by the same domain', async () => {
    const { tx } = identityTx();
    await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-q1',
      providerKey: 'wikidata',
      record: {
        name: 'Group One',
        domain: 'shared.example',
        identifiers: [{ scheme: 'wikidata-qid', value: 'Q100' }],
      },
    });
    await expect(resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-q2',
      providerKey: 'wikidata',
      record: {
        name: 'Group Two',
        domain: 'shared.example',
        identifiers: [{ scheme: 'wikidata-qid', value: 'Q200' }],
      },
    })).resolves.toMatchObject({ kind: 'conflict' });
  });

  it('converges domain, LEI, FDA and TED identifiers from three raw records', async () => {
    const { tx, state } = identityTx();
    const first = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-1',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'lei', value: '529900T8BM49AURSDO55' }] },
    });
    const second = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-2',
      providerKey: 'sandbox',
      record: {
        name: 'ACME GmbH',
        domain: 'www.acme.example',
        identifiers: [{ scheme: 'fda-reg', jurisdiction: 'US', value: '3012345678' }],
      },
    });
    const third = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-3',
      providerKey: 'sandbox',
      record: {
        name: 'Acme Europe',
        identifiers: [
          { scheme: 'fda-reg', jurisdiction: 'US', value: '3012345678' },
          { scheme: 'ted-natid', jurisdiction: 'DE', value: 'DE-123' },
        ],
      },
    });

    expect(first.kind).toBe('bound');
    expect(second.kind).toBe('bound');
    expect(third.kind).toBe('bound');
    expect(
      new Set([
        first.kind === 'bound' ? first.companyId : '',
        second.kind === 'bound' ? second.companyId : '',
        third.kind === 'bound' ? third.companyId : '',
      ]).size,
    ).toBe(1);
    expect(state.companies).toHaveLength(1);
    expect(state.identifiers.map((item) => item.scheme).sort()).toEqual(['domain', 'fda-reg', 'lei', 'ted-natid']);
  });

  it('keeps same-name companies with different registration numbers separate', async () => {
    const { tx, state } = identityTx();
    const left = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-left',
      providerKey: 'sandbox',
      record: { name: 'Twin GmbH', country: 'DE', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-100' }] },
    });
    const right = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-right',
      providerKey: 'sandbox',
      record: { name: 'Twin GmbH', country: 'DE', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-200' }] },
    });

    expect(left.kind).toBe('bound');
    expect(right.kind).toBe('bound');
    expect(left.kind === 'bound' && right.kind === 'bound' && left.companyId).not.toBe(right.kind === 'bound' ? right.companyId : '');
    expect(state.companies).toHaveLength(2);
    expect(state.conflicts).toHaveLength(0);
  });

  it('lazily upgrades only a legacy name-country candidate', async () => {
    const { tx, state } = identityTx();
    state.companies.push({
      id: 'legacy',
      workspaceId: WORKSPACE_ID,
      dedupeKey: 'n:legacy:de',
      name: 'Legacy GmbH',
      country: 'DE',
      version: 1,
    });

    const result = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-legacy',
      providerKey: 'sandbox',
      record: { name: 'Legacy GmbH', country: 'DE', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-300' }] },
    });

    expect(result).toMatchObject({ kind: 'bound', companyId: 'legacy' });
    expect(state.companies).toHaveLength(1);
    expect(state.identifiers).toEqual([expect.objectContaining({ companyId: 'legacy', normalizedValue: 'HRB300' })]);
  });

  it('stops on shared domain versus different singleton registration and detects input drift', async () => {
    const { tx, state } = identityTx();
    await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-a',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-100' }] },
    });
    const conflict = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-b',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-200' }] },
    });

    expect(conflict.kind).toBe('conflict');
    expect(state.conflicts).toHaveLength(1);
    expect(state.parties).toHaveLength(2);
    expect(state.links.filter((item) => item.rawRecordId === 'raw-b').every((item) => item.status === 'PENDING_CONFLICT')).toBe(true);
    expect(state.identifiers).toContainEqual(expect.objectContaining({
      rawRecordId: 'raw-b',
      normalizedValue: 'HRB200',
      status: 'PENDING_CONFLICT',
    }));

    await expect(
      resolveOrganizationIdentityForRaw(tx, {
        workspaceId: WORKSPACE_ID,
        rawRecordId: 'raw-a',
        providerKey: 'sandbox',
        record: {
          name: 'Acme renamed',
          domain: 'acme.example',
          identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-100' }],
        },
      }),
    ).rejects.toBeInstanceOf(OrganizationIdentityInputDriftError);
  });

  it('does not recreate pending identifiers when the same facts were already kept separate', async () => {
    const { tx, state } = identityTx();
    await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-a',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-100' }] },
    });
    const firstConflict = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-b',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-200' }] },
    });
    expect(firstConflict.kind).toBe('conflict');
    state.conflicts[0].status = 'RESOLVED';
    for (const identifier of state.identifiers.filter((item) => item.status === 'PENDING_CONFLICT')) {
      identifier.status = 'REVOKED';
      identifier.revokedAt = new Date();
    }
    const before = state.identifiers.length;

    const repeat = await resolveOrganizationIdentityForRaw(tx, {
      workspaceId: WORKSPACE_ID,
      rawRecordId: 'raw-c',
      providerKey: 'sandbox',
      record: { name: 'Acme', domain: 'acme.example', identifiers: [{ scheme: 'ted-natid', jurisdiction: 'DE', value: 'HRB-200' }] },
    });

    expect(repeat).toMatchObject({ kind: 'conflict', conflictId: state.conflicts[0].id });
    expect(state.conflicts).toHaveLength(1);
    expect(state.identifiers).toHaveLength(before);
    expect(state.links.filter((item) => item.rawRecordId === 'raw-c').every((item) => item.status === 'REVOKED')).toBe(true);
  });
});
