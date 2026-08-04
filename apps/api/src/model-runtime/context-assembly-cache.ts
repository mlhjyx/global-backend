import { createHash } from 'node:crypto';
import { stableSerialize, verifyContextEnvelope } from './context-engine';
import { deepFreeze, immutableClone } from './immutable';
import type { ContextEnvelope } from './types';

export interface ContextAssemblyCacheIdentity {
  workspaceId: string;
  sourceVersions: Readonly<Record<string, string>>;
  contextPolicyVersion: string;
  locale: string;
}

export interface ContextAssemblyCache {
  get(identity: ContextAssemblyCacheIdentity): Promise<ContextEnvelope | undefined>;
  put(identity: ContextAssemblyCacheIdentity, envelope: ContextEnvelope): Promise<void>;
}

export function contextAssemblyCacheKey(identity: ContextAssemblyCacheIdentity): string {
  if (!identity.workspaceId || !identity.contextPolicyVersion || !identity.locale) {
    throw new Error('context cache identity is incomplete');
  }
  return createHash('sha256').update(stableSerialize(identity)).digest('hex');
}

/**
 * Reference implementation. Production Redis/object-store adapters implement
 * the same exact-key contract; no cache lookup may omit the workspace id.
 */
export class InMemoryContextAssemblyCache implements ContextAssemblyCache {
  private readonly entries = new Map<string, ContextEnvelope>();

  async get(identity: ContextAssemblyCacheIdentity): Promise<ContextEnvelope | undefined> {
    const value = this.entries.get(contextAssemblyCacheKey(identity));
    return value === undefined ? undefined : deepFreeze(immutableClone(value));
  }

  async put(identity: ContextAssemblyCacheIdentity, envelope: ContextEnvelope): Promise<void> {
    if (identity.workspaceId !== envelope.workspaceId) {
      throw new Error('context cache workspace identity mismatch');
    }
    if (identity.contextPolicyVersion !== envelope.policyVersion) {
      throw new Error('context cache policy identity mismatch');
    }
    if (envelope.segments.some((segment) => segment.sensitivity === 'restricted')) {
      throw new Error('restricted context segments cannot enter the shared assembly cache');
    }
    verifyContextEnvelope(envelope);
    this.entries.set(
      contextAssemblyCacheKey(identity),
      deepFreeze(immutableClone(envelope)),
    );
  }
}
