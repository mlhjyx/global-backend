import { describe, expect, it, vi } from 'vitest';
import {
  BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE,
  modelPolicyRegistry,
} from './model-policy.registry';
import { SITE_BUILDER_MODEL_PROFILES } from './model-profiles';
import { getSiteBuilderTaskRouteBinding } from './task-route-bindings';
import {
  resolveTaskExecutionTarget,
  resolveTaskRoute,
  SITE_BUILDER_DETERMINISTIC_TASK_IDS,
  SITE_BUILDER_GENERATIVE_TASK_IDS,
  SITE_BUILDER_TASK_IDS,
} from './task-routes';

/**
 * site_builder per-task 模型路由（09 §3 终版定档表的代码化，02 §6 唯一真值）。
 * 配置驱动：接入新通道后翻 env + 重启 worker 即切换，不改代码。
 */
describe('resolveTaskRoute — 逐任务生产策略', () => {
  it('brand_profile：MODEL-1 晋级 Terra，Sonnet 原生协议回退，复杂结构化修复有 240s 单模型预算', () => {
    const route = resolveTaskRoute('site_builder.brand_profile');
    expect(route.primary).toBe('gpt-5.6-terra');
    expect(route.fallbacks).toEqual(['claude-sonnet-5']);
    expect(route.timeoutMs).toBe(240_000);
    expect(route.maxTokens).toBeGreaterThanOrEqual(4000); // v4 是 reasoning 模型，预算过小 content 为空（H2）
    expect(route.maxCostCents).toBe(40);
    expect(route.dataPolicy).toEqual({
      transport: 'new_api_only',
      region: 'gateway_controlled',
      personalData: 'workspace_controlled',
      dataScope: 'workspace_site_materials',
    });
    expect(route.policy).toMatchObject({
      policyVersion: 'site-builder-model-policy/v3',
      routeState: 'promotedRoute',
      lifecycle: 'active',
      source: 'registry',
      promotionEvidenceId: 'model1-brand-profile-20260719-v20',
    });
  });

  it('copy：已采用 Sonnet Messages/medium；旧 DeepSeek low 只在显式 rollback 生效', () => {
    const route = resolveTaskRoute('site_builder.copy');
    expect(route.primary).toBe('claude-sonnet-5');
    expect(route.reasoningEffort).toBe('medium');
    expect(route.fallbacks).toEqual([]);
    expect(route.policy).toMatchObject({
      routeState: 'promotedRoute',
      promotionEvidenceId:
        'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
    });
  });

  it('only BrandProfile and Copy remain generative while the other five task IDs stay deterministic', () => {
    expect(SITE_BUILDER_TASK_IDS).toHaveLength(7);
    expect(SITE_BUILDER_GENERATIVE_TASK_IDS).toEqual([
      'site_builder.brand_profile',
      'site_builder.copy',
    ]);
    expect(SITE_BUILDER_DETERMINISTIC_TASK_IDS).toEqual([
      'site_builder.design_spec',
      'site_builder.assemble',
      'site_builder.assembly_fix',
      'site_builder.qa_summarize',
      'site_builder.seo_review',
    ]);
    for (const taskId of SITE_BUILDER_DETERMINISTIC_TASK_IDS) {
      expect(getSiteBuilderTaskRouteBinding(taskId).executionMode).toBe(
        'deterministic',
      );
      expect(resolveTaskExecutionTarget(taskId)).toMatchObject({
        kind: 'deterministic_fallback',
        taskId,
      });
      expect(() => resolveTaskRoute(taskId)).toThrow(
        /must execute deterministic fallback/,
      );
      const suffix = taskId.split('.')[1].toUpperCase();
      expect(() =>
        resolveTaskExecutionTarget(taskId, {
          [`SITE_BUILDER_MODEL_${suffix}`]: 'operator-bypass',
        } as NodeJS.ProcessEnv),
      ).toThrow(/does not accept a model override/);
    }
    for (const taskId of SITE_BUILDER_GENERATIVE_TASK_IDS) {
      expect(getSiteBuilderTaskRouteBinding(taskId).executionMode).toBe(
        'generative',
      );
      expect(resolveTaskExecutionTarget(taskId).kind).toBe('model_route');
    }
  });

  it('全部 task id 都有完整 model 或 deterministic execution target', () => {
    const deterministicFallbacks = {
      'site_builder.design_spec': 'safe-blueprint',
      'site_builder.assemble': 'safe-blueprint',
      'site_builder.assembly_fix': 'safe-blueprint',
      'site_builder.qa_summarize': 'rule-summary',
      'site_builder.seo_review': 'rule-summary',
    } as const;
    for (const id of SITE_BUILDER_TASK_IDS) {
      const target = resolveTaskExecutionTarget(id);
      if (target.kind === 'deterministic_fallback') {
        expect(target.fallback.id).toBe(
          deterministicFallbacks[id as keyof typeof deterministicFallbacks],
        );
        expect(target.source).toBe('registry_deterministic');
        expect(target.policyVersion).toBe('site-builder-model-policy/v3');
        continue;
      }
      const route = target.route;
      expect(route.primary).toBeTruthy();
      expect(Array.isArray(route.fallbacks)).toBe(true);
      expect(route.maxTokens).toBeGreaterThan(0);
      expect(route.timeoutMs).toBeGreaterThan(0);
      expect(route.maxCostCents).toBeGreaterThan(0);
      expect(route.policy.route).toEqual({
        primary: route.primary,
        fallbacks: route.fallbacks,
      });
    }
  });
});

describe('resolveTaskRoute — env 覆盖（通道接入后翻配置即切换，D-M1-2）', () => {
  it('SITE_BUILDER_MODEL_<TASK> 覆盖主选', () => {
    const route = resolveTaskRoute('site_builder.brand_profile', {
      SITE_BUILDER_MODEL_BRAND_PROFILE: 'gemini-3.1-pro',
    } as NodeJS.ProcessEnv);
    expect(route.primary).toBe('gemini-3.1-pro');
    expect(route.policy).toMatchObject({
      routeState: 'currentRoute',
      source: 'env_override',
      route: {
        primary: 'gemini-3.1-pro',
        fallbacks: ['claude-sonnet-5'],
      },
    });
    expect(route.policy).not.toHaveProperty('promotionEvidenceId');
  });

  it('promoted task 的 fallback 紧急覆盖不能继承晋级证据', () => {
    const route = resolveTaskRoute('site_builder.brand_profile', {
      SITE_BUILDER_FALLBACKS_BRAND_PROFILE: 'operator-fallback',
    } as NodeJS.ProcessEnv);
    expect(route.policy).toMatchObject({
      profile: 'structured.workspace_materials',
      routeState: 'currentRoute',
      source: 'env_override',
      route: {
        primary: 'gpt-5.6-terra',
        fallbacks: ['operator-fallback'],
      },
    });
    expect(route.policy).not.toHaveProperty('promotionEvidenceId');
  });

  it('SITE_BUILDER_FALLBACKS_<TASK> 覆盖回退链（逗号分隔，空段剔除）', () => {
    const route = resolveTaskRoute('site_builder.copy', {
      SITE_BUILDER_FALLBACKS_COPY: 'glm-5.2, deepseek-v4-pro,,',
    } as NodeJS.ProcessEnv);
    expect(route.fallbacks).toEqual(['glm-5.2', 'deepseek-v4-pro']);
  });

  it('退役 alias 不能经环境覆盖重新进入运行时', () => {
    expect(() =>
      resolveTaskRoute('site_builder.copy', {
        SITE_BUILDER_FALLBACKS_COPY: 'doubao-seed-2.0-pro',
      } as NodeJS.ProcessEnv),
    ).toThrow(/RETIRED_ALIAS_RUNTIME_FORBIDDEN/);
  });

  it('SITE_BUILDER_PROFILE_<TASK> 不能改写任务能力与数据政策', () => {
    expect(() =>
      resolveTaskRoute('site_builder.brand_profile', {
        SITE_BUILDER_PROFILE_BRAND_PROFILE: 'reasoning.high',
      } as NodeJS.ProcessEnv),
    ).toThrow(/profile override.*not supported/i);
    expect(() =>
      resolveTaskRoute('site_builder.copy', {
        SITE_BUILDER_PROFILE_COPY: 'text.bulk',
      } as NodeJS.ProcessEnv),
    ).toThrow(/profile override.*not supported/i);
  });

  it('SITE_BUILDER_MODEL_ROLLBACK_<TASK>=true 执行独立 rollback policy', () => {
    const route = resolveTaskRoute('site_builder.brand_profile', {
      SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE: 'true',
    } as NodeJS.ProcessEnv);
    expect(route.primary).toBe('deepseek-v4-pro');
    expect(route.fallbacks).toEqual(['glm-5.2']);
    expect(route.policy).toMatchObject({
      routeState: 'currentRoute',
      lifecycle: 'active',
      source: 'rollback_override',
      rollbackPolicyVersion: 'site-builder-model-rollback-policy/v1',
      route: {
        primary: 'deepseek-v4-pro',
        fallbacks: ['glm-5.2'],
      },
    });
    expect(route.policy).not.toHaveProperty('promotionEvidenceId');
  });

  it('紧急 model/fallback 覆盖优先于 rollback，trace 仍记录实际快照', () => {
    const route = resolveTaskRoute('site_builder.brand_profile', {
      SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE: 'true',
      SITE_BUILDER_MODEL_BRAND_PROFILE: 'operator-primary',
      SITE_BUILDER_FALLBACKS_BRAND_PROFILE: 'operator-fallback',
    } as NodeJS.ProcessEnv);
    expect(route.primary).toBe('operator-primary');
    expect(route.fallbacks).toEqual(['operator-fallback']);
    expect(route.policy).toMatchObject({
      routeState: 'currentRoute',
      source: 'env_override',
      route: {
        primary: 'operator-primary',
        fallbacks: ['operator-fallback'],
      },
    });
  });

  it('rollback 值非法或用于尚未晋级的 task 时 fail-fast', () => {
    expect(() =>
      resolveTaskRoute('site_builder.brand_profile', {
        SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE: 'yes',
      } as NodeJS.ProcessEnv),
    ).toThrow(/must be true or false/);
    expect(() =>
      resolveTaskRoute('site_builder.design_spec', {
        SITE_BUILDER_MODEL_ROLLBACK_DESIGN_SPEC: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/has no promoted route/);
  });

  it('晋级后的 design_spec rollback 由运行决策携带 safe-blueprint，不再解析成模型错误', () => {
    const original =
      modelPolicyRegistry.getActiveTaskPolicy.bind(modelPolicyRegistry);
    const policy = vi
      .spyOn(modelPolicyRegistry, 'getActiveTaskPolicy')
      .mockImplementation((taskId) =>
        taskId === 'site_builder.design_spec'
          ? {
              state: 'promotedRoute',
              lifecycle: 'active',
              route: {
                primary: 'candidate-primary',
                fallbacks: ['candidate-fallback'],
              },
              promotionEvidenceId: 'test-design-spec-promotion',
            }
          : original(taskId),
      );
    try {
      expect(
        resolveTaskExecutionTarget('site_builder.design_spec', {
          SITE_BUILDER_MODEL_ROLLBACK_DESIGN_SPEC: 'true',
        } as NodeJS.ProcessEnv),
      ).toEqual({
        kind: 'deterministic_fallback',
        taskId: 'site_builder.design_spec',
        profile: 'structured.default',
        fallback: expect.objectContaining({ id: 'safe-blueprint' }),
        source: 'rollback_override',
        rollbackPolicyVersion: 'site-builder-model-rollback-policy/v1',
      });
    } finally {
      policy.mockRestore();
    }
  });

  it('未知 SITE_BUILDER_PROFILE_<TASK> 同样 fail-fast，绝不静默忽略', () => {
    expect(() =>
      resolveTaskRoute('site_builder.copy', {
        SITE_BUILDER_PROFILE_COPY: 'typo.profile',
      } as NodeJS.ProcessEnv),
    ).toThrow(/profile override.*not supported/i);
  });

  it('未知 task 抛错（fail-fast，不静默用错路由）', () => {
    expect(() => resolveTaskRoute('site_builder.nope' as never)).toThrow(
      /unknown site_builder task/,
    );
  });
});

describe('MODEL-0 profile binding and MODEL-1 per-task promotion isolation', () => {
  it('任务只绑定语义 profile；仅 BrandProfile 晋级，其他任务保持 pre-MODEL-0 行为', () => {
    expect(resolveTaskRoute('site_builder.brand_profile').profile).toBe(
      'structured.workspace_materials',
    );
    expect(resolveTaskRoute('site_builder.copy').profile).toBe('copy.premium');
    expect(
      resolveTaskExecutionTarget('site_builder.qa_summarize'),
    ).toMatchObject({
      kind: 'deterministic_fallback',
      profile: 'text.summary',
    });
    expect(
      modelPolicyRegistry.getActiveTaskPolicy('site_builder.design_spec'),
    ).toMatchObject({
      state: 'deterministicFallback',
      fallback: { id: 'safe-blueprint' },
    });
    expect(
      modelPolicyRegistry.getActiveTaskPolicy('site_builder.brand_profile'),
    ).toMatchObject({
      state: 'promotedRoute',
      promotionEvidenceId: 'model1-brand-profile-20260719-v20',
    });
  });

  it('active target removes retired aliases without silently promoting candidates', () => {
    expect(
      Object.fromEntries(
        SITE_BUILDER_TASK_IDS.map((taskId) => [
          taskId,
          modelPolicyRegistry.getActiveTaskPolicy(taskId),
        ]),
      ),
    ).toMatchObject({
      'site_builder.copy': {
        state: 'promotedRoute',
        route: { primary: 'claude-sonnet-5', fallbacks: [] },
        promotionEvidenceId:
          'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
      },
      'site_builder.design_spec': {
        state: 'deterministicFallback',
        fallback: { id: 'safe-blueprint' },
      },
      'site_builder.assemble': {
        state: 'deterministicFallback',
        fallback: { id: 'safe-blueprint' },
      },
      'site_builder.assembly_fix': {
        state: 'deterministicFallback',
        fallback: { id: 'safe-blueprint' },
      },
      'site_builder.qa_summarize': {
        state: 'deterministicFallback',
        fallback: { id: 'rule-summary' },
      },
      'site_builder.seo_review': {
        state: 'deterministicFallback',
        fallback: { id: 'rule-summary' },
      },
    });
    expect(() =>
      modelPolicyRegistry.resolveActiveTaskRoute('site_builder.design_spec'),
    ).toThrow(/deterministic fallback/);
  });

  it('历史路由与可执行 rollback 分离，MiniMax/Doubao 不进入 rollback target', () => {
    expect(modelPolicyRegistry.getRollbackPolicyVersion()).toBe(
      'site-builder-model-rollback-policy/v1',
    );
    expect(
      Object.fromEntries(
        SITE_BUILDER_TASK_IDS.map((taskId) => [
          taskId,
          modelPolicyRegistry.getExecutableRollbackPolicy(taskId),
        ]),
      ),
    ).toEqual({
      'site_builder.brand_profile': {
        kind: 'model_route',
        route: {
          primary: 'deepseek-v4-pro',
          fallbacks: ['glm-5.2'],
        },
      },
      'site_builder.copy': {
        kind: 'model_route',
        route: {
          primary: 'deepseek-v4-pro',
          fallbacks: ['glm-5.2'],
        },
      },
      'site_builder.design_spec': {
        kind: 'deterministic_fallback',
        fallback: expect.objectContaining({ id: 'safe-blueprint' }),
      },
      'site_builder.assemble': {
        kind: 'deterministic_fallback',
        fallback: expect.objectContaining({ id: 'safe-blueprint' }),
      },
      'site_builder.assembly_fix': {
        kind: 'deterministic_fallback',
        fallback: expect.objectContaining({ id: 'safe-blueprint' }),
      },
      'site_builder.qa_summarize': {
        kind: 'deterministic_fallback',
        fallback: expect.objectContaining({ id: 'rule-summary' }),
      },
      'site_builder.seo_review': {
        kind: 'deterministic_fallback',
        fallback: expect.objectContaining({ id: 'rule-summary' }),
      },
    });
    for (const alias of [
      'minimax-m3',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
    ]) {
      expect(modelPolicyRegistry.getAliasRetirementPolicy(alias)).toMatchObject(
        {
          decision: 'pending_retirement',
        },
      );
    }
    expect(
      modelPolicyRegistry.getAliasRetirementPolicy('constructor'),
    ).toBeNull();
    expect(modelPolicyRegistry.getAliasRetirementPolicy('toString')).toBeNull();
  });

  it('评测 comparator 只从可执行模型 rollback 派生，确定性任务不接纳付费 legacy', () => {
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute('site_builder.copy'),
    ).toEqual({
      primary: 'deepseek-v4-pro',
      fallbacks: ['glm-5.2'],
    });
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute(
        'site_builder.design_spec',
      ),
    ).toBeNull();
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute('site_builder.assemble'),
    ).toBeNull();
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute(
        'site_builder.assembly_fix',
      ),
    ).toBeNull();
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute(
        'site_builder.qa_summarize',
      ),
    ).toBeNull();
    expect(
      modelPolicyRegistry.getEvaluationComparatorRoute(
        'site_builder.seo_review',
      ),
    ).toBeNull();
  });

  it('BrandProfile promotion evidence 冻结候选、现役基线、协议与价格快照', () => {
    expect(BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE).toMatchObject({
      id: 'model1-brand-profile-20260719-v20',
      reportSha256:
        '76f30d38dc958e777b036a29f430963d185399b761e7de5d63f7189b303bad60',
      currentRouteBaseline: {
        route: {
          primary: 'deepseek-v4-pro',
          fallbacks: ['glm-5.2'],
        },
        model: 'deepseek-v4-pro',
        acceptedArtifacts: 12,
        hardFailures: 0,
        fallbackRuns: 0,
        attemptedCostUsd: 0.06435825,
        acceptedArtifactUnitCostUsd: 0.0053631875,
        reportSha256:
          '3aa408b68978779b4a81f3696f68c761adca453e5fafa9d513bf128d41b2d69b',
      },
      pricing: {
        rates: {
          'gpt-5.6-terra': { input: 0.25, output: 1.5 },
          'claude-sonnet-5': { input: 0.54, output: 2.7 },
          'deepseek-v4-pro': { input: 0.435, output: 0.87 },
        },
      },
    });
    expect(BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.routes).toEqual([
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        transport: 'openai-responses',
        acceptedArtifacts: 12,
        hardFailures: 0,
      }),
      expect.objectContaining({
        model: 'claude-sonnet-5',
        transport: 'anthropic-messages',
        acceptedArtifacts: 12,
        hardFailures: 0,
      }),
    ]);
    expect(Object.isFrozen(BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE)).toBe(true);
    expect(
      Object.isFrozen(BRAND_PROFILE_MODEL1_PROMOTION_EVIDENCE.pricing.rates),
    ).toBe(true);
  });

  it('18 个稳定 profile 都有能力、数据处理声明；未接入的语音/视频/审核档 fail-closed', () => {
    expect(Object.keys(SITE_BUILDER_MODEL_PROFILES)).toHaveLength(18);
    for (const profile of [
      'video.premium',
      'speech.production',
      'transcription',
      'moderation.media',
    ] as const) {
      expect(
        SITE_BUILDER_MODEL_PROFILES[profile].requiredCapabilities,
      ).not.toHaveLength(0);
      expect(modelPolicyRegistry.getCandidates(profile)).toEqual([]);
    }
    expect(
      modelPolicyRegistry.getProfile('text.summary').requiredCapabilities,
    ).toContain('structured_output');
    expect(modelPolicyRegistry.getProfile('text.summary').dataPolicy).toEqual({
      transport: 'new_api_only',
      region: 'gateway_controlled',
      personalData: 'forbidden',
      dataScope: 'company_facts_only',
    });
    expect(
      modelPolicyRegistry.getProfile('structured.default').dataPolicy,
    ).toEqual({
      transport: 'new_api_only',
      region: 'gateway_controlled',
      personalData: 'forbidden',
      dataScope: 'company_facts_only',
    });
    expect(
      modelPolicyRegistry.getProfile('structured.workspace_materials')
        .dataPolicy,
    ).toEqual({
      transport: 'new_api_only',
      region: 'gateway_controlled',
      personalData: 'workspace_controlled',
      dataScope: 'workspace_site_materials',
    });
    expect(
      modelPolicyRegistry.getProfile('embedding.private').dataPolicy.region,
    ).toBe('private_local');
  });

  it('candidate baseline targets remain registry-only；只有有 task 证据的 BrandProfile 可晋级', () => {
    const target = modelPolicyRegistry.getCandidates('structured.default');
    expect(target).toContainEqual(
      expect.objectContaining({
        state: 'targetCandidate',
        route: { primary: 'gpt-5.6-terra', fallbacks: [] },
        activation: 'requires_task_evaluation',
      }),
    );
    expect(
      modelPolicyRegistry.getCandidates('structured.workspace_materials'),
    ).toContainEqual(
      expect.objectContaining({
        state: 'targetCandidate',
        route: { primary: 'gpt-5.6-terra', fallbacks: [] },
        activation: 'requires_task_evaluation',
      }),
    );
    expect(resolveTaskRoute('site_builder.brand_profile').primary).toBe(
      'gpt-5.6-terra',
    );
    expect(
      resolveTaskExecutionTarget('site_builder.design_spec'),
    ).toMatchObject({
      kind: 'deterministic_fallback',
      fallback: { id: 'safe-blueprint' },
    });
  });

  it('bounds multimodal review to controlled workspace site material without activating a task route', () => {
    expect(
      modelPolicyRegistry.getProfile('multimodal.review').dataPolicy,
    ).toEqual({
      transport: 'new_api_only',
      region: 'gateway_controlled',
      personalData: 'workspace_controlled',
      dataScope: 'workspace_site_materials',
    });
    expect(SITE_BUILDER_TASK_IDS).not.toContain(
      'site_builder.aesthetic_review',
    );
  });

  it('media candidates require a real MediaGateway and have no current task route', () => {
    for (const profile of [
      'image.bulk.creative',
      'image.premium.design',
      'image.precise_edit',
      'video.primary',
    ] as const) {
      expect(modelPolicyRegistry.getCandidates(profile)).not.toHaveLength(0);
      expect(modelPolicyRegistry.getCandidates(profile)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: 'targetCandidate',
            activation: 'requires_media_gateway',
          }),
        ]),
      );
    }
  });

  it('returns defensive copies, so callers cannot mutate the registered policy', () => {
    const current = modelPolicyRegistry.resolveActiveTaskRoute(
      'site_builder.brand_profile',
    );
    (current.fallbacks as string[]).push('not-a-policy-model');
    expect(
      modelPolicyRegistry.resolveActiveTaskRoute('site_builder.brand_profile')
        .fallbacks,
    ).toEqual(['claude-sonnet-5']);

    const candidates = modelPolicyRegistry.getCandidates('structured.default');
    (candidates[0].route.fallbacks as string[]).push('not-a-policy-model');
    expect(
      modelPolicyRegistry.getCandidates('structured.default')[0].route
        .fallbacks,
    ).toEqual([]);

    const profile = modelPolicyRegistry.getProfile('structured.default');
    (profile.requiredCapabilities as string[]).push('not-a-capability');
    expect(
      modelPolicyRegistry.getProfile('structured.default').requiredCapabilities,
    ).toEqual(['text_generation', 'structured_output']);
  });

  it('freezes exported profile definitions at runtime, including nested constraints', () => {
    const profile = SITE_BUILDER_MODEL_PROFILES['structured.default'];
    expect(Object.isFrozen(SITE_BUILDER_MODEL_PROFILES)).toBe(true);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(profile.dataPolicy)).toBe(true);
    expect(() =>
      (profile.requiredCapabilities as string[]).push('reasoning'),
    ).toThrow(TypeError);
  });
});
