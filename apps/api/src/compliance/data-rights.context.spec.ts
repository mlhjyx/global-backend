import { describe, it, expect } from 'vitest';
import { storageRightsContextForLead, PROCESSOR_JURISDICTION, resolveProcessorJurisdiction } from './data-rights.context';
import { evaluateDataRights } from './data-rights.engine';
import { JURISDICTION_POLICY_SEED } from './jurisdiction-policy.seed';

/** 用系统种子规则跑真引擎，得到 STORE 动作的存储权利 effect（= 快照 storage_rights_decision 的值）。 */
const rules = JURISDICTION_POLICY_SEED;
const effectFor = (input: Parameters<typeof storageRightsContextForLead>[0], processor?: 'EU' | 'UK' | 'US' | 'CN' | 'OTHER') =>
  evaluateDataRights(storageRightsContextForLead(input, processor), rules).effect;

describe('storageRightsContextForLead（纯映射）', () => {
  it('具名决策人 → red；纯公司事实 → green', () => {
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }).dataClass).toBe('red');
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: false }).dataClass).toBe('green');
  });

  it('国别 alpha-2 归一为主体法域（DE→EU / US→US / 缺失→OTHER）', () => {
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }).subjectJurisdiction).toBe('EU');
    expect(storageRightsContextForLead({ country: 'US', status: 'ENRICHED', hasNamedContacts: true }).subjectJurisdiction).toBe('US');
    expect(storageRightsContextForLead({ country: null, status: 'ENRICHED', hasNamedContacts: true }).subjectJurisdiction).toBe('OTHER');
  });

  it('action 恒 STORE、lawfulBasis 不断言、SUPPRESSED → suppressed', () => {
    const ctx = storageRightsContextForLead({ country: 'DE', status: 'SUPPRESSED', hasNamedContacts: true });
    expect(ctx.action).toBe('STORE');
    expect(ctx.lawfulBasis).toBeNull();
    expect(ctx.suppressed).toBe(true);
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }).suppressed).toBe(false);
  });

  it('processor 默认取 PROCESSOR_JURISDICTION，可注入覆盖', () => {
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }).processorJurisdiction).toBe(PROCESSOR_JURISDICTION);
    expect(storageRightsContextForLead({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }, 'CN').processorJurisdiction).toBe('CN');
  });
});

describe('storage_rights_decision 经真引擎 + 系统种子（STORE 动作 effect）', () => {
  it('EU 具名决策人 STORE → ALLOW（存储无需 basis）', () => {
    expect(effectFor({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }, 'EU')).toBe('ALLOW');
  });

  it('纯公司事实 → ALLOW（green 无限制）', () => {
    expect(effectFor({ country: 'DE', status: 'ENRICHED', hasNamedContacts: false }, 'EU')).toBe('ALLOW');
  });

  it('SUPPRESSED → DENY（禁联优先于一切）', () => {
    expect(effectFor({ country: 'DE', status: 'SUPPRESSED', hasNamedContacts: true }, 'EU')).toBe('DENY');
  });

  it('CN 主体 STORE → ALLOW_WITH_BASIS（PIPL 存储需合法性基础）', () => {
    expect(effectFor({ country: 'CN', status: 'ENRICHED', hasNamedContacts: true }, 'EU')).toBe('ALLOW_WITH_BASIS');
  });

  it('EU 主体 × CN 处理地 STORE → REQUIRE_APPROVAL（GDPR Chapter V/PIPL 跨境人审）', () => {
    expect(effectFor({ country: 'DE', status: 'ENRICHED', hasNamedContacts: true }, 'CN')).toBe('REQUIRE_APPROVAL');
  });

  // Codex P1 on PR #72：非 alpha-2 国别（ISO-3 / 国名）必须归到正确法域并流到真引擎判定，
  // 否则会静默落 OTHER → 漏 CN(ALLOW_WITH_BASIS) 与 EU×CN 跨境(REQUIRE_APPROVAL)。
  it('ISO-3 CHN 主体 STORE → ALLOW_WITH_BASIS（等价 alpha-2 CN，非 OTHER）', () => {
    expect(effectFor({ country: 'CHN', status: 'ENRICHED', hasNamedContacts: true }, 'EU')).toBe('ALLOW_WITH_BASIS');
  });

  it('国名 "China" 主体 STORE → ALLOW_WITH_BASIS（非 OTHER）', () => {
    expect(effectFor({ country: 'China', status: 'ENRICHED', hasNamedContacts: true }, 'EU')).toBe('ALLOW_WITH_BASIS');
  });

  it('国名 "Germany" 主体 × CN 处理地 STORE → REQUIRE_APPROVAL（跨境，非 OTHER 漏判）', () => {
    expect(effectFor({ country: 'Germany', status: 'ENRICHED', hasNamedContacts: true }, 'CN')).toBe('REQUIRE_APPROVAL');
  });
});

/**
 * 处理地法域解析（Codex P1 on PR #72，fail-closed）：生产未设 DATA_PROCESSOR_JURISDICTION → 抛
 *（宁可 fail-fast 不启动也不静默缺省 EU 误判在华处理）；dev/test 未设 → 缺省 EU；非法值恒抛。
 */
describe('resolveProcessorJurisdiction（fail-closed）', () => {
  it('生产未设 → 抛（fail-closed，不静默缺省 EU）', () => {
    expect(() => resolveProcessorJurisdiction('', 'production')).toThrow(/DATA_PROCESSOR_JURISDICTION/);
    expect(() => resolveProcessorJurisdiction(null, 'production')).toThrow();
    expect(() => resolveProcessorJurisdiction(undefined, 'production')).toThrow();
  });

  it('dev/test 未设 → 缺省 EU（便于本地/CI）', () => {
    expect(resolveProcessorJurisdiction('', 'development')).toBe('EU');
    expect(resolveProcessorJurisdiction(undefined, 'test')).toBe('EU');
  });

  it('已设合法值 → 采用（大小写无关），任何 env 下均不抛', () => {
    expect(resolveProcessorJurisdiction('CN', 'production')).toBe('CN');
    expect(resolveProcessorJurisdiction('cn', 'production')).toBe('CN');
    expect(resolveProcessorJurisdiction('EU', 'production')).toBe('EU');
  });

  it('非法值 → 抛（fail-fast 防拼写），与 env 无关', () => {
    expect(() => resolveProcessorJurisdiction('XX', 'production')).toThrow(/非法/);
    expect(() => resolveProcessorJurisdiction('CHINA', 'development')).toThrow(/非法/);
  });
});
