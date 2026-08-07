export interface PiiBackfillAuthorization {
  mode: "APPLY" | "VERIFY_ONLY";
  databaseUrl: string;
  authorizationId: string;
  expectedDatabaseName: string;
  expectedBuildSha: string;
  maxRows: number;
}

type BackfillEnvironment = Record<string, string | undefined>;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_DATABASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

export function resolvePiiBackfillAuthorization(
  args: readonly string[],
  env: BackfillEnvironment,
): PiiBackfillAuthorization {
  const apply = args.includes("--apply");
  const verifyOnly = args.includes("--verify-only");
  if (apply && verifyOnly) throw new Error("PII_BACKFILL_MODE_CONFLICT");
  if (!apply && !verifyOnly) throw new Error("PII_BACKFILL_MODE_REQUIRED");
  if (args.some((arg) => arg !== "--apply" && arg !== "--verify-only")) {
    throw new Error("PII_BACKFILL_ARGUMENT_INVALID");
  }

  const databaseUrl = env.PII_BACKFILL_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("PII_BACKFILL_DATABASE_URL_REQUIRED");
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
      throw new Error("invalid protocol");
    }
  } catch {
    throw new Error("PII_BACKFILL_DATABASE_URL_INVALID");
  }

  const authorizationId = env.PII_BACKFILL_AUTHORIZATION_ID?.trim() ?? "";
  if (!SAFE_ID.test(authorizationId)) {
    throw new Error("PII_BACKFILL_AUTHORIZATION_ID_INVALID");
  }
  const expectedDatabaseName = env.PII_BACKFILL_EXPECTED_DATABASE?.trim() ?? "";
  if (!SAFE_DATABASE_NAME.test(expectedDatabaseName)) {
    throw new Error("PII_BACKFILL_EXPECTED_DATABASE_INVALID");
  }
  const expectedBuildSha =
    env.PII_BACKFILL_EXPECTED_BUILD_SHA?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(expectedBuildSha)) {
    throw new Error("PII_BACKFILL_EXPECTED_BUILD_SHA_INVALID");
  }
  const maxRows = Number(env.PII_BACKFILL_MAX_ROWS);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1_000_000) {
    throw new Error("PII_BACKFILL_MAX_ROWS_INVALID");
  }

  return {
    mode: apply ? "APPLY" : "VERIFY_ONLY",
    databaseUrl,
    authorizationId,
    expectedDatabaseName,
    expectedBuildSha,
    maxRows,
  };
}

/**
 * Admission for the destructive fixture verifier. The verifier creates and
 * removes synthetic rows and runs the real apply path, so a normal backfill
 * authorization is insufficient: operators must also attest that the target
 * is an isolated disposable verification database.
 */
export function resolvePiiBackfillVerifierAuthorization(
  env: BackfillEnvironment,
): PiiBackfillAuthorization {
  if (env.PII_BACKFILL_ISOLATED_VERIFY !== "true") {
    throw new Error("PII_BACKFILL_ISOLATED_VERIFY_REQUIRED");
  }
  return resolvePiiBackfillAuthorization(["--apply"], env);
}
