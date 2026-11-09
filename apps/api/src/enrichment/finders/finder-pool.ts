import type { EmailEnrichmentAdapter } from './email-enrichment-provider';
import { ApolloProvider, resolveApolloConfig } from './apollo.provider';
import { FindymailProvider, resolveFindymailConfig } from './findymail.provider';
import { HunterProvider, resolveHunterConfig } from './hunter.provider';
import { PdlProvider, resolvePdlConfig } from './pdl.provider';
import { ProspeoProvider, resolveProspeoConfig } from './prospeo.provider';

/**
 * 富集器池：按固定顺序返回**凭据已配置**的 finder（瀑布顺序即计划 §2.3.4.1：
 * Hunter → Findymail → Prospeo 为主池；Apollo / PDL 是可选的**尾部署**（P1-09），
 * **只对 A 档公司追加**（评分 ≥80；由调用方按公司分档把 tail 拼到 base 之后），
 * 不对全量开启——两家单价最高（Apollo ≈$0.025、PDL ≈$0.28/record）。
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

/** 可选尾（Apollo → PDL）：调用方只对 A 档公司把它们追加到主池之后。 */
export function resolveConfiguredTailFinderProviders(
  env: NodeJS.ProcessEnv = process.env,
): EmailEnrichmentAdapter[] {
  return [
    new ApolloProvider(resolveApolloConfig(env)),
    new PdlProvider(resolvePdlConfig(env)),
  ].filter((provider) => provider.isConfigured());
}
