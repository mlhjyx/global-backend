import { describe, expect, it, vi } from "vitest";
import { RuntimeClockService } from "./runtime-clock.service";
import {
  RuntimeReleaseIdentityService,
  type RuntimeReleaseIdentity,
} from "./runtime-release-identity";
import { RuntimeAdmissionService } from "./runtime-admission";

const nonce = "a".repeat(32);
const identity = {
  attested: true,
  build_sha: "1".repeat(40),
  image_digest: `sha256:${"2".repeat(64)}`,
  artifact_digest: `sha256:${"3".repeat(64)}`,
} as RuntimeReleaseIdentity;
function setup(admitted = true, build = identity, now = () => 1800000000000) {
  return new RuntimeClockService(
    { current: () => ({ admitted }) } as RuntimeAdmissionService,
    new RuntimeReleaseIdentityService(build),
    now,
  );
}
describe("runtime clock is an admitted local observation, not a caller clock", () => {
  it("returns exact closed nonce/identity and reads local wall clock once", () => {
    const now = vi.fn(() => 1800000000000);
    expect(
      setup(true, identity, now).observe(`/api/v1/health/clock?nonce=${nonce}`),
    ).toEqual({
      schemaVersion: "runtime-clock-observation/v1",
      nonce,
      observedAt: 1800000000000,
      buildSha: "1".repeat(40),
      imageDigest: `sha256:${"2".repeat(64)}`,
      artifactDigest: `sha256:${"3".repeat(64)}`,
    });
    expect(now).toHaveBeenCalledTimes(1);
  });
  it.each([
    "",
    "/api/v1/health/clock",
    `/api/v1/health/clock?nonce=${nonce}&now=0`,
    `/api/v1/health/clock?nonce=${nonce}&nonce=${nonce}`,
    `/api/v1/health/clock?nonce=${nonce.toUpperCase()}`,
    `/api/v1/health/clock/?nonce=${nonce}`,
    `/api/v1/health/clock?nonce=%61${nonce.slice(1)}`,
  ])("rejects noncanonical/extra query %s", (url) => {
    expect(() => setup().observe(url)).toThrow("RUNTIME_CLOCK_REQUEST_INVALID");
  });
  it("requires own admission and real immutable release identity", () => {
    expect(() =>
      setup(false).observe(`/api/v1/health/clock?nonce=${nonce}`),
    ).toThrow("RUNTIME_CLOCK_UNAVAILABLE");
    expect(() =>
      setup(true, {
        attested: false,
        schema_version: "global-runtime-release-identity/v1",
        code: "TEST_RUNTIME_UNATTESTED",
      }).observe(`/api/v1/health/clock?nonce=${nonce}`),
    ).toThrow("RUNTIME_CLOCK_UNAVAILABLE");
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid local clock %s",
    (now) => {
      expect(() =>
        setup(true, identity, () => now).observe(
          `/api/v1/health/clock?nonce=${nonce}`,
        ),
      ).toThrow("RUNTIME_CLOCK_UNAVAILABLE");
    },
  );
});
