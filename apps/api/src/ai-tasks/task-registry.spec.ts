import { describe, expect, it } from 'vitest';
import {
  getTask,
  resolveDiscoveryFitMaxCostCents,
  resolveDiscoveryFitMaxPhysicalCalls,
  resolveDiscoveryFitMaxTokens,
  resolveDiscoveryFitModel,
} from './task-registry';

describe('AI task registry personal-data boundaries', () => {
  it('keeps BrandProfile identity data in internal gaps while forbidding automatic public projection', () => {
    const description = getTask('site_builder.brand_profile')?.description;

    expect(description).toBeTruthy();
    expect(description).not.toContain('不输出任何具名个人');
    expect(description).toMatch(/gaps.*(?:姓名|身份).*(?:联系方式|联系信息).*内部/is);
    expect(description).toMatch(/(?:Claim|FactSheet|SiteSpec).*(?:不得|禁止).*自动公开/is);
  });

  it('keeps acquisition decision-maker extraction explicitly enabled', () => {
    const description = getTask('contact.find_decision_makers')?.description;

    expect(description).toMatch(/具名的人/);
    expect(description).toMatch(/人名.*职务.*邮箱.*电话/);
    expect(description).toMatch(/个人数据/);
  });
});

describe('AI task registry acquisition model routing', () => {
  it('keeps AI company candidates as bounded hypotheses with no tool access or direct projection', () => {
    const task = getTask('discovery.propose_company_candidates');

    expect(task).toMatchObject({
      allowedTools: [],
      maxCostCents: 3,
      risk: 'medium',
      humanGate: false,
    });
    expect(task?.description).toMatch(/搜索假设/u);
    expect(task?.description).toMatch(/不是.*企业记录/u);
    expect(task?.description).toMatch(/不得直接进入身份.*Lead/u);
    expect(task?.description).toMatch(/官网.*独立验证/u);
    expect(task?.outputSchema.properties?.candidates?.maxItems).toBe(5);
  });

  it('teaches query planning only the enabled governed acquisition channels and their hard gates', () => {
    const task = getTask('discovery.query_plan');
    const description = task?.description ?? '';
    const filters = String(task?.outputSchema.properties?.queries?.items?.properties?.filters?.description ?? '');

    expect(description).toContain('world_bank_procurement');
    expect(description).toContain('uk_find_a_tender');
    expect(description).toContain('singapore_gebiz');
    expect(description).toMatch(/singapore_gebiz.*默认关闭/u);
    expect(description).toMatch(/singapore_gebiz.*当前不得选择/u);
    expect(description).toMatch(/brazil_pncp.*默认关闭/u);
    expect(description).toMatch(/uk_contracts_finder.*严格 buyer-only/u);
    expect(description).toMatch(/source_hint=uk_contracts_finder.*英国 country.*非空 keywords.*procurement_role=buyer/u);
    expect(description).not.toContain('uk_contracts_finder 默认关闭');
    expect(description).toMatch(/usaspending_awards.*已启用/u);
    expect(description).not.toContain('usaspending_awards 默认关闭');
    expect(description).toMatch(/usaspending_awards.*仅支持 procurement_role=buyer/u);
    expect(description).toMatch(/Recipient Name.*不得用于供应商/u);
    expect(filters).toMatch(/procurement_role.*supplier/u);
    expect(filters).toMatch(/source_hint.*uk_contracts_finder/u);
    expect(filters).toMatch(/uk_contracts_finder.*严格 buyer-only/u);
    expect(filters).toMatch(/source_hint=uk_contracts_finder.*英国 country.*非空 keywords.*procurement_role=buyer/u);
    expect(filters).toMatch(/usaspending_awards.*仅支持 buyer/u);
    expect(filters).toMatch(/usaspending_awards.*历史授标.*不得解释为当前商机/u);
    expect(filters).toContain('nppes');
    expect(filters).toMatch(/healthcare=true/u);
    expect(description).toMatch(/ror.*默认关闭.*不参加普通 fan-out/u);
    expect(description).toMatch(/source_hint=ror.*ISO-2 country.*一个官方 organization_types/u);
    expect(description).toMatch(/ROR 的 keywords 只能是组织名称或已知外部标识/u);
    expect(filters).toMatch(/source_hint=ror.*ISO-2 country.*恰好一个 organization_types/u);
    expect(description).toMatch(/sec_edgar.*默认关闭.*不参加普通 fan-out/u);
    expect(description).toMatch(/source_hint=sec_edgar.*精确 ticker.*精确规范名.*limit.*1\.\.5/u);
    expect(description).toMatch(/submissions.*已有.*目录.*CIK.*enrichment.*不得.*创建/u);
    expect(filters).toMatch(/source_hint=sec_edgar.*精确 ticker.*精确规范名.*limit.*1\.\.5/u);
  });

  it('keeps the reviewed DeepSeek route when no acquisition override is configured', () => {
    expect(resolveDiscoveryFitModel({})).toBe('deepseek-v4-pro');
  });

  it('allows the acquisition fit judge to use a purpose-scoped model alias', () => {
    expect(resolveDiscoveryFitModel({ DISCOVERY_FIT_MODEL: ' gemini-3.5-flash ' })).toBe(
      'gemini-3.5-flash',
    );
  });

  it('does not treat an empty override as a model alias', () => {
    expect(resolveDiscoveryFitModel({ DISCOVERY_FIT_MODEL: '   ' })).toBe('deepseek-v4-pro');
  });

  it('accepts a bounded acquisition fit output limit', () => {
    expect(resolveDiscoveryFitMaxTokens({ DISCOVERY_FIT_MAX_TOKENS: '512' })).toBe(512);
  });

  it('leaves the shared runtime default in place for absent or unsafe limits', () => {
    expect(resolveDiscoveryFitMaxTokens({})).toBeUndefined();
    expect(resolveDiscoveryFitMaxTokens({ DISCOVERY_FIT_MAX_TOKENS: '64' })).toBeUndefined();
    expect(resolveDiscoveryFitMaxTokens({ DISCOVERY_FIT_MAX_TOKENS: '4097' })).toBeUndefined();
  });

  it('accepts bounded fit cost and physical-call limits for a paid canary', () => {
    expect(resolveDiscoveryFitMaxCostCents({ DISCOVERY_FIT_MAX_COST_CENTS: '10' })).toBe(10);
    expect(resolveDiscoveryFitMaxPhysicalCalls({ DISCOVERY_FIT_MAX_PHYSICAL_CALLS: '1' })).toBe(1);
    expect(resolveDiscoveryFitMaxPhysicalCalls({ DISCOVERY_FIT_MAX_PHYSICAL_CALLS: '2' })).toBe(2);
  });

  it('rejects unsafe fit cost and physical-call overrides', () => {
    expect(resolveDiscoveryFitMaxCostCents({ DISCOVERY_FIT_MAX_COST_CENTS: '0' })).toBeUndefined();
    expect(resolveDiscoveryFitMaxCostCents({ DISCOVERY_FIT_MAX_COST_CENTS: '21' })).toBeUndefined();
    expect(resolveDiscoveryFitMaxPhysicalCalls({ DISCOVERY_FIT_MAX_PHYSICAL_CALLS: '3' })).toBeUndefined();
  });
});
