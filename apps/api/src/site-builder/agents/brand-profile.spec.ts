import { describe, expect, it } from 'vitest';
import { checkAgainstSchema } from '../../model-gateway/schema-validate';
import * as brandProfileModule from './brand-profile';
import {
  BRAND_PROFILE_INPUT_SCHEMA,
  BRAND_PROFILE_OUTPUT_SCHEMA,
  BRAND_PROFILE_PROMPT_VERSION,
  BRAND_PROFILE_ROUTE_VALIDATION_VERSION,
  BRAND_PROFILE_TASK,
  buildBrandProfilePrompt,
  canonicalUrl,
  enforceEvidenceGate,
  enforceEvidenceGateV2,
  EvidenceCorpus,
  RawFactItem,
  sanitizeBrandProfilePersistenceOutput,
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

const CLOSED_ENGLISH_PERSONAL_ROLES = [
  'CEO',
  'CFO',
  'COO',
  'CTO',
  'CMO',
  'CPO',
  'CIO',
  'CSO',
  'VP',
  'SVP',
  'EVP',
  'Sales VP',
  'Engineering VP',
  'VP of Sales',
  'VP of Engineering',
  'SVP of Sales',
  'EVP of Engineering',
  'Head of Sales',
  'Head of Engineering',
  'Department Head',
  'Partner',
  'Secretary',
  'Treasurer',
  'Controller',
  'Employee',
  'Staff',
  'Team Member',
  'Personnel',
  'Representative',
  'Sales Representative',
  'Account Executive',
  'Spokesperson',
  'Human Resources',
  'HR',
] as const;

const CLOSED_ENGLISH_ROLE_ATTRIBUTIONS =
  CLOSED_ENGLISH_PERSONAL_ROLES.flatMap((role) => {
    const lowerRole = role.toLocaleLowerCase('en-US');
    return [
      `${role}: Jane Smith`,
      `Jane Smith ${role}`,
      `Jane Smith is ${role}`,
      `${lowerRole}: jane smith`,
      `jane smith ${lowerRole}`,
      `jane smith is ${lowerRole}`,
    ];
  });

const CLOSED_PERSONAL_ATTRIBUTION_TEXTS = [
  'CEO',
  'founder',
  'sales manager',
  'contact person',
  'Jane Smith',
  'By Jane Smith',
  'Written by Jane Smith',
  'Authored by Jane Smith',
  'Presented by Jane Smith',
  'Published by Jane Smith',
  'Author: Jane Smith',
  'Editor: Jane Smith',
  'Byline: Jane Smith',
  'Jane Smith, CEO',
  'Jane — Founder',
  'Jane Smith (Managing Director)',
  'Jane Smith is CEO',
  'Jane Smith serves as CEO',
  'Jane Smith acts as CEO',
  'Jane Smith is Managing Director',
  'Jane Smith, Sales Manager',
  'Jane — Technical Manager',
  'Jane Smith (Project Lead)',
  'Sales Manager: Jane Smith',
  'Jane Smith wrote this article',
  'Jane Smith authored this report',
  'Jane Smith presented this article',
  'Jane Smith founded the company',
  'Jane Smith leads engineering',
  'Jane Smith leads time studies.',
  'Contact: Jane',
  'Inventor Jane',
  'Engineer: Jane',
  '张三担任首席执行官',
  '张三，首席执行官',
  'jane smith is CEO',
  'JANE SMITH is CEO',
  'jane smith wrote this article',
  'JANE SMITH wrote this article',
  'By jane smith',
  'BY JANE SMITH',
  'CEO: jane smith',
  'Sales Manager: jane smith',
  'Designed by Jane Smith',
  'Designed by john smith',
  'Designed by ACME Engineering Team',
  'Designed by Bosch',
  'Designed by Unknown Organization',
  'Designed by a jane smith team',
  'Written by the jane smith team',
  'Managed by our john smith department',
  'Designed by the acme engineering team',
  'Certified by an unknown organization body',
  'Developed by our bosch research team',
  'Written by Jane Smith is',
  'Designed by john smith was',
  'Author: Jane Smith is',
  'CEO: jane smith was',
  'Tested by TÜV Rheinland Jane Smith',
  'Certified by SGS jane smith',
  'Designed by Intertek Unknown Organization',
  'By 张三 wrote this article',
  '作者：张三撰写了这篇技术文章',
  '撰稿人：张三撰写了这篇技术文章',
  '张三撰写了这篇技术文章',
  '由张三设计的工业泵系统',
  '李四是公司的首席执行官',
  '王五现任公司的法定代表人',
  'john smith sales manager',
  'JANE SMITH SALES MANAGER',
  'Jane Smith Chief Technology Officer',
  'Product Manager: Jane Smith',
  'Director: Jane Smith',
  'Owner: Jane Smith',
  'Chief Technology Officer: Jane Smith',
  'Jane Smith R&D Director',
  'jane smith chief technology officer',
  'product manager: jane smith',
  'jane smith r&d director',
  'Jane Smith | CEO',
  'Jane Smith / CEO',
  '董事长：张三',
  '总经理：张三',
  '经理：张三',
  '技术总监：张三',
  '工程师：张三',
  '员工：张三',
  '团队成员：张三',
  '人员：张三',
  '代表：张三',
  '董事：张三',
  '销售代表：张三',
  '张三，董事长',
  '张三担任工程师',
  '张三是董事',
  '张三负责销售',
  '张三负责技术',
  'Written by Quality Engineering. Written by Jane Smith.',
  'Written by Jane Smith. Written by Quality Engineering.',
  'CEO: Chief Executive Officer. CEO: Jane Smith.',
  'CEO: Jane Smith. CEO: Chief Executive Officer.',
  'Quality Engineering Sales Manager. Jane Smith Sales Manager.',
  'Jane Smith Sales Manager. Quality Engineering Sales Manager.',
  'Quality Engineering manages production. Jane Smith leads sales.',
  'Jane Smith leads sales. Quality Engineering manages production.',
  '研发部门开发的系统；张三开发了这项产品',
  '张三开发了这项产品；研发部门开发的系统',
  'CEO: Chief Executive Officer',
  'Author: Quality Engineering',
  'Engineer: Quality Engineering',
  'Quality Engineering is Managing Director',
  'Sales Manager: Sales Department',
  'Quality Engineering Sales Manager',
  'Quality Engineering Product Manager',
  'Research Department Director',
  'Engineering Department R&D Director',
  '研发部门是技术总监',
  '工程师：研发部门',
  ...CLOSED_ENGLISH_ROLE_ATTRIBUTIONS,
] as const;

const SAFE_DETERMINED_NOUN_PHRASES = [
  ['a', 'cross-functional engineering', 'team'],
  ['an', 'external testing', 'laboratory'],
  ['the', 'national standards', 'authority'],
  ['our', 'in-house development', 'team'],
  ['an', 'internal R&D', 'department'],
  ['a', 'proprietary', 'algorithm'],
  ['the', 'technical documentation', 'team'],
].map(([determiner, modifiers, head]) =>
  [determiner, modifiers, head].join(' '),
);

const SAFE_NON_PERSONAL_ATTRIBUTIONS = [
  'Led by Quality Engineering',
  'Written by Quality Engineering',
  'Quality Engineering leads production',
  'Powered by compressed air',
  'Driven by electric motor',
  'Controlled by PLC',
  'Tested by TÜV Rheinland',
  'Designed by finite element analysis',
  'Managed by programmable logic controller',
  'Automation software manages production',
  'Control system manages pressure',
  'The machine leads its class',
  'Designed by an experienced engineering team',
  'Designed by our engineering team',
  'Managed by the control system',
  'Driven by the electric motor',
  'Tested by an independent laboratory',
  'Certified by an accredited body',
  'Developed by the research department',
  'Created by automated software',
  'Led by market demand',
  'Written by the quality team',
  ...SAFE_DETERMINED_NOUN_PHRASES.map((subject) => `Designed by ${subject}`),
  'Verified by an external testing laboratory',
  'Certified by the national standards authority',
  'Built by our in-house development team',
  'Managed by advanced automation software',
  'Developed by an internal R&D department',
  'Created by a proprietary algorithm',
  'Written by the technical documentation team',
  '由自动化软件设计的工业泵系统',
  '由研发部门开发的控制系统',
  '质量团队负责生产管理',
  '研发部门负责技术',
  '质量团队负责质量监督',
] as const;

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
          value: 'Pumps up to 400 bar',
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
      name: 'an unnumbered ISO assertion cannot cite a quote that omits ISO',
      key: 'certifications',
      value: 'ISO certified quality system',
      quote: 'Certified quality system.',
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
    {
      name: 'a standalone model number is not covered by a larger pressure number',
      key: 'specifications',
      value: 'Model 300; maximum pressure 1300 bar',
      quote: 'Maximum pressure 1300 bar.',
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

  it('rejects person-bearing fact keys even when the name is present in an exact upload quote', () => {
    const out = evaluate({
      key: 'founder',
      value: 'Jane Smith',
      quote: 'Founder: Jane Smith.',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        field: 'personal_data',
        reason: 'personal_data_not_publishable',
      }),
    ]);
  });

  it.each([
    {
      key: 'employee_count',
      value: 'Jane Smith',
      quote: 'Jane Smith',
      reason: 'personal_data_not_publishable',
    },
    {
      key: 'team_size',
      value: 'CEO: Jane Smith',
      quote: 'CEO: Jane Smith',
      reason: 'personal_data_not_publishable',
    },
    {
      key: 'staff_count',
      value: 'many employees',
      quote: 'many employees',
      reason: 'unsupported_public_fact_key',
    },
    {
      key: 'employee_count',
      value: 'Jane Smith 240',
      quote: 'Jane Smith 240',
      reason: 'unsupported_public_fact_key',
    },
    {
      key: 'staff_count',
      value: 'Jane Smith, 240',
      quote: 'Jane Smith, 240',
      reason: 'unsupported_public_fact_key',
    },
    {
      key: 'team_size',
      value: '张三 240',
      quote: '张三 240',
      reason: 'unsupported_public_fact_key',
    },
  ])(
    'does not let personnel aggregate key $key bypass identity and numeric-count gates',
    ({ key, value, quote, reason }) => {
      const out = evaluate({ key, value, quote });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason }),
      ]);
      expect(JSON.stringify(out.gaps)).not.toContain('Jane Smith');
    },
  );

  it.each([
    {
      key: 'employee_count',
      value: 'Employees: 240',
      quote: 'Employees: 240',
    },
    {
      key: 'staff_count',
      value: 'Staff count: 240',
      quote: 'Staff count: 240',
    },
    {
      key: 'team_size',
      value: '团队规模：约240人',
      quote: '团队规模：约240人',
    },
    {
      key: 'employee_count',
      value: '240',
      quote: 'Employee count: 240',
    },
    {
      key: 'staff_count',
      value: '240 employees',
      quote: '240 employees',
    },
    {
      key: 'representative_products',
      value: 'Industrial pumps',
      quote: 'Representative products: Industrial pumps',
    },
    {
      key: 'target markets',
      value: 'Germany and France',
      quote: 'Target markets: Germany and France',
    },
    {
      key: 'technical parameter',
      value: 'Maximum pressure: 400 bar',
      quote: 'Technical parameter — Maximum pressure: 400 bar',
    },
    ...[
      ['services', 'pump maintenance services'],
      ['capabilities', 'custom machining'],
      ['industries', 'automotive applications'],
      ['facilities', 'automated assembly facility'],
      ['applications', 'water treatment'],
      ['materials', 'stainless steel'],
      ['technologies', 'magnetic drive technology'],
      ['processes', 'five-axis machining'],
      ['operations', 'automated assembly'],
      ['factories', 'regional factories'],
      ['locations', 'Germany and France'],
      ['distributors', 'regional distributors'],
      ['suppliers', 'industrial suppliers'],
      ['manufacturers', 'component manufacturers'],
      ['warranties', 'standard warranties'],
    ].map(([key, value]) => ({ key, value, quote: value })),
  ])('retains non-personal company fact $key', ({ key, value, quote }) => {
    const out = evaluate({ key, value, quote });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it('keeps the public fact-key grammar bounded', () => {
    const out = evaluate({
      key: 'arbitrary_unreviewed_metadata',
      value: 'internal note',
      quote: 'internal note',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'unsupported_public_fact_key' }),
    ]);
  });

  it.each([
    {
      key: 'distributor_support',
      value: 'Distributor contact sales@example.com',
      quote: 'Distributor support is available.',
    },
    {
      key: 'company_history',
      value: 'Founded by Jane Smith',
      quote: 'Founded by Jane Smith.',
    },
    {
      key: 'president',
      value: 'Jane Smith',
      quote: 'President: Jane Smith.',
    },
    {
      key: 'owner',
      value: 'Jane Smith',
      quote: 'Owner: Jane Smith.',
    },
    {
      key: 'manager',
      value: 'Jane Smith',
      quote: 'Manager: Jane Smith.',
    },
    {
      key: 'director',
      value: 'Jane Smith',
      quote: 'Director: Jane Smith.',
    },
    {
      key: 'employee_name',
      value: 'Jane Smith',
      quote: 'Employee name: Jane Smith.',
    },
    {
      key: 'employee',
      value: 'Jane Smith',
      quote: 'Employee: Jane Smith.',
    },
    {
      key: 'engineer',
      value: 'Jane Smith',
      quote: 'Engineer: Jane Smith.',
    },
    {
      key: 'sales_lead',
      value: 'Jane Smith',
      quote: 'Sales lead: Jane Smith.',
    },
    {
      key: 'sales_manager',
      value: 'Jane Smith',
      quote: 'Sales manager: Jane Smith.',
    },
    {
      key: 'chief_engineer',
      value: 'Jane Smith',
      quote: 'Chief engineer: Jane Smith.',
    },
    {
      key: 'project_lead',
      value: 'Jane Smith',
      quote: 'Project lead: Jane Smith.',
    },
    {
      key: 'inventor',
      value: 'Jane Smith',
      quote: 'Inventor: Jane Smith.',
    },
    {
      key: 'scientific_advisor',
      value: 'Jane Smith',
      quote: 'Scientific advisor: Jane Smith.',
    },
  ])('rejects personal data carried by $key/value', ({ key, value, quote }) => {
    const out = evaluate({ key, value, quote });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'personal_data_not_publishable' }),
    ]);
    expect(JSON.stringify(out.gaps)).not.toContain('Jane Smith');
    expect(JSON.stringify(out.gaps)).not.toContain('sales@example.com');
  });

  it.each(CLOSED_PERSONAL_ATTRIBUTION_TEXTS)(
    'rejects closed-form personal attribution without persisting its subject: %s',
    (value) => {
      const out = evaluate({ key: 'capability', value, quote: value });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'personal_data_not_publishable' }),
      ]);
      for (const personalToken of [
        'Jane',
        'jane',
        'john',
        '张三',
        '李四',
        '王五',
      ]) {
        expect(out.gaps[0]?.hint).not.toContain(personalToken);
      }
    },
  );

  it.each(SAFE_NON_PERSONAL_ATTRIBUTIONS)(
    'does not treat a closed safe department as personal attribution: %s',
    (value) => {
      const out = evaluate({ key: 'capability', value, quote: value });

      expect(out.gaps).toEqual([]);
      expect(out.factSheet).toHaveLength(1);
    },
  );

  it('fails closed for an unclassified free-form fact key', () => {
    const out = evaluate({
      key: 'unclassified_field',
      value: 'Industrial pumps',
      quote: 'Industrial pumps',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps[0]).toMatchObject({
      reason: expect.stringMatching(
        /personal_data_not_publishable|unsupported_public_fact_key/,
      ),
    });
  });

  it.each(['Maximum Pressure', 'maximum-pressure', 'maximum pressure'])(
    'rejects non-canonical fact key %s before creating Claim/Evidence',
    (key) => {
      const out = evaluate({
        key,
        value: 'Maximum working pressure: 300 bar',
        quote: 'Maximum working pressure: 300 bar',
      });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'unsupported_public_fact_key' }),
      ]);
    },
  );

  it.each([
    {
      key: 'customer',
      value: 'Jane Smith',
      quote: 'Customer: Jane Smith',
    },
    {
      key: 'company_name',
      value: 'Jane Smith',
      quote: 'Company name: Jane Smith',
    },
    {
      key: 'project',
      value: 'Project led by Jane Smith',
      quote: 'Project led by Jane Smith',
    },
  ])(
    'does not project ambiguous person-bearing identity through $key',
    ({ key, value, quote }) => {
      const out = evaluate({ key, value, quote });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps[0]).toMatchObject({
        reason: expect.stringMatching(
          /personal_data_not_publishable|unsupported_public_fact_key/,
        ),
      });
    },
  );

  it.each([
    {
      key: 'product_name',
      value: 'Stainless Steel Pump',
      quote: 'Stainless Steel Pump',
    },
    {
      key: 'representative_products',
      value: 'Variable Frequency Drive',
      quote: 'Variable Frequency Drive',
    },
    {
      key: 'product_name',
      value: 'Precision Press Brake',
      quote: 'Precision Press Brake',
    },
    {
      key: 'product_name',
      value: 'Laser Cutter',
      quote: 'Laser Cutter',
    },
    {
      key: 'product_name',
      value: 'Heat Exchanger',
      quote: 'Heat Exchanger',
    },
    {
      key: 'product_name',
      value: 'Hydraulic Press',
      quote: 'Hydraulic Press',
    },
    {
      key: 'capability',
      value: 'manufactures Industrial Pumps',
      quote: 'manufactures Industrial Pumps',
    },
  ])(
    'does not misclassify public B2B terminology in $key as a person',
    ({ key, value, quote }) => {
      const out = evaluate({ key, value, quote });

      expect(out.gaps).toEqual([]);
      expect(out.factSheet).toEqual([expect.objectContaining({ key, value })]);
    },
  );

  it.each([
    ['product', 'Industrial Pumps'],
    ['products', 'Hydraulic Press'],
    ['main_product', 'Atlas Pro'],
    ['main_products', 'Industrial Pumps'],
    ['model', 'Atlas Pro'],
    ['product_model', 'Atlas Pro'],
    ['sku', 'Hydraulic Press'],
    ['part_number', 'Atlas Pro'],
  ])('typed product/model key %s does not apply a generic TitleCase person heuristic', (key, value) => {
    const out = evaluate({ key, value, quote: value });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toEqual([expect.objectContaining({ key, value })]);
  });

  it.each([
    ['company_name', 'General Electric'],
    ['brand_name', 'Atlas Copco'],
  ])('company/brand identity remains non-projectable without identity disambiguation: %s', (key, value) => {
    const out = evaluate({ key, value, quote: value });

    expect(out.factSheet).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'unsupported_public_fact_key' }),
    ]);
  });

  it('rejects unresolved customer/project semantics carried in an otherwise public key', () => {
    const out = evaluate({
      key: 'capability',
      value: 'served customer acme on project delta',
      quote: 'served customer acme on project delta',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'unsupported_public_fact_key' }),
    ]);
  });

  it.each(['Engineering led by Jane Smith', 'Designed by Jane Smith'])(
    'rejects person bylines carried in a public capability: %s',
    (value) => {
      const out = evaluate({ key: 'capability', value, quote: value });

      expect(out.factSheet).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'personal_data_not_publishable' }),
      ]);
    },
  );

  it.each([
    'Supplies Acme Corporation with pumps',
    'Partnered with Acme GmbH',
    'Supplies Acme with pumps',
    'Supplies pumps to Acme',
    'Serves Acme globally',
    'Works with Acme',
    'Partnered with Acme',
    'Delivers to Acme',
    'Customers include Acme',
    'Acme is our customer',
    'Delivers to acme',
    'Works with bosch',
    'Customers include acme',
    'acme is our customer',
  ])(
    'rejects unresolved third-party organization relations: %s',
    (value) => {
      const out = evaluate({ key: 'capability', value, quote: value });

      expect(out.factSheet).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'unsupported_public_fact_key' }),
      ]);
      expect(out.gaps[0]?.field).toBe('unresolved_third_party');
      expect(out.gaps[0]?.hint).not.toContain('Acme');
    },
  );

  it.each([
    'Supplies industrial manufacturers',
    'Works with quality engineering teams',
    'Serves global markets',
    'Partners with distributors',
    'Delivers to European manufacturers',
    'Delivers to North American manufacturers',
    'Serves European markets',
    'Works with Fortune 500 companies',
    'Supplies Asian distributors',
    'Serves German customers',
  ])('does not treat a generic business relation as a named third party: %s', (value) => {
    const out = evaluate({ key: 'capability', value, quote: value });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it.each([
    {
      key: 'company_overview',
      value: 'Jane Smith',
      quote: 'Jane Smith',
    },
    {
      key: 'business_history',
      value: 'Jane Smith established the firm',
      quote: 'Jane Smith established the firm',
    },
  ])(
    'fails closed when a supported-looking field contains a personal name: $key',
    ({ key, value, quote }) => {
      const out = evaluate({ key, value, quote });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps[0]).toMatchObject({
        reason: expect.stringMatching(
          /personal_data_not_publishable|unsupported_public_fact_key/,
        ),
      });
    },
  );

  it('rejects a CJK person relabelled as a product when the exact quote carries a personal role', () => {
    const out = evaluate({
      key: 'product_name',
      value: '张伟',
      quote: '品牌创始人：张伟。',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'personal_data_not_publishable' }),
    ]);
  });

  it.each([
    {
      key: 'capability',
      value: 'Operates five factories across Germany',
      quote: 'Provides after-sales maintenance for installed pumps.',
    },
    {
      key: 'industry',
      value: 'Industrial automation',
      quote: 'Supplies replacement seals for standard pump models.',
    },
    {
      key: 'export_markets',
      value: 'Exports to North America',
      quote: 'The company serves customers in Southeast Asia.',
    },
    {
      key: 'market',
      value: 'US',
      quote: 'Industrial pumps for Europe',
    },
    {
      key: 'capability',
      value: 'Operates 5 factories in Germany',
      quote: 'Provides a 5-year warranty for pumps.',
    },
    {
      key: 'export_markets',
      value: 'Exports to Germany since 1998',
      quote: 'Founded in Germany in 1998.',
    },
  ])(
    'rejects semantically unrelated exact evidence for $key',
    ({ key, value, quote }) => {
      const out = evaluate({ key, value, quote });

      expect(out.factSheet).toEqual([]);
      expect(out.refs).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'evidence_value_mismatch' }),
      ]);
    },
  );

  it('rejects PII in a quote even if a malformed upstream bypassed source freezing', () => {
    const source = {
      sourceKey: 'poisoned-source',
      sourceType: 'upload' as const,
      sourceRole: 'fact_candidate' as const,
      hashAlgorithm: 'sha256' as const,
      contentHash: 'a'.repeat(64),
      normalizationVersion: 'evidence-text/1' as const,
      snapshotText: 'Contact sales@example.com for distributor support.',
      provenance: { documentId: 'poisoned-document' },
    };
    const out = enforceEvidenceGateV2(
      [
        fact({
          key: 'distributor_support',
          value: 'Distributor support available',
          evidence: {
            sourceType: 'upload',
            sourceId: 'poisoned-source',
            contentHash: source.contentHash,
            quote: source.snapshotText,
          },
        }),
      ],
      {
        sources: new Map([['poisoned-source', source]]),
        createEvidenceRefId: () => 'poisoned-ref',
      },
    );

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'personal_data_not_publishable' }),
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

  it('requires the complete compound unit instead of accepting a shorter unit prefix', () => {
    const out = evaluate({
      key: 'flow_capacity',
      value: '10 L/min',
      quote: 'Datasheet rated flow 10 L under nominal conditions.',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.refs).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({
        field: 'flow_capacity',
        reason: 'evidence_value_mismatch',
      }),
    ]);
  });

  it.each([
    ['10 L/min', 'Datasheet rated flow 10 L/day.'],
    ['10 L/min', 'Datasheet rated flow 110 L/min.'],
    ['10 L/min', 'Datasheet rated flow 10 L/minute.'],
    ['5 m/s', 'Datasheet rated speed 5 m.'],
    ['500 kg/h', 'Datasheet rated throughput 500 kg.'],
    ['Flow 10 L/min at 60 cycles/min', 'Rated flow 10 L/min at 60 cycles'],
    ['10 L / cycle', 'Rated output 10 L'],
    ['5 m / cycle', 'Rated travel 5 m'],
    ['500 kg / batch', 'Rated load 500 kg'],
    ['10 L per minute', 'Rated output 10 L'],
    ['500 kg per hour', 'Rated load 500 kg'],
    ['5 metres per second', 'Rated travel 5 metres'],
    ['500 units per hour', 'Rated capacity 500 units per day'],
    ['500 units per labour hour', 'Rated capacity 500 units per labour day'],
    ['500 units per working hour', 'Rated capacity 500 units per working day'],
    ['500 units/operator/hour', 'Rated capacity 500 units/operator/day'],
    [
      '10 litres per cubic metre',
      'Rated concentration 10 litres per cubic foot',
    ],
    ['10 kg per square metre', 'Rated loading 10 kg per square foot'],
  ])('rejects a changed or truncated compound unit: %s', (value, quote) => {
    const out = evaluate({ key: 'flow_capacity', value, quote });

    expect(out.factSheet).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'evidence_value_mismatch' }),
    ]);
  });

  it('accepts a compound unit only when the exact quote carries the whole unit', () => {
    const out = evaluate({
      key: 'flow_capacity',
      value: '10 L/min',
      quote: 'Datasheet rated flow 10 L/min under nominal conditions.',
    });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it.each([
    [
      '10 to 20 bar',
      'The datasheet lists 10 test cycles and a maximum pressure of 20 bar.',
    ],
    [
      'between 10 and 20 bar',
      'The datasheet lists 10 test cycles and a maximum pressure of 20 bar.',
    ],
    [
      'from 10 to 20 bar',
      'The datasheet lists 10 test cycles and a maximum pressure of 20 bar.',
    ],
    [
      '10 up to 20 bar',
      'The datasheet lists 10 test cycles and a maximum pressure of 20 bar.',
    ],
    [
      '10–20 bar',
      'The datasheet lists 10 test cycles and a maximum pressure of 20 bar.',
    ],
    ['10 to 20 bar', 'The supported range is 20 to 10 bar.'],
  ])(
    'binds the complete numeric range instead of independent numbers: %s',
    (value, quote) => {
      const out = evaluate({ key: 'pressure_range', value, quote });

      expect(out.factSheet).toEqual([]);
      expect(out.gaps).toEqual([
        expect.objectContaining({ reason: 'evidence_value_mismatch' }),
      ]);
    },
  );

  it.each([
    ['10 to 20 bar', 'The supported range is 10 to 20 bar.'],
    ['between 10 and 20 bar', 'Pressure stays between 10 and 20 bar.'],
    ['from 10 to 20 bar', 'Pressure ranges from 10 to 20 bar.'],
    ['10 up to 20 bar', 'The supported span is 10 up to 20 bar.'],
    ['10–20 bar', 'The supported range is 10-20 bar.'],
  ])('accepts a complete supported numeric range: %s', (value, quote) => {
    const out = evaluate({ key: 'pressure_range', value, quote });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it.each([
    ['At least 10 bar', 'Pressure is at most 10 bar.'],
    ['At most 10 bar', 'Pressure is at least 10 bar.'],
    ['More than 10 bar', 'Pressure is less than 10 bar.'],
    ['Less than 10 bar', 'Pressure is more than 10 bar.'],
    ['Above 10 bar', 'Pressure is below 10 bar.'],
    ['Below 10 bar', 'Pressure is above 10 bar.'],
    ['Over 10 bar', 'Pressure is under 10 bar.'],
    ['Under 10 bar', 'Pressure is over 10 bar.'],
    ['Up to 10 bar', 'Pressure is at least 10 bar.'],
    ['≥ 10 bar', 'Pressure is ≤ 10 bar.'],
    ['> 10 bar', 'Pressure is < 10 bar.'],
    ['Minimum 10 bar', 'Maximum pressure is 10 bar.'],
    ['Maximum 10 bar', 'Minimum pressure is 10 bar.'],
    ['Min. 10 bar', 'Max. pressure is 10 bar.'],
    ['Max. 10 bar', 'Min. pressure is 10 bar.'],
    ['Greater than 10 bar', 'Pressure is lower than 10 bar.'],
    ['Lower than 10 bar', 'Pressure is greater than 10 bar.'],
    ['10 bar or more', 'Pressure is 10 bar or less.'],
    ['10 bar or less', 'Pressure is 10 bar or more.'],
    ['10 bar minimum', 'Pressure is 10 bar maximum.'],
    ['10 bar maximum', 'Pressure is 10 bar minimum.'],
  ])('binds comparison direction to the measurement: %s', (value, quote) => {
    const out = evaluate({ key: 'maximum_pressure', value, quote });

    expect(out.factSheet).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'evidence_value_mismatch' }),
    ]);
  });

  it.each([
    ['At least 10 bar', 'Pressure is at least 10 bar.'],
    ['More than 10 bar', 'Pressure is more than 10 bar.'],
    ['Below 10 bar', 'Pressure remains below 10 bar.'],
    ['Up to 10 bar', 'Pressure is rated up to 10 bar.'],
    ['≥ 10 bar', 'Pressure is ≥ 10 bar.'],
    ['Minimum 10 bar', 'Pressure is minimum 10 bar.'],
    ['Max. 10 bar', 'Pressure is Max. 10 bar.'],
    ['Greater than 10 bar', 'Pressure is greater than 10 bar.'],
    ['10 bar or more', 'Pressure is 10 bar or more.'],
    ['10 bar minimum', 'Pressure is 10 bar minimum.'],
  ])('accepts a supported directional measurement: %s', (value, quote) => {
    const out = evaluate({ key: 'maximum_pressure', value, quote });

    expect(out.gaps).toEqual([]);
    expect(out.factSheet).toHaveLength(1);
  });

  it('fails closed for an unrecognised multi-measurement structured claim', () => {
    const out = evaluate({
      key: 'pressure_specification',
      value: '10 bar at 20 °C',
      quote: '10 bar at 20 °C',
    });

    expect(out.factSheet).toEqual([]);
    expect(out.gaps).toEqual([
      expect.objectContaining({ reason: 'evidence_value_mismatch' }),
    ]);
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
  const persistenceContext = {
    companyName: 'Acme GmbH',
    products: ['high-pressure pumps'],
  };

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
    ['IDN domain: sales@例子.公司', 'IDN domain: [redacted-email]'],
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
          context: { companyName: string; products: string[] },
        ) => Record<string, unknown>;
      }
    ).sanitizeBrandProfilePersistenceOutput;

    expect(sanitize).toBeTypeOf('function');
    if (!sanitize) return;
    const out = sanitize(
      {
        valueProps: [],
        tone: null,
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [
          {
            key: 'Support alice@example.com',
            value: 'Call +49 30 1234567',
            evidence: { evidenceRefId: 'ref-1' },
          },
        ],
        gaps: [
          {
            field: 'Question bob@example.com',
            reason: 'needs_input',
            hint: 'Call +49 30 7654321',
          },
        ],
      },
      persistenceContext,
    ) as {
      factSheet: { key: string; value: string }[];
      gaps: { field: string; hint: string }[];
    };

    expect(out.factSheet[0]).toMatchObject({
      key: 'Support [redacted-email]',
      value: 'Call [redacted-phone]',
    });
    expect(out.gaps[0]).toMatchObject({
      field: 'Question [redacted-email]',
      hint: 'Call [redacted-phone]',
    });
  });

  it.each([
    {
      name: 'value proposition',
      over: { valueProps: ['Founded by Jane Smith'] },
    },
    {
      name: 'tone voice',
      over: { tone: { voice: 'Led by Jane Smith', style: [] } },
    },
    {
      name: 'differentiator',
      over: { differentiators: ['Designed by Jane Smith'] },
    },
    {
      name: 'glossary definition',
      over: {
        glossary: [{ term: 'Leadership', definition: 'CEO: Jane Smith' }],
      },
    },
    {
      name: 'gap hint',
      over: {
        gaps: [
          {
            field: 'leadership',
            reason: 'needs_input' as const,
            hint: 'Contact person: Jane Smith',
          },
        ],
      },
    },
  ])('落库前拒绝 $name 中的明确个人署名', ({ over }) => {
    expect(() =>
      sanitizeBrandProfilePersistenceOutput(
        {
          valueProps: [],
          tone: null,
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [],
          gaps: [],
          ...over,
        },
        persistenceContext,
      ),
    ).toThrow(/explicit personal attribution|forbidden personnel role/i);
  });

  it.each(CLOSED_PERSONAL_ATTRIBUTION_TEXTS)('落库前拒绝闭集角色/署名关系: %s', (value) => {
    expect(() =>
      sanitizeBrandProfilePersistenceOutput(
        {
          valueProps: [value],
          tone: null,
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [],
          gaps: [],
        },
        persistenceContext,
      ),
    ).toThrow(/explicit personal attribution|forbidden personnel role/i);
  });

  it.each([
    {
      value: 'Written by Jane Smith',
      quote: 'Industrial pumps',
    },
    {
      value: 'Industrial pumps',
      quote: 'Written by Jane Smith',
    },
  ])('落库前分别拒绝 fact value/quote 中的人员署名: %j', ({ value, quote }) => {
    const sanitize = sanitizeBrandProfilePersistenceOutput as unknown as (
      input: Record<string, unknown>,
      context: { companyName: string; products: string[] },
    ) => Record<string, unknown>;
    expect(() =>
      sanitize(
        {
          valueProps: [],
          tone: null,
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [
            {
              key: 'capability',
              value,
              evidence: { quote },
            },
          ],
          gaps: [],
        },
        persistenceContext,
      ),
    ).toThrow(/explicit personal attribution/i);
  });

  it.each(['Jane Smith', 'General Electric', 'Atlas Copco'])(
    '落库前拒绝未做组织身份消歧的 competitor: %s',
    (name) => {
      expect(() =>
        sanitizeBrandProfilePersistenceOutput(
          {
            valueProps: [],
            tone: null,
            glossary: [],
            keywords: [],
            differentiators: [],
            competitors: [{ name, positioning: 'Premium segment' }],
            factSheet: [],
            gaps: [],
          },
          persistenceContext,
        ),
      ).toThrow(/unresolved competitor identity/i);
    },
  );

  it.each([
    ['ceo', 'Who is the CEO?'],
    ['sales_manager', 'Who manages sales?'],
    ['quality_manager', '谁负责质量管理？'],
  ])(
    '落库门允许不含实际个人标识的站主补证问题: %s',
    (field, hint) => {
      expect(() =>
        sanitizeBrandProfilePersistenceOutput(
          {
            valueProps: [],
            tone: null,
            glossary: [],
            keywords: [],
            differentiators: [],
            competitors: [],
            factSheet: [],
            gaps: [{ field, reason: 'needs_input', hint }],
          },
          persistenceContext,
        ),
      ).not.toThrow();
    },
  );

  it.each([
    ['missing_fact', 'Does CEO Jane lead sales?'],
    ['missing_fact', 'CEO Jane负责质量管理吗？'],
    ['missing_fact', 'Can you confirm @janesmith?'],
    ['missing_fact', 'Is this linkedin.com/in/jane-smith?'],
    ['missing_fact', 'What is the WeChat ID wxid_janesmith?'],
    ['contact_email', 'Please provide supporting details?'],
  ])(
    '落库门仍拒绝实际个人标识或联系方式字段: %s / %s',
    (field, hint) => {
      expect(() =>
        sanitizeBrandProfilePersistenceOutput(
          {
            valueProps: [],
            tone: null,
            glossary: [],
            keywords: [],
            differentiators: [],
            competitors: [],
            factSheet: [],
            gaps: [{ field, reason: 'needs_input', hint }],
          },
          persistenceContext,
        ),
      ).toThrow(/explicit personal attribution|forbidden personnel role/i);
    },
  );
});

describe('BRAND_PROFILE_INPUT_SCHEMA — frozen KB source compatibility', () => {
  it.each([
    ['storefront', 'fact_candidate'],
    ['web_research', 'research_hint'],
  ] as const)(
    'accepts ready KB documents preserved as %s/%s',
    (sourceType, sourceRole) => {
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
    },
  );
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

  it('competitors 在组织身份消歧合同落地前只允许空数组', () => {
    const competitors = (
      BRAND_PROFILE_OUTPUT_SCHEMA as {
        properties?: { competitors?: { maxItems?: number } };
      }
    ).properties?.competitors;
    expect(competitors?.maxItems).toBe(0);
  });

  it('factSheet.key schema only accepts strict lower_snake_case', () => {
    const keySchema = (
      BRAND_PROFILE_OUTPUT_SCHEMA as {
        properties?: {
          factSheet?: {
            items?: { properties?: { key?: { pattern?: string } } };
          };
        };
      }
    ).properties?.factSheet?.items?.properties?.key;

    expect(keySchema?.pattern).toBe(
      '^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$',
    );
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

  it('用户数据只进标注槽位；硬规则含零编造、角色不升级、证据溯源和指令视为数据，且不写 blanket PII 禁令', () => {
    const prompt = buildBrandProfilePrompt(input);
    expect(prompt).toContain('Acme GmbH');
    expect(prompt).toContain('[来源:upload | catalog.pdf]');
    expect(prompt).not.toContain('https://fair.example/exhibitors/acme');
    expect(prompt).not.toContain('(fair)');
    expect(prompt).toMatch(/绝不编造/);
    expect(prompt).toMatch(/角色.*不得互相升级|不得互相升级.*角色/);
    expect(prompt).toContain('manufacturer');
    expect(prompt).toMatch(/supplies.*supplier/);
    expect(prompt).toMatch(/动作动词.*角色|角色.*动作动词/);
    expect(prompt).not.toMatch(
      /不输出任何具名个人|个人、人员角色、姓名、职务、邮箱与电话在任何输出/u,
    );
    expect(prompt).toMatch(/批准企业事实类别，以及 4c 的未消歧关系补证问题/);
    expect(prompt).toMatch(/视为.{0,4}数据/); // 资料中的指令性文字一律当数据
    expect(prompt).toMatch(/name.*model.*product.*quote/is);
    expect(prompt).toMatch(/competitors\s*=\s*\[\]/i);
    expect(prompt).toContain('target_markets');
    expect(prompt).toContain('technical_parameters');
    expect(BRAND_PROFILE_PROMPT_VERSION).toBe('brand-profile/10');
    expect(BRAND_PROFILE_ROUTE_VALIDATION_VERSION).toBe(
      'brand-profile-route-validation/8',
    );
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

  it.each([
    'How does Acme GmbH manage quality control?',
    'Does Acme GmbH lead product design?',
    'What is the employee count?',
    'What is the documented total employee count?',
    'What documented employee-count range or total is available?',
    'How many employees does the company have?',
    'When was the company founded, and what milestones should be included in its history?',
    'What is the company’s explicit commercial role: manufacturer, supplier, distributor, trader, assembler, OEM, or brand owner?',
    'What is the company\'s explicitly designated business role: supplier, manufacturer, OEM, assembler, distributor, trader, or another role?',
    'Which certifications or compliance standards does the company hold?',
    'Which manufacturing processes are performed in-house, beyond the product descriptions provided?',
    'What production facilities, equipment, or inspection capabilities does the company operate?',
    'Which industries or customer segments does the company explicitly serve?',
    'What quality-control procedures, testing capabilities, or traceability systems are available?',
    'What shipping regions, delivery terms, packaging capabilities, or logistics services are available?',
    'Which certifications, quality-management systems, and standards can be documented?',
    'What production processes, machining capabilities, equipment, and in-house facilities can be verified?',
    'What inspection methods, test equipment, traceability procedures, and quality-control documentation are available?',
    'What tolerances, surface treatments, load requirements, and additional technical specifications apply to the yokes and flanges?',
    'Are custom drawings, materials, dimensions, tooling, or OEM services available?',
    'What are the production capacity, minimum order quantity, sample policy, and typical lead time?',
    'What is the typical lead-time?',
    'What is the founding year and verified company history?',
    '员工人数是多少？',
    '有哪些代表产品？',
    'Who manages quality control?',
    'Which manager leads quality control?',
    '谁负责质量管理？',
    'Who is the CEO?',
    'Does the company have a CEO?',
    'Please provide CEO?',
    'What is the employee count approved by the CEO?',
    'What is the employee count for HR?',
    'What is the employee count by manager?',
    'What is the employee count under the sales director?',
  ])(
    '任务级失败门允许已知企业主体或封闭人员汇总问题: %s',
    (question) => {
      expect(() =>
        BRAND_PROFILE_TASK.validateOutput?.(input, {
          valueProps: [],
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [],
          gaps: [{ field: 'missing_fact', question }],
        }),
      ).not.toThrow();
    },
  );

  it.each([
    'CEO: Acme GmbH',
    'What is the employee count? CEO: Jane Smith',
    'How does Acme GmbH manage quality control? Jane Smith leads sales.',
    'When was Jane Smith founded?',
    'What employee-count figure is available for Jane Smith?',
    'What is Jane Smith employee count?',
    'What is the employee count overseen by CEO Jane?',
    'Does CEO Jane lead sales?',
    'Who is CEO Jane?',
    'What is the employee count approved by CEO Jane?',
    'CEO Jane负责质量管理吗？',
    'Is Jane Smith the CEO?',
    '张三是负责人吗？',
    'What is the email john@example.com?',
    'Can you confirm +1 415 555 1212?',
    'Can you confirm @janesmith?',
    'Can you confirm @张三?',
    '请联系@张三？',
    'Is this linkedin.com/in/jane-smith?',
    'Is this x.com/janesmith?',
    'Is this instagram.com/janesmith?',
    'Is this t.me/janesmith?',
    'Is this https://例子.公司/张三?',
    'Is this https://xn--fsqu00a.xn--55qx5d/jane?',
    'Is this https://localhost/user/jane?',
    'Can you confirm telegram:janesmith?',
    'Can you confirm signal:janesmith?',
    'Can you confirm skype:janesmith?',
    'Can you confirm line:janesmith?',
    'Is this www.例子.公司/张三?',
    'What is the WeChat ID wxid_janesmith?',
  ])('任务级失败门仍拒绝人员身份问题: %s', (question) => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [],
        gaps: [{ field: 'missing_fact', question }],
      }),
    ).toThrow(/explicit personal attribution/i);
  });

  it.each(['ceo', 'contact_person', 'sales_manager', 'founder'])(
    '任务级失败门允许不含实际个人值的受控 gap field: %s',
    (field) => {
      expect(() =>
        BRAND_PROFILE_TASK.validateOutput?.(input, {
          valueProps: [],
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [],
          gaps: [{ field, question: 'Please provide supporting details?' }],
        }),
      ).not.toThrow();
    },
  );

  it.each(['email', 'contact_email', 'phone', 'whatsapp'])(
    '任务级失败门仍拒绝会把实际联系方式引入公共 gap 的 field: %s',
    (field) => {
      expect(() =>
        BRAND_PROFILE_TASK.validateOutput?.(input, {
          valueProps: [],
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [],
          factSheet: [],
          gaps: [{ field, question: 'Please provide supporting details?' }],
        }),
      ).toThrow(/explicit personal attribution/i);
    },
  );

  it.each([
    { valueProps: ['Follow @janesmith'] },
    { valueProps: ['Follow @张三'] },
    { valueProps: ['联系@张三'] },
    { keywords: ['linkedin.com/in/jane-smith'] },
    { keywords: ['x.com/janesmith'] },
    { keywords: ['instagram.com/janesmith'] },
    { keywords: ['t.me/janesmith'] },
    { keywords: ['https://例子.公司/张三'] },
    { keywords: ['https://xn--fsqu00a.xn--55qx5d/jane'] },
    { keywords: ['https://localhost/user/jane'] },
    { keywords: ['telegram:janesmith'] },
    { keywords: ['signal:janesmith'] },
    { keywords: ['skype:janesmith'] },
    { keywords: ['line:janesmith'] },
    { keywords: ['www.例子.公司/张三'] },
    { differentiators: ['WeChat ID wxid_janesmith'] },
  ])('任务级失败门拒绝公共输出里的个人社交标识: %j', (over) => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [],
        gaps: [],
        ...over,
      }),
    ).toThrow(/explicit personal attribution/i);
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

  it('任务级失败门安全报告被拒字段，便于区分路由失败与证据契约失败', () => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [
          {
            key: 'main_products',
            value: 'Industrial valves',
            evidence: {
              sourceType: 'upload',
              sourceId: 'kb-1',
              contentHash: 'b'.repeat(64),
              quote: 'Pumps up to 400 bar.',
            },
          },
        ],
        gaps: [],
      }),
    ).toThrow(/main_products:evidence_value_mismatch/);
  });

  it.each([
    {
      name: 'valueProps',
      over: { valueProps: ['Founded by Jane Smith'] },
    },
    {
      name: 'tone',
      over: { tone: { voice: 'Led by Jane Smith', style: [] } },
    },
    {
      name: 'differentiators',
      over: { differentiators: ['Designed by Jane Smith'] },
    },
    {
      name: 'glossary',
      over: {
        glossary: [{ term: 'Leadership', definition: 'CEO: Jane Smith' }],
      },
    },
    {
      name: 'gaps',
      over: {
        gaps: [{ field: 'leadership', question: 'Contact person: Jane Smith' }],
      },
    },
    {
      name: 'single-name byline',
      over: { valueProps: ['Led by Jane'] },
    },
    {
      name: 'single-name role label',
      over: { differentiators: ['CEO: Jane'] },
    },
    {
      name: 'fact value byline',
      over: {
        factSheet: [
          {
            key: 'capability',
            value: 'Written by Jane Smith',
            evidence: {
              sourceType: 'upload' as const,
              sourceId: 'kb-1',
              contentHash: 'b'.repeat(64),
              quote: 'Pumps up to 400 bar.',
            },
          },
        ],
      },
    },
    {
      name: 'fact quote byline',
      over: {
        factSheet: [
          {
            key: 'capability',
            value: 'Industrial pumps',
            evidence: {
              sourceType: 'upload' as const,
              sourceId: 'kb-1',
              contentHash: 'b'.repeat(64),
              quote: 'Written by Jane Smith',
            },
          },
        ],
      },
    },
    { name: 'bare CEO value proposition', over: { valueProps: ['CEO'] } },
    { name: 'bare founder keyword', over: { keywords: ['founder'] } },
    { name: 'bare CEO tone', over: { tone: { voice: 'CEO', style: [] } } },
    {
      name: 'bare sales manager differentiator',
      over: { differentiators: ['sales manager'] },
    },
    {
      name: 'bare contact-person glossary',
      over: { glossary: [{ term: 'contact person', definition: 'role' }] },
    },
    {
      name: 'bare personal name value proposition',
      over: { valueProps: ['Jane Smith'] },
    },
    { name: 'bare personal name keyword', over: { keywords: ['Jane Smith'] } },
    {
      name: 'bare personal name tone',
      over: { tone: { voice: 'Jane Smith', style: [] } },
    },
    { name: 'email keyword', over: { keywords: ['john@example.com'] } },
    {
      name: 'phone value proposition',
      over: { valueProps: ['+1 415 555 1212'] },
    },
  ])('任务级失败门拒绝 $name 中的明确个人署名', ({ over }) => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [],
        gaps: [],
        ...over,
      }),
    ).toThrow(/explicit personal attribution/i);
  });

  it('任务级失败门只记录拒绝字段范围，不把潜在姓名写进错误日志', () => {
    let caught: unknown;
    try {
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [
          {
            key: 'capability',
            value: 'Industrial pumps',
            evidence: {
              sourceType: 'upload',
              sourceId: 'kb-1',
              contentHash: 'b'.repeat(64),
              quote: 'Written by Jane Smith',
            },
          },
        ],
        gaps: [],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/evidenceQuotes\/\w+:1/);
    expect((caught as Error).message).not.toContain('Jane Smith');
  });

  it.each(CLOSED_PERSONAL_ATTRIBUTION_TEXTS)('任务级失败门拒绝闭集角色/署名关系: %s', (value) => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [value],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [],
        gaps: [],
      }),
    ).toThrow(/explicit personal attribution/i);
  });

  it.each(['Jane Smith', 'General Electric', 'Atlas Copco'])(
    '任务级失败门拒绝未做组织身份消歧的 competitor: %s',
    (name) => {
      expect(() =>
        BRAND_PROFILE_TASK.validateOutput?.(input, {
          valueProps: [],
          glossary: [],
          keywords: [],
          differentiators: [],
          competitors: [{ name, positioning: 'Premium segment' }],
          factSheet: [],
          gaps: [],
        }),
      ).toThrow(/unresolved competitor identity/i);
    },
  );

  it.each([
    {
      tone: { voice: 'Led by Quality Engineering', style: [] },
    },
    { valueProps: ['Written by Quality Engineering'] },
    { differentiators: ['Quality Engineering leads production'] },
    { keywords: ['Managed by programmable logic controller'] },
    { keywords: ['Programmable Logic Controller Integration'] },
    { keywords: ['curing agent'] },
    { valueProps: ['global partner network'] },
    { keywords: ['brand owner'] },
    { differentiators: ['buyer-focused documentation'] },
    { keywords: ['High Pressure Pumps'] },
    { keywords: ['高压泵', '工业泵', '质量管理', '北美'] },
  ])('明确部门/系统归属不是个人署名，不应误杀：%j', (over) => {
    expect(() =>
      BRAND_PROFILE_TASK.validateOutput?.(input, {
        valueProps: [],
        glossary: [],
        keywords: [],
        differentiators: [],
        competitors: [],
        factSheet: [],
        gaps: [],
        ...over,
      }),
    ).not.toThrow();
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
