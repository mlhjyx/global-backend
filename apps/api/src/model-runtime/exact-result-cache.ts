import { createHash } from 'node:crypto';
import { stableSerialize } from './context-engine';
import { deepFreeze, immutableClone } from './immutable';
import type { ExactResultCache, ExactResultCacheEntry, ExactResultCacheIdentity } from './types';

export function exactResultCacheKey(identity: ExactResultCacheIdentity): string {
  return createHash('sha256').update(stableSerialize(identity)).digest('hex');
}

export class InMemoryExactResultCache implements ExactResultCache {
  private readonly entries = new Map<string, ExactResultCacheEntry>();
  private readonly repairAliases = new Map<string, string>();

  async get<Output>(identity: ExactResultCacheIdentity): Promise<ExactResultCacheEntry<Output> | undefined> {
    const identityKey = exactResultCacheKey(identity);
    const resultKey = this.repairAliases.get(identityKey) ?? identityKey;
    return this.entries.get(resultKey) as ExactResultCacheEntry<Output> | undefined;
  }

  async put<Output>(identity: ExactResultCacheIdentity, entry: ExactResultCacheEntry<Output>): Promise<void> {
    if (entry.settlement !== 'known') throw new Error('unknown settlement results cannot enter the exact result cache');
    if (!entry.validated) throw new Error('only validated results can enter the exact result cache');
    stableSerialize(entry.output);
    const identityKey = exactResultCacheKey(identity);
    this.repairAliases.delete(identityKey);
    this.entries.set(identityKey, deepFreeze({
      ...entry,
      output: immutableClone(entry.output),
    }));
  }

  async putRepair<Output>(
    originalIdentity: ExactResultCacheIdentity,
    repairIdentity: ExactResultCacheIdentity,
    entry: ExactResultCacheEntry<Output>,
  ): Promise<void> {
    if (!repairIdentity.priorOutputDigest || !repairIdentity.findingsDigest) {
      throw new Error('repair cache identity must bind prior output and findings digests');
    }
    await this.put(repairIdentity, entry);
    this.repairAliases.set(exactResultCacheKey(originalIdentity), exactResultCacheKey(repairIdentity));
  }
}
