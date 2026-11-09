import type { PrismaClient } from '@prisma/client';

/**
 * 付费第三方 provider 的通用前置门（验证器与 finder 同口径，P1-07/08）：
 *  1) `data_provider.<key>` 行存在且 ENABLED（kill switch；seed 默认 DISABLED）；
 *  2) `source_policy.<domain>` 已登记、未 SUSPENDED、允许 enrichment/discovery 用途。
 *
 * 未登记 = 未批准（fail-closed）；本函数只做读检查，不发请求。凭据检查由调用方
 * （provider 池的 isConfigured 过滤）负责——三处门都过才允许真实出网。
 */
export interface ProviderGateTarget {
  readonly key: string;
  /** 无协议头的 API 域名。 */
  readonly domain: string;
}

export async function checkProviderGates(
  prisma: PrismaClient,
  provider: ProviderGateTarget,
): Promise<{ ok: boolean; reason?: string }> {
  const dataProvider = await prisma.dataProvider.findUnique({
    where: { key: provider.key },
    select: { status: true },
  });
  if (!dataProvider || dataProvider.status !== 'ENABLED') {
    return {
      ok: false,
      reason: `data_provider.${provider.key} 未启用（kill switch）——先由运维翻 ENABLED`,
    };
  }
  const policy = await prisma.sourcePolicy.findUnique({
    where: { domain: provider.domain },
    select: { reviewStatus: true, allowedPurpose: true },
  });
  if (!policy) {
    return { ok: false, reason: `source_policy.${provider.domain} 未登记（未登记 = 未批准）` };
  }
  if (policy.reviewStatus === 'SUSPENDED') {
    return { ok: false, reason: `source_policy.${provider.domain} 已 SUSPENDED` };
  }
  const purposes = Array.isArray(policy.allowedPurpose) ? policy.allowedPurpose : [];
  if (purposes.length > 0 && !purposes.some((p) => p === 'enrichment' || p === 'discovery')) {
    return {
      ok: false,
      reason: `source_policy.${provider.domain} 用途门拒绝（allowedPurpose 不含 enrichment/discovery）`,
    };
  }
  return { ok: true };
}
