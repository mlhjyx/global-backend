import type { PrismaClient } from "@prisma/client";

type PlatformAuthorityFreshnessRow = Readonly<{
  purpose: string;
  state: string;
}>;

/** Refuse schedule polling unless every enabled platform purpose is issuable. */
export async function assertPlatformAuthorityReady(
  platformWriter: Pick<PrismaClient, "$queryRaw">,
): Promise<void> {
  const rows = await platformWriter.$queryRaw<PlatformAuthorityFreshnessRow[]>`
    SELECT purpose, state
    FROM inspect_platform_execution_authority_freshness_v1(clock_timestamp())
  `;
  const requiredPurposes = new Set([
    "platform.acquisition",
    "platform.intent_watch",
    "platform.sanctions",
  ]);
  const usable = new Set(
    rows
      .filter(
        (row) =>
          row.state === "ISSUABLE" ||
          row.state === "INTENTIONALLY_DISABLED_NO_EGRESS",
      )
      .map((row) => row.purpose),
  );
  for (const purpose of requiredPurposes) {
    if (!usable.has(purpose)) {
      throw new Error("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
    }
  }
}
