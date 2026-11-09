import type { EmailVerificationProvider } from './email-verification-provider';
import { EmailableProvider, resolveEmailableConfig } from './emailable.provider';
import { MillionVerifierProvider, resolveMillionVerifierConfig } from './millionverifier.provider';

/**
 * 验证器池：按固定顺序返回**凭据已配置**的验证器（主验在前）。
 *
 * 顺序即瀑布顺序（计划 §2.3.5.1：MillionVerifier 粗筛 → Emailable 二次确认 →
 * ZeroBounce 仲裁留位）。data_provider/source_policy 的 kill switch 由调用方
 * （再验证 sweep / CLI / Schedule activity）逐家过 `checkProviderGates`，
 * 本函数只看凭据。缺凭据的验证器不进入列表——瀑布不会浪费一次调用去确认
 * 「provider_unconfigured」，单票 positive 也自然停在 UNKNOWN。
 */
export function resolveConfiguredVerificationProviders(
  env: NodeJS.ProcessEnv = process.env,
): EmailVerificationProvider[] {
  return [
    new MillionVerifierProvider(resolveMillionVerifierConfig(env)),
    new EmailableProvider(resolveEmailableConfig(env)),
  ].filter((provider) => provider.isConfigured());
}
