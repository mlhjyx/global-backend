import { join } from "node:path";
import {
  computeSchemaDigest,
  latestMigrationRevision,
} from "./build-attestation";

/**
 * packages/db/prisma relative to the compiled apps/api/dist/temporal directory
 * of a source checkout (dist/temporal -> dist -> apps/api -> apps -> root).
 */
export const DEV_FAST_LANE_PRISMA_ROOT_FROM_DIST_TEMPORAL =
  "../../../../packages/db/prisma";

export type DevFastLaneSourceProvenance = Readonly<{
  migrationRevision: string;
  schemaDigest: string;
}>;

/**
 * The fast-lane worker has no build receipt, so it derives the two facts a
 * receipt would carry from its own source tree with the receipt's functions:
 * the newest migration (checked against the database) and the schema digest
 * (checked against the managed image's /health/build schema_digest).
 */
export async function readDevFastLaneSourceProvenance(
  prismaRoot: string,
): Promise<DevFastLaneSourceProvenance> {
  const [migrationRevision, schemaDigest] = await Promise.all([
    latestMigrationRevision(join(prismaRoot, "migrations")),
    computeSchemaDigest(join(prismaRoot, "schema.prisma")),
  ]);
  return Object.freeze({ migrationRevision, schemaDigest });
}
