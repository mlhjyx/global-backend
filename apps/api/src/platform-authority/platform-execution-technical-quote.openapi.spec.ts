import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const OPENAPI = JSON.parse(
  readFileSync(
    resolve(process.cwd(), "../../packages/contracts/openapi/openapi.json"),
    "utf8",
  ),
) as {
  paths: Record<string, Record<string, any>>;
};

describe("Platform technical quote service-only OpenAPI", () => {
  const operation =
    OPENAPI.paths["/api/v1/platform-authority/technical-quote"]?.post;

  it("publishes one dedicated service-only operation without bearer fallback", () => {
    expect(operation).toBeDefined();
    expect(operation.operationId).toBe("readPlatformExecutionTechnicalQuote");
    expect(operation.security).toBeUndefined();
    expect(operation["x-required-service-scope"]).toBe(
      "platform-technical-quote.read",
    );
    expect(operation["x-service-authentication"]).toEqual({
      kind: "injected-dedicated-service-verifier",
      identity_token_fallback: false,
      workspace_token_fallback: false,
      unsigned_fallback: false,
    });
    expect(Object.keys(operation.requestBody.content)).toEqual([
      "application/json",
    ]);
    expect(operation.responses).not.toHaveProperty("301");
    expect(operation.responses).not.toHaveProperty("302");
    expect(operation.responses).not.toHaveProperty("307");
    expect(operation.responses).not.toHaveProperty("308");
  });

  it("keeps the request and quote response as closed string-only objects", () => {
    const request = operation.requestBody.content["application/json"].schema;
    expect(request.additionalProperties).toBe(false);
    expect(request.required).toEqual([
      "schema_version",
      "purpose",
      "temporal_namespace",
      "schedule_id",
      "workflow_type",
      "workflow_id",
      "workflow_run_id",
      "schedule_request_sha256",
    ]);
    expect(Object.keys(request.properties)).toEqual(request.required);
    for (const property of Object.values(request.properties) as any[]) {
      expect(property.type).toBe("string");
    }
    expect(request.properties).not.toHaveProperty("cap_microusd");
    expect(request.properties).not.toHaveProperty("workspace_id");

    const response = operation.responses["200"].content["application/json"].schema;
    expect(response.additionalProperties).toBe(false);
    expect(response.required).toEqual(["data"]);
    expect(response.properties.data.additionalProperties).toBe(false);
    expect(response.properties.data.required).toContain("quote_sha256");
    expect(response.properties.data.required).toContain("policy_revision");
    expect(response.properties.data.required).not.toContain("customer_id");
  });

  it("documents only stable closed authentication and quote errors", () => {
    expect(Object.keys(operation.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "503",
    ]);
    const codes = (status: string) =>
      operation.responses[status].content["application/json"].schema.properties.error
        .properties.code.enum;
    expect(codes("400")).toEqual([
      "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
    ]);
    expect(codes("401")).toEqual([
      "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_DENIED",
    ]);
    expect(codes("503")).toEqual([
      "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_UNAVAILABLE",
      "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
      "PLATFORM_EXECUTION_BUDGET_POLICY_DRIFT",
    ]);
  });
});
