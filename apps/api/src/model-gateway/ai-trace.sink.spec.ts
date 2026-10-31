import { describe, expect, it, vi } from 'vitest';
import { AiTraceSink } from './ai-trace.sink';
import type { PrismaService } from '../prisma/prisma.service';

describe('AiTraceSink', () => {
  it('persists the ledger operation and budget disposition of a failed call in ai_trace.meta (D13)', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-d13' }));
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({ aiTrace: { create: aiTraceCreate }, usageLedger: { create: vi.fn() } }),
      ),
    } as unknown as PrismaService;

    new AiTraceSink(prisma).record({
      workspaceId: '00000000-0000-0000-0000-000000000001',
      task: 'discovery.extract_company',
      op: 'generateStructured',
      provider: 'gateway',
      model: 'deepseek-v4-pro',
      status: 'ERROR',
      errorMessage: 'ProviderTransportError:CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR',
      latencyMs: 31_527,
      budgetOperationId: '7d5e8f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6',
      budgetDisposition: 'RELEASED_DEFINITE_FAILURE',
    });

    await vi.waitFor(() => expect(aiTraceCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          budgetOperationId: '7d5e8f1a-2b3c-4d5e-8f90-a1b2c3d4e5f6',
          budgetDisposition: 'RELEASED_DEFINITE_FAILURE',
        },
      }),
    });
  });

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

  it('names a substitute model and keeps the requested model beside it (D14)', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-substitute-1' }));
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
      task: 'discovery.qualify_fit',
      op: 'generateStructured',
      provider: 'gateway',
      model: 'deepseek-v4-flash',
      status: 'OK',
      latencyMs: 12,
      inputTokens: 7,
      outputTokens: 3,
      modelSubstitution: {
        requestedModel: 'deepseek-v4-pro',
        substituteModels: ['deepseek-v4-flash'],
      },
    });

    await vi.waitFor(() => expect(usageLedgerCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'deepseek-v4-flash',
        meta: {
          requestedModel: 'deepseek-v4-pro',
          modelSubstituted: true,
          substituteModels: ['deepseek-v4-flash'],
        },
      }),
    });
    expect(usageLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: 'discovery.qualify_fit',
          model: 'deepseek-v4-flash',
          requestedModel: 'deepseek-v4-pro',
          modelSubstituted: true,
          substituteModels: ['deepseek-v4-flash'],
        },
      }),
    });
  });

  it('marks an answer whose identity the upstream never stated (D14)', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-unproven-1' }));
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
      task: 'discovery.qualify_fit',
      op: 'generateStructured',
      provider: 'gateway',
      model: 'deepseek-v4-pro',
      status: 'OK',
      latencyMs: 12,
      inputTokens: 7,
      outputTokens: 3,
      modelIdentityUnproven: true,
    });

    await vi.waitFor(() => expect(usageLedgerCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'deepseek-v4-pro',
        meta: { modelIdentityUnproven: true },
      }),
    });
    expect(usageLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: {
          task: 'discovery.qualify_fit',
          model: 'deepseek-v4-pro',
          modelIdentityUnproven: true,
        },
      }),
    });
  });

  it('writes no substitution marker for an exact identity', async () => {
    const aiTraceCreate = vi.fn(async () => ({ id: 'trace-exact-1' }));
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
      task: 'discovery.qualify_fit',
      op: 'generateStructured',
      provider: 'gateway',
      model: 'deepseek-v4-pro',
      status: 'OK',
      latencyMs: 12,
      inputTokens: 7,
      outputTokens: 3,
    });

    await vi.waitFor(() => expect(usageLedgerCreate).toHaveBeenCalledTimes(1));
    expect(aiTraceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ model: 'deepseek-v4-pro', meta: undefined }),
    });
    expect(usageLedgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meta: { task: 'discovery.qualify_fit', model: 'deepseek-v4-pro' },
      }),
    });
  });
});
