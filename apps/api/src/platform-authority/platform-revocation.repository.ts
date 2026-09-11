import { Prisma, type PrismaClient } from "@prisma/client";
import { PlatformAuthorityRevocationClaimsSchema } from "@global/contracts/execution-budget";
import { attestExecutionBudgetPlatformWriterTransaction } from "../execution-budget/execution-budget-authority.repository";
import type { AuthenticatedPlatformRevocation } from "./platform-revocation-verifier";

const UNAVAILABLE = "PLATFORM_REVOCATION_PERSISTENCE_UNAVAILABLE";
const MAX_BIGINT = 9223372036854775807n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface PlatformRevocationReceipt {
  readonly receiptId: string;
  readonly generation: string;
  readonly committedAt: Date;
  readonly inFlightAttempts: string;
  readonly replay: boolean;
}
function unavailable(): never { throw new Error(UNAVAILABLE); }
function receipt(rows: unknown): PlatformRevocationReceipt {
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0] === null || typeof rows[0] !== "object") return unavailable();
  const row = rows[0];
  if (typeof row.receipt_id !== "string" || !UUID.test(row.receipt_id) ||
      typeof row.generation !== "bigint" || row.generation < 1n || row.generation > MAX_BIGINT ||
      typeof row.in_flight_attempts !== "bigint" || row.in_flight_attempts < 0n || row.in_flight_attempts > MAX_BIGINT ||
      typeof row.replay !== "boolean" || !(row.committed_at instanceof Date) || !Number.isFinite(row.committed_at.getTime())) return unavailable();
  return Object.freeze({ receiptId: row.receipt_id, generation: row.generation.toString(),
    committedAt: new Date(row.committed_at.getTime()), inFlightAttempts: row.in_flight_attempts.toString(), replay: row.replay });
}

/** Called only with authenticated commands. SQL atomically resolves replay and performs the fence. */
export class PlatformRevocationRepository {
  constructor(private readonly writer?: Pick<PrismaClient, "$transaction"> | null) {}
  async apply(command: AuthenticatedPlatformRevocation): Promise<PlatformRevocationReceipt> {
    try {
      if (!this.writer || !command || !/^[0-9a-f]{64}$/.test(command.tokenSha256) || typeof command.expired !== "boolean") return unavailable();
      const claim = PlatformAuthorityRevocationClaimsSchema.parse(command.claims);
      // execute() returning is not a commit receipt. Await the OUTER transaction before returning facts.
      return await this.writer.$transaction(async transaction => {
        await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = 5000");
        await attestExecutionBudgetPlatformWriterTransaction(transaction);
        const rows = await transaction.$queryRaw(Prisma.sql`
          SELECT * FROM apply_platform_revocation_fence_v1(
            ${claim.iss}::text, ${claim.revocation_jti}::uuid, ${command.tokenSha256}::text,
            ${claim.target_issuer}::text, ${claim.target_jti}::uuid, ${claim.schedule_id}::text,
            ${claim.workflow_run_id}::text, ${BigInt(claim.fence_sequence)}::bigint,
            ${claim.reason_code}::text, ${new Date(claim.exp * 1000)}::timestamptz
          )
        `);
        const result = receipt(rows);
        if (command.expired && !result.replay) throw new Error("PLATFORM_REVOCATION_EXPIRED");
        return result;
      }, { maxWait: 1000, timeout: 5500 });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 4096) : "";
      const code = ["PLATFORM_REVOCATION_INVALID", "PLATFORM_REVOCATION_EXPIRED", "PLATFORM_REVOCATION_REUSED", "PLATFORM_REVOCATION_SCOPE_MISMATCH", "PLATFORM_REVOCATION_SEQUENCE_CONFLICT"]
        .find(candidate => message.includes(candidate)) ?? UNAVAILABLE;
      // eslint-disable-next-line preserve-caught-error -- SQL/credential diagnostics must not escape the credential boundary
      throw new Error(code);
    }
  }
}
