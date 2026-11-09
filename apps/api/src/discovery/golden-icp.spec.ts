import { describe, expect, it } from 'vitest';
import {
  GoldenIcpParseError,
  parseGoldenIcpYaml,
  precisionAtK,
  rankGoldenCandidates,
} from './golden-icp';

const SAMPLE_YAML = `# Golden ICP 评测集（测试样例）
version: 1
queries:
  - id: de-pumps
    icp: 德国工业泵分销商
    target_markets: [德国, Germany]
    industry_terms:
      - 工业泵
      - pumps
    expected_domains:
      - pumpentechnik-bass.de
      - wasserpumpe.de   # 行尾注释
    excluded_domains: [amazon.de]
    labeled_by: mlhjyx
    labeled_at: "2026-11-10"
    notes: 试点样本
  - id: unlabeled-query
    icp: 法国阀门进口商
    target_markets: [法国]
    industry_terms: [valves]
    expected_domains: []
`;

describe('parseGoldenIcpYaml', () => {
  it('parses the restricted YAML subset (inline and block lists, comments, quotes)', () => {
    const set = parseGoldenIcpYaml(SAMPLE_YAML);
    expect(set.version).toBe(1);
    expect(set.queries).toHaveLength(2);
    const [first, second] = set.queries;
    expect(first).toMatchObject({
      id: 'de-pumps',
      icp: '德国工业泵分销商',
      targetMarkets: ['德国', 'Germany'],
      industryTerms: ['工业泵', 'pumps'],
      expectedDomains: ['pumpentechnik-bass.de', 'wasserpumpe.de'],
      excludedDomains: ['amazon.de'],
      labeledBy: 'mlhjyx',
      labeledAt: '2026-11-10',
    });
    expect(second?.id).toBe('unlabeled-query');
    expect(second?.expectedDomains).toEqual([]);
  });

  it('rejects malformed input with a line number instead of silently skipping', () => {
    expect(() => parseGoldenIcpYaml('version: 1\nqueries:\n  - id: a\n    icp: x\n  broken line\n')).toThrow(
      GoldenIcpParseError,
    );
    expect(() => parseGoldenIcpYaml('version: 1\nqueries:\n  - id: a\n  - id: a\n')).toThrow(/重复/);
    expect(() => parseGoldenIcpYaml('unexpected: 1\n')).toThrow(/未知顶层键/);
  });
});

const CANDIDATES = [
  {
    domain: 'pumpentechnik-bass.de',
    name: 'Pumpentechnik Bass',
    country: 'DE',
    industry: 'Manufacture of machinery and equipment n.e.c.',
    keywords: ['pumps'],
  },
  {
    domain: 'wasserpumpe.de',
    name: 'Wasserpumpe',
    country: 'DE',
    industry: null,
    products: ['pumps'],
  },
  {
    domain: 'cheese-shop.fr',
    name: 'Fromagerie',
    country: 'FR',
    industry: null,
    keywords: ['cheese'],
  },
  {
    domain: 'valves-gmbh.de',
    name: 'Valves GmbH',
    country: 'DE',
    industry: null,
    keywords: ['valves'],
  },
];

describe('rankGoldenCandidates', () => {
  const query = {
    id: 'de-pumps',
    icp: '德国工业泵分销商',
    targetMarkets: ['德国'],
    industryTerms: ['工业泵', 'pumps'],
    expectedDomains: ['pumpentechnik-bass.de', 'wasserpumpe.de'],
    excludedDomains: [],
  };

  it('ranks industry/market matches first, deterministically', () => {
    const ranked = rankGoldenCandidates(query, CANDIDATES);
    expect(ranked.map((candidate) => candidate.domain)).toEqual([
      'pumpentechnik-bass.de',
      'wasserpumpe.de',
      'valves-gmbh.de',
      'cheese-shop.fr',
    ]);
    expect(ranked[0]?.matches).toEqual(expect.arrayContaining(['isic:28', 'term:pumps', 'market:DE']));
    expect(ranked[3]?.score).toBe(0);
  });
});

describe('precisionAtK', () => {
  it('computes precision@K, recall, misses and excluded hits', () => {
    const query = {
      id: 'de-pumps',
      icp: '',
      targetMarkets: ['德国'],
      industryTerms: ['pumps'],
      expectedDomains: ['pumpentechnik-bass.de', 'wasserpumpe.de', 'missing.de'],
      excludedDomains: ['valves-gmbh.de'],
    };
    const ranked = rankGoldenCandidates(query, CANDIDATES);
    const result = precisionAtK(query, ranked, 2);
    expect(result).toMatchObject({
      labeled: true,
      precisionAtK: 1,
      recall: 0.6667,
      missed: ['missing.de'],
      excludedInTopK: [],
    });
    const wider = precisionAtK(query, ranked, 4);
    expect(wider.precisionAtK).toBe(0.5);
    expect(wider.excludedInTopK).toEqual(['valves-gmbh.de']);
  });

  it('marks unlabeled queries without scoring them', () => {
    const query = {
      id: 'u',
      icp: '',
      targetMarkets: [],
      industryTerms: [],
      expectedDomains: [],
      excludedDomains: [],
    };
    const result = precisionAtK(query, rankGoldenCandidates(query, CANDIDATES));
    expect(result.labeled).toBe(false);
    expect(result.precisionAtK).toBe(0);
  });
});
