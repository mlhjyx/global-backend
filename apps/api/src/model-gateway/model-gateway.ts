import {
  AiContext,
  ChatResponse,
  EmbedInput,
  GenerateChatWithToolsInput,
  GenerateStructuredInput,
  GenerateTextInput,
  ModelResult,
  ReviewVisionInput,
} from './types';

/**
 * The single unified API business code depends on (PRD 9.5 / 9.12). Behind it:
 * many providers, routed and aggregated with fallback. Swapping providers — or
 * the whole LiteLLM kernel — never changes callers.
 */
export abstract class ModelGateway {
  abstract generateText(input: GenerateTextInput, ctx: AiContext): Promise<ModelResult<string>>;
  abstract generateStructured<T = unknown>(
    input: GenerateStructuredInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>>;
  abstract reviewVision<T = unknown>(
    input: ReviewVisionInput,
    ctx: AiContext,
  ): Promise<ModelResult<T>>;
  abstract embed(input: EmbedInput, ctx: AiContext): Promise<ModelResult<number[][]>>;

  /**
   * WEB-1：带工具定义的一轮对话（模型可返回 tool_use，由平台执行后回填 tool 消息）。
   *
   * 默认实现必须写成**实例方法**（不是属性）：`useDefineForClassFields` 下属性声明
   * 会给每个实例定义同名 undefined 字段，遮蔽子类原型上的实现（见 settleCachedStructured
   * 的注释与仓库既有教训）。不支持 tool_calls 的网关沿用此默认实现即 fail-closed。
   */
  async generateChatWithTools(
    _input: GenerateChatWithToolsInput,
    _ctx: AiContext,
  ): Promise<ModelResult<ChatResponse>> {
    throw new Error('CHAT_WITH_TOOLS_UNSUPPORTED');
  }
  /**
   * PR-B：把 LLM 缓存命中的结果按真实调用同构地记入持久账本并产出 receipt。
   * 无外呼：reserve(0) → projection/receiptFacts → settle(0) → onDurableReceipt。
   * 未实现的网关（测试桩）省略此方法，调用方在需要收据时须按 miss 处理。
   * 注意：必须写成可选「方法」签名而不是属性（`?: (...) =>`）。属性声明在
   * useDefineForClassFields 下会给每个实例定义同名 undefined 字段，遮蔽子类
   * 原型上的实现，`gateway.settleCachedStructured` 恒为 undefined。
   */
  settleCachedStructured?<T>(
    input: GenerateStructuredInput,
    context: AiContext,
    cached: Readonly<{ data: T; model: string }>,
  ): Promise<ModelResult<T>>;
}
