const PURPOSE = "site_builder_copy_sonnet_recovery" as const;

export const COPY_SONNET_RECOVERY_SOURCE_POLICY = Object.freeze({
  domain: "openox.tech",
  sourceType: "model_gateway_pricing",
  accessMode: "api",
  allowedPaths: Object.freeze(["/api/public/pricing-catalog"]),
  disallowedPaths: null,
  robotsStatus: "UNREVIEWED",
  termsStatus: "UNREVIEWED",
  personalData: false,
  allowedPurpose: Object.freeze([PURPOSE]),
  crawlDelayMs: 2_000,
  retentionDays: 1,
  reviewStatus: "APPROVED",
  owner: "site_builder",
  notes:
    "OpenOx public pricing catalog only; zero-model-call Copy Sonnet recovery preflight. Terms remain unreviewed; approval is limited to the authorized pricing read.",
});

type CopySonnetRecoverySourcePolicy =
  typeof COPY_SONNET_RECOVERY_SOURCE_POLICY;

interface SourcePolicyUpsertInput {
  where: { domain: typeof COPY_SONNET_RECOVERY_SOURCE_POLICY.domain };
  update: Record<string, never>;
  create: CopySonnetRecoverySourcePolicy;
}

export interface CopySonnetRecoverySourcePolicySeedDb {
  sourcePolicy: {
    upsert(input: SourcePolicyUpsertInput): Promise<Record<string, unknown>>;
  };
}

export interface CopySonnetRecoverySourcePolicySeedRole {
  currentUser: string;
  canSelect: boolean;
  canInsert: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactPolicy(row: Record<string, unknown>): void {
  for (const [field, expected] of Object.entries(
    COPY_SONNET_RECOVERY_SOURCE_POLICY,
  )) {
    if (!sameJson(row[field], expected)) {
      throw new Error(
        `COPY_SONNET_RECOVERY_SOURCE_POLICY_DRIFT:${field}`,
      );
    }
  }
}

export function validateCopySonnetRecoverySourcePolicySeedRole(
  role: CopySonnetRecoverySourcePolicySeedRole,
): void {
  if (
    !role.currentUser.trim() ||
    role.currentUser === "app_user" ||
    role.canSelect !== true ||
    role.canInsert !== true
  ) {
    throw new Error(
      "COPY_SONNET_RECOVERY_SOURCE_POLICY_SEED_ROLE_INVALID",
    );
  }
}

export async function ensureCopySonnetRecoverySourcePolicy(
  db: CopySonnetRecoverySourcePolicySeedDb,
): Promise<{ status: "CURRENT"; domain: "openox.tech" }> {
  const row = await db.sourcePolicy.upsert({
    where: { domain: COPY_SONNET_RECOVERY_SOURCE_POLICY.domain },
    update: {},
    create: COPY_SONNET_RECOVERY_SOURCE_POLICY,
  });
  assertExactPolicy(row);
  return Object.freeze({ status: "CURRENT", domain: "openox.tech" });
}
