import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import {
  assertSafeRequestHeaders,
  createValidatedAiSdkSchema,
  normalizeAiSdkUsage,
  normalizeAiSdkWarnings,
  readOneApiRequestId,
  throwNormalizedOutputError,
} from './ai-sdk-adapter-result';
import type {
  AiSdkNativeAdapterSettings,
  NativeModelAdapter,
  NativeModelAdapterRequest,
  NativeModelAdapterResult,
} from './ai-sdk-native-adapter.contract';
import { assertNewApiGatewayBinding } from './ai-sdk-native-adapter.contract';

export class AiSdkOpenAiResponsesAdapter implements NativeModelAdapter {
  readonly protocol = 'openai-responses' as const;
  private readonly provider: ReturnType<typeof createOpenAI>;

  constructor(settings: AiSdkNativeAdapterSettings) {
    assertNewApiGatewayBinding(settings);
    this.provider = createOpenAI({
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      name: 'new-api-openai-responses',
    });
  }

  async execute<OutputValue = string>(
    request: NativeModelAdapterRequest,
  ): Promise<NativeModelAdapterResult<OutputValue>> {
    if (request.abortSignal == null) {
      throw new Error('Model adapter requires a bounded AbortSignal');
    }
    assertSafeRequestHeaders(request.headers);
    const output = request.outputSchema
      ? Output.object<OutputValue>({
          schema: createValidatedAiSdkSchema<OutputValue>(
            request.outputSchema,
          ),
          name: request.outputSchemaName,
        })
      : Output.text();
    let result;
    try {
      result = await generateText({
        model: this.provider.responses(request.alias),
        system: request.system,
        prompt: request.prompt,
        output,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        maxRetries: 0,
        abortSignal: request.abortSignal,
        headers: request.headers,
        providerOptions: {
          openai: {
            store: false,
            strictJsonSchema: true,
            ...(request.reasoning == null
              ? {}
              : { reasoningEffort: request.reasoning.effort }),
          },
        },
      });
    } catch (error) {
      throwNormalizedOutputError({
        error,
        protocol: this.protocol,
        requestedModel: request.alias,
      });
    }

    return Object.freeze({
      protocol: this.protocol,
      requestedModel: request.alias,
      reportedModel: result.response.modelId,
      ...(readOneApiRequestId(result.response.headers) == null
        ? {}
        : { requestId: readOneApiRequestId(result.response.headers) }),
      output: result.output as OutputValue,
      usage: normalizeAiSdkUsage(result.usage),
      warnings: normalizeAiSdkWarnings(result.warnings),
    });
  }
}
