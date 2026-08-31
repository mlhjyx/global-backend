import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PrismaRuntimeProcessLeaseStore,
  RuntimeProcessLeaseService,
  type RuntimeProcessLeaseRecord,
  type RuntimeProcessLeaseStore,
} from "./runtime-process-lease";

const identity = {
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
  migration_revision: "20260816000000_runtime_process_lease",
  schema_digest: `sha256:${"d".repeat(64)}`,
};

function lease(
  overrides: Partial<RuntimeProcessLeaseRecord> = {},
): RuntimeProcessLeaseRecord {
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    role: "WORKER",
    state: "READY",
    taskQueue: "understanding",
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

function fixture(records: RuntimeProcessLeaseRecord[] = []) {
  const store: RuntimeProcessLeaseStore = {
    upsert: vi.fn(async () => undefined),
    listFresh: vi.fn(async () => records),
  };
  const service = new RuntimeProcessLeaseService(store, {
    identity,
    instanceId: "00000000-0000-4000-8000-000000000099",
    now: () => new Date("2026-08-16T00:00:30.000Z"),
  });
  return { service, store };
}

describe("RuntimeProcessLeaseService", () => {
  it("uses the mapped PostgreSQL table, columns and enum names from the migration", () => {
    const source = readFileSync(
      join(import.meta.dirname, "runtime-process-lease.ts"),
      "utf8",
    );
    const migration = readFileSync(
      join(
        import.meta.dirname,
        "../../../../packages/db/prisma/migrations/20260816220000_production_parity_budget_runtime/migration.sql",
      ),
      "utf8",
    );
    expect(source).toContain("register_worker_runtime_process_lease");
    expect(source).toContain("heartbeat_worker_runtime_process_lease");
    expect(source).toContain("RUNTIME_API_LEASE_DATABASE_URL");
    expect(source).toContain("RUNTIME_WORKER_LEASE_DATABASE_URL");
    expect(source).toContain("RUNTIME_OUTBOX_RELAY_LEASE_DATABASE_URL");
    expect(source).toContain('$2::"runtime_process_state"');
    expect(source).toContain('"instance_id" AS "instanceId"');
    expect(source).not.toContain('"RuntimeProcessLease"');
    expect(source).not.toContain('::"RuntimeProcessRole"');
    expect(migration).toContain('CREATE TABLE "runtime_process_lease"');
    expect(migration).toContain('"instance_id" UUID NOT NULL');
    expect(migration).toContain('CREATE TYPE "runtime_process_role"');
    expect(migration).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE");
    expect(migration).toContain("register_worker_runtime_process_lease(");
    expect(migration).toContain("heartbeat_worker_runtime_process_lease(");
    expect(migration).toContain(
      "REVOKE EXECUTE ON FUNCTION register_runtime_process_lease",
    );
  });

  it("registers immutable identity once and sends only bounded heartbeat state afterward", async () => {
    const appReader = {
      $queryRawUnsafe: vi.fn(async () => []),
    };
    const workerWriter = {
      $queryRawUnsafe: vi
        .fn()
        .mockResolvedValueOnce([
          {
            sessionUser: "ci_runtime_worker",
            superuser: false,
            bypassRls: false,
            createDb: false,
            createRole: false,
            replication: false,
            memberships: ["runtime_worker"],
          },
        ])
        .mockResolvedValueOnce([
          { instance_id: "00000000-0000-4000-8000-000000000001" },
        ])
        .mockResolvedValue([{ heartbeat: "" }]),
    };
    const store = new PrismaRuntimeProcessLeaseStore(appReader as never, {
      writers: { WORKER: workerWriter as never },
    });
    const record = lease();

    await store.upsert(record);
    await store.upsert({ ...record, state: "READY", lastSeenAt: new Date() });

    expect(appReader.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(workerWriter.$queryRawUnsafe).toHaveBeenCalledTimes(4);
    expect(workerWriter.$queryRawUnsafe.mock.calls[0]?.[0]).toContain(
      "pg_auth_members",
    );
    expect(workerWriter.$queryRawUnsafe.mock.calls[1]?.[0]).toContain(
      "register_worker_runtime_process_lease",
    );
    expect(workerWriter.$queryRawUnsafe.mock.calls[3]?.[0]).toContain(
      "heartbeat_worker_runtime_process_lease",
    );
    expect(workerWriter.$queryRawUnsafe.mock.calls[3]?.[0]).toContain(
      ')::text AS "heartbeat"',
    );
    expect(workerWriter.$queryRawUnsafe.mock.calls[3]?.slice(1)).toEqual([
      record.instanceId,
      "READY",
      expect.any(Date),
    ]);
  });

  it.each([
    ["API", "runtime_api", "heartbeat_api_runtime_process_lease"],
    ["WORKER", "runtime_worker", "heartbeat_worker_runtime_process_lease"],
    [
      "OUTBOX_RELAY",
      "runtime_outbox_relay",
      "heartbeat_outbox_relay_runtime_process_lease",
    ],
  ] as const)(
    "casts the %s heartbeat void result to a Prisma-supported scalar",
    async (role, membership, heartbeatFunction) => {
      const appReader = { $queryRawUnsafe: vi.fn(async () => []) };
      const writer = {
        $queryRawUnsafe: vi
          .fn()
          .mockResolvedValueOnce([
            {
              sessionUser: `ci_${membership}`,
              superuser: false,
              bypassRls: false,
              createDb: false,
              createRole: false,
              replication: false,
              memberships: [membership],
            },
          ])
          .mockResolvedValueOnce([
            { instance_id: "00000000-0000-4000-8000-000000000001" },
          ])
          .mockResolvedValueOnce([{ heartbeat: "" }]),
      };
      const store = new PrismaRuntimeProcessLeaseStore(appReader as never, {
        writers: { [role]: writer as never },
      });

      await store.upsert(
        lease({ role, taskQueue: role === "WORKER" ? "understanding" : null }),
      );

      expect(writer.$queryRawUnsafe.mock.calls[2]?.[0]).toContain(
        heartbeatFunction,
      );
      expect(writer.$queryRawUnsafe.mock.calls[2]?.[0]).toContain(
        ')::text AS "heartbeat"',
      );
    },
  );

  it("fails closed without the dedicated writer for the requested runtime role", async () => {
    const appReader = { $queryRawUnsafe: vi.fn(async () => []) };
    const store = new PrismaRuntimeProcessLeaseStore(appReader as never, {
      env: {},
      writers: {},
    });

    await expect(store.upsert(lease())).rejects.toThrow(
      "RUNTIME_PROCESS_LEASE_WRITER_UNAVAILABLE",
    );
    expect(appReader.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("rejects an owner, superuser or multi-role URL before calling a lease wrapper", async () => {
    const appReader = { $queryRawUnsafe: vi.fn(async () => []) };
    const unsafeWriter = {
      $queryRawUnsafe: vi.fn(async () => [
        {
          sessionUser: "global",
          superuser: true,
          bypassRls: true,
          createDb: true,
          createRole: true,
          replication: false,
          memberships: ["runtime_api", "runtime_worker"],
        },
      ]),
    };
    const store = new PrismaRuntimeProcessLeaseStore(appReader as never, {
      writers: { WORKER: unsafeWriter as never },
    });

    await expect(store.upsert(lease())).rejects.toThrow(
      "RUNTIME_PROCESS_LEASE_WRITER_IDENTITY_INVALID",
    );
    expect(unsafeWriter.$queryRawUnsafe).toHaveBeenCalledOnce();
  });

  it("heartbeats the exact release identity without mutable or secret metadata", async () => {
    const { service, store } = fixture();
    await service.heartbeat("WORKER", "STARTING", "understanding");

    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        role: "WORKER",
        state: "STARTING",
        taskQueue: "understanding",
        buildSha: identity.build_sha,
        imageDigest: identity.image_digest,
        artifactDigest: identity.artifact_digest,
        migrationRevision: identity.migration_revision,
      }),
    );
    expect(
      JSON.stringify((store.upsert as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("DATABASE_URL");
  });

  it("uses a different stable process UUID for every role in the same API process", async () => {
    const { service, store } = fixture();

    await service.heartbeat("API", "STARTING", null);
    await service.heartbeat("OUTBOX_RELAY", "STARTING", null);
    await service.heartbeat("API", "READY", null);

    const calls = (store.upsert as ReturnType<typeof vi.fn>).mock.calls.map(
      ([record]) => record as RuntimeProcessLeaseRecord,
    );
    expect(calls[0]?.instanceId).toBe(calls[2]?.instanceId);
    expect(calls[0]?.instanceId).not.toBe(calls[1]?.instanceId);
  });

  it("admits multiple workers only when every fresh lease has the exact same identity", async () => {
    const matching = fixture([
      lease(),
      lease({ instanceId: "00000000-0000-4000-8000-000000000002" }),
    ]);
    await expect(
      matching.service.inspectWorkerQueue("understanding"),
    ).resolves.toEqual({
      status: "ok",
    });

    const mixed = fixture([
      lease(),
      lease({
        instanceId: "00000000-0000-4000-8000-000000000003",
        imageDigest: `sha256:${"e".repeat(64)}`,
      }),
    ]);
    await expect(
      mixed.service.inspectWorkerQueue("understanding"),
    ).resolves.toEqual({
      status: "failed",
      code: "WORKER_MIXED_RELEASE_IDENTITY",
    });
  });

  it("requires a fresh READY matching worker and ignores stopped or stale leases", async () => {
    const missing = fixture([
      lease({ state: "STOPPED" }),
      lease({ lastSeenAt: new Date("2026-08-15T23:59:00.000Z") }),
    ]);
    await expect(
      missing.service.inspectWorkerQueue("understanding"),
    ).resolves.toEqual({
      status: "failed",
      code: "MATCHING_WORKER_NOT_READY",
    });
  });

  it("never permits an unattested process to publish a lease", async () => {
    const store: RuntimeProcessLeaseStore = {
      upsert: vi.fn(async () => undefined),
      listFresh: vi.fn(async () => []),
    };
    const service = new RuntimeProcessLeaseService(store, {
      identity: {
        attested: false,
        schema_version: "global-runtime-release-identity/v1",
        code: "BUILD_ATTESTATION_REQUIRED",
      },
      instanceId: "00000000-0000-4000-8000-000000000099",
      now: () => new Date(),
    });

    await expect(service.heartbeat("API", "READY", null)).rejects.toThrow(
      /release identity/i,
    );
    expect(store.upsert).not.toHaveBeenCalled();
  });
});
