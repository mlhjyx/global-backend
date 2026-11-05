import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归守卫（P4-P4c 真机缺陷之二）：平台 writer 身份在授权器里只允许
 * StartWorkflowExecution；SDK 的 Connection.connect 会先调用 GetSystemInfo 做连通性
 * 预检，被授权器拒绝（PLATFORM_TEMPORAL_READER_AUTH_DENIED），导致 startWorkflow
 * 永远不可用。PlatformTemporalClient 必须使用 Connection.lazy（无预检）。
 * 现有 spec 直接覆盖私有 connect，覆盖不到真实 SDK 工厂选择，这里 mock SDK 断言。
 */

const lazy = vi.fn((_options: unknown) => ({
  close: vi.fn(async () => undefined),
  workflowService: {},
}));
const connect = vi.fn((_options: unknown) => {
  throw new Error('Connection.connect must not be used for the writer identity');
});

vi.mock('@temporalio/client', () => ({
  Connection: class {
    static lazy = lazy;
    static connect = connect;
  },
  Client: class {},
}));

vi.mock('../platform-authority/machine-token-runtime', () => ({
  createRuntimeMachineTokenClient: vi.fn(async () => ({
    client: { currentToken: async () => 'test-token', close: vi.fn() },
    subject: 'platform-temporal-schedule-writer',
  })),
  temporalTlsConfiguration: vi.fn(async () => ({ address: '127.0.0.1:17233' })),
}));

vi.mock('../runtime/runtime-release-identity', () => ({
  currentRuntimeReleaseIdentity: vi.fn(async () => ({
    attested: true,
    artifact_digest: 'sha256:' + 'a'.repeat(64),
  })),
}));

describe('PlatformTemporalClient 连接工厂', () => {
  beforeEach(() => {
    lazy.mockClear();
    connect.mockClear();
  });

  it('使用 Connection.lazy 而不是 Connection.connect（避开 GetSystemInfo 预检）', async () => {
    const { PlatformTemporalClient } = await import('./platform-temporal.client');
    const client = new PlatformTemporalClient();
    const connection = await (
      client as unknown as { connect: () => Promise<unknown> }
    ).connect();
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    expect(connection).toBeDefined();
  });
});
