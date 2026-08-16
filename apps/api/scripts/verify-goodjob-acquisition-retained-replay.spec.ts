import { describe, expect, it } from "vitest";
import {
  RETAINED_REPLAY_FLAG,
  assertChannelReplaySemantics,
  assertConnectionIdentity,
  assertReplayDatabaseUrl,
  assertSnapshotsEqual,
  buildStableSummary,
  parseReplayInvocation,
  parseReplayManifest,
  serializeSafeResult,
  throwingEgressStub,
  type ReplaySnapshot,
} from "./verify-goodjob-acquisition-retained-replay.mts";

const manifest = JSON.stringify([
  {
    channel: "nppes",
    runId: "312a08db-4985-4348-bca2-dcb80828e29c",
    workspaceId: "bc160c9c-1107-4a28-acbf-fcc03c13b718",
  },
  {
    channel: "world_bank_procurement",
    runId: "ad380b3a-9701-4ba0-b6ee-4e8a65f5f91a",
    workspaceId: "80b2f1f5-789c-40fa-a876-2a01a1750861",
  },
  {
    channel: "usaspending_awards",
    runId: "78df54a2-69a2-4072-90cb-50bdb3fb940c",
    workspaceId: "67715f0e-d210-4c83-9510-6f19432f104e",
  },
  {
    channel: "uk_contracts_finder",
    runId: "eedfd02e-0333-4750-a249-67faf8f24263",
    workspaceId: "0408bd25-38aa-4e50-b5ba-bbbc91efa791",
  },
]);

function snapshot(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  const empty = buildStableSummary([]);
  return {
    run: empty,
    raw: empty,
    governance: empty,
    identityLinks: empty,
    identityConflicts: empty,
    fieldEvidence: empty,
    canonicalCompanies: empty,
    organizationIdentifiers: empty,
    leads: empty,
    outbox: empty,
    qualityLedger: empty,
    relayState: { publishedCount: 0, parkedCount: 0 },
    ...overrides,
  };
}

describe("retained acquisition replay verifier", () => {
  it("requires one explicit flag", () => {
    expect(parseReplayInvocation([RETAINED_REPLAY_FLAG])).toEqual({
      verify: true,
    });
    expect(() => parseReplayInvocation([])).toThrow(/explicit/u);
    expect(() =>
      parseReplayInvocation([RETAINED_REPLAY_FLAG, "--extra"]),
    ).toThrow(/explicit/u);
  });

  it("admits only loopback PostgreSQL acceptance URLs without returning credentials", () => {
    expect(
      assertReplayDatabaseUrl(
        "postgresql://app_user:secret@127.0.0.1:55432/fresh2_acceptance",
      ),
    ).toEqual({
      databaseName: "fresh2_acceptance",
      hostKind: "loopback",
    });
    expect(() =>
      assertReplayDatabaseUrl(
        "postgresql://app_user:secret@db.internal:5432/fresh2_acceptance",
      ),
    ).toThrow();
    expect(() =>
      assertReplayDatabaseUrl(
        "postgresql://app_user:secret@127.0.0.1:55432/global_dev",
      ),
    ).toThrow();
  });

  it("requires exact app_user RLS identity and admitted database", () => {
    const admitted = {
      databaseName: "fresh2_acceptance",
      hostKind: "loopback" as const,
    };
    expect(() =>
      assertConnectionIdentity(admitted, {
        databaseName: "fresh2_acceptance",
        currentUser: "owner",
        superuser: false,
        bypassRls: false,
      }),
    ).toThrow(/app_user/u);
    expect(() =>
      assertConnectionIdentity(admitted, {
        databaseName: "fresh2_acceptance",
        currentUser: "app_user",
        superuser: false,
        bypassRls: true,
      }),
    ).toThrow(/BYPASSRLS/u);
    expect(
      assertConnectionIdentity(admitted, {
        databaseName: "fresh2_acceptance",
        currentUser: "app_user",
        superuser: false,
        bypassRls: false,
      }),
    ).toEqual(admitted);
  });

  it("accepts exactly the four canonical manifest entries and selectors", () => {
    expect(parseReplayManifest(manifest).map((entry) => entry.channel)).toEqual(
      [
        "nppes",
        "world_bank_procurement",
        "usaspending_awards",
        "uk_contracts_finder",
      ],
    );
    const wrong = JSON.parse(manifest) as Array<Record<string, string>>;
    wrong[0]!.runId = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(() => parseReplayManifest(JSON.stringify(wrong))).toThrow(/nppes/u);
    expect(() =>
      parseReplayManifest(JSON.stringify(wrong.slice(0, 3))),
    ).toThrow(/four/u);
  });

  it("uses deterministic order-independent summaries without exposing row values", () => {
    const first = buildStableSummary([
      { id: "2", value: "sensitive-b" },
      { id: "1", value: "sensitive-a" },
    ]);
    const second = buildStableSummary([
      { value: "sensitive-a", id: "1" },
      { value: "sensitive-b", id: "2" },
    ]);
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("sensitive");
  });

  it("fails closed on any semantic snapshot difference but ignores relay publication counters", () => {
    const before = snapshot({ raw: buildStableSummary([{ id: "raw-1" }]) });
    expect(() =>
      assertSnapshotsEqual(before, {
        ...before,
        relayState: { publishedCount: 1, parkedCount: 0 },
      }),
    ).not.toThrow();
    expect(() =>
      assertSnapshotsEqual(before, {
        ...before,
        raw: buildStableSummary([{ id: "raw-2" }]),
      }),
    ).toThrow(/raw/u);
  });

  it("enforces ordinary replay and USA permanent restriction semantics separately", () => {
    expect(() =>
      assertChannelReplaySemantics({
        channel: "nppes",
        providerKey: "nppes",
        visibleAcceptedRawCount: 2,
        restrictedRawCount: 0,
        result: {
          suppressed: 0,
          identityQuality: {
            nppes: {
              acceptedRows: 2,
              boundRows: 2,
              replayedRows: 2,
              conflictRows: 0,
              suppressedRows: 0,
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertChannelReplaySemantics({
        channel: "usaspending_awards",
        providerKey: "usaspending_awards",
        visibleAcceptedRawCount: 0,
        restrictedRawCount: 3,
        result: {
          suppressed: 3,
          identityQuality: {
            usaspending_awards: {
              acceptedRows: 0,
              boundRows: 0,
              replayedRows: 0,
              conflictRows: 0,
              suppressedRows: 3,
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertChannelReplaySemantics({
        channel: "usaspending_awards",
        providerKey: "usaspending_awards",
        visibleAcceptedRawCount: 2,
        restrictedRawCount: 0,
        result: {
          suppressed: 0,
          identityQuality: {
            usaspending_awards: {
              acceptedRows: 2,
              boundRows: 2,
              replayedRows: 2,
              conflictRows: 0,
              suppressedRows: 0,
            },
          },
        },
      }),
    ).not.toThrow();
  });

  it("throws on any accidental provider, gateway, or broker access and serializes no sensitive material", () => {
    const stub = throwingEgressStub("provider");
    expect(() => (stub as Record<string, unknown>).discoverCompanies).toThrow(
      /forbidden/u,
    );
    const serialized = serializeSafeResult({
      status: "PASS",
      database: { databaseName: "fresh2_acceptance" },
    });
    expect(serialized).toContain("PASS");
    expect(() =>
      serializeSafeResult({
        databaseUrl: "postgresql://app:secret@127.0.0.1/db",
      }),
    ).toThrow(/sensitive/u);
  });
});
