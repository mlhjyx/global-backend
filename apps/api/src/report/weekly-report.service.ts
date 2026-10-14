import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import { exportRightsContextForLead } from '../compliance/data-rights.context';
import { DataRightsService, type PolicyDecisionEntry } from '../compliance/data-rights.service';
import { isSyntheticDiscoveryProvenance } from '../discovery/evidence-license';
import { canonicalizeSuppressionValue, canonicalizeSuppressionValues } from '../discovery/suppression-value';
import { computeValidUntil } from '../lead/lead-qualified-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import {
  matchesFromJson,
  reconcileReviewState,
  SanctionsScreeningService,
  type ScreenResult,
} from '../sanctions/sanctions-screening.service';
import { encodeCsv, type CsvValue } from './csv';
import { isoWeekOf, parseIsoWeek } from './iso-week';
import {
  WEEKLY_REPORT_COLUMNS,
  weeklyReportRow,
  type WeeklyReportRowInput,
  type WeeklyReportSanctionsStatus,
} from './weekly-report-row';

/** A week's accepted leads are reviewed by hand; more than this is refused, never truncated. */
export const WEEKLY_REPORT_MAX_LEADS = 1_000;

/** Lead states that still mean "delivered": accepted, and possibly followed up since. */
const DELIVERED_LEAD_STATUSES = ['QUALIFIED', 'CONTACTED', 'CONVERTED'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRANSACTION = { maxWait: 5_000, timeout: 30_000 } as const;

export interface WeeklyReportRequest {
  icpId?: unknown;
  week?: unknown;
}

export interface WeeklyReport {
  /** Correlation id of this export's policy_decision_log rows. */
  readonly reportId: string;
  readonly week: string;
  readonly icpId: string;
  /** UTF-8 CSV with BOM. */
  readonly csv: string;
  readonly rows: number;
  readonly withheld: {
    /** DataRights EXPORT denied (suppressed, or no evidence); each one is in policy_decision_log. */
    readonly rights: number;
    /** Unresolved sanctions hit (persisted or live): never delivered. */
    readonly sanctions: number;
    /** Historical synthetic provenance: never product data. */
    readonly quarantined: number;
  };
}

type Tx = Prisma.TransactionClient;
interface ReportLead {
  id: string;
  canonicalCompanyId: string;
  fitVerdict: string | null;
  totalScore: number | null;
  scores: Prisma.JsonValue;
}
interface ReportCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  status: string;
  attributes: Prisma.JsonValue;
}
interface PriorScreening {
  status: string;
  reviewState: string;
  matches: Prisma.JsonValue;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({ error: { code: 'VALIDATION_ERROR', message } });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const list = groups.get(key(item));
    if (list) list.push(item);
    else groups.set(key(item), [item]);
  }
  return groups;
}

/**
 * Same rule as the accept-time fifth gate (LeadService.decide): a persisted hit blocks unless a
 * person cleared it as a false positive, and a live hit blocks unless every match was already
 * cleared. Not screened when the gate is off and nothing was ever recorded.
 */
function sanctionsDelivery(
  prior: PriorScreening | undefined,
  live: ScreenResult,
): { blocking: true } | { blocking: false; status: WeeklyReportSanctionsStatus } {
  const priorBlocking = !!prior && prior.status === 'potential_match' && prior.reviewState !== 'cleared_false_positive';
  const liveBlocking =
    live.status === 'potential_match' &&
    reconcileReviewState(
      prior ? { reviewState: prior.reviewState, matches: matchesFromJson(prior.matches) } : null,
      live.matches,
    ) !== 'cleared_false_positive';
  if (priorBlocking || liveBlocking) return { blocking: true };
  if (prior?.reviewState === 'cleared_false_positive' && prior.status === 'potential_match') {
    return { blocking: false, status: 'cleared_false_positive' };
  }
  return { blocking: false, status: prior || live.status !== 'not_screened' ? 'clear' : 'not_screened' };
}

/**
 * BI-22 weekly report (design §5, L4-lite): one CSV row per lead of the ICP accepted in the ISO
 * week. Every row passes DataRights EXPORT first and every decision is written to
 * policy_decision_log in the same transaction; a denied row is not exported. Only company-level
 * facts and company contact links are read — never canonical_contact or contact_point.
 */
@Injectable()
export class WeeklyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataRights: DataRightsService,
    private readonly sanctions: SanctionsScreeningService,
  ) {}

  async weekly(ctx: RequestContext, request: WeeklyReportRequest): Promise<WeeklyReport> {
    const { icpId } = request;
    if (typeof icpId !== 'string' || !UUID.test(icpId)) throw invalid('icpId must be a UUID');
    const week = request.week === undefined || request.week === '' ? isoWeekOf(new Date()) : request.week;
    const range = typeof week === 'string' ? parseIsoWeek(week) : null;
    if (!range) throw invalid('week must be an ISO week such as 2026-W42');
    const reportId = randomUUID();

    return this.prisma.withWorkspace(
      ctx.workspaceId,
      async (tx) => {
        const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, select: { id: true } });
        if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });

        const leads: ReportLead[] = await tx.lead.findMany({
          where: {
            icpId,
            status: { in: [...DELIVERED_LEAD_STATUSES] },
            decisions: { some: { action: 'accept', createdAt: { gte: range.start, lt: range.end } } },
          },
          select: { id: true, canonicalCompanyId: true, fitVerdict: true, totalScore: true, scores: true },
          orderBy: [{ totalScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
          take: WEEKLY_REPORT_MAX_LEADS + 1,
        });
        if (leads.length > WEEKLY_REPORT_MAX_LEADS) {
          throw new UnprocessableEntityException({
            error: {
              code: 'WEEKLY_REPORT_TOO_LARGE',
              message: `more than ${WEEKLY_REPORT_MAX_LEADS} leads were accepted in ${range.week}`,
            },
          });
        }

        const built = leads.length ? await this.buildRows(tx, ctx, reportId, icpId, leads) : null;
        return {
          reportId,
          week: range.week,
          icpId,
          csv: encodeCsv(WEEKLY_REPORT_COLUMNS, built?.rows ?? []),
          rows: built?.rows.length ?? 0,
          withheld: built?.withheld ?? { rights: 0, sanctions: 0, quarantined: 0 },
        };
      },
      TRANSACTION,
    );
  }

  private async buildRows(tx: Tx, ctx: RequestContext, reportId: string, icpId: string, leads: readonly ReportLead[]) {
    const facts = await this.loadFacts(tx, ctx.workspaceId, icpId, [
      ...new Set(leads.map((lead) => lead.canonicalCompanyId)),
    ]);
    const rows: CsvValue[][] = [];
    const decisions: PolicyDecisionEntry[] = [];
    const withheld = { rights: 0, sanctions: 0, quarantined: 0 };
    for (const lead of leads) {
      // FK lead → canonical_company (cascade) and the same RLS scope make a miss impossible; skip defensively.
      const company = facts.companies.get(lead.canonicalCompanyId);
      if (!company) continue;
      const evidence = facts.evidence.get(company.id) ?? [];
      if (evidence.some(isSyntheticDiscoveryProvenance)) {
        withheld.quarantined += 1;
        continue;
      }
      const sanctions = sanctionsDelivery(
        facts.screenings.get(company.id),
        this.sanctions.screen(company.name, company.country),
      );
      if (sanctions.blocking) {
        withheld.sanctions += 1;
        continue;
      }
      const rightsContext = exportRightsContextForLead({
        country: company.country,
        suppressed: company.status === 'SUPPRESSED' || facts.isListed(company),
        hasEvidence: evidence.length > 0,
      });
      const decision = this.dataRights.evaluate(rightsContext);
      decisions.push({
        ctx: rightsContext,
        decision,
        meta: { subjectType: 'lead', subjectId: lead.id, actorId: ctx.userId, correlationId: reportId },
      });
      if (!decision.allowed) {
        withheld.rights += 1;
        continue;
      }
      const freshness = evidence
        .filter((group) => group._min.fetchedAt != null)
        .map((group) => ({ dataClass: group.dataClass, fetchedAt: group._min.fetchedAt as Date }));
      rows.push([
        ...weeklyReportRow({
          leadId: lead.id,
          fitVerdict: lead.fitVerdict,
          totalScore: lead.totalScore,
          scores: lead.scores,
          company,
          contactPoints: facts.contactPoints.get(company.id) ?? [],
          sanctionsStatus: sanctions.status,
          validUntil: computeValidUntil(freshness, company.attributes),
          runCost: facts.runCosts.get(company.id) ?? null,
        }),
      ]);
    }
    await this.dataRights.logDecisions(tx, ctx.workspaceId, decisions);
    return { rows, withheld };
  }

  /** Everything the rows need, read in a few bounded queries keyed by company id. */
  private async loadFacts(tx: Tx, workspaceId: string, icpId: string, companyIds: string[]) {
    // Sequential on purpose: an interactive transaction runs on one connection anyway.
    const companies: ReportCompany[] = await tx.canonicalCompany.findMany({
      where: { id: { in: companyIds } },
      select: { id: true, name: true, domain: true, country: true, status: true, attributes: true },
    });
    const evidence = await tx.fieldEvidence.groupBy({
      by: ['entityId', 'dataClass', 'providerKey', 'license'],
      where: { entityType: 'company', entityId: { in: companyIds } },
      _min: { fetchedAt: true },
    });
    const contactPoints = await tx.companyContactPoint.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, kind: true, value: true, status: true },
      orderBy: [{ kind: 'asc' }, { value: 'asc' }],
    });
    const screenings = await tx.sanctionsScreeningResult.findMany({
      where: { canonicalCompanyId: { in: companyIds } },
      select: { canonicalCompanyId: true, status: true, reviewState: true, matches: true },
    });
    const suppressions = await tx.suppressionRecord.findMany({
      where: { type: { in: ['domain', 'company_name'] } },
      select: { type: true, value: true },
    });
    const suppressedDomains = canonicalizeSuppressionValues(
      'domain',
      suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
    );
    const suppressedNames = canonicalizeSuppressionValues(
      'company_name',
      suppressions.filter((row) => row.type === 'company_name').map((row) => row.value),
    );
    return {
      companies: new Map(companies.map((company) => [company.id, company])),
      evidence: groupBy(evidence, (row) => row.entityId),
      contactPoints: groupBy(contactPoints, (row) => row.companyId),
      screenings: new Map<string, PriorScreening>(screenings.map((row) => [row.canonicalCompanyId, row])),
      /** Same canonical keys as the accept-time suppression check (companyMatchesSuppression). */
      isListed: (company: ReportCompany): boolean => {
        const domain = company.domain ? canonicalizeSuppressionValue('domain', company.domain) : null;
        const name = canonicalizeSuppressionValue('company_name', company.name);
        return (!!domain && suppressedDomains.has(domain)) || (!!name && suppressedNames.has(name));
      },
      runCosts: await this.runCosts(tx, workspaceId, icpId, companyIds),
    };
  }

  /**
   * Run-level cost (design E4 deferred: no per-lead allocation yet). The run is the latest
   * discovery run of this ICP that materialized the company; its cost is the charged total of the
   * run's budget account(s), found through its query receipts. Null when any account is missing.
   */
  private async runCosts(
    tx: Tx,
    workspaceId: string,
    icpId: string,
    companyIds: readonly string[],
  ): Promise<Map<string, NonNullable<WeeklyReportRowInput['runCost']>>> {
    const result = new Map<string, NonNullable<WeeklyReportRowInput['runCost']>>();
    const outcomes = await tx.discoveryCompanyMaterializationOutcome.findMany({
      where: { canonicalCompanyId: { in: [...companyIds] } },
      select: { canonicalCompanyId: true, runId: true },
      distinct: ['canonicalCompanyId', 'runId'],
    });
    if (outcomes.length === 0) return result;
    const runs = await tx.discoveryRun.findMany({
      where: { id: { in: [...new Set(outcomes.map((outcome) => outcome.runId))] }, icpId },
      select: { id: true, createdAt: true },
    });
    const runById = new Map(runs.map((run) => [run.id, run]));
    const latestRun = new Map<string, { id: string; createdAt: Date }>();
    for (const outcome of outcomes) {
      const run = runById.get(outcome.runId);
      const companyId = outcome.canonicalCompanyId;
      if (!run || !companyId) continue;
      const current = latestRun.get(companyId);
      if (
        !current ||
        run.createdAt.getTime() > current.createdAt.getTime() ||
        (run.createdAt.getTime() === current.createdAt.getTime() && run.id > current.id)
      ) {
        latestRun.set(companyId, run);
      }
    }
    if (latestRun.size === 0) return result;
    const runIds = [...new Set([...latestRun.values()].map((run) => run.id))];
    const receipts = await tx.discoveryQueryReceipt.findMany({
      where: { runId: { in: runIds } },
      select: { runId: true, accountKey: true },
      distinct: ['runId', 'accountKey'],
    });
    const keysByRun = groupBy(receipts, (receipt) => receipt.runId);
    const accountKeys = [...new Set(receipts.map((receipt) => receipt.accountKey))];
    const accounts = accountKeys.length
      ? await tx.toolBudgetAccount.findMany({
          where: { scopeKey: workspaceId, accountKey: { in: accountKeys } },
          select: { accountKey: true, chargedMicrousd: true },
        })
      : [];
    const chargedByKey = new Map(accounts.map((account) => [account.accountKey, account.chargedMicrousd]));
    const chargedByRun = new Map<string, bigint | null>();
    for (const runId of runIds) {
      const keys = (keysByRun.get(runId) ?? []).map((receipt) => receipt.accountKey);
      const charges = keys.map((key) => chargedByKey.get(key));
      chargedByRun.set(
        runId,
        keys.length > 0 && charges.every((charge): charge is bigint => typeof charge === 'bigint')
          ? charges.reduce((sum, charge) => sum + charge, 0n)
          : null,
      );
    }
    for (const [companyId, run] of latestRun) {
      result.set(companyId, { runId: run.id, chargedMicrousd: chargedByRun.get(run.id) ?? null });
    }
    return result;
  }
}
