import type { Prisma } from '@prisma/client';
import { types as nodeUtilTypes } from 'node:util';
import { parseArtifactReference } from '../durable-results/artifact/artifact-reference.schema';
import { invalidGenericOperationArtifact, type GenericOperationArtifactReference } from '../durable-results/artifact/artifact.types';
import type { ArtifactExecutionPort, ArtifactSubjectRef } from './artifact-execution-port';
import { parseGenericOperationProjection, type GenericOperationProjection } from './generic-operation-projection';
import type { Tool, ToolResult } from './tool-contract';

export const DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA = 'discovery-v3-artifact-reference/v1' as const;

export interface DiscoveryV3ArtifactIdentity {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly requestSha256: string;
}

export interface PrepareDiscoveryV3ArtifactInput<I, O> {
  readonly identity: DiscoveryV3ArtifactIdentity;
  readonly tool: Tool<I, O>;
  readonly input: I;
  readonly result: ToolResult<O>;
  readonly subjectRef: ArtifactSubjectRef;
  readonly signal?: AbortSignal;
}

export interface ReplayDiscoveryV3ArtifactInput<I, O> {
  readonly identity: DiscoveryV3ArtifactIdentity;
  readonly tool: Tool<I, O>;
  readonly subjectRef: ArtifactSubjectRef;
  readonly projection: GenericOperationProjection;
  readonly resultSha256: string;
  readonly signal?: AbortSignal;
}

export function parseDiscoveryV3ArtifactProjection(
  value: unknown,
  expected?: Readonly<{ operationId: string; resultSchema?: string; resultSha256?: string }>,
): GenericOperationArtifactReference {
  if (!value || typeof value !== 'object' || nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return invalidGenericOperationArtifact();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== 5 || !ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
  })) return invalidGenericOperationArtifact();
  // Validate the original data before the generic JSON normalizer can drop
  // unknown fields with undefined values.
  const reference = parseArtifactReference(Object.getOwnPropertyDescriptor(value, 'data')?.value);
  let projection: GenericOperationProjection;
  try {
    projection = parseGenericOperationProjection(value);
  } catch {
    return invalidGenericOperationArtifact();
  }
  if (projection.kind !== 'tool' || projection.schema !== DISCOVERY_V3_ARTIFACT_REFERENCE_SCHEMA ||
      (expected?.resultSha256 !== undefined && projection.digest !== expected.resultSha256)) {
    return invalidGenericOperationArtifact();
  }
  if (expected && (reference.operationId !== expected.operationId ||
      (expected.resultSchema !== undefined && reference.resultSchema !== expected.resultSchema))) {
    return invalidGenericOperationArtifact();
  }
  return reference;
}

export interface PreparedDiscoveryV3Artifact<O> {
  readonly projection: GenericOperationProjection;
  /** Called within the same transaction as the successful v3 operation receipt. */
  commit(tx: Prisma.TransactionClient): Promise<void>;
  readResult(): Promise<ToolResult<O>>;
  cleanup(): Promise<void>;
}

export interface DiscoveryV3ArtifactExecutionPort extends Pick<ArtifactExecutionPort, 'admit'> {
  prepare<I, O>(input: PrepareDiscoveryV3ArtifactInput<I, O>): Promise<PreparedDiscoveryV3Artifact<O>>;
  replay<I, O>(input: ReplayDiscoveryV3ArtifactInput<I, O>): Promise<ToolResult<O>>;
}
