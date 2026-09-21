import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { RuntimeAdmissionService } from "./runtime-admission";
import { RuntimeReleaseIdentityService } from "./runtime-release-identity";

export const RUNTIME_CLOCK_SCHEMA = "runtime-clock-observation/v1" as const;
/** Observation only: never claims NTP synchronization or alters the local clock. */
export class RuntimeClockService {
  constructor(
    private readonly admission: RuntimeAdmissionService,
    private readonly identity: RuntimeReleaseIdentityService,
    private readonly now: () => number = Date.now,
  ) {}

  observe(originalUrl: string) {
    const match = /^\/api\/v1\/health\/clock\?nonce=([a-f0-9]{32})$/.exec(
      originalUrl,
    );
    if (!match) throw new BadRequestException("RUNTIME_CLOCK_REQUEST_INVALID");
    const build = this.identity.current();
    if (!this.admission.current().admitted || !build.attested)
      throw new ServiceUnavailableException("RUNTIME_CLOCK_UNAVAILABLE");
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0)
      throw new ServiceUnavailableException("RUNTIME_CLOCK_UNAVAILABLE");
    return {
      schemaVersion: RUNTIME_CLOCK_SCHEMA,
      nonce: match[1],
      observedAt,
      buildSha: build.build_sha,
      imageDigest: build.image_digest,
      artifactDigest: build.artifact_digest,
    };
  }
}
