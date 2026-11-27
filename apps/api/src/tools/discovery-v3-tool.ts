import type { Prisma } from '@prisma/client';
import { discoveryV3RobotsTarget, DISCOVERY_V3_ROBOTS_TIMEOUT_MS, type PrepareDiscoveryV3Robots } from '../adapters/discovery-v3-robots';
import {
  currentDiscoveryV3OperationScope, discoveryV3WireSignal, persistDiscoveryV3WireReceipt,
} from '../durable-results/discovery-v3-operation-scope';
import {
  DISCOVERY_V3_ROBOTS_PROOF, DiscoveryV3OperationError, discoveryV3Digest,
  type DiscoveryV3ClaimedOperation, type DiscoveryV3Cost, type DiscoveryV3OperationInput,
} from '../durable-results/discovery-v3-operation-contract';
import { parseGenericOperationProjection, projectGenericOperationResult, type GenericOperationProjection } from './generic-operation-projection';
import type { ArtifactSubjectRef } from './artifact-execution-port';
import type { DiscoveryV3ArtifactExecutionPort, PreparedDiscoveryV3Artifact } from './discovery-v3-artifact-execution-port';
import { assertToolExternalActionAuthorized, type Tool, type ToolContext, type ToolResult } from './tool-contract';
import { observedToolMicrousd } from './tool-cost-microusd';

type NativeScope = NonNullable<ReturnType<typeof currentDiscoveryV3OperationScope>>;
const REPLAY = new Error('DISCOVERY_V3_TOOL_REPLAY');

async function checkRobotsProof(args: {
  scope: NativeScope;
  operation: DiscoveryV3OperationInput;
  workerAttempt: number;
  authorize: () => Promise<void>;
  prepare: PrepareDiscoveryV3Robots;
}): Promise<boolean> {
  const { scope, operation, workerAttempt, authorize, prepare } = args;
  await authorize();
  const decision = await scope.store.claim(scope.command, operation, workerAttempt);
  if (decision.status === 'REPLAY' && decision.result && decision.resultSha256) {
    const result = parseGenericOperationProjection(decision.result);
    const data = result.data as { allowed?: unknown } | null;
    if (result.kind !== 'tool' || result.schema !== DISCOVERY_V3_ROBOTS_PROOF || result.digest !== decision.resultSha256 ||
        !data || Object.keys(data).join(',') !== 'allowed' || typeof data.allowed !== 'boolean') {
      throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_CONFLICT');
    }
    return data.allowed;
  }
  if (decision.status !== 'CLAIMED') throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_UNRESOLVED');
  let started = false;
  let allowed: boolean;
  try {
    const read = await prepare();
    await authorize();
    const authorizationStarted = performance.now();
    const remaining = await scope.store.authorizeSend(scope.command, operation, decision, workerAttempt);
    const signal = discoveryV3WireSignal(scope.signal, remaining, authorizationStarted);
    started = true;
    allowed = await read(signal);
    if (typeof allowed !== 'boolean') throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
  } catch (error) {
    await persistDiscoveryV3WireReceipt(scope, operation, decision, {
      outcome: started ? 'UNKNOWN' : 'FAILED',
      cost: started ? { basis: 'UNKNOWN' } : {
        basis: 'CONFIRMED_ZERO', amountMicros: 0, currency: 'USD',
        evidenceSha256: discoveryV3Digest([decision.operationId, operation.requestSha256, 'no_wire']),
      },
    });
    throw error;
  }
  const result = projectGenericOperationResult({ kind: 'tool', schema: DISCOVERY_V3_ROBOTS_PROOF, data: { allowed } });
  await persistDiscoveryV3WireReceipt(scope, operation, decision, { outcome: 'SUCCEEDED', result, cost: { basis: 'UNKNOWN' } });
  return allowed;
}

function toolCost(result: ToolResult): DiscoveryV3Cost {
  const charge = result.providerCharge;
  if (charge && /^[0-9a-f]{64}$/.test(charge.evidenceSha256) && /^[A-Z]{3}$/.test(charge.currency) &&
      Number.isSafeInteger(charge.amountMicros) && charge.amountMicros >= 0) {
    return { basis: 'PROVIDER_REPORTED', ...charge };
  }
  const estimate = Number(observedToolMicrousd(result));
  if (Number.isSafeInteger(estimate) && estimate > 0) {
    return { basis: 'ESTIMATED', currency: 'USD', source: 'tariff', amountMicros: estimate };
  }
  return { basis: 'UNKNOWN' };
}

export async function executeDiscoveryV3Tool<I, O>(input: {
  scope: NativeScope;
  context: ToolContext;
  tool: Tool<I, O>;
  request: I;
  timeoutMs: number;
  artifact?: { port: DiscoveryV3ArtifactExecutionPort; subjectRef: ArtifactSubjectRef; schema: string };
  authorizeSource: () => Promise<void>;
  authorizeSubject?: () => Promise<void>;
  project: (result: ToolResult<O>) => GenericOperationProjection;
  restore: (result: GenericOperationProjection) => ToolResult<O> | null;
}): Promise<ToolResult<O>> {
  const { scope, context, tool, request, timeoutMs, artifact } = input;
  const requiresRobots = tool.id === 'crawl4ai.fetch';
  if (requiresRobots && (!input.authorizeSubject || artifact?.schema !== 'crawl4ai-fetch/v1')) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
  }
  const workerAttempt = scope.workerAttempt ?? 1;
  const operation: DiscoveryV3OperationInput = {
    step: `${scope.step}/tool/${++scope.nextTool}`, kind: 'TOOL', ordinal: 1,
    provider: tool.id, action: tool.id, method: 'invoke', maxDurationMs: timeoutMs,
    requestSha256: discoveryV3Digest(JSON.parse(JSON.stringify([
      tool.version, request, context.purpose ?? null, context.taskContractId ?? null,
      ...(artifact ? [artifact.subjectRef, artifact.schema] : []),
    ])) as Prisma.InputJsonArray),
  };
  let invoked = false;
  let robotsInvoked = false;
  let robotsAllowed = false;
  let claim: DiscoveryV3ClaimedOperation | undefined;
  let wireStarted = false;
  let replay: ToolResult<O> | null = null;
  let replayLink: Parameters<NonNullable<NativeScope['onResult']>>[0] | undefined;
  let dispatchError: unknown;
  let result: ToolResult<O>;
  async function authorize() {
    scope.signal.throwIfAborted();
    await input.authorizeSource();
    await input.authorizeSubject?.();
    await assertToolExternalActionAuthorized(context);
  }
  try {
    const executionContext: ToolContext & Required<Pick<ToolContext, 'dispatchDiscoveryV3Wire'>> = {
      ...context,
      checkDiscoveryV3Robots: requiresRobots ? async (targetUrl, prepare) => {
        try {
          if (robotsInvoked || invoked || !request || typeof request !== 'object' ||
              Object.getOwnPropertyDescriptor(request, 'url')?.value !== targetUrl) {
            throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
          }
          robotsInvoked = true;
          const { robotsUrl, path } = discoveryV3RobotsTarget(targetUrl);
          const child: DiscoveryV3OperationInput = {
            ...operation, step: `${operation.step}/robots`, method: 'robots', maxDurationMs: DISCOVERY_V3_ROBOTS_TIMEOUT_MS,
            requestSha256: discoveryV3Digest([operation.requestSha256, robotsUrl, path]),
          };
          robotsAllowed = await checkRobotsProof({ scope, operation: child, workerAttempt, authorize, prepare });
          return robotsAllowed;
        } catch (error) {
          dispatchError = error;
          throw error;
        }
      } : undefined,
      async dispatchDiscoveryV3Wire<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
        try {
          if (invoked || (requiresRobots && !robotsAllowed)) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_CONFLICT');
          invoked = true;
          await authorize();
          const decision = await scope.store.claim(scope.command, operation, workerAttempt);
          if (decision.status === 'REPLAY' && decision.result && decision.resultSha256) {
            replay = artifact ? await artifact.port.replay({
              identity: { workspaceId: context.workspaceId, operationId: decision.operationId, requestSha256: operation.requestSha256 },
              tool, subjectRef: artifact.subjectRef, projection: decision.result, resultSha256: decision.resultSha256, signal: scope.signal,
            }) : input.restore(decision.result);
            if (replay) {
              replayLink = { operation, operationId: decision.operationId, resultSha256: decision.resultSha256 };
              throw REPLAY;
            }
          }
          if (decision.status !== 'CLAIMED') throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_UNRESOLVED');
          claim = decision;
          await authorize();
          const authorizationStarted = performance.now();
          const remaining = await scope.store.authorizeSend(scope.command, operation, claim, workerAttempt);
          const signal = discoveryV3WireSignal(scope.signal, remaining, authorizationStarted);
          signal.throwIfAborted();
          wireStarted = true;
          return await send(signal);
        } catch (error) {
          dispatchError = error;
          throw error;
        }
      },
    };
    result = await (tool.executeDiscoveryV3 ? tool.executeDiscoveryV3(request, executionContext) : tool.execute(request, executionContext));
    if (dispatchError !== undefined) throw dispatchError;
  } catch (error) {
    if (error === REPLAY && replay) {
      const prior = replay as ToolResult<O>;
      if (replayLink) scope.onResult?.(replayLink);
      return { ...prior, costCents: 0, costMicrousd: '0', providerCharge: undefined };
    }
    if (claim) {
      const cost = wireStarted ? { basis: 'UNKNOWN' as const } : {
        basis: 'CONFIRMED_ZERO' as const, amountMicros: 0, currency: 'USD',
        evidenceSha256: discoveryV3Digest([claim.operationId, operation.requestSha256, 'no_wire']),
      };
      await persistDiscoveryV3WireReceipt(scope, operation, claim, { outcome: wireStarted ? 'UNKNOWN' : 'FAILED', cost });
    }
    throw error;
  }
  if (!claim) {
    // Declared adapters can explicitly degrade before any transport, for
    // example when an operator has not configured a provider credential.
    if (result.degraded && result.costCents === 0) return result;
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_INVALID');
  }
  let cost: DiscoveryV3Cost;
  if (tool.discoveryV3ChargeFree && result.costCents === 0 && !result.providerCharge) {
    cost = {
      basis: 'CONFIRMED_ZERO', amountMicros: 0, currency: 'USD',
      evidenceSha256: discoveryV3Digest([claim.operationId, operation.requestSha256, tool.version, 'registered_free_source']),
    };
  } else {
    try { cost = toolCost(result); } catch { cost = { basis: 'UNKNOWN' }; }
  }
  let projection: GenericOperationProjection;
  let prepared: PreparedDiscoveryV3Artifact<O> | undefined;
  try {
    if (artifact) {
      prepared = await artifact.port.prepare({
        identity: { workspaceId: context.workspaceId, operationId: claim.operationId, requestSha256: operation.requestSha256 },
        tool, input: request, result, subjectRef: artifact.subjectRef, signal: scope.signal,
      });
    }
    projection = prepared?.projection ?? input.project(result);
  } catch (error) {
    await persistDiscoveryV3WireReceipt(scope, operation, claim, { outcome: 'FAILED', cost });
    throw error;
  }
  try {
    await persistDiscoveryV3WireReceipt(scope, operation, claim, { outcome: 'SUCCEEDED', result: projection, cost }, prepared?.commit);
    const verified = prepared ? await prepared.readResult() : result;
    scope.onResult?.({ operation, operationId: claim.operationId, resultSha256: projection.digest });
    return verified;
  } finally {
    await prepared?.cleanup();
  }
}
