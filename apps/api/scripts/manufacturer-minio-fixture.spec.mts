import { describe, expect, it } from "vitest";
import {
  fixtureImageId,
  assertFixtureOwnership,
  assertFixtureVersion,
  MINIO_FIXTURE_COMMIT,
  MINIO_FIXTURE_RELEASE,
} from "./manufacturer-minio-fixture.mjs";
const imageId = "sha256:" + "a".repeat(64);
describe("source-built manufacturer fixture identity", () => {
  it("accepts only a canonical immutable image ID from the build iidfile", () => {
    expect(fixtureImageId(imageId + "\n")).toBe(imageId);
  });
  it.each([
    "minio/minio:latest",
    "quay.io/minio/minio@" + imageId,
    "sha256:" + "a".repeat(63),
    imageId + " extra",
    "",
    "sha256:" + "A".repeat(64),
  ])("refuses an unsafe image reference %s", (value) => {
    expect(() => fixtureImageId(value)).toThrow(
      "MANUFACTURER_TEST_IMAGE_ID_INVALID",
    );
  });
  it("checks generated task ownership and execution platform before cleanup/use", () => {
    const metadata = {
      id: imageId,
      task: "b".repeat(32),
      os: "linux",
      architecture: "amd64",
    };
    expect(() =>
      assertFixtureOwnership(JSON.stringify(metadata), imageId, "b".repeat(32)),
    ).not.toThrow();
    for (const change of [
      { id: "other" },
      { task: "other" },
      { os: "other" },
      { architecture: "arm64" },
    ])
      expect(() =>
        assertFixtureOwnership(
          JSON.stringify({ ...metadata, ...change }),
          imageId,
          "b".repeat(32),
        ),
      ).toThrow("MANUFACTURER_TEST_IMAGE_OWNERSHIP_INVALID");
  });
  it("validates the running binary release and exact upstream commit, not a base-image label", () => {
    expect(() =>
      assertFixtureVersion(
        `minio version ${MINIO_FIXTURE_RELEASE} (commit-id=${MINIO_FIXTURE_COMMIT})`,
      ),
    ).not.toThrow();
    for (const version of [
      MINIO_FIXTURE_RELEASE,
      "minio version DEVELOPMENT",
      `untrusted label: minio version ${MINIO_FIXTURE_RELEASE} (commit-id=${MINIO_FIXTURE_COMMIT})`,
      `minio version ${MINIO_FIXTURE_RELEASE} (commit-id=32d8)`,
    ])
      expect(() => assertFixtureVersion(version)).toThrow(
        "MANUFACTURER_TEST_MINIO_VERSION_INVALID",
      );
  });
});
