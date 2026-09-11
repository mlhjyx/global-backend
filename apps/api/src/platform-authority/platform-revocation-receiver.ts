import { createHash } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { PlatformAuthorityFenceAckClaimsSchema, PLATFORM_AUTHORITY_FENCE_ACK_TYPE } from "@global/contracts/execution-budget";
import { SignedFenceAck, type PlatformFenceAckCipher, type PlatformFenceAckSigner } from "./platform-fence-ack-crypto";
import type { PlatformRevocationVerifier } from "./platform-revocation-verifier";
import type { PlatformRevocationRepository } from "./platform-revocation.repository";
import type { PlatformFenceAckDeliveryRepository } from "./platform-fence-ack-delivery.repository";

function unavailable(): never { throw new Error("PLATFORM_FENCE_ACK_DELIVERY_UNAVAILABLE"); }
export class PlatformRevocationReceiver {
  constructor(private readonly dependencies: {
    readonly ackIssuer: string;
    readonly verifier: Pick<PlatformRevocationVerifier, "inspect">;
    readonly revocations: Pick<PlatformRevocationRepository, "apply">;
    readonly deliveries: Pick<PlatformFenceAckDeliveryRepository, "read" | "store">;
    readonly signer: Pick<PlatformFenceAckSigner, "sign"> | null;
    readonly cipher: Pick<PlatformFenceAckCipher, "encrypt" | "decrypt">;
  }) {}
  async receive(compactCommand: string): Promise<SignedFenceAck> {
    // Preserve bounded verifier and durable fence errors before any ACK work starts.
    const command = await this.dependencies.verifier.inspect(compactCommand);
    const receipt = await this.dependencies.revocations.apply(command);
    if (command.expired && !receipt.replay) throw new Error("PLATFORM_REVOCATION_EXPIRED");
    try {
      let stored = await this.dependencies.deliveries.read(receipt.receiptId, command.tokenSha256);
      if (!stored) {
        if (!this.dependencies.signer) return unavailable();
        const candidate = this.dependencies.signer.sign(receipt, {
          revocationJti: command.claims.revocation_jti, tokenSha256: command.tokenSha256,
          scheduleId: command.claims.schedule_id, fenceSequence: command.claims.fence_sequence,
        });
        const context = { receiptId: receipt.receiptId, commandSha256: command.tokenSha256,
          ackSha256: candidate.tokenSha256, signingKeyId: candidate.keyId };
        stored = await this.dependencies.deliveries.store({ ...context, ...this.dependencies.cipher.encrypt(context, candidate.token) });
      }
      // Deliver only the database winner, never this invocation's uncommitted candidate.
      if (stored.receiptId !== receipt.receiptId || stored.commandSha256 !== command.tokenSha256) return unavailable();
      const token = this.dependencies.cipher.decrypt(stored, stored);
      if (createHash("sha256").update(token).digest("hex") !== stored.ackSha256) return unavailable();
      const header = decodeProtectedHeader(token);
      if (header.alg !== "RS256" || header.typ !== PLATFORM_AUTHORITY_FENCE_ACK_TYPE || header.kid !== stored.signingKeyId ||
          Object.keys(header).sort().join(",") !== "alg,kid,typ") return unavailable();
      const claims = PlatformAuthorityFenceAckClaimsSchema.parse(decodeJwt(token));
      if (claims.iss !== this.dependencies.ackIssuer || claims.jti !== receipt.receiptId ||
          claims.revocation_jti !== command.claims.revocation_jti || claims.command_sha256 !== command.tokenSha256 ||
          claims.schedule_id !== command.claims.schedule_id || claims.fence_sequence !== command.claims.fence_sequence ||
          claims.backend_generation !== receipt.generation || claims.in_flight_attempts !== receipt.inFlightAttempts ||
          claims.committed_at !== Math.floor(receipt.committedAt.getTime() / 1000)) return unavailable();
      // Expired immutable ACKs are replayed unchanged. GrowthOS requires its exact pending command.
      // AES-GCM proves the stored origin here; GrowthOS independently verifies the ACK signature.
      return new SignedFenceAck(token, stored.signingKeyId, stored.ackSha256);
    } catch { return unavailable(); }
  }
}
