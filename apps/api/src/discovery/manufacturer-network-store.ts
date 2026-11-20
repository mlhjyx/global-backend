import { loadCompanyForSuppressionSafeWrite } from "./company-suppression-gate";
import { Prisma } from "@prisma/client";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import {
  currentManufacturerEvidence,
  readManufacturerNetworkEvidence,
  type ManufacturerNetworkEvidence,
} from "./manufacturer-network-evidence";
import {
  readManufacturerNetworkSources,
  manufacturerIndependence,
  manufacturerSourceForUrl,
} from "./manufacturer-network-sources";

export async function commitManufacturerEvidence(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; companyId: string; runId: string },
  binding: ExecutionBudgetBinding,
  evidence: ManufacturerNetworkEvidence,
  search: DurableExecutionReceipt,
): Promise<boolean> {
  if (
    !readManufacturerNetworkEvidence(evidence) ||
    evidence.workspaceId !== args.workspaceId ||
    evidence.companyId !== args.companyId
  ) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
  }
  if (
    !(await loadCompanyForSuppressionSafeWrite(
      tx,
      args.workspaceId,
      args.companyId,
    ))
  )
    return false;
  const rows = await tx.$queryRaw<
    Array<{ stored: boolean }>
  >`SELECT public.commit_manufacturer_network_evidence_v1(
    ${args.workspaceId}::uuid, ${args.companyId}::uuid, ${args.runId}::uuid, ${binding.authorityId}::uuid,
    ${search.operationId}::uuid, ${JSON.stringify(evidence)}::jsonb) AS stored`;
  return rows[0]?.stored === true;
}
/** Only the receipt-backed immutable record is qualified. Raw/canonical JSON is never an authorization marker. */
export async function loadManufacturerEvidence(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; companyId: string; runId: string },
  company: {
    id: string;
    name: string;
    domain: string | null;
    country: string | null;
  },
  now = new Date(),
): Promise<ManufacturerNetworkEvidence | undefined> {
  const rows = await tx.$queryRaw<
    Array<{ evidence: unknown }>
  >`SELECT evidence FROM public.read_manufacturer_network_evidence_v1(
    ${args.workspaceId}::uuid, ${args.companyId}::uuid, ${args.runId}::uuid)`;
  const evidence = currentManufacturerEvidence(rows[0]?.evidence, company, now);
  if (!evidence || evidence.workspaceId !== args.workspaceId) return undefined;
  const row = await tx.dataProvider.findUnique({
    where: { key: "manufacturer_network" },
    select: { status: true, config: true },
  });
  const config =
    row?.status === "ENABLED"
      ? readManufacturerNetworkSources(row.config)
      : undefined;
  if (!config || !company.domain) return undefined;
  const policies = await tx.sourcePolicy.findMany({
    select: {
      id: true,
      domain: true,
      sourceType: true,
      reviewStatus: true,
      termsStatus: true,
      allowedPurpose: true,
      allowedPaths: true,
      disallowedPaths: true,
      retentionDays: true,
    },
  });
  const governed = manufacturerSourceForUrl(
    evidence.sourceUrl,
    config.sources,
    policies,
    now,
  );
  const independence = governed
    ? manufacturerIndependence(
        config,
        governed.source,
        { ...args, domain: company.domain },
        now,
      )
    : undefined;
  if (
    !governed ||
    !independence ||
    governed.source.publisherId !== evidence.publisherId ||
    governed.policy.id !== evidence.sourcePolicyId ||
    governed.source.reviewRef !== evidence.sourceReviewRef ||
    independence.reviewRef !== evidence.independenceReviewRef ||
    governed.source.licenseLabel !== evidence.licenseLabel
  )
    return undefined;
  return evidence;
}
