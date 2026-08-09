import { APICallError, TypeValidationError } from "ai";
import { describe, expect, it } from "vitest";
import { throwNormalizedOutputError } from "./ai-sdk-adapter-result";
import { NativeModelApiError } from "./ai-sdk-native-adapter.contract";

describe("throwNormalizedOutputError", () => {
  it("normalizes the complete AI SDK issue-array error chain without retaining response values", () => {
    const sensitiveValue = "sensitive-value-must-not-enter-diagnostics";
    const responseBody = JSON.stringify({
      content: [{ type: "thinking", thinking: sensitiveValue }],
      usage: {
        output_tokens_details: { thinking_tokens: sensitiveValue },
      },
      private_payload: sensitiveValue,
    });
    const validationError = new TypeValidationError({
      value: JSON.parse(responseBody) as unknown,
      cause: [
        { path: ["usage", "output_tokens_details", "thinking_tokens"] },
        { path: ["content", 0, "signature"] },
        { path: ["content", 0, "signature"] },
        { path: ["private_payload", "secret"] },
      ],
    });
    const apiError = new APICallError({
      message: "Invalid JSON response",
      url: "https://gateway.invalid/v1/messages",
      requestBodyValues: { private_prompt: sensitiveValue },
      statusCode: 200,
      responseHeaders: { "x-oneapi-request-id": "fixture-request-id" },
      responseBody,
      cause: validationError,
    });

    const error = (() => {
      try {
        throwNormalizedOutputError({
          error: apiError,
          protocol: "anthropic-messages",
          requestedModel: "claude-sonnet-5",
        });
      } catch (failure) {
        return failure;
      }
    })();

    expect(error).toBeInstanceOf(NativeModelApiError);
    expect(error).toMatchObject({
      protocol: "anthropic-messages",
      requestedModel: "claude-sonnet-5",
      requestId: "fixture-request-id",
      statusCode: 200,
      retryable: false,
      responseBodyDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      responseBodyBytes: expect.any(Number),
      responseShape: {
        schemaVersion: "native-model-response-shape/2026-08-09-v1",
        topLevelKeys: ["content", "usage"],
        contentBlockTypes: ["thinking"],
        usageKeys: ["output_tokens_details"],
        validationPaths: [
          "content[0].signature",
          "usage.output_tokens_details.thinking_tokens",
        ],
      },
    });
    expect(error).not.toHaveProperty("responseBody");
    expect(error).not.toHaveProperty("requestBodyValues");
    expect(JSON.stringify(error)).not.toContain(sensitiveValue);
    expect(JSON.stringify(error)).not.toContain("private_payload");
    expect(JSON.stringify(error)).not.toContain("private_prompt");
  });
});
