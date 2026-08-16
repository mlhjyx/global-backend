import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_CAPTURE_FLAG,
  assertAcceptanceDatabaseUrl,
  assertConnectionIdentity,
  buildAcceptanceEnvelope,
  parseCaptureInvocation,
  parseGovernanceWorkspaceManifest,
  sanitizeForEvidence,
} from "./capture-goodjob-acquisition-acceptance.mts";

describe("GoodJob acquisition acceptance capture", () => {
  it("requires an explicit unique governance workspace manifest", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(
      parseGovernanceWorkspaceManifest(JSON.stringify([second, first])),
    ).toEqual([first, second]);
    expect(() => parseGovernanceWorkspaceManifest(undefined)).toThrow(
      /required/i,
    );
    expect(() =>
      parseGovernanceWorkspaceManifest(JSON.stringify([first, first])),
    ).toThrow(/duplicates/i);
  });

  it("requires the explicit capture flag", () => {
    expect(() => parseCaptureInvocation([])).toThrow(/explicit/i);
    expect(parseCaptureInvocation([ACCEPTANCE_CAPTURE_FLAG])).toEqual({
      capture: true,
    });
  });

  it.each([
    "postgresql://user:secret@db.internal:5432/goodjob_acceptance",
    "postgresql://user:secret@127.0.0.1:5432/global_dev",
    "mysql://user:secret@127.0.0.1:3306/goodjob_acceptance",
  ])("rejects a non-admitted database URL: %s", (databaseUrl) => {
    expect(() => assertAcceptanceDatabaseUrl(databaseUrl)).toThrow();
  });

  it("admits only a loopback PostgreSQL acceptance database without returning credentials", () => {
    expect(
      assertAcceptanceDatabaseUrl(
        "postgresql://app:secret@127.0.0.1:55432/goodjob_acceptance",
      ),
    ).toEqual({
      databaseName: "goodjob_acceptance",
      hostKind: "loopback",
    });
  });

  it("fails closed on connected-database drift or an RLS-bypassing role", () => {
    const admitted = assertAcceptanceDatabaseUrl(
      "postgresql://app:secret@127.0.0.1:55432/goodjob_acceptance",
    );
    expect(() =>
      assertConnectionIdentity(admitted, {
        database_name: "other_acceptance",
        current_user: "app_user",
        superuser: false,
        bypass_rls: false,
      }),
    ).toThrow(/does not exactly match/i);
    expect(() =>
      assertConnectionIdentity(admitted, {
        database_name: "goodjob_acceptance",
        current_user: "owner",
        superuser: true,
        bypass_rls: false,
      }),
    ).toThrow(/non-superuser/i);
    expect(
      assertConnectionIdentity(admitted, {
        database_name: "goodjob_acceptance",
        current_user: "app_user",
        superuser: false,
        bypass_rls: false,
      }),
    ).toMatchObject({
      databaseName: "goodjob_acceptance",
      currentUser: "app_user",
      superuser: false,
      bypassRls: false,
    });
  });

  it("recursively removes URLs, credentials and sensitive fields", () => {
    const sanitized = sanitizeForEvidence({
      sourceUrl: "https://official.example.test/award/1",
      nested: {
        password: "open-sesame",
        note: "fetch http://127.0.0.1:3000/private next",
        authorization: "Bearer abc.def.ghi",
        safe: "DONE",
      },
    });
    const serialized = JSON.stringify(sanitized);

    expect(sanitized).toEqual({
      sourceUrl: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        note: "fetch [REDACTED_URL] next",
        authorization: "[REDACTED]",
        safe: "DONE",
      },
    });
    expect(serialized).not.toContain("official.example.test");
    expect(serialized).not.toContain("open-sesame");
    expect(serialized).not.toContain("abc.def.ghi");
  });

  it("never reports attested true for a dirty worktree and states retained-evidence limits", () => {
    const envelope = buildAcceptanceEnvelope({
      capturedAt: "2026-08-14T00:00:00.000Z",
      git: { head: "a".repeat(40), clean: false, changedPathCount: 9 },
      database: { databaseName: "goodjob_acceptance", hostKind: "loopback" },
      health: {
        ready: { ok: true, status: 200, body: { status: "ok" } },
        build: {
          ok: true,
          status: 200,
          body: { attested: true, build_sha: "a".repeat(40) },
        },
      },
      channels: [],
      historicalGovernance: { status: "CAPTURED", count: 29 },
    });

    expect(envelope.attestation).toMatchObject({
      reportedByRuntime: true,
      effective: false,
      reason: "dirty_worktree",
    });
    expect(envelope.replay).toMatchObject({
      rerunByThisCapture: false,
      status: "NOT_RERUN",
    });
    expect(envelope.claims).toMatchObject({
      scope: "RETAINED_EVIDENCE_SNAPSHOT",
      fullEndToEndClaim: false,
      leadQualifiedProduced: false,
    });
  });

  it("reads the real nested health build identity shape", () => {
    const head = "c".repeat(40);
    const envelope = buildAcceptanceEnvelope({
      capturedAt: "2026-08-14T00:00:00.000Z",
      git: { head, clean: true, changedPathCount: 0 },
      database: { databaseName: "goodjob_acceptance", hostKind: "loopback" },
      health: {
        ready: { ok: true, status: 200, body: { status: "ok" } },
        build: {
          ok: true,
          status: 200,
          body: {
            status: "ok",
            service: "api",
            build: { attested: true, build_sha: head },
          },
        },
      },
      channels: [],
      historicalGovernance: { status: "CAPTURED", count: 29 },
    });

    expect(envelope.attestation).toMatchObject({
      reportedByRuntime: true,
      reportedBuildSha: head,
      buildShaMatches: true,
      effective: true,
    });
  });

  it("does not manufacture a LeadQualified absence when retained events contain one", () => {
    const envelope = buildAcceptanceEnvelope({
      capturedAt: "2026-08-14T00:00:00.000Z",
      git: { head: "b".repeat(40), clean: true, changedPathCount: 0 },
      database: { databaseName: "goodjob_acceptance", hostKind: "loopback" },
      health: {
        ready: { ok: true, status: 200, body: { status: "ok" } },
        build: { ok: true, status: 200, body: { attested: true } },
      },
      channels: [
        {
          channel: "nppes",
          runSelector: "312a08db",
          run: { id: "312a08db-0000-4000-8000-000000000000", status: "DONE" },
          outbox: {
            eventTypeCounts: { LeadQualified: 1 },
            leadQualifiedCount: 1,
          },
        },
      ],
      historicalGovernance: { status: "CAPTURED", count: 29 },
    });

    expect(envelope.claims.leadQualifiedProduced).toBe(true);
    expect(envelope.claims.fullEndToEndClaim).toBe(false);
  });
});
