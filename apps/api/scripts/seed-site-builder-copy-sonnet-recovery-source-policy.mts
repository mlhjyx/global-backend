import { PrismaClient } from "@prisma/client";

import {
  ensureCopySonnetRecoverySourcePolicy,
  validateCopySonnetRecoverySourcePolicySeedRole,
  type CopySonnetRecoverySourcePolicySeedRole,
} from "../src/site-builder/eval/copy-sonnet-recovery-source-policy-seed";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`COPY_SONNET_RECOVERY_REQUIRED_ENV_MISSING:${name}`);
  }
  return value;
}

const db = new PrismaClient({
  datasourceUrl: requiredEnvironment("SOURCE_POLICY_OWNER_DATABASE_URL"),
});

await db.$connect();
try {
  const roles = await db.$queryRaw<CopySonnetRecoverySourcePolicySeedRole[]>`
    SELECT current_user AS "currentUser",
           has_table_privilege(current_user, 'public.source_policy', 'SELECT') AS "canSelect",
           has_table_privilege(current_user, 'public.source_policy', 'INSERT') AS "canInsert"`;
  if (roles.length !== 1) {
    throw new Error(
      "COPY_SONNET_RECOVERY_SOURCE_POLICY_SEED_ROLE_INVALID",
    );
  }
  validateCopySonnetRecoverySourcePolicySeedRole(roles[0]);

  const result = await ensureCopySonnetRecoverySourcePolicy({
    sourcePolicy: {
      upsert: async (input) => ({
        ...(await db.sourcePolicy.upsert(input)),
      }),
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await db.$disconnect();
}
