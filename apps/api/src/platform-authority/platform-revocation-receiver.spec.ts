import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PlatformRevocationReceiver } from "./platform-revocation-receiver";
import { PlatformFenceAckCipher, PlatformFenceAckSigner } from "./platform-fence-ack-crypto";
import type { StoredFenceAck } from "./platform-fence-ack-delivery.repository";

const claims = JSON.parse(readFileSync(new URL("../../../../packages/test-support/fixtures/platform-revocation-ack-v1-vectors.json", import.meta.url), "utf8")).command;
function setup() {
  const order: string[] = [];
  const command = { claims, tokenSha256: "a".repeat(64), expired: false };
  const receipt = { receiptId: "44444444-4444-4444-8444-444444444444", generation: "1", committedAt: new Date(claims.iat * 1000), inFlightAttempts: "0", replay: false };
  const cipher = new PlatformFenceAckCipher("cipher-1", new Map([["cipher-1", Buffer.alloc(32, 7)]]));
  const signer = new PlatformFenceAckSigner("https://backend.example", "ack-1", generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, () => claims.iat);
  const sign = vi.spyOn(signer, "sign");
  let saved: StoredFenceAck | null = null;
  const deps = {
    ackIssuer: "https://backend.example", cipher, signer,
    verifier: { inspect: vi.fn(async () => { order.push("verify"); return command; }) },
    revocations: { apply: vi.fn(async () => { order.push("fence-committed"); return receipt; }) },
    deliveries: { read: vi.fn(async () => { order.push("read"); return saved; }),
      store: vi.fn(async (candidate: StoredFenceAck) => { order.push("ack-committed"); saved ??= candidate; return saved; }) },
  };
  return { deps, sign, order, command, receipt, get saved() { return saved; } };
}
describe("revocation receipt to durable signed ACK delivery", () => {
  it("returns only committed first ACK bytes and replays them without signing again", async () => {
    const fixture = setup(); const receiver = new PlatformRevocationReceiver(fixture.deps);
    const first = await receiver.receive("opaque-command");
    expect(fixture.order).toEqual(["verify", "fence-committed", "read", "ack-committed"]);
    fixture.command.expired = true; fixture.receipt.replay = true;
    const replay = await receiver.receive("opaque-command");
    expect(replay.token).toBe(first.token);
    expect(fixture.sign).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain(first.token);
  });
  it("does not create or return ACK after verification or fence commit failure", async () => {
    const fixture = setup(); const receiver = new PlatformRevocationReceiver(fixture.deps);
    fixture.deps.verifier.inspect.mockRejectedValueOnce(new Error("PLATFORM_REVOCATION_INVALID"));
    await expect(receiver.receive("bad")).rejects.toThrow("PLATFORM_REVOCATION_INVALID");
    expect(fixture.deps.revocations.apply).not.toHaveBeenCalled();
    fixture.deps.revocations.apply.mockRejectedValueOnce(new Error("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE"));
    await expect(receiver.receive("valid")).rejects.toThrow("PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE");
    expect(fixture.sign).not.toHaveBeenCalled();
  });
  it("does not release local signed bytes when ACK persistence commit is unknown", async () => {
    const fixture = setup();
    fixture.deps.deliveries.store.mockRejectedValueOnce(new Error("private database detail"));
    await expect(new PlatformRevocationReceiver(fixture.deps).receive("valid")).rejects.toThrow("PLATFORM_FENCE_ACK_DELIVERY_UNAVAILABLE");
  });
  it("rejects corrupted durable ciphertext instead of signing a replacement", async () => {
    const fixture = setup(); const receiver = new PlatformRevocationReceiver(fixture.deps);
    await receiver.receive("valid");
    fixture.saved!.ciphertext[30] ^= 1;
    await expect(receiver.receive("valid")).rejects.toThrow("PLATFORM_FENCE_ACK_DELIVERY_UNAVAILABLE");
    expect(fixture.sign).toHaveBeenCalledTimes(1);
  });
  it("requires a signer for first delivery but can replay existing ciphertext without an active signing key", async () => {
    const fixture = setup();
    await expect(new PlatformRevocationReceiver({ ...fixture.deps, signer: null }).receive("valid")).rejects.toThrow();
    const first = await new PlatformRevocationReceiver(fixture.deps).receive("valid");
    expect((await new PlatformRevocationReceiver({ ...fixture.deps, signer: null }).receive("valid")).token).toBe(first.token);
  });
  it("will not create an ACK for an expired command falsely reported as a new fence", async () => {
    const fixture = setup(); fixture.command.expired = true;
    await expect(new PlatformRevocationReceiver(fixture.deps).receive("valid")).rejects.toThrow("PLATFORM_REVOCATION_EXPIRED");
    expect(fixture.sign).not.toHaveBeenCalled();
  });
  it.each([
    { header: { typ: "execution-budget-grant+jwt" } }, { header: { kid: "other" } },
    { body: { iss: "https://other.example" } }, { body: { backend_generation: "2" } },
    { body: { command_sha256: "c".repeat(64) } }, { body: { in_flight_attempts: "1" } },
    { body: { committed_at: claims.iat - 1 } }, { body: { extra: "field" } },
  ])("rejects an authenticated ciphertext whose token is not bound to the committed receipt %j", async mutation => {
    const fixture = setup(); const receiver = new PlatformRevocationReceiver(fixture.deps);
    const first = await receiver.receive("valid");
    const [header, body, signature] = first.token.split(".");
    const changedHeader = { ...JSON.parse(Buffer.from(header, "base64url").toString()), ...mutation.header };
    const changedBody = { ...JSON.parse(Buffer.from(body, "base64url").toString()), ...mutation.body };
    const token = [Buffer.from(JSON.stringify(changedHeader)).toString("base64url"), Buffer.from(JSON.stringify(changedBody)).toString("base64url"), signature].join(".");
    const context = { ...fixture.saved!, ackSha256: createHash("sha256").update(token).digest("hex") };
    fixture.deps.deliveries.read.mockResolvedValueOnce({ ...context, ...fixture.deps.cipher.encrypt(context, token) });
    await expect(receiver.receive("valid")).rejects.toThrow("PLATFORM_FENCE_ACK_DELIVERY_UNAVAILABLE");
    expect(fixture.sign).toHaveBeenCalledTimes(1);
  });
});
