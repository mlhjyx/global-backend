import { describe, expect, it, vi } from "vitest";
import { PlatformRevocationRepository } from "./platform-revocation.repository";
import type { AuthenticatedPlatformRevocation } from "./platform-revocation-verifier";

const command: AuthenticatedPlatformRevocation = {
  claims: { schema_version: "PlatformExecutionBudgetAuthorityRevoked/v1", iss: "https://growthos.example",
    aud: "global-backend:execution-budget", revocation_jti: "11111111-1111-4111-8111-111111111111",
    target_issuer: "https://growthos.example", target_jti: "22222222-2222-4222-8222-222222222222",
    schedule_id: "acq-sweep", workflow_run_id: "33333333-3333-4333-8333-333333333333",
    fence_sequence: "1", reason_code: "POLICY_DISABLED", iat: 1788830000, nbf: 1788830000, exp: 1788830300 },
  tokenSha256: "a".repeat(64), expired: false,
};
const principal = { sessionUser: "platform_writer_login", currentUser: "platform_writer_login", canLogin: true,
  superuser: false, bypassRls: false, createDb: false, createRole: false, replication: false, inherit: true,
  memberships: ["execution_budget_platform_writer"] };
const row = { receipt_id: "44444444-4444-4444-8444-444444444444", generation: 2n,
  committed_at: new Date("2026-09-08T00:00:00Z"), in_flight_attempts: 1n, replay: false };
function database(result: unknown = [row], commitFails = false) {
  const query = vi.fn().mockResolvedValueOnce([principal]).mockResolvedValueOnce(result);
  const tx = { $queryRaw: query, $executeRawUnsafe: vi.fn().mockResolvedValue(0) };
  const client = { $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const value = await callback(tx);
    if (commitFails) throw new Error("commit ACK lost with private diagnostic");
    return value;
  }) };
  return { client, query, tx };
}
describe("signed revocation persistence", () => {
  it("returns durable receipt only after the dedicated writer transaction commits", async () => {
    const db = database();
    const result = await new PlatformRevocationRepository(db.client as never).apply(command);
    expect(result).toEqual({ receiptId: row.receipt_id, generation: "2", committedAt: row.committed_at,
      inFlightAttempts: "1", replay: false });
    const sql = db.query.mock.calls[1][0];
    expect(sql.text).toContain("apply_platform_revocation_fence_v1");
    expect(sql.values).toContain(command.tokenSha256);
    expect(sql.values).toContain(command.claims.target_jti);
    expect(sql.values).toContain(1n);
    expect(db.client.$transaction.mock.calls[0][1]).toEqual({ maxWait: 1000, timeout: 5500 });
  });
  it("does not expose a receipt after an uncertain commit", async () => {
    const db = database([row], true);
    await expect(new PlatformRevocationRepository(db.client as never).apply(command))
      .rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
  });
  it("never falls back to an app or owner connection", async () => {
    await expect(new PlatformRevocationRepository().apply(command)).rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
    const db = database(); db.query.mockReset().mockResolvedValueOnce([{ ...principal, superuser: true }]);
    await expect(new PlatformRevocationRepository(db.client as never).apply(command)).rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it.each([[], [null], ["row"], [{ ...row, receipt_id: "bad" }], [{ ...row, replay: "true" }],
    [{ ...row, generation: -1n }], [{ ...row, generation: "1" }], [{ ...row, generation: 9223372036854775808n }],
    [{ ...row, in_flight_attempts: -1n }], [{ ...row, in_flight_attempts: "0" }],
    [{ ...row, in_flight_attempts: 9223372036854775808n }], [{ ...row, committed_at: "now" }],
    [{ ...row, committed_at: new Date(Number.NaN) }], [row, row]].map(rows => ({ rows })))(
    "rejects malformed persistence receipts", async ({ rows }) => {
      const db = database(rows);
      await expect(new PlatformRevocationRepository(db.client as never).apply(command))
        .rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
    },
  );
  it("passes expiry to SQL even on expired authenticated replay", async () => {
    const db = database([{ ...row, replay: true }]);
    const result = await new PlatformRevocationRepository(db.client as never).apply({ ...command, expired: true });
    expect(result.replay).toBe(true);
    expect(db.query.mock.calls[1][0].values).toContainEqual(new Date(command.claims.exp * 1000));
  });
  it("rejects an expired command if persistence claims a new fence", async () => {
    const db = database();
    await expect(new PlatformRevocationRepository(db.client as never).apply({ ...command, expired: true }))
      .rejects.toThrow("PLATFORM_REVOCATION_EXPIRED");
  });
  it("validates the authenticated digest before entering a transaction", async () => {
    const db = database();
    await expect(new PlatformRevocationRepository(db.client as never).apply({ ...command, tokenSha256: "invalid" }))
      .rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
    expect(db.client.$transaction).not.toHaveBeenCalled();
  });
  it.each(["PLATFORM_REVOCATION_REUSED", "PLATFORM_REVOCATION_SCOPE_MISMATCH", "PLATFORM_REVOCATION_SEQUENCE_CONFLICT"])(
    "preserves only the stable database failure code %s", async code => {
      const db = database();
      db.query.mockReset().mockResolvedValueOnce([principal]).mockRejectedValueOnce(new Error(`private diagnostic ${code}`));
      const result = await new PlatformRevocationRepository(db.client as never).apply(command).catch(error => error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe(code);
      expect(result).not.toHaveProperty("cause");
    },
  );
});
