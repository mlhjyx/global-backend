import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
      const rows = await tx.$queryRaw<Array<{ backend_pid: number }>>`
        SELECT pg_backend_pid()::integer AS backend_pid`;
      const receipt = await resolveOrganizationIdentityForRaw(tx, input);
      return Object.freeze({ backendPid: rows[0]?.backend_pid, receipt });
    });
  } finally {
    await client.$disconnect();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.TASK6B_RESOLVER_APP_DATABASE_URL;
  const [workspaceId, rawRecordId] = process.argv.slice(2);
  if (!databaseUrl || !workspaceId || !rawRecordId) {
    process.stdout.write(
      `${JSON.stringify({ errorCode: "INPUT_REQUIRED" })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  try {
    const result = await runDisposableOrganizationIdentityResolver(
      databaseUrl,
      {
        workspaceId,
        rawRecordId,
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const meta =
      error !== null &&
      typeof error === "object" &&
      "meta" in error &&
      error.meta !== null &&
      typeof error.meta === "object"
        ? error.meta
        : null;
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "IDENTITY_RESOLUTION_STATE_INVALID";
    const databaseCode =
      meta && "code" in meta && typeof meta.code === "string"
        ? meta.code
        : null;
    const metaMessage =
      meta && "message" in meta && typeof meta.message === "string"
        ? meta.message
        : "";
    const sqlState =
      /(?:Code|code):\s*['"`]?([0-9A-Z]{5})/u.exec(metaMessage)?.[1] ?? null;
    const databaseToken =
      /(IDENTITY_[A-Z0-9_]+)/u.exec(metaMessage)?.[1] ?? null;
    process.stdout.write(
      `${JSON.stringify({ errorCode: code, databaseCode, sqlState, databaseToken })}\n`,
    );
    process.exitCode = 2;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  void main();
}
