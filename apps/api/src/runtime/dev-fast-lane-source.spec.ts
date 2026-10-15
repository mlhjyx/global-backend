import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL,
  readDevFastLaneSourceProvenance,
} from "./dev-fast-lane-source";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("readDevFastLaneSourceProvenance", () => {
  it("derives migration revision and schema digest from the source tree like the build receipt", async () => {
    // Arrange
    const prismaRoot = await mkdtemp(join(tmpdir(), "global-dev-fast-lane-"));
    directories.push(prismaRoot);
    await mkdir(join(prismaRoot, "migrations", "20260101000000_a"), {
      recursive: true,
    });
    await mkdir(join(prismaRoot, "migrations", "20260202000000_b"));
    await writeFile(join(prismaRoot, "schema.prisma"), "model Lane {}");

    // Act
    const provenance = await readDevFastLaneSourceProvenance(prismaRoot);

    // Assert
    expect(provenance).toEqual({
      migrationRevision: "20260202000000_b",
      schemaDigest: `sha256:${createHash("sha256").update("model Lane {}").digest("hex")}`,
    });
  });

  it("fails instead of guessing when the schema is missing", async () => {
    // Arrange
    const prismaRoot = await mkdtemp(join(tmpdir(), "global-dev-fast-lane-"));
    directories.push(prismaRoot);
    await mkdir(join(prismaRoot, "migrations", "20260101000000_a"), {
      recursive: true,
    });

    // Act + Assert
    await expect(readDevFastLaneSourceProvenance(prismaRoot)).rejects.toThrow();
  });

  it("locates packages/db/prisma from the compiled apps/api/dist/temporal directory", () => {
    // Arrange
    const apiRoot = resolve(import.meta.dirname, "..", "..");
    const compiledTemporal = join(apiRoot, "dist", "temporal");

    // Act
    const prismaRoot = resolve(
      compiledTemporal,
      DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL,
    );

    // Assert
    expect(DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL).toBe(
      "../../../../packages/db/prisma",
    );
    expect(prismaRoot).toBe(
      resolve(apiRoot, "..", "..", "packages", "db", "prisma"),
    );
    expect(existsSync(join(prismaRoot, "schema.prisma"))).toBe(true);
    expect(existsSync(join(prismaRoot, "migrations"))).toBe(true);
  });
});
