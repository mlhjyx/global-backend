import { Prisma, type PrismaClient } from "@prisma/client";
import {
  PlatformAuthorityTargetLookupRequestSchema,
  type PlatformAuthorityTargetLookupRequest,
} from "@global/contracts/platform-authority/target-lookup";
import { attestExecutionBudgetPlatformWriterTransaction } from "../execution-budget/execution-budget-authority.repository";

const UNAVAILABLE = "PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE";
function unavailable(): never {
  throw new Error(UNAVAILABLE);
}
function remaining(now: number, deadline: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(deadline)) return unavailable();
  const value = Math.floor(deadline - now);
  if (value < 1 || value > 2000) return unavailable();
  return value;
}
function foundResult(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) return unavailable();
  const row = Object.getOwnPropertyDescriptor(rows, "0")?.value;
  if (
    row === null ||
    typeof row !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(row)) ||
    Reflect.ownKeys(row).length !== 1
  )
    return unavailable();
  const found = Object.getOwnPropertyDescriptor(row, "found");
  if (!found || typeof found.value !== "boolean") return unavailable();
  return found.value;
}

export class PlatformTargetLookupRepository {
  constructor(
    private readonly writer?: Pick<PrismaClient, "$transaction"> | null,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  async lookup(
    request: PlatformAuthorityTargetLookupRequest,
    deadlineAtMs: number,
  ): Promise<boolean> {
    try {
      if (!this.writer) return unavailable();
      const input = PlatformAuthorityTargetLookupRequestSchema.parse(request);
      const budget = remaining(this.monotonicNow(), deadlineAtMs);
      // Acquisition and transaction share the caller's existing absolute deadline.
      // Reserving both within it prevents each layer from opening a new 2s window.
      const maxWait = Math.min(100, Math.floor(budget / 4));
      const timeout = budget - maxWait;
      if (maxWait < 1) return unavailable();
      const result = await this.writer.$transaction(
        async (transaction) => {
          remaining(this.monotonicNow(), deadlineAtMs);
          await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
          const statementBudget = Math.min(
            timeout,
            remaining(this.monotonicNow(), deadlineAtMs),
          );
          await transaction.$executeRaw(
            Prisma.sql`SELECT set_config('statement_timeout', ${String(statementBudget)}, true)`,
          );
          remaining(this.monotonicNow(), deadlineAtMs);
          await attestExecutionBudgetPlatformWriterTransaction(transaction);
          remaining(this.monotonicNow(), deadlineAtMs);
          const rows =
            await transaction.$queryRaw(Prisma.sql`SELECT public.lookup_platform_authority_target_v1(
          ${input.target_issuer}::text, ${input.target_jti}::uuid,
          ${input.schedule_id}::text, ${input.workflow_run_id}::text
        ) AS found`);
          remaining(this.monotonicNow(), deadlineAtMs);
          return foundResult(rows);
        },
        { maxWait, timeout },
      );
      // A callback value is not a committed transaction result; discard late ACKs.
      remaining(this.monotonicNow(), deadlineAtMs);
      return result;
    } catch {
      // Bound database/credential diagnostics at the dedicated writer boundary.
      throw new Error(UNAVAILABLE);
    }
  }
}
