import type {
  ManufacturerIdentitySubject,
  ReviewedManufacturerLegalName,
} from "../manufacturer-network-identity";
import type { ManufacturerIdentityEvidenceRef } from "@global/contracts";
import { paidOperationKey } from "../../common/paid-cost-ledger-contract";
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
import type { ExecutionBroker, ToolContext, ToolResult } from "../../tools/tool-contract";
import { parseDurableExecutionReceipt } from "../../durable-results/durable-execution-receipt";
import { ExecutionControlError } from "../../execution-budget/execution-control-error";
import { currentDiscoveryV3OperationScope } from "../discovery-v3-operation-scope";
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

type LookupRequest = { q: string; pages: number };
type LookupResult = ToolResult<{ results: Array<{ url: string }> }>;
type FetchRequest = { url: string; maxChars: number; exactHtml: true; profileTextRevision?: "manufacturer-profile/v1" };
type PageResult = ToolResult<{ url: string; text: string; contentHash: string }>;
type EvidenceArtifact = Pick<ManufacturerNetworkEvidence, "artifactId" | "operationId" | "resultDigest">;

export interface ManufacturerNetworkWire {
  search(input: LookupRequest, context: ToolContext): Promise<LookupResult>;
  fetch(input: FetchRequest, context: ToolContext): Promise<{ result: PageResult; artifact: EvidenceArtifact } | undefined>;
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
      discoveryV3Wire?: ManufacturerNetworkWire;
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
      !this.deps.loadConfiguration ||
      ctx.artifactSubject?.subjectType !== "company" ||
      !input.domain ||
      input.country !== "DE"
    )
      return miss();
    const native = this.deps.discoveryV3Wire;
    if (native) {
      const scope = currentDiscoveryV3OperationScope(ctx);
      if (!scope || scope.command.manufacturerNetworkRevision !== ctx.manufacturerNetworkRevision ||
        scope.step !== `manufacturer/${ctx.artifactSubject.subjectId}` || !ctx.authorizeExternalAction ||
        ctx.durableBudgetAuthority || ctx.admitManufacturerProbe) {
        throw new ExecutionControlError("DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH");
      }
    }
    const wire = native ?? this.legacyWire(ctx, ctx.artifactSubject.subjectId);
    if (!wire) return miss();
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
    const toolCtx: ToolContext = { ...ctx, purpose: "enrichment" };
    const lookupCtx = native ? { ...toolCtx, authorizeExternalAction: async () => {
      if (!await ctx.authorizeExternalAction!()) return false;
      const fresh = await this.deps.loadConfiguration!();
      const configuration = fresh?.status === 'ENABLED' ? readManufacturerNetworkSources(fresh.config) : undefined;
      const checkedAt = this.deps.now?.() ?? new Date();
      return Boolean(configuration && sources.every((original) => {
        const current = configuration.sources.find((source) => source.publisherId === original.publisherId);
        return current && current.domain === original.domain && current.reviewRef === original.reviewRef &&
          currentManufacturerReview(current, checkedAt) && manufacturerIndependence(configuration, current, subject, checkedAt);
      }));
    } } : toolCtx;
    const found = await wire.search({ q: query, pages: 1 }, lookupCtx);
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
    const fetchInput: FetchRequest = {
      url: candidate.url,
      maxChars: 60000,
      exactHtml: true as const,
      ...(ctx.manufacturerNetworkRevision ===
      MANUFACTURER_NETWORK_PROFILE_REVISION
        ? { profileTextRevision: "manufacturer-profile/v1" as const }
        : {}),
    };
    const fetched = await wire.fetch(fetchInput, {
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
    if (!fetched) return miss();
    const { result: page, artifact } = fetched;
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
      artifact,
      found,
    );
  }

  private legacyWire(ctx: ExecutionContext, companyId: string): ManufacturerNetworkWire | undefined {
    const { broker, readArtifactSubject } = this.deps;
    const admit = ctx.admitManufacturerProbe;
    if (!broker || !readArtifactSubject || !admit) return undefined;
    const authorize = async (phase: 'lookup' | 'fetch', toolId: string, toolVersion: string, requestKey: string) => {
      if (!await admit(phase, paidOperationKey([ctx.runId ?? ctx.workspaceId, 'tool-budget', toolId, toolVersion, requestKey]))) {
        throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH');
      }
    };
    return {
      search: async (input, context) => {
        const tool = searxngSearchTool;
        await authorize('lookup', tool.id, tool.version, tool.idempotencyKey(input));
        const result = await broker.invoke<LookupRequest, LookupResult['data']>('searxng.search', input, context);
        requireReceipt(result, 'searxng-search/v1', 'typed_projection', ctx);
        return result;
      },
      fetch: async (input, context) => {
        const tool = crawl4aiFetchTool;
        await authorize('fetch', tool.id, tool.version, tool.idempotencyKey(input));
        const result = await broker.invoke<FetchRequest, PageResult['data']>('crawl4ai.fetch', input, context);
        const { artifactId, operationId, resultDigest } = requireReceipt(result, 'crawl4ai-fetch/v1', 'artifact_reference', ctx);
        if (!artifactId || !await readArtifactSubject(ctx.workspaceId, companyId, artifactId)) {
          throw new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_SCOPE_MISMATCH');
        }
        return { result, artifact: { artifactId, operationId, resultDigest } };
      },
    };
  }

  /** Post-wire governance and deterministic projection, after receipt/Subject/URL validation. */
  private async finishEvidence(
    input: CompanyEnrichmentInput & { domain: string; country: "DE" },
    ctx: ExecutionContext,
    subject: Omit<ManufacturerIdentitySubject, "country">,
    candidate: { url: string; source: ManufacturerNetworkSource },
    page: PageResult,
    artifact: EvidenceArtifact,
    found: LookupResult,
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
      ...artifact,
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
