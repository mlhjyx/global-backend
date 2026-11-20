/** Internal CI fixture guards; no caller-supplied image or build recipe. */
export const MINIO_FIXTURE_COMMIT = "07c3a429bfed433e49018cb0f78a52145d4bedeb";
export const MINIO_FIXTURE_RELEASE = "RELEASE.2025-09-07T16-13-09Z";
export const MINIO_FIXTURE_LABEL = "global.manufacturer-fixture";

export function fixtureImageId(value: string): string {
  const id = value.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(id))
    throw new Error("MANUFACTURER_TEST_IMAGE_ID_INVALID");
  return id;
}
export function assertFixtureOwnership(
  metadata: string,
  imageId: string,
  taskId: string,
): void {
  const value = JSON.parse(metadata);
  if (
    !/^[a-f0-9]{32}$/u.test(taskId) ||
    value?.id !== imageId ||
    value?.task !== taskId ||
    value?.os !== "linux" ||
    value?.architecture !== "amd64"
  )
    throw new Error("MANUFACTURER_TEST_IMAGE_OWNERSHIP_INVALID");
}
export function assertFixtureVersion(version: string): void {
  if (
    version.split(/\r?\n/u)[0]?.trim() !==
    `minio version ${MINIO_FIXTURE_RELEASE} (commit-id=${MINIO_FIXTURE_COMMIT})`
  )
    throw new Error("MANUFACTURER_TEST_MINIO_VERSION_INVALID");
}
