import "reflect-metadata";

import { Module, VersioningType } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaService } from "../prisma/prisma.service";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import { ExecutionBudgetAuthorityReadinessContributors } from "../runtime/managed-dependency-readiness";
import { RuntimeProcessLeaseService } from "../runtime/runtime-process-lease";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { RuntimeReleaseIdentityService } from "../runtime/runtime-release-identity";
import { platformAutomationReadinessFactName } from "../platform-authority/platform-automation-readiness";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "../platform-authority/platform-execution-contract";
import { PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR } from "../platform-authority/platform-technical-quote-service-auth";
import { TemporalClient } from "../temporal/temporal.client";
import { HealthController } from "./health.controller";
import { RuntimeReadinessService } from "./runtime-readiness.service";

const registry = new RuntimeReadinessContributorRegistry();
const writer = {
  inspectPlatformWriterCapability: vi.fn(async () => ({
    status: "available" as const,
  })),
};

for (const name of [
  "execution_budget_jwks",
  "site_builder_model_settlement_readback",
  "api_runtime_lease",
  "storage",
  "generic_artifact_storage",
  "redis",
  "model_gateway",
  "renderer",
  "browser",
  "budget_grant_verification",
  "auth_jwks",
] as const) {
  registry.register(name, () => ({ status: "ok" }));
}
registry.register(
  PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READINESS_CONTRIBUTOR,
  () => ({ status: "ok" }),
);
for (const row of PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows) {
  for (const fact of [
    "temporal_proof",
    "issuer",
    "revocation_delivery",
  ] as const) {
    registry.register(
      platformAutomationReadinessFactName(fact, row.scheduleId),
      () => ({ status: "ok" }),
    );
  }
}
new ExecutionBudgetAuthorityReadinessContributors(
  registry,
  writer as never,
).onModuleInit();

const transaction = {
  $executeRawUnsafe: vi.fn(async () => 0),
  $queryRawUnsafe: vi.fn(async (query: string) =>
    query === "SELECT 1"
      ? [{ ok: 1 }]
      : [{ migration_name: "20260905193000_platform_run_bound_authority" }],
  ),
};
const prisma = {
  $queryRaw: vi.fn(async () => [{ ok: 1 }]),
  $transaction: vi.fn(
    async (operation: (value: typeof transaction) => unknown) =>
      operation(transaction),
  ),
};
const releaseIdentity = {
  current: () => ({
    attested: true as const,
    migration_revision: "20260905193000_platform_run_bound_authority",
  }),
};
const readiness = new RuntimeReadinessService(
  prisma as never,
  { probe: async () => ({ connected: true }) } as never,
  { current: () => ({ admitted: true }) } as never,
  releaseIdentity as never,
  {
    inspectWorkerQueue: async () => ({ status: "ok" }),
    inspectRole: async () => ({ status: "ok" }),
  } as never,
  registry,
);

@Module({
  controllers: [HealthController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: RuntimeReadinessService, useValue: readiness },
    { provide: RuntimeReleaseIdentityService, useValue: releaseIdentity },
    { provide: RuntimeAdmissionService, useValue: {} },
    { provide: RuntimeProcessLeaseService, useValue: {} },
    { provide: TemporalClient, useValue: {} },
  ],
})
class PlatformReadinessHealthTestModule {}

describe("Platform readiness real Nest health composition", () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await readiness.check();
    app = await NestFactory.create<NestExpressApplication>(
      PlatformReadinessHealthTestModule,
      { logger: false },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("serves the cached aggregate and four rows without a second readiness probe", async () => {
    const writerCalls =
      writer.inspectPlatformWriterCapability.mock.calls.length;
    const response = await fetch(`${baseUrl}/api/v1/health/ready`);
    const body = (await response.json()) as {
      capabilities: {
        platform_budget_authority: unknown;
        platform_automation: {
          rows: Array<{
            identity: { purpose: string; scheduleId: string };
            state: string;
          }>;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.capabilities.platform_budget_authority).toEqual({
      status: "failed",
      code: "PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED",
    });
    expect(body.capabilities.platform_automation.rows).toHaveLength(4);
    expect(
      body.capabilities.platform_automation.rows
        .filter((row) => row.identity.purpose === "platform.acquisition")
        .map((row) => [row.identity.scheduleId, row.state]),
    ).toEqual([
      ["acq-sweep", "BLOCKED"],
      ["patents-cache-refresh", "INTENTIONALLY_DISABLED_NO_EGRESS"],
    ]);
    expect(writer.inspectPlatformWriterCapability).toHaveBeenCalledTimes(
      writerCalls,
    );
    const openapi = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "../../packages/contracts/openapi/openapi.json"),
        "utf8",
      ),
    ) as {
      paths: Record<
        string,
        {
          get: {
            responses: Record<
              string,
              { content: Record<string, { schema: object }> }
            >;
          };
        }
      >;
    };
    const schema =
      openapi.paths["/api/v1/health/ready"]!.get.responses["200"]!.content[
        "application/json"
      ]!.schema;
    const validate = new Ajv2020({
      strict: true,
      formats: { "date-time": true },
    }).compile(schema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });
});
