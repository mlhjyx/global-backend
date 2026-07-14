import { describe, expect, it } from 'vitest';
import { resolveTaskRoute, SITE_BUILDER_TASK_IDS } from './task-routes';

/**
 * site_builder per-task 模型路由（09 §3 终版定档表的代码化，02 §6 唯一真值）。
 * 配置驱动：接入新通道后翻 env + 重启 worker 即切换，不改代码。
 */
describe('resolveTaskRoute — 终版定档默认值（09 §3）', () => {
  it('brand_profile：主选 deepseek-v4-pro，回退 glm-5.2', () => {
    const route = resolveTaskRoute('site_builder.brand_profile');
    expect(route.primary).toBe('deepseek-v4-pro');
    expect(route.fallbacks).toEqual(['glm-5.2']);
    expect(route.timeoutMs).toBeGreaterThan(0);
    expect(route.maxTokens).toBeGreaterThanOrEqual(4000); // v4 是 reasoning 模型，预算过小 content 为空（H2）
  });

  it('copy：deepseek-v4-pro + 🔴 reasoning_effort=low（评测实证：不压 effort 时延迟不可用）', () => {
    const route = resolveTaskRoute('site_builder.copy');
    expect(route.primary).toBe('deepseek-v4-pro');
    expect(route.reasoningEffort).toBe('low');
    expect(route.fallbacks).toEqual(['glm-5.2', 'doubao-seed-2.0-pro']);
  });

  it('assemble：glm-5.2 主选 + 180s 超时预算 + 回退 deepseek-v4-pro', () => {
    const route = resolveTaskRoute('site_builder.assemble');
    expect(route.primary).toBe('glm-5.2');
    expect(route.timeoutMs).toBe(180_000);
    expect(route.fallbacks).toContain('deepseek-v4-pro');
  });

  it('qa_summarize / seo_review：flash 快档', () => {
    expect(resolveTaskRoute('site_builder.qa_summarize').primary).toBe('deepseek-v4-flash');
    expect(resolveTaskRoute('site_builder.seo_review').primary).toBe('deepseek-v4-flash');
  });

  it('全部 task id 都能解析出完整路由（回归守卫：新增 task 忘配路由=测试红）', () => {
    for (const id of SITE_BUILDER_TASK_IDS) {
      const route = resolveTaskRoute(id);
      expect(route.primary).toBeTruthy();
      expect(Array.isArray(route.fallbacks)).toBe(true);
      expect(route.maxTokens).toBeGreaterThan(0);
      expect(route.timeoutMs).toBeGreaterThan(0);
    }
  });
});

describe('resolveTaskRoute — env 覆盖（通道接入后翻配置即切换，D-M1-2）', () => {
  it('SITE_BUILDER_MODEL_<TASK> 覆盖主选', () => {
    const route = resolveTaskRoute('site_builder.brand_profile', {
      SITE_BUILDER_MODEL_BRAND_PROFILE: 'gemini-3.1-pro',
    } as NodeJS.ProcessEnv);
    expect(route.primary).toBe('gemini-3.1-pro');
  });

  it('SITE_BUILDER_FALLBACKS_<TASK> 覆盖回退链（逗号分隔，空段剔除）', () => {
    const route = resolveTaskRoute('site_builder.copy', {
      SITE_BUILDER_FALLBACKS_COPY: 'glm-5.2, deepseek-v4-pro,,',
    } as NodeJS.ProcessEnv);
    expect(route.fallbacks).toEqual(['glm-5.2', 'deepseek-v4-pro']);
  });

  it('未知 task 抛错（fail-fast，不静默用错路由）', () => {
    expect(() => resolveTaskRoute('site_builder.nope' as never)).toThrow(/unknown site_builder task/);
  });
});
