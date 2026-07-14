import { ModelProvider } from '../model-provider';
import { ProviderOutputError } from './provider-output-error';
import {
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  HealthStatus,
  ModelOp,
  ModelResult,
} from '../types';

export interface OpenAICompatConfig {
  id: string; // 'deepseek' | 'openai' | 'gemini' | 'volcengine'
  baseUrl: string;
  apiKey: string;
  model: string;
  embedModel?: string;
}

/** 剥 markdown 围栏（部分模型在 json_object 模式下仍偶发 ```json…``` 包裹结构化输出）。 */
export function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
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
    const { content, usage } = await this.chat(
      [
        { role: 'system', content: input.system ?? '' },
        { role: 'user', content: input.prompt },
      ],
      { model, maxTokens: input.maxTokens, temperature: input.temperature, reasoningEffort: input.reasoningEffort, signal: input.signal },
    );
    return { data: content, provider: this.id, model, usage };
  }

  async generateStructured<T = unknown>(input: GenerateStructuredInput): Promise<ModelResult<T>> {
    const model = input.model ?? this.cfg.model;
    const system = `${input.system ?? ''}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(input.schema)}`;
    const { content, usage, finishReason } = await this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      { model, maxTokens: input.maxTokens, temperature: 0, json: true, reasoningEffort: input.reasoningEffort, signal: input.signal },
    );
    if (!content.trim()) {
      // 显式空输出失败（M1 评测实证）：reasoning 模型 max_tokens 过小时思考吃光预算，
      // finish_reason=length 且 content 为空——给可诊断错误，而非 JSON.parse('') 的 SyntaxError。
      // 🔴 改动 2：携带 usage——空输出仍消耗了 token，网关 catch 据此结算（否则绕过硬预算上界）。
      throw new ProviderOutputError(
        `${this.id} ${model}: empty content (finish_reason=${finishReason ?? 'unknown'}) — reasoning 预算耗尽或输出被截断，检查 maxTokens/reasoning_effort`,
        usage,
      );
    }
    // 剥 markdown 围栏（真机实证：glm-5.2 在 json_object 模式下仍偶发 ```json…``` 包裹）。
    const payload = stripJsonFence(content);
    try {
      return { data: JSON.parse(payload) as T, provider: this.id, model, usage };
    } catch (err) {
      // JSON 解析失败三种同根因（都花了 token → 均带 usage 供网关结算，改动 2）：
      // ① finish_reason=length = 输出中途截断（真机实证：v4-pro「Unterminated string」）——显式指向 maxTokens。
      if (finishReason === 'length') {
        throw new ProviderOutputError(
          `${this.id} ${model}: output truncated at max_tokens (finish_reason=length), JSON incomplete — raise maxTokens`,
          usage,
          { cause: err },
        );
      }
      // ② 非截断的解析失败（模型返回非 JSON 文本）——保留原始 SyntaxError 为 cause，不误报截断。
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProviderOutputError(
        `${this.id} ${model}: structured output is not valid JSON — ${detail}`,
        usage,
        { cause: err },
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
    return { data: json.data.map((d) => d.embedding), provider: this.id, model: this.cfg.embedModel };
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  private async chat(
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
  }> {
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS) || 180_000;
    // 自身超时 + 调用方 signal（如 ai-task 的 per-task 超时）合并——任一触发即 abort fetch，
    // 不留后台弃单继续消耗 vendor tokens（复审 Temporal F1）。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal, // 模型调用必须有界（PRD 9.12）
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
    };
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
      finishReason: json.choices?.[0]?.finish_reason,
    };
  }
}
