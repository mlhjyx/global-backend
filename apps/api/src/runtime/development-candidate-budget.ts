import {
  ExecutionBudgetGrantError,
  type VerifiedExecutionBudgetAuthority,
} from "../execution-budget/execution-budget-authority.types";
import {
  assertCandidateWorkspaceAllowed,
  readCandidateBudgetCache,
  runtimeCandidateContext,
  type RuntimeCandidateContext,
} from "./development-candidate";

interface Allocation {
  id: string;
  requestKey: string;
  arm: "A" | "B";
  workspaceId: string;
  purpose: string;
  quoteSha256: string;
  capMicrousd: number;
  state: string;
  accountKey: string | null;
  grantSha256: string | null;
}
interface Snapshot {
  schemaVersion: string;
  authorizationSha256: string;
  campaignId: string;
  expiresAt: string;
  capMicrousd: number;
  arms: Record<"A" | "B", { workspaceId: string; capMicrousd: number }>;
  allocations: Allocation[];
}
interface GrantIdentity {
  workspaceId: string | null;
  purpose: string;
  requestSha256: string | null;
  tokenSha256: string;
  capMicrousd: bigint | null;
}
const HASH = /^[0-9a-f]{64}$/u;
function invalid(): never {
  throw new ExecutionBudgetGrantError("EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH");
}
function cap(value: unknown, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= maximum
  );
}

/** The cache is an export of the host's atomic, private ledger, installed by
 * the trusted operator as root in a read-only directory mount. It contains no
 * tokens. Every allocation, including pending/UNKNOWN, counts at full cap.
 */
export function validateCandidateBudgetAllocation(
  input: unknown,
  context: RuntimeCandidateContext,
  target: { grant?: GrantIdentity; workspaceId?: string; accountKey?: string },
  now = Date.now(),
): void {
  try {
    const snapshot = input as Snapshot;
    if (
      snapshot.schemaVersion !==
        "development-candidate-budget-allocations/v1" ||
      snapshot.authorizationSha256 !== context.authorizationSha256 ||
      snapshot.campaignId !== context.instanceId ||
      !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
      Date.parse(snapshot.expiresAt) <= now ||
      Date.parse(snapshot.expiresAt) > Date.parse(context.validUntil) ||
      now >= Date.parse(context.validUntil) ||
      !cap(snapshot.capMicrousd, 5_000_000) ||
      !Array.isArray(snapshot.allocations) ||
      snapshot.allocations.length > 128 ||
      !cap(snapshot.arms.A.capMicrousd, 2_500_000) ||
      !cap(snapshot.arms.B.capMicrousd, 2_500_000) ||
      snapshot.arms.A.workspaceId !== context.workspaceIds[0] ||
      snapshot.arms.B.workspaceId !== context.workspaceIds[1] ||
      snapshot.arms.A.capMicrousd + snapshot.arms.B.capMicrousd >
        snapshot.capMicrousd
    )
      invalid();
    const seen = {
      id: new Set<string>(),
      request: new Set<string>(),
      account: new Set<string>(),
      grant: new Set<string>(),
    };
    const totals = { A: 0, B: 0 };
    for (const entry of snapshot.allocations) {
      if (
        !["A", "B"].includes(entry.arm) ||
        !HASH.test(entry.id) ||
        !HASH.test(entry.requestKey) ||
        !HASH.test(entry.quoteSha256) ||
        entry.workspaceId !== snapshot.arms[entry.arm].workspaceId ||
        !cap(entry.capMicrousd, snapshot.arms[entry.arm].capMicrousd) ||
        !["ALLOCATED", "ISSUING", "BOUND", "UNKNOWN"].includes(entry.state) ||
        seen.id.has(entry.id) ||
        seen.request.has(entry.requestKey)
      )
        invalid();
      seen.id.add(entry.id);
      seen.request.add(entry.requestKey);
      if (entry.accountKey !== null || entry.grantSha256 !== null) {
        if (
          typeof entry.accountKey !== "string" ||
          entry.accountKey.length > 200 ||
          !entry.accountKey.length ||
          [...entry.accountKey].some(
            (character) => character.charCodeAt(0) < 32,
          ) ||
          !entry.grantSha256 ||
          !HASH.test(entry.grantSha256) ||
          seen.account.has(entry.accountKey) ||
          seen.grant.has(entry.grantSha256)
        )
          invalid();
        seen.account.add(entry.accountKey);
        seen.grant.add(entry.grantSha256);
      } else if (entry.state === "BOUND") invalid();
      totals[entry.arm] += entry.capMicrousd;
    }
    if (
      totals.A > snapshot.arms.A.capMicrousd ||
      totals.B > snapshot.arms.B.capMicrousd ||
      totals.A + totals.B > snapshot.capMicrousd
    )
      invalid();
    const grant = target.grant;
    const entry = snapshot.allocations.find(
      (item) =>
        item.state === "BOUND" &&
        (grant
          ? item.grantSha256 === grant.tokenSha256
          : item.workspaceId === target.workspaceId &&
            item.accountKey === target.accountKey),
    );
    if (!entry) invalid();
    if (
      grant &&
      (grant.workspaceId !== entry.workspaceId ||
        grant.purpose !== entry.purpose ||
        grant.requestSha256 !== entry.requestKey ||
        grant.capMicrousd === null ||
        grant.capMicrousd <= 0n ||
        grant.capMicrousd > BigInt(entry.capMicrousd))
    )
      invalid();
  } catch {
    invalid();
  }
}
export async function assertCandidateGrantAllocated(
  authority: VerifiedExecutionBudgetAuthority,
): Promise<void> {
  assertCandidateWorkspaceAllowed(authority.workspaceId ?? "");
  const context = runtimeCandidateContext();
  if (!context) return;
  try {
    validateCandidateBudgetAllocation(
      await readCandidateBudgetCache(),
      context,
      { grant: authority },
    );
  } catch {
    invalid();
  }
}
export async function assertCandidateAccountAllocated(
  workspaceId: string,
  accountKey: string,
): Promise<void> {
  assertCandidateWorkspaceAllowed(workspaceId);
  const context = runtimeCandidateContext();
  if (!context) return;
  try {
    validateCandidateBudgetAllocation(
      await readCandidateBudgetCache(),
      context,
      { workspaceId, accountKey },
    );
  } catch {
    invalid();
  }
}
