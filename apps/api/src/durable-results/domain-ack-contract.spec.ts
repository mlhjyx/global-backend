import { describe, expect, it } from 'vitest';
import {
  parseDomainAckContract,
  parseExecutionResultDisposition,
} from './domain-ack-contract';

const receipt = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: 'workspace:8baedc78-9082-4b95-b888-4b18eb326d13',
  authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  accountId: '486eb66b-67d3-46c3-a358-637b3650038d',
  operationId: '9efb3b8d-b32d-472e-a594-679b5f43bf41',
  operationKey: 'tool:smtp.rcpt_probe:request:2c52d430',
  resultStrategy: 'typed_projection',
  resultSchema: 'smtp-probe-verdict/v1',
  resultDigest: 'b'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD', unit: 'microusd', callCount: 1,
    chargedMicrousd: '0', upperBoundMicrousd: '0',
  },
  costBasis: 'provider_reported',
  status: 'SETTLED',
});

const personalAck = Object.freeze({
  schemaVersion: 'generic-operation-domain-ack/v1',
  scopeKey: receipt.scopeKey,
  authorityId: receipt.authorityId,
  accountId: receipt.accountId,
  operationId: receipt.operationId,
  resultStrategy: receipt.resultStrategy,
  resultSchema: receipt.resultSchema,
  resultDigest: receipt.resultDigest,
  artifactId: null,
  consumer: 'EmailVerificationProvider',
  domainAggregateType: 'EmailVerification',
  domainAggregateId: 'verification:7f4a5c40',
  domainRevision: '1',
  privacyClass: 'PERSONAL_DATA',
  subjectRef: {
    schemaVersion: 'generic-operation-subject-ref/v1',
    subjectType: 'contact_point',
    subjectIdHash: 'c'.repeat(64),
  },
  personalDataDsrCompatible: true,
  acknowledgedAt: '2026-08-24T10:20:30.000Z',
});

describe('domain ACK declaration contract', () => {
  it('accepts a closed PERSONAL_DATA ACK only with a hashed subject reference', () => {
    const parsed = parseDomainAckContract(personalAck);
    expect(parsed).toEqual(personalAck);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.subjectRef)).toBe(true);
  });

  it('rejects PERSONAL_DATA ACKs without DSR compatibility and subject binding', () => {
    for (const candidate of [
      { ...personalAck, subjectRef: null },
      { ...personalAck, personalDataDsrCompatible: false },
      { ...personalAck, subjectRef: { ...personalAck.subjectRef, subjectId: 'person@example.test' } },
    ]) {
      expect(() => parseDomainAckContract(candidate)).toThrow('DOMAIN_ACK_CONTRACT_INVALID');
    }
  });

  it('rejects payload, personal, credential and raw execution fields', () => {
    for (const field of [
      'body', 'prompt', 'reasoning', 'rawResponse', 'response', 'token',
      'email', 'credential', 'credentials',
    ]) {
      expect(() => parseDomainAckContract({ ...personalAck, [field]: 'forbidden' }))
        .toThrow('DOMAIN_ACK_CONTRACT_INVALID');
    }
  });

  it('accepts a bounded artifact ACK and rejects strategy/artifact/timestamp drift', () => {
    const artifactAck = {
      ...personalAck,
      resultStrategy: 'artifact_reference',
      resultSchema: 'http-get/v1',
      artifactId: '892b2e0e-990a-4c66-89d9-2ce467a0da4d',
    };
    expect(parseDomainAckContract(artifactAck)).toMatchObject({
      resultStrategy: 'artifact_reference',
      artifactId: artifactAck.artifactId,
    });
    for (const candidate of [
      { ...artifactAck, artifactId: null },
      { ...personalAck, artifactId: artifactAck.artifactId },
      { ...personalAck, acknowledgedAt: '2026-08-24T10:20:30Z' },
      { ...personalAck, domainRevision: '' },
    ]) {
      expect(() => parseDomainAckContract(candidate)).toThrow('DOMAIN_ACK_CONTRACT_INVALID');
    }
  });

  it('preserves ACK state after artifact expiry while raw access remains a separate gate', () => {
    const acknowledgedAfterArtifactExpiry = {
      ...personalAck,
      resultStrategy: 'artifact_reference',
      resultSchema: 'http-get/v1',
      artifactId: '892b2e0e-990a-4c66-89d9-2ce467a0da4d',
      acknowledgedAt: '2026-08-25T10:20:30.000Z',
    };

    expect(parseDomainAckContract(acknowledgedAfterArtifactExpiry)).toEqual(
      acknowledgedAfterArtifactExpiry,
    );
  });
});

describe('valid/unknown/control/replay disposition contract', () => {
  it('accepts valid output only with a settled receipt and no result body', () => {
    expect(parseExecutionResultDisposition({
      schemaVersion: 'execution-result-disposition/v1',
      kind: 'valid_output',
      receipt,
      automaticPhysicalRetryAllowed: false,
    })).toMatchObject({ kind: 'valid_output' });
  });

  it.each([
    {
      kind: 'result_unknown', code: 'GENERIC_OPERATION_RESULT_UNKNOWN',
      operationStatus: 'RESULT_UNKNOWN',
    },
    {
      kind: 'control_error', code: 'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
      operationStatus: 'RELEASED',
    },
    {
      kind: 'replay_error', code: 'GENERIC_OPERATION_REPLAY_INVALID',
      operationStatus: 'SETTLED',
    },
  ])('locks $kind to no automatic physical retry', (input) => {
    expect(parseExecutionResultDisposition({
      schemaVersion: 'execution-result-disposition/v1',
      ...input,
      operationId: receipt.operationId,
      operationKey: receipt.operationKey,
      automaticPhysicalRetryAllowed: false,
    })).toMatchObject(input);
  });

  it('rejects unknown/control/replay outcomes that permit a second physical call', () => {
    expect(() => parseExecutionResultDisposition({
      schemaVersion: 'execution-result-disposition/v1',
      kind: 'result_unknown',
      code: 'GENERIC_OPERATION_RESULT_UNKNOWN',
      operationStatus: 'RESULT_UNKNOWN',
      operationId: receipt.operationId,
      operationKey: receipt.operationKey,
      automaticPhysicalRetryAllowed: true,
    })).toThrow('EXECUTION_RESULT_DISPOSITION_INVALID');
  });

  it('rejects mismatched status/code pairs and malformed valid receipts', () => {
    for (const candidate of [
      {
        schemaVersion: 'execution-result-disposition/v1', kind: 'control_error',
        code: 'GENERIC_OPERATION_RESULT_UNKNOWN', operationStatus: 'RELEASED',
        operationId: receipt.operationId, operationKey: receipt.operationKey,
        automaticPhysicalRetryAllowed: false,
      },
      {
        schemaVersion: 'execution-result-disposition/v1', kind: 'replay_error',
        code: 'GENERIC_OPERATION_REPLAY_INVALID', operationStatus: 'RESULT_UNKNOWN',
        operationId: receipt.operationId, operationKey: receipt.operationKey,
        automaticPhysicalRetryAllowed: false,
      },
      {
        schemaVersion: 'execution-result-disposition/v1', kind: 'valid_output',
        receipt: { ...receipt, status: 'RESULT_UNKNOWN' },
        automaticPhysicalRetryAllowed: false,
      },
    ]) {
      expect(() => parseExecutionResultDisposition(candidate))
        .toThrow('EXECUTION_RESULT_DISPOSITION_INVALID');
    }
  });

  it('rejects a Proxy before invoking any descriptor trap', () => {
    let descriptorTrapCalls = 0;
    const candidate = new Proxy({
      schemaVersion: 'execution-result-disposition/v1',
      kind: 'result_unknown',
      code: 'GENERIC_OPERATION_RESULT_UNKNOWN',
      operationStatus: 'RESULT_UNKNOWN',
      operationId: receipt.operationId,
      operationKey: receipt.operationKey,
      automaticPhysicalRetryAllowed: false,
    }, {
      getOwnPropertyDescriptor(target, property) {
        descriptorTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => parseExecutionResultDisposition(candidate))
      .toThrow('EXECUTION_RESULT_DISPOSITION_INVALID');
    expect(descriptorTrapCalls).toBe(0);
  });
});
