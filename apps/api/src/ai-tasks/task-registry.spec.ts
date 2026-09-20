import { describe, expect, it } from 'vitest';
import { getTask } from './task-registry';

describe('AI task registry personal-data boundaries', () => {
  it('keeps BrandProfile identity data in internal gaps while forbidding automatic public projection', () => {
    const description = getTask('site_builder.brand_profile')?.description;

    expect(description).toBeTruthy();
    expect(description).not.toContain('不输出任何具名个人');
    expect(description).toMatch(/gaps.*(?:姓名|身份).*(?:联系方式|联系信息).*内部/is);
    expect(description).toMatch(/(?:Claim|FactSheet|SiteSpec).*(?:不得|禁止).*自动公开/is);
  });

  it('keeps acquisition decision-maker extraction explicitly enabled', () => {
    const task = getTask('contact.find_decision_makers');
    const description = task?.description;

    expect(description).toMatch(/具名的人/);
    expect(description).toMatch(/人名.*职务.*邮箱.*电话/);
    expect(description).toMatch(/个人数据/);
    expect(
      (task?.outputSchema as {
        properties?: { people?: { maxItems?: number } };
      }).properties?.people?.maxItems,
    ).toBe(25);
  });
});

describe('AI task registry model execution policy invariants', () => {
  it('tightens only output contracts for the ten projected tasks', () => {
    const expected = {
      'company_understanding.extract_claims': {
        model: 'deepseek-v4-flash', risk: 'medium', humanGate: true,
        allowedTools: ['crawl4ai.fetch'], maxCostCents: 20, timeoutMs: 180000,
      },
      'company_understanding.extract_profile': {
        model: 'deepseek-v4-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 10, timeoutMs: 120000,
      },
      'company_understanding.extract_offerings': {
        model: 'deepseek-v4-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 20, timeoutMs: 180000,
      },
      'icp.design': {
        model: 'deepseek-v4-pro', risk: 'medium', humanGate: true,
        allowedTools: [], maxCostCents: 40, timeoutMs: 180000,
      },
      'discovery.query_plan': {
        model: 'deepseek-v4-pro', risk: 'low', humanGate: true,
        allowedTools: [], maxCostCents: 40, timeoutMs: 180000,
      },
      'taxonomy.normalize': {
        model: 'deepseek-v4-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 5, timeoutMs: 60000,
      },
      'discovery.qualify_fit': {
        model: 'deepseek-v4-pro', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 20, timeoutMs: 180000,
      },
      'discovery.extract_company': {
        model: 'deepseek-v4-flash', risk: 'low', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 15,
        timeoutMs: 180000,
      },
      'discovery.extract_list': {
        model: 'deepseek-v4-flash', risk: 'low', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 20,
        timeoutMs: 180000,
      },
      'contact.find_decision_makers': {
        model: 'deepseek-v4-flash', risk: 'medium', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 15,
        timeoutMs: 120000,
      },
    } as const;

    for (const [taskId, policy] of Object.entries(expected)) {
      const task = getTask(taskId);
      expect(task).toBeTruthy();
      expect({
        model: task!.model,
        risk: task!.risk,
        humanGate: task!.humanGate,
        allowedTools: task!.allowedTools ?? [],
        maxCostCents: task!.maxCostCents,
        timeoutMs: task!.timeoutMs,
      }).toEqual(policy);
      expect(task!.maxOutputTokens).toBeGreaterThan(0);
      expect(task!.maxOutputTokens).toBeLessThanOrEqual(16_000);
    }
  });
});
