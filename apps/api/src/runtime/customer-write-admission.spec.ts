import { describe, expect, it, vi } from "vitest";
import {
  RuntimeReadinessService,
  type ComponentStatus,
  type RuntimeReadinessReport,
} from "../health/runtime-readiness.service";
import {
  CUSTOMER_WRITE_TOLERATED_FAILURE,
  customerWriteAdmission,
} from "./customer-write-admission";
import {
  RuntimeProcessLeaseService,
  type RuntimeProcessLeaseRecord,
} from "./runtime-process-lease";

type Components = RuntimeReadinessReport["components"];

const MIGRATION = "20260816000000_runtime_process_lease";
const OK: ComponentStatus = Object.freeze({ status: "ok" });
const PLATFORM_WORKER_NOT_READY: ComponentStatus = Object.freeze({
  status: "failed",
  code: "PLATFORM_WORKER_NOT_READY",
});

function readinessService(): RuntimeReadinessService {
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRawUnsafe: vi.fn(async (query: string) =>
      query === "SELECT 1" ? [{ ok: 1 }] : [{ migration_name: MIGRATION }],
    ),
  };
  return new RuntimeReadinessService(
    {
      $transaction: vi.fn(
        async (operation: (client: typeof transaction) => Promise<unknown>) =>
          operation(transaction),
      ),
    } as never,
    { probe: vi.fn(async () => ({ connected: true })) } as never,
    { current: vi.fn(() => ({ admitted: true })) } as never,
    {
      current: vi.fn(() => ({ attested: true, migration_revision: MIGRATION })),
    } as never,
    {
      inspectWorkerQueue: vi.fn(async () => OK),
      inspectRole: vi.fn(async () => OK),
    } as never,
    { check: vi.fn(async () => OK) } as never,
  );
}

// Read from the readiness service itself, so a hard component added to the
// report is exercised by every table below without editing this file.
const HARD_COMPONENTS = Object.keys(readinessService().current().components);
const CUSTOMER_DEPENDENCIES = HARD_COMPONENTS.filter(
  (name) => name !== "platform_worker",
);

// Derives the aggregate status the way the readiness service does: ready only
// when every component is ok.
function snapshot(
  overrides: Readonly<Record<string, unknown>> = {},
): Pick<RuntimeReadinessReport, "status" | "components"> {
  const components = {
    ...Object.fromEntries(HARD_COMPONENTS.map((name) => [name, OK])),
    ...overrides,
  } as Components;
  return {
    status: Object.values(components).every(
      (component) => (component as ComponentStatus | null)?.status === "ok",
    )
      ? "ready"
      : "not_ready",
    components,
  };
}

function withoutComponent(
  report: Pick<RuntimeReadinessReport, "status" | "components">,
  name: string,
): Pick<RuntimeReadinessReport, "status" | "components"> {
  const components: Record<string, unknown> = { ...report.components };
  delete components[name];
  return { ...report, components: components as Components };
}

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
  migration_revision: MIGRATION,
  schema_digest: `sha256:${"d".repeat(64)}`,
};
const temporal = {
  temporalClusterId: "test-cluster",
  temporalClusterProofDigest: `sha256:${"9".repeat(64)}`,
};

function platformWorkerLease(
  overrides: Partial<RuntimeProcessLeaseRecord> = {},
): RuntimeProcessLeaseRecord {
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    role: "PLATFORM_WORKER",
    state: "READY",
    taskQueue: "understanding",
    ...temporal,
    temporalNamespace: "platform-automation",
    workloadKind: "platform-worker",
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

async function inspectPlatformWorker(
  records: RuntimeProcessLeaseRecord[],
): Promise<ComponentStatus> {
  const leases = new RuntimeProcessLeaseService(
    {
      upsert: vi.fn(async () => undefined),
      terminalize: vi.fn(async () => undefined),
      listFresh: vi.fn(async () => records),
    },
    {
      identity,
      temporal,
      now: () => new Date("2026-08-16T00:00:30.000Z"),
    },
  );
  return leases.inspectRole("PLATFORM_WORKER");
}

describe("customerWriteAdmission", () => {
  it("opens customer writes when an absent or not-yet-READY platform worker is the only failure", () => {
    expect(
      customerWriteAdmission(
        snapshot({ platform_worker: PLATFORM_WORKER_NOT_READY }),
      ),
    ).toEqual({ open: true, blocking: [] });
    expect(
      customerWriteAdmission(
        snapshot({ platform_worker: PLATFORM_WORKER_NOT_READY, future: OK }),
      ),
    ).toEqual({ open: true, blocking: [] });
  });

  it.each([
    ["failed", "PLATFORM_WORKER_MIXED_RELEASE_IDENTITY"],
    ["failed", "WORKER_TEMPORAL_IDENTITY_INVALID"],
    ["failed", "RUNTIME_PROCESS_LEASE_UNAVAILABLE"],
    ["failed", "RUNTIME_RELEASE_IDENTITY_UNAVAILABLE"],
    ["failed", "platform_worker_not_ready"],
    ["failed", "PLATFORM_WORKER_NOT_READY "],
    ["not_proven", "RUNTIME_READINESS_SNAPSHOT_UNAVAILABLE"],
    ["not_proven", "PLATFORM_WORKER_NOT_READY"],
  ])(
    "keeps customer writes closed when the platform worker is %s with %s",
    (status, code) => {
      const admission = customerWriteAdmission(
        snapshot({ platform_worker: { status, code } }),
      );
      expect(admission.open).toBe(false);
      expect(admission.blocking).toEqual([
        { component: "platform_worker", code },
      ]);
    },
  );

  it.each(CUSTOMER_DEPENDENCIES)(
    "keeps customer writes closed when %s is not ok, alone or beside an absent platform worker",
    (name) => {
      for (const component of [
        { status: "failed", code: "DEPENDENCY_FAILED" },
        { status: "not_proven", code: "DEPENDENCY_NOT_PROVEN" },
      ]) {
        for (const platformWorker of [OK, PLATFORM_WORKER_NOT_READY]) {
          const admission = customerWriteAdmission(
            snapshot({ [name]: component, platform_worker: platformWorker }),
          );
          expect(admission.open).toBe(false);
          expect(admission.blocking).toContainEqual({
            component: name,
            code: component.code,
          });
        }
      }
    },
  );

  it.each(CUSTOMER_DEPENDENCIES)(
    "keeps customer writes closed when %s fails without a string code",
    (name) => {
      for (const code of [null, undefined, 0]) {
        for (const platformWorker of [OK, PLATFORM_WORKER_NOT_READY]) {
          const admission = customerWriteAdmission(
            snapshot({
              [name]: { status: "failed", code },
              platform_worker: platformWorker,
            }),
          );
          expect(admission.open).toBe(false);
          expect(admission.blocking).toContainEqual({
            component: name,
            code: "RUNTIME_READINESS_COMPONENT_INVALID",
          });
        }
      }
    },
  );

  it("does not let a non-enumerable component hide its failure", () => {
    const components: Record<string, unknown> = {
      ...snapshot({ platform_worker: PLATFORM_WORKER_NOT_READY }).components,
    };
    Object.defineProperty(components, "database", {
      value: { status: "failed", code: "DATABASE_UNAVAILABLE" },
      enumerable: false,
    });
    const admission = customerWriteAdmission({
      status: "not_ready",
      components: components as Components,
    });
    expect(admission.open).toBe(false);
    expect(admission.blocking).toContainEqual({
      component: "database",
      code: "RUNTIME_READINESS_COMPONENT_MISSING",
    });
  });

  it("treats a failing component it has not classified as a customer dependency", () => {
    const admission = customerWriteAdmission(
      snapshot({
        platform_worker: PLATFORM_WORKER_NOT_READY,
        future: { status: "failed", code: "PLATFORM_WORKER_NOT_READY" },
      }),
    );
    expect(admission.open).toBe(false);
    expect(admission.blocking).toContainEqual({
      component: "future",
      code: "PLATFORM_WORKER_NOT_READY",
    });
  });

  it("follows aggregate readiness when the snapshot is ready", () => {
    expect(customerWriteAdmission(snapshot()).open).toBe(true);
    expect(
      customerWriteAdmission({ status: "ready" } as RuntimeReadinessReport)
        .open,
    ).toBe(true);
  });

  it("keeps customer writes closed on malformed, inconsistent or initial snapshots", () => {
    const tolerated = snapshot({ platform_worker: PLATFORM_WORKER_NOT_READY });
    for (const report of [
      undefined,
      { status: "not_ready" },
      { status: "not_ready", components: null },
      { status: "degraded", components: tolerated.components },
      { status: "not_ready", components: snapshot().components },
      readinessService().current(),
      withoutComponent(tolerated, "database"),
      snapshot({ platform_worker: PLATFORM_WORKER_NOT_READY, redis: null }),
      snapshot({
        platform_worker: PLATFORM_WORKER_NOT_READY,
        redis: { status: "OK" },
      }),
    ]) {
      const admission = customerWriteAdmission(
        report as RuntimeReadinessReport | undefined,
      );
      expect(admission.open).toBe(false);
      expect(admission.blocking.length).toBeGreaterThan(0);
    }
    expect(
      customerWriteAdmission(withoutComponent(tolerated, "database")).blocking,
    ).toContainEqual({
      component: "database",
      code: "RUNTIME_READINESS_COMPONENT_MISSING",
    });
  });

  it("classifies every hard readiness component and tolerates exactly one platform worker code", async () => {
    const report = await readinessService().check();
    expect(report.status).toBe("ready");
    const classified = Object.keys(CUSTOMER_WRITE_TOLERATED_FAILURE).sort();
    expect(Object.keys(report.components).sort()).toEqual(classified);
    expect([...HARD_COMPONENTS].sort()).toEqual(classified);
    expect(
      Object.entries(CUSTOMER_WRITE_TOLERATED_FAILURE).filter(
        ([, code]) => code !== null,
      ),
    ).toEqual([["platform_worker", "PLATFORM_WORKER_NOT_READY"]]);
  });

  it("tolerates the code the lease inspection emits for an absent or not-yet-READY platform worker, and none it emits for an integrity failure", async () => {
    for (const [records, open] of [
      [[], true],
      [[platformWorkerLease({ state: "STARTING" })], true],
      [[platformWorkerLease({ state: "DRAINING" })], true],
      [[platformWorkerLease({ state: "STOPPED" })], true],
      [[platformWorkerLease()], true],
      [
        [
          platformWorkerLease({
            state: "STARTING",
            imageDigest: `sha256:${"0".repeat(64)}`,
          }),
        ],
        false,
      ],
      [[platformWorkerLease({ temporalNamespace: "default" })], false],
      [[platformWorkerLease({ temporalClusterId: "other-cluster" })], false],
    ] as const) {
      const platformWorker = await inspectPlatformWorker([...records]);
      expect(
        customerWriteAdmission(snapshot({ platform_worker: platformWorker }))
          .open,
      ).toBe(open);
    }
    await expect(inspectPlatformWorker([])).resolves.toEqual(
      PLATFORM_WORKER_NOT_READY,
    );
  });
});
