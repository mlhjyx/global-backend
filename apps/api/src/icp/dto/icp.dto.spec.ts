import { describe, expect, it } from 'vitest';
import { IcpDto } from './icp.dto';

const row = (rules: Array<{ kind: string; field: string; operator: string; value: unknown }>) => ({
  id: '10000000-0000-4000-8000-000000000001',
  companyId: '20000000-0000-4000-8000-000000000002',
  name: 'Synthetic ICP',
  status: 'ACTIVE',
  companyAttributes: {},
  painPoints: [],
  triggerSignals: [],
  exclusions: [],
  valueProps: [],
  targetMarkets: [],
  version: 1,
  createdAt: new Date('2026-10-14T00:00:00Z'),
  personas: [],
  roles: [],
  rules: rules.map((r, i) => ({ id: `rule-${i}`, weight: 1, rationale: null, ...r })),
});

describe('IcpDto.ruleLint（激活 / 读取时的规则提示）', () => {
  it('MUST_HAVE 的镜像 EXCLUSION（同 field 同 value、否定操作符）→ 一条提示，指明规则 id', () => {
    const dto = IcpDto.from(
      row([
        { kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: '泵' },
        { kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: '泵' },
        { kind: 'EXCLUSION', field: 'business_model', operator: 'contains', value: '终端工厂' },
      ]),
    );
    expect(dto.ruleLint).toHaveLength(1);
    expect(dto.ruleLint[0]).toContain('rule-1');
    expect(dto.ruleLint[0]).toContain('keywords');
  });

  it('非镜像的否定型 EXCLUSION → 一条提示（它在资格门已判 Fit 时仍然排除）', () => {
    const dto = IcpDto.from(row([{ kind: 'EXCLUSION', field: 'country', operator: 'not_in', value: ['DE', 'AT', 'CH'] }]));
    expect(dto.ruleLint).toHaveLength(1);
    expect(dto.ruleLint[0]).toContain('rule-0');
    expect(dto.ruleLint[0]).toContain('仍然排除');
  });

  it('无镜像 → 空数组（不是 undefined，契约稳定）', () => {
    const dto = IcpDto.from(row([{ kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['RU'] }]));
    expect(dto.ruleLint).toEqual([]);
    expect(IcpDto.from({ ...row([]), rules: undefined }).ruleLint).toEqual([]);
  });
});
