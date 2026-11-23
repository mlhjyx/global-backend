import { parseExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import { parseCanonicalMicrousd } from "../tools/microusd";
import { isCanonicalArtifactUuid } from "../durable-results/artifact/artifact.types";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import type { LawfulBasis } from "../discovery/provider-contract";
import type { ContactEnrichmentSafetyService } from "../enrichment/safety/contact-enrichment-safety.service";
import { EnrichmentSafetyError } from "../enrichment/safety/enrichment-safety.contract";
export interface ContactEnrichmentSafetyActivityInput { workspaceId: string; companyId: string; runId: string; binding: ExecutionBudgetBinding; lawfulBasis: LawfulBasis; remainingMicrousd: bigint; }
export interface ContactEnrichmentSafetyActivityResult { skipped: boolean; reason?: string; tier?: "A" | "B"; attempted?: number; costMicrousd?: number; operationRef?: string; }
/** Ordinary in-activity helper only: no new Temporal workflow command, grant, budget store or changing workflow-run identity. */
export async function executeContactEnrichmentSafetyActivity(service: Pick<ContactEnrichmentSafetyService, "executeRun">, input: ContactEnrichmentSafetyActivityInput): Promise<ContactEnrichmentSafetyActivityResult> {
  if (![input.workspaceId, input.companyId, input.runId].every(isCanonicalArtifactUuid) || typeof input.remainingMicrousd !== "bigint") throw new EnrichmentSafetyError("INVALID_PLAN");
  // The grant subject is the derived request scope, not the business run UUID.
  const binding = parseExecutionBudgetBinding(input.binding, { scopeKey: input.workspaceId, purpose: "discovery.run", subjectType: "discovery_run" });
  const remainingMicrousd = parseCanonicalMicrousd("run remaining", input.remainingMicrousd.toString()).toString();
  const result = await service.executeRun({ workspaceId: input.workspaceId, companyId: input.companyId, businessRunId: input.runId, binding, lawfulBasis: input.lawfulBasis, remainingMicrousd, actorId: "discovery-run:" + input.runId });
  if (result.admission === "NOT_ADMITTED") {
    const reasons: Readonly<Record<string, string>> = { GOVERNANCE_PENDING: "governance_pending", NO_CONFIGURED_FINDER: "no_configured_finder", NO_ENABLED_FINDER: "no_enabled_finder", NO_LAWFUL_BASIS: "no_lawful_basis_configured", BUDGET_CAP: "skipped_budget", SUPPRESSED: "suppressed", NO_DOMAIN: "no_domain", NO_CONTACTS: "no_contacts" };
    return { skipped: true, reason: reasons[result.reasonCode ?? ""] ?? "source_control_pending" };
  }
  return { skipped: false, tier: result.tier, attempted: result.attempted, costMicrousd: result.costMicrousd, ...(result.operationRef === undefined ? {} : { operationRef: result.operationRef }), ...(result.skipped === undefined ? {} : { reason: result.skipped }) };
}
