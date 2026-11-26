import type { Prisma } from "@prisma/client";
import { assertManufacturerNetworkAuthority } from "../manufacturer-network-authority";
import { loadIcpBrief } from "../fit-judge";
import { commitManufacturerEvidence } from "../manufacturer-network-store";
import {
  isManufacturerNetworkRevision,
  type ManufacturerNetworkExecutionSnapshot,
} from "../manufacturer-network-execution";
import type { PrismaService } from "../../prisma/prisma.service";
import type { ExecutionBudgetBinding } from "../../execution-budget/execution-budget-binding";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../../execution-budget/execution-control-error";
import { applyDomainAckConsumerTransactions } from "../../durable-results/domain-ack-consumer-bindings";
import type { DurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import { ToolPolicyDenied } from "../../tools/tool-broker";
import { ViesTransientError } from "../../adapters/vies";
import type { DiscoveryProviderRegistry } from "../provider.registry";
import type {
  CompanyEnrichmentAdapter,
  EnrichmentResult,
} from "../provider-contract";
import { companyMayUseExternalProcessing } from "../company-suppression-gate";
import {
  commitCompanyEnrichmentResults,
  enrichmentHitSurvivesGovernance,
} from "../company-enrichment-commit";
import { currentEvidenceBundle } from "../evidence-bundle";
import {
  enrichmentIdentityConflicts,
  scopeIndependentEnrichment,
} from "../enrichment-identity";
import { MAX_DISCOVERY_ENRICH_COMPANIES } from "../execution-envelope";
import { appendRunEvent } from "./run-events";

const SOURCES = {
  gleif: ["gleif.fetch", "gleif-fetch/v1"],
  vies: ["vies.check", "vies-check/v1"],
  wikidata: ["wikidata.entity", "wikidata-entity/v1"],
} as const;
type Receipt = { producerId: string; receipt: DurableExecutionReceipt };

export interface CorroborationDependencies {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
}

export interface CorroborationCompany {
  name: string;
  domain: string | null;
  country: string | null;
  region: string | null;
  attributes: unknown;
}

export interface CorroborationCoreArgs {
  workspaceId: string;
  companyId: string;
  runId?: string;
  icpId?: string;
  correlationId?: string;
  manufacturerNetworkExecution?: ManufacturerNetworkExecutionSnapshot;
  scene?: string;
  skipProvider?: (key: string) => Promise<boolean>;
  onObserved?: (
    tx: Prisma.TransactionClient,
    provider: string,
    status: string,
  ) => Promise<void>;
}

export interface CorroborationOutcome {
  readonly provider: string;
  readonly status: string;
  readonly stored: boolean;
}

interface Input {
  manufacturerNetworkExecution?: ManufacturerNetworkExecutionSnapshot;
  workspaceId: string;
  runId: string;
  icpId: string;
  companyId: string;
  enrichmentSlot?: number;
}

function withinQuota(slot: number | undefined): boolean {
  return (
    slot !== undefined &&
    Number.isInteger(slot) &&
    slot >= 0 &&
    slot < MAX_DISCOVERY_ENRICH_COMPANIES
  );
}

async function permitted(
  deps: CorroborationDependencies,
  workspaceId: string,
  companyId: string,
): Promise<boolean> {
  return deps.prisma.withWorkspace(workspaceId, (tx) =>
    companyMayUseExternalProcessing(tx, workspaceId, companyId),
  );
}

function readWebsiteProfileIdentity(attributes: unknown): {
  vatId?: string;
  legalName?: string;
} {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return {};
  }
  const profile = (attributes as Record<string, unknown>).website_profile;
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return {};
  }
  const record = profile as Record<string, unknown>;
  return {
    ...(typeof record.vat_id === "string" && record.vat_id.trim()
      ? { vatId: record.vat_id.trim() }
      : {}),
    ...(typeof record.legal_name === "string" && record.legal_name.trim()
      ? { legalName: record.legal_name.trim() }
      : {}),
  };
}

function classifyProviderErrorStatus(key: string, error: unknown): string {
  if (key === "vies" && error instanceof ViesTransientError) {
    if (error.code === "VIES_RATE_LIMITED") return "rate_limited";
    if (error.code === "VIES_RATE_LIMITED_COOLDOWN") return "not_executed_rate_limited";
    return "provider_unavailable";
  }
  if (key === "wikidata" && error instanceof Error) {
    if (error.message === "WIKIDATA_RATE_LIMITED_COOLDOWN") return "not_executed_rate_limited";
    if (error.message === "WIKIDATA_RATE_LIMITED") return "rate_limited";
  }
  return "provider_failed";
}

function assertReceipts(
  workspaceId: string,
  binding: ExecutionBudgetBinding,
  key: string,
  receipts: Receipt[],
): void {
  const expected =
    key === "manufacturer_network"
      ? undefined
      : SOURCES[key as keyof typeof SOURCES];
  for (const { producerId, receipt } of receipts) {
    const contract =
      expected ??
      (producerId === "searxng.search"
        ? ["searxng.search", "searxng-search/v1"]
        : ["crawl4ai.fetch", "crawl4ai-fetch/v1"]);
    if (
      producerId !== contract[0] ||
      receipt.scopeKey !== workspaceId ||
      receipt.authorityId !== binding.authorityId ||
      receipt.resultStrategy !==
        (key === "manufacturer_network" && producerId === "crawl4ai.fetch"
          ? "artifact_reference"
          : "typed_projection") ||
      receipt.resultSchema !== contract[1] ||
      receipt.status !== "SETTLED"
    ) {
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    }
  }
}

async function commit(
  deps: CorroborationDependencies,
  args: CorroborationCoreArgs,
  outcome: {
    key: string;
    result?: EnrichmentResult;
    receipts: Receipt[];
    status: string;
    binding: ExecutionBudgetBinding;
  },
): Promise<CorroborationOutcome> {
  const { key, result, receipts, status } = outcome;
  const hits = status === "matched" && result ? [{ key, result }] : [];
  let stored = false;
  let finalStatus = status;
  await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
    if (receipts.length) {
      const consumed = await applyDomainAckConsumerTransactions({
        transaction: tx,
        acknowledgements: receipts.map(({ producerId, receipt }) => ({
          producerId,
          receipt,
          domainAckKey: `${args.companyId}:${receipt.operationId}:enrichment`,
          domainRevision: receipt.resultDigest,
        })),
        apply: (transaction) =>
          hits.length && key === "manufacturer_network"
            ? commitManufacturerEvidence(
                transaction,
                {
                  workspaceId: args.workspaceId,
                  companyId: args.companyId,
                  runId: args.runId!,
                },
                outcome.binding,
                result!.manufacturerEvidence!,
                receipts.find((r) => r.producerId === "searxng.search")!
                  .receipt,
              )
            : hits.length
              ? commitCompanyEnrichmentResults(transaction, {
                  workspaceId: args.workspaceId,
                  companyId: args.companyId,
                  hits,
                  signalTimestamp: new Date(),
                })
              : Promise.resolve(false),
        readback: async (transaction) => {
          const company = await transaction.canonicalCompany.findUnique({
            where: { id: args.companyId },
            select: { attributes: true },
          });
          const attributes = company?.attributes;
          return Boolean(
            hits.length &&
            attributes &&
            typeof attributes === "object" &&
            !Array.isArray(attributes) &&
            Object.hasOwn(attributes, key),
          );
        },
      });
      stored = consumed.value;
    }
    finalStatus = status === "matched" && !stored ? "write_skipped" : status;
    await args.onObserved?.(tx, key, finalStatus);
  });
  return { provider: key, status: finalStatus, stored };
}

async function probe(
  deps: CorroborationDependencies,
  args: CorroborationCoreArgs,
  binding: ExecutionBudgetBinding,
  company: CorroborationCompany,
  provider: CompanyEnrichmentAdapter,
): Promise<CorroborationOutcome> {
  const key = provider.key;
  const account =
    key === "manufacturer_network"
      ? await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          tx.toolBudgetAccount.findFirst({
            where: {
              scopeKey: args.workspaceId,
              accountKey: binding.accountKey,
              authorityId: binding.authorityId,
            },
            select: { id: true },
          }),
        )
      : undefined;
  if (key === "manufacturer_network" && !account) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
  }
  const receipts: Receipt[] = [];
  let result: EnrichmentResult;
  try {
    result = await provider.enrichCompany(
      {
        name: company.name,
        domain: company.domain ?? undefined,
        country: company.country ?? undefined,
        region: company.region ?? undefined,
        ...readWebsiteProfileIdentity(company.attributes),
      },
      {
        ...(key === "manufacturer_network"
          ? {
              manufacturerNetworkRevision:
                args.manufacturerNetworkExecution!.body.manufacturerNetworkRevision,
              durableBudgetAuthority: {
                authorityId: binding.authorityId,
                accountId: account!.id,
              },
              admitManufacturerProbe: (
                phase: "lookup" | "fetch",
                identitySha256: string,
              ) =>
                deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
                  const rows = await tx.$queryRaw<
                    Array<{ admitted: boolean }>
                  >`SELECT public.admit_manufacturer_network_probe_v1(${args.workspaceId}::uuid,${args.companyId}::uuid,${args.runId!}::uuid,${binding.authorityId}::uuid,${phase},${identitySha256}) AS admitted`;
                  return rows[0]?.admitted === true;
                }),
            }
          : {}),
        workspaceId: args.workspaceId,
        runId: binding.accountKey,
        correlationId: args.correlationId ?? binding.accountKey,
        artifactSubject: { subjectType: "company", subjectId: args.companyId },
        authorizeExternalAction: () =>
          permitted(deps, args.workspaceId, args.companyId),
        onDurableReceipt: (producerId, receipt) =>
          receipts.push({ producerId, receipt }),
      },
    );
  } catch (error) {
    if (
      error instanceof ToolPolicyDenied &&
      /^(?:source_policy(?: |$)|purpose not allowed for |domain \S+ is SUSPENDED$|source compliance )/u.test(
        error.reason,
      )
    ) {
      assertReceipts(args.workspaceId, binding, key, receipts);
      return commit(deps, args, {
        key,
        receipts,
        binding,
        status: "policy_blocked",
      });
    }
    if (isExecutionControlError(error)) throw error;
    assertReceipts(args.workspaceId, binding, key, receipts);
    return commit(deps, args, {
      key,
      receipts,
      binding,
      status: classifyProviderErrorStatus(key, error),
    });
  }
  assertReceipts(args.workspaceId, binding, key, receipts);
  if (result.matched && receipts.length === 0) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_MISSING");
  }
  if (key === "manufacturer_network" && result.matched) {
    const proof = result.manufacturerEvidence;
    const fetches = receipts.filter((r) => r.producerId === "crawl4ai.fetch");
    if (
      receipts.length !== 2 ||
      receipts.filter((r) => r.producerId === "searxng.search").length !== 1 ||
      fetches.length !== 1 ||
      !proof ||
      fetches[0]!.receipt.operationId !== proof.operationId ||
      fetches[0]!.receipt.artifactId !== proof.artifactId ||
      fetches[0]!.receipt.resultDigest !== proof.resultDigest
    ) {
      throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
    }
  }
  const conflict =
    result.matched &&
    enrichmentIdentityConflicts(company, key, result.attributes);
  const status = conflict
    ? "identity_unconfirmed"
    : result.matched &&
        (key === "manufacturer_network"
          ? result.manufacturerEvidence !== undefined
          : enrichmentHitSurvivesGovernance({ key, result }))
      ? "matched"
      : "miss";
  return commit(deps, args, { key, result, receipts, binding, status });
}

/**
 * Shared T1/T2 corroboration execution core used by Run2 discovery and future
 * audited lead rejudge flows.
 */
export async function corroborateCompanyWithProviders(
  deps: CorroborationDependencies,
  args: CorroborationCoreArgs,
  binding: ExecutionBudgetBinding,
  company: CorroborationCompany,
  providers: readonly CompanyEnrichmentAdapter[],
): Promise<CorroborationOutcome[]> {
  const present = new Set(
    currentEvidenceBundle({
      ...company,
      attributes: scopeIndependentEnrichment(company),
    }).entries.map((entry) => entry.source_key),
  );
  const outcomes: CorroborationOutcome[] = [];
  for (const provider of providers) {
    if (
      (!Object.hasOwn(SOURCES, provider.key) &&
        provider.key !== "manufacturer_network") ||
      present.has(provider.key)
    ) {
      continue;
    }
    if (
      provider.key === "manufacturer_network" &&
      (!isManufacturerNetworkRevision(
        args.manufacturerNetworkExecution?.body.manufacturerNetworkRevision,
      ) ||
        args.scene !== "distribution")
    ) {
      continue;
    }
    if (args.skipProvider && (await args.skipProvider(provider.key))) {
      continue;
    }
    if (!(await permitted(deps, args.workspaceId, args.companyId))) {
      return outcomes;
    }
    outcomes.push(await probe(deps, args, binding, company, provider));
  }
  return outcomes;
}

/** Existing, quoted T1/T2 enrichment runs before final fit, independently of website freshness. */
export async function corroborateCompanyBeforeFit(
  deps: CorroborationDependencies,
  args: Input,
  binding: ExecutionBudgetBinding,
): Promise<void> {
  assertManufacturerNetworkAuthority(
    args.manufacturerNetworkExecution,
    binding,
  );
  if (!withinQuota(args.enrichmentSlot)) return;
  const setup = await deps.prisma.withWorkspace(
    args.workspaceId,
    async (tx) => {
      const job = await tx.discoveryCompanyJob.findFirst({
        where: {
          workspaceId: args.workspaceId,
          runId: args.runId,
          canonicalCompanyId: args.companyId,
          verdictQuick: { in: ["match", "weak"] },
          stage: "profiling",
          run: {
            workspaceId: args.workspaceId,
            id: args.runId,
            icpId: args.icpId,
            ...(args.manufacturerNetworkExecution
              ? { planId: args.manufacturerNetworkExecution.planId }
              : {}),
          },
        },
        select: { canonicalCompanyId: true },
      });
      if (
        !job ||
        !(await companyMayUseExternalProcessing(
          tx,
          args.workspaceId,
          args.companyId,
        ))
      ) {
        return null;
      }
      const company = await tx.canonicalCompany.findUnique({
        where: { id: args.companyId },
        select: {
          name: true,
          domain: true,
          country: true,
          region: true,
          attributes: true,
        },
      });
      if (!company) return null;
      const providers = await deps.providers.routeEnrichment(tx as never);
      const scene = args.manufacturerNetworkExecution
        ? (await loadIcpBrief(tx, args.icpId, args.runId)).procurement_scenario
            ?.id
        : undefined;
      return { company, providers, scene };
    },
  );
  if (!setup) return;
  await corroborateCompanyWithProviders(
    deps,
    {
      workspaceId: args.workspaceId,
      runId: args.runId,
      icpId: args.icpId,
      companyId: args.companyId,
      manufacturerNetworkExecution: args.manufacturerNetworkExecution,
      scene: setup.scene,
      skipProvider: async (providerKey) => {
        const previous = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          tx.runEvent.findFirst({
            where: {
              workspaceId: args.workspaceId,
              runId: args.runId,
              type: "company_enrichment_observed",
              AND: [
                { payload: { path: ["companyId"], equals: args.companyId } },
                { payload: { path: ["provider"], equals: providerKey } },
              ],
            },
            orderBy: { seq: "desc" },
            select: { payload: true },
          }),
        );
        return Boolean(previous);
      },
      onObserved: async (tx, providerKey, status) => {
        await appendRunEvent(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          type: "company_enrichment_observed",
          payload: {
            companyId: args.companyId,
            provider: providerKey,
            stage: "profiling",
            status,
          },
        });
      },
    },
    binding,
    setup.company,
    setup.providers,
  );
}
