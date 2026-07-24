import { createHash } from 'node:crypto';
import { ModelProvider } from '../model-provider';
import { ProviderHttpError, ProviderIdentityError, ProviderOutputError } from './provider-output-error';
import {
  EmbedInput,
  GenerateStructuredInput,
  GenerateTextInput,
  HealthStatus,
  ModelOp,
  ModelResolutionSource,
  ModelResult,
  ReviewVisionInput,
  VISION_REVIEW_MATERIAL_CLASSES,
} from '../types';
import { snapshotVisionReviewInput } from '../vision-review-input';

/**
 * The application still has one gateway credential and one logical model name.
 * A gateway may, however, expose different vendor-native wire protocols behind
 * that same endpoint. Keep the choice explicit per model: a caller must never
 * infer it from a friendly model-name prefix at runtime.
 */
export type GatewayModelTransport = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages';
export type GatewayVisionTransport =
  'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generate-content';

export interface OpenAICompatConfig {
  id: string; // 'deepseek' | 'openai' | 'gemini' | 'volcengine'
  baseUrl: string;
  apiKey: string;
  model: string;
  embedModel?: string;
  /** Optional, explicit protocol override for models that have passed a protocol probe. */
  modelTransports?: Readonly<Record<string, GatewayModelTransport>>;
  /**
   * Explicit vision request adapters. Presence is not capability evidence:
   * MODEL-1 must still probe the live endpoint before route promotion.
   */
  visionModelTransports?: Readonly<Record<string, GatewayVisionTransport>>;
  /**
   * Immutable repository fixture identity -> SHA-256. Runtime providers omit
   * this; PR6 supplies the reviewed fixture catalog to its evaluation client.
   */
  visionEvalFixtureDigests?: Readonly<Record<string, string>>;
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

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_VISION_IMAGES = 3;
const MAX_VISION_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 6 * 1024 * 1024;
const BOUNDED_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function assertVisionReviewInput(input: ReviewVisionInput, evalFixtureDigests: ReadonlyMap<string, string>): void {
  let schemaBytes = Number.POSITIVE_INFINITY;
  try {
    schemaBytes = JSON.stringify(input.schema).length;
  } catch {
    // Cyclic or otherwise non-JSON schemas are never sent to the provider.
  }
  if (
    Object.keys(input as unknown as Record<string, unknown>).some(
      (key) =>
        ![
          'task',
          'prompt',
          'system',
          'model',
          'schema',
          'images',
          'validateOutput',
          'maxTokens',
          'maxCostCents',
          'signal',
        ].includes(key),
    ) ||
    !['site_builder.aesthetic_review', 'site_builder.aesthetic_review.eval'].includes(input.task) ||
    !BOUNDED_TOKEN.test(input.task) ||
    !BOUNDED_TOKEN.test(input.model) ||
    typeof input.prompt !== 'string' ||
    input.prompt.length < 1 ||
    input.prompt.length > 32_000 ||
    (input.system !== undefined && (typeof input.system !== 'string' || input.system.length > 16_000)) ||
    !input.schema ||
    typeof input.schema !== 'object' ||
    Array.isArray(input.schema) ||
    schemaBytes > 64_000 ||
    !Number.isInteger(input.maxTokens) ||
    (input.maxTokens ?? 0) < 1 ||
    (input.maxTokens ?? 0) > 16_000 ||
    !Number.isInteger(input.maxCostCents) ||
    input.maxCostCents < 1 ||
    input.maxCostCents > 100 ||
    !Array.isArray(input.images) ||
    input.images.length < 1 ||
    input.images.length > MAX_VISION_IMAGES
  ) {
    throw new Error('VISION_REVIEW_INPUT_INVALID');
  }

  let totalBytes = 0;
  const artifactIds = new Set<string>();
  for (const image of input.images) {
    const runtime = image as unknown as Record<string, unknown>;
    if ('url' in runtime || 'imageUrl' in runtime || 'path' in runtime) {
      throw new Error('VISION_REVIEW_REMOTE_OR_PATH_INPUT_FORBIDDEN');
    }
    if (
      Object.keys(runtime).some(
        (key) => !['materialClass', 'workspaceId', 'artifactId', 'sha256', 'mimeType', 'bytes', 'target'].includes(key),
      ) ||
      !VISION_REVIEW_MATERIAL_CLASSES.includes(image.materialClass) ||
      (image.materialClass === 'workspace_site_screenshot'
        ? !image.workspaceId || !BOUNDED_TOKEN.test(image.workspaceId)
        : image.workspaceId !== undefined) ||
      (input.task === 'site_builder.aesthetic_review.eval'
        ? image.materialClass !== 'model_eval_fixture'
        : image.materialClass !== 'workspace_site_screenshot') ||
      !BOUNDED_TOKEN.test(image.artifactId) ||
      artifactIds.has(image.artifactId) ||
      !SHA256.test(image.sha256) ||
      image.mimeType !== 'image/png' ||
      !(image.bytes instanceof Uint8Array) ||
      image.bytes.byteLength < PNG_SIGNATURE.length ||
      image.bytes.byteLength > MAX_VISION_IMAGE_BYTES ||
      PNG_SIGNATURE.some((byte, index) => image.bytes[index] !== byte) ||
      !image.target ||
      Object.keys(image.target).some((key) => !['locale', 'pageId', 'breakpoint'].includes(key)) ||
      !BOUNDED_TOKEN.test(image.target.locale) ||
      !BOUNDED_TOKEN.test(image.target.pageId) ||
      ![375, 768, 1440].includes(image.target.breakpoint)
    ) {
      throw new Error('VISION_REVIEW_IMAGE_INVALID');
    }
    const actualDigest = createHash('sha256').update(image.bytes).digest('hex');
    if (actualDigest !== image.sha256) {
      throw new Error('VISION_REVIEW_IMAGE_DIGEST_MISMATCH');
    }
    if (image.materialClass === 'model_eval_fixture' && evalFixtureDigests.get(image.artifactId) !== actualDigest) {
      throw new Error('VISION_REVIEW_EVAL_FIXTURE_UNAUTHORIZED');
    }
    artifactIds.add(image.artifactId);
    totalBytes += image.bytes.byteLength;
  }
  if (totalBytes > MAX_VISION_TOTAL_BYTES) {
    throw new Error('VISION_REVIEW_IMAGE_BUDGET_EXCEEDED');
  }
}

/**
 * One provider class for any OpenAI-compatible vendor — DeepSeek, OpenAI (GPT),
 * 火山引擎方舟 (Volcengine Ark), Gemini (OpenAI-compat endpoint). Configured
 * per vendor; register as many as you have keys for. The gateway routes across
 * them per task (ModelRouter + AI Task modelPolicy).
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  private readonly cfg: OpenAICompatConfig;
  private readonly visionEvalFixtureDigests: ReadonlyMap<string, string>;

  constructor(cfg: OpenAICompatConfig) {
    this.id = cfg.id;
    this.cfg = {
      ...cfg,
      ...(cfg.modelTransports ? { modelTransports: Object.freeze({ ...cfg.modelTransports }) } : {}),
      ...(cfg.visionModelTransports
        ? {
            visionModelTransports: Object.freeze({
              ...cfg.visionModelTransports,
            }),
          }
        : {}),
      // The private Map below is the sole runtime authority.
      visionEvalFixtureDigests: undefined,
    };
    this.visionEvalFixtureDigests = new Map(Object.entries(cfg.visionEvalFixtureDigests ?? {}));
  }

  supports(op: ModelOp): boolean {
    if (op === 'embed') return !!this.cfg.embedModel;
    if (op === 'reviewVision') {
      return Object.keys(this.cfg.visionModelTransports ?? {}).length > 0;
    }
    return op === 'generateText' || op === 'generateStructured';
  }

  async health(): Promise<HealthStatus> {
    return { healthy: true, detail: this.cfg.model };
  }

  async generateText(input: GenerateTextInput): Promise<ModelResult<string>> {
    const model = input.model ?? this.cfg.model;
    const {
      content,
      usage,
      model: resolvedModel,
    } = await this.complete(
      [
        { role: 'system', content: input.system ?? '' },
        { role: 'user', content: input.prompt },
      ],
      {
        model,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        reasoningEffort: input.reasoningEffort,
        signal: input.signal,
      },
    );
    return {
      data: content,
      provider: this.id,
      ...resolutionProvenance(model, resolvedModel),
      usage,
    };
  }

  async generateStructured<T = unknown>(input: GenerateStructuredInput): Promise<ModelResult<T>> {
    const model = input.model ?? this.cfg.model;
    const system = `${input.system ?? ''}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(input.schema)}`;
    const {
      content,
      usage,
      finishReason,
      model: resolvedModel,
    } = await this.complete(
      [
        { role: 'system', content: system },
        { role: 'user', content: input.prompt },
      ],
      {
        model,
        maxTokens: input.maxTokens,
        temperature: 0,
        json: true,
        reasoningEffort: input.reasoningEffort,
        signal: input.signal,
      },
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
        {
          provider: this.id,
          ...resolutionProvenance(model, resolvedModel),
        },
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
          {
            cause: err,
            provider: this.id,
            ...resolutionProvenance(model, resolvedModel),
          },
        );
      }
      // ② 非截断的解析失败（模型返回非 JSON 文本）——保留原始 SyntaxError 为 cause，不误报截断。
      const detail = err instanceof Error ? err.message : String(err);
      throw new ProviderOutputError(`${this.id} ${model}: structured output is not valid JSON — ${detail}`, usage, {
        cause: err,
        provider: this.id,
        ...resolutionProvenance(model, resolvedModel),
      });
    }
  }

  async reviewVision<T = unknown>(input: ReviewVisionInput): Promise<ModelResult<T>> {
    const snapshot = snapshotVisionReviewInput(input);
    assertVisionReviewInput(snapshot, this.visionEvalFixtureDigests);
    const transport = this.cfg.visionModelTransports?.[snapshot.model];
    if (!transport) {
      throw new Error(`VISION_REVIEW_MODEL_TRANSPORT_UNPROVEN: ${snapshot.model}`);
    }
    switch (transport) {
      case 'openai-chat-completions':
        return this.reviewVisionChatCompletions<T>(snapshot);
      case 'openai-responses':
        return this.reviewVisionResponses<T>(snapshot);
      case 'anthropic-messages':
        return this.reviewVisionAnthropicMessages<T>(snapshot);
      case 'google-generate-content':
        return this.reviewVisionGoogleGenerateContent<T>(snapshot);
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
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
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
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
      finishReason: json.choices?.[0]?.finish_reason,
      model: json.model?.trim() || undefined,
    };
  }

  private async reviewVisionChatCompletions<T>(input: ReviewVisionInput): Promise<ModelResult<T>> {
    const system = `${input.system ?? ''}\n只返回符合以下 JSON Schema 的合法 JSON，不要任何多余文本或解释：\n${JSON.stringify(input.schema)}`;
    const content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image_url';
          image_url: { url: string; detail: 'high' };
        }
    > = [{ type: 'text', text: input.prompt }];
    for (const image of input.images) {
      content.push({
        type: 'text',
        text: `受控输入 ${image.artifactId}: locale=${image.target.locale}, page=${image.target.pageId}, breakpoint=${image.target.breakpoint}`,
      });
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64')}`,
          detail: 'high',
        },
      });
    }
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      signal: this.requestSignal(input.signal),
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content },
        ],
        max_tokens: input.maxTokens,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      throw new ProviderHttpError({
        status: res.status,
        provider: this.id,
        model: input.model,
        responseExcerpt: (await res.text()).slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const usage = {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
    const reportedModel = json.model?.trim() || undefined;
    const provenance = resolutionProvenance(input.model, reportedModel);
    if (!reportedModel || reportedModel !== input.model) {
      throw new ProviderIdentityError(
        `VISION_REVIEW_MODEL_IDENTITY_MISMATCH: requested=${input.model}, reported=${reportedModel ?? 'missing'}`,
        usage,
        {
          provider: this.id,
          ...provenance,
        },
      );
    }
    const finishReason = json.choices?.[0]?.finish_reason;
    const raw = json.choices?.[0]?.message?.content ?? '';
    if (finishReason === 'length') {
      throw new ProviderOutputError('VISION_REVIEW_OUTPUT_TRUNCATED', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    if (finishReason !== 'stop') {
      throw new ProviderOutputError(`VISION_REVIEW_FINISH_REASON_INVALID: ${finishReason ?? 'missing'}`, usage, {
        provider: this.id,
        ...provenance,
      });
    }
    if (!raw.trim()) {
      throw new ProviderOutputError('VISION_REVIEW_EMPTY_OUTPUT: finish_reason=stop', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    try {
      return {
        data: JSON.parse(stripJsonFence(raw)) as T,
        provider: this.id,
        ...provenance,
        usage,
      };
    } catch (error) {
      throw new ProviderOutputError(
        `VISION_REVIEW_OUTPUT_NOT_JSON: ${error instanceof Error ? error.message : String(error)}`,
        usage,
        {
          cause: error,
          provider: this.id,
          ...provenance,
        },
      );
    }
  }

  private async reviewVisionResponses<T>(input: ReviewVisionInput): Promise<ModelResult<T>> {
    const content: Array<
      { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'high' }
    > = [{ type: 'input_text', text: input.prompt }];
    for (const image of input.images) {
      content.push({
        type: 'input_text',
        text: `Controlled input ${image.artifactId}: locale=${image.target.locale}, page=${image.target.pageId}, breakpoint=${image.target.breakpoint}`,
      });
      content.push({
        type: 'input_image',
        image_url: `data:image/png;base64,${Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64')}`,
        detail: 'high',
      });
    }
    const res = await fetch(`${this.cfg.baseUrl}/responses`, {
      method: 'POST',
      headers: this.headers(),
      signal: this.requestSignal(input.signal),
      body: JSON.stringify({
        model: input.model,
        input: [
          ...(input.system
            ? [
                {
                  role: 'system',
                  content: [{ type: 'input_text', text: input.system }],
                },
              ]
            : []),
          { role: 'user', content },
        ],
        max_output_tokens: input.maxTokens,
        temperature: 0,
        text: {
          format: {
            type: 'json_schema',
            name: 'design_evaluation',
            strict: true,
            schema: input.schema,
          },
        },
      }),
    });
    if (!res.ok) {
      throw new ProviderHttpError({
        status: res.status,
        provider: this.id,
        model: input.model,
        responseExcerpt: (await res.text()).slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      output?: { content?: { type?: string; text?: string }[] }[];
      output_text?: string;
      status?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    const reportedModel = json.model?.trim() || undefined;
    const provenance = resolutionProvenance(input.model, reportedModel);
    if (!reportedModel || reportedModel !== input.model) {
      throw new ProviderIdentityError(
        `VISION_REVIEW_MODEL_IDENTITY_MISMATCH: requested=${input.model}, reported=${reportedModel ?? 'missing'}`,
        usage,
        {
          provider: this.id,
          ...provenance,
        },
      );
    }
    if (json.status !== 'completed') {
      throw new ProviderOutputError(`VISION_REVIEW_FINISH_REASON_INVALID: ${json.status ?? 'missing'}`, usage, {
        provider: this.id,
        ...provenance,
      });
    }
    const raw =
      (json.output ?? [])
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === 'output_text' && typeof item.text === 'string')
        .map((item) => item.text ?? '')
        .join('') ||
      json.output_text ||
      '';
    if (!raw.trim()) {
      throw new ProviderOutputError('VISION_REVIEW_EMPTY_OUTPUT: status=completed', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    try {
      return {
        data: JSON.parse(stripJsonFence(raw)) as T,
        provider: this.id,
        ...provenance,
        usage,
      };
    } catch (error) {
      throw new ProviderOutputError(
        `VISION_REVIEW_OUTPUT_NOT_JSON: ${error instanceof Error ? error.message : String(error)}`,
        usage,
        {
          cause: error,
          provider: this.id,
          ...provenance,
        },
      );
    }
  }

  private async reviewVisionAnthropicMessages<T>(input: ReviewVisionInput): Promise<ModelResult<T>> {
    const content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: 'image/png';
            data: string;
          };
        }
    > = [{ type: 'text', text: input.prompt }];
    for (const image of input.images) {
      content.push({
        type: 'text',
        text: `Controlled input ${image.artifactId}: locale=${image.target.locale}, page=${image.target.pageId}, breakpoint=${image.target.breakpoint}`,
      });
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64'),
        },
      });
    }
    const res = await fetch(`${this.cfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: this.requestSignal(input.signal),
      body: JSON.stringify({
        model: input.model,
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content }],
        max_tokens: input.maxTokens,
        temperature: 0,
        output_config: {
          format: {
            type: 'json_schema',
            schema: input.schema,
          },
        },
      }),
    });
    if (!res.ok) {
      throw new ProviderHttpError({
        status: res.status,
        provider: this.id,
        model: input.model,
        responseExcerpt: (await res.text()).slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    const reportedModel = json.model?.trim() || undefined;
    const provenance = resolutionProvenance(input.model, reportedModel);
    if (!reportedModel || reportedModel !== input.model) {
      throw new ProviderIdentityError(
        `VISION_REVIEW_MODEL_IDENTITY_MISMATCH: requested=${input.model}, reported=${reportedModel ?? 'missing'}`,
        usage,
        {
          provider: this.id,
          ...provenance,
        },
      );
    }
    if (json.stop_reason === 'max_tokens') {
      throw new ProviderOutputError('VISION_REVIEW_OUTPUT_TRUNCATED', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    if (json.stop_reason !== 'end_turn') {
      throw new ProviderOutputError(`VISION_REVIEW_FINISH_REASON_INVALID: ${json.stop_reason ?? 'missing'}`, usage, {
        provider: this.id,
        ...provenance,
      });
    }
    const raw = (json.content ?? [])
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text ?? '')
      .join('');
    if (!raw.trim()) {
      throw new ProviderOutputError('VISION_REVIEW_EMPTY_OUTPUT: stop_reason=end_turn', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    try {
      return {
        data: JSON.parse(stripJsonFence(raw)) as T,
        provider: this.id,
        ...provenance,
        usage,
      };
    } catch (error) {
      throw new ProviderOutputError(
        `VISION_REVIEW_OUTPUT_NOT_JSON: ${error instanceof Error ? error.message : String(error)}`,
        usage,
        {
          cause: error,
          provider: this.id,
          ...provenance,
        },
      );
    }
  }

  private async reviewVisionGoogleGenerateContent<T>(input: ReviewVisionInput): Promise<ModelResult<T>> {
    const parts: Array<
      | { text: string }
      | {
          inline_data: {
            mime_type: 'image/png';
            data: string;
          };
        }
    > = [{ text: input.prompt }];
    for (const image of input.images) {
      parts.push({
        text: `Controlled input ${image.artifactId}: locale=${image.target.locale}, page=${image.target.pageId}, breakpoint=${image.target.breakpoint}`,
      });
      parts.push({
        inline_data: {
          mime_type: 'image/png',
          data: Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength).toString('base64'),
        },
      });
    }
    const gatewayRoot = this.cfg.baseUrl.replace(/\/v1\/?$/, '');
    const res = await fetch(`${gatewayRoot}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`, {
      method: 'POST',
      headers: this.headers(),
      signal: this.requestSignal(input.signal),
      body: JSON.stringify({
        ...(input.system
          ? {
              systemInstruction: {
                parts: [{ text: input.system }],
              },
            }
          : {}),
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: input.maxTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: input.schema,
        },
      }),
    });
    if (!res.ok) {
      throw new ProviderHttpError({
        status: res.status,
        provider: this.id,
        model: input.model,
        responseExcerpt: (await res.text()).slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            thought?: boolean;
          }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
      modelVersion?: string;
    };
    const usage = {
      inputTokens: json.usageMetadata?.promptTokenCount,
      outputTokens: (json.usageMetadata?.candidatesTokenCount ?? 0) + (json.usageMetadata?.thoughtsTokenCount ?? 0),
    };
    const reportedModel = json.modelVersion?.trim() || undefined;
    const provenance = resolutionProvenance(input.model, reportedModel);
    if (!reportedModel || reportedModel !== input.model) {
      throw new ProviderIdentityError(
        `VISION_REVIEW_MODEL_IDENTITY_MISMATCH: requested=${input.model}, reported=${reportedModel ?? 'missing'}`,
        usage,
        {
          provider: this.id,
          ...provenance,
        },
      );
    }
    const finishReason = json.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      throw new ProviderOutputError('VISION_REVIEW_OUTPUT_TRUNCATED', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    if (finishReason !== 'STOP') {
      throw new ProviderOutputError(`VISION_REVIEW_FINISH_REASON_INVALID: ${finishReason ?? 'missing'}`, usage, {
        provider: this.id,
        ...provenance,
      });
    }
    const raw = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('');
    if (!raw.trim()) {
      throw new ProviderOutputError('VISION_REVIEW_EMPTY_OUTPUT: finishReason=STOP', usage, {
        provider: this.id,
        ...provenance,
      });
    }
    try {
      return {
        data: JSON.parse(stripJsonFence(raw)) as T,
        provider: this.id,
        ...provenance,
        usage,
      };
    } catch (error) {
      throw new ProviderOutputError(
        `VISION_REVIEW_OUTPUT_NOT_JSON: ${error instanceof Error ? error.message : String(error)}`,
        usage,
        {
          cause: error,
          provider: this.id,
          ...provenance,
        },
      );
    }
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
    const usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    if (json.status !== 'completed') {
      throw new ProviderOutputError(
        `${this.id} ${opts.model}: Responses request did not complete (status=${json.status ?? 'unknown'})`,
        usage,
        {
          provider: this.id,
          ...resolutionProvenance(opts.model, json.model?.trim() || undefined),
        },
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
    const usage = {
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
    if (json.stop_reason === 'max_tokens' || json.stop_reason === 'model_context_window_exceeded') {
      throw new ProviderOutputError(
        `${this.id} ${opts.model}: Claude response truncated (stop_reason=${json.stop_reason})`,
        usage,
        {
          provider: this.id,
          ...resolutionProvenance(opts.model, json.model?.trim() || undefined),
        },
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
