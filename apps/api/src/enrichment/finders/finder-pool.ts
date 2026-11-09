import type { EmailEnrichmentAdapter } from './email-enrichment-provider';
import { FindymailProvider, resolveFindymailConfig } from './findymail.provider';
import { HunterProvider, resolveHunterConfig } from './hunter.provider';
import { ProspeoProvider, resolveProspeoConfig } from './prospeo.provider';

/**
 * 富集器池：按固定顺序返回**凭据已配置**的 finder（瀑布顺序即计划 §2.3.4.1：
 * Hunter → Findymail → Prospeo；Apollo/PDL 属于 P1-09 的可选尾，入池前单独评估）。
 *
 * data_provider / source_policy 的 kill switch 由编排层（P1-08 富集瀑布）逐家过门，
 * 本函数只看凭据——缺凭据的 finder 不进入列表，瀑布不会浪费一次调用去确认
 * `provider_unconfigured`，也不会把「没配 key」误记成 miss 拉低 scorecard。
 */
export function resolveConfiguredFinderProviders(
  env: NodeJS.ProcessEnv = process.env,
): EmailEnrichmentAdapter[] {
  return [
    new HunterProvider(resolveHunterConfig(env)),
    new FindymailProvider(resolveFindymailConfig(env)),
    new ProspeoProvider(resolveProspeoConfig(env)),
  ].filter((provider) => provider.isConfigured());
}
