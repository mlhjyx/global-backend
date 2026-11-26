import { createHash } from 'node:crypto';
import { isCanonicalArtifactUuid } from '../../durable-results/artifact/artifact.types';
import { parseContactEnrichmentQualityResult, type ContactEnrichmentQualityResultV1 } from './contact-enrichment-results.dto';
import type { WorkspaceEnrichmentTransactions } from './enrichment-execution.repository';
import { EnrichmentSafetyError, safetyDigest, type EnrichmentContactResultReason } from './enrichment-safety.contract';

interface CompanyScope {
  readonly workspaceId: string;
  readonly companyId: string;
}

type StreamingEnrichmentStatus = 'APPLY_PENDING' | 'COMPLETED' | 'RATE_LIMITED';

/** Commit the claim before entering the existing bypass waterfall. A replay never owns it. */
export async function runBypassStreamingContactEnrichment(
  database: WorkspaceEnrichmentTransactions,
  input: CompanyScope & { readonly runId: string },
  execute: () => Promise<{ rateLimited?: boolean }>,
): Promise<void> {
  const { workspaceId, runId, companyId } = input;
  if (![workspaceId, runId, companyId].every(isCanonicalArtifactUuid)) throw new EnrichmentSafetyError('INVALID_PLAN');
  const operationRef = createHash('sha256')
    .update(`streaming-contact-enrichment:v1:${workspaceId}:${runId}:${companyId}`)
    .digest('hex');
  const [claim] = await database.withWorkspace(workspaceId, (tx) => tx.$queryRaw<{ id: string }[]>`
    UPDATE public.discovery_company_job j
    SET contact_enrichment_operation_ref = ${operationRef},
        contact_enrichment_started_at = date_trunc('milliseconds', clock_timestamp()),
        contact_enrichment_status = 'APPLY_PENDING'
    WHERE j.workspace_id = ${workspaceId}::uuid AND j.run_id = ${runId}::uuid
      AND j.canonical_company_id = ${companyId}::uuid AND j.verdict_deep = 'match'
      AND j.contact_enrichment_operation_ref IS NULL
      AND EXISTS (
        SELECT 1 FROM public.discovery_run r
        WHERE r.workspace_id = j.workspace_id AND r.id = j.run_id AND r.status = 'RUNNING'
      )
      AND EXISTS (
        SELECT 1 FROM public.canonical_company c
        WHERE c.workspace_id = j.workspace_id AND c.id = j.canonical_company_id AND c.status <> 'SUPPRESSED'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.contact_enrichment_execution e
        WHERE e.workspace_id = j.workspace_id AND e.company_id = j.canonical_company_id
          AND e.business_run_id = j.run_id AND e.entrypoint = 'discovery_run'
      )
    RETURNING j.id::text`);
  if (!claim) return;

  // A thrown error can occur after a request reached the provider. Keep the
  // pending claim for durable readback and block a second execution.
  const result = await execute();
  const status: StreamingEnrichmentStatus = result.rateLimited === true ? 'RATE_LIMITED' : 'COMPLETED';
  await database.withWorkspace(workspaceId, (tx) => tx.$executeRaw`
    UPDATE public.discovery_company_job
    SET contact_enrichment_status = ${status}
    WHERE workspace_id = ${workspaceId}::uuid AND run_id = ${runId}::uuid
      AND canonical_company_id = ${companyId}::uuid AND id = ${claim.id}::uuid
      AND contact_enrichment_operation_ref = ${operationRef} AND contact_enrichment_status = 'APPLY_PENDING'`);
}

interface StreamingResultRow {
  readonly operation_ref: string;
  readonly run_id: string;
  readonly started_at: Date;
  readonly result_status: StreamingEnrichmentStatus;
  readonly company_suppressed: boolean;
  readonly contact_id: string | null;
  readonly attempt_refs: string[] | null;
  readonly attempt_outcomes: string[] | null;
}

function contactReason(status: StreamingEnrichmentStatus, outcomes: readonly string[]): EnrichmentContactResultReason {
  if (status !== 'COMPLETED' || outcomes.includes('error')) return 'RESULT_UNKNOWN';
  // The finder attempt records a hit, without a link proving the committed point.
  if (outcomes.includes('hit')) return 'UNAVAILABLE';
  if (outcomes.includes('skipped_budget')) return 'BUDGET_CAP';
  if (outcomes.includes('miss')) return 'NO_MATCH';
  return 'GOVERNANCE_PENDING';
}

/** Build the existing V1 response from the claim and surviving attempt evidence. */
export async function readStreamingContactEnrichmentResult(
  database: WorkspaceEnrichmentTransactions,
  { workspaceId, companyId }: CompanyScope,
  identity: { readonly id: string } | { readonly operationRef: string },
): Promise<ContactEnrichmentQualityResultV1 | null> {
  const id = 'id' in identity ? identity.id : null;
  const operationRef = 'operationRef' in identity ? safetyDigest(identity.operationRef) : null;
  if (![workspaceId, companyId].every(isCanonicalArtifactUuid) || (id !== null && !isCanonicalArtifactUuid(id))) {
    throw new EnrichmentSafetyError('INVALID_PLAN');
  }
  const rows = await database.withWorkspace(workspaceId, (tx) => tx.$queryRaw<StreamingResultRow[]>`
    WITH head AS (
      SELECT j.workspace_id, j.canonical_company_id AS company_id, j.run_id,
        j.contact_enrichment_operation_ref AS operation_ref, j.contact_enrichment_started_at AS started_at,
        j.contact_enrichment_status AS result_status, c.status = 'SUPPRESSED' AS company_suppressed
      FROM public.discovery_company_job j
      JOIN public.canonical_company c ON c.workspace_id = j.workspace_id AND c.id = j.canonical_company_id
      WHERE j.workspace_id = ${workspaceId}::uuid AND j.canonical_company_id = ${companyId}::uuid
        AND j.contact_enrichment_operation_ref IS NOT NULL
        AND (j.id = ${id}::uuid OR j.contact_enrichment_operation_ref = ${operationRef}::varchar)
    )
    SELECT head.operation_ref, head.run_id::text, head.started_at, head.result_status, head.company_suppressed,
      evidence.contact_id, evidence.attempt_refs, evidence.attempt_outcomes
    FROM head
    LEFT JOIN LATERAL (
      SELECT c.id::text AS contact_id,
        (array_agg(a.id::text ORDER BY a.attempted_at DESC, a.id DESC))[1:3] AS attempt_refs,
        (array_agg(a.outcome ORDER BY a.attempted_at DESC, a.id DESC))[1:3] AS attempt_outcomes
      FROM public.canonical_contact c
      JOIN public.contact_enrichment_attempt a ON a.workspace_id = c.workspace_id AND a.contact_id = c.id
      WHERE NOT head.company_suppressed AND c.workspace_id = head.workspace_id AND c.company_id = head.company_id
        AND a.run_id = head.run_id::text AND a.created_at >= head.started_at AT TIME ZONE 'UTC'
        AND NOT EXISTS (
          SELECT 1 FROM public.deletion_request d
          WHERE d.workspace_id = c.workspace_id AND d.subject_type = 'contact' AND d.subject_id = c.id
            AND d.status <> 'RECEIVED'
        )
      GROUP BY c.id
      ORDER BY min(a.attempted_at), c.id
      LIMIT 10
    ) evidence ON TRUE`);
  const [head] = rows;
  if (!head) return null;

  const perContact: ContactEnrichmentQualityResultV1['perContact'][number][] = [];
  const skipped = new Map<string, number>();
  let eligible = 0;
  for (const row of rows) {
    if (!row.contact_id || !row.attempt_refs || !row.attempt_outcomes) continue;
    const reasonCode = contactReason(head.result_status, row.attempt_outcomes);
    if (row.attempt_outcomes.some((outcome) => outcome !== 'skipped_compliance')) eligible += 1;
    if (reasonCode === 'BUDGET_CAP' || reasonCode === 'GOVERNANCE_PENDING') {
      skipped.set(reasonCode, (skipped.get(reasonCode) ?? 0) + 1);
    }
    perContact.push({
      contactId: row.contact_id, reasonCode, attemptRefs: row.attempt_refs,
      beforeStates: [], afterStates: [], pointRefs: [], eventRefs: [], newCandidate: null, newValidPersonal: null,
    });
  }
  return parseContactEnrichmentQualityResult({
    version: 1,
    protocolVersion: 1,
    operationRef: head.operation_ref,
    companyId,
    entrypoint: 'discovery_run',
    businessRunId: head.run_id,
    createdAt: head.started_at.toISOString(),
    status: head.company_suppressed ? 'REDACTED' : head.result_status === 'COMPLETED' ? 'COMPLETED' : 'APPLY_PENDING',
    resultRevision: head.result_status === 'APPLY_PENDING' ? 1 : 2,
    qualityCoverage: 'PREREQUISITE_ONLY',
    summary: {
      consideredUniqueContacts: perContact.length,
      eligibleUniqueContacts: eligible,
      stockValidPersonalContacts: null,
      physicallyAttemptedUniqueContacts: null,
      newCandidatePoints: 0,
      newValidPersonalContacts: null,
      unresolvedUniqueContacts: null,
      skippedByReason: [...skipped].map(([reasonCode, count]) => ({ reasonCode, count })),
    },
    perContact,
    spend: { quotedUpperBoundMicrousd: '0', knownChargedMicrousd: null, unknownUpperBoundMicrousd: null, costBasis: 'estimated_upper_bound' },
    unavailableMetrics: ['stockValidPersonalContacts', 'physicallyAttemptedUniqueContacts', 'newValidPersonalContacts', 'unresolvedUniqueContacts'],
  });
}
