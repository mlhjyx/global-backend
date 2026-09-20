import { describe, expect, it, vi } from "vitest";
import { PlatformFenceAckDeliveryRepository } from "./platform-fence-ack-delivery.repository";
const principal = { sessionUser: "writer", currentUser: "writer", canLogin: true, superuser: false,
  bypassRls: false, createDb: false, createRole: false, replication: false, inherit: true, memberships: ["execution_budget_platform_writer"] };
const value = { receiptId: "11111111-1111-4111-8111-111111111111", commandSha256: "a".repeat(64),
  ackSha256: "b".repeat(64), signingKeyId: "ack-1", keyId: "cipher-1", ciphertext: Buffer.alloc(64, 7) };
const row = { receipt_id: value.receiptId, command_token_sha256: value.commandSha256, ack_token_sha256: value.ackSha256,
  signing_key_id: value.signingKeyId, cipher_key_id: value.keyId, ciphertext: value.ciphertext };
function db(rows: unknown) {
  const query = vi.fn().mockResolvedValueOnce([principal]).mockResolvedValueOnce(rows);
  const writer = { $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    $queryRaw: query, $executeRawUnsafe: vi.fn().mockResolvedValue(0),
  })) };
  return { query, writer };
}
describe("encrypted ACK delivery persistence", () => {
  it("accepts Prisma 6 BYTEA Uint8Array results and snapshots them as a Buffer", async () => {
    const bytes = new Uint8Array(value.ciphertext);
    const fixture = db([{ ...row, ciphertext: bytes }]);
    const result = await new PlatformFenceAckDeliveryRepository(fixture.writer as never).read(value.receiptId, value.commandSha256);
    expect(result).toEqual(value);
    bytes.fill(0);
    expect(result!.ciphertext.equals(value.ciphertext)).toBe(true);
  });
  it("returns the durable first winner rather than a new local candidate", async () => {
    const fixture = db([row]);
    const candidate = { ...value, ackSha256: "c".repeat(64), ciphertext: Buffer.alloc(80, 8) };
    const result = await new PlatformFenceAckDeliveryRepository(fixture.writer as never).store(candidate);
    expect(result).toEqual(value);
    expect(fixture.query.mock.calls[1][0].text).toContain("store_platform_fence_ack_v1");
    expect(fixture.query.mock.calls[1][0].values).toContain(candidate.ackSha256);
  });
  it("returns absence only after authenticated read and never invents ciphertext", async () => {
    const fixture = db([]);
    expect(await new PlatformFenceAckDeliveryRepository(fixture.writer as never).read(value.receiptId, value.commandSha256)).toBeNull();
    expect(fixture.query.mock.calls[1][0].text).toContain("read_platform_fence_ack_v1");
  });
  it.each([[], [row, row], [{ ...row, command_token_sha256: "d".repeat(64) }],
    [{ ...row, receipt_id: "22222222-2222-4222-8222-222222222222" }], [{ ...row, ciphertext: Buffer.alloc(28) }],
    [{ ...row, cipher_key_id: "unsafe\n" }], [{ ...row, ack_token_sha256: "bad" }]].map(rows => ({ rows })))(
    "rejects invalid, absent or incorrectly bound stored delivery", async ({ rows }) => {
      const fixture = db(rows);
      await expect(new PlatformFenceAckDeliveryRepository(fixture.writer as never).store(value)).rejects.toThrow("PLATFORM_FENCE_ACK_PERSISTENCE_UNAVAILABLE");
    },
  );
  it("does not use missing or overprivileged writer and rejects bad input before SQL", async () => {
    await expect(new PlatformFenceAckDeliveryRepository().store(value)).rejects.toThrow();
    const fixture = db([row]);
    const repository = new PlatformFenceAckDeliveryRepository(fixture.writer as never);
    await expect(repository.store({ ...value, ciphertext: Buffer.alloc(16413) })).rejects.toThrow();
    expect(fixture.writer.$transaction).not.toHaveBeenCalled();
    fixture.query.mockReset().mockResolvedValueOnce([{ ...principal, superuser: true }]);
    await expect(repository.read(value.receiptId, value.commandSha256)).rejects.toThrow();
    expect(fixture.query).toHaveBeenCalledTimes(1);
  });
});
