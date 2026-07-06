import { ModelProvider } from '../model-provider';
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
      { model, maxTokens: input.maxTokens, temperature: input.temperature },
    );
    return { data: content, provider: this.id, model, usage };
  }

  async generateStructured<T = unknown>(input: GenerateStructuredInput): Promise<ModelResult<T>> {
    const model = input.model ?? this.cfg.model;
    const system = `${input.system ?? ''}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(input.schema)}`;
    const { content, usage } = await this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      { model, maxTokens: input.maxTokens, temperature: 0, json: true },
    );
    return { data: JSON.parse(content) as T, provider: this.id, model, usage };
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
    opts: { model: string; maxTokens?: number; temperature?: number; json?: boolean },
  ): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.id} ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  }
}
