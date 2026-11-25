import { Prisma, type PrismaClient } from '@prisma/client';

export const DEFAULT_EXPECTED_PROVIDER_KEYS = Object.freeze([
  'public_web',
  'google_patents',
  'manufacturer_network',
  'web_watch',
  'ted',
  'openfda',
] as const);

export class PlatformCatalogNotSeededError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformCatalogNotSeededError';
    this.code = code;
  }
}

export interface PlatformCatalogReadinessInput {
  readonly requireJurisdictionPolicy?: boolean;
  readonly expectedProviderKeys?: readonly string[];
  readonly expectedSanctionsKeys?: readonly string[];
  readonly expectedSkillVersions?: ReadonlyArray<{
    readonly skillKey: string;
    readonly version: string;
  }>;
  readonly expectedPackVersions?: ReadonlyArray<{
    readonly packKey: string;
    readonly version: string;
  }>;
  readonly expectedAgentKeys?: readonly string[];
}

export interface PlatformCatalogReadinessSummary {
  readonly jurisdictionPolicyCount: number | null;
  readonly providerCount: number | null;
  readonly sanctionsCount: number | null;
  readonly skillCount: number | null;
  readonly packCount: number | null;
  readonly agentCount: number | null;
}

type KeyRow = { readonly key: string };
type CountRow = { readonly count: bigint | number };
type SkillRow = { readonly skill_key: string; readonly version: string };
type PackRow = { readonly pack_key: string; readonly version: string };

/**
 * Read-only startup verification that deploy-time catalog seeding
 * (`pnpm --filter @global/api seed:platform-catalogs`) has populated the
 * platform tables required by API/workers/relay. Never writes to catalog tables.
 */
export async function verifyPlatformCatalogsReadOnly(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: PlatformCatalogReadinessInput,
): Promise<PlatformCatalogReadinessSummary> {
  let jurisdictionPolicyCount: number | null = null;
  let providerCount: number | null = null;
  let sanctionsCount: number | null = null;
  let skillCount: number | null = null;
  let packCount: number | null = null;
  let agentCount: number | null = null;

  if (input.requireJurisdictionPolicy) {
    const rows = await db.$queryRaw<CountRow[]>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM "jurisdiction_policy"
    `);
    jurisdictionPolicyCount = Number(rows[0]?.count ?? 0);
    if (jurisdictionPolicyCount <= 0) {
      throw new PlatformCatalogNotSeededError(
        'JURISDICTION_POLICY_NOT_SEEDED',
        'jurisdiction_policy is empty; run seed-platform-catalogs during deploy before starting runtime',
      );
    }
  }

  if (input.expectedProviderKeys && input.expectedProviderKeys.length > 0) {
    const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`
      SELECT "key" FROM "data_provider"
      WHERE "key" = ANY(${[...input.expectedProviderKeys]}::text[])
    `);
    const present = new Set(rows.map((r) => r.key));
    const missing = input.expectedProviderKeys.filter((k) => !present.has(k));
    providerCount = present.size;
    if (missing.length > 0) {
      throw new PlatformCatalogNotSeededError(
        'PROVIDER_CATALOG_NOT_SEEDED',
        `data_provider missing seeded keys [${missing.join(', ')}]; run seed-platform-catalogs before starting runtime`,
      );
    }
  }

  if (input.expectedSanctionsKeys && input.expectedSanctionsKeys.length > 0) {
    const rows = await db.$queryRaw<KeyRow[]>(Prisma.sql`
      SELECT "key" FROM "sanctions_source"
      WHERE "key" = ANY(${[...input.expectedSanctionsKeys]}::text[])
    `);
    const present = new Set(rows.map((r) => r.key));
    const missing = input.expectedSanctionsKeys.filter((k) => !present.has(k));
    sanctionsCount = present.size;
    if (missing.length > 0) {
      throw new PlatformCatalogNotSeededError(
        'SANCTIONS_CATALOG_NOT_SEEDED',
        `sanctions_source missing seeded keys [${missing.join(', ')}]; run seed-platform-catalogs before starting runtime`,
      );
    }
  }

  if (input.expectedSkillVersions && input.expectedSkillVersions.length > 0) {
    const rows = await db.$queryRaw<SkillRow[]>(Prisma.sql`
      SELECT sp."skill_key", sv."version"
      FROM "skill_package" sp
      JOIN "skill_version" sv ON sv."package_id" = sp."id"
      WHERE sp."workspace_id" IS NULL
    `);
    const present = new Set(rows.map((r) => `${r.skill_key}@${r.version}`));
    const missing = input.expectedSkillVersions
      .map((s) => `${s.skillKey}@${s.version}`)
      .filter((k) => !present.has(k));
    skillCount = rows.length;
    if (missing.length > 0) {
      throw new PlatformCatalogNotSeededError(
        'SKILL_CATALOG_NOT_SEEDED',
        `skill catalog missing seeded versions [${missing.join(', ')}]; run seed-platform-catalogs before starting runtime`,
      );
    }
  }

  if (input.expectedPackVersions && input.expectedPackVersions.length > 0) {
    const rows = await db.$queryRaw<PackRow[]>(Prisma.sql`
      SELECT pp."pack_key", pv."version"
      FROM "pack_package" pp
      JOIN "pack_version" pv ON pv."package_id" = pp."id"
      JOIN "pack_activation" pa ON pa."package_id" = pp."id" AND pa."version_id" = pv."id"
      WHERE pa."scope" = 'platform'
    `);
    const present = new Set(rows.map((r) => `${r.pack_key}@${r.version}`));
    const missing = input.expectedPackVersions
      .map((p) => `${p.packKey}@${p.version}`)
      .filter((k) => !present.has(k));
    packCount = rows.length;
    if (missing.length > 0) {
      throw new PlatformCatalogNotSeededError(
        'PACK_CATALOG_NOT_SEEDED',
        `pack catalog missing active platform versions [${missing.join(', ')}]; run seed-platform-catalogs before starting runtime`,
      );
    }
  }

  if (input.expectedAgentKeys && input.expectedAgentKeys.length > 0) {
    const rows = await db.$queryRaw<Array<{ agent_key: string }>>(Prisma.sql`
      SELECT "agent_key" FROM "agent_profile"
      WHERE "agent_key" = ANY(${[...input.expectedAgentKeys]}::text[])
    `);
    const present = new Set(rows.map((r) => r.agent_key));
    const missing = input.expectedAgentKeys.filter((k) => !present.has(k));
    agentCount = present.size;
    if (missing.length > 0) {
      throw new PlatformCatalogNotSeededError(
        'AGENT_CATALOG_NOT_SEEDED',
        `agent_profile missing seeded keys [${missing.join(', ')}]; run seed-platform-catalogs before starting runtime`,
      );
    }
  }

  return {
    jurisdictionPolicyCount,
    providerCount,
    sanctionsCount,
    skillCount,
    packCount,
    agentCount,
  };
}
