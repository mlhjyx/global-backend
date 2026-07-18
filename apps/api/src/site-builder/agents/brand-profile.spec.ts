import { describe, expect, it } from 'vitest';
import { checkAgainstSchema } from '../../model-gateway/schema-validate';
import * as brandProfileModule from './brand-profile';
import {
  BRAND_PROFILE_INPUT_SCHEMA,
  BRAND_PROFILE_OUTPUT_SCHEMA,
  BRAND_PROFILE_TASK,
  buildBrandProfilePrompt,
  canonicalUrl,
  enforceEvidenceGate,
  enforceEvidenceGateV2,
  EvidenceCorpus,
  RawFactItem,
  sanitizeProfileForPrompt,
  scrubPii,
} from './brand-profile';
import { freezeEvidenceSource } from './evidence-ref';

/**
 * brandProfile AiTask（09 §2.4 / 合规 C4 + D1/D2，复审 F1/F2/F3/F4 加固）：
 * - 确定性出口闸：factSheet 逐项 evidence 非空；storefront/web_research 引用 canonical 命中
 *   本次抓取语料（反捏造引用）；认证类断言必须 quote 实质命中源、web_research 单源不上站。
 * - 输出 schema 结构性排除个人字段（C4）+ maxLength 有界。
 */

const FAIR_URL = 'https://fair.example/exhibitors/acme';
const corpusWith = (over: Partial<EvidenceCorpus> = {}): EvidenceCorpus => ({
  intakeText:
    'Acme GmbH high-pressure industrial pumps Germany CE marked pumps since 2001',
  kbText:
    '[来源:upload | catalog.pdf] Pumps up to 400 bar. ISO 9001 certified quality system.',
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

describe('enforceEvidenceGateV2 — all new facts bind exact frozen evidence', () => {
  const frozen = freezeEvidenceSource({
    sourceKey: 'kb_document:doc-1',
    sourceType: 'upload',
    sourceRole: 'fact_candidate',
    rawText: 'Pumps up to 400 bar. ISO 9001 certified quality system.',
    provenance: { documentId: 'doc-1', chunkIds: ['chunk-1'] },
  });
  const sources = new Map([['source-1', frozen]]);

  it('hydrates a server-owned EvidenceRef v2 and returns a persistence row', () => {
    const out = enforceEvidenceGateV2(
      [
        fact({
          evidence: {
            sourceType: 'upload',
            sourceId: 'source-1',
            contentHash: frozen.contentHash,
            quote: 'Pumps up to 400 bar',
          },
        }),
      ],
      { sources, createEvidenceRefId: () => 'ref-1' },
    );

    expect(out.gaps).toEqual([]);
    expect(out.factSheet[0].evidence).toMatchObject({
      version: 2,
      evidenceRefId: 'ref-1',
      sourceId: 'source-1',
      contentHash: frozen.contentHash,
      quote: 'Pumps up to 400 bar',
    });
    expect(out.refs).toEqual([
      expect.objectContaining({ evidenceRefId: 'ref-1' }),
    ]);
  });

  it('rejects ordinary facts without an exact quote (v1 permissive behavior is read-only legacy)', () => {
    const out = enforceEvidenceGateV2(
      [
        fact({
          evidence: {
            sourceType: 'upload',
            sourceId: 'source-1',
            contentHash: frozen.contentHash,
          },
        }),
      ],
      { sources, createEvidenceRefId: () => 'ref-1' },
    );

    expect(out.factSheet).toEqual([]);
    expect(out.gaps[0].reason).toBe('missing_evidence');
  });

  it('retains the existing certification rule: web-research-only certification is still a gap', () => {
    const hint = freezeEvidenceSource({
      sourceKey: 'search:https://directory.example/acme',
      sourceType: 'web_research',
      sourceRole: 'research_hint',
      rawText: 'Acme is ISO 9001 certified.',
      displayUrl: 'https://directory.example/acme',
      provenance: { parserVersion: 'searxng-snippet/1' },
    });
    const out = enforceEvidenceGateV2(
      [
        fact({
          key: 'certifications',
          value: 'ISO 9001 certified',
          evidence: {
            sourceType: 'web_research',
            sourceId: 'hint-1',
            contentHash: hint.contentHash,
            quote: 'ISO 9001 certified',
          },
        }),
      ],
      {
        sources: new Map([['hint-1', hint]]),
        createEvidenceRefId: () => 'ref-1',
      },
    );

    expect(out.factSheet).toEqual([]);
    expect(out.gaps[0].reason).toBe('unverified_certification');
  });
});

describe('enforceEvidenceGateV2 — R4-A2 value/quote truth gate', () => {
  const evaluate = (input: {
    key: string;
    value: string;
    quote: string;
    sourceRole?: 'fact_candidate' | 'research_hint';
  }) => {
    const sourceRole = input.sourceRole ?? 'fact_candidate';
    const frozen = freezeEvidenceSource({
      sourceKey: `truth-gate:${input.key}:${sourceRole}`,
      sourceType: sourceRole === 'research_hint' ? 'web_research' : 'upload',
      sourceRole,
      rawText: input.quote,
      ...(sourceRole === 'research_hint'
        ? {
            displayUrl: 'https://directory.example/acme',
            provenance: { parserVersion: 'searxng-snippet/1' },
          }
        : {
            provenance: {
              documentId: 'truth-gate-document',
              chunkIds: ['truth-gate-chunk'],
            },
          }),
    });

    return enforceEvidenceGateV2(
      [
        fact({
          key: input.key,
          value: input.value,
          evidence: {
            sourceType: frozen.sourceType,
            sourceId: 'truth-gate-source',
            contentHash: frozen.contentHash,
            quote: input.quote,
          },
        }),
      ],
      {
        sources: new Map([['truth-gate-source', frozen]]),
        createEvidenceRefId: () => 'truth-gate-ref',
      },
    );
  };

  it.each([
    {
      name: 'pressure value 300 bar cannot cite a 160 bar quote',
      key: 'maximum_pressure',
      value: 'Maximum working pressure: 300 bar',
      quote: 'Maximum working pressure: 160 bar.',
    },
    {
      name: 'frequency value 60 Hz cannot cite a 50 Hz quote',
      key: 'rated_frequency',
      value: 'Rated frequency: 60 Hz',
      quote: 'Rated frequency: 50 Hz.',
    },
    {
      name: 'ISO 14001 cannot cite an ISO 9001 quote',
      key: 'certifications',
      value: 'ISO 14001 certified',
      quote: 'ISO 9001 certified quality system.',
    },
    {
      name: 'a product model cannot cite a different product model',
      key: 'product_model',
      value: 'Product model: PX-900',
      quote: 'Flagship product model: PX-300.',
    },
    {
      name: 'Unicode normalization must not turn a model prefix into an exact token match',
      key: 'product_model',
      value: 'Product model: ＡＢＣ-300',
      quote: 'Product model: ABC-3000.',
    },
    {
      name: 'CJK-adjacent digits still require a complete product-model token',
      key: 'product_model',
      value: '产品型号：泵王300',
      quote: '主力产品型号：泵王3000。',
    },
  ])('$name', ({ key, value, quote }) => {
    const out = evaluate({ key, value, quote });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        field: key,
        reason: 'evidence_value_mismatch',
      }),
    ]);
  });

  it('an exact quote from research_hint remains non-publishable and is downgraded to a gap', () => {
    const out = evaluate({
      key: 'trade_fairs',
      value: 'Exhibited at EuroBLECH 2024',
      quote: 'Exhibited at EuroBLECH 2024',
      sourceRole: 'research_hint',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        field: 'trade_fairs',
        reason: 'research_hint_not_publishable',
      }),
    ]);
  });

  it('accepts a fact_candidate whose protected value is supported by the exact quote', () => {
    const out = evaluate({
      key: 'maximum_pressure',
      value: 'Maximum pressure reaches 160 bar',
      quote: 'The PX-300 maximum working pressure reaches 160 bar.',
    });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toEqual([
      expect.objectContaining({
        key: 'maximum_pressure',
        value: 'Maximum pressure reaches 160 bar',
        evidence: expect.objectContaining({
          evidenceRefId: 'truth-gate-ref',
          sourceRole: 'fact_candidate',
          quote: 'The PX-300 maximum working pressure reaches 160 bar.',
        }),
      }),
    ]);
    expect(out.refs).toHaveLength(1);
  });

  it('rejects a product fact whose exact product value is absent from the quote', () => {
    const out = evaluate({
      key: 'main_products',
      value: 'Industrial pumps',
      quote: 'Precision bearings for industrial machinery.',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        field: 'main_products',
        reason: 'evidence_value_mismatch',
      }),
    ]);
  });

  it('accepts known numeric units with harmless source whitespace differences', () => {
    const out = evaluate({
      key: 'maximum_pressure',
      value: 'Maximum working pressure: 160 bar',
      quote: 'Maximum working pressure reaches 160bar.',
    });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it('accepts a CJK product model followed by the natural 型 suffix', () => {
    const out = evaluate({
      key: 'product_model',
      value: '产品型号：泵王300',
      quote: '主力产品是泵王300型高压泵。',
    });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });
});

describe('enforceEvidenceGate — D1 零虚构代码闸', () => {
  it('非认证 upload 事实（来源语料非空）通过', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact()], {
      corpus: corpusWith(),
    });
    expect(factSheet).toHaveLength(1);
    expect(gaps).toHaveLength(0);
  });

  it('缺 evidence → 剔出 factSheet，降 gaps（reason=missing_evidence）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [fact({ evidence: undefined })],
      {
        corpus: corpusWith(),
      },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps).toEqual([
      expect.objectContaining({
        field: 'main_products',
        reason: 'missing_evidence',
      }),
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
        fact({
          evidence: {
            sourceType: 'web_research',
            url: 'https://made-up.example/page',
          },
        }),
        fact({ key: 'hq', evidence: { sourceType: 'storefront' } }), // 连 url 都没给
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps.map((g) => g.reason)).toEqual([
      'uncited_web_source',
      'uncited_web_source',
    ]);
  });

  it('🔴 F3 URL 归一化：模型引用带尾斜杠/大写 host → canonical 后命中，真事实不被误降', () => {
    const { factSheet } = enforceEvidenceGate(
      [
        fact({
          key: 'trade_fairs',
          value: 'Exhibited at EuroBLECH',
          evidence: {
            sourceType: 'web_research',
            url: 'https://FAIR.example/exhibitors/acme/',
          },
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
    expect(gaps[0]).toMatchObject({
      field: 'certifications',
      reason: 'unverified_certification',
    });
  });

  it('🔴 F1 洗白防线：认证类标 intake/upload 但无 quote → 降 gaps（标签不再无条件放行）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({
          key: 'certifications',
          value: 'ISO 9001 certified',
          evidence: { sourceType: 'upload' },
        }),
      ],
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
          evidence: {
            sourceType: 'upload',
            quote: 'ISO 9001 certified quality system',
          },
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
          evidence: {
            sourceType: 'storefront',
            url: 'https://acme.example',
            quote: 'FDA cleared class II',
          },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('unverified_certification');
  });

  it('非认证事实带 quote 但 quote 不在来源 → 降 gaps unsupported_quote（防捏造引用）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({
          evidence: {
            sourceType: 'upload',
            quote: 'exports to 47 countries worldwide',
          },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('unsupported_quote');
  });

  it('引用命中真实来源的 web_research 非认证事实（无 quote）→ 放行', () => {
    const { factSheet } = enforceEvidenceGate(
      [
        fact({
          key: 'trade_fairs',
          value: 'Exhibited at EuroBLECH',
          evidence: { sourceType: 'web_research', url: FAIR_URL },
        }),
      ],
      { corpus: corpusWith() },
    );
    expect(factSheet).toHaveLength(1);
  });
});

describe('canonicalUrl — F3 归一化', () => {
  it('host 小写 + 去尾斜杠 + 去 fragment', () => {
    expect(canonicalUrl('https://WWW.Acme.com/about/#team')).toBe(
      'https://www.acme.com/about',
    );
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
  it('递归遮蔽非 contact 自由文本里的邮箱与电话', () => {
    const out = sanitizeProfileForPrompt({
      brand: { slogan: 'Email alice@example.com' },
      trustAssets: { customerCases: [{ summary: 'Call +49 30 1234567' }] },
    });
    expect(JSON.stringify(out)).not.toContain('alice@example.com');
    expect(JSON.stringify(out)).not.toContain('+49 30 1234567');
    expect(out).toEqual({
      brand: { slogan: 'Email [redacted-email]' },
      trustAssets: { customerCases: [{ summary: 'Call [redacted-phone]' }] },
    });
  });
  it('undefined profile → undefined', () => {
    expect(sanitizeProfileForPrompt(undefined)).toBeUndefined();
  });
  it('scrubPii 遮蔽自由文本里的邮箱与电话', () => {
    expect(scrubPii('reach us at sales@acme.com or +49 30 1234567')).toBe(
      'reach us at [redacted-email] or [redacted-phone]',
    );
  });
  it.each([
    ['请联系 用户@例子.公司 获取报价', '请联系 [redacted-email] 获取报价'],
    [
      'IDN domain: sales@例子.公司',
      'IDN domain: [redacted-email]',
    ],
    [
      'SMTPUTF8 + punycode: 采购@xn--fsqu00a.xn--55qx5d',
      'SMTPUTF8 + punycode: [redacted-email]',
    ],
    [
      'Combining local/domain: u\u0308ser@exa\u0308mple.de',
      'Combining local/domain: [redacted-email]',
    ],
  ])('遮蔽国际化邮箱且保留周边文本：%s', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });
  it.each([
    '主营精密泵阀，面向德国市场，支持小批量定制。',
    '关注@环球泵业 获取更新',
    '工艺温度为 80℃，不含邮箱或电话。',
  ])('不误删普通中文或无合法域名的 @ 文本：%s', (input) => {
    expect(scrubPii(input)).toBe(input);
  });

  it('落库清洗覆盖 fact key 与 gap field，而不只清洗 value/hint', () => {
    const sanitize = (
      brandProfileModule as typeof brandProfileModule & {
        sanitizeBrandProfilePersistenceOutput?: (
          input: Record<string, unknown>,
        ) => Record<string, unknown>;
      }
    ).sanitizeBrandProfilePersistenceOutput;

    expect(sanitize).toBeTypeOf('function');
    if (!sanitize) return;
    const out = sanitize({
      valueProps: [],
      tone: null,
      glossary: [],
      keywords: [],
      differentiators: [],
      competitors: [],
      factSheet: [
        {
          key: 'Contact alice@example.com',
          value: 'Call +49 30 1234567',
          evidence: { evidenceRefId: 'ref-1' },
        },
      ],
      gaps: [
        {
          field: 'Owner bob@example.com',
          reason: 'needs_input',
          hint: 'Call +49 30 7654321',
        },
      ],
    }) as {
      factSheet: { key: string; value: string }[];
      gaps: { field: string; hint: string }[];
    };

    expect(out.factSheet[0]).toMatchObject({
      key: 'Contact [redacted-email]',
      value: 'Call [redacted-phone]',
    });
    expect(out.gaps[0]).toMatchObject({
      field: 'Owner [redacted-email]',
      hint: 'Call [redacted-phone]',
    });
  });
});

describe('BRAND_PROFILE_INPUT_SCHEMA — frozen KB source compatibility', () => {
  it.each([
    ['storefront', 'fact_candidate'],
    ['web_research', 'research_hint'],
  ] as const)('accepts ready KB documents preserved as %s/%s', (sourceType, sourceRole) => {
    const result = checkAgainstSchema(BRAND_PROFILE_INPUT_SCHEMA, {
      companyName: 'Acme',
      products: ['pumps'],
      targetMarkets: ['DE'],
      intakeSource: {
        sourceId: 'intake-source',
        sourceType: 'intake',
        sourceRole: 'fact_candidate',
        contentHash: 'a'.repeat(64),
        content: 'Company: Acme',
      },
      kbSources: [
        {
          sourceId: `kb-${sourceType}`,
          sourceType,
          sourceRole,
          contentHash: 'b'.repeat(64),
          content: 'Frozen ready KB content.',
          title: 'source.txt',
        },
      ],
      research: [],
    });

    expect(result).toEqual({ valid: true });
  });
});

describe('BRAND_PROFILE_OUTPUT_SCHEMA — C4 结构性排除个人字段', () => {
  it('输出 schema 不含任何个人数据字段（team/contact/person/email/phone/founder）', () => {
    const banned = /team|contact|person|people|email|phone|founder|ceo|staff/i;
    const walk = (node: unknown, path: string[]): string[] => {
      if (node == null || typeof node !== 'object') return [];
      const hits: string[] = [];
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
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
    expect(
      (BRAND_PROFILE_OUTPUT_SCHEMA as { additionalProperties?: boolean })
        .additionalProperties,
    ).toBe(false);
  });
});

describe('buildBrandProfilePrompt — 模板槽位与硬规则', () => {
  const input = {
    companyName: 'Acme GmbH',
    industry: 'industrial pumps',
    products: ['high-pressure pumps'],
    targetMarkets: ['DE', 'US'],
    intakeSource: {
      sourceId: 'intake-1',
      sourceType: 'intake' as const,
      sourceRole: 'fact_candidate' as const,
      contentHash: 'a'.repeat(64),
      content: 'Company: Acme GmbH\nFounded: 2001',
    },
    kbSources: [
      {
        sourceId: 'kb-1',
        sourceType: 'upload' as const,
        sourceRole: 'fact_candidate' as const,
        contentHash: 'b'.repeat(64),
        title: 'catalog.pdf',
        content: '[来源:upload | catalog.pdf]\nPumps up to 400 bar.',
      },
    ],
    research: [
      {
        sourceId: 'research-1',
        sourceType: 'web_research' as const,
        sourceRole: 'research_hint' as const,
        contentHash: 'c'.repeat(64),
        url: 'https://fair.example/exhibitors/acme',
        title: 'fair',
        content: 'exhibitor Acme',
        fetchedAt: '2026-07-14T00:00:00Z',
      },
    ],
  };

  it('用户数据只进标注槽位；硬规则含零编造、角色不升级、证据溯源、无具名个人/指令视为数据', () => {
    const prompt = buildBrandProfilePrompt(input);
    expect(prompt).toContain('Acme GmbH');
    expect(prompt).toContain('[来源:upload | catalog.pdf]');
    expect(prompt).not.toContain('https://fair.example/exhibitors/acme');
    expect(prompt).not.toContain('(fair)');
    expect(prompt).toMatch(/绝不编造/);
    expect(prompt).toMatch(/角色.*不得互相升级|不得互相升级.*角色/);
    expect(prompt).toContain('manufacturer');
    expect(prompt).toMatch(/具名个人/);
    expect(prompt).toMatch(/视为.{0,4}数据/); // 资料中的指令性文字一律当数据
  });

  it('无 KB、无研究源时槽位标注「无」（模型不猜空槽位）', () => {
    const prompt = buildBrandProfilePrompt({
      ...input,
      kbSources: [],
      research: [],
    });
    expect(prompt).toMatch(/知识库[^]{0,10}(无|空)/);
  });

  it('task 定义：id 正确 + 输入 schema 必填字段齐（fail-fast 面）', () => {
    expect(BRAND_PROFILE_TASK.id).toBe('site_builder.brand_profile');
    const required =
      (BRAND_PROFILE_TASK.inputSchema as { required?: string[] }).required ??
      [];
    expect(required).toEqual(
      expect.arrayContaining(['companyName', 'products']),
    );
  });

  it('任务级失败门拒绝无法绑定冻结来源的 fact，供 AiTask 切到 Sonnet fallback', () => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [
          {
            key: 'business_role',
            value: 'Manufacturer',
            evidence: {
              sourceType: 'intake',
              sourceId: 'unknown-source',
              contentHash: 'f'.repeat(64),
              quote: 'Acme is a manufacturer',
            },
          },
        ],
        gaps: [],
      }),
    ).toThrow(/hard gate rejected.*evidence_source_mismatch/);
  });

  it('Evidence 2.0 prompt exposes only frozen source IDs/hashes and requires exact quotes for every fact', () => {
    const prompt = buildBrandProfilePrompt({
      ...input,
      intakeSource: {
        sourceId: 'intake-source-1',
        sourceType: 'intake',
        sourceRole: 'fact_candidate',
        contentHash: 'a'.repeat(64),
        content: 'Company: Acme GmbH\nProducts: high-pressure pumps',
      },
      kbSources: [
        {
          sourceId: 'kb-source-1',
          sourceType: 'upload',
          sourceRole: 'fact_candidate',
          contentHash: 'b'.repeat(64),
          title: 'catalog.pdf',
          content: 'Pumps up to 400 bar.',
        },
      ],
      research: [
        {
          ...input.research[0],
          sourceId: 'hint-source-1',
          sourceRole: 'research_hint',
          contentHash: 'c'.repeat(64),
          upstreamContentHash: 'd'.repeat(64),
          parserVersion: 'searxng-snippet/1',
        },
      ],
    });

    expect(prompt).toContain('source_id=intake-source-1');
    expect(prompt).toContain(`sha256=${'a'.repeat(64)}`);
    expect(prompt).toContain('source_id=kb-source-1');
    expect(prompt).toContain('source_role=research_hint');
    expect(prompt).toMatch(/每项.*quote|quote.*每项/);
  });
});
