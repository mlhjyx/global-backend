import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { persistDiscoveredContacts } from './contact-persist';
import { contactIdentity, declinedContactIdentity } from './identity';
import { blindContactKey } from '../compliance/pii-crypto';
import type { ProviderContactRecord } from './provider-contract';

type FakeCandidate = { id: string; fullName: string; contactPoints: { type: string; value: string; status?: string }[] };

/**
 * 可编排的假 tx：
 *  - `findMany` 返回给定候选（供 resolvePersonIdentity 分层匹配）；
 *  - `findUnique` 按 where 形状分流：`{id}` → mergeIntoContact 读 title/seniority/department；
 *    `{workspaceId_dedupeKey}` → createContact 的**碰撞探测**（命中 opts.existingBlindedKeys → 返行、否则 null）。
 */
function fakeTx(
  candidates: FakeCandidate[],
  opts?: { existingBlindedKeys?: string[]; companyStatus?: string; suppressedContactKeys?: string[] },
) {
  const existingKeys = new Set(opts?.existingBlindedKeys ?? []);
  const contactPointUpsert = vi.fn(async () => ({}));
  const fieldEvidenceCreate = vi.fn(async () => ({}));
  const canonicalUpsert = vi.fn(async () => ({ id: 'new-contact-1' }));
  const canonicalUpdate = vi.fn(async () => ({}));
  const canonicalFindUnique = vi.fn(async (arg: { where: Record<string, unknown> }) => {
    const where = arg?.where ?? {};
    if ('workspaceId_dedupeKey' in where) {
      const key = (where.workspaceId_dedupeKey as { dedupeKey: string }).dedupeKey;
      return existingKeys.has(key) ? { id: 'collide-existing' } : null;
    }
    return { title: 'Geschäftsführer', seniority: null, department: null };
  });
  // $queryRaw = 公司 FOR SHARE 状态复检（默认 NEW=未 SUPPRESSED）；suppressionRecord.findMany = person-level 禁联键。
  const suppressionFindMany = vi.fn(async () => (opts?.suppressedContactKeys ?? []).map((value) => ({ value })));
  const queryRaw = vi.fn(async () => [{ status: opts?.companyStatus ?? 'NEW' }]);
  const tx = {
    canonicalContact: {
      findMany: vi.fn(async () => candidates),
      findUnique: canonicalFindUnique,
      upsert: canonicalUpsert,
      update: canonicalUpdate,
    },
    contactPoint: { upsert: contactPointUpsert },
    fieldEvidence: { create: fieldEvidenceCreate },
    suppressionRecord: { findMany: suppressionFindMany },
    $queryRaw: queryRaw,
  } as unknown as Prisma.TransactionClient;
  return { tx, contactPointUpsert, fieldEvidenceCreate, canonicalUpsert, canonicalUpdate, canonicalFindUnique, suppressionFindMany, queryRaw };
}

/** 从 canonicalContact.upsert 的调用取实际写入的 dedupeKey（盲值）。 */
function upsertDedupeKey(canonicalUpsert: ReturnType<typeof vi.fn>): string {
  const call = canonicalUpsert.mock.calls[0][0] as {
    where: { workspaceId_dedupeKey: { dedupeKey: string } };
    create: { dedupeKey: string };
  };
  expect(call.where.workspaceId_dedupeKey.dedupeKey).toBe(call.create.dedupeKey); // where 与 create 同键
  return call.create.dedupeKey;
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
    // 具名人 person.profile 证据存在（personal_data 标记）
    expect(evidence.some((e) => e.data.field === 'person.profile')).toBe(true);
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

  it('🔴 name-merge 身份源（inpi_rne，无联系点）新建 → person.profile 证据带该源 license（不再硬编码 public）', async () => {
    // 法国 dirigeant / EPO inventor 这类**归一名合并**源不发任何 contact_point（无 email/phone/linkedin/externalId），
    // 故一条新建联系人的**唯一**证据就是 person.profile。此前它硬编码 license:'public'，把源署名许可
    // （INPI RNE=Licence-Ouverte-2.0 / EPO=CC-BY-4.0）整个丢掉（仅在发生合并时才落到 identity.merge）。
    const { tx, contactPointUpsert, fieldEvidenceCreate, canonicalUpsert } = fakeTx([]); // 无候选 → 新建
    const dirigeant: ProviderContactRecord = {
      externalId: 'inpi_rne:552081317:jean-dupont',
      fullName: 'Jean Dupont',
      seniority: 'executive',
      buyingRole: 'economic_buyer',
      personalData: true,
      sourcePage: 'https://annuaire-entreprises.data.gouv.fr/entreprise/552081317',
      license: 'Licence-Ouverte-2.0',
      // 无 email/phone/linkedin/externalIds —— 归一名合并源不发联系点
    };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'inpi_rne',
      contacts: [dirigeant],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    expect(canonicalUpsert).toHaveBeenCalledTimes(1);
    expect(contactPointUpsert).not.toHaveBeenCalled(); // name-merge 源不写任何 contact_point
    const profile = fieldEvidenceCreate.mock.calls
      .map((c) => c[0] as { data: { field: string; license: string } })
      .find((e) => e.data.field === 'person.profile');
    expect(profile).toBeDefined(); // 唯一证据
    expect(profile?.data.license).toBe('Licence-Ouverte-2.0'); // 🔴 修复前 = 'public'（源署名许可被丢）
  });

  it('无 license 的 adapter（decision_maker）→ person.profile 证据回退 public（保留既有默认）', async () => {
    const { tx, fieldEvidenceCreate } = fakeTx([]);
    await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: 'Anna Weber', email: 'anna@x.test', personalData: true }],
      suppressedEmails: new Set(),
    });
    const profile = fieldEvidenceCreate.mock.calls
      .map((c) => c[0] as { data: { field: string; license: string } })
      .find((e) => e.data.field === 'person.profile');
    expect(profile?.data.license).toBe('public'); // 无源 license → 保留 public 默认
  });

  it('🔴 收口⑥ PR #60：新建的 dedupe_key 已盲化（bi:v1:），where 与 create 同键，不含明文 email', async () => {
    const { tx, canonicalUpsert } = fakeTx([]); // 无候选 → 新建
    await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: 'Anna Weber', email: 'anna@x.test', personalData: true }],
      suppressedEmails: new Set(),
    });
    expect(canonicalUpsert).toHaveBeenCalledTimes(1);
    const call = canonicalUpsert.mock.calls[0][0] as {
      where: { workspaceId_dedupeKey: { dedupeKey: string } };
      create: { dedupeKey: string };
    };
    const createdKey = call.create.dedupeKey;
    const whereKey = call.where.workspaceId_dedupeKey.dedupeKey;
    expect(createdKey.startsWith('bi:v1:')).toBe(true); // 盲化前缀
    expect(whereKey).toBe(createdKey); // where 与 create 同盲值 → upsert 幂等成立
    expect(createdKey).not.toContain('anna'); // 明文 email 不泄进去重键
    expect(createdKey).not.toContain('e:'); // 非 legacy 明文键形
  });
});

describe('contact-persist · 🔴 Art.17 删除禁联消费（Codex P1 on PR #63）', () => {
  const companyKey = company.dedupeKey; // d:astrazeneca.com

  it('公司已 SUPPRESSED（FOR SHARE 复检命中）→ 整批不入库（防完成删除后的漏网写入）', async () => {
    const { tx, canonicalUpsert, queryRaw } = fakeTx([], { companyStatus: 'SUPPRESSED' });
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [
        { externalId: 'x', fullName: 'Late One', email: 'late1@x.test', personalData: true },
        { externalId: 'y', fullName: 'Late Two', email: 'late2@x.test', personalData: true },
      ],
      suppressedEmails: new Set(),
    });
    expect(queryRaw).toHaveBeenCalledTimes(1); // 取了 FOR SHARE 状态锁并复读
    expect(res.created).toBe(0);
    expect(res.skippedSuppressed).toBe(2); // 整批跳过
    expect(canonicalUpsert).not.toHaveBeenCalled(); // 未新建任何联系人
  });

  it('person-level 禁联键命中 → 同一人换新邮箱再现也跳过（不重建被 Art.17 擦除的具名人）', async () => {
    // 该人此前被删，冻结时写了 person-level 禁联键（email-独立）。现以**不同邮箱**被重新发现。
    const personKey = blindContactKey(contactIdentity({ fullName: 'Klaus Löschmann' }, companyKey)).toLowerCase();
    const { tx, canonicalUpsert } = fakeTx([], { suppressedContactKeys: [personKey] });
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: 'Klaus Löschmann', email: 'klaus.NEW@other.test', personalData: true }],
      suppressedEmails: new Set(), // 新邮箱不在 email 禁联表 → 只有 person-level 键能拦
    });
    expect(res.created).toBe(0);
    expect(res.skippedSuppressed).toBe(1); // person-level 键命中
    expect(canonicalUpsert).not.toHaveBeenCalled();
  });

  it('person-level 禁联键未命中 → 正常新建（正向路径不被破坏）', async () => {
    const otherKey = blindContactKey(contactIdentity({ fullName: 'Someone Else' }, companyKey)).toLowerCase();
    const { tx, canonicalUpsert } = fakeTx([], { suppressedContactKeys: [otherKey] });
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [{ externalId: 'x', fullName: 'Fresh Person', email: 'fresh@x.test', personalData: true }],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    expect(canonicalUpsert).toHaveBeenCalledTimes(1);
  });
});

describe('contact-persist · 🔴 待办2 create 层收尾：createContact 尊重 resolve 的「拒并」（不经键控 upsert 旁路）', () => {
  const companyKey = company.dedupeKey; // d:astrazeneca.com

  it('#54-E RISKY：不同名记录撞既有 RISKY catch-all 邮箱 → resolve 拒并 → 新建独立行（按名 dx 键，不并回邮箱行）', async () => {
    // 既有 Anna 的邮箱点后被标 RISKY；来的 Bob Jones 撞同一 catch-all 地址
    const annaEmailKey = blindContactKey(contactIdentity({ fullName: 'Anna Weber', email: 'a.weber@catchall.test' }, companyKey));
    const { tx, canonicalUpsert } = fakeTx(
      [{ id: 'anna', fullName: 'Anna Weber', contactPoints: [{ type: 'email', value: 'a.weber@catchall.test', status: 'RISKY' }] }],
      { existingBlindedKeys: [annaEmailKey] },
    );
    const bob: ProviderContactRecord = { externalId: 'x', fullName: 'Bob Jones', email: 'a.weber@catchall.test', personalData: true };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [bob],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    expect(res.merged).toBe(0);
    const key = upsertDedupeKey(canonicalUpsert);
    expect(key).toBe(blindContactKey(declinedContactIdentity({ fullName: 'Bob Jones' }, companyKey))); // dx:c 按名
    expect(key).not.toBe(annaEmailKey); // 🔴 绝不并回 Anna 的邮箱行（catch-all 误并被根治）
  });

  it('#54-D 同名歧义：≥2 同归一名候选 → resolve 拒并 → 新建独立行（dx 键，不并回既有 Anna 行）', async () => {
    // 既有 Anna Weber 与 Dr. Anna Weber 共存（归一同名、原名键不同）；来的 Anna Weber 无邮箱/externalId
    const annaNameKey = blindContactKey(contactIdentity({ fullName: 'Anna Weber' }, companyKey));
    const { tx, canonicalUpsert } = fakeTx(
      [
        { id: 'anna', fullName: 'Anna Weber', contactPoints: [] },
        { id: 'dr-anna', fullName: 'Dr. Anna Weber', contactPoints: [] },
      ],
      { existingBlindedKeys: [annaNameKey] },
    );
    const incoming: ProviderContactRecord = { externalId: 'x', fullName: 'Anna Weber', personalData: true };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'patent_inventor',
      contacts: [incoming],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    const key = upsertDedupeKey(canonicalUpsert);
    expect(key).toBe(blindContactKey(declinedContactIdentity({ fullName: 'Anna Weber' }, companyKey)));
    expect(key).not.toBe(annaNameKey); // 🔴 歧义守卫不再被 create 层旁路
  });

  it('🔴 同源再跑幂等：declined 记录二次 persist → 同一 dx 键（确定性 → 真库 upsert-by-key 落回同行，不产生第三行）', async () => {
    const annaNameKey = blindContactKey(contactIdentity({ fullName: 'Anna Weber' }, companyKey));
    const incoming: ProviderContactRecord = { externalId: 'x', fullName: 'Anna Weber', personalData: true };
    const runOnce = async (): Promise<string> => {
      const { tx, canonicalUpsert } = fakeTx(
        [
          { id: 'anna', fullName: 'Anna Weber', contactPoints: [] },
          { id: 'dr-anna', fullName: 'Dr. Anna Weber', contactPoints: [] },
        ],
        { existingBlindedKeys: [annaNameKey] },
      );
      await persistDiscoveredContacts(tx, {
        workspaceId: 'ws-1',
        company,
        adapterKey: 'patent_inventor',
        contacts: [incoming],
        suppressedEmails: new Set(),
      });
      return upsertDedupeKey(canonicalUpsert);
    };
    const keyRun1 = await runOnce();
    const keyRun2 = await runOnce();
    expect(keyRun1).toBe(keyRun2); // 确定性
    expect(keyRun1).toBe(blindContactKey(declinedContactIdentity({ fullName: 'Anna Weber' }, companyKey)));
  });

  it('🔴 歧义幂等硬化：歧义候选不占用来件明文键（两条邮箱行）→ 仍走 dx 键（不新建明文键行，杜绝再跑翻键生重复）', async () => {
    // 两条同名不同邮箱的 Anna（键 e:a / e:b）→ 来件无邮箱 Anna 的明文名键 c:…anna weber 本是「空」的。
    // 只靠碰撞探测会误用明文名键新建，二次跑该行反成碰撞 → 翻成 dx 键 → 生第三行（破幂等）。
    // 故同名歧义必须由 resolve 直接判 declined，令 create 层无论明文键空否都走 dx（DB-state 无关 → 幂等）。
    const { tx, canonicalUpsert } = fakeTx(
      [
        { id: 'anna-a', fullName: 'Anna Weber', contactPoints: [{ type: 'email', value: 'anna.a@x.test', status: 'VALID' }] },
        { id: 'anna-b', fullName: 'Anna Weber', contactPoints: [{ type: 'email', value: 'anna.b@x.test', status: 'VALID' }] },
      ],
      { existingBlindedKeys: [] }, // 明文名键空 → 碰撞探测返 false
    );
    const incoming: ProviderContactRecord = { externalId: 'x', fullName: 'Anna Weber', personalData: true };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'patent_inventor',
      contacts: [incoming],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    const key = upsertDedupeKey(canonicalUpsert);
    expect(key).toBe(blindContactKey(declinedContactIdentity({ fullName: 'Anna Weber' }, companyKey))); // dx 键
    expect(key).not.toBe(blindContactKey(contactIdentity({ fullName: 'Anna Weber' }, companyKey))); // 🔴 绝不用明文名键
  });

  it('🔴 误并回归：同名歧义但各带**不同 VALID 邮箱** → 各自成键（不因同名塌成一行）', async () => {
    // 两条无邮箱同名 John Smith（如两名不同 officer_id 董事）令来件歧义；来件是两个**不同**人，各带不同邮箱。
    // declined 键必须保留**邮箱判别符**——否则 dx:c:<name> 只按名，会把 alice 与 bob 塌成一行（净新误并，破红线）。
    const twoNoEmailJohns = [
      { id: 'r1', fullName: 'John Smith', contactPoints: [] },
      { id: 'r2', fullName: 'John Smith', contactPoints: [] },
    ];
    const keyFor = async (email: string): Promise<string> => {
      const { tx, canonicalUpsert } = fakeTx(twoNoEmailJohns, { existingBlindedKeys: [] }); // 来件邮箱各自 free
      await persistDiscoveredContacts(tx, {
        workspaceId: 'ws-1',
        company,
        adapterKey: 'decision_maker',
        contacts: [{ externalId: 'x', fullName: 'John Smith', email, personalData: true }],
        suppressedEmails: new Set(),
      });
      return upsertDedupeKey(canonicalUpsert);
    };
    const kAlice = await keyFor('alice@acme.com');
    const kBob = await keyFor('bob@gmail.com');
    expect(kAlice).not.toBe(kBob); // 🔴 不同人不同键（含 VALID 邮箱判别符），绝不塌成一行
    expect(kAlice).toBe(blindContactKey(declinedContactIdentity({ fullName: 'John Smith', email: 'alice@acme.com' }, companyKey)));
  });

  it('无碰撞的真新人 → 仍用明文键盲值（不误入 dx 命名空间，正向路径不被破坏）', async () => {
    const { tx, canonicalUpsert } = fakeTx([]); // 无候选、无既有键 → 碰撞探测返 null
    const zoe: ProviderContactRecord = { externalId: 'x', fullName: 'Zoe New', email: 'zoe@new.test', personalData: true };
    const res = await persistDiscoveredContacts(tx, {
      workspaceId: 'ws-1',
      company,
      adapterKey: 'decision_maker',
      contacts: [zoe],
      suppressedEmails: new Set(),
    });
    expect(res.created).toBe(1);
    const key = upsertDedupeKey(canonicalUpsert);
    expect(key).toBe(blindContactKey(contactIdentity({ fullName: 'Zoe New', email: 'zoe@new.test' }, companyKey))); // 明文 e: 键盲值
    expect(key).not.toBe(blindContactKey(declinedContactIdentity({ fullName: 'Zoe New' }, companyKey))); // 非 dx
  });
});
