import { createHash } from 'node:crypto';
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
        allowedTools: ['searxng.search'], maxCostCents: 3,
        timeoutMs: 180000,
      },
      'discovery.extract_list': {
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: ['searxng.search', 'crawl4ai.fetch'], maxCostCents: 5,
        timeoutMs: 180000,
      },
      'discovery.classify_trade_role': {
        // BI-14: the website profile also renders the company's linked contact page (form check).
        model: 'deepseek-flash', risk: 'low', humanGate: false,
        allowedTools: ['crawl4ai.fetch', 'crawl4ai.render'], maxCostCents: 3, timeoutMs: 120000,
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

  it('gives the planning and web-search confirmation tasks the provider ceiling of 16,000 output tokens', () => {
    // 2026-10-08: one query plan used 10,568 output tokens, the next was cut off at 8,192.
    // 2026-11-10 run 97a4fa1b: web_search_candidates 的结构确认在 8k 下 finish=length
    // 且 content 为空（STRUCTURED_OUTPUT_EMPTY_TRUNCATED），确认环节整段作废。
    for (const taskId of ['icp.design', 'discovery.query_plan', 'discovery.web_search_candidates']) {
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
    'discovery.web_search_candidates',
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

const B2_LEGACY_SCHEMA_BYTES = {
  "company_understanding.extract_claims": {
    "output": "cafe12f823aa2a21d9a0bdeec90940b2804ef7e7bfdb3247803dbc7ab9d3ae60",
    "contract": "d88ce9d1e40f283cb09d4beea61d3df40b58aa5fb6658511f139ae94d491545e"
  },
  "company_understanding.extract_profile": {
    "output": "1b817a35345ddee673026b290d28434a935b5fe05b2be9800171db2572f2aa26",
    "contract": "93193bc1d84139cd6507c043c553d85845ff97c0bcb55a0c9401a2b5725e86d6"
  },
  "company_understanding.extract_offerings": {
    "output": "04b585ca421d61bca3fc6b4859e312c024666d9501626d8816b707ce475d4e84",
    "contract": "f5120a2da87bfc61058ea3363ca7903093c2b45a0c5263b9e4b143bc09f0de7a"
  },
  "icp.design": {
    "output": "ff593e144ad6489deb896cf30cdb70cd0df04f8ce025b81469e0e0de97a1e780",
    "contract": "e3c01937eb30fd5dfb1a8649cf0556538df9486858242d395d8653a63e7a307c"
  },
  "discovery.extract_company": {
    "output": "e1e158cda13100c8c204668115faeb19416a4ba2dd2157989792a9b642133224",
    "contract": "530cd600fd50cbee25c1fa52533daafd3717e8f3778d507b670a8a8e5c4ac22e"
  },
  "discovery.classify_trade_role": {
    "output": "26c61256e97019ee6bdbecb76aededa991a5f8c100fa820c7d86e1c60ee134a3",
    "contract": "a6a888e005b90190ca8481aa0c1543348664cb9d411bbcd5f0092c4b8bd677bf"
  },
  "discovery.web_search_candidates": {
    "output": "3ba5f1c67e332287da4fe3ee36ee4556b9165c8c649300389f24076c10b6f189",
    "contract": "7ab23288e74a7afc0ee0efc22dbd2855f7f799aa88459b3afc9448b8ab038840"
  },
  "contact.find_decision_makers": {
    "output": "946b9114a0d3997f6cff641e19bf155421f1b856dbaefdc2fe9e55a506d61ec2",
    "contract": "f7aaf258fe812d6a2a1d6d28a6cf3cd7554ae132bf29c353a79e10be9e178c38"
  },
  "discovery.extract_list": {
    "output": "518011f7bbf4096c36a8891cbd2459196b9d2fae0fb2c65f62ed84e4f462fa8b",
    "contract": "20b4eff261885eb97aac4321255efaef215fdb9b825bd1ccb3e215e3a907346f"
  },
  "taxonomy.normalize": {
    "output": "3fd0aff6cb2f332c19683f4ae8c8f5ac1431cdf62ac77fe10cfce9e3c1c266fc",
    "contract": "67cb49254c66323d65315e19c6ef329d8e98efa46a6bd1f652348d5c864c6e0c"
  },
  "discovery.quick_judge": {
    "output": "2810eb6a2cbb3dcf259cde2bd350b3f5ce5a657e5724e912556659591c0892dd",
    "contract": "f5120a2da87bfc61058ea3363ca7903093c2b45a0c5263b9e4b143bc09f0de7a"
  },
  "discovery.qualify_fit": {
    "output": "a3d60c8d1a191a21b0d3d860c107b9e23ec5bbae1a2e8f3343876ace3fb9603b",
    "contract": "f5120a2da87bfc61058ea3363ca7903093c2b45a0c5263b9e4b143bc09f0de7a"
  },
  "discovery.query_plan": {
    "output": "a8c56837b774a67da67a0754028a96869578c8ce6e30aabe96e823fa03567e51",
    "contract": "f08c90ff93b67d8ef8562d1551e0fab33439c0f0ae1d78c083aabbe93ca43324"
  },
  "outreach.first_contact_draft": {
    "output": "7b876ebc0dfd05fe87b919e9b4aa2f75321cfb40338a228a8db65992765c81a2",
    "contract": "c10598a32044913bebf53dcfa47c0d299519e15b0b36f523054381beb172fb5c"
  },
  "outreach.sequence_draft": {
    "output": "87e6e65599231fe4d58751012a371f4f33b561ee7f501b5eb98a5353c73c7072",
    "contract": "c10598a32044913bebf53dcfa47c0d299519e15b0b36f523054381beb172fb5c"
  },
  "engage.reply_classify": {
    "output": "f1babd0b5a983836bdf41b647659fb6c77eb03580b3c468b046e2abf8069c13f",
    "contract": "6a3808e2be122801c3f995871747bff349ed91c341dd3a11926f12850f3f0941"
  },
  "campaign.plan": {
    "output": "9809a15c54c1102b7a15673a758686f938013eb7d9b75388b61dfce7129bd607",
    "contract": "c0e518033c55fa6c37939a664b2ed294279b37bffb35e1d10c272b4887ea9dcf"
  },
  "site_builder.brand_profile": {
    "output": "a2c799262a3ce3c19ef5cdd983bf3d12b43ab3c426227091b909dcb7054738c0",
    "contract": "82709e3808c7dff9dbf1d338cd83acb5332ff179331185dec750616cbe50b8cb"
  },
  "research.account_research": {
    "output": "2b8083bd4fa945d4684d2bdf215f7f06b8a7d2475bf62d299e78c8ac6f9e5b11",
    "contract": "1fbf6e32590409f7ac7f5978f5e84687b7f6d83adc6c0211ace2f962223b18c2"
  },
  "triage.lead_triage": {
    "output": "b2cc39702e3f1d8515bb4cdaf53c9bcf17f0a30bca8c6fbfdb02ba10161e0ab8",
    "contract": "2c8231382be0d9987626d8629366b377392eb5e92fc116e54a9477c74cbb693d"
  }
} as const;

describe('B2 exact legacy schema bytes and new generation task boundary', () => {
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  it.each(Object.entries(B2_LEGACY_SCHEMA_BYTES))('preserves the serialized legacy contract for %s', (id, expected) => {
    const task = getTask(id)!;
    expect(digest(task.outputSchema)).toBe(expected.output);
    expect(digest({ allowedTools: task.allowedTools, risk: task.risk, humanGate: task.humanGate,
      maxCostCents: task.maxCostCents, maxOutputTokens: task.maxOutputTokens, timeoutMs: task.timeoutMs,
      cacheable: task.cacheable })).toBe(expected.contract);
  });

  it('registers only bounded explicit generation without tools, hidden cache or a substitute-policy expansion', () => {
    const task = getTask('market.candidates.generate');
    expect(task).toMatchObject({ id: 'market.candidates.generate', allowedTools: [], maxCostCents: 40,
      maxOutputTokens: 16_000, timeoutMs: 180_000, risk: 'medium', humanGate: true });
    expect(task?.cacheable).not.toBe(true);
    expect(task?.acceptsModelSubstitute).toBeUndefined();
    expect(task?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'company', 'offerings', 'claims'],
      properties: { schemaVersion: { const: 'market-candidate-generation-input/v1' },
        offerings: { type: 'array', maxItems: 200 }, claims: { type: 'array', maxItems: 200 } } });
    expect(task?.outputSchema).toMatchObject({ type: 'object', additionalProperties: false,
      required: ['outcome', 'candidates'], properties: { outcome: { enum: ['CANDIDATES_PROPOSED', 'COMPLETED_EMPTY'] },
        candidates: { type: 'array', maxItems: 100 } } });
  });

  it('resolves the new generation task through the same existing reasoning-tier override mechanism', async () => {
    vi.resetModules();
    vi.stubEnv('MODEL_ACQUISITION_REASONING_MODEL', 'synthetic-reasoning-alias');
    vi.stubEnv('MODEL_ACQUISITION_TASK_MODELS', '{}');
    try {
      const current = await import('./task-registry');
      expect(current.getTask('market.candidates.generate')?.model).toBe('synthetic-reasoning-alias');
    } finally { vi.unstubAllEnvs(); vi.resetModules(); }
  });
});
