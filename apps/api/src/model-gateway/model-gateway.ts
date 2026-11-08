import {
  AiContext,
  EmbedInput,
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
