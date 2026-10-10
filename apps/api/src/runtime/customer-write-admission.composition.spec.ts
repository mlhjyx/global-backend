import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Controller, Module, Post, VersioningType } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { describe, expect, it, vi } from "vitest";
import { GlobalHttpExceptionFilter } from "../common/http-exception.filter";
import { HealthController } from "../health/health.controller";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeAdmissionService } from "./runtime-admission";
import {
  RuntimeProcessLeaseService,
  type RuntimeProcessLeaseRecord,
  type RuntimeProcessRole,
} from "./runtime-process-lease";
import { RuntimeReleaseIdentityService } from "./runtime-release-identity";
import { RuntimeWorkAdmissionGuard } from "./runtime-work-admission.guard";

const MIGRATION = "20260816000000_runtime_process_lease";
const identity = Object.freeze({
  attested: true as const,
  schema_version: "global-runtime-release-identity/v1" as const,
  build_sha: "a".repeat(40),
  built_at: "2026-08-16T00:00:00.000Z",
  image_digest: `sha256:${"b".repeat(64)}`,
  artifact_digest: `sha256:${"c".repeat(64)}`,
  artifact_manifest_digest: `sha256:${"e".repeat(64)}`,
  sbom_digest: `sha256:${"f".repeat(64)}`,
  source_tree_digest: `sha256:${"1".repeat(64)}`,
  renderer_digest: `sha256:${"2".repeat(64)}`,
  migration_revision: MIGRATION,
  schema_digest: `sha256:${"d".repeat(64)}`,
});
const temporal = Object.freeze({
  temporalClusterId: "test-cluster",
  temporalClusterProofDigest: `sha256:${"9".repeat(64)}`,
});

@Controller("customer-work")
class CustomerWorkController {
  @Post()
  create(): Readonly<{ accepted: true }> {
    return Object.freeze({ accepted: true });
  }
}

function lease(
  role: RuntimeProcessRole,
  overrides: Partial<RuntimeProcessLeaseRecord> = {},
): RuntimeProcessLeaseRecord {
  const worker = role === "WORKER" || role === "PLATFORM_WORKER";
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    role,
    state: "READY",
    taskQueue: worker ? "understanding" : null,
    temporalClusterId: worker ? temporal.temporalClusterId : null,
    temporalClusterProofDigest: worker
      ? temporal.temporalClusterProofDigest
      : null,
    temporalNamespace:
      role === "PLATFORM_WORKER"
        ? "platform-automation"
        : role === "WORKER"
          ? "default"
          : null,
    workloadKind:
      role === "PLATFORM_WORKER"
        ? "platform-worker"
        : role === "WORKER"
          ? "customer-worker"
          : null,
    buildSha: identity.build_sha,
    imageDigest: identity.image_digest,
    artifactDigest: identity.artifact_digest,
    migrationRevision: identity.migration_revision,
    startedAt: new Date("2026-08-16T00:00:00.000Z"),
    lastSeenAt: new Date("2026-08-16T00:00:20.000Z"),
    stoppedAt: null,
    ...overrides,
  };
}

describe("customer write admission through the real readiness snapshot", () => {
  it("keeps /health/ready at 503 for an absent platform worker yet admits customer writes, and still closes them for a release mismatch or a missing customer worker", async () => {
    const records = new Map<RuntimeProcessRole, RuntimeProcessLeaseRecord[]>([
      ["WORKER", [lease("WORKER")]],
      ["OUTBOX_RELAY", [lease("OUTBOX_RELAY")]],
      ["PLATFORM_WORKER", []],
    ]);
    const leases = new RuntimeProcessLeaseService(
      {
        upsert: vi.fn(async () => undefined),
        terminalize: vi.fn(async () => undefined),
        listFresh: vi.fn(async ({ role }) => records.get(role) ?? []),
      },
      {
        identity,
        temporal,
        now: () => new Date("2026-08-16T00:00:30.000Z"),
      },
    );
    const transaction = {
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRawUnsafe: vi.fn(async (query: string) =>
        query === "SELECT 1" ? [{ ok: 1 }] : [{ migration_name: MIGRATION }],
      ),
    };
    const readiness = new RuntimeReadinessService(
      {
        $transaction: vi.fn(
          async (operation: (client: typeof transaction) => Promise<unknown>) =>
            operation(transaction),
        ),
      } as never,
      { probe: vi.fn(async () => ({ connected: true })) } as never,
      { current: () => ({ admitted: true }) } as never,
      { current: () => identity } as never,
      leases,
      { check: vi.fn(async () => ({ status: "ok" })) } as never,
    );

    @Module({
      controllers: [HealthController, CustomerWorkController],
      providers: [
        { provide: PrismaService, useValue: {} },
        // A facade without lifecycle hooks: the test refreshes the snapshot
        // explicitly instead of racing the 10-second background refresh.
        {
          provide: RuntimeReadinessService,
          useValue: { current: () => readiness.current() },
        },
        {
          provide: RuntimeReleaseIdentityService,
          useValue: { current: () => identity },
        },
        {
          provide: RuntimeAdmissionService,
          useValue: { current: () => ({ admitted: true }) },
        },
        { provide: APP_GUARD, useClass: RuntimeWorkAdmissionGuard },
      ],
    })
    class CustomerWriteAdmissionTestModule {}

    // abortOnError: false turns a wiring error into a test failure instead of
    // a process exit.
    const app = await NestFactory.create<NestExpressApplication>(
      CustomerWriteAdmissionTestModule,
      { logger: false, abortOnError: false },
    );
    app.setGlobalPrefix("api");
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
    app.useGlobalFilters(new GlobalHttpExceptionFilter());
    try {
      await app.listen(0, "127.0.0.1");
      const address = app.getHttpServer().address() as AddressInfo;
      const base = `http://127.0.0.1:${address.port}/api/v1`;
      const observe = async () => {
        await readiness.check();
        const ready = await fetch(`${base}/health/ready`);
        const write = await fetch(`${base}/customer-work`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        return {
          ready: ready.status,
          report: (await ready.json()) as {
            components: Record<string, unknown>;
          },
          write: write.status,
          written: (await write.json()) as unknown,
        };
      };

      // No platform worker lease at all (stopped or restarting).
      let seen = await observe();
      expect(seen.ready).toBe(503);
      expect(seen.report).toMatchObject({
        status: "not_ready",
        components: {
          worker: { status: "ok" },
          platform_worker: {
            status: "failed",
            code: "PLATFORM_WORKER_NOT_READY",
          },
        },
      });
      expect(seen.write).toBe(201);
      expect(seen.written).toEqual({ accepted: true });

      // A same-release platform worker that has not reached READY yet.
      records.set("PLATFORM_WORKER", [
        lease("PLATFORM_WORKER", { state: "STARTING" }),
      ]);
      seen = await observe();
      expect(seen.ready).toBe(503);
      expect(seen.report.components.platform_worker).toEqual({
        status: "failed",
        code: "PLATFORM_WORKER_NOT_READY",
      });
      expect(seen.write).toBe(201);

      // A platform worker from another release still closes customer writes.
      records.set("PLATFORM_WORKER", [
        lease("PLATFORM_WORKER", { imageDigest: `sha256:${"0".repeat(64)}` }),
      ]);
      seen = await observe();
      expect(seen.ready).toBe(503);
      expect(seen.report.components.platform_worker).toEqual({
        status: "failed",
        code: "PLATFORM_WORKER_MIXED_RELEASE_IDENTITY",
      });
      expect(seen.write).toBe(503);
      expect(seen.written).toMatchObject({
        error: { code: "RUNTIME_ADMISSION_CLOSED" },
      });

      // The customer worker going away closes customer writes again.
      records.set("PLATFORM_WORKER", []);
      records.set("WORKER", []);
      seen = await observe();
      expect(seen.ready).toBe(503);
      expect(seen.report.components.worker).toEqual({
        status: "failed",
        code: "MATCHING_WORKER_NOT_READY",
      });
      expect(seen.write).toBe(503);
      expect(seen.written).toMatchObject({
        error: { code: "RUNTIME_ADMISSION_CLOSED" },
      });

      // Both workers READY: aggregate readiness and customer writes agree.
      records.set("WORKER", [lease("WORKER")]);
      records.set("PLATFORM_WORKER", [lease("PLATFORM_WORKER")]);
      seen = await observe();
      expect(seen.ready).toBe(200);
      expect(seen.write).toBe(201);
    } finally {
      await app.close();
    }
  });
});
