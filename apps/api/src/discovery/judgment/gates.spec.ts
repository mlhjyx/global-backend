import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

import { GATE_REASON_CODES, type GateReasonCode } from './failure-codes';
import {
  GATE_SET_VERSION,
  GATE_VERSIONS,
  SANCTIONS_FRESH_MAX_HOURS,
  SANCTIONS_YELLOW_MAX_HOURS,
  assertGateDecision,
  buildSanctionsFacts,
  canonicalJson,
  decideCountryGate,
  decideDomainGate,
  decideIcpExclusionGate,
  decideSanctionsGate,
  decideSizeGate,
  decideSuppressionGate,
  evaluateGates,
  gateInputDigest,
  normalizeCountryIso,
  normalizeMarketIsos,
  sanctionsFreshnessState,
  type GateDecision,
  type SanctionsFacts,
} from './gates';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const HOUR = 3_600_000;

function sanctionsFacts(overrides: Partial<SanctionsFacts> = {}): SanctionsFacts {
  return {
    screeningStatus: 'clear',
    reviewState: 'open',
    listVersions: { ofac_sdn: '2026-11-01' },
    enabledSourceKeys: ['ofac_sdn'],
    failedSourceKeys: [],
    missingRefreshSourceKeys: [],
    minRefreshedAt: '2026-11-09T00:00:00.000Z',
    refreshAgeHours: 12,
    ...overrides,
  };
}

// ── G1 制裁门（含陈旧门四态） ───────────────────────────────────────────────

describe('decideSanctionsGate（G1 制裁 + 陈旧四态）', () => {
  it('清白 + fresh → PASS（无 reason_code）', () => {
    const decision = decideSanctionsGate(sanctionsFacts());
    expect(decision.gateId).toBe('G_SANCTIONS');
    expect(decision.gateVersion).toBe(GATE_VERSIONS.G_SANCTIONS);
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
    expect(decision.applicable).toBe(true);
    expect(decision.facts).toMatchObject({
      freshness: 'fresh',
      screening_status: 'clear',
      list_versions: { ofac_sdn: '2026-11-01' },
    });
  });

  it('potential_match + open → FAIL GATE_SANCTIONS_HIT（压过一切）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ screeningStatus: 'potential_match', reviewState: 'open' }),
    );
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_HIT');
  });

  it('potential_match + confirmed_true_hit → FAIL', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({
        screeningStatus: 'potential_match',
        reviewState: 'confirmed_true_hit',
      }),
    );
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_HIT');
  });

  it('potential_match 但 review_state 漂移（null）→ FAIL（fail-safe，不得当成清白）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ screeningStatus: 'potential_match', reviewState: null }),
    );
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_HIT');
  });

  it('potential_match + cleared_false_positive → 视为清白，fresh 时 PASS', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({
        screeningStatus: 'potential_match',
        reviewState: 'cleared_false_positive',
      }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
  });

  it('无筛查记录 → UNKNOWN GATE_SANCTIONS_NOT_SCREENED（未筛查不是通过）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ screeningStatus: null, reviewState: null }),
    );
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_NOT_SCREENED');
    expect(decision.applicable).toBe(true);
  });

  it('筛查状态显式 not_screened → UNKNOWN', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ screeningStatus: 'not_screened', reviewState: null }),
    );
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_NOT_SCREENED');
  });

  it('筛查状态值漂移（库值不在闭集）→ UNKNOWN（不得静默通过）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ screeningStatus: 'still_running', reviewState: null }),
    );
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_NOT_SCREENED');
  });

  it('无 ENABLED 源（筛门未启用）→ UNKNOWN（fail-open → fail-safe），即便库里有 clear 行', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({
        enabledSourceKeys: [],
        failedSourceKeys: [],
        missingRefreshSourceKeys: [],
        minRefreshedAt: null,
        refreshAgeHours: null,
      }),
    );
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_NOT_SCREENED');
    expect(decision.facts.freshness).toBe('none');
  });

  it('命中在无 ENABLED 源时仍是 FAIL（未清白的命中永远拦）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({
        screeningStatus: 'potential_match',
        reviewState: 'open',
        enabledSourceKeys: [],
        minRefreshedAt: null,
        refreshAgeHours: null,
      }),
    );
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_HIT');
  });

  it('fresh 边界：恰好 72h → fresh', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ refreshAgeHours: SANCTIONS_FRESH_MAX_HOURS }),
    );
    expect(decision.facts.freshness).toBe('fresh');
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
  });

  it('yellow：72h < age ≤ 168h → PASS 但带 stale reason 与 sanctions_stale', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ refreshAgeHours: SANCTIONS_FRESH_MAX_HOURS + 0.5 }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_STALE_YELLOW');
    expect(decision.facts.freshness).toBe('yellow');
    expect(decision.facts.sanctions_stale).toBe(true);
  });

  it('yellow/fresh 边界：恰好 168h 仍是 yellow', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ refreshAgeHours: SANCTIONS_YELLOW_MAX_HOURS }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_STALE_YELLOW');
  });

  it('red：> 168h → PASS 但带 stale-red（判定可继续，下游不得进推荐/导出）', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ refreshAgeHours: SANCTIONS_YELLOW_MAX_HOURS + 0.5 }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_STALE_RED');
    expect(decision.facts.freshness).toBe('red');
    expect(decision.facts.sanctions_stale).toBe(true);
  });

  it('任一 ENABLED 源最近刷新 FAILED（即便 age 在 fresh 窗口）→ yellow', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({ refreshAgeHours: 1, failedSourceKeys: ['eu_fsf'] }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_STALE_YELLOW');
    expect(decision.facts.failed_sources).toEqual(['eu_fsf']);
  });

  it('ENABLED 源从未刷新（无新鲜度证据）→ red', () => {
    const decision = decideSanctionsGate(
      sanctionsFacts({
        missingRefreshSourceKeys: ['eu_fsf'],
        refreshAgeHours: null,
        minRefreshedAt: null,
      }),
    );
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBe('GATE_SANCTIONS_STALE_RED');
    expect(decision.facts.freshness).toBe('red');
  });

  it('freshness 派生：72/168 小时阈值', () => {
    expect(sanctionsFreshnessState(sanctionsFacts({ refreshAgeHours: 71.9 }))).toBe('fresh');
    expect(sanctionsFreshnessState(sanctionsFacts({ refreshAgeHours: 72.1 }))).toBe('yellow');
    expect(sanctionsFreshnessState(sanctionsFacts({ refreshAgeHours: 167.9 }))).toBe('yellow');
    expect(sanctionsFreshnessState(sanctionsFacts({ refreshAgeHours: 168.1 }))).toBe('red');
  });
});

describe('buildSanctionsFacts（G1 输入归一）', () => {
  it('取 ENABLED 源最旧刷新时间计算 age；FAILED / 从未刷新源分别记账', () => {
    const facts = buildSanctionsFacts({
      screening: {
        status: 'clear',
        reviewState: 'open',
        listVersions: { ofac_sdn: '2026-11-01', junk: 42 },
      },
      sources: [
        { key: 'ofac_sdn', lastRefreshedAt: new Date(NOW.getTime() - 10 * HOUR), lastFetchStatus: 'DONE' },
        { key: 'eu_fsf', lastRefreshedAt: new Date(NOW.getTime() - 30 * HOUR), lastFetchStatus: 'FAILED' },
        { key: 'ofac_consolidated', lastRefreshedAt: null, lastFetchStatus: null },
      ],
      now: NOW,
    });
    expect(facts.enabledSourceKeys).toEqual(['eu_fsf', 'ofac_consolidated', 'ofac_sdn']);
    expect(facts.failedSourceKeys).toEqual(['eu_fsf']);
    expect(facts.missingRefreshSourceKeys).toEqual(['ofac_consolidated']);
    expect(facts.minRefreshedAt).toBe(new Date(NOW.getTime() - 30 * HOUR).toISOString());
    expect(facts.refreshAgeHours).toBe(30);
    // listVersions 只保留字符串值。
    expect(facts.listVersions).toEqual({ ofac_sdn: '2026-11-01' });
  });

  it('同输入不同评估时刻（refreshAgeHours 变化）不改变 digest（replay 幂等的前提）', () => {
    const sources = [
      { key: 'ofac_sdn', lastRefreshedAt: new Date(NOW.getTime() - 10 * HOUR), lastFetchStatus: 'DONE' },
    ];
    const a = decideSanctionsGate(
      buildSanctionsFacts({ screening: { status: 'clear', reviewState: 'open', listVersions: {} }, sources, now: NOW }),
    );
    const b = decideSanctionsGate(
      buildSanctionsFacts({
        screening: { status: 'clear', reviewState: 'open', listVersions: {} },
        sources,
        now: new Date(NOW.getTime() + HOUR),
      }),
    );
    expect(a.verdict).toBe('PASS');
    expect(a.inputDigest).toBe(b.inputDigest);
  });
});

// ── G2 禁联门 ──────────────────────────────────────────────────────────────

describe('decideSuppressionGate（G2 禁联）', () => {
  it('域名命中（canonical 化后比较）→ FAIL GATE_SUPPRESSION，并记录命中 id', () => {
    const decision = decideSuppressionGate({
      companyName: 'Muster Metallbau GmbH',
      companyDomain: 'example.com',
      rows: [{ id: 's1', type: 'domain', value: 'https://WWW.Example.com/kontakt' }],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SUPPRESSION');
    expect(decision.facts.matched_suppression_ids).toEqual(['s1']);
  });

  it('公司名命中（大小写不敏感）→ FAIL', () => {
    const decision = decideSuppressionGate({
      companyName: 'Muster Metallbau GmbH',
      companyDomain: null,
      rows: [
        { id: 's2', type: 'company_name', value: 'muster metallbau gmbh' },
        { id: 's3', type: 'domain', value: 'other.example' },
      ],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.facts.matched_suppression_ids).toEqual(['s2']);
  });

  it('canonical_company.status=SUPPRESSED（派生状态先于行可见）→ FAIL', () => {
    const decision = decideSuppressionGate({
      companyName: 'Muster Metallbau GmbH',
      companyDomain: 'example.com',
      companyStatus: 'SUPPRESSED',
      rows: [],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SUPPRESSION');
    expect(decision.facts.company_status).toBe('SUPPRESSED');
  });

  it('无命中（含空清单）→ PASS（查无即通过，缺失不等于证据缺失）', () => {
    const decision = decideSuppressionGate({
      companyName: 'Muster Metallbau GmbH',
      companyDomain: 'example.com',
      rows: [],
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
    expect(decision.facts.matched_suppression_ids).toEqual([]);
  });

  it('多个命中 id 排序输出（digest 确定性）', () => {
    const decision = decideSuppressionGate({
      companyName: 'Muster Metallbau GmbH',
      companyDomain: 'example.com',
      rows: [
        { id: 's9', type: 'domain', value: 'example.com' },
        { id: 's1', type: 'company_name', value: 'Muster Metallbau GmbH' },
      ],
    });
    expect(decision.facts.matched_suppression_ids).toEqual(['s1', 's9']);
  });
});

// ── G2b ICP 排除门 ─────────────────────────────────────────────────────────

describe('decideIcpExclusionGate（G2b ICP 排除）', () => {
  it('ICP 无 EXCLUSION 规则 → NOT_APPLICABLE（applicable=false）', () => {
    const decision = decideIcpExclusionGate({
      rules: [{ id: 'r1', kind: 'MUST_HAVE', field: 'country', operator: 'in', value: ['DE'] }],
      attributes: { country: 'DE' },
    });
    expect(decision.verdict).toBe('NOT_APPLICABLE');
    expect(decision.applicable).toBe(false);
    expect(decision.reasonCode).toBeNull();
    expect(decision.facts.exclusion_rule_count).toBe(0);
  });

  it('EXCLUSION 规则命中 → FAIL GATE_ICP_EXCLUSION（带 rule_id）', () => {
    const decision = decideIcpExclusionGate({
      rules: [
        { id: 'r9', kind: 'EXCLUSION', field: 'industry', operator: 'in', value: ['包装'] },
      ],
      attributes: { industry: '包装' },
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_ICP_EXCLUSION');
    expect(decision.facts.rule_ids).toEqual(['r9']);
  });

  it('未命中 → PASS', () => {
    const decision = decideIcpExclusionGate({
      rules: [
        { id: 'r9', kind: 'EXCLUSION', field: 'industry', operator: 'in', value: ['包装'] },
      ],
      attributes: { industry: '金属加工' },
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
  });

  it('镜像 EXCLUSION（MUST_HAVE 的否定型镜像）只记录 advisory，不排除', () => {
    const decision = decideIcpExclusionGate({
      rules: [
        { id: 'm1', kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: ['泵'] },
        { id: 'x1', kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: ['泵'] },
      ],
      attributes: { keywords: ['Pumpe', 'Ventil'] },
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
    expect(decision.facts.advisory_rule_ids).toEqual(['x1']);
    expect(decision.facts.rule_ids).toEqual([]);
  });

  it('属性缺失（outcome=unknown）不构成命中 → PASS，并记录 unknown_rule_ids', () => {
    const decision = decideIcpExclusionGate({
      rules: [
        { id: 'x1', kind: 'EXCLUSION', field: 'industry', operator: 'in', value: ['包装'] },
      ],
      attributes: {},
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.facts.unknown_rule_ids).toEqual(['x1']);
  });
});

// ── G3 国家/市场门 ─────────────────────────────────────────────────────────

describe('decideCountryGate（G3 国家）', () => {
  it('德国 vs DACH（地区词展开）→ PASS', () => {
    const decision = decideCountryGate({ companyCountry: '德国', marketTerms: ['DACH'] });
    expect(decision.verdict).toBe('PASS');
    expect(decision.facts.company_country_iso).toBe('DE');
    expect(decision.facts.markets).toEqual(['AT', 'CH', 'DE']);
  });

  it('已是 alpha-2 的国家（DE）与市场词 DE → PASS', () => {
    const decision = decideCountryGate({ companyCountry: 'DE', marketTerms: ['de', '德国'] });
    expect(decision.verdict).toBe('PASS');
  });

  it('不在市场集合 → FAIL GATE_COUNTRY_MISMATCH', () => {
    const decision = decideCountryGate({ companyCountry: 'FR', marketTerms: ['DACH'] });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_COUNTRY_MISMATCH');
  });

  it('公司国家缺失 → UNKNOWN GATE_COUNTRY_UNKNOWN（进补数队列）', () => {
    const decision = decideCountryGate({ companyCountry: null, marketTerms: ['DE'] });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_COUNTRY_UNKNOWN');
  });

  it('公司国家无法归一 → UNKNOWN（不得当成不符）', () => {
    const decision = decideCountryGate({ companyCountry: 'Narnia', marketTerms: ['DE'] });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_COUNTRY_UNKNOWN');
  });

  it('ICP 未声明市场 → NOT_APPLICABLE', () => {
    const decision = decideCountryGate({ companyCountry: 'DE', marketTerms: [] });
    expect(decision.verdict).toBe('NOT_APPLICABLE');
    expect(decision.applicable).toBe(false);
    expect(decision.facts.markets).toEqual([]);
  });

  it('归一函数：国名/代码/地区词', () => {
    expect(normalizeCountryIso('德国')).toBe('DE');
    expect(normalizeCountryIso('de')).toBe('DE');
    expect(normalizeCountryIso(' Narnia ')).toBeNull();
    expect(normalizeCountryIso(null)).toBeNull();
    expect(normalizeMarketIsos(['DACH', '德国', 'FR'])).toEqual(['AT', 'CH', 'DE', 'FR']);
  });

  it('自由文本市场词（dev 库实测形态）：精确匹配失败时做保守子串抽取', () => {
    // 2026-11-09 global_dev.icp_definition.target_markets 的真实值。
    expect(normalizeMarketIsos(['德国工业泵分销与批发渠道'])).toEqual(['DE']);
    expect(normalizeMarketIsos(['DACH地区工业泵分销市场'])).toEqual(['AT', 'CH', 'DE']);
    expect(normalizeMarketIsos(['瑞士（德语区优先）'])).toEqual(['CH']);
    // 拉丁词不做子串猜测（含 us 的无关词不得命中美国）。
    expect(normalizeMarketIsos(['industrial pump distribution'])).toEqual([]);
    // 德语 Dach（屋顶）不是 DACH 地区。
    expect(normalizeMarketIsos(['Dachdeckerbedarf'])).toEqual([]);
  });

  it('自由文本市场词也能驱动 PASS 判定', () => {
    const decision = decideCountryGate({
      companyCountry: 'AT',
      marketTerms: ['DACH地区工业泵分销市场'],
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.facts.markets).toEqual(['AT', 'CH', 'DE']);
  });
});

// ── G4 规模门 ──────────────────────────────────────────────────────────────

describe('decideSizeGate（G4 规模）', () => {
  const gte = (value: unknown, id = 'size-min') => ({
    id,
    kind: 'MUST_HAVE' as const,
    field: 'employee_count',
    operator: 'gte',
    value,
  });
  const lte = (value: unknown, id = 'size-max') => ({
    id,
    kind: 'MUST_HAVE' as const,
    field: 'employee_count',
    operator: 'lte',
    value,
  });

  it('在范围内（gte + lte）→ PASS', () => {
    const decision = decideSizeGate({
      employeeCount: 85,
      employeeBand: null,
      rules: [gte(51), lte(200)],
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
  });

  it('低于下限 → FAIL GATE_SIZE_OUT_OF_RANGE（带 rule_id）', () => {
    const decision = decideSizeGate({
      employeeCount: 10,
      employeeBand: null,
      rules: [gte(51)],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SIZE_OUT_OF_RANGE');
    expect(decision.facts.failed_rule_ids).toEqual(['size-min']);
  });

  it('高于上限 → FAIL', () => {
    const decision = decideSizeGate({
      employeeCount: 5000,
      employeeBand: null,
      rules: [lte(200)],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.reasonCode).toBe('GATE_SIZE_OUT_OF_RANGE');
  });

  it('band in 命中 → PASS（"51-200" 解析）', () => {
    const decision = decideSizeGate({
      employeeCount: null,
      employeeBand: '51-200',
      rules: [
        { id: 'band', kind: 'MUST_HAVE', field: 'employee_band', operator: 'in', value: ['51-200', '200+'] },
      ],
    });
    expect(decision.verdict).toBe('PASS');
  });

  it('band in 未命中 → FAIL', () => {
    const decision = decideSizeGate({
      employeeCount: null,
      employeeBand: '201-500',
      rules: [
        { id: 'band', kind: 'MUST_HAVE', field: 'employee_band', operator: 'in', value: ['51-200'] },
      ],
    });
    expect(decision.verdict).toBe('FAIL');
  });

  it('employeeCount 与 band 均缺失 → UNKNOWN GATE_SIZE_UNKNOWN', () => {
    const decision = decideSizeGate({ employeeCount: null, employeeBand: null, rules: [gte(51)] });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SIZE_UNKNOWN');
  });

  it('ICP 无规模条件 → NOT_APPLICABLE', () => {
    const decision = decideSizeGate({ employeeCount: 85, employeeBand: null, rules: [] });
    expect(decision.verdict).toBe('NOT_APPLICABLE');
    expect(decision.applicable).toBe(false);
  });

  it('规则值不可解析 → UNKNOWN（不静默通过），并记录 unknown_rule_ids', () => {
    const decision = decideSizeGate({
      employeeCount: 85,
      employeeBand: null,
      rules: [gte('many')],
    });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_SIZE_UNKNOWN');
    expect(decision.facts.unknown_rule_ids).toEqual(['size-min']);
  });

  it('FAIL 优先于 UNKNOWN（同门内一条越界 + 一条不可解析）', () => {
    const decision = decideSizeGate({
      employeeCount: 10,
      employeeBand: null,
      rules: [gte(51), lte('many', 'size-unknown')],
    });
    expect(decision.verdict).toBe('FAIL');
    expect(decision.facts.failed_rule_ids).toEqual(['size-min']);
    expect(decision.facts.unknown_rule_ids).toEqual(['size-unknown']);
  });
});

// ── G5 域名门 ──────────────────────────────────────────────────────────────

describe('decideDomainGate（G5 域名/可验证性）', () => {
  it('有域名且存活校验非 DEAD → PASS', () => {
    const decision = decideDomainGate({
      domain: 'https://www.Muster.de/',
      domainStatus: null,
      allowDomainless: false,
    });
    expect(decision.verdict).toBe('PASS');
    expect(decision.reasonCode).toBeNull();
    expect(decision.facts.domain_normalized).toBe('muster.de');
  });

  it('无域名 → UNKNOWN GATE_DOMAIN_MISSING（不进 LLM judge，进补数队列）', () => {
    const decision = decideDomainGate({ domain: null, domainStatus: null, allowDomainless: false });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_DOMAIN_MISSING');
  });

  it('域名 DEAD → UNKNOWN GATE_DOMAIN_DEAD', () => {
    const decision = decideDomainGate({
      domain: 'muster.de',
      domainStatus: 'DEAD',
      allowDomainless: false,
    });
    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.reasonCode).toBe('GATE_DOMAIN_DEAD');
  });

  it('ICP allow_domainless=true → NOT_APPLICABLE（例外降级）', () => {
    const decision = decideDomainGate({ domain: null, domainStatus: null, allowDomainless: true });
    expect(decision.verdict).toBe('NOT_APPLICABLE');
    expect(decision.applicable).toBe(false);
    expect(decision.reasonCode).toBeNull();
  });

  it('存活状态未知但域名存在 → PASS（没有存活证据 ≠ DEAD）', () => {
    const decision = decideDomainGate({
      domain: 'muster.de',
      domainStatus: 'UNKNOWN',
      allowDomainless: false,
    });
    expect(decision.verdict).toBe('PASS');
  });
});

// ── 闭集校验 / digest 确定性 ───────────────────────────────────────────────

describe('assertGateDecision（GATE_REASON_CODES 闭集，fail-closed）', () => {
  const base: GateDecision = {
    gateId: 'G_DOMAIN',
    gateVersion: GATE_VERSIONS.G_DOMAIN,
    verdict: 'UNKNOWN',
    reasonCode: 'GATE_DOMAIN_MISSING',
    applicable: true,
    facts: {},
    inputDigest: gateInputDigest('G_DOMAIN', {}),
  };

  it('合法决策通过', () => {
    expect(() => assertGateDecision(base)).not.toThrow();
  });

  it('FAIL/UNKNOWN 缺 reason_code → 抛错', () => {
    expect(() => assertGateDecision({ ...base, reasonCode: null })).toThrow(
      /GATE_REASON_CODE_REQUIRED/,
    );
  });

  it('未登记的 reason_code → 抛错（不允许拼写错误写进判定历史）', () => {
    expect(() =>
      assertGateDecision({ ...base, reasonCode: 'GATE_MADE_UP' as GateReasonCode }),
    ).toThrow(/UNKNOWN_GATE_REASON_CODE/);
  });

  it('NOT_APPLICABLE 必须 applicable=false 且无 reason_code', () => {
    expect(() =>
      assertGateDecision({ ...base, verdict: 'NOT_APPLICABLE', reasonCode: null, applicable: true }),
    ).toThrow(/GATE_NOT_APPLICABLE_INVALID/);
    expect(() =>
      assertGateDecision({ ...base, verdict: 'NOT_APPLICABLE', applicable: false }),
    ).toThrow(/GATE_NOT_APPLICABLE_INVALID/);
  });

  it('PASS 允许带 stale reason_code（G1 yellow/red 的降级标记）', () => {
    expect(() =>
      assertGateDecision({
        ...base,
        gateId: 'G_SANCTIONS',
        gateVersion: GATE_VERSIONS.G_SANCTIONS,
        verdict: 'PASS',
        reasonCode: 'GATE_SANCTIONS_STALE_YELLOW',
        inputDigest: gateInputDigest('G_SANCTIONS', {}),
      }),
    ).not.toThrow();
  });

  it('所有决策产出的 reason_code 都在闭集内', () => {
    const decisions = [
      decideSanctionsGate(sanctionsFacts()),
      decideSanctionsGate(sanctionsFacts({ screeningStatus: null, reviewState: null })),
      decideSanctionsGate(
        sanctionsFacts({ screeningStatus: 'potential_match', reviewState: 'open' }),
      ),
      decideSuppressionGate({ companyName: 'X', companyDomain: null, rows: [] }),
      decideCountryGate({ companyCountry: null, marketTerms: ['DE'] }),
      decideSizeGate({ employeeCount: null, employeeBand: null, rules: [] }),
      decideDomainGate({ domain: null, domainStatus: null, allowDomainless: false }),
    ];
    for (const decision of decisions) {
      expect(() => assertGateDecision(decision)).not.toThrow();
      if (decision.reasonCode !== null) {
        expect(GATE_REASON_CODES).toContain(decision.reasonCode);
      }
    }
  });
});

describe('gateInputDigest（确定性）', () => {
  it('同输入同 digest；facts 不同 / 门不同 → digest 不同', () => {
    const facts = { a: 1, b: ['x', 'y'] };
    expect(gateInputDigest('G_COUNTRY', facts)).toBe(gateInputDigest('G_COUNTRY', { ...facts }));
    expect(gateInputDigest('G_COUNTRY', facts)).not.toBe(
      gateInputDigest('G_COUNTRY', { a: 1, b: ['y', 'x'] }),
    );
    expect(gateInputDigest('G_COUNTRY', facts)).not.toBe(gateInputDigest('G_SIZE', facts));
    expect(gateInputDigest('G_COUNTRY', facts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonicalJson 按键排序、跳过 undefined', () => {
    expect(canonicalJson({ b: 1, a: undefined, c: { y: 2, x: [true, null] } })).toBe(
      '{"b":1,"c":{"x":[true,null],"y":2}}',
    );
  });
});

// ── evaluateGates 编排（假事务，零容器） ───────────────────────────────────

interface FakeWorld {
  company: Record<string, unknown> | null;
  icp: Record<string, unknown> | null;
  rules?: Array<Record<string, unknown>>;
  screening?: Record<string, unknown> | null;
  sources?: Array<{ key: string; lastRefreshedAt: Date | null; lastFetchStatus: string | null }>;
  suppressions?: Array<{ id: string; type: string; value: string }>;
}

interface FakeStore {
  results: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
}

function makeTx(world: FakeWorld, store: FakeStore): Prisma.TransactionClient {
  // 模拟两张表的表达式唯一索引 + INSERT … ON CONFLICT DO NOTHING。
  const resultKeys = new Set<string>();
  const taskKeys = new Set<string>();
  const insertMany = (
    target: Array<Record<string, unknown>>,
    keys: Set<string>,
    makeKey: (row: Record<string, unknown>) => string,
  ) =>
    vi.fn(async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const row of args.data) {
        const key = makeKey(row);
        if (keys.has(key)) continue;
        keys.add(key);
        target.push(row);
        count += 1;
      }
      return { count };
    });
  return {
    canonicalCompany: { findFirst: vi.fn(async () => world.company) },
    icpDefinition: { findFirst: vi.fn(async () => world.icp) },
    qualificationRule: { findMany: vi.fn(async () => world.rules ?? []) },
    sanctionsScreeningResult: { findUnique: vi.fn(async () => world.screening ?? null) },
    sanctionsSource: { findMany: vi.fn(async () => world.sources ?? []) },
    suppressionRecord: { findMany: vi.fn(async () => world.suppressions ?? []) },
    hardGateResult: {
      createMany: insertMany(
        store.results,
        resultKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}|${String(row.inputDigest)}`,
      ),
    },
    gateEnrichmentTask: {
      createMany: insertMany(
        store.tasks,
        taskKeys,
        (row) =>
          `${String(row.workspaceId)}|${String(row.canonicalCompanyId)}|${String(row.icpId ?? '')}|${String(row.gateId)}`,
      ),
    },
  } as unknown as Prisma.TransactionClient;
}

function happyWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    company: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Muster Metallbau GmbH',
      domain: 'muster.de',
      country: 'DE',
      industry: '金属加工',
      employeeCount: 85,
      revenueUsd: null,
      attributes: { employee_band: '51-200' },
    },
    icp: { companyAttributes: {}, targetMarkets: ['DACH'] },
    rules: [],
    screening: { status: 'clear', reviewState: 'open', listVersions: { ofac_sdn: '2026-11-01' } },
    sources: [
      {
        key: 'ofac_sdn',
        lastRefreshedAt: new Date(NOW.getTime() - 6 * HOUR),
        lastFetchStatus: 'DONE',
      },
    ],
    suppressions: [],
    ...overrides,
  };
}

const CTX = {
  workspaceId: '00000000-0000-4000-8000-00000000000a',
  canonicalCompanyId: '00000000-0000-4000-8000-000000000001',
  icpId: '00000000-0000-4000-8000-0000000000b2',
  now: NOW,
} as const;

describe('evaluateGates（编排 / 写库语义）', () => {
  it('全通过：按 G1→G5 顺序评估 6 个执行器，G1/G2 的 icp_id 为 NULL', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(makeTx(happyWorld(), store), CTX);

    expect(evaluation.gateSetVersion).toBe(GATE_SET_VERSION);
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.failedGate).toBeNull();
    expect(evaluation.results.map((decision) => decision.gateId)).toEqual([
      'G_SANCTIONS',
      'G_SUPPRESSION',
      'G_ICP_EXCLUSION',
      'G_COUNTRY',
      'G_SIZE',
      'G_DOMAIN',
    ]);
    expect(evaluation.insertedResultCount).toBe(6);
    expect(evaluation.enrichmentTaskCount).toBe(0);

    const byGate = new Map(store.results.map((row) => [row.gateId, row]));
    expect(byGate.get('G_SANCTIONS')?.icpId).toBeNull();
    expect(byGate.get('G_SUPPRESSION')?.icpId).toBeNull();
    expect(byGate.get('G_COUNTRY')?.icpId).toBe(CTX.icpId);
    expect(byGate.get('G_DOMAIN')?.icpId).toBe(CTX.icpId);
    expect(byGate.get('G_ICP_EXCLUSION')?.verdict).toBe('NOT_APPLICABLE');
    for (const row of store.results) {
      expect(row.gateSetVersion).toBe(GATE_SET_VERSION);
      expect(row.gateVersion).toBe(GATE_VERSIONS[row.gateId as keyof typeof GATE_VERSIONS]);
    }
  });

  it('任一 FAIL 短路：制裁命中后不再评估/写后续门', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          screening: { status: 'potential_match', reviewState: 'open', listVersions: {} },
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.failedGate?.gateId).toBe('G_SANCTIONS');
    expect(evaluation.results).toHaveLength(1);
    expect(store.results).toHaveLength(1);
    expect(store.results[0]?.gateId).toBe('G_SANCTIONS');
    expect(store.tasks).toHaveLength(0);
  });

  it('禁联命中在 G2 短路（G1 的 PASS 行已写，G3 起不评估）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          suppressions: [{ id: 's1', type: 'domain', value: 'muster.de' }],
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('FAIL');
    expect(evaluation.failedGate?.gateId).toBe('G_SUPPRESSION');
    expect(evaluation.results.map((decision) => decision.gateId)).toEqual([
      'G_SANCTIONS',
      'G_SUPPRESSION',
    ]);
  });

  it('UNKNOWN 不短路：国家缺失 → 后续门照常评估，整链 UNKNOWN，写补数任务', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          company: {
            ...happyWorld().company,
            country: null,
          },
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('UNKNOWN');
    expect(evaluation.results).toHaveLength(6);
    expect(evaluation.unknownGates.map((decision) => decision.gateId)).toEqual(['G_COUNTRY']);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toMatchObject({
      gateId: 'G_COUNTRY',
      reasonCode: 'GATE_COUNTRY_UNKNOWN',
      status: 'queued',
      icpId: CTX.icpId,
    });
  });

  it('G5 无域名 → UNKNOWN + 补数任务（GATE_DOMAIN_MISSING）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          company: { ...happyWorld().company, domain: null },
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('UNKNOWN');
    expect(evaluation.unknownGates.map((decision) => decision.reasonCode)).toEqual([
      'GATE_DOMAIN_MISSING',
    ]);
    expect(store.tasks).toHaveLength(1);
    expect(store.tasks[0]).toMatchObject({
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_MISSING',
      status: 'queued',
    });
  });

  it('域名存活校验 DEAD（ctx.domainStatus）→ G5 UNKNOWN + 补数任务（GATE_DOMAIN_DEAD）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(makeTx(happyWorld(), store), {
      ...CTX,
      domainStatus: 'DEAD',
    });
    expect(evaluation.verdict).toBe('UNKNOWN');
    expect(store.tasks[0]).toMatchObject({
      gateId: 'G_DOMAIN',
      reasonCode: 'GATE_DOMAIN_DEAD',
    });
  });

  it('ICP allow_domainless=true → G5 NOT_APPLICABLE，无补数任务', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          company: { ...happyWorld().company, domain: null },
          icp: { companyAttributes: { allow_domainless: true }, targetMarkets: ['DACH'] },
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('PASS');
    expect(evaluation.results.find((d) => d.gateId === 'G_DOMAIN')?.verdict).toBe(
      'NOT_APPLICABLE',
    );
    expect(store.tasks).toHaveLength(0);
  });

  it('G1 UNKNOWN（未筛查）不进补数队列（制裁复筛不是数据补数）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(happyWorld({ screening: null }), store),
      CTX,
    );
    expect(evaluation.verdict).toBe('UNKNOWN');
    expect(evaluation.unknownGates.map((decision) => decision.gateId)).toContain('G_SANCTIONS');
    expect(store.tasks.every((task) => task.gateId !== 'G_SANCTIONS')).toBe(true);
  });

  it('replay 幂等：同 digest 第二次评估不重复写（skipDuplicates 走唯一索引语义）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const tx = makeTx(happyWorld(), store);
    const first = await evaluateGates(tx, CTX);
    const second = await evaluateGates(tx, CTX);
    expect(first.insertedResultCount).toBe(6);
    expect(second.insertedResultCount).toBe(0);
    expect(first.enrichmentTaskCount).toBe(0);
    expect(second.enrichmentTaskCount).toBe(0);
    expect(store.results).toHaveLength(6);
    // createMany 用 ON CONFLICT DO NOTHING 语义。
    const createMany = tx.hardGateResult.createMany as unknown as {
      mock: { calls: Array<[{ skipDuplicates?: boolean }]> };
    };
    expect(createMany.mock.calls[0]?.[0].skipDuplicates).toBe(true);
  });

  it('ENABLED 源名单陈旧（>7d）→ G1 PASS 但带 stale-red，整链仍 PASS（下游 J07 降级）', async () => {
    const store: FakeStore = { results: [], tasks: [] };
    const evaluation = await evaluateGates(
      makeTx(
        happyWorld({
          sources: [
            {
              key: 'ofac_sdn',
              lastRefreshedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
              lastFetchStatus: 'DONE',
            },
          ],
        }),
        store,
      ),
      CTX,
    );
    expect(evaluation.verdict).toBe('PASS');
    const sanctions = evaluation.results.find((d) => d.gateId === 'G_SANCTIONS');
    expect(sanctions?.verdict).toBe('PASS');
    expect(sanctions?.reasonCode).toBe('GATE_SANCTIONS_STALE_RED');
  });

  it('缺公司 / 缺 ICP → 抛输入契约错误', async () => {
    await expect(
      evaluateGates(makeTx(happyWorld({ company: null }), { results: [], tasks: [] }), CTX),
    ).rejects.toThrow(/GATE_COMPANY_NOT_FOUND/);
    await expect(
      evaluateGates(makeTx(happyWorld({ icp: null }), { results: [], tasks: [] }), CTX),
    ).rejects.toThrow(/GATE_ICP_NOT_FOUND/);
  });

  it('确定性：同输入两次独立评估产出完全相同的 digest 序列', async () => {
    const a = await evaluateGates(makeTx(happyWorld(), { results: [], tasks: [] }), CTX);
    const b = await evaluateGates(makeTx(happyWorld(), { results: [], tasks: [] }), CTX);
    expect(a.results.map((d) => d.inputDigest)).toEqual(b.results.map((d) => d.inputDigest));
  });
});
