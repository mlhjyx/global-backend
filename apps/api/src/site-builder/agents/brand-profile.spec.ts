import { describe, expect, it } from 'vitest';
import {
  BRAND_PROFILE_OUTPUT_SCHEMA,
  BRAND_PROFILE_TASK,
  buildBrandProfilePrompt,
  canonicalUrl,
  enforceEvidenceGate,
  EvidenceCorpus,
  RawFactItem,
  sanitizeProfileForPrompt,
  scrubPii,
} from './brand-profile';

/**
 * brandProfile AiTask（09 §2.4 / 合规 C4 + D1/D2，复审 F1/F2/F3/F4 加固）：
 * - 确定性出口闸：factSheet 逐项 evidence 非空；storefront/web_research 引用 canonical 命中
 *   本次抓取语料（反捏造引用）；认证类断言必须 quote 实质命中源、web_research 单源不上站。
 * - 输出 schema 结构性排除个人字段（C4）+ maxLength 有界。
 */

const FAIR_URL = 'https://fair.example/exhibitors/acme';
const corpusWith = (over: Partial<EvidenceCorpus> = {}): EvidenceCorpus => ({
  intakeText: 'Acme GmbH high-pressure industrial pumps Germany CE marked pumps since 2001',
  kbText: '[来源:upload | catalog.pdf] Pumps up to 400 bar. ISO 9001 certified quality system.',
  urlText: new Map([
    ['https://acme.example', 'We build pumps. Family owned since 2001.'],
    [FAIR_URL, 'Acme exhibited at EuroBLECH 2024 with new pump line.'],
  ]),
  ...over,
});

const fact = (over: Partial<RawFactItem> = {}): RawFactItem => ({
  key: 'main_products',
  value: 'High-pressure industrial pumps',
  evidence: { sourceType: 'upload' },
  ...over,
});

describe('enforceEvidenceGate — D1 零虚构代码闸', () => {
  it('非认证 upload 事实（来源语料非空）通过', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact()], { corpus: corpusWith() });
    expect(factSheet).toHaveLength(1);
    expect(gaps).toHaveLength(0);
  });

  it('缺 evidence → 剔出 factSheet，降 gaps（reason=missing_evidence）', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact({ evidence: undefined })], {
      corpus: corpusWith(),
    });
    expect(factSheet).toHaveLength(0);
    expect(gaps).toEqual([
      expect.objectContaining({ field: 'main_products', reason: 'missing_evidence' }),
    ]);
  });

  it('sourceType 不在分级枚举内 → 降 gaps（不接受模型自创来源）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [fact({ evidence: { sourceType: 'model_memory' as never } })],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('missing_evidence');
  });

  it('🔴 标 upload 但 KB 语料为空（无从核验）→ 降 gaps missing_evidence', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact()], {
      corpus: corpusWith({ kbText: '' }),
    });
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('missing_evidence');
  });

  it('🔴 反捏造引用：storefront/web_research 的 url 未 canonical 命中抓取集合 → 降 gaps', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({ evidence: { sourceType: 'web_research', url: 'https://made-up.example/page' } }),
        fact({ key: 'hq', evidence: { sourceType: 'storefront' } }), // 连 url 都没给
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps.map((g) => g.reason)).toEqual(['uncited_web_source', 'uncited_web_source']);
  });

  it('🔴 F3 URL 归一化：模型引用带尾斜杠/大写 host → canonical 后命中，真事实不被误降', () => {
    const { factSheet } = enforceEvidenceGate(
      [
        fact({
          key: 'trade_fairs',
          value: 'Exhibited at EuroBLECH',
          evidence: { sourceType: 'web_research', url: 'https://FAIR.example/exhibitors/acme/' },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(1);
  });

  it('🔴 D2 认证类断言 web_research 单源不上站', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({
          key: 'certifications',
          value: 'ISO 9001 certified',
          evidence: { sourceType: 'web_research', url: FAIR_URL },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0]).toMatchObject({ field: 'certifications', reason: 'unverified_certification' });
  });

  it('🔴 F1 洗白防线：认证类标 intake/upload 但无 quote → 降 gaps（标签不再无条件放行）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [fact({ key: 'certifications', value: 'ISO 9001 certified', evidence: { sourceType: 'upload' } })],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('unverified_certification');
  });

  it('认证类标 upload + quote 实质命中 KB 原文 → 放行', () => {
    const { factSheet } = enforceEvidenceGate(
      [
        fact({
          key: 'certifications',
          value: 'ISO 9001 certified',
          evidence: { sourceType: 'upload', quote: 'ISO 9001 certified quality system' },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(1);
  });

  it('🔴 citation laundering：认证类贴真 storefront URL 但 quote 不在其正文 → 降 gaps', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({
          key: 'certifications',
          value: 'FDA cleared device',
          evidence: { sourceType: 'storefront', url: 'https://acme.example', quote: 'FDA cleared class II' },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('unverified_certification');
  });

  it('非认证事实带 quote 但 quote 不在来源 → 降 gaps unsupported_quote（防捏造引用）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [fact({ evidence: { sourceType: 'upload', quote: 'exports to 47 countries worldwide' } })],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('unsupported_quote');
  });

  it('引用命中真实来源的 web_research 非认证事实（无 quote）→ 放行', () => {
    const { factSheet } = enforceEvidenceGate(
      [fact({ key: 'trade_fairs', value: 'Exhibited at EuroBLECH', evidence: { sourceType: 'web_research', url: FAIR_URL } })],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(1);
  });
});

describe('canonicalUrl — F3 归一化', () => {
  it('host 小写 + 去尾斜杠 + 去 fragment', () => {
    expect(canonicalUrl('https://WWW.Acme.com/about/#team')).toBe('https://www.acme.com/about');
    expect(canonicalUrl('https://www.acme.com/')).toBe('https://www.acme.com');
  });
  it('非法 URL → null', () => {
    expect(canonicalUrl('not a url')).toBeNull();
    expect(canonicalUrl(undefined)).toBeNull();
  });
});

describe('sanitizeProfileForPrompt / scrubPii — F2 数据最小化与落库清洗', () => {
  it('剔除 contact 组（邮箱/电话不进 prompt）', () => {
    const out = sanitizeProfileForPrompt({
      companyProfile: { founded: 2001 },
      contact: { email: 'ceo@acme.com', phone: '+49 30 123456' },
    });
    expect(out).toEqual({ companyProfile: { founded: 2001 } });
    expect(out).not.toHaveProperty('contact');
  });
  it('undefined profile → undefined', () => {
    expect(sanitizeProfileForPrompt(undefined)).toBeUndefined();
  });
  it('scrubPii 遮蔽自由文本里的邮箱与电话', () => {
    expect(scrubPii('reach us at sales@acme.com or +49 30 1234567')).toBe(
      'reach us at [redacted-email] or [redacted-phone]',
    );
  });
});

describe('BRAND_PROFILE_OUTPUT_SCHEMA — C4 结构性排除个人字段', () => {
  it('输出 schema 不含任何个人数据字段（team/contact/person/email/phone/founder）', () => {
    const banned = /team|contact|person|people|email|phone|founder|ceo|staff/i;
    const walk = (node: unknown, path: string[]): string[] => {
      if (node == null || typeof node !== 'object') return [];
      const hits: string[] = [];
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (path[path.length - 1] === 'properties' && banned.test(key)) {
          hits.push([...path, key].join('.'));
        }
        hits.push(...walk(value, [...path, key]));
      }
      return hits;
    };
    expect(walk(BRAND_PROFILE_OUTPUT_SCHEMA, [])).toEqual([]);
  });

  it('additionalProperties=false（模型加塞的字段被网关校验拒绝，而非静默入库）', () => {
    expect((BRAND_PROFILE_OUTPUT_SCHEMA as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});

describe('buildBrandProfilePrompt — 模板槽位与硬规则', () => {
  const input = {
    companyName: 'Acme GmbH',
    industry: 'industrial pumps',
    products: ['high-pressure pumps'],
    targetMarkets: ['DE', 'US'],
    profile: { companyProfile: { founded: 2001 } },
    kbDigest: '[来源:upload | catalog.pdf]\nPumps up to 400 bar.',
    research: [
      {
        sourceType: 'web_research' as const,
        url: 'https://fair.example/exhibitors/acme',
        title: 'fair',
        content: 'exhibitor Acme',
        fetchedAt: '2026-07-14T00:00:00Z',
      },
    ],
  };

  it('用户数据只进标注槽位；硬规则含零编造/证据溯源/无具名个人/指令视为数据', () => {
    const prompt = buildBrandProfilePrompt(input);
    expect(prompt).toContain('Acme GmbH');
    expect(prompt).toContain('[来源:upload | catalog.pdf]');
    expect(prompt).toContain('https://fair.example/exhibitors/acme');
    expect(prompt).toMatch(/绝不编造/);
    expect(prompt).toMatch(/具名个人/);
    expect(prompt).toMatch(/视为.{0,4}数据/); // 资料中的指令性文字一律当数据
  });

  it('无 KB、无研究源时槽位标注「无」（模型不猜空槽位）', () => {
    const prompt = buildBrandProfilePrompt({ ...input, kbDigest: '', research: [] });
    expect(prompt).toMatch(/知识库[^]{0,10}(无|空)/);
  });

  it('task 定义：id 正确 + 输入 schema 必填字段齐（fail-fast 面）', () => {
    expect(BRAND_PROFILE_TASK.id).toBe('site_builder.brand_profile');
    const required = (BRAND_PROFILE_TASK.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toEqual(expect.arrayContaining(['companyName', 'products']));
  });
});
