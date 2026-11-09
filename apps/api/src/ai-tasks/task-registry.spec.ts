import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_TASKS, getTask, parseTaskModelOverrides } from './task-registry';

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
        // A1: Impressum pages render to raw HTML for JSON-LD/cfemail (whitelisted tool).
        allowedTools: ['social.search', 'social.fetch', 'crawl4ai.fetch', 'http.get', 'crawl4ai.render'],
        maxCostCents: 15,
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
    'campaign.plan',
    'company_understanding.extract_claims',
    'company_understanding.extract_profile',
    'company_understanding.extract_offerings',
    'icp.design',
    'discovery.query_plan',
    'taxonomy.normalize',
    'discovery.qualify_fit',
    'discovery.quick_judge',
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


describe('acquisition per-task model overrides', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('parses the JSON map and drops non-string values', () => {
    expect(parseTaskModelOverrides('{"icp.design":"gpt-6.1-terra","bad":1,"list":["x"]}')).toEqual({
      'icp.design': 'gpt-6.1-terra',
    });
    expect(parseTaskModelOverrides('not json')).toEqual({});
    expect(parseTaskModelOverrides('[]')).toEqual({});
    expect(parseTaskModelOverrides(undefined)).toEqual({});
    expect(parseTaskModelOverrides('   ')).toEqual({});
  });

  it('applies overrides to listed tasks only, keeping tier defaults elsewhere', async () => {
    vi.resetModules();
    vi.stubEnv('MODEL_ACQUISITION_MODEL', 'gemini-3.8-flash');
    vi.stubEnv('MODEL_ACQUISITION_REASONING_MODEL', 'gpt-6.1-terra');
    vi.stubEnv(
      'MODEL_ACQUISITION_TASK_MODELS',
      '{"discovery.qualify_fit":"gemini-4-argon-high","taxonomy.normalize":"deepseek-flash"}',
    );

    const mod = await import('./task-registry');

    expect(mod.getTask('discovery.qualify_fit')?.model).toBe('gemini-4-argon-high');
    expect(mod.getTask('taxonomy.normalize')?.model).toBe('deepseek-flash');
    expect(mod.getTask('icp.design')?.model).toBe('gpt-6.1-terra');
    expect(mod.getTask('company_understanding.extract_claims')?.model).toBe('gemini-3.8-flash');
  });

  it('ignores a non-allowlisted override for the final-verdict judge (P3 J03)', async () => {
    vi.resetModules();
    vi.stubEnv('MODEL_ACQUISITION_REASONING_MODEL', 'gpt-5.6-sol');
    vi.stubEnv(
      'MODEL_ACQUISITION_TASK_MODELS',
      '{"discovery.qualify_fit":"gemini-3.8-flash"}',
    );

    const mod = await import('./task-registry');

    expect(mod.getTask('discovery.qualify_fit')?.model).toBe('gpt-5.6-sol');
    expect(mod.judgeModelOverrideRejections()).toEqual([
      {
        taskId: 'discovery.qualify_fit',
        requestedModel: 'gemini-3.8-flash',
        effectiveModel: 'gpt-5.6-sol',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      mod.enforceJudgeModelRouting({ mode: 'production' }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ignored MODEL_ACQUISITION_TASK_MODELS'),
    );
    warn.mockRestore();
  });

  it('honours the flash override for the judge only with JUDGE_ALLOW_FLASH=true', async () => {
    vi.resetModules();
    vi.stubEnv(
      'MODEL_ACQUISITION_TASK_MODELS',
      '{"discovery.qualify_fit":"gemini-3.8-flash"}',
    );
    vi.stubEnv('JUDGE_ALLOW_FLASH', 'true');

    const mod = await import('./task-registry');

    expect(mod.getTask('discovery.qualify_fit')?.model).toBe('gemini-3.8-flash');
    expect(mod.judgeModelOverrideRejections()).toEqual([]);
    expect(() =>
      mod.enforceJudgeModelRouting({ mode: 'production' }),
    ).not.toThrow();
  });

  it('startup self-check fails closed in controlled modes but only warns in dev/test', async () => {
    vi.resetModules();
    vi.stubEnv('MODEL_ACQUISITION_REASONING_MODEL', 'deepseek-flash');

    const mod = await import('./task-registry');

    expect(() =>
      mod.enforceJudgeModelRouting({ mode: 'production' }),
    ).toThrow(/JUDGE_MODEL_ALLOWLIST/);
    expect(() => mod.enforceJudgeModelRouting({ mode: 'pilot' })).toThrow(
      /JUDGE_MODEL_ALLOWLIST/,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() =>
      mod.enforceJudgeModelRouting({ mode: 'development' }),
    ).not.toThrow();
    expect(() => mod.enforceJudgeModelRouting({ mode: 'test' })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('allowed outside controlled modes'),
    );
    warn.mockRestore();
  });

  it('an invalid map leaves every task on its tier default', async () => {
    vi.resetModules();
    vi.stubEnv('MODEL_ACQUISITION_TASK_MODELS', '{oops');

    const mod = await import('./task-registry');

    expect(mod.getTask('icp.design')?.model).toBe('deepseek-flash');
    expect(mod.getTask('taxonomy.normalize')?.model).toBe('deepseek-flash');
  });
});

describe('A1：联系人发现的工具白名单', () => {
  it('contact.find_decision_makers 放行 crawl4ai.render（Impressum HTML 取数面）', () => {
    // 白名单缺 render 时，Broker 抛 ToolPolicyDenied 会被 isExecutionControlError 归为
    // control error → public_web 的 catch 不再回退而是 rethrow → 整次联系人发现失败（#748 同类）。
    expect(getTask('contact.find_decision_makers')?.allowedTools).toContain('crawl4ai.render');
  });
});
