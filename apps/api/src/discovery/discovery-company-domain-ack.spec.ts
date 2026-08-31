import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DomainAckService, InMemoryDomainAckRepository } from '../durable-results/domain-ack';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import {
  DISCOVERY_COMPANY_DOMAIN_ACK_INVALID,
  discoveryCompanyDomainAckIdentity,
} from './discovery-company-domain-ack';

const RUN_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const AUTHORITY_ID = '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0';
const ACCOUNT_ID = '1b3d6096-b924-4bc8-bb4f-8436efb37b07';
const OPERATION_ID = 'f9c22f2a-3578-4ed2-ac8b-0819e9147c40';
const DIGEST = 'a'.repeat(64);

function validInput() {
  return {
    runId: RUN_ID,
    providerKey: 'public_web',
    operationId: OPERATION_ID,
    resultDigest: DIGEST,
  };
}

function opaque(value: string): string {
  return createHash('sha256').update(value.normalize('NFC')).digest('hex');
}

function receipt(): DurableExecutionReceipt {
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: RUN_ID,
    authorityId: AUTHORITY_ID,
    accountId: ACCOUNT_ID,
    operationId: OPERATION_ID,
    operationKey: 'discovery:company:operation-1',
    resultStrategy: 'typed_projection',
    resultSchema: 'discovery-extract-company/v1',
    resultDigest: DIGEST,
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      upperBoundMicrousd: '0',
    },
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  };
}

describe('discoveryCompanyDomainAckIdentity', () => {
  it('returns one frozen unhashed v3 identity for DomainAckService', async () => {
    const identity = discoveryCompanyDomainAckIdentity(validInput());
    expect(identity).toEqual({
      domainAckKey: `${RUN_ID}:public_web:${OPERATION_ID}`,
      domainRevision: DIGEST,
    });
    expect(Object.isFrozen(identity)).toBe(true);

    const apply = vi.fn(async () => 'stored');
    const result = await new DomainAckService(
      new InMemoryDomainAckRepository(),
    ).applyWithAck(
      {
        receipt: receipt(),
        consumer: 'PublicWebDiscoveryProvider',
        domainAggregateType: 'RawSourceRecord',
        ...identity,
      },
      apply,
    );
    expect(result.ack.domainAckKey).toBe(opaque(identity.domainAckKey));
    expect(result.ack.domainRevision).toBe(opaque(DIGEST));
    expect(result.ack.domainAckKey).not.toBe(opaque(opaque(identity.domainAckKey)));
    expect(apply).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    [],
    { ...validInput(), extra: true },
    { ...validInput(), runId: 'not-a-uuid' },
    { ...validInput(), operationId: 'not-a-uuid' },
    { ...validInput(), providerKey: 'public-web' },
    { ...validInput(), providerKey: 'A' },
    { ...validInput(), resultDigest: DIGEST.toUpperCase() },
    new Proxy(validInput(), {}),
    Object.defineProperty(validInput(), 'providerKey', { get: () => 'public_web' }),
  ])('rejects non-canonical input before producing an ACK identity', (input) => {
    expect(() => discoveryCompanyDomainAckIdentity(input as never)).toThrow(
      DISCOVERY_COMPANY_DOMAIN_ACK_INVALID,
    );
  });

  it('rejects missing, symbol and enumerable accessor fields without invoking getters', () => {
    const missing = validInput() as Record<string, unknown>;
    delete missing.providerKey;
    expect(() => discoveryCompanyDomainAckIdentity(missing)).toThrow(
      DISCOVERY_COMPANY_DOMAIN_ACK_INVALID,
    );

    const symbol = { ...validInput(), [Symbol('hidden')]: true };
    expect(() => discoveryCompanyDomainAckIdentity(symbol)).toThrow(
      DISCOVERY_COMPANY_DOMAIN_ACK_INVALID,
    );

    let getterCalls = 0;
    const accessor = validInput();
    Object.defineProperty(accessor, 'providerKey', {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'public_web';
      },
    });
    expect(() => discoveryCompanyDomainAckIdentity(accessor)).toThrow(
      DISCOVERY_COMPANY_DOMAIN_ACK_INVALID,
    );
    expect(getterCalls).toBe(0);
  });

  it('does not alter the existing v2 Activity callsite', () => {
    const activities = readFileSync(
      new URL('../temporal/discovery.activities.ts', import.meta.url),
      'utf8',
    );
    expect(activities).not.toContain('discoveryCompanyDomainAckIdentity');
  });
});
