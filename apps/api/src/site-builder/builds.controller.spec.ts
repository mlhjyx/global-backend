import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildsController } from "./builds.controller";

const CTX = {
  userId: "u1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  roles: [],
};

describe("BuildsController public progress response", () => {
  it("exports the strict build request and idempotency contract", () => {
    const spec = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../packages/contracts/openapi/openapi.json"),
        "utf8",
      ),
    ) as {
      paths: Record<
        string,
        {
          post: {
            parameters: Array<{
              name: string;
              schema: Record<string, unknown>;
            }>;
            responses: Record<string, unknown>;
            requestBody: {
              content: {
                "application/json": { schema: Record<string, unknown> };
              };
            };
          };
        }
      >;
      components: {
        schemas: Record<
          string,
          { properties: Record<string, Record<string, unknown>> }
        >;
      };
    };
    const operation = spec.paths["/api/v1/site-builder/sites/{id}/builds"].post;
    const idempotency = operation.parameters.find(
      (parameter) => parameter.name === "idempotency-key",
    );
    const budgetGrant = operation.parameters.find(
      (parameter) => parameter.name === "X-Site-Build-Budget-Grant",
    );
    expect(idempotency?.schema).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]{1,128}$",
    });
    expect(budgetGrant).toMatchObject({
      name: "X-Site-Build-Budget-Grant",
      required: true,
      in: "header",
      schema: { type: "string", minLength: 1, maxLength: 16_384 },
    });
    const intakeBudgetGrant = spec.paths[
      "/api/v1/site-builder/intake"
    ].post.parameters.find(
      (parameter) => parameter.name === "X-Site-Build-Budget-Grant",
    );
    expect(intakeBudgetGrant).toMatchObject({
      name: "X-Site-Build-Budget-Grant",
      required: true,
      in: "header",
      schema: { type: "string", minLength: 1, maxLength: 16_384 },
    });
    expect(
      JSON.stringify(
        spec.paths["/api/v1/site-builder/intake"].post.responses["409"],
      ),
    ).toContain("BUDGET_GRANT_REUSED");
    expect(operation.responses).toHaveProperty("422");
    expect(operation.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: { type: "string", enum: ["site", "page", "section"] },
        targetId: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "page/section 必填；site 禁止",
        },
        options: {
          type: "object",
          additionalProperties: false,
          properties: {
            stylePreset: {
              type: "string",
              enum: ["modern-industrial", "precision-light"],
            },
            locales: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              uniqueItems: true,
              items: { type: "string", enum: ["en", "de-DE"] },
            },
            pages: {
              type: "array",
              minItems: 1,
              maxItems: 32,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        },
      },
    });
  });

  it("does not expose persisted raw worker/provider errors", async () => {
    const builds = {
      get: async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        kind: "refurbish",
        status: "failed",
        phase: "P2_assets",
        progress: 0.4,
        steps: null,
        costSummary: null,
        error: "connect ECONNREFUSED 10.0.0.7:7233 secret-token=abc",
        startedAt: new Date("2026-07-17T00:00:00.000Z"),
        finishedAt: new Date("2026-07-17T00:01:00.000Z"),
      }),
    };
    const controller = new BuildsController(builds as never, {} as never);

    const response = await controller.get(
      CTX,
      "22222222-2222-4222-8222-222222222222",
    );

    expect(response.data).toMatchObject({
      error: "build could not complete during P2_assets",
      errorCode: "BUILD_FAILED",
    });
    expect(JSON.stringify(response)).not.toContain("10.0.0.7");
    expect(JSON.stringify(response)).not.toContain("secret-token");
  });

  it.each(["MODEL_SETTLEMENT_UNKNOWN", "TOOL_CALL_UNKNOWN"])(
    "uses persisted pending reconciliation truth for %s without exposing provider diagnostics",
    async (errorCode) => {
      const builds = {
        get: async () => ({
          id: "22222222-2222-4222-8222-222222222222",
          kind: "refurbish",
          status: "failed",
          phase: "P3_assembly",
          progress: 0.56,
          steps: [{ key: "brand_profile", status: "failed", errorCode }],
          costSummary: { reconciliation: { pendingOperations: 1 } },
          error: "private provider acknowledgement detail",
          startedAt: new Date("2026-09-02T00:00:00.000Z"),
          finishedAt: new Date("2026-09-02T00:01:00.000Z"),
        }),
      };
      const controller = new BuildsController(builds as never, {} as never);

      const response = await controller.get(
        CTX,
        "22222222-2222-4222-8222-222222222222",
      );

      expect(response.data).toMatchObject({
        error: "site build cost reconciliation is pending during P3_assembly",
        errorCode,
      });
      expect(JSON.stringify(response)).not.toContain("private provider");
    },
  );

  it("keeps error null when the run has no persisted error", async () => {
    const builds = {
      get: async () => ({
        id: "22222222-2222-4222-8222-222222222222",
        kind: "refurbish",
        status: "running",
        phase: null,
        progress: 0.1,
        steps: null,
        costSummary: null,
        error: null,
        startedAt: null,
        finishedAt: null,
      }),
    };
    const controller = new BuildsController(builds as never, {} as never);

    const response = await controller.get(
      CTX,
      "22222222-2222-4222-8222-222222222222",
    );

    expect(response.data.error).toBeNull();
    expect(response.data.errorCode).toBeNull();
  });

  it("exports the non-null progress shape as strings plus a step array", () => {
    const spec = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../packages/contracts/openapi/openapi.json"),
        "utf8",
      ),
    ) as {
      components: {
        schemas: {
          BuildStatusResponseDto: {
            properties: Record<
              string,
              {
                type?: string;
                nullable?: boolean;
                items?: unknown;
                enum?: string[];
              }
            >;
          };
        };
      };
    };
    const properties =
      spec.components.schemas.BuildStatusResponseDto.properties;

    expect(properties.phase).toMatchObject({
      type: "string",
      nullable: true,
      enum: [
        "P1_understanding",
        "P2_assets",
        "P3_assembly",
        "P4_quality",
        "P5_publish",
      ],
    });
    expect(properties.error).toMatchObject({ type: "string", nullable: true });
    expect(properties.steps).toMatchObject({ type: "array", nullable: true });
    expect(properties.steps.items).toMatchObject({
      type: "object",
      required: ["key", "status"],
      properties: {
        key: { type: "string" },
        status: { type: "string" },
      },
    });
  });
});
