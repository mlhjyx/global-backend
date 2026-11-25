import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { seedJurisdictionPolicy } from '../src/compliance/jurisdiction-policy.seed';
import { seedSanctions } from '../src/sanctions/sanctions-seed';
import { seedSkillCatalog } from '../src/skills/skill-catalog.seed';
import { seedPackCatalog } from '../src/skills/packs/pack-catalog.seed';
import { seedAgentCatalog } from '../src/agents/agent-catalog.seed';

const FORBIDDEN_SEED_ROLES = new Set([
  'app_user',
  'outbox_relay_worker',
  'memory_outbox_reader',
  'customer_worker_ops',
  'execution_budget_platform_writer_svc',
]);

function assertSeedDatabaseUrl(rawUrl: string | undefined): string {
  if (!rawUrl?.trim()) {
    throw new Error('SEED_PLATFORM_CATALOGS_DATABASE_URL_REQUIRED: DATABASE_URL must be set');
  }
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('SEED_PLATFORM_CATALOGS_DATABASE_URL_INVALID: must be postgres:// or postgresql://');
  }
  const username = decodeURIComponent(parsed.username);
  if (!username || FORBIDDEN_SEED_ROLES.has(username)) {
    throw new Error(
      `SEED_PLATFORM_CATALOGS_ROLE_FORBIDDEN: DATABASE_URL role "${username || '(empty)'}" cannot seed owner-owned catalogs (app_user/runtime roles refused)`,
    );
  }
  return rawUrl.trim();
}

async function main(): Promise<void> {
  const databaseUrl = assertSeedDatabaseUrl(process.env.DATABASE_URL);
  const ownerDb = new PrismaClient({ datasourceUrl: databaseUrl });

  try {
    await ownerDb.$connect();
    const roleCheck = await ownerDb.$queryRaw<
      Array<{ sessionUser: string; rolSuper: boolean; isNonSuperAppMember: boolean }>
    >`SELECT session_user::text AS "sessionUser",
             r.rolsuper AS "rolSuper",
             (NOT r.rolsuper AND pg_has_role(session_user, 'app_user', 'member')) AS "isNonSuperAppMember"
      FROM pg_roles r
      WHERE r.rolname = session_user`;
    if (
      !roleCheck[0] ||
      roleCheck[0].sessionUser === 'app_user' ||
      roleCheck[0].isNonSuperAppMember
    ) {
      throw new Error(
        `SEED_PLATFORM_CATALOGS_APP_USER_REFUSED: connected role ${roleCheck[0]?.sessionUser ?? 'unknown'} must not be app_user`,
      );
    }

    await new DiscoveryProviderRegistry().seed(ownerDb);
    const jurisdictionPolicyRows = await seedJurisdictionPolicy(ownerDb);
    await seedSanctions(ownerDb);
    const skillResult = await seedSkillCatalog(ownerDb);
    const packResult = await seedPackCatalog(ownerDb);
    const agentResult = await seedAgentCatalog(ownerDb);

    console.log(
      JSON.stringify({
        event: 'platform_catalogs_seeded',
        jurisdictionPolicyRows,
        skills: skillResult,
        packs: packResult,
        agents: agentResult,
      }),
    );
  } finally {
    await ownerDb.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
