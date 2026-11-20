import { governingPolicy, type RawSourcePolicySnapshot, type RawSourceDispositionCode } from './raw-source-ingestion';
import { sourcePolicyAllowsDiscovery } from './source-policy-scope';

/** Read-only raw admission before directory crawling; never grants a source exception. */
export function directorySourcePolicyDecision(
  sourceUrl: string,
  policies: readonly RawSourcePolicySnapshot[],
): Readonly<{ allowed: boolean; reasonCode?: RawSourceDispositionCode }> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return { allowed: false, reasonCode: 'INVALID_PROVENANCE' };
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    return { allowed: false, reasonCode: 'INVALID_PROVENANCE' };
  }
  const host = url.hostname.replace(/^www\./u, '');
  const policy = governingPolicy({ host, hostname: host }, 'directory', undefined, policies);
  if (!policy) return { allowed: false, reasonCode: 'SOURCE_POLICY_MISSING' };
  if (policy.reviewStatus !== 'APPROVED') return { allowed: false, reasonCode: 'SOURCE_POLICY_SUSPENDED' };
  if (!sourcePolicyAllowsDiscovery(policy.allowedPurpose)) {
    return { allowed: false, reasonCode: 'SOURCE_POLICY_PURPOSE_NOT_ALLOWED' };
  }
  return { allowed: true };
}

export function directorySourcePolicyCheck(policies: readonly RawSourcePolicySnapshot[]) {
  return (sourceUrl: string) => directorySourcePolicyDecision(sourceUrl, policies);
}
