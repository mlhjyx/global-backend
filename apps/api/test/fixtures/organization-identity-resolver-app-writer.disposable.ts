import { PrismaClient } from "@prisma/client";
import { resolveOrganizationIdentityForRaw } from "../../src/discovery/organization-identity-resolver";

export async function runDisposableOrganizationIdentityResolver(
  databaseUrl: string,
  input: Readonly<{ workspaceId: string; rawRecordId: string }>,
) {
  const client = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${input.workspaceId}, true)`;
      return resolveOrganizationIdentityForRaw(tx, input);
    });
  } finally {
    await client.$disconnect();
  }
}
