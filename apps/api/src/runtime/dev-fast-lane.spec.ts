import { describe, expect, it } from "vitest";
import type { RuntimeAdmissionResult } from "./runtime-admission";
import type { RuntimeMode } from "./runtime-environment";
import type { RuntimeReleaseIdentity } from "./runtime-release-identity";
import {
  DEV_FAST_LANE_ACQUISITION_COMMANDS,
  DEV_FAST_LANE_SCHEMA_DIGEST_ENV,
  DEV_FAST_LANE_TASK_QUEUE_PREFIX,
  DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV,
  DEV_FAST_LANE_WORKSPACE_ID_ENV,
  NULL_LEASE_WRITER,
  checkDevFastLaneSourceSchema,
  devFastLaneRoute,
  devFastLaneWorkerLane,
  resolveDevFastLane,
  type DevFastLane,
} from "./dev-fast-lane";

// A synthetic workspace; the real test workspace id never enters the repository.
const WORKSPACE = "0f0e0d0c-0b0a-4908-8706-050403020100";
const OTHER_WORKSPACE = "11111111-2222-4333-8444-555555555555";
const ADDRESS = "127.0.0.1:7233";
const DIGEST = `sha256:${"a".repeat(64)}`;
const MODES: RuntimeMode[] = ["development", "test", "pilot", "production"];

function laneEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [DEV_FAST_LANE_WORKSPACE_ID_ENV]: WORKSPACE,
    [DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV]: ADDRESS,
    ...overrides,
  };
}

function enabledLane(): Extract<DevFastLane, { enabled: true }> {
  const lane = resolveDevFastLane("development", laneEnv());
  if (!lane.enabled) throw new Error("fixture lane must be enabled");
  return lane;
}

function admission(
  failed: Record<string, string>,
): Pick<RuntimeAdmissionResult, "admitted" | "checks"> {
  const ok = { status: "ok" as const };
  const checks: RuntimeAdmissionResult["checks"] = {
    build: ok,
    environment: ok,
    database: ok,
    auth: ok,
    gateway: ok,
    pii: ok,
  };
  for (const [name, code] of Object.entries(failed)) {
    checks[name as keyof RuntimeAdmissionResult["checks"]] = {
      status: "failed",
      code,
    };
  }
  return { admitted: Object.keys(failed).length === 0, checks };
}

function unattested(code: string): RuntimeReleaseIdentity {
  return {
    attested: false,
    schema_version: "global-runtime-release-identity/v1",
    code,
  } as RuntimeReleaseIdentity;
}

describe("resolveDevFastLane", () => {
  it("is off in every mode when no lane variable is set or all are blank", () => {
    // Arrange
    const environments: NodeJS.ProcessEnv[] = [
      {},
      {
        [DEV_FAST_LANE_WORKSPACE_ID_ENV]: "",
        [DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV]: "  ",
        [DEV_FAST_LANE_SCHEMA_DIGEST_ENV]: "",
      },
    ];

    for (const mode of MODES) {
      for (const env of environments) {
        // Act
        const lane = resolveDevFastLane(mode, env);

        // Assert
        expect(lane, mode).toEqual({ enabled: false });
      }
    }
  });

  it("enables exactly one workspace on a tenant-scoped queue of a loopback development Temporal", () => {
    // Act
    const lane = resolveDevFastLane("development", laneEnv());
    const withDigest = resolveDevFastLane(
      "development",
      laneEnv({ [DEV_FAST_LANE_SCHEMA_DIGEST_ENV]: DIGEST }),
    );

    // Assert
    expect(lane).toEqual({
      enabled: true,
      workspaceId: WORKSPACE,
      taskQueue: `${DEV_FAST_LANE_TASK_QUEUE_PREFIX}${WORKSPACE}`,
      temporalAddress: ADDRESS,
      temporalNamespace: "default",
      expectedSchemaDigest: null,
    });
    expect(lane.enabled && lane.taskQueue).toBe(
      `understanding-dev-fast-lane-${WORKSPACE}`,
    );
    expect(withDigest).toMatchObject({ expectedSchemaDigest: DIGEST });
    expect(Object.isFrozen(lane)).toBe(true);
  });

  it("refuses any lane variable outside development and names the mode", () => {
    for (const mode of ["test", "pilot", "production"] as const) {
      for (const key of [
        DEV_FAST_LANE_WORKSPACE_ID_ENV,
        DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV,
        DEV_FAST_LANE_SCHEMA_DIGEST_ENV,
      ]) {
        // Arrange
        const env = {
          [key]: key === DEV_FAST_LANE_SCHEMA_DIGEST_ENV ? DIGEST : WORKSPACE,
        };

        // Act
        const resolve = () => resolveDevFastLane(mode, env);

        // Assert
        expect(resolve, `${mode}/${key}`).toThrow(
          /^DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT: /,
        );
        expect(resolve, `${mode}/${key}`).toThrow(
          new RegExp(`runtime mode is ${mode}$`),
        );
      }
    }
  });

  it("rejects a workspace id that is not one lowercase canonical UUID", () => {
    for (const workspaceId of [
      WORKSPACE.toUpperCase(),
      ` ${WORKSPACE}`,
      `${WORKSPACE} `,
      `${WORKSPACE},${OTHER_WORKSPACE}`,
      "on",
      "*",
      "0f0e0d0c0b0a490887060504030201ff",
    ]) {
      // Act
      const resolve = () =>
        resolveDevFastLane(
          "development",
          laneEnv({ [DEV_FAST_LANE_WORKSPACE_ID_ENV]: workspaceId }),
        );

      // Assert
      expect(resolve, workspaceId).toThrow(
        /^DEV_FAST_LANE_WORKSPACE_ID_INVALID: /,
      );
    }
  });

  it("accepts only a loopback host:port as the development Temporal address", () => {
    for (const address of ["127.0.0.1:7233", "localhost:7233", "[::1]:7233"]) {
      expect(
        resolveDevFastLane(
          "development",
          laneEnv({ [DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV]: address }),
        ),
        address,
      ).toMatchObject({ enabled: true, temporalAddress: address });
    }
    for (const address of [
      "",
      "10.0.0.5:7233",
      "0.0.0.0:7233",
      "temporal:7233",
      "127.0.0.1",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1:07233",
      "http://127.0.0.1:7233",
      " 127.0.0.1:7233",
    ]) {
      // Act
      const resolve = () =>
        resolveDevFastLane(
          "development",
          laneEnv({ [DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV]: address }),
        );

      // Assert
      expect(resolve, address).toThrow(
        /^DEV_FAST_LANE_TEMPORAL_ADDRESS_INVALID: /,
      );
    }
  });

  it("rejects a partial configuration without the workspace switch", () => {
    for (const env of [
      { [DEV_FAST_LANE_TEMPORAL_ADDRESS_ENV]: ADDRESS },
      { [DEV_FAST_LANE_SCHEMA_DIGEST_ENV]: DIGEST },
    ]) {
      expect(() => resolveDevFastLane("development", env)).toThrow(
        /^DEV_FAST_LANE_CONFIGURATION_INVALID: /,
      );
    }
  });

  it("rejects a schema digest that is not sha256 followed by 64 lowercase hex", () => {
    for (const digest of [
      "a".repeat(64),
      `sha256:${"A".repeat(64)}`,
      "sha256:",
    ]) {
      expect(() =>
        resolveDevFastLane(
          "development",
          laneEnv({ [DEV_FAST_LANE_SCHEMA_DIGEST_ENV]: digest }),
        ),
      ).toThrow(/^DEV_FAST_LANE_SCHEMA_DIGEST_INVALID: /);
    }
  });
});

describe("devFastLaneRoute", () => {
  it("routes the three acquisition commands of the lane workspace to its queue with bounded execution", () => {
    // Arrange
    const lane = enabledLane();

    // Act
    const routes = Object.fromEntries(
      DEV_FAST_LANE_ACQUISITION_COMMANDS.map((eventType) => [
        eventType,
        devFastLaneRoute(lane, eventType, WORKSPACE),
      ]),
    );

    // Assert
    expect(routes).toEqual({
      CompanyProfileCreated: {
        taskQueue: lane.taskQueue,
        workflowExecutionTimeout: "30 minutes",
      },
      DiscoveryRunRequested: {
        taskQueue: lane.taskQueue,
        workflowExecutionTimeout: "215 minutes",
      },
      QualifyRequested: {
        taskQueue: lane.taskQueue,
        workflowExecutionTimeout: "30 minutes",
      },
    });
  });

  it("keeps every other workspace, every other command and a disabled lane on the managed path", () => {
    // Arrange
    const lane = enabledLane();
    const cases: Array<[DevFastLane | undefined, string, string]> = [
      [lane, "DiscoveryRunRequested", OTHER_WORKSPACE],
      [lane, "DiscoveryRunRequested", WORKSPACE.toUpperCase()],
      [lane, "DeletionRequested", WORKSPACE],
      [lane, "PersonalArtifactCleanupRequested", WORKSPACE],
      [lane, "AssetObjectCleanupRequested", WORKSPACE],
      [lane, "LeadQualified", WORKSPACE],
      [{ enabled: false }, "DiscoveryRunRequested", WORKSPACE],
      [undefined, "DiscoveryRunRequested", WORKSPACE],
    ];

    for (const [candidate, eventType, workspaceId] of cases) {
      // Act
      const route = devFastLaneRoute(candidate, eventType, workspaceId);

      // Assert
      expect(route, `${eventType}/${workspaceId}`).toBeNull();
    }
  });
});

describe("devFastLaneWorkerLane", () => {
  it("activates only for an unattested lane build whose single admission failure is the missing receipt", () => {
    // Arrange
    const lane = enabledLane();

    // Act
    const result = devFastLaneWorkerLane(
      lane,
      unattested("DEV_FAST_LANE_UNATTESTED"),
      admission({ build: "DEV_FAST_LANE_UNATTESTED" }),
    );

    // Assert
    expect(result).toEqual({ active: true, blocking: [] });
  });

  it("stays inactive and lists every failure when anything else fails", () => {
    // Act
    const result = devFastLaneWorkerLane(
      enabledLane(),
      unattested("DEV_FAST_LANE_UNATTESTED"),
      admission({
        build: "DEV_FAST_LANE_UNATTESTED",
        environment: "MANAGED_NODE_ENV_REQUIRED",
      }),
    );

    // Assert
    expect(result).toEqual({
      active: false,
      blocking: [
        "build:DEV_FAST_LANE_UNATTESTED",
        "environment:MANAGED_NODE_ENV_REQUIRED",
      ],
    });
  });

  it("never activates for an attested build, another unattested code, or a disabled lane", () => {
    // Arrange
    const attested = { attested: true } as RuntimeReleaseIdentity;
    const cases: Array<[DevFastLane, RuntimeReleaseIdentity, string]> = [
      [enabledLane(), attested, "attested"],
      [enabledLane(), unattested("TEST_RUNTIME_UNATTESTED"), "test"],
      [enabledLane(), unattested("BUILD_ATTESTATION_REQUIRED"), "required"],
      [enabledLane(), unattested("BUILD_ATTESTATION_INVALID"), "invalid"],
      [{ enabled: false }, unattested("DEV_FAST_LANE_UNATTESTED"), "disabled"],
    ];

    for (const [lane, identity, label] of cases) {
      // Act
      const result = devFastLaneWorkerLane(
        lane,
        identity,
        admission(
          identity.attested
            ? {}
            : { build: (identity as { code: string }).code },
        ),
      );

      // Assert
      expect(result.active, label).toBe(false);
    }
  });
});

describe("checkDevFastLaneSourceSchema", () => {
  it("requires the managed schema digest and compares it exactly with the source schema", () => {
    // Arrange
    const lane = enabledLane();
    const pinned = resolveDevFastLane(
      "development",
      laneEnv({ [DEV_FAST_LANE_SCHEMA_DIGEST_ENV]: DIGEST }),
    );
    if (!pinned.enabled) throw new Error("fixture lane must be enabled");

    // Act + Assert
    expect(checkDevFastLaneSourceSchema(lane, DIGEST)).toEqual({
      status: "failed",
      code: "DEV_FAST_LANE_SCHEMA_DIGEST_REQUIRED",
    });
    expect(
      checkDevFastLaneSourceSchema(pinned, `sha256:${"b".repeat(64)}`),
    ).toEqual({ status: "failed", code: "SCHEMA_DIGEST_MISMATCH" });
    expect(checkDevFastLaneSourceSchema(pinned, DIGEST)).toEqual({
      status: "ok",
    });
  });
});

describe("NULL_LEASE_WRITER", () => {
  it("accepts every heartbeat without writing a lease", async () => {
    await expect(
      NULL_LEASE_WRITER.heartbeat("WORKER", "READY", "anything"),
    ).resolves.toBeUndefined();
  });
});
