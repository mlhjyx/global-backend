import { ModelProvider } from '../model-provider';
import { ProviderOutputError } from './provider-output-error';
import {
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  HealthStatus,
  ModelOp,
  ModelResolutionSource,
  ModelResult,
} from '../types';

/**
 * The application still has one gateway credential and one logical model name.
 * A gateway may, however, expose different vendor-native wire protocols behind
 * that same endpoint. Keep the choice explicit per model: a caller must never
 * infer it from a friendly model-name prefix at runtime.
 */
export type GatewayModelTransport = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';

export interface OpenAICompatConfig {
  id: string; // 'deepseek' | 'openai' | 'gemini' | 'volcengine'
  baseUrl: string;
  apiKey: string;
  model: string;
  embedModel?: string;
  /** Optional, explicit protocol override for models that have passed a protocol probe. */
  modelTransports?: Readonly<Record<string, GatewayModelTransport>>;
}

/** 剥 markdown 围栏（部分模型在 json_object 模式下仍偶发 ```json…``` 包裹结构化输出）。 */
export function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function resolutionProvenance(
  requestedModel: string,
  reportedModel?: string,
): {
  model: string;
  reportedModel?: string;
  modelResolutionSource: ModelResolutionSource;
} {
  return reportedModel
    ? {
        model: reportedModel,
        reportedModel,
        modelResolutionSource: 'upstream_response',
      }
    : {
        model: requestedModel,
        modelResolutionSource: 'requested_fallback',
      };
}

/**
 * One provider class for any OpenAI-compatible vendor — DeepSeek, OpenAI (GPT),
 * 火山引擎方舟 (Volcengine Ark), Gemini (OpenAI-compat endpoint). Configured
 * per vendor; register as many as you have keys for. The gateway routes across
 * them per task (ModelRouter + AI Task modelPolicy).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(private readonly cfg: OpenAICompatConfig) {
    this.id = cfg.id;
  }

  supports(op: ModelOp): boolean {
    if (op === 'embed') return !!this.cfg.embedModel;
    return op === 'generateText' || op === 'generateStructured';
  }

  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: this.cfg.model };
  }

  async generateText(input: GenerateTextInput): Promise<ModelResult<string>> {
    const model = input.model ?? this.cfg.model;
    const { content, usage, model: resolvedModel } = await this.complete(
      [
        { role: 'system', content: input.system ?? '' },
        { role: 'user', content: input.prompt },
      ],
      { model, maxTokens: input.maxTokens, temperature: input.temperature, reasoningEffort: input.reasoningEffort, signal: input.signal },
    );
    return { data: content, provider: this.id, ...resolutionProvenance(model, resolvedModel), usage };
  }

  async generateStructured<T = unknown>(input: GenerateStructuredInput): Promise<ModelResult<T>> {
    const model = input.model ?? this.cfg.model;
    const system = `${input.system ?? ''}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(input.schema)}`;
    const { content, usage, finishReason, model: resolvedModel } = await this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      { model, maxTokens: input.maxTokens, temperature: 0, json: true, reasoningEffort: input.reasoningEffort, signal: input.signal },
    );
    if (!content.trim()) {
      // Empty content is an explicit failure, not JSON.parse(''). A length
      // finish can indicate an exhausted reasoning/output budget; a stop
      // finish instead means the OpenAI-compatible response exposed no visible
      // content despite completing, which is a distinct gateway/model issue.
      // 🔴 改动 2：携带 usage——空输出仍消耗了 token，网关 catch 据此结算（否则绕过硬预算上界）。
      const cause =
        finishReason === 'length'
          ? 'reasoning budget exhausted or output truncated; check maxTokens/reasoningEffort'
          : 'upstream returned no visible message content; inspect OpenAI-compatible content/reasoning mapping';
      throw new ProviderOutputError(
        `${this.id} ${model}: empty content (finish_reason=${finishReason ?? 'unknown'}) — ${cause}`,
        usage,
        { provider: this.id, ...resolutionProvenance(model, resolvedModel) },
      );
    }
    // 剥 markdown 围栏（真机实证：glm-5.2 在 json_object 模式下仍偶发 ```json…``` 包裹）。
    const payload = stripJsonFence(content);
    try {
      return {
        data: JSON.parse(payload) as T,
        provider: this.id,
        ...resolutionProvenance(model, resolvedModel),
        usage,
      };
    } catch (err) {
      // JSON 解析失败三种同根因（都花了 token → 均带 usage 供网关结算，改动 2）：
      // ① finish_reason=length = 输出中途截断（真机实证：v4-pro「Unterminated string」）——显式指向 maxTokens。
      if (finishReason === 'length') {
        throw new ProviderOutputError(
          `${this.id} ${model}: output truncated at max_tokens (finish_reason=length), JSON incomplete — raise maxTokens`,
          usage,
          { cause: err, provider: this.id, ...resolutionProvenance(model, resolvedModel) },
        );
      }
      // ② 非截断的解析失败（模型返回非 JSON 文本）——保留原始 SyntaxError 为 cause，不误报截断。
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProviderOutputError(
        `${this.id} ${model}: structured output is not valid JSON — ${detail}`,
        usage,
        { cause: err, provider: this.id, ...resolutionProvenance(model, resolvedModel) },
      );
    }
  }

  async embed(input: EmbedInput): Promise<ModelResult<number[][]>> {
    if (!this.cfg.embedModel) throw new Error(`${this.id}: embeddings not configured`);
    const res = await fetch(`${this.cfg.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: this.cfg.embedModel, input: input.input }),
    });
    if (!res.ok) throw new Error(`${this.id} embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return {
      data: json.data.map((d) => d.embedding),
      provider: this.id,
      model: this.cfg.embedModel,
      modelResolutionSource: 'requested_fallback',
    };
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  private async complete(
    messages: { role: string; content: string }[],
    opts: {
      model: string;
      maxTokens?: number;
      temperature?: number;
      json?: boolean;
      reasoningEffort?: 'low' | 'medium' | 'high';
      signal?: AbortSignal;
    },
  ): Promise<{
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    finishReason?: string;
    /** OpenAI-compatible gateways may expose the post-alias/upstream model here. */
    model?: string;
  }> {
    const transport = this.cfg.modelTransports?.[opts.model] ?? 'openai-chat-completions';
    switch (transport) {
      case 'openai-chat-completions':
        return this.chatCompletions(messages, opts);
      case 'openai-responses':
        return this.responses(messages, opts);
      case 'anthropic-messages':
        return this.anthropicMessages(messages, opts);
    }
  }

  /** Combines the process-wide ceiling with the task's per-call cancellation. */
  private requestSignal(signal?: AbortSignal): AbortSignal {
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 180_000;
    // 自身超时 + 调用方 signal（如 ai-task 的 per-task 超时）合并——任一触发即 abort fetch，
    // 不留后台弃单继续消耗 vendor tokens（复审 Temporal F1）。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
  }

  private async chatCompletions(
    messages: { role: string; content: string }[],
    opts: {
      model: string;
      maxTokens?: number;
      temperature?: number;
      json?: boolean;
      reasoningEffort?: 'low' | 'medium' | 'high';
      signal?: AbortSignal;
    },
  ): Promise<{
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    finishReason?: string;
    model?: string;
  }> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal: this.requestSignal(opts.signal), // 模型调用必须有界（PRD 9.12）
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      finishReason: json.choices?.[0]?.finish_reason,
      model: json.model?.trim() || undefined,
    };
  }

  /**
   * GPT-family native Responses API. New API's helper `output_text` is not
   * consistently populated, so the canonical source is the typed nested
   * `output[].content[]` list; the helper remains a backward-compatible
   * fallback. This has been capability-probed through the current gateway.
   */
  private async responses(
    messages: { role: string; content: string }[],
    opts: {
      model: string;
      maxTokens?: number;
      temperature?: number;
      json?: boolean;
      reasoningEffort?: 'low' | 'medium' | 'high';
      signal?: AbortSignal;
    },
  ): Promise<{
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    finishReason?: string;
    model?: string;
  }> {
    const res = await fetch(`${this.cfg.baseUrl}/responses`, {
      method: 'POST',
      headers: this.headers(),
      signal: this.requestSignal(opts.signal),
      body: JSON.stringify({
        model: opts.model,
        // New API transparently forwards the standard Responses message form.
        input: messages,
        max_output_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { text: { format: { type: 'json_object' } } } : {}),
        ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      output?: { content?: { type?: string; text?: string }[] }[];
      output_text?: string;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const nestedContent = (json.output ?? [])
      .flatMap((item) => item.content ?? [])
      .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('');
    const usage = { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens };
    if (json.status !== 'completed') {
      throw new ProviderOutputError(
        `${this.id} ${opts.model}: Responses request did not complete (status=${json.status ?? 'unknown'})`,
        usage,
        { provider: this.id, ...resolutionProvenance(opts.model, json.model?.trim() || undefined) },
      );
    }
    return {
      content: nestedContent || json.output_text || '',
      usage,
      // Preserve the existing ProviderOutputError branch vocabulary.
      finishReason: 'stop',
      model: json.model?.trim() || undefined,
    };
  }

  /**
   * Claude is materially better served by its native Messages protocol. The
   * gateway keeps the same base URL and credential, but this request must use
   * Anthropic headers and read only `text` blocks (never expose thinking
   * blocks as model output).
   */
  private async anthropicMessages(
    messages: { role: string; content: string }[],
    opts: {
      model: string;
      maxTokens?: number;
      temperature?: number;
      json?: boolean;
      reasoningEffort?: 'low' | 'medium' | 'high';
      signal?: AbortSignal;
    },
  ): Promise<{
    content: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    finishReason?: string;
    model?: string;
  }> {
    if (opts.maxTokens === undefined) {
      throw new Error(`${this.id} ${opts.model}: maxTokens is required for anthropic-messages transport`);
    }
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        // Callers currently construct system/user messages only. Keep an
        // explicit conversion boundary instead of leaking arbitrary roles.
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: message.content,
      }));
    const res = await fetch(`${this.cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: this.requestSignal(opts.signal),
      body: JSON.stringify({
        model: opts.model,
        ...(system ? { system } : {}),
        messages: conversation,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const usage = { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens };
    if (json.stop_reason === 'max_tokens' || json.stop_reason === 'model_context_window_exceeded') {
      throw new ProviderOutputError(
        `${this.id} ${opts.model}: Claude response truncated (stop_reason=${json.stop_reason})`,
        usage,
        { provider: this.id, ...resolutionProvenance(opts.model, json.model?.trim() || undefined) },
      );
    }
    return {
      content: (json.content ?? [])
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => item.text ?? '')
        .join(''),
      usage,
      finishReason: json.stop_reason === 'end_turn' ? 'stop' : json.stop_reason,
      model: json.model?.trim() || undefined,
    };
  }
}
