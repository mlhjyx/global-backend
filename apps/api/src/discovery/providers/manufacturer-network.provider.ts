import type {
  ManufacturerIdentitySubject,
  ReviewedManufacturerLegalName,
} from "../manufacturer-network-identity";
import type { ManufacturerIdentityEvidenceRef } from "@global/contracts";
import { paidOperationKey } from "../../site-builder/site-build-cost-ledger";
import {
  searxngSearchTool,
  crawl4aiFetchTool,
} from "../../tools/builtin-tools";
import type {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from "../provider-contract";
import type { ExecutionBroker, ToolResult } from "../../tools/tool-contract";
import { parseDurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import { ExecutionControlError } from "../../execution-budget/execution-control-error";
import {
  isManufacturerNetworkRevision,
  MANUFACTURER_NETWORK_PROFILE_REVISION,
} from "../manufacturer-network-execution";
import {
  currentManufacturerReview,
  manufacturerNameKey,
  manufacturerIndependence,
  manufacturerSourceForUrl,
  readManufacturerNetworkSources,
  type ManufacturerNetworkSource,
  type ManufacturerSourcePolicy,
} from "../manufacturer-network-sources";
import {
  parseManufacturerDetail,
  type ManufacturerNetworkEvidence,
} from "../manufacturer-network-evidence";

export interface ManufacturerSourceConfiguration {
  status: string;
  config: unknown;
  policies: ManufacturerSourcePolicy[];
}
const miss = (): EnrichmentResult => ({
  matched: false,
  attributes: {},
  confidence: 0,
  costCents: 0,
});
/** Deterministic adapter. No AI-task allowlist, raw HTTP, fallback source or snippet facts. */
export class ManufacturerNetworkProvider implements CompanyEnrichmentAdapter {
  readonly key = "manufacturer_network";
  constructor(
    private readonly deps: {
      broker?: ExecutionBroker;
      readIdentityAliases?: (
        subject: ManufacturerIdentitySubject,
        references: readonly ManufacturerIdentityEvidenceRef[],
      ) => Promise<readonly ReviewedManufacturerLegalName[] | undefined>;
      readArtifactSubject?: (
        workspaceId: string,
        companyId: string,
        artifactId: string,
      ) => Promise<boolean>;
      loadConfiguration?: () => Promise<
        ManufacturerSourceConfiguration | undefined
      >;
      now?: () => Date;
    },
  ) {}
  async enrichCompany(
    input: CompanyEnrichmentInput,
    ctx: ExecutionContext,
  ): Promise<EnrichmentResult> {
    if (
      !isManufacturerNetworkRevision(ctx.manufacturerNetworkRevision) ||
      !this.deps.broker ||
      !this.deps.loadConfiguration ||
      !this.deps.readArtifactSubject ||
      !ctx.admitManufacturerProbe ||
      ctx.artifactSubject?.subjectType !== "company" ||
      !input.domain ||
      input.country !== "DE"
    )
      return miss();
    const now = this.deps.now?.() ?? new Date();
    const setup = await this.deps.loadConfiguration();
    const config =
      setup?.status === "ENABLED"
        ? readManufacturerNetworkSources(setup.config)
        : undefined;
    if (!config || !setup) return miss();
    const subject = {
      workspaceId: ctx.workspaceId,
      companyId: ctx.artifactSubject.subjectId,
      domain: input.domain,
    };
    const sources = config.sources.filter(
      (s) =>
        currentManufacturerReview(s, now) &&
        manufacturerIndependence(config, s, subject, now),
    );
    if (!sources.length) return miss();
    // One query for this company across the reviewed publishers; never retry/fan out.
    const query = `"${input.name.replace(/["\\]/gu, " ")}" "${input.domain}" (${sources.map((s) => `site:${s.domain}`).join(" OR ")}) distributor Germany`;
    const searchInput = { q: query, pages: 1 };
    if (
      !(await ctx.admitManufacturerProbe(
        "lookup",
        paidOperationKey([
          ctx.runId ?? ctx.workspaceId,
          "tool-budget",
          searxngSearchTool.id,
          searxngSearchTool.version,
          searxngSearchTool.idempotencyKey(searchInput),
        ]),
      ))
    )
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    const toolCtx = { ...ctx, purpose: "enrichment" };
    const found = await this.deps.broker.invoke<
      { q: string; pages: number },
      { results: Array<{ url: string }> }
    >("searxng.search", { q: query, pages: 1 }, toolCtx);
    requireReceipt(found, "searxng-search/v1", "typed_projection", ctx);
    const candidates = found.data.results.flatMap((r) => {
      const governed = manufacturerSourceForUrl(
        r.url,
        sources,
        setup.policies,
        now,
      );
      return governed ? [{ url: r.url, ...governed }] : [];
    });
    const candidate = candidates[0];
    if (!candidate) return miss();
    const fetchInput = {
      url: candidate.url,
      maxChars: 60000,
      exactHtml: true as const,
      ...(ctx.manufacturerNetworkRevision ===
      MANUFACTURER_NETWORK_PROFILE_REVISION
        ? { profileTextRevision: "manufacturer-profile/v1" as const }
        : {}),
    };
    if (
      !(await ctx.admitManufacturerProbe(
        "fetch",
        paidOperationKey([
          ctx.runId ?? ctx.workspaceId,
          "tool-budget",
          crawl4aiFetchTool.id,
          crawl4aiFetchTool.version,
          crawl4aiFetchTool.idempotencyKey(fetchInput),
        ]),
      ))
    )
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    const page = await this.deps.broker.invoke<
      {
        url: string;
        maxChars: number;
        exactHtml: true;
        profileTextRevision?: "manufacturer-profile/v1";
      },
      { url: string; text: string; contentHash: string }
    >("crawl4ai.fetch", fetchInput, {
      ...toolCtx,
      authorizeExternalAction: async () => {
        if (
          ctx.authorizeExternalAction &&
          !(await ctx.authorizeExternalAction())
        )
          return false;
        const current = await this.deps.loadConfiguration!();
        const reviewed =
          current?.status === "ENABLED"
            ? readManufacturerNetworkSources(current.config)
            : undefined;
        const allowed =
          current && reviewed
            ? manufacturerSourceForUrl(
                candidate.url,
                reviewed.sources,
                current.policies,
                this.deps.now?.() ?? new Date(),
              )
            : undefined;
        return Boolean(
          allowed &&
          reviewed &&
          manufacturerIndependence(
            reviewed,
            allowed.source,
            subject,
            this.deps.now?.() ?? new Date(),
          ),
        );
      },
    });
    const receipt = requireReceipt(
      page,
      "crawl4ai-fetch/v1",
      "artifact_reference",
      ctx,
    );
    if (
      !(await this.deps.readArtifactSubject(
        ctx.workspaceId,
        ctx.artifactSubject.subjectId,
        receipt.artifactId!,
      ))
    )
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    if (
      page.data.url !== candidate.url ||
      page.provenance?.sourceUrl !== candidate.url ||
      page.provenance.parserVersion !== "artifact/crawl4ai-fetch/v1" ||
      !/^[a-f0-9]{24}$/u.test(page.data.contentHash) ||
      page.provenance.contentHash !== page.data.contentHash
    )
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    return this.finishEvidence(
      input as CompanyEnrichmentInput & { domain: string; country: "DE" },
      ctx,
      subject,
      candidate,
      page,
      receipt,
      found,
    );
  }

  /** Post-wire governance and deterministic projection, after receipt/Subject/URL validation. */
  private async finishEvidence(
    input: CompanyEnrichmentInput & { domain: string; country: "DE" },
    ctx: ExecutionContext,
    subject: Omit<ManufacturerIdentitySubject, "country">,
    candidate: { url: string; source: ManufacturerNetworkSource },
    page: ToolResult<{ url: string; text: string; contentHash: string }>,
    receipt: ReturnType<typeof requireReceipt>,
    found: ToolResult<{ results: Array<{ url: string }> }>,
  ): Promise<EnrichmentResult> {
    const now = this.deps.now?.() ?? new Date();
    const fetchedAt = page.provenance!.fetchedAt;
    const artifactExpiresAt = page.provenance!.artifactExpiresAt;
    if (
      !artifactExpiresAt ||
      !Number.isFinite(Date.parse(artifactExpiresAt)) ||
      Date.parse(artifactExpiresAt) <= Date.parse(fetchedAt)
    )
      throw new ExecutionControlError(
        "DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH",
      );
    if (
      !Number.isFinite(Date.parse(fetchedAt)) ||
      Date.parse(fetchedAt) > now.getTime() ||
      now.getTime() - Date.parse(fetchedAt) > 86400000
    )
      return miss();
    // Re-read current governance after the wire; a concurrent revocation must not become evidence.
    const latest = await this.deps.loadConfiguration!();
    const latestConfig =
      latest?.status === "ENABLED"
        ? readManufacturerNetworkSources(latest.config)
        : undefined;
    const governed =
      latestConfig && latest
        ? manufacturerSourceForUrl(
            candidate.url,
            latestConfig.sources,
            latest.policies,
            now,
          )
        : undefined;
    const independence =
      latestConfig && governed
        ? manufacturerIndependence(latestConfig, governed.source, subject, now)
        : undefined;
    if (
      !governed ||
      !independence ||
      governed.source.publisherId !== candidate.source.publisherId
    )
      return miss();
    let aliases: readonly ReviewedManufacturerLegalName[] = [];
    if (independence.identityEvidenceRefs) {
      if (!this.deps.readIdentityAliases) return miss();
      const read = await this.deps.readIdentityAliases(
        { ...subject, country: input.country },
        independence.identityEvidenceRefs,
      );
      if (!read || read.length !== independence.identityEvidenceRefs.length)
        return miss();
      aliases = read;
    }
    const detail = parseManufacturerDetail({
      ...(ctx.manufacturerNetworkRevision ===
      MANUFACTURER_NETWORK_PROFILE_REVISION
        ? { profileTextRevision: "manufacturer-profile/v1" as const }
        : {}),
      text: page.data.text,
      legalNames: aliases.map((alias) => alias.value),
      source: governed.source,
      company: {
        name: input.name,
        domain: input.domain,
        country: input.country,
      },
    });
    if (!detail) return miss();
    const usedAlias =
      manufacturerNameKey(detail.matchedName) !==
      manufacturerNameKey(input.name)
        ? aliases.find(
            (alias) =>
              manufacturerNameKey(alias.value) ===
              manufacturerNameKey(detail.matchedName),
          )
        : undefined;
    if (
      manufacturerNameKey(detail.matchedName) !==
        manufacturerNameKey(input.name) &&
      !usedAlias
    )
      return miss();
    const expiresAt = new Date(
      Math.min(
        Date.parse(artifactExpiresAt),
        ...(usedAlias ? [Date.parse(usedAlias.fetchedAt) + 30 * 86400000] : []),
        Date.parse(governed.source.expiresAt),
        Date.parse(independence.expiresAt),
        Date.parse(fetchedAt) + governed.policy.retentionDays * 86400000,
      ),
    ).toISOString();
    const evidence: ManufacturerNetworkEvidence = {
      schemaVersion: "manufacturer-network-evidence/v1",
      ...(usedAlias
        ? { identityEvidenceRefs: [{ ...usedAlias.reference }] }
        : {}),
      workspaceId: ctx.workspaceId,
      companyId: subject.companyId,
      publisherId: governed.source.publisherId,
      targetDomain: input.domain.replace(/^www\./u, ""),
      targetName: input.name,
      country: "DE",
      sourceUrl: candidate.url,
      fetchedAt,
      expiresAt,
      relationship: "authorized_distributor",
      spans: detail.spans,
      artifactId: receipt.artifactId!,
      operationId: receipt.operationId,
      resultDigest: receipt.resultDigest,
      contentHash: page.data.contentHash,
      sourcePolicyId: governed.policy.id,
      licenseLabel: governed.source.licenseLabel,
      allowedActions: ["display", "match"],
      sourceReviewRef: governed.source.reviewRef,
      independenceReviewRef: independence.reviewRef,
    };
    return {
      matched: true,
      confidence: 1,
      costCents: found.costCents + page.costCents,
      attributes: { evidence },
      manufacturerEvidence: evidence,
      provenance: {
        sourceUrl: candidate.url,
        fetchedAt,
        contentHash: page.data.contentHash,
        parserVersion: "manufacturer-network-evidence/v1",
      },
    };
  }
}
function requireReceipt<T>(
  result: ToolResult<T>,
  schema: string,
  strategy: string,
  ctx: ExecutionContext,
) {
  if (!result.durableReceipt)
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_MISSING");
  const receipt = parseDurableExecutionReceipt(result.durableReceipt);
  if (
    receipt.scopeKey !== ctx.workspaceId ||
    receipt.resultSchema !== schema ||
    receipt.resultStrategy !== strategy ||
    !ctx.durableBudgetAuthority ||
    receipt.authorityId !== ctx.durableBudgetAuthority.authorityId ||
    receipt.accountId !== ctx.durableBudgetAuthority.accountId
  ) {
    throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
  }
  return receipt;
}
