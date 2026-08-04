export type NativeModelProtocol =
  | 'openai-responses'
  | 'anthropic-messages';

export type NativeReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export interface NativeAdapterReasoning {
  effort: NativeReasoningEffort;
}

export interface NativeModelAdapterRequest {
  alias: string;
  system?: string;
  prompt: string;
  outputSchema?: Readonly<Record<string, unknown>>;
  outputSchemaName?: string;
  reasoning?: NativeAdapterReasoning;
  temperature?: number;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}

export interface NativeAdapterUsage {
  inputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
}

export interface NativeAdapterWarning {
  type: string;
  feature?: string;
  details?: string;
}

export interface NativeModelAdapterResult<Output> {
  protocol: NativeModelProtocol;
  requestedModel: string;
  reportedModel: string;
  requestId?: string;
  output: Output;
  usage: NativeAdapterUsage;
  warnings: readonly NativeAdapterWarning[];
}

export class NativeModelOutputError extends Error {
  readonly protocol: NativeModelProtocol;
  readonly requestedModel: string;
  readonly reportedModel?: string;
  readonly requestId?: string;
  readonly usage?: NativeAdapterUsage;

  constructor(input: {
    protocol: NativeModelProtocol;
    requestedModel: string;
    reportedModel?: string;
    requestId?: string;
    usage?: NativeAdapterUsage;
  }) {
    super('Model output failed structured-output validation');
    this.name = 'NativeModelOutputError';
    this.protocol = input.protocol;
    this.requestedModel = input.requestedModel;
    this.reportedModel = input.reportedModel;
    this.requestId = input.requestId;
    this.usage = input.usage;
  }
}

export interface NativeModelAdapter {
  readonly protocol: NativeModelProtocol;
  execute<Output = string>(
    request: NativeModelAdapterRequest,
  ): Promise<NativeModelAdapterResult<Output>>;
}

export interface AiSdkNativeAdapterSettings {
  baseUrl: string;
  /** Independently configured new-api base URL; must exactly match baseUrl. */
  canonicalGatewayBaseUrl: string;
  apiKey: string;
}

const OFFICIAL_PROVIDER_HOSTS = new Set([
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
]);

function canonicalBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('new-api gateway URL cannot contain credentials, query, or fragment');
  }
  if (OFFICIAL_PROVIDER_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('direct provider origins are forbidden; new-api is the sole model egress');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('new-api gateway URL must use HTTPS except for loopback development');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function assertNewApiGatewayBinding(settings: AiSdkNativeAdapterSettings): void {
  if (canonicalBaseUrl(settings.baseUrl) !== canonicalBaseUrl(settings.canonicalGatewayBaseUrl)) {
    throw new Error('model adapter base URL does not match the canonical new-api gateway');
  }
}
