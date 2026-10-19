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
import type { DataRightsDecision } from '../compliance/data-rights.types';
import { isSyntheticDiscoveryProvenance } from '../discovery/evidence-license';
import { canonicalizeSuppressionValue, canonicalizeSuppressionValues } from '../discovery/suppression-value';
import { computeValidUntil } from '../lead/lead-qualified-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import {
  matchesFromJson,
  reconcileReviewState,
  SanctionsScreeningService,
  storedScreeningBlocks,
  type ScreenResult,
} from '../sanctions/sanctions-screening.service';
import { encodeCsv, type CsvValue } from './csv';
import { isoWeekOf, parseIsoWeek, type IsoWeekRange } from './iso-week';
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
    /** DataRights EXPORT denied (suppressed, or no evidence). */
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
  /** The latest decision only (ordered newest first, take 1). */
  decisions: { action: string; createdAt: Date }[];
}
interface DeliveredLead extends ReportLead {
  /** When the accept that puts the lead in this week's report was made. */
  acceptedAt: Date;
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
type RunCost = NonNullable<WeeklyReportRowInput['runCost']>;
type ReportFacts = Awaited<ReturnType<WeeklyReportService['loadFacts']>>;

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
 * A lead belongs to the week of its latest decision when that decision is an accept: a lead that
 * was rejected and accepted again is listed once, in the week of the last accept.
 */
function deliveredInWeek(lead: ReportLead, range: IsoWeekRange): DeliveredLead | null {
  const latest = lead.decisions[0];
  if (!latest || latest.action !== 'accept') return null;
  const at = latest.createdAt.getTime();
  if (at < range.start.getTime() || at >= range.end.getTime()) return null;
  return { ...lead, acceptedAt: latest.createdAt };
}

/**
 * Same rule as the accept-time fifth gate (LeadService.decide): a persisted hit blocks unless a
 * person cleared it as a false positive, and a live hit blocks unless every match was already
 * cleared. Not screened when the gate is off and nothing was ever recorded.
 */
export function sanctionsDelivery(
  prior: PriorScreening | undefined,
  live: ScreenResult,
): { blocking: true } | { blocking: false; status: WeeklyReportSanctionsStatus } {
  const priorBlocking = storedScreeningBlocks(prior);
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
 * EXPORT denied by a gate that runs before the DataRights engine (quarantine, sanctions). Shaped
 * like the engine's own pre-rule denials (`suppressed`, `no_evidence`): no rule id, empty version.
 */
function gateDenial(reason: 'synthetic_quarantined' | 'sanctions_hold'): DataRightsDecision {
  return {
    effect: 'DENY',
    allowed: false,
    reason,
    ruleId: null,
    ruleVersion: '',
    requiresLawfulBasis: false,
    article14NoticeRequired: false,
  };
}

/**
 * BI-22 weekly report (design §5, L4-lite): one CSV row per lead of the ICP whose latest decision
 * is an accept in the ISO week. Reads happen in one short transaction; sanctions screening (CPU on
 * the in-memory index) and the per-row decisions run outside it; every decision — exported, denied
 * by DataRights, or withheld for sanctions or synthetic provenance — is then written to
 * policy_decision_log in its own transaction, and the CSV is returned only after that commits.
 * Only company-level facts and company contact links are read — never canonical_contact or
 * contact_point.
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

    const snapshot = await this.prisma.withWorkspace(
      ctx.workspaceId,
      (tx) => this.read(tx, ctx.workspaceId, icpId, range),
      TRANSACTION,
    );
    const built = snapshot ? this.buildRows(ctx, reportId, snapshot.leads, snapshot.facts) : null;
    if (built && built.decisions.length > 0) {
      await this.prisma.withWorkspace(
        ctx.workspaceId,
        (tx) => this.dataRights.logDecisions(tx, ctx.workspaceId, built.decisions),
        TRANSACTION,
      );
    }
    return {
      reportId,
      week: range.week,
      icpId,
      csv: encodeCsv(WEEKLY_REPORT_COLUMNS, built?.rows ?? []),
      rows: built?.rows.length ?? 0,
      withheld: built?.withheld ?? { rights: 0, sanctions: 0, quarantined: 0 },
    };
  }

  /** The week's delivered leads and their facts; null when the week has none. */
  private async read(tx: Tx, workspaceId: string, icpId: string, range: IsoWeekRange) {
    const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, select: { id: true } });
    if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });

    const candidates: ReportLead[] = await tx.lead.findMany({
      where: {
        icpId,
        status: { in: [...DELIVERED_LEAD_STATUSES] },
        decisions: {
          some: { action: 'accept', createdAt: { gte: range.start, lt: range.end } },
          none: { createdAt: { gte: range.end } },
        },
      },
      select: {
        id: true,
        canonicalCompanyId: true,
        fitVerdict: true,
        totalScore: true,
        scores: true,
        decisions: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { action: true, createdAt: true },
        },
      },
      orderBy: [{ totalScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      take: WEEKLY_REPORT_MAX_LEADS + 1,
    });
    if (candidates.length > WEEKLY_REPORT_MAX_LEADS) {
      throw new UnprocessableEntityException({
        error: {
          code: 'WEEKLY_REPORT_TOO_LARGE',
          message: `more than ${WEEKLY_REPORT_MAX_LEADS} leads were accepted in ${range.week}`,
        },
      });
    }
    const leads = candidates.flatMap((lead) => deliveredInWeek(lead, range) ?? []);
    if (leads.length === 0) return null;
    return { leads, facts: await this.loadFacts(tx, workspaceId, icpId, leads) };
  }

  /** Pure CPU over the snapshot: screening, decisions and rows. Never inside a transaction. */
  private buildRows(ctx: RequestContext, reportId: string, leads: readonly DeliveredLead[], facts: ReportFacts) {
    const rows: CsvValue[][] = [];
    const decisions: PolicyDecisionEntry[] = [];
    const withheld = { rights: 0, sanctions: 0, quarantined: 0 };
    const screen = this.memoizedScreen();
    for (const lead of leads) {
      // FK lead → canonical_company (cascade) and the same RLS scope make a miss impossible; skip defensively.
      const company = facts.companies.get(lead.canonicalCompanyId);
      if (!company) continue;
      const evidence = facts.evidence.get(company.id) ?? [];
      const rightsContext = exportRightsContextForLead({
        country: company.country,
        suppressed: company.status === 'SUPPRESSED' || facts.isListed(company),
        hasEvidence: evidence.length > 0,
      });
      const meta = { subjectType: 'lead', subjectId: lead.id, actorId: ctx.userId, correlationId: reportId };
      if (evidence.some(isSyntheticDiscoveryProvenance)) {
        withheld.quarantined += 1;
        decisions.push({ ctx: rightsContext, decision: gateDenial('synthetic_quarantined'), meta });
        continue;
      }
      const sanctions = sanctionsDelivery(facts.screenings.get(company.id), screen(company));
      if (sanctions.blocking) {
        withheld.sanctions += 1;
        decisions.push({ ctx: rightsContext, decision: gateDenial('sanctions_hold'), meta });
        continue;
      }
      const decision = this.dataRights.evaluate(rightsContext);
      decisions.push({ ctx: rightsContext, decision, meta });
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
    return { rows, decisions, withheld };
  }

  /** Live screening once per (name, country) of this report: several sites of one firm share a name. */
  private memoizedScreen(): (company: ReportCompany) => ScreenResult {
    const results = new Map<string, ScreenResult>();
    return (company) => {
      const key = JSON.stringify([company.name, company.country]);
      let result = results.get(key);
      if (!result) {
        result = this.sanctions.screen(company.name, company.country);
        results.set(key, result);
      }
      return result;
    };
  }

  /** Everything the rows need, read in a few bounded queries keyed by company id. */
  private async loadFacts(tx: Tx, workspaceId: string, icpId: string, leads: readonly DeliveredLead[]) {
    const companyIds = [...new Set(leads.map((lead) => lead.canonicalCompanyId))];
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
      runCosts: await this.runCosts(tx, workspaceId, icpId, leads),
    };
  }

  /**
   * Run-level cost (design E4 deferred: no per-lead allocation yet). The run is the latest
   * discovery run of this ICP that materialized the company and was created no later than the
   * lead's accept, so a later run never changes an exported week. Keyed by company: a lead is
   * unique per (ICP, company).
   */
  private async runCosts(
    tx: Tx,
    workspaceId: string,
    icpId: string,
    leads: readonly DeliveredLead[],
  ): Promise<Map<string, RunCost>> {
    const result = new Map<string, RunCost>();
    const acceptedAt = new Map(leads.map((lead) => [lead.canonicalCompanyId, lead.acceptedAt.getTime()]));
    const outcomes = await tx.discoveryCompanyMaterializationOutcome.findMany({
      where: { canonicalCompanyId: { in: [...acceptedAt.keys()] } },
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
      const accepted = companyId ? acceptedAt.get(companyId) : undefined;
      if (!run || !companyId || accepted === undefined || run.createdAt.getTime() > accepted) continue;
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
    const chargedByRun = await this.runCharges(tx, workspaceId, [...new Set([...latestRun.values()].map((run) => run.id))]);
    for (const [companyId, run] of latestRun) {
      result.set(companyId, { runId: run.id, chargedMicrousd: chargedByRun.get(run.id) ?? null });
    }
    return result;
  }

  /**
   * Charged total of each run's budget account(s), found through its query receipts. Null — never
   * an under-count — when any account is missing or still holds a reservation (an operation still
   * RESERVED or RESULT_UNKNOWN, whose spend is not settled yet).
   */
  private async runCharges(tx: Tx, workspaceId: string, runIds: readonly string[]): Promise<Map<string, bigint | null>> {
    const receipts = await tx.discoveryQueryReceipt.findMany({
      where: { runId: { in: [...runIds] } },
      select: { runId: true, accountKey: true },
      distinct: ['runId', 'accountKey'],
    });
    const keysByRun = groupBy(receipts, (receipt) => receipt.runId);
    const accountKeys = [...new Set(receipts.map((receipt) => receipt.accountKey))];
    const accounts = accountKeys.length
      ? await tx.toolBudgetAccount.findMany({
          where: { scopeKey: workspaceId, accountKey: { in: accountKeys } },
          select: { accountKey: true, chargedMicrousd: true, reservedMicrousd: true },
        })
      : [];
    const accountByKey = new Map(accounts.map((account) => [account.accountKey, account]));
    const chargedByRun = new Map<string, bigint | null>();
    for (const runId of runIds) {
      const runAccounts = (keysByRun.get(runId) ?? []).map((receipt) => accountByKey.get(receipt.accountKey));
      const settled =
        runAccounts.length > 0 &&
        runAccounts.every(
          (account) =>
            account !== undefined && account.reservedMicrousd === 0n && typeof account.chargedMicrousd === 'bigint',
        );
      chargedByRun.set(
        runId,
        settled ? runAccounts.reduce((sum, account) => sum + (account?.chargedMicrousd ?? 0n), 0n) : null,
      );
    }
    return chargedByRun;
  }
}
