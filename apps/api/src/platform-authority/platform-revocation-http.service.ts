import type { PlatformRevocationTrustRuntime } from "./platform-revocation-trust.runtime";
import type { PlatformRevocationRepository } from "./platform-revocation.repository";
import type { PlatformFenceAckDeliveryRepository } from "./platform-fence-ack-delivery.repository";
import { PlatformRevocationReceiver } from "./platform-revocation-receiver";
import { type SignedFenceAck } from "./platform-fence-ack-crypto";
import type { RevocationRequestScope } from "./platform-revocation-http.middleware";
import {
  parsePlatformRevocationRequest,
  PlatformRevocationHttpError,
  revocationFailure,
  PLATFORM_REVOCATION_HTTP_DEADLINE_MS,
  type RevocationHttpInput,
} from "./platform-revocation-http.contract";

interface Dependencies {
  trust: Pick<PlatformRevocationTrustRuntime, "open" | "assertCurrent">;
  revocations: Pick<PlatformRevocationRepository, "apply">;
  deliveries: Pick<PlatformFenceAckDeliveryRepository, "read" | "store">;
  limiter: { allow(issuer: string): Promise<boolean> };
  admitted(): boolean;
}
function mapped(error: unknown): never {
  if (error instanceof PlatformRevocationHttpError) throw error;
  const code = error instanceof Error ? error.message : "";
  if (code === "PLATFORM_REVOCATION_INVALID")
    return revocationFailure("denied");
  if (code === "PLATFORM_REVOCATION_EXPIRED")
    return revocationFailure("expired");
  if (code === "PLATFORM_REVOCATION_SCOPE_MISMATCH")
    return revocationFailure("scope");
  if (code === "PLATFORM_REVOCATION_REUSED") return revocationFailure("reused");
  if (code === "PLATFORM_REVOCATION_SEQUENCE_CONFLICT")
    return revocationFailure("sequenceConflict");
  return revocationFailure();
}
/** HTTP orchestration only. Existing verifier, repositories and Receiver remain
 * authoritative; timeout never implies rollback or permission to sign a substitute. */
export class PlatformRevocationHttpService {
  private closed = false;
  private readonly active = new Set<() => void>();
  constructor(private readonly dependencies: Dependencies) {}
  async receive(
    input: RevocationHttpInput,
    scope: RevocationRequestScope,
  ): Promise<SignedFenceAck> {
    let finished = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      stop: (() => void) | undefined;
    const guard = () => {
      scope.assertActive();
      const now = performance.now();
      if (
        finished ||
        this.closed ||
        scope.signal.aborted ||
        now < scope.startedAt ||
        now >= scope.deadlineAt ||
        scope.deadlineAt - scope.startedAt >
          PLATFORM_REVOCATION_HTTP_DEADLINE_MS ||
        !this.dependencies.admitted()
      )
        return revocationFailure();
      this.dependencies.trust.assertCurrent();
    };
    try {
      const compact = parsePlatformRevocationRequest(input);
      guard();
      const unavailable = new Promise<never>((_resolve, reject) => {
        stop = () => {
          finished = true;
          reject(new PlatformRevocationHttpError("unavailable"));
        };
        this.active.add(stop);
        scope.signal.addEventListener("abort", stop, { once: true });
        timer = setTimeout(
          stop,
          Math.max(1, scope.deadlineAt - performance.now()),
        );
        timer.unref();
      });
      const work = async () => {
        const opened = await this.dependencies.trust.open(scope.signal);
        guard();
        const receiver = new PlatformRevocationReceiver({
          ackIssuer: opened.ackIssuer,
          verifier: {
            inspect: async (command) => {
              guard();
              const verified = await opened.verifier.inspect(command);
              guard();
              if (!(await this.dependencies.limiter.allow(verified.claims.iss)))
                return revocationFailure("rateLimited");
              guard();
              return verified;
            },
          },
          revocations: {
            apply: async (command) => {
              guard();
              const result = await this.dependencies.revocations.apply(command);
              guard();
              return result;
            },
          },
          deliveries: {
            read: async (...args) => {
              guard();
              const result = await this.dependencies.deliveries.read(...args);
              guard();
              return result;
            },
            store: async (value) => {
              guard();
              const result = await this.dependencies.deliveries.store(value);
              guard();
              return result;
            },
          },
          signer: {
            sign: (...args) => {
              guard();
              return opened.material.signer.sign(...args);
            },
          },
          cipher: {
            encrypt: (...args) => {
              guard();
              return opened.material.cipher.encrypt(...args);
            },
            decrypt: (...args) => {
              guard();
              return opened.material.cipher.decrypt(...args);
            },
          },
        });
        const ack = await receiver.receive(compact);
        guard();
        if (
          ack.token.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ack.token)
        )
          return revocationFailure();
        return ack;
      };
      const result = await Promise.race([work(), unavailable]);
      guard();
      return result;
    } catch (error) {
      return mapped(error);
    } finally {
      finished = true;
      clearTimeout(timer);
      if (stop) {
        this.active.delete(stop);
        scope.signal.removeEventListener("abort", stop);
      }
    }
  }
  onModuleDestroy(): void {
    this.closed = true;
    for (const stop of this.active) stop();
    this.active.clear();
  }
}
