import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSingleReplayConnection,
  assertSingleReplayRun,
  parseSingleReplayInput,
  SINGLE_REPLAY_FLAG,
  SINGLE_REPLAY_OUTPUT_MODE,
  throwingSingleReplayEgressStub,
} from "./verify-single-retained-acquisition-replay.mts";

const workspaceId = "44932eec-3707-4092-baba-305ddc1324e7";
const runId = "f697d5a0-5d7a-4e1c-a40d-302d7fe5f406";

function env(
  url = "postgresql://app_user:redacted@127.0.0.1:55432/global_identity_fresh2_acceptance",
) {
  return {
    APP_DATABASE_URL: url,
    ACQUISITION_REPLAY_WORKSPACE_ID: workspaceId,
    ACQUISITION_REPLAY_RUN_ID: runId,
    ACQUISITION_REPLAY_PROVIDER_KEY: "world_bank_procurement",
  };
}

describe("single retained acquisition replay admission", () => {
  it("accepts only an explicit loopback acceptance target", () => {
    expect(parseSingleReplayInput([SINGLE_REPLAY_FLAG], env())).toMatchObject({
      databaseName: "global_identity_fresh2_acceptance",
      workspaceId,
      runId,
      providerKey: "world_bank_procurement",
    });
    expect(() =>
      parseSingleReplayInput(
        [SINGLE_REPLAY_FLAG],
        env(
          "postgresql://app_user:redacted@db.example.com:5432/global_acceptance",
        ),
      ),
    ).toThrow("SINGLE_REPLAY_DATABASE_NOT_LOOPBACK");
    expect(() =>
      parseSingleReplayInput(
        [SINGLE_REPLAY_FLAG],
        env("postgresql://app_user:redacted@127.0.0.1:55432/global_dev"),
      ),
    ).toThrow("SINGLE_REPLAY_DATABASE_NOT_ACCEPTANCE");
  });

  it("rejects owner, superuser and BYPASSRLS connections", () => {
    const base = {
      databaseName: "global_identity_fresh2_acceptance",
      currentUser: "app_user",
      superuser: false,
      bypassRls: false,
    };
    expect(() =>
      assertSingleReplayConnection(base.databaseName, {
        ...base,
        currentUser: "global",
      }),
    ).toThrow("SINGLE_REPLAY_APP_USER_REQUIRED");
    expect(() =>
      assertSingleReplayConnection(base.databaseName, {
        ...base,
        superuser: true,
      }),
    ).toThrow("SINGLE_REPLAY_RLS_ROLE_REQUIRED");
    expect(() =>
      assertSingleReplayConnection(base.databaseName, {
        ...base,
        bypassRls: true,
      }),
    ).toThrow("SINGLE_REPLAY_RLS_ROLE_REQUIRED");
  });

  it("rejects provider and run scope mismatches", () => {
    const expected = {
      workspaceId,
      runId,
      providerKey: "world_bank_procurement",
    };
    expect(() =>
      assertSingleReplayRun(
        expected,
        { id: runId, workspaceId, status: "DONE" },
        [{ providerKey: "nppes", ingestStatus: "ACCEPTED" }],
      ),
    ).toThrow("SINGLE_REPLAY_PROVIDER_RUN_MISMATCH");
    expect(() =>
      assertSingleReplayRun(
        expected,
        { id: runId, workspaceId: crypto.randomUUID(), status: "DONE" },
        [{ providerKey: "world_bank_procurement", ingestStatus: "ACCEPTED" }],
      ),
    ).toThrow("SINGLE_REPLAY_RUN_SCOPE_MISMATCH");
  });

  it("fails closed on any egress access and has no file-writing path", () => {
    expect(
      () =>
        (throwingSingleReplayEgressStub("provider") as { get: unknown }).get,
    ).toThrow("SINGLE_REPLAY_FORBIDDEN_EGRESS_provider");
    expect(SINGLE_REPLAY_OUTPUT_MODE).toBe("STDOUT_ONLY");
    const source = readFileSync(
      new URL(
        "./verify-single-retained-acquisition-replay.mts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:writeFile|appendFile|mkdir)\b/u);
  });
});
