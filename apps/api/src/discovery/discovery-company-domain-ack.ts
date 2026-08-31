import { types } from 'node:util';
import { ExecutionControlError } from '../execution-budget/execution-control-error';

export const DISCOVERY_COMPANY_DOMAIN_ACK_INVALID =
  'DISCOVERY_COMPANY_DOMAIN_ACK_INVALID' as const;

export type DiscoveryCompanyDomainAckIdentity = Readonly<{
  domainAckKey: string;
  domainRevision: string;
}>;

type DiscoveryCompanyDomainAckInput = Readonly<{
  runId: string;
  providerKey: string;
  operationId: string;
  resultDigest: string;
}>;

const KEYS = Object.freeze([
  'runId',
  'providerKey',
  'operationId',
  'resultDigest',
] as const);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROVIDER_KEY = /^[a-z][a-z0-9_]{0,63}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

function invalid(): never {
  throw new ExecutionControlError(DISCOVERY_COMPANY_DOMAIN_ACK_INVALID);
}

function closedInput(value: unknown): DiscoveryCompanyDomainAckInput {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== KEYS.length ||
      ownKeys.some((key) => typeof key !== 'string' || !KEYS.includes(key as never)) ||
      KEYS.some((key) =>
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
      )
    ) {
      invalid();
    }
    return Object.freeze(
      Object.fromEntries(
        KEYS.map((key) => [key, descriptors[key]!.value]),
      ),
    ) as DiscoveryCompanyDomainAckInput;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === DISCOVERY_COMPANY_DOMAIN_ACK_INVALID
    ) {
      throw error;
    }
    return invalid();
  }
}

export function discoveryCompanyDomainAckIdentity(
  value: unknown,
): DiscoveryCompanyDomainAckIdentity {
  const input = closedInput(value);
  if (
    typeof input.runId !== 'string' ||
    !UUID.test(input.runId) ||
    typeof input.operationId !== 'string' ||
    !UUID.test(input.operationId) ||
    typeof input.providerKey !== 'string' ||
    !PROVIDER_KEY.test(input.providerKey) ||
    typeof input.resultDigest !== 'string' ||
    !DIGEST.test(input.resultDigest)
  ) {
    invalid();
  }
  return Object.freeze({
    domainAckKey: `${input.runId}:${input.providerKey}:${input.operationId}`,
    domainRevision: input.resultDigest,
  });
}
