import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ActivityExecuteInput } from '@temporalio/worker';
import {
  candidateWorkflowIdsForLookup,
  expandPurgeWorkflowIds,
  formatLegacyWorkflowId,
  formatTenantWorkflowId,
  isTenantOrLegacyWorkflowId,
  parseTenantWorkflowId,
  workspaceIdFromWorkflowId,
} from './tenant-workflow-id';
import {
  BATCH_DISCOVERY_TASK_QUEUE,
  createTenantConcurrencyActivityInterceptor,
  INTERACTIVE_ONBOARDING_TASK_QUEUE,
  resolveCustomerTaskQueue,
  resolveWorkerCustomerTaskQueues,
  resolveWorkerPerTenantActivityConcurrency,
} from './tenant-task-queues';
import {
  AES_GCM_PAYLOAD_ENCODING,
  AesGcmPayloadCodec,
  resolveTemporalPayloadCodec,
  resolveTemporalPayloadCodecMode,
} from './payload-codec';
import {
  compactWorkflowPageText,
  scrubInlinePiiForWorkflowHistory,
} from './workflow-payload-hygiene';
import { UNDERSTANDING_TASK_QUEUE } from './understanding.constants';
import { combineQueueWorkers, resolveCustomerWorkerRuntimeSpec } from './worker-tenant-runtime';

const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

describe('Temporal M10-PR2 tenant workflowId, dual queue, PayloadCodec, and history hygiene', () => {
  it('formats and parses tenant-prefixed and legacy unprefixed workflowIds symmetrically', () => {
    const prefixed = formatTenantWorkflowId(WS_A, 'discovery', 'run-42');
    expect(prefixed).toBe(`ws:${WS_A}:discovery:run-42`);
    expect(parseTenantWorkflowId(prefixed)).toEqual({
      workspaceId: WS_A,
      type: 'discovery',
      id: 'run-42',
      legacy: false,
    });
    expect(workspaceIdFromWorkflowId(prefixed)).toBe(WS_A);

    const legacy = formatLegacyWorkflowId('discovery', 'run-42');
    expect(legacy).toBe('discovery-run-42');
    expect(parseTenantWorkflowId(legacy)).toEqual({
      workspaceId: null,
      type: 'discovery',
      id: 'run-42',
      legacy: true,
    });
    expect(candidateWorkflowIdsForLookup(WS_A, 'discovery', 'run-42')).toEqual([
      prefixed,
      legacy,
    ]);
    expect(isTenantOrLegacyWorkflowId(prefixed, WS_A, 'discovery', 'run-42')).toBe(true);
    expect(isTenantOrLegacyWorkflowId(legacy, WS_A, 'discovery', 'run-42')).toBe(true);
    expect(isTenantOrLegacyWorkflowId(`ws:${WS_B}:discovery:run-42`, WS_A, 'discovery', 'run-42')).toBe(false);

    // Rejects injection / delimiter spoofing
    expect(() => formatTenantWorkflowId('ws:evil', 'discovery', 'run-1')).toThrow(
      /TEMPORAL_WORKFLOW_ID_INVALID_WORKSPACE/,
    );
    expect(() => formatTenantWorkflowId(WS_A, 'bad:type', 'run-1')).toThrow(
      /TEMPORAL_WORKFLOW_ID_INVALID_TYPE/,
    );
  });

  it('expands purge targets to cancel both prefixed and legacy IDs while skipping self and foreign tenants', () => {
    const expanded = expandPurgeWorkflowIds(WS_A, [
      `workspace-purge-${WS_A}`,
      `ws:${WS_A}:workspace-purge:${WS_A}`,
      'discovery-run-1',
      `ws:${WS_A}:data-export:exp-9`,
      `ws:${WS_B}:discovery:foreign-run-99`,
      `ws:${WS_B}:site-refurbish:foreign-build-7`,
      'ws:malformed-unparsed',
    ]);
    expect(expanded).toContain(`ws:${WS_A}:discovery:run-1`);
    expect(expanded).toContain('discovery-run-1');
    expect(expanded).toContain(`ws:${WS_A}:data-export:exp-9`);
    expect(expanded).toContain('data-export-exp-9');
    expect(expanded).not.toContain(`workspace-purge-${WS_A}`);
    expect(expanded).not.toContain(`ws:${WS_A}:workspace-purge:${WS_A}`);
    expect(expanded).not.toContain(`ws:${WS_B}:discovery:foreign-run-99`);
    expect(expanded).not.toContain('discovery-foreign-run-99');
    expect(expanded).not.toContain(`ws:${WS_B}:site-refurbish:foreign-build-7`);
    expect(expanded).not.toContain('ws:malformed-unparsed');
  });

  it('routes interactive vs batch queues in split mode while preserving legacy default', () => {
    expect(resolveCustomerTaskQueue('interactive', {})).toBe(UNDERSTANDING_TASK_QUEUE);
    expect(resolveCustomerTaskQueue('batch', {})).toBe(UNDERSTANDING_TASK_QUEUE);
    expect(resolveWorkerCustomerTaskQueues({})).toEqual([UNDERSTANDING_TASK_QUEUE]);

    const splitEnv = { TEMPORAL_DUAL_QUEUE_MODE: 'split' };
    expect(resolveCustomerTaskQueue('interactive', splitEnv)).toBe(INTERACTIVE_ONBOARDING_TASK_QUEUE);
    expect(resolveCustomerTaskQueue('batch', splitEnv)).toBe(BATCH_DISCOVERY_TASK_QUEUE);
    expect(resolveWorkerCustomerTaskQueues(splitEnv)).toEqual([
      UNDERSTANDING_TASK_QUEUE,
      INTERACTIVE_ONBOARDING_TASK_QUEUE,
      BATCH_DISCOVERY_TASK_QUEUE,
    ]);
    expect(
      resolveWorkerCustomerTaskQueues({
        TEMPORAL_WORKER_TASK_QUEUES: 'interactive-onboarding, batch-discovery, interactive-onboarding',
      }),
    ).toEqual([INTERACTIVE_ONBOARDING_TASK_QUEUE, BATCH_DISCOVERY_TASK_QUEUE]);

    expect(resolveWorkerPerTenantActivityConcurrency({})).toBe(4);
    expect(
      resolveWorkerPerTenantActivityConcurrency({
        WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES: '2',
      }),
    ).toBe(2);
    expect(() =>
      resolveWorkerPerTenantActivityConcurrency({
        WORKER_PER_TENANT_MAX_CONCURRENT_ACTIVITIES: '0',
      }),
    ).toThrow(/WORKER_CONCURRENCY_INVALID/);
  });

  it('caps in-flight activities per tenant without stalling neighbor workspaces', async () => {
    const factory = createTenantConcurrencyActivityInterceptor({ maxPerTenant: 1 });
    const inbound = factory({} as never).inbound!;

    let releaseA1!: () => void;
    const a1Started = new Promise<void>((resolve) => {
      void inbound.execute(
        { args: [{ workspaceId: WS_A }], headers: {} } as ActivityExecuteInput,
        async () => {
          resolve();
          await new Promise<void>((r) => {
            releaseA1 = r;
          });
          return 'a1';
        },
      );
    });
    await a1Started;

    let a2Entered = false;
    const a2Promise = inbound.execute(
      { args: [{ workspaceId: WS_A }], headers: {} } as ActivityExecuteInput,
      async () => {
        a2Entered = true;
        return 'a2';
      },
    );

    // Neighbor WS_B and platform activity run immediately while WS_A's 2nd activity waits
    const bResult = await inbound.execute(
      { args: [{ workspaceId: WS_B }], headers: {} } as ActivityExecuteInput,
      async () => 'b1',
    );
    const platformResult = await inbound.execute(
      { args: [{ workspaceId: 'platform' }], headers: {} } as ActivityExecuteInput,
      async () => 'plat',
    );
    expect(bResult).toBe('b1');
    expect(platformResult).toBe('plat');
    expect(a2Entered).toBe(false);

    releaseA1();
    await expect(a2Promise).resolves.toBe('a2');
    expect(a2Entered).toBe(true);
  });

  it('encrypts/decrypts Temporal payloads with AES-256-GCM, supports keyring rotation, and enforces fail-closed mode', async () => {
    const k1 = randomBytes(32).toString('hex');
    const k2 = randomBytes(32).toString('base64');

    // Unconfigured defaults to off -> zero runtime breakage
    expect(resolveTemporalPayloadCodecMode({})).toBe('off');
    expect(resolveTemporalPayloadCodec({})).toBeUndefined();

    // Enforce without keys fails closed
    expect(() =>
      resolveTemporalPayloadCodec({ TEMPORAL_PAYLOAD_CODEC_MODE: 'enforce' }),
    ).toThrow('TEMPORAL_PAYLOAD_CODEC_KEYS_REQUIRED');

    const codecV1 = resolveTemporalPayloadCodec({
      TEMPORAL_PAYLOAD_CODEC_KEYS_JSON: JSON.stringify({ v1: k1 }),
      TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID: 'v1',
      TEMPORAL_PAYLOAD_CODEC_MODE: 'optional',
    });
    expect(codecV1).toBeInstanceOf(AesGcmPayloadCodec);

    const plaintextPayload = {
      metadata: { encoding: Buffer.from('json/plain', 'utf8') },
      data: Buffer.from(JSON.stringify({ workspaceId: WS_A, secret: 'buyer-note' }), 'utf8'),
    };
    const [encodedV1] = await codecV1!.encode([plaintextPayload]);
    expect(Buffer.from(encodedV1!.metadata!.encoding!).toString('utf8')).toBe(
      AES_GCM_PAYLOAD_ENCODING,
    );
    expect(Buffer.from(encodedV1!.metadata!['encryption-key-id']!).toString('utf8')).toBe('v1');
    expect(Buffer.from(encodedV1!.data!).toString('utf8')).not.toContain('buyer-note');

    // Rotate active key to v2 while keeping v1 in keyring -> decodes v1 payloads cleanly
    const codecV2Enforce = resolveTemporalPayloadCodec({
      TEMPORAL_PAYLOAD_CODEC_KEYS_JSON: JSON.stringify({ v1: k1, v2: k2 }),
      TEMPORAL_PAYLOAD_CODEC_ACTIVE_KEY_ID: 'v2',
      TEMPORAL_PAYLOAD_CODEC_MODE: 'enforce',
    })!;
    const [decodedFromV1] = await codecV2Enforce.decode([encodedV1!]);
    expect(Buffer.from(decodedFromV1!.data!).toString('utf8')).toContain('buyer-note');

    // Tampered ciphertext rejected via GCM auth tag
    const tampered = {
      ...encodedV1!,
      data: Buffer.from(encodedV1!.data!),
    };
    tampered.data[tampered.data.length - 1] ^= 0xff;
    await expect(codecV2Enforce.decode([tampered])).rejects.toThrow();

    // Optional mode allows legacy plaintext decode; enforce mode rejects unencrypted payloads
    const [legacyDecoded] = await codecV1!.decode([plaintextPayload]);
    expect(legacyDecoded).toBe(plaintextPayload);
    await expect(codecV2Enforce.decode([plaintextPayload])).rejects.toThrow(
      'TEMPORAL_PAYLOAD_UNENCRYPTED_REJECTED',
    );
  });

  it('bounds large crawled text while retaining footer context and redacts inline PII', () => {
    const body = `${'HEADER '.repeat(400)}${'MIDDLE '.repeat(5000)}IMPRESSUM VAT DE123456789`;
    const compacted = compactWorkflowPageText(body, 2_500);
    expect(compacted.truncated).toBe(true);
    expect(compacted.text.length).toBeLessThanOrEqual(2_500);
    expect(compacted.text).toContain('HEADER');
    expect(compacted.text).toContain('IMPRESSUM VAT DE123456789');
    expect(compacted.text).toContain('sha256=');

    const scrubbed = scrubInlinePiiForWorkflowHistory(
      'failed for alice.smith@buyer.example at https://www.linkedin.com/in/alice-smith-99/',
    );
    expect(scrubbed).not.toContain('alice.smith@buyer.example');
    expect(scrubbed).not.toContain('linkedin.com/in/alice-smith-99');
    expect(scrubbed).toContain('[redacted-email]');
    expect(scrubbed).toContain('[redacted-linkedin-profile]');
  });

  it('resolves unified worker runtime spec and coordinates multi-queue worker shutdown', async () => {
    const key = randomBytes(32).toString('hex');
    const spec = resolveCustomerWorkerRuntimeSpec({
      TEMPORAL_CUSTOMER_BACKEND_MODE: 'postgres_platform',
      TEMPORAL_CUSTOMER_ADDRESS: 'temporal-unified:7233',
      TEMPORAL_CUSTOMER_NAMESPACE: 'customer',
      TEMPORAL_DUAL_QUEUE_MODE: 'split',
      TEMPORAL_PAYLOAD_CODEC_KEY: key,
    });
    expect(spec.namespace).toBe('customer');
    expect(spec.primaryTaskQueue).toBe(UNDERSTANDING_TASK_QUEUE);
    expect(spec.auxiliaryTaskQueues).toEqual([
      INTERACTIVE_ONBOARDING_TASK_QUEUE,
      BATCH_DISCOVERY_TASK_QUEUE,
    ]);
    expect(spec.dataConverter.payloadCodecs).toHaveLength(1);

    // Dedicated single-queue Pod honors TEMPORAL_WORKER_TASK_QUEUES without polling `understanding`
    const dedicatedInteractive = resolveCustomerWorkerRuntimeSpec({
      TEMPORAL_WORKER_TASK_QUEUES: 'interactive-onboarding',
    });
    expect(dedicatedInteractive.primaryTaskQueue).toBe(INTERACTIVE_ONBOARDING_TASK_QUEUE);
    expect(dedicatedInteractive.auxiliaryTaskQueues).toEqual([]);

    const stopped: string[] = [];
    const combined = combineQueueWorkers(
      { run: async () => undefined, shutdown: () => { stopped.push('primary'); } },
      [{ run: async () => undefined, shutdown: () => { stopped.push('aux'); } }],
    );
    await combined.run();
    combined.shutdown();
    expect(stopped).toEqual(['primary', 'aux']);
  });
});
