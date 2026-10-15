import { describe, expect, it } from 'vitest';
import {
  screenName,
  prepareName,
  buildSanctionsIndex,
  type IndexedSanctionsEntity,
  type SanctionsEntityRow,
} from './sanctions-matcher';

/**
 * 制裁匹配核心（召回优先）单测。红线：**弱别名不 originate 命中**、**国别背离不清候选**、**返回全部超阈候选**。
 */

function idx(
  externalId: string,
  primaryName: string,
  opts: {
    sourceKey?: string;
    country?: string | null;
    aliases?: { name: string; quality: 'strong' | 'weak' }[];
  } = {},
): IndexedSanctionsEntity {
  const p = prepareName(primaryName);
  return {
    externalId,
    sourceKey: opts.sourceKey ?? 'ofac_sdn',
    primaryName,
    normalizedPrimary: p.normalized,
    primaryTokens: p.tokens,
    primaryCoreTokens: p.coreTokens,
    country: opts.country ?? null,
    listVersion: '2026-07-13',
    aliases: (opts.aliases ?? []).map((a) => ({ name: a.name, ...prepareName(a.name), quality: a.quality })),
  };
}

describe('screenName（召回优先匹配）', () => {
  it('精确归一名 → 满分候选，aliasQuality=primary', () => {
    const m = screenName('AEROCARIBBEAN AIRLINES', null, [idx('36', 'AEROCARIBBEAN AIRLINES')]);
    expect(m).toHaveLength(1);
    expect(m[0].nameScore).toBe(1);
    expect(m[0].aliasQuality).toBe('primary');
    expect(m[0].matchedName).toBe('AEROCARIBBEAN AIRLINES');
  });

  it('命中强别名 → 候选，aliasQuality=strong', () => {
    const ent = idx('9', 'GLOBAL WIDGETS', { aliases: [{ name: 'ACME CORP', quality: 'strong' }] });
    const m = screenName('ACME CORP', null, [ent]);
    expect(m).toHaveLength(1);
    expect(m[0].aliasQuality).toBe('strong');
    expect(m[0].matchedName).toBe('ACME CORP');
  });

  it('🔴 仅命中弱别名（primaryName/强别名都不匹配）→ 绝不 originate 候选', () => {
    const ent = idx('9', 'GLOBAL WIDGETS', { aliases: [{ name: 'GW', quality: 'weak' }] });
    expect(screenName('GW', null, [ent])).toEqual([]);
  });

  it('弱别名只升高已 originate 的候选（不凭空建）', () => {
    // primaryName 'ACME INTERNATIONAL' vs 'ACME' → 0.80 originate；弱别名 'ACME' 精确 → 升到 1.0
    // （'international' 非法人后缀不被剥；'holdings/company/corp' 会被 normalizeCompanyName 剥）
    const ent = idx('9', 'ACME INTERNATIONAL', { aliases: [{ name: 'ACME', quality: 'weak' }] });
    const m = screenName('ACME', null, [ent]);
    expect(m).toHaveLength(1);
    expect(m[0].nameScore).toBe(1);
    expect(m[0].aliasQuality).toBe('weak');
  });

  it('低于阈值 → 无候选', () => {
    expect(screenName('TOTALLY UNRELATED CO', null, [idx('36', 'AEROCARIBBEAN AIRLINES')])).toEqual([]);
  });

  it('🔴 M3a 双向召回：实体短名 ⊆ 公司全名（Tinkoff vs "Tinkoff Bank JSC"）也命中（单向会漏）', () => {
    const m = screenName('Tinkoff Bank JSC', null, [idx('7', 'Tinkoff')]);
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].externalId).toBe('7');
  });

  it('国别一致 → 展示分加成；背离 → 降展示分但仍是候选（不自动清）', () => {
    const ent = idx('36', 'AEROCARIBBEAN AIRLINES', { country: 'CU' });
    const same = screenName('AEROCARIBBEAN AIRLINES', 'CU', [ent])[0];
    expect(same.countryMatch).toBe('same');
    expect(same.score).toBeGreaterThanOrEqual(same.nameScore);

    const diverge = screenName('AEROCARIBBEAN AIRLINES', 'US', [ent])[0];
    expect(diverge).toBeDefined(); // 背离仍是候选
    expect(diverge.countryMatch).toBe('diverge');
    expect(diverge.score).toBeLessThan(diverge.nameScore); // 展示分降
    expect(diverge.nameScore).toBe(1); // 名字分不受国别影响
  });

  it('法人形式归一：AEROCARIBBEAN AIRLINES GmbH ≡ AEROCARIBBEAN AIRLINES（复用 name-match）', () => {
    const m = screenName('AEROCARIBBEAN AIRLINES GmbH', null, [idx('36', 'AEROCARIBBEAN AIRLINES')]);
    expect(m.length).toBeGreaterThan(0);
  });

  it('多实体命中 → 全部返回，按展示分降序', () => {
    const index = [idx('1', 'ACME'), idx('2', 'ACME INTERNATIONAL'), idx('3', 'UNRELATED')];
    const m = screenName('ACME', null, index);
    expect(m.map((x) => x.externalId).sort()).toEqual(['1', '2']); // 3 不命中
    expect(m[0].externalId).toBe('1'); // 精确 'ACME'(1.0) 先于 'ACME INTERNATIONAL'(0.80)
  });

  it('空/无核心 token 查询 → 空（防泛匹配）', () => {
    expect(screenName('', null, [idx('36', 'AEROCARIBBEAN AIRLINES')])).toEqual([]);
  });
});

/**
 * 实体名开头的俄式法律形式（FSE = Federal State Enterprise、OOO、AO、JSC…）和 GmbH、LLC 一样不是身份。
 * xin 2026-10-15 重评：德国公司「FSE」命中 6 条以「FSE」开头的 EU/OFAC 实体，全部是误报。
 * 规则：一个名字（主名或强/弱别名）只有在查询与它**去掉开头法律形式后的核心词**至少共享 1 个词时才算数；
 * 分数照旧按完整 token 算。所以只去掉「唯一重合是法律形式」的命中，其余命中的分数与改动前逐字相同、
 * 不新增候选。#660 复审：只剥实体侧会让「Kalashnikov JSC」这类两侧都带法律形式的真命中漏掉，故不剥分数用的 token。
 */
describe('实体名开头的俄式法律形式：唯一重合是法律形式时不算命中', () => {
  it('公司「FSE」不再命中以 FSE 开头的实体主名', () => {
    expect(screenName('FSE', null, [idx('fse-1', 'FSE Kamensky Zavod', { sourceKey: 'eu_fsf', country: 'RU' })])).toEqual([]);
  });

  it('公司「FSE」不再命中以 FSE 开头的强别名', () => {
    const ent = idx('fse-2', 'Alekszini Vegyi Üzem Szövetségi Állami Vállalat', {
      sourceKey: 'eu_fsf',
      country: 'RU',
      aliases: [{ name: 'FSE AHK', quality: 'strong' }, { name: 'FSE ACP VYMPEL', quality: 'strong' }],
    });
    expect(screenName('FSE', null, [ent])).toEqual([]);
  });

  it('多个法律形式连在一起也一路剥完：公司「AO」不命中「ZAO AO KVORUM」', () => {
    expect(screenName('AO', null, [idx('kvorum-1', 'ZAO AO KVORUM')])).toEqual([]);
  });

  it.each([
    // #660 复审用公开名单找到的回归场景：两侧都带法律形式、核心词部分覆盖。
    ['Kalashnikov JSC', 'JSC KALASHNIKOV CONCERN', 0.8],
    ['OJSC Belavia', 'OJSC BELAVIA BELARUSIAN AIRLINES', 0.75],
    ['OOO Volga', 'OOO VOLGA GROUP', 0.8],
    ['Almaz-Antey JSC', 'JSC CONCERN VKO ALMAZ ANTEY', 0.75],
  ])('两侧都带法律形式的真命中保留且分数不变：%s ↔ %s', (company, entityName, score) => {
    const [m] = screenName(company, 'RU', [idx('ru-hit', entityName, { country: 'RU' })]);
    expect(m).toMatchObject({ externalId: 'ru-hit', nameScore: score });
  });

  it('核心词有重合时分数与改动前相同（按完整 token 算，不因剥法律形式而升分）', () => {
    const [m] = screenName('Kamensky Zavod GmbH', 'RU', [idx('fse-3', 'FSE Kamensky Zavod', { country: 'RU' })]);
    expect(m).toMatchObject({ externalId: 'fse-3', nameScore: 0.8, aliasQuality: 'primary' });
  });

  it('不新增候选：「Saturn Electronics GmbH」与「JSC Saturn」改动前不命中，改动后也不命中', () => {
    expect(screenName('Saturn Electronics GmbH', null, [idx('saturn', 'JSC Saturn')])).toEqual([]);
  });

  it('末尾括号里的缩写不是法律形式：照旧是候选，交人审', () => {
    const [m] = screenName('FSE', null, [idx('fse-4', 'Fanavaran Sanat Ertebatat Company (FSE)', { sourceKey: 'eu_fsf' })]);
    expect(m).toMatchObject({ externalId: 'fse-4' });
  });

  it('名字只由法律形式组成时核心至少留一个 token（不制造空核心）', () => {
    expect(prepareName('OOO AO').coreTokens).toEqual(new Set(['ao']));
    expect(prepareName('AO').coreTokens).toEqual(new Set(['ao']));
  });

  it('查询侧与分数用 token 都不剥：同名「OOO Romashka」仍是精确满分', () => {
    const [m] = screenName('OOO Romashka', null, [idx('ru-q', 'OOO Romashka')]);
    expect(m).toMatchObject({ externalId: 'ru-q', nameScore: 1 });
  });
});

describe('buildSanctionsIndex（DB 行 → 索引）', () => {
  const rows: SanctionsEntityRow[] = [
    {
      externalId: '36',
      sourceKey: 'ofac_sdn',
      primaryName: 'AEROCARIBBEAN AIRLINES',
      country: 'CU',
      listVersion: '2026-07-13',
      aliases: [
        { name: 'AERO-CARIBBEAN', quality: 'strong' },
        { name: 'ACN', quality: 'weak' },
        { name: 42, quality: 'strong' }, // 非字符串 → 过滤
      ],
    },
  ];
  const index = buildSanctionsIndex(rows);

  it('归一主名 + token 预算，别名保质量、非字符串过滤', () => {
    expect(index).toHaveLength(1);
    const e = index[0];
    expect(e.normalizedPrimary).toBe(prepareName('AEROCARIBBEAN AIRLINES').normalized);
    expect(e.aliases.map((a) => `${a.name}:${a.quality}`)).toEqual(['AERO-CARIBBEAN:strong', 'ACN:weak']);
    expect(e.primaryTokens.has('aerocaribbean')).toBe(true);
  });

  it('建好的索引可直接筛（端到端）：强别名命中', () => {
    const m = screenName('AERO-CARIBBEAN', 'CU', index);
    expect(m).toHaveLength(1);
    expect(m[0].aliasQuality).toBe('strong');
    expect(m[0].countryMatch).toBe('same');
  });

  it('aliases 非数组 → 空别名（fail-safe）', () => {
    const e = buildSanctionsIndex([{ ...rows[0], aliases: null }])[0];
    expect(e.aliases).toEqual([]);
  });
});
