import { describe, expect, it, vi } from 'vitest';
import { AiTraceSink } from './ai-trace.sink';
import type { PrismaService } from '../prisma/prisma.service';

describe('AiTraceSink', () => {
  it('persists a Site Builder execution policy snapshot in ai_trace.meta', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-1' }));
    const usageLedgerCreate = vi.fn(async () => ({}));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          aiTrace: { create: aiTraceCreate },
          usageLedger: { create: usageLedgerCreate },
        }),
      ),
    } as unknown as PrismaService;
    const sink = new AiTraceSink(prisma);

    sink.record({
      workspaceId: '00000000-0000-0000-0000-000000000001',
      task: 'site_builder.copy',
      op: 'generateStructured',
      provider: 'new-api',
      model: 'claude-sonnet-5',
      status: 'OK',
      latencyMs: 12,
      modelPolicy: {
        policyVersion: 'site-builder-model-policy/v1',
        profile: 'copy.premium',
        routeState: 'currentRoute',
        lifecycle: 'active',
        source: 'registry',
        dataPolicy: {
          transport: 'new_api_only',
          region: 'gateway_controlled',
          personalData: 'forbidden',
          dataScope: 'company_facts_only',
        },
        maxCostCents: 20,
        route: { primary: 'deepseek-v4-pro', fallbacks: ['glm-5.2'] },
        fallbackIndex: 1,
      },
    });

    await vi.waitFor(() => expect(aiTraceCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          modelPolicy: expect.objectContaining({
            profile: 'copy.premium',
            fallbackIndex: 1,
            route: { primary: 'deepseek-v4-pro', fallbacks: ['glm-5.2'] },
          }),
        },
      }),
    });
  });

  it('persists rejected-attempt tokens without creating a second usage-ledger row', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-error-1' }));
    const usageLedgerCreate = vi.fn(async () => ({}));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          aiTrace: { create: aiTraceCreate },
          usageLedger: { create: usageLedgerCreate },
        }),
      ),
    } as unknown as PrismaService;
    const sink = new AiTraceSink(prisma);

    sink.record({
      workspaceId: '00000000-0000-0000-0000-000000000001',
      task: 'site_builder.brand_profile',
      op: 'generateStructured',
      provider: 'new-api',
      model: 'gpt-5.6-terra',
      status: 'ERROR',
      errorMessage: 'task output hard gate rejected',
      latencyMs: 12,
      inputTokens: 7,
      outputTokens: 3,
    });

    await vi.waitFor(() => expect(aiTraceCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'ERROR',
        inputTokens: 7,
        outputTokens: 3,
      }),
    });
    expect(usageLedgerCreate).not.toHaveBeenCalled();
  });
});
