import { describe, expect, it } from 'vitest';
import { companyIdentity, contactIdentity, declinedContactIdentity, normalizeCompanyName, normalizeDomain } from './identity';

describe('identity resolution（PRD 8.8 确定性规则）', () => {
  it('域名规范化：协议/www/路径剥离', () => {
    expect(normalizeDomain('https://www.Acme-Tech.COM/en/about')).toBe('acme-tech.com');
    expect(normalizeDomain(null)).toBeNull();
  });

  it('公司名规范化：法律后缀剥离 + 大小写', () => {
    expect(normalizeCompanyName('Acme Manufacturing GmbH')).toBe('acme manufacturing');
    expect(normalizeCompanyName('深圳精密制造有限公司')).toBe('深圳精密制造');
  });

  it('有域名 → domain_exact；无域名 → name_country', () => {
    expect(companyIdentity({ name: 'Acme', domain: 'acme.com' })).toEqual({
      dedupeKey: 'd:acme.com',
      matchRule: 'domain_exact',
    });
    expect(companyIdentity({ name: 'Acme GmbH', country: 'DE' })).toEqual({
      dedupeKey: 'n:acme:de',
      matchRule: 'name_country',
    });
  });

  it('同公司不同来源（www 变体）解析到同一 dedupeKey', () => {
    const a = companyIdentity({ name: 'Acme', domain: 'www.acme.com' });
    const b = companyIdentity({ name: 'ACME Inc.', domain: 'https://acme.com' });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});

describe('§8.4 identifier 身份规则（税号/注册号）—— 优先级 domain > identifier > name+country', () => {
  it('无域名 + identifier → identifier_exact（scheme:归一值）', () => {
    expect(
      companyIdentity({ name: 'SPIE GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE 291499156' } }),
    ).toEqual({ dedupeKey: 'id:ted-natid:de291499156', matchRule: 'identifier_exact' });
  });

  it('有域名时 domain 仍压过 identifier（域名最强）', () => {
    const k = companyIdentity({
      name: 'SPIE',
      domain: 'spie.de',
      identifier: { scheme: 'ted-natid', value: 'DE 291499156' },
    });
    expect(k).toEqual({ dedupeKey: 'd:spie.de', matchRule: 'domain_exact' });
  });

  it('同名同国、identifier 不同 → 不同 key（根治 §8.4 误并）', () => {
    const a = companyIdentity({ name: 'Müller GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE111' } });
    const b = companyIdentity({ name: 'Müller GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: 'DE222' } });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('同值不同 scheme（ted-natid vs lei）→ 不同 key（绝不跨 id 体系串号）', () => {
    const a = companyIdentity({ name: 'X', country: 'DE', identifier: { scheme: 'ted-natid', value: '529900X' } });
    const b = companyIdentity({ name: 'X', country: 'DE', identifier: { scheme: 'lei', value: '529900X' } });
    expect(a.dedupeKey).not.toBe(b.dedupeKey);
  });

  it('空/空白 identifier 值 → 回退 name_country（不产生 id:scheme: 空 key）', () => {
    expect(companyIdentity({ name: 'Acme GmbH', country: 'DE', identifier: { scheme: 'ted-natid', value: '  ' } })).toEqual({
      dedupeKey: 'n:acme:de',
      matchRule: 'name_country',
    });
  });
});

describe('declinedContactIdentity（待办2 create 层收尾：resolve 拒并时的不碰撞键）', () => {
  const ck = 'd:acme.com';

  it('无 externalId → dx:c:<companyKey>:<归一人名>（按名，绝不用 email）', () => {
    // RISKY 场景：Bob Jones 撞了 Anna 的 catch-all 邮箱，declined 键必须按名把 Bob 与 Anna 分开
    expect(declinedContactIdentity({ fullName: 'Bob Jones' }, ck)).toBe('dx:c:d:acme.com:bob jones');
  });

  it('有 externalId → dx:x:<companyKey>:<scheme:value 小写>（同名不同 officer_id 各自成键）', () => {
    expect(declinedContactIdentity({ fullName: 'Whoever', externalIds: [{ scheme: 'UK-CH-Officer', value: 'OID2' }] }, ck)).toBe(
      'dx:x:d:acme.com:uk-ch-officer:oid2',
    );
  });

  it('无 externalId、有可信 email → dx:e:<companyKey>:<归一名>:<email 小写>（名+邮箱双判别符）', () => {
    expect(declinedContactIdentity({ fullName: 'John Smith', email: 'Alice@Acme.com' }, ck)).toBe(
      'dx:e:d:acme.com:john smith:alice@acme.com',
    );
  });

  it('🔴 dx:e 键含人名 → 不同名共用同一 catch-all 邮箱也各自成键（不塌成一行）', () => {
    // 残余硬化：dx:e 只按 email 时，两不同名的人共用一 catch-all 地址会塌键；含人名后各自成键
    expect(declinedContactIdentity({ fullName: 'Alice Smith', email: 'info@acme.com' }, ck)).not.toBe(
      declinedContactIdentity({ fullName: 'Bob Jones', email: 'info@acme.com' }, ck),
    );
  });

  it('判别符优先级 externalId > email > 人名（三者齐备取 externalId）', () => {
    expect(
      declinedContactIdentity(
        { fullName: 'John Smith', email: 'alice@acme.com', externalIds: [{ scheme: 'uk-ch-officer', value: 'OID1' }] },
        ck,
      ),
    ).toBe('dx:x:d:acme.com:uk-ch-officer:oid1');
    // 无 externalId 时 email（含人名）压过纯人名键
    expect(declinedContactIdentity({ fullName: 'John Smith', email: 'alice@acme.com' }, ck)).toBe(
      'dx:e:d:acme.com:john smith:alice@acme.com',
    );
  });

  it('人名归一与 contactIdentity 的 c 形一致（小写 + 折叠空白 + 去首尾）', () => {
    expect(declinedContactIdentity({ fullName: '  Anna   Weber ' }, ck)).toBe('dx:c:d:acme.com:anna weber');
  });

  it('declined dx:c 用 resolver 同款归一 → 称谓/逗号语序变体幂等落同一 declined 行（#67 P2）', () => {
    const plain = declinedContactIdentity({ fullName: 'Anna Weber' }, ck);
    expect(declinedContactIdentity({ fullName: 'Dr. Anna Weber' }, ck)).toBe(plain);
    expect(declinedContactIdentity({ fullName: 'Weber, Anna' }, ck)).toBe(plain);
    expect(plain).toBe('dx:c:d:acme.com:anna weber');
  });

  it('declined dx:e 人名部同样 resolver 归一（Dr. 变体 + 同 email 幂等同键）', () => {
    expect(declinedContactIdentity({ fullName: 'Dr. John Smith', email: 'a@acme.com' }, ck)).toBe(
      declinedContactIdentity({ fullName: 'John Smith', email: 'a@acme.com' }, ck),
    );
  });

  it('确定性：同输入 → 同键（同源再跑幂等的基石）', () => {
    const a = declinedContactIdentity({ fullName: 'Anna Weber' }, ck);
    const b = declinedContactIdentity({ fullName: 'Anna Weber' }, ck);
    expect(a).toBe(b);
  });

  it('多 externalId → 排序取首（确定性，不受输入顺序影响）', () => {
    const a = declinedContactIdentity(
      { fullName: 'X', externalIds: [{ scheme: 'b-scheme', value: 'v2' }, { scheme: 'a-scheme', value: 'v1' }] },
      ck,
    );
    const b = declinedContactIdentity(
      { fullName: 'X', externalIds: [{ scheme: 'a-scheme', value: 'v1' }, { scheme: 'b-scheme', value: 'v2' }] },
      ck,
    );
    expect(a).toBe(b);
    expect(a).toBe('dx:x:d:acme.com:a-scheme:v1');
  });

  it('🔴 dx: 命名空间与明文 e:/c: 互斥 → declined 键绝不与既有 non-declined 行碰撞', () => {
    expect(declinedContactIdentity({ fullName: 'Anna Weber' }, ck)).not.toBe(
      contactIdentity({ fullName: 'Anna Weber' }, ck),
    );
    // 撞 catch-all 邮箱的记录：declined 键（按名）≠ 明文 e:<email> 键
    expect(declinedContactIdentity({ fullName: 'Bob Jones' }, ck)).not.toBe(
      contactIdentity({ fullName: 'Bob Jones', email: 'a.weber@catchall.test' }, ck),
    );
  });

  it('🔴 按公司隔离：同 externalId 跨公司 → 不同键（同一董事任两家公司不误并成一联系人）', () => {
    const a = declinedContactIdentity({ fullName: 'X', externalIds: [{ scheme: 'uk-ch-officer', value: 'OID1' }] }, 'd:a.com');
    const b = declinedContactIdentity({ fullName: 'X', externalIds: [{ scheme: 'uk-ch-officer', value: 'OID1' }] }, 'd:b.com');
    expect(a).not.toBe(b);
  });

  it('🔴 不同名 → 不同键；同名 → 同键（floor：无可区分信息才折叠）', () => {
    expect(declinedContactIdentity({ fullName: 'Bob Jones' }, ck)).not.toBe(declinedContactIdentity({ fullName: 'Alice Roe' }, ck));
    expect(declinedContactIdentity({ fullName: 'Bob Jones' }, ck)).toBe(declinedContactIdentity({ fullName: 'bob jones' }, ck));
  });
});
