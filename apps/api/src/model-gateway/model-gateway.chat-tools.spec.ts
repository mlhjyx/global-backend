import { describe, expect, it, vi } from 'vitest';
import { BudgetLedger, InMemoryBudgetStoreAdapter } from '@global/test-support';
import { ModelGateway } from './model-gateway';
import { RouterModelGateway } from './router-model-gateway';
import type { ModelRouter } from './model-router';
import type { ModelProvider } from './model-provider';
import type { BudgetStore } from '../tools/budget-store';
import type { ChatResponse, ModelResult } from './types';

/**
 * WEB-1（v3.0 第 6 章 §6.3.9.4）：generateChatWithTools 的路由层契约——
 * 网关默认实现 fail-closed；路由器透传 provider 结果并让 messages/tools 参与预算幂等键。
 */

const CTX = { workspaceId: '11111111-1111-4111-8111-111111111111' };
const MESSAGES = [{ role: 'user', content: 'find pump importers' }] as const;
const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the public web.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
] as const;

const RESPONSE: ChatResponse = {
  text: 'answer',
  toolUses: [{ id: 'call_1', name: 'web_search', input: { query: 'q' } }],
  stopReason: 'tool_use',
};

function provider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'fake',
    supports: (op) => op !== 'embed' && op !== 'reviewVision',
    health: async () => ({ healthy: true }),
    generateText: vi.fn(async () => ({ data: 'ok', provider: 'fake', model: 'm' })),
    generateStructured: vi.fn(async () => ({ data: {}, provider: 'fake', model: 'm' })),
    reviewVision: vi.fn(),
    embed: vi.fn(),
    generateChatWithTools: vi.fn(
      async (): Promise<ModelResult<ChatResponse>> => ({
        data: RESPONSE,
        provider: 'fake',
        model: 'm',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ),
    ...overrides,
  } as unknown as ModelProvider;
}

function gatewayWith(target: ModelProvider, budget = new BudgetLedger()): RouterModelGateway {
  const router = { route: (op: string) => (target.supports(op as never) ? [target] : []) } as unknown as ModelRouter;
  return new RouterModelGateway(
    router,
    undefined,
    new InMemoryBudgetStoreAdapter(budget) as unknown as BudgetStore,
  );
}

describe('WEB-1：generateChatWithTools 网关契约', () => {
  it('ModelGateway 默认实现 fail-closed（CHAT_WITH_TOOLS_UNSUPPORTED）', async () => {
    class MinimalGateway extends ModelGateway {
      async generateText(): Promise<ModelResult<string>> {
        throw new Error('unused');
      }
      async generateStructured<T>(): Promise<ModelResult<T>> {
        throw new Error('unused');
      }
      async reviewVision<T>(): Promise<ModelResult<T>> {
        throw new Error('unused');
      }
      async embed(): Promise<ModelResult<number[][]>> {
        throw new Error('unused');
      }
    }
    const gateway = new MinimalGateway();
    await expect(
      gateway.generateChatWithTools({ task: 't', messages: [...MESSAGES], tools: [...TOOLS] }, CTX),
    ).rejects.toThrow('CHAT_WITH_TOOLS_UNSUPPORTED');
  });

  it('路由器把一轮工具调用透传给 provider，并返回封闭的 ChatResponse', async () => {
    const fake = provider();
    const gateway = gatewayWith(fake);
    const result = await gateway.generateChatWithTools(
      { task: 'research.account_research', messages: [...MESSAGES], tools: [...TOOLS] },
      CTX,
    );
    expect(result.data).toEqual(RESPONSE);
    expect(fake.generateChatWithTools).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'research.account_research' }),
      expect.anything(),
    );
  });

  it('provider 未实现该方法时（supports 返回 true 也不兜底）→ CHAT_WITH_TOOLS_UNSUPPORTED', async () => {
    const fake = provider({ generateChatWithTools: undefined });
    const gateway = gatewayWith(fake);
    await expect(
      gateway.generateChatWithTools({ task: 't', messages: [...MESSAGES], tools: [...TOOLS] }, CTX),
    ).rejects.toThrow('CHAT_WITH_TOOLS_UNSUPPORTED');
  });

  it('platformEgress 上下文下 fail-closed（R4 围栏 modelOp 白名单未扩列）', async () => {
    const fake = provider();
    const gateway = gatewayWith(fake);
    await expect(
      gateway.generateChatWithTools(
        { task: 't', messages: [...MESSAGES], tools: [...TOOLS] },
        {
          ...CTX,
          platformEgress: { authorizeAndDispatch: vi.fn() },
        } as never,
      ),
    ).rejects.toMatchObject({ code: 'CHAT_WITH_TOOLS_PLATFORM_EGRESS_UNSUPPORTED' });
    expect(fake.generateChatWithTools).not.toHaveBeenCalled();
  });

  it('provider 不支持该 op → 路由链为空（明确报错而非静默降级）', async () => {
    const fake = provider({ supports: () => false });
    const gateway = gatewayWith(fake);
    await expect(
      gateway.generateChatWithTools({ task: 't', messages: [...MESSAGES], tools: [...TOOLS] }, CTX),
    ).rejects.toThrow(/no model provider/u);
  });

  it('messages/tools 参与预算幂等键：同任务不同对话产生不同 operationKey', async () => {
    const reserve = vi.fn(async (input: { workspaceId: string; accountKey: string; operationKey: string; estimatedMicrousd: bigint }) => ({
      workspaceId: input.workspaceId,
      accountKey: input.accountKey,
      operationId: 'op',
      estimatedMicrousd: input.estimatedMicrousd,
      replay: false,
    }));
    const settle = vi.fn(async () => ({
      chargedMicrousd: 0n,
      observedMicrousd: 0n,
      capVariance: false,
      replay: false,
    }));
    const gateway = new RouterModelGateway(
      { route: () => [provider()] } as unknown as ModelRouter,
      undefined,
      { reserve, settle } as unknown as BudgetStore,
    );
    await gateway.generateChatWithTools({ task: 't', messages: [...MESSAGES], tools: [...TOOLS] }, CTX);
    await gateway.generateChatWithTools(
      { task: 't', messages: [{ role: 'user', content: 'another question' }], tools: [...TOOLS] },
      CTX,
    );
    const keys = reserve.mock.calls.map(([call]) => call.operationKey);
    // operationKey 是哈希；两次不同对话必须产生不同的键（重放可区分、不互相覆盖）。
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(new Set(keys).size).toBe(2);
  });
});
