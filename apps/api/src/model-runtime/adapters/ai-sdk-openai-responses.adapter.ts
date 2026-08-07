import { createOpenAI } from "@ai-sdk/openai";
import { Output, streamText } from "ai";
import {
  assertSafeRequestHeaders,
  createValidatedAiSdkSchema,
  normalizeAiSdkUsage,
  normalizeAiSdkWarnings,
  readOneApiRequestId,
  throwNormalizedOutputError,
} from "./ai-sdk-adapter-result";
import type {
  AiSdkNativeAdapterSettings,
  NativeModelAdapter,
  NativeModelAdapterRequest,
  NativeModelAdapterResult,
} from "./ai-sdk-native-adapter.contract";
import { assertNewApiGatewayBinding } from "./ai-sdk-native-adapter.contract";

export class AiSdkOpenAiResponsesAdapter implements NativeModelAdapter {
  readonly protocol = "openai-responses" as const;
  private readonly provider: ReturnType<typeof createOpenAI>;

  constructor(settings: AiSdkNativeAdapterSettings) {
    assertNewApiGatewayBinding(settings);
    this.provider = createOpenAI({
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      name: "new-api-openai-responses",
    });
  }

  async execute<OutputValue = string>(
    request: NativeModelAdapterRequest,
  ): Promise<NativeModelAdapterResult<OutputValue>> {
    if (request.abortSignal == null) {
      throw new Error("Model adapter requires a bounded AbortSignal");
    }
    assertSafeRequestHeaders(request.headers);
    const output = request.outputSchema
      ? Output.object<OutputValue>({
          schema: createValidatedAiSdkSchema<OutputValue>(request.outputSchema),
          name: request.outputSchemaName,
        })
      : Output.text();
    let providerStreamError: unknown;
    try {
      const result = streamText({
        model: this.provider.responses(request.alias),
        system: request.system,
        prompt: request.prompt,
        output,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        maxRetries: 0,
        abortSignal: request.abortSignal,
        headers: request.headers,
        onError: ({ error }) => {
          providerStreamError ??= error;
        },
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
      const [outputValue, finalStep, usage] = await Promise.all([
        result.output,
        result.finalStep,
        result.usage,
      ]);
      const response = finalStep.response;

      return Object.freeze({
        protocol: this.protocol,
        requestedModel: request.alias,
        reportedModel: response.modelId,
        ...(readOneApiRequestId(response.headers) == null
          ? {}
          : { requestId: readOneApiRequestId(response.headers) }),
        output: outputValue as OutputValue,
        usage: normalizeAiSdkUsage(usage),
        warnings: normalizeAiSdkWarnings(finalStep.warnings),
      });
    } catch (error) {
      throwNormalizedOutputError({
        error: providerStreamError ?? error,
        protocol: this.protocol,
        requestedModel: request.alias,
      });
    }
  }
}
