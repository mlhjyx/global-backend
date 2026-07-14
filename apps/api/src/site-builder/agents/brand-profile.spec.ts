import { describe, expect, it } from 'vitest';
import {
  BRAND_PROFILE_OUTPUT_SCHEMA,
  BRAND_PROFILE_TASK,
  buildBrandProfilePrompt,
  enforceEvidenceGate,
  RawFactItem,
} from './brand-profile';

/**
 * brandProfile AiTask（09 §2.4 / 合规 C4 + D1/D2）：
 * - 确定性出口闸：factSheet 逐项 evidence 非空；storefront/web_research 引用必须命中
 *   本次真实提供过的 URL（反捏造引用）；认证类断言 web_research 单源不上站 → 降 gaps。
 * - 输出 schema 结构性排除个人字段（C4）。
 */

const KNOWN_URLS = new Set(['https://acme.example', 'https://fair.example/exhibitors/acme']);

const fact = (over: Partial<RawFactItem> = {}): RawFactItem => ({
  key: 'main_products',
  value: 'High-pressure industrial pumps',
  evidence: { sourceType: 'upload' },
  ...over,
});

describe('enforceEvidenceGate — D1 零虚构代码闸', () => {
  it('evidence 齐备的事实通过', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact()], { knownUrls: KNOWN_URLS });
    expect(factSheet).toHaveLength(1);
    expect(gaps).toHaveLength(0);
  });

  it('缺 evidence → 剔出 factSheet，降 gaps（reason=missing_evidence）', () => {
    const { factSheet, gaps } = enforceEvidenceGate([fact({ evidence: undefined })], {
      knownUrls: KNOWN_URLS,
    });
    expect(factSheet).toHaveLength(0);
    expect(gaps).toEqual([
      expect.objectContaining({ field: 'main_products', reason: 'missing_evidence' }),
    ]);
  });

  it('sourceType 不在分级枚举内 → 降 gaps（不接受模型自创来源）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [fact({ evidence: { sourceType: 'model_memory' as never } })],
      { knownUrls: KNOWN_URLS },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0].reason).toBe('missing_evidence');
  });

  it('🔴 反捏造引用：storefront/web_research 的 url 不在本次提供的来源集合 → 降 gaps', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({ evidence: { sourceType: 'web_research', url: 'https://made-up.example/page' } }),
        fact({ key: 'hq', evidence: { sourceType: 'storefront' } }), // 连 url 都没给
      ],
      { knownUrls: KNOWN_URLS },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps.map((g) => g.reason)).toEqual(['uncited_web_source', 'uncited_web_source']);
  });

  it('🔴 D2 认证类断言 web_research 单源不上站（ISO/CE/FDA…→ 降 gaps 请站主提供证书）', () => {
    const { factSheet, gaps } = enforceEvidenceGate(
      [
        fact({
          key: 'certifications',
          value: 'ISO 9001 certified',
          evidence: { sourceType: 'web_research', url: 'https://fair.example/exhibitors/acme' },
        }),
      ],
      { knownUrls: KNOWN_URLS },
    );
    expect(factSheet).toHaveLength(0);
    expect(gaps[0]).toMatchObject({ field: 'certifications', reason: 'unverified_certification' });
  });

  it('认证类断言来自 intake/upload（站主自证）→ 放行', () => {
    const { factSheet } = enforceEvidenceGate(
      [fact({ key: 'certifications', value: 'CE marked pumps', evidence: { sourceType: 'intake' } })],
      { knownUrls: KNOWN_URLS },
    );
    expect(factSheet).toHaveLength(1);
  });

  it('引用命中真实来源的 web_research 非认证事实 → 放行', () => {
    const { factSheet } = enforceEvidenceGate(
      [
        fact({
          key: 'trade_fairs',
          value: 'Exhibited at EuroBLECH',
          evidence: { sourceType: 'web_research', url: 'https://fair.example/exhibitors/acme' },
        }),
      ],
      { knownUrls: KNOWN_URLS },
    );
    expect(factSheet).toHaveLength(1);
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
