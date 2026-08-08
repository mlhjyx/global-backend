import { describe, expect, it } from 'vitest';
import {
  NativeModelApiError,
  NativeModelOutputError,
} from '../../model-runtime/adapters/ai-sdk-native-adapter.contract';
import { canonicalDigest } from '../../model-runtime/context-engine';
import { COPY_REAL_CAPABILITY_ARTIFACT_PATHS } from './copy-real-capability-runner';
import { copyRealCapabilityValidationForTests as validation } from './copy-real-capability-runner';

function exactReceipt() {
  const executionId = 'copy-capability-1';
  const alias = 'model-a';
  const protocol = 'openai_responses';
  const reasoning = 'medium';
  const planDigest = '1'.repeat(64);
  const inputDigest = '2'.repeat(64);
  const contextDigest = '3'.repeat(64);
  const promptDigest = '4'.repeat(64);
  const fixedSourceCommit = '5'.repeat(40);
  const sourceBundleDigest = '6'.repeat(64);
  const manifestDigest = '7'.repeat(64);
  const admissionDigest = '8'.repeat(64);
  const credentialAttestationDigest = '9'.repeat(64);
  const settlementObserverDigest = 'a'.repeat(64);
  const globalAuthorizationDigest = 'b'.repeat(64);
  const childAuthorizationDigest = 'c'.repeat(64);
  const compiledRuntimeDigest = 'd'.repeat(64);
  const childSlotId = 'slot-1';
  const campaignId = 'campaign-1';
  const authorizationId = 'authorization-1';
  const reservationId = 'reservation-1';
  const fixtureId = 'fixture-1';
  const outputDigest = 'e'.repeat(64);
  const runtimeBinding = {
    schemaVersion: 'copy-real-capability-runtime-binding/2026-08-07-v3',
    taskId: 'site_builder.copy',
    planDigest,
    fixedSourceCommit,
    sourceBundleDigest,
    manifestDigest,
    credentialAttestationDigest,
    settlementObserverDigest,
    globalAuthorizationDigest,
    childAuthorizationDigest,
    selectedExecutionKey: executionId,
    childCampaignId: campaignId,
    gitReviewedEvidenceAcceptanceSchemaVersion: 'git-reviewed-evidence-acceptance/2026-08-07-v1',
    artifactPathsDigest: canonicalDigest(COPY_REAL_CAPABILITY_ARTIFACT_PATHS),
  };
  const compiledBindingDigest = canonicalDigest(runtimeBinding);
  const evidenceBinding = {
    schemaVersion: 'real-model-execution-evidence-binding/2026-08-07-v1',
    executionId,
    childSlotId,
    alias,
    protocol,
    reasoning,
    fixtureId,
    executionPlanDigest: planDigest,
    inputDigest,
    contextDigest,
    promptDigest,
    fixedSourceCommit,
    sourceBundleDigest,
    manifestDigest,
    admissionDigest,
    globalAuthorizationDigest,
    childAuthorizationDigest,
    compiledRuntimeDigest,
    compiledBindingDigest,
  };
  const ledgerCampaign = {
    campaignId,
    taskId: 'site_builder.copy',
    planDigest,
    maximumExecutions: 1,
    maximumWireCalls: 2,
  };
  const ledgerAuthorization = {
    authorizationId,
    reservationId,
    manifestDigest,
    credentialAttestationDigest,
    settlementObserverDigest,
    ledgerIdentityDigest: 'f'.repeat(64),
    reservationDigest: '0'.repeat(64),
    maximumExecutions: 1,
    maximumWireCalls: 2,
    maximumRepairCallsPerExecution: 1,
    evidenceBinding,
  };
  const observation = {
    settlement: 'known',
    requestIdDigest: '1'.repeat(64),
    requestedAlias: alias,
    resolvedAlias: alias,
    reportedModel: alias,
    protocol,
    usage: { inputTokens: 1, outputTokens: 2 },
    outputDigest,
    receiptDigest: '2'.repeat(64),
    quota: 1,
    resolverId: 'resolver',
    channelId: 1,
  };
  const settlementChainWithoutDigest = {
    schemaVersion: 'real-model-known-settlement-evidence/2026-08-07-v1',
    executionId,
    executionClaim: { planDigest },
    wires: [{ wireIndex: 0, claim: { wireId: 'wire-1', requestDigest: '3'.repeat(64) }, observation }],
    completion: { outputDigest },
  };
  const settlementChain = {
    ...settlementChainWithoutDigest,
    digest: canonicalDigest(settlementChainWithoutDigest),
  };
  return {
    classification: 'DISPATCH_PREFLIGHT_RECEIPT_ONLY',
    evidenceClass: 'copy_gateway_settlement_candidate',
    evidenceKind: 'capability_pilot',
    taskId: 'site_builder.copy',
    campaignId,
    executionId,
    alias,
    protocol,
    reasoning,
    wireCount: 1,
    repaired: false,
    fixtureId,
    repeatIndex: null,
    planDigest,
    inputDigest,
    contextDigest,
    promptDigest,
    ledgerDigest: '5'.repeat(64),
    outputDigest,
    fixedSourceCommit,
    sourceBundleDigest,
    manifestDigest,
    admissionDigest,
    credentialAttestationDigest,
    settlementObserverDigest,
    knownSettlementDigest: settlementChain.digest,
    settlementChain,
    authorizationId,
    reservationId,
    globalAuthorizationDigest,
    childAuthorizationDigest,
    childSlotId,
    ledgerCampaign,
    ledgerAuthorization,
    runtimeBinding,
    compiledRuntimeDigest,
    compiledBindingDigest,
  };
}

describe('copy real capability receipt validators', () => {
  it('accepts only plain exact-key records', () => {
    expect(validation.objectRecord({ a: 1 })).toBe(true);
    expect(validation.objectRecord(Object.create(null))).toBe(true);
    expect(validation.objectRecord(null)).toBe(false);
    expect(validation.objectRecord([])).toBe(false);
    expect(validation.objectRecord(new Date())).toBe(false);
    expect(validation.exactObjectKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(validation.exactObjectKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(validation.exactObjectKeys({ a: 1, c: 2 }, ['a', 'b'])).toBe(false);
    expect(validation.exactObjectKeys([], [])).toBe(false);
    const symbol = Symbol('secret');
    expect(validation.exactObjectKeys({ a: 1, [symbol]: 2 }, ['a', 'b'])).toBe(false);
  });

  it('rejects forbidden evidence keys at any depth, cycles, and symbolic keys', () => {
    expect(validation.containsForbiddenEvidenceKey(null)).toBe(false);
    expect(validation.containsForbiddenEvidenceKey({ safe: [{ nested: true }] })).toBe(false);
    expect(validation.containsForbiddenEvidenceKey({ bearer_token: 'x' })).toBe(true);
    expect(validation.containsForbiddenEvidenceKey({ nested: [{ rawRequestId: 'x' }] })).toBe(true);
    expect(validation.containsForbiddenEvidenceKey({ [Symbol('secret')]: true })).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validation.containsForbiddenEvidenceKey(cyclic)).toBe(true);
  });

  it('validates exact known-settlement chains including repair bindings', () => {
    const observation = {
      settlement: 'known',
      requestIdDigest: 'a'.repeat(64),
      requestedAlias: 'model-a',
      resolvedAlias: 'model-a',
      reportedModel: 'model-a',
      protocol: 'openai_responses',
      usage: { inputTokens: 1, outputTokens: 2 },
      outputDigest: 'b'.repeat(64),
      receiptDigest: 'c'.repeat(64),
      quota: 1,
      resolverId: 'resolver',
      channelId: 1,
    };
    const chain = {
      schemaVersion: 'known-settlement/v1',
      executionId: 'exec-1',
      executionClaim: { planDigest: 'd'.repeat(64) },
      wires: [
        { wireIndex: 0, claim: { wireId: 'wire-0', requestDigest: 'e'.repeat(64) }, observation },
        {
          wireIndex: 1,
          claim: { wireId: 'wire-1', requestDigest: 'f'.repeat(64) },
          repairPlan: {
            wireId: 'wire-1',
            bindingDigest: '1'.repeat(64),
            priorOutputDigest: '2'.repeat(64),
            findingsDigest: '3'.repeat(64),
          },
          observation,
        },
      ],
      completion: { outputDigest: '4'.repeat(64) },
      digest: '5'.repeat(64),
    };
    expect(validation.exactSettlementChain(chain)).toBe(true);
    expect(validation.exactSettlementChain(null)).toBe(false);
    expect(validation.exactSettlementChain({ ...chain, extra: true })).toBe(false);
    expect(validation.exactSettlementChain({ ...chain, executionClaim: {} })).toBe(false);
    expect(validation.exactSettlementChain({ ...chain, wires: {} })).toBe(false);
    expect(validation.exactSettlementChain({ ...chain, completion: {} })).toBe(false);
    expect(validation.exactSettlementChain({ ...chain, wires: [{ ...chain.wires[0], extra: true }] })).toBe(false);
    expect(
      validation.exactSettlementChain({
        ...chain,
        wires: [{ ...chain.wires[1], repairPlan: { wireId: 'wire-1' } }],
      }),
    ).toBe(false);
    expect(
      validation.exactSettlementChain({
        ...chain,
        wires: [{ ...chain.wires[0], observation: { ...observation, usage: { inputTokens: 1 } } }],
      }),
    ).toBe(false);
  });

  it('checks settlement observations against the receipt alias/protocol', () => {
    const receipt = {
      alias: 'model-a',
      protocol: 'openai_responses',
      settlementChain: {
        wires: [{ observation: { settlement: 'known', resolvedAlias: 'model-a', reportedModel: 'model-a', protocol: 'openai_responses' } }],
      },
    };
    expect(validation.settlementWiresMatchReceipt(receipt as never)).toBe(true);
    for (const change of [
      { settlement: 'unknown' },
      { resolvedAlias: 'model-b' },
      { reportedModel: 'model-b' },
      { protocol: 'anthropic_messages' },
    ]) {
      const changed = {
        ...receipt,
        settlementChain: { wires: [{ observation: { ...receipt.settlementChain.wires[0].observation, ...change } }] },
      };
      expect(validation.settlementWiresMatchReceipt(changed as never)).toBe(false);
    }
  });

  it('accepts only an exact, internally bound historical candidate receipt', () => {
    const receipt = exactReceipt();
    expect(validation.exactCopyReceipt(receipt)).toBe(true);
    expect(validation.historicalReceiptBindingIsExact(receipt as never)).toBe(true);
    expect(validation.exactCopyReceipt({ ...receipt, bearerToken: 'secret' })).toBe(false);
    expect(validation.exactCopyReceipt({ ...receipt, runtimeBinding: { ...receipt.runtimeBinding, extra: true } })).toBe(false);
    expect(validation.exactCopyReceipt({ ...receipt, ledgerCampaign: { ...receipt.ledgerCampaign, extra: true } })).toBe(false);
    expect(validation.exactCopyReceipt({ ...receipt, ledgerAuthorization: { ...receipt.ledgerAuthorization, evidenceBinding: null } })).toBe(false);
    expect(validation.historicalReceiptBindingIsExact({ ...receipt, classification: 'OTHER' } as never)).toBe(false);
    expect(validation.historicalReceiptBindingIsExact({ ...receipt, wireCount: 2 } as never)).toBe(false);
    expect(
      validation.historicalReceiptBindingIsExact({
        ...receipt,
        settlementChain: {
          ...receipt.settlementChain,
          wires: [{ ...receipt.settlementChain.wires[0], observation: { ...receipt.settlementChain.wires[0].observation, settlement: 'unknown' } }],
        },
      } as never),
    ).toBe(false);
  });

  it('binds a challenge to the canonical receipt and settlement-chain digests', () => {
    const receipt = exactReceipt();
    const challenge = {
      schemaVersion: 'site-builder-copy-git-evidence-acceptance-challenge/2026-08-07-v1',
      candidateReceiptDigest: canonicalDigest(receipt),
      receipt,
    };
    expect(validation.challengeReceipt(challenge as never)).toBe(receipt);
    expect(() => validation.challengeReceipt({ ...challenge, extra: true } as never)).toThrow('CANDIDATE_MISMATCH');
    expect(() => validation.challengeReceipt({ ...challenge, receipt: { bad: true } } as never)).toThrow('CANDIDATE_MISMATCH');
    expect(() => validation.challengeReceipt({ ...challenge, schemaVersion: 'old' } as never)).toThrow('CANDIDATE_MISMATCH');
    expect(() => validation.challengeReceipt({ ...challenge, candidateReceiptDigest: '0'.repeat(64) } as never)).toThrow(
      'CANDIDATE_MISMATCH',
    );
    expect(() =>
      validation.challengeReceipt({
        ...challenge,
        receipt: { ...receipt, knownSettlementDigest: '0'.repeat(64) },
      } as never),
    ).toThrow('CANDIDATE_MISMATCH');
  });

  it('fails closed when any historical receipt binding drifts independently', () => {
    const paths = [
      'classification',
      'evidenceClass',
      'evidenceKind',
      'taskId',
      'repeatIndex',
      'runtimeBinding.schemaVersion',
      'runtimeBinding.taskId',
      'runtimeBinding.fixedSourceCommit',
      'runtimeBinding.sourceBundleDigest',
      'runtimeBinding.manifestDigest',
      'runtimeBinding.credentialAttestationDigest',
      'runtimeBinding.settlementObserverDigest',
      'runtimeBinding.globalAuthorizationDigest',
      'runtimeBinding.childAuthorizationDigest',
      'runtimeBinding.selectedExecutionKey',
      'runtimeBinding.childCampaignId',
      'runtimeBinding.gitReviewedEvidenceAcceptanceSchemaVersion',
      'compiledBindingDigest',
      'ledgerAuthorization.evidenceBinding.schemaVersion',
      'ledgerAuthorization.evidenceBinding.executionId',
      'ledgerAuthorization.evidenceBinding.childSlotId',
      'ledgerAuthorization.evidenceBinding.alias',
      'ledgerAuthorization.evidenceBinding.protocol',
      'ledgerAuthorization.evidenceBinding.reasoning',
      'ledgerAuthorization.evidenceBinding.fixtureId',
      'ledgerAuthorization.evidenceBinding.executionPlanDigest',
      'ledgerAuthorization.evidenceBinding.inputDigest',
      'ledgerAuthorization.evidenceBinding.contextDigest',
      'ledgerAuthorization.evidenceBinding.promptDigest',
      'ledgerAuthorization.evidenceBinding.fixedSourceCommit',
      'ledgerAuthorization.evidenceBinding.sourceBundleDigest',
      'ledgerAuthorization.evidenceBinding.manifestDigest',
      'ledgerAuthorization.evidenceBinding.admissionDigest',
      'ledgerAuthorization.evidenceBinding.globalAuthorizationDigest',
      'ledgerAuthorization.evidenceBinding.childAuthorizationDigest',
      'ledgerAuthorization.evidenceBinding.compiledRuntimeDigest',
      'ledgerAuthorization.evidenceBinding.compiledBindingDigest',
      'ledgerCampaign.maximumExecutions',
      'ledgerAuthorization.maximumExecutions',
      'settlementChain.executionId',
      'settlementChain.executionClaim.planDigest',
      'settlementChain.completion.outputDigest',
      'settlementChain.wires.0.observation.resolvedAlias',
      'settlementChain.wires.0.observation.reportedModel',
      'settlementChain.wires.0.observation.protocol',
    ];
    for (const path of paths) {
      const receipt = structuredClone(exactReceipt()) as Record<string, unknown>;
      const segments = path.split('.');
      let target: Record<string, unknown> | unknown[] = receipt;
      for (const segment of segments.slice(0, -1)) {
        target = Array.isArray(target)
          ? (target[Number(segment)] as Record<string, unknown>)
          : (target[segment] as Record<string, unknown> | unknown[]);
      }
      const key = segments.at(-1)!;
      if (Array.isArray(target)) target[Number(key)] = 'drift';
      else target[key] = 'drift';
      expect(validation.historicalReceiptBindingIsExact(receipt as never), path).toBe(false);
    }

    const repaired = exactReceipt();
    expect(validation.historicalReceiptBindingIsExact({ ...repaired, repaired: true } as never)).toBe(false);
    const missingEvidence = exactReceipt();
    expect(
      validation.historicalReceiptBindingIsExact({
        ...missingEvidence,
        ledgerAuthorization: { ...missingEvidence.ledgerAuthorization, evidenceBinding: undefined },
      } as never),
    ).toBe(false);
    const extraWire = exactReceipt();
    expect(
      validation.historicalReceiptBindingIsExact({
        ...extraWire,
        settlementChain: { ...extraWire.settlementChain, wires: [...extraWire.settlementChain.wires, extraWire.settlementChain.wires[0]] },
      } as never),
    ).toBe(false);
  });

  it('accepts only complete non-negative safe token usage', () => {
    expect(validation.completeUsage({ inputTokens: 0, outputTokens: 2 })).toBe(true);
    expect(validation.completeUsage({ inputTokens: undefined, outputTokens: 2 })).toBe(false);
    expect(validation.completeUsage({ inputTokens: -1, outputTokens: 2 })).toBe(false);
    expect(validation.completeUsage({ inputTokens: 1, outputTokens: 1.5 })).toBe(false);
    expect(validation.completeUsage({ inputTokens: 1, outputTokens: -1 })).toBe(false);
  });

  it('maps native protocols and rejects unsupported runtime values', () => {
    expect(validation.runtimeProtocol('openai-responses')).toBe('openai_responses');
    expect(validation.runtimeProtocol('openai-chat-completions')).toBe('openai_chat_completions');
    expect(validation.runtimeProtocol('anthropic-messages')).toBe('anthropic_messages');
    expect(() => validation.runtimeProtocol('other' as never)).toThrow('NATIVE_PROTOCOL_NOT_SUPPORTED');
  });

  it('extracts only object-shaped invalid structured output', () => {
    const error = (rawOutputText?: string) =>
      new NativeModelOutputError({
        protocol: 'openai-responses',
        requestedModel: 'model-a',
        rawOutputText,
      });
    expect(validation.invalidOutput(error('{"ok":true}'))).toEqual({ ok: true });
    expect(validation.invalidOutput(error())).toEqual({});
    expect(validation.invalidOutput(error('null'))).toEqual({});
    expect(validation.invalidOutput(error('[]'))).toEqual({});
    expect(validation.invalidOutput(error('{'))).toEqual({});
  });

  it('produces bounded native API failure reasons without response bodies', () => {
    expect(
      validation.nativeApiFailureReason(
        new NativeModelApiError({
          protocol: 'openai-responses',
          requestedModel: 'model-a',
          statusCode: 429,
          retryable: true,
          responseBodyDigest: 'a'.repeat(64),
          responseBodyBytes: 123,
        }),
        'settled',
      ),
    ).toBe(`native_api_failure_http_429:settled:body_sha256_${'a'.repeat(64)}:bytes_123`);
    expect(
      validation.nativeApiFailureReason(
        new NativeModelApiError({
          protocol: 'openai-responses',
          requestedModel: 'model-a',
          statusCode: 99,
          retryable: false,
          responseBodyDigest: 'bad',
          responseBodyBytes: -1,
        }),
        'request_id_missing',
      ),
    ).toBe('native_api_failure_http_unknown:request_id_missing');
    expect(
      validation.nativeApiFailureReason(
        new NativeModelApiError({ protocol: 'openai-responses', requestedModel: 'model-a', retryable: false }),
        'log_unavailable',
      ),
    ).toBe('native_api_failure_http_unknown:log_unavailable');
  });
});
