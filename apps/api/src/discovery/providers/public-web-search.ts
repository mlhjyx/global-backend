import type { SearxResult } from '../../adapters/searxng';
import {
  isTerminalExternalActionPolicyDenied,
  readToolFailureCost,
  type ExecutionBroker,
  type ToolContext,
} from '../../tools/tool-contract';
import type {
  GovernedWebSearchInput,
  GovernedWebSearchOutput,
} from '../../tools/web-search-tools';
import type { ProviderCallUsageBreakdown } from '../provider-contract';

export type PublicWebSearchToolId = 'searxng.search' | 'serper.search' | 'brave.search';

export interface PublicWebSearchResult {
  results: { title: string; url: string }[];
  costCents: number;
  usage: ProviderCallUsageBreakdown[];
}

const SELF_HOSTED: PublicWebSearchToolId = 'searxng.search';
const KNOWN_BACKENDS = new Set<PublicWebSearchToolId>([
  SELF_HOSTED,
  'serper.search',
  'brave.search',
]);

/**
 * Paid/quota-backed search is opt-in. Even when configured, the self-hosted
 * SearXNG backend remains first so an ordinary successful request consumes no
 * external quota.
 */
export function resolvePublicWebSearchBackends(value: string | undefined): PublicWebSearchToolId[] {
  const requested = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is PublicWebSearchToolId => KNOWN_BACKENDS.has(item as PublicWebSearchToolId));
  return [SELF_HOSTED, ...requested.filter((item) => item !== SELF_HOSTED)]
    .filter((item, index, all) => all.indexOf(item) === index);
}

interface SearchResultShape {
  title?: unknown;
  url?: unknown;
}

function normalizedResults(value: unknown): { title: string; url: string }[] {
  if (!value || typeof value !== 'object') return [];
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.slice(0, 20).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as SearchResultShape;
    if (typeof candidate.url !== 'string' || candidate.url.length === 0) return [];
    return [{
      title: typeof candidate.title === 'string' ? candidate.title : '',
      url: candidate.url,
    }];
  });
}

export async function invokePublicWebSearch(
  broker: ExecutionBroker,
  input: GovernedWebSearchInput,
  ctx: ToolContext,
  backends: readonly PublicWebSearchToolId[],
  onDegraded?: (toolId: PublicWebSearchToolId, error?: unknown) => void,
): Promise<PublicWebSearchResult> {
  let costCents = 0;
  const usage: ProviderCallUsageBreakdown[] = [];
  for (const toolId of backends) {
    try {
      const result = toolId === 'searxng.search'
        ? await broker.invoke<GovernedWebSearchInput, { results: SearxResult[] }>(toolId, input, ctx)
        : await broker.invoke<GovernedWebSearchInput, GovernedWebSearchOutput>(toolId, input, {
            ...ctx,
            purpose: 'discovery',
          });
      costCents += result.costCents;
      usage.push({
        phase: 'search',
        backend: toolId,
        callCount: 1,
        completedCount: 1,
        costCents: result.costCents,
      });
      const normalized = normalizedResults(result.data);
      if (normalized.length > 0) return { results: normalized, costCents, usage };
      onDegraded?.(toolId);
    } catch (error) {
      if (isTerminalExternalActionPolicyDenied(error)) throw error;
      const failureCostCents = readToolFailureCost(error)?.costCents ?? 0;
      costCents += failureCostCents;
      usage.push({
        phase: 'search',
        backend: toolId,
        callCount: 1,
        completedCount: 0,
        costCents: failureCostCents,
      });
      onDegraded?.(toolId, error);
    }
  }
  return { results: [], costCents, usage };
}
