import { createHash } from 'node:crypto';
import type { ContextEnvelope, ContextPolicy, ContextSegment, ContextSegmentKind } from './types';
import { deepFreeze, immutableClone } from './immutable';

const KIND_ORDER: Readonly<Record<ContextSegmentKind, number>> = Object.freeze({
  policy: 0,
  schema: 1,
  examples: 2,
  facts: 3,
  brand: 4,
  request: 5,
  repair: 6,
});
const REQUIRED_KINDS = new Set<ContextSegmentKind>(['policy', 'schema', 'request', 'repair']);

export function stableSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('context contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('context contains a non-plain object');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((itemKey) => `${JSON.stringify(itemKey)}:${stableSerialize(record[itemKey])}`).join(',')}}`;
  }
  throw new Error(`context contains unsupported value type: ${typeof value}`);
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function ordered(segments: readonly ContextSegment[]): ContextSegment[] {
  return [...segments].sort((left, right) =>
    KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || compareText(left.sourceRef, right.sourceRef)
      || compareText(left.sourceDigest, right.sourceDigest),
  );
}

interface AssembleContextInput {
  workspaceId: string;
  policy: ContextPolicy;
  segments: readonly ContextSegment[];
  budget: { contextWindow: number; outputReserve: number; reasoningReserve: number };
}

export class ContextEngine {
  assemble(input: AssembleContextInput): ContextEnvelope {
    const allowed = new Set(input.policy.allowedSourceRefs);
    for (const [name, value] of Object.entries(input.budget)) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid context budget: ${name}`);
    }
    const available = input.budget.contextWindow - input.budget.outputReserve - input.budget.reasoningReserve;
    if (!input.workspaceId) throw new Error('context workspaceId is required');
    if (available < 0) throw new Error('context budget reserves exceed the model context window');

    for (const segment of input.segments) {
      if (!allowed.has(segment.sourceRef)) throw new Error(`context source is not allowed: ${segment.sourceRef}`);
      if (!Number.isSafeInteger(segment.estimatedTokens) || segment.estimatedTokens < 0) {
        throw new Error(`invalid token estimate for context source: ${segment.sourceRef}`);
      }
      if (segment.relevance !== undefined && !Number.isFinite(segment.relevance)) {
        throw new Error(`invalid relevance for context source: ${segment.sourceRef}`);
      }
      if (canonicalDigest(segment.content) !== segment.sourceDigest) {
        throw new Error(`context source digest mismatch: ${segment.sourceRef}`);
      }
    }

    const required = input.segments.filter((segment) => REQUIRED_KINDS.has(segment.kind));
    const requiredTokens = required.reduce((total, segment) => total + segment.estimatedTokens, 0);
    if (requiredTokens > available) throw new Error('required context segments exceed the model context budget');

    const optional = [...input.segments]
      .filter((segment) => !REQUIRED_KINDS.has(segment.kind))
      .sort((left, right) =>
        (right.relevance ?? 0) - (left.relevance ?? 0)
          || compareText(left.sourceRef, right.sourceRef)
          || compareText(left.sourceDigest, right.sourceDigest),
      );
    let usedTokens = requiredTokens;
    const selected = [...required];
    const droppedSourceRefs: string[] = [];
    for (const segment of optional) {
      if (usedTokens + segment.estimatedTokens <= available) {
        selected.push(segment);
        usedTokens += segment.estimatedTokens;
      } else {
        droppedSourceRefs.push(segment.sourceRef);
      }
    }

    const segments = ordered(selected).map((segment) => deepFreeze({
      ...segment,
      content: immutableClone(segment.content),
    }));
    const envelopeWithoutDigest = {
      workspaceId: input.workspaceId,
      policyVersion: input.policy.version,
      segments,
      estimatedTokens: usedTokens,
      outputReserve: input.budget.outputReserve,
      reasoningReserve: input.budget.reasoningReserve,
      droppedSourceRefs: Object.freeze([...droppedSourceRefs].sort()),
    };
    return deepFreeze({ ...envelopeWithoutDigest, digest: canonicalDigest(envelopeWithoutDigest) });
  }
}

export function verifyContextEnvelope(envelope: ContextEnvelope): void {
  const { digest, ...material } = envelope;
  if (canonicalDigest(material) !== digest) throw new Error('context envelope digest mismatch');
}
