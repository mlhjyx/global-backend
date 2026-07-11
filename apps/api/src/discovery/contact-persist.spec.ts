import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { persistDiscoveredContacts } from './contact-persist';
import type { ProviderContactRecord } from './provider-contract';

/** 可编排的假 tx：canonicalContact.findMany 返回给定候选（供 resolvePersonIdentity）。 */
function fakeTx(candidates: { id: string; fullName: string; contactPoints: { type: string; value: string }[] }[]) {
  const contactPointUpsert = vi.fn(async () => ({}));
  const fieldEvidenceCreate = vi.fn(async () => ({}));
  const canonicalUpsert = vi.fn(async () => ({ id: 'new-contact-1' }));
  const canonicalUpdate = vi.fn(async () => ({}));
  const tx = {
    canonicalContact: {
      findMany: vi.fn(async () => candidates),
      findUnique: vi.fn(async () => ({ title: 'Geschäftsführer', seniority: null, department: null })),
      upsert: canonicalUpsert,
      update: canonicalUpdate,
    },
    contactPoint: { upsert: contactPointUpsert },
    fieldEvidence: { create: fieldEvidenceCreate },
  } as unknown as Prisma.TransactionClient;
  return { tx, contactPointUpsert, fieldEvidenceCreate, canonicalUpsert, canonicalUpdate };
}

const chDirector: ProviderContactRecord = {
  externalId: 'companies_house:02723534:OID1',
  fullName: 'John Smith',
  title: 'Director',
  seniority: 'director',
  buyingRole: 'economic_buyer',
  personalData: true,
  sourcePage: 'https://find-and-update.company-information.service.gov.uk/company/02723534',
  license: 'OGL-UK-3.0',
  externalIds: [{ scheme: 'uk-ch-officer', value: 'OID1' }],
};

const company = { id: 'co-1', dedupeKey: 'd:astrazeneca.com' };

describe('contact-persist · externalIds → external_id 点 + license 署名', () => {
  it('新人：createContact + 写 external_id 点（value=`scheme:value`）+ OGL license 证据', async () => {
    const { tx, contactPointUpsert, fieldEvidenceCreate, canonicalUpsert } = fakeTx([]); // 无候选 → 新建
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'companies_house',
      contacts: [chDirector],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    expect(canonicalUpsert).toHaveBeenCalledTimes(1); // 新建

    // external_id 点写入（value=`uk-ch-officer:OID1`，与 Tier 0 查法一致）
    const pointCall = contactPointUpsert.mock.calls.find(
      (c) => (c[0] as { create: { type: string } }).create.type === 'external_id',
    );
    expect(pointCall).toBeDefined();
    expect((pointCall![0] as { create: { value: string } }).create.value).toBe('uk-ch-officer:OID1');

    // 该点的 field_evidence.license = OGL（非硬编码 licensed）
    const evidence = fieldEvidenceCreate.mock.calls.map((c) => c[0] as { data: { field: string; license: string } });
    const extIdEvidence = evidence.find((e) => e.data.field === 'external_id');
    expect(extIdEvidence?.data.license).toBe('OGL-UK-3.0');
    // 具名人 person.profile 证据存在（personal_data 标记）+ 带 CH 源 license（OGL 署名落库）
    expect(evidence.some((e) => e.data.field === 'person.profile')).toBe(true);
    expect(evidence.find((e) => e.data.field === 'person.profile')?.data.license).toBe('OGL-UK-3.0');
  });

  it('Tier 0：候选已有匹配 external_id 点 → 并入现有行（不新建）+ identity.merge match_rule=external_id', async () => {
    const { tx, canonicalUpsert, fieldEvidenceCreate } = fakeTx([
      { id: 'c-existing', fullName: 'J. Smith', contactPoints: [{ type: 'external_id', value: 'uk-ch-officer:oid1' }] },
    ]);
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'companies_house',
      contacts: [chDirector],
      suppressedEmails: new Set(),
    });
    expect(res.merged).toBe(1);
    expect(res.created).toBe(0);
    expect(canonicalUpsert).not.toHaveBeenCalled(); // Tier 0 命中 → 不新建

    const merge = fieldEvidenceCreate.mock.calls
      .map((c) => c[0] as { data: { field: string; value: { match_rule?: string }; license: string } })
      .find((e) => e.data.field === 'identity.merge');
    expect(merge?.data.value.match_rule).toBe('external_id');
    expect(merge?.data.license).toBe('OGL-UK-3.0'); // 合并证据也带 CH 署名
  });

  it('🔴 HIGH-1 端到端：同公司同名不同 officer_id → 不并（Tier 2 externalId 冲突守卫）→ 新建', async () => {
    // contact-A 已挂 uk-ch-officer:OID1、无 email；来的是同名董事但 officerId OID2（真实不同人）
    const { tx, canonicalUpsert, fieldEvidenceCreate } = fakeTx([
      { id: 'contact-A', fullName: 'John Smith', contactPoints: [{ type: 'external_id', value: 'uk-ch-officer:OID1' }] },
    ]);
    const directorOid2: ProviderContactRecord = { ...chDirector, externalId: 'x', externalIds: [{ scheme: 'uk-ch-officer', value: 'OID2' }] };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'companies_house',
      contacts: [directorOid2],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1); // 🔴 新建（不误并到 contact-A）
    expect(res.merged).toBe(0);
    expect(canonicalUpsert).toHaveBeenCalledTimes(1);
    // 未写 identity.merge（没有发生合并）
    expect(fieldEvidenceCreate.mock.calls.map((c) => (c[0] as { data: { field: string } }).data.field)).not.toContain('identity.merge');
  });

  it('无 license 的 adapter（decision_maker）→ 回退 licensed（不破坏既有语义）', async () => {
    const { tx, fieldEvidenceCreate } = fakeTx([]);
    await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: 'Anna Weber', email: 'anna@x.test', personalData: true }],
      suppressedEmails: new Set(),
    });
    const emailEvidence = fieldEvidenceCreate.mock.calls
      .map((c) => c[0] as { data: { field: string; license: string } })
      .find((e) => e.data.field === 'email');
    expect(emailEvidence?.data.license).toBe('licensed');
  });

  it('🟢 EPO 类无联系点具名人：person.profile 证据带源 license（CC BY 署名落库），不写任何 contact_point', async () => {
    const { tx, fieldEvidenceCreate, contactPointUpsert } = fakeTx([]); // 无候选 → 新建
    const inventor: ProviderContactRecord = {
      externalId: 'epo_ops:siemens-ag:hans-mueller',
      fullName: 'Hans Müller',
      title: 'Inventor',
      buyingRole: 'technical_buyer',
      personalData: true,
      sourcePage: 'https://worldwide.espacenet.com/',
      license: 'CC-BY-4.0',
      // 🔴 无 email/phone/linkedin/externalIds —— EPO 发明人无联系点
    };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'epo_ops',
      contacts: [inventor],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    expect(contactPointUpsert).not.toHaveBeenCalled(); // 无联系点 → 不写 contact_point
    // CC BY 署名靠 person.profile 承载（否则 EPO 的署名义务不入库）
    const profile = fieldEvidenceCreate.mock.calls
      .map((c) => c[0] as { data: { field: string; license: string } })
      .find((e) => e.data.field === 'person.profile');
    expect(profile?.data.license).toBe('CC-BY-4.0');
  });
});
