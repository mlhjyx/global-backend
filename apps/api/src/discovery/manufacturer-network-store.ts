import { loadReviewedManufacturerLegalNames } from "./manufacturer-network-identity";
import { loadCompanyForSuppressionSafeWrite } from "./company-suppression-gate";
import { Prisma } from "@prisma/client";
import type { ExecutionBudgetBinding } from "../execution-budget/execution-budget-binding";
import type { DurableExecutionReceipt } from "../durable-results/durable-execution-receipt";
import type { DiscoveryV3Dispatch } from "../runtime/discovery-v3-dispatch-contract";
import type { DiscoveryV3ResultLink } from "./discovery-v3-operation-scope";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import type { ManufacturerSourceConfiguration } from "./providers/manufacturer-network.provider";
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
  return currentGovernedManufacturerEvidence(tx, args, company, rows[0]?.evidence, now);
}

export async function loadManufacturerSourceConfiguration(tx: Prisma.TransactionClient): Promise<ManufacturerSourceConfiguration | undefined> {
  const row = await tx.dataProvider.findUnique({ where: { key: "manufacturer_network" }, select: { status: true, config: true } });
  if (!row || row.status !== "ENABLED") return undefined;
  const policies = await tx.sourcePolicy.findMany({ select: {
    id: true, domain: true, sourceType: true, reviewStatus: true, termsStatus: true,
    allowedPurpose: true, allowedPaths: true, disallowedPaths: true, retentionDays: true,
  } });
  return { ...row, policies };
}

type EvidenceSubject = { id: string; name: string; domain: string | null; country: string | null };

export async function currentGovernedManufacturerEvidence(
  tx: Prisma.TransactionClient,
  args: { workspaceId: string; companyId: string },
  company: EvidenceSubject,
  value: unknown,
  now: Date,
): Promise<ManufacturerNetworkEvidence | undefined> {
  const evidence = currentManufacturerEvidence(value, company, now);
  if (!evidence || evidence.workspaceId !== args.workspaceId) return undefined;
  const setup = await loadManufacturerSourceConfiguration(tx);
  const config = setup && readManufacturerNetworkSources(setup.config);
  if (!setup || !config || !company.domain) return undefined;
  const governed = manufacturerSourceForUrl(
    evidence.sourceUrl,
    config.sources,
    setup.policies,
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
  if (evidence.identityEvidenceRefs) {
    if (
      !independence.identityEvidenceRefs ||
      !evidence.identityEvidenceRefs.every((ref) =>
        independence.identityEvidenceRefs!.some(
          (r) =>
            r.fieldEvidenceId === ref.fieldEvidenceId &&
            r.valueSha256 === ref.valueSha256,
        ),
      )
    )
      return undefined;
    const aliases = await loadReviewedManufacturerLegalNames(
      tx,
      { ...args, domain: company.domain, country: company.country ?? "" },
      evidence.identityEvidenceRefs,
      now,
    );
    if (!aliases || aliases.length !== evidence.identityEvidenceRefs.length)
      return undefined;
  }
  return evidence;
}

/** A v3 ACK binds both original proof links and the same leased worker. */
export async function commitDiscoveryV3ManufacturerEvidence(
  tx: Prisma.TransactionClient,
  command: DiscoveryV3Dispatch,
  companyId: string,
  workerAttempt: number,
  consumerSha256: string,
  lookup: DiscoveryV3ResultLink,
  fetched: DiscoveryV3ResultLink,
  evidence: ManufacturerNetworkEvidence,
  now: Date,
): Promise<boolean> {
  const company = await loadCompanyForSuppressionSafeWrite(tx, command.workspaceId, companyId);
  if (!company || !await currentGovernedManufacturerEvidence(tx, { ...command, companyId }, company, evidence, now)) return false;
  const [row] = await tx.$queryRaw<Array<{ stored: boolean }>>`
    SELECT public.commit_discovery_v3_manufacturer_evidence_v1(
      ${command.workspaceId}::uuid, ${companyId}::uuid, ${command.runId}::uuid,
      ${command.requestSha256}::text, ${workerAttempt}::integer, ${lookup.operationId}::uuid, ${lookup.resultSha256}::text,
      ${fetched.operationId}::uuid, ${fetched.resultSha256}::text, ${consumerSha256}::text,
      ${JSON.stringify(evidence)}::jsonb) AS stored`;
  return row?.stored === true;
}

export async function loadDiscoveryV3ManufacturerEvidence(
  tx: Prisma.TransactionClient,
  command: DiscoveryV3Dispatch,
  company: EvidenceSubject,
  now: Date,
): Promise<ManufacturerNetworkEvidence | undefined> {
  const [row] = await tx.$queryRaw<Array<{ evidence: unknown }>>`
    SELECT evidence FROM public.read_discovery_v3_manufacturer_evidence_v1(
      ${command.workspaceId}::uuid, ${company.id}::uuid, ${command.runId}::uuid, ${command.requestSha256}::text)`;
  return currentGovernedManufacturerEvidence(tx, { ...command, companyId: company.id }, company, row?.evidence, now);
}
