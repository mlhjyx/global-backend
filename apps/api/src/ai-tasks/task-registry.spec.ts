import { describe, expect, it } from 'vitest';
import { AI_TASKS, getTask } from './task-registry';

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
  it('tightens only output contracts for the twelve projected tasks', () => {
    const expected = {
      'company_understanding.extract_claims': {
        model: 'deepseek-flash', risk: 'medium', humanGate: true,
        allowedTools: ['crawl4ai.fetch'], maxCostCents: 20, timeoutMs: 180000,
      },
      'company_understanding.extract_profile': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 10, timeoutMs: 120000,
      },
      'company_understanding.extract_offerings': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 20, timeoutMs: 180000,
      },
      'icp.design': {
        model: 'deepseek-flash', risk: 'medium', humanGate: true,
        allowedTools: [], maxCostCents: 40, timeoutMs: 180000,
      },
      'discovery.query_plan': {
        model: 'deepseek-flash', risk: 'low', humanGate: true,
        allowedTools: [], maxCostCents: 40, timeoutMs: 180000,
      },
      'taxonomy.normalize': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 5, timeoutMs: 60000,
      },
      'discovery.qualify_fit': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: [], maxCostCents: 20, timeoutMs: 180000,
      },
      'discovery.extract_company': {
        // G3 5.3: discovery judges from search results only; no pre-identity fetch.
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: ['searxng.search'], maxCostCents: 15,
        timeoutMs: 180000,
      },
      'discovery.extract_list': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 20,
        timeoutMs: 180000,
      },
      'discovery.classify_trade_role': {
        // BI-14: the website profile also renders the company's linked contact page (form check).
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: ['crawl4ai.fetch', 'crawl4ai.render'], maxCostCents: 10, timeoutMs: 120000,
      },
      'contact.find_decision_makers': {
        model: 'deepseek-flash', risk: 'medium', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 15,
        timeoutMs: 120000,
      },
      // BI-15: drafts go to operators for review; never sent by the platform.
      'outreach.first_contact_draft': {
        model: 'deepseek-flash', risk: 'medium', humanGate: true,
        allowedTools: [], maxCostCents: 20, timeoutMs: 180000,
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

  it('leaves every reasoning-tier acquisition task room for its reasoning tokens', () => {
    // 2026-10-08: icp.design hit max_tokens=4096 twice in a row on xin and was
    // truncated, because the reasoning tokens count against the same cap.
    const reasoningTasks = [
      'company_understanding.extract_claims', 'company_understanding.extract_profile',
      'company_understanding.extract_offerings',
      'taxonomy.normalize', 'discovery.qualify_fit', 'discovery.extract_company',
      'discovery.extract_list', 'discovery.classify_trade_role', 'contact.find_decision_makers',
      'outreach.first_contact_draft',
    ];
    for (const taskId of reasoningTasks) {
      expect(getTask(taskId)?.model, taskId).toBe('deepseek-flash');
      expect(getTask(taskId)?.maxOutputTokens, taskId).toBe(8_192);
    }
  });

  it('gives the two planning tasks the provider ceiling of 16,000 output tokens', () => {
    // 2026-10-08: one query plan used 10,568 output tokens, the next was cut off at 8,192.
    for (const taskId of ['icp.design', 'discovery.query_plan']) {
      expect(getTask(taskId)?.model, taskId).toBe('deepseek-flash');
      expect(getTask(taskId)?.maxOutputTokens, taskId).toBe(16_000);
    }
  });
});

describe('AI task registry model substitution opt-in (D14, 2026-10-11)', () => {
  // Only these acquisition tasks may run on a deployment-approved substitute
  // model (MODEL_IDENTITY_SUBSTITUTES); every other task keeps exact identity.
  const ACQUISITION_TASKS = [
    'company_understanding.extract_claims',
    'company_understanding.extract_profile',
    'company_understanding.extract_offerings',
    'icp.design',
    'discovery.query_plan',
    'taxonomy.normalize',
    'discovery.qualify_fit',
    'discovery.extract_company',
    'discovery.extract_list',
    'discovery.classify_trade_role',
    'contact.find_decision_makers',
  ];

  it('marks exactly the acquisition tasks as accepting a substitute', () => {
    const marked = Object.values(AI_TASKS)
      .filter((task) => task.acceptsModelSubstitute === true)
      .map((task) => task.id)
      .sort();

    expect(marked).toEqual([...ACQUISITION_TASKS].sort());
  });

  it('keeps Site Builder on exact model identity', () => {
    expect(getTask('site_builder.brand_profile')?.acceptsModelSubstitute).toBeUndefined();
  });
});
