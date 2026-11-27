import { createHash, timingSafeEqual } from 'node:crypto';
import { resolveModelGatewayBaseUrl, validateModelGatewayEndpoint } from '../adapters/model-gateway-endpoint';
import { DiscoveryV3OperationError, type DiscoveryV3OperationInput, type DiscoveryV3WireStore, type DiscoveryV3WireUsage } from '../durable-results/discovery-v3-operation-contract';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import type { DiscoveryV3GatewayCredentialFingerprint, DiscoveryV3GatewayEvidence, DiscoveryV3GatewayReadbackBinding, DiscoveryV3GatewayRoute } from './discovery-v3-gateway-contract';
import { canonicalGatewayCredential, gatewayCredentialsAreDistinct } from './gateway-credential-boundary';
import { boundedModelTokenCount } from './model-usage-boundary';
import {
  NEW_API_REQUEST_BOUND_RESOLVER_ID,
  type NewApiRequestBoundSettlementReceipt,
  type NewApiRequestBoundSettlementResolverPort,
} from './settlement-readback-contract';
import {
  loadSettlementDerivationKeyring,
  restoreSettlementWireIdentity,
  settlementWireIdentities,
  toDurableSettlementWireIdentity,
  type SettlementDerivationKeyring,
  type SettlementWireIdentity,
} from './settlement-wire-identity';
import { MODEL_GATEWAY_TENANT_KEYS_ENV, parseTenantGatewayKeyMap } from './tenant-gateway-routing';
import type { AiContext } from './types';

const READER_CREDENTIAL = /^srb1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;
const CREDENTIAL_TAG = /^[0-9a-f]{64}$/u;
const ENDPOINT = {
  'openai-chat-completions': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
} as const;

export interface DiscoveryV3GatewayReadbackRuntime {
  readonly gatewayOrigin: string;
  readonly keyring: SettlementDerivationKeyring;
  readonly resolver: NewApiRequestBoundSettlementResolverPort;
}

interface ReadbackTarget {
  readonly command: DiscoveryV3Dispatch;
  readonly operation: DiscoveryV3OperationInput;
  readonly operationId: string;
}

function operationBindingFields({ command, operation, operationId }: ReadbackTarget) {
  return [
    command.workspaceId, command.runId, command.planId, command.icpId,
    command.attemptId, command.requestSha256, operationId, operation.kind, operation.step, operation.ordinal,
    operation.requestSha256, operation.provider, operation.action, operation.method, operation.maxDurationMs,
  ];
}

function operationKey(target: ReadbackTarget, route: DiscoveryV3GatewayRoute): string {
  return createHash('sha256').update(JSON.stringify([
    'discovery-v3-gateway-wire/v1', ...operationBindingFields(target),
    route.gatewayOrigin, route.alias, route.protocol, route.maxOutputTokens, route.credentialSha256,
  ])).digest('hex');
}

interface DiscoveryV3GatewayWire {
  readonly binding: DiscoveryV3GatewayReadbackBinding;
  readonly identity: SettlementWireIdentity;
  readonly fingerprintCredential: DiscoveryV3GatewayCredentialFingerprint;
  dispatched: boolean;
}

const activeWires = new WeakMap<AiContext, DiscoveryV3GatewayWire>();

export function prepareDiscoveryV3GatewayWire(
  runtime: DiscoveryV3GatewayReadbackRuntime, target: ReadbackTarget,
  resolveRoute: (fingerprintCredential: DiscoveryV3GatewayCredentialFingerprint) => DiscoveryV3GatewayRoute,
): DiscoveryV3GatewayWire {
  const { gatewayOrigin, keyring } = runtime;
  const scope = JSON.stringify([gatewayOrigin, ...operationBindingFields(target)]);
  const fingerprintCredential: DiscoveryV3GatewayCredentialFingerprint =
    (credential) => keyring.fingerprintDiscoveryV3GatewayCredential(scope, credential);
  const route = resolveRoute(fingerprintCredential);
  if (route.gatewayOrigin !== gatewayOrigin || !MODEL_IDENTIFIER.test(route.alias) ||
    !CREDENTIAL_TAG.test(route.credentialSha256)) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  const [identity] = settlementWireIdentities(keyring, operationKey(target, route), 1);
  const binding = Object.freeze({ ...route, identity: toDurableSettlementWireIdentity(identity!) });
  return { binding, identity: identity!, fingerprintCredential, dispatched: false };
}

export async function withDiscoveryV3GatewayWire<T>(
  context: AiContext, wire: DiscoveryV3GatewayWire, send: (boundContext: AiContext) => Promise<T>,
): Promise<T> {
  const boundContext = { ...context };
  activeWires.set(boundContext, wire);
  try {
    return await send(boundContext);
  } finally {
    activeWires.delete(boundContext);
  }
}

/** Called by the adapter immediately before the one generation POST. */
export function discoveryV3GatewayRequestHeaders(context: AiContext, url: string, init: RequestInit, alias: string): Headers | undefined {
  const wire = activeWires.get(context);
  if (!wire) return undefined;
  const { binding, identity } = wire;
  const requestUrl = new URL(url);
  const headers = new Headers(init.headers);
  const credential = binding.protocol === 'anthropic-messages'
    ? headers.get('x-api-key')
    : headers.get('Authorization')?.match(/^Bearer (.+)$/u)?.[1];
  if (init.method !== 'POST' || alias !== binding.alias || requestUrl.origin !== binding.gatewayOrigin ||
    !requestUrl.pathname.endsWith(ENDPOINT[binding.protocol]) || headers.get('x-workspace-id') !== context.workspaceId ||
    !credential || !timingSafeEqual(Buffer.from(wire.fingerprintCredential(credential), 'hex'), Buffer.from(binding.credentialSha256, 'hex'))) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  if (wire.dispatched) throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_UNRESOLVED');
  init.signal?.throwIfAborted();
  headers.set('X-New-API-Settlement-Request-Id', identity.requestId);
  headers.set('X-New-API-Settlement-Nonce', identity.nonce);
  wire.dispatched = true;
  return headers;
}

function gatewayEvidence(
  binding: DiscoveryV3GatewayReadbackBinding, receipt: NewApiRequestBoundSettlementReceipt,
): DiscoveryV3GatewayEvidence {
  if (receipt.requestId !== binding.identity.requestId || receipt.alias !== binding.alias ||
    receipt.protocol !== binding.protocol || receipt.resolverId !== NEW_API_REQUEST_BOUND_RESOLVER_ID || receipt.physicalCallCount !== 0) {
    throw new DiscoveryV3OperationError('DISCOVERY_V3_OPERATION_BINDING_MISMATCH');
  }
  return {
    requestId: receipt.requestId, alias: binding.alias, protocol: binding.protocol, channelId: receipt.channelId,
    quotaPoints: receipt.quota, inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens,
    upstreamIdState: receipt.upstreamIdState, receiptSha256: receipt.receiptDigest,
    ...(receipt.actualCharge ? { actualCharge: receipt.actualCharge } : {}),
  };
}

/** Performs read-only settlement against the original durable binding, including after finalization. */
export async function readDiscoveryV3GatewayEvidence(input: ReadbackTarget & {
  readonly binding: DiscoveryV3GatewayReadbackBinding;
  readonly runtime: DiscoveryV3GatewayReadbackRuntime;
  readonly store: Pick<DiscoveryV3WireStore, 'claimModelReadbackProbe' | 'recordModelReadbackProbe'>;
  readonly probeSequence: 1 | 2;
  readonly usage?: DiscoveryV3WireUsage;
  readonly signal?: AbortSignal;
}): Promise<DiscoveryV3GatewayEvidence | undefined> {
  const { runtime, command, operation, operationId, binding, store } = input;
  if (operation.kind !== 'MODEL' || binding.gatewayOrigin !== runtime.gatewayOrigin || binding.identity.physicalWireAttempt !== 1) return undefined;
  const identity = restoreSettlementWireIdentity(runtime.keyring, operationKey(input, binding), binding.identity);
  if (!identity) return undefined;
  try {
    const readback = await runtime.resolver.resolve({
      profile: 'discovery-v3', requestId: identity.requestId, nonce: identity.nonce,
      alias: binding.alias, protocol: binding.protocol,
      usage: { inputTokens: boundedModelTokenCount(input.usage?.inputTokens), outputTokens: boundedModelTokenCount(input.usage?.outputTokens) },
      maxOutputTokens: binding.maxOutputTokens, maximumQuotaPoints: 1_000_000_000, maximumProbeCount: 1,
      signal: input.signal,
      probeAuthority: {
        claim: () => store.claimModelReadbackProbe(command, operation, operationId, binding, input.probeSequence),
        record: ({ probeId, probe, observedAt, receipt }) => store.recordModelReadbackProbe(command, operation, operationId, binding, {
          probeId, probe: { ...probe, sequence: input.probeSequence }, observedAt,
          ...(receipt ? { evidence: gatewayEvidence(binding, receipt) } : {}),
        }),
      },
    });
    return readback.status === 'settled' ? gatewayEvidence(binding, readback) : undefined;
  } catch {
    // The persisted binding remains eligible for read-only reconciliation.
    return undefined;
  }
}

/** Uses a separate per-request reader profile and keeps Site Builder credentials out of Discovery. */
export async function createDiscoveryV3GatewayReadbackRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryV3GatewayReadbackRuntime | undefined> {
  const configuredCredential = env.DISCOVERY_V3_GATEWAY_READBACK_CREDENTIAL;
  const keyringPath = env.DISCOVERY_V3_GATEWAY_READBACK_KEYRING_FILE;
  if (configuredCredential === undefined && keyringPath === undefined) return undefined;
  try {
    const readerCredential = canonicalGatewayCredential(configuredCredential);
    const dispatchCredential = canonicalGatewayCredential(env.MODEL_GATEWAY_KEY);
    const gatewayBaseUrl = resolveModelGatewayBaseUrl(env);
    const endpoint = validateModelGatewayEndpoint(gatewayBaseUrl, { allowInternalServiceHttp: true, allowPlainHttpHostnames: true, env });
    const otherCredentials = [dispatchCredential, env.MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL,
      ...parseTenantGatewayKeyMap(env[MODEL_GATEWAY_TENANT_KEYS_ENV]).values()];
    if (!readerCredential || !READER_CREDENTIAL.test(readerCredential) || !dispatchCredential || !endpoint.ok || !endpoint.url ||
      !keyringPath || keyringPath === env.SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_FILE ||
      otherCredentials.some((credential) => credential && !gatewayCredentialsAreDistinct(credential, readerCredential))) {
      throw new Error('invalid discovery reader configuration');
    }
    const gatewayOrigin = endpoint.url.origin;
    const keyring = loadSettlementDerivationKeyring(keyringPath);
    const { NewApiRequestBoundSettlementResolver } = await import('./new-api-request-bound-settlement');
    const resolver = new NewApiRequestBoundSettlementResolver({
      gatewayOrigin, readerCredential, resolverId: NEW_API_REQUEST_BOUND_RESOLVER_ID, maximumProbeDurationMs: 5_000,
    });
    return Object.freeze({ gatewayOrigin, keyring, resolver });
  } catch {
    throw new Error('DISCOVERY_V3_GATEWAY_READBACK_UNAVAILABLE');
  }
}
