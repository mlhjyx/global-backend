import { createHash } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type DiscoveryQueryPlan } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import {
  suggestAdaptiveQueryPlan,
  type AdaptiveIdentityQuality,
  type AdaptivePlanQuery,
  type AdaptiveRoundStats,
  type AdaptiveSourceStats,
  type AdaptiveSuggestionReason,
} from '../discovery/adaptive-query-plan';
import { PrismaService } from '../prisma/prisma.service';

export interface AdaptiveQueryPlanRequest {
  currentRound?: number;
  maxRounds?: number;
}

export interface AdaptiveQueryPlanResult {
  outcome: 'DRAFT' | 'CONVERGED';
  replayed: boolean;
  convergenceReason: 'MAX_ROUNDS_REACHED' | 'NO_SAFE_ADAPTATION' | 'NO_ADAPTATION_NEEDED' | null;
  plan: DiscoveryQueryPlan | null;
}

interface AdaptivePlanTrace {
  schemaVersion: 'adaptive-query-plan-suggestion/v1';
  previousRunId: string;
  previousPlanId: string;
  currentRound: number;
  nextRound: number;
  maxRounds: number;
  reasons: AdaptiveSuggestionReason[];
}

const TRACE_VERSION = 'adaptive-query-plan-suggestion/v1' as const;
const SUCCESSFUL_RUN_STATUSES = new Set(['DONE', 'PARTIAL']);
const DEFAULT_MAX_ROUNDS = 3;
const ADAPTIVE_REASON_CODES = new Set([
  'LOW_YIELD_BROADENED',
  'LOW_YIELD_NO_SAFE_CHANGE',
  'DUPLICATE_SATURATION',
  'SOURCE_FAILURE_PAUSED',
  'LOW_IDENTITY_QUALITY',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidFacts(`${label} must be a non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalidFacts(`${label} must be a positive integer`);
  }
  return value;
}

function optionalProvider(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidFacts(`${label} must be a provider key or null`);
  }
  return value;
}

function invalidFacts(message: string): ConflictException {
  return new ConflictException({
    error: { code: 'ADAPTIVE_FACTS_UNAVAILABLE', message },
  });
}

function requestConflict(message: string): ConflictException {
  return new ConflictException({
    error: { code: 'IDEMPOTENCY_CONFLICT', message },
  });
}

function parseSourceStats(value: unknown, label: string): AdaptiveSourceStats {
  const source = record(value);
  if (!source) throw invalidFacts(`${label} must be an object`);
  const parsed: AdaptiveSourceStats = {
    rawCount: nonNegativeInteger(source.rawCount, `${label}.rawCount`),
    quarantinedCount: nonNegativeInteger(source.quarantinedCount, `${label}.quarantinedCount`),
    rejectedCount: nonNegativeInteger(source.rejectedCount, `${label}.rejectedCount`),
    duplicateCount: nonNegativeInteger(source.duplicateCount, `${label}.duplicateCount`),
    failedProviderCount: nonNegativeInteger(source.failedProviderCount, `${label}.failedProviderCount`),
    provider: optionalProvider(source.provider, `${label}.provider`),
  };
  if (source.yieldCount !== undefined) {
    parsed.yieldCount = nonNegativeInteger(source.yieldCount, `${label}.yieldCount`);
  }
  return parsed;
}

function parseIdentityQuality(value: unknown, label: string): AdaptiveIdentityQuality {
  const quality = record(value);
  if (!quality) throw invalidFacts(`${label} must be an object`);
  return {
    acceptedRows: nonNegativeInteger(quality.acceptedRows, `${label}.acceptedRows`),
    boundRows: nonNegativeInteger(quality.boundRows, `${label}.boundRows`),
    uniqueCompanies: nonNegativeInteger(quality.uniqueCompanies, `${label}.uniqueCompanies`),
    conflictRows: nonNegativeInteger(quality.conflictRows, `${label}.conflictRows`),
  };
}

function parseRoundStats(value: unknown): AdaptiveRoundStats {
  const stats = record(value);
  const perSource = record(stats?.perSource);
  const identityQuality = record(stats?.identityQuality);
  if (!stats || !perSource || !identityQuality) {
    throw invalidFacts('completed discovery run does not contain adaptive perSource and identityQuality facts');
  }
  return {
    perSource: Object.fromEntries(
      Object.entries(perSource).map(([key, source]) => [key, parseSourceStats(source, `perSource.${key}`)]),
    ),
    identityQuality: Object.fromEntries(
      Object.entries(identityQuality).map(([key, quality]) => [key, parseIdentityQuality(quality, `identityQuality.${key}`)]),
    ),
  };
}

function parseAdaptiveTrace(value: unknown, label: string): AdaptivePlanTrace {
  const trace = record(value);
  if (
    !trace
    || trace.schemaVersion !== TRACE_VERSION
    || typeof trace.previousRunId !== 'string'
    || trace.previousRunId.trim() === ''
    || typeof trace.previousPlanId !== 'string'
    || trace.previousPlanId.trim() === ''
    || !Array.isArray(trace.reasons)
  ) {
    throw invalidFacts(`${label} is invalid`);
  }
  const currentRound = positiveInteger(trace.currentRound, `${label}.currentRound`);
  const nextRound = positiveInteger(trace.nextRound, `${label}.nextRound`);
  const maxRounds = positiveInteger(trace.maxRounds, `${label}.maxRounds`);
  if (nextRound !== currentRound + 1 || nextRound > maxRounds) {
    throw invalidFacts(`${label} round chain is invalid`);
  }
  const reasons = trace.reasons.map((value, index) => {
    const reason = record(value);
    if (
      !reason
      || typeof reason.sourceClass !== 'string'
      || reason.sourceClass.trim() === ''
      || typeof reason.code !== 'string'
      || !ADAPTIVE_REASON_CODES.has(reason.code)
      || typeof reason.detail !== 'string'
      || reason.detail.trim() === ''
    ) {
      throw invalidFacts(`${label}.reasons.${index} is invalid`);
    }
    return {
      sourceClass: reason.sourceClass,
      code: reason.code,
      detail: reason.detail,
    } as AdaptiveSuggestionReason;
  });
  return {
    schemaVersion: TRACE_VERSION,
    previousRunId: trace.previousRunId,
    previousPlanId: trace.previousPlanId,
    currentRound,
    nextRound,
    maxRounds,
    reasons,
  };
}

function sameTrace(left: AdaptivePlanTrace, right: AdaptivePlanTrace): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseSourcePlan(value: unknown): { queries: AdaptivePlanQuery[]; trace: AdaptivePlanTrace | null } {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidFacts('source query plan has no executable query array');
  }
  const sourceClasses = new Set<string>();
  const tracePresence: boolean[] = [];
  const traces: AdaptivePlanTrace[] = [];
  const queries = value.map((value, index) => {
    const query = record(value);
    const filters = record(query?.filters);
    if (
      !query
      || typeof query.source_class !== 'string'
      || query.source_class.trim() === ''
      || !filters
      || !Array.isArray(query.keywords)
      || !query.keywords.every((keyword) => typeof keyword === 'string')
      || typeof query.priority !== 'number'
      || !Number.isFinite(query.priority)
    ) {
      throw invalidFacts(`source query plan item ${index} is invalid`);
    }
    if (sourceClasses.has(query.source_class)) {
      throw invalidFacts(`source query plan repeats source_class ${query.source_class}`);
    }
    sourceClasses.add(query.source_class);
    const hasTrace = Object.hasOwn(query, '_adaptive');
    tracePresence.push(hasTrace);
    if (hasTrace) traces.push(parseAdaptiveTrace(query._adaptive, `source query plan item ${index}._adaptive`));
    const { _adaptive: _previousTrace, ...withoutTrace } = query;
    return {
      ...withoutTrace,
      source_class: query.source_class,
      filters,
      keywords: [...query.keywords],
      priority: query.priority,
    } as AdaptivePlanQuery;
  });
  const tracedCount = tracePresence.filter(Boolean).length;
  if (tracedCount !== 0 && tracedCount !== queries.length) {
    throw invalidFacts('source query plan must have adaptive trace on every query or none');
  }
  if (traces.length > 1 && traces.slice(1).some((trace) => !sameTrace(traces[0]!, trace))) {
    throw invalidFacts('source query plan adaptive traces are inconsistent');
  }
  return { queries, trace: traces[0] ?? null };
}

function assertExactSourceStats(queries: AdaptivePlanQuery[], stats: AdaptiveRoundStats): void {
  const planned = queries.map((query) => query.source_class).sort((left, right) => left.localeCompare(right));
  const observed = Object.keys(stats.perSource).sort((left, right) => left.localeCompare(right));
  if (planned.length !== observed.length || planned.some((key, index) => key !== observed[index])) {
    throw invalidFacts('adaptive perSource keys must exactly match source query plan source_class values');
  }
}

function resolveRoundFacts(
  sourceTrace: AdaptivePlanTrace | null,
  request: AdaptiveQueryPlanRequest,
): { currentRound: number; maxRounds: number } {
  if (request.currentRound !== undefined && (!Number.isInteger(request.currentRound) || request.currentRound < 1)) {
    throw requestConflict('currentRound must be a positive integer when provided');
  }
  if (request.maxRounds !== undefined && (!Number.isInteger(request.maxRounds) || request.maxRounds < 1)) {
    throw requestConflict('maxRounds must be a positive integer when provided');
  }
  const currentRound = sourceTrace?.nextRound ?? 1;
  const maxRounds = sourceTrace?.maxRounds ?? request.maxRounds ?? DEFAULT_MAX_ROUNDS;
  if (request.currentRound !== undefined && request.currentRound !== currentRound) {
    throw requestConflict('currentRound does not match the round derived from the source plan');
  }
  if (sourceTrace && request.maxRounds !== undefined && request.maxRounds !== sourceTrace.maxRounds) {
    throw requestConflict('maxRounds does not match the value inherited from the source plan');
  }
  if (currentRound > maxRounds) {
    throw invalidFacts('derived currentRound exceeds maxRounds');
  }
  return { currentRound, maxRounds };
}

/** Stable UUIDv5-shaped key: the database primary key is the concurrency-safe idempotency boundary. */
function suggestionPlanId(workspaceId: string, runId: string): string {
  const bytes = createHash('sha256')
    .update(`${TRACE_VERSION}:${workspaceId}:${runId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertMatchingReplay(
  plan: DiscoveryQueryPlan,
  runId: string,
  sourcePlanId: string,
  round: { currentRound: number; maxRounds: number },
): void {
  const trace = parseSourcePlan(plan.queries).trace;
  if (
    !trace
    || trace.previousRunId !== runId
    || trace.previousPlanId !== sourcePlanId
    || trace.currentRound !== round.currentRound
    || trace.maxRounds !== round.maxRounds
  ) {
    throw new ConflictException({
      error: {
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'this discovery run already has an adaptive plan with different request facts',
      },
    });
  }
  if (plan.status !== 'DRAFT') {
    throw new ConflictException({
      error: {
        code: 'INVALID_STATE',
        message: `the adaptive plan is already ${plan.status}; a replay cannot replace it`,
      },
    });
  }
}

@Injectable()
export class AdaptiveQueryPlanService {
  constructor(private readonly prisma: PrismaService) {}

  suggestForCompletedRun(
    ctx: RequestContext,
    runId: string,
    request: AdaptiveQueryPlanRequest,
  ): Promise<AdaptiveQueryPlanResult> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const run = await tx.discoveryRun.findUnique({ where: { id: runId } });
      if (!run) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'discovery run not found' },
        });
      }
      if (!SUCCESSFUL_RUN_STATUSES.has(run.status)) {
        throw new ConflictException({
          error: {
            code: 'INVALID_STATE',
            message: `discovery run is ${run.status}; only DONE or PARTIAL runs can produce a next-round draft`,
          },
        });
      }

      const sourcePlan = await tx.discoveryQueryPlan.findUnique({ where: { id: run.planId } });
      if (!sourcePlan) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'source query plan not found' },
        });
      }
      if (sourcePlan.status !== 'EXECUTED' || sourcePlan.icpId !== run.icpId) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: 'completed run and source query plan are inconsistent' },
        });
      }

      const parsedSourcePlan = parseSourcePlan(sourcePlan.queries);
      const round = resolveRoundFacts(parsedSourcePlan.trace, request);
      const stats = parseRoundStats(run.stats);
      assertExactSourceStats(parsedSourcePlan.queries, stats);

      const planId = suggestionPlanId(ctx.workspaceId, run.id);
      // Read the stable idempotency winner before evaluating convergence. A mutable or
      // repaired stats projection must never turn an already-created DRAFT into a
      // contradictory CONVERGED response for the same completed run.
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`adaptive-query-plan:${ctx.workspaceId}:${run.id}`}, 0))::text AS locked`;
      const existing = await tx.discoveryQueryPlan.findUnique({ where: { id: planId } });
      if (existing) {
        assertMatchingReplay(existing, run.id, sourcePlan.id, round);
        return { outcome: 'DRAFT', replayed: true, convergenceReason: null, plan: existing };
      }

      const suggestion = suggestAdaptiveQueryPlan({
        currentRound: round.currentRound,
        maxRounds: round.maxRounds,
        originalPlan: { status: sourcePlan.status, queries: parsedSourcePlan.queries },
        stats,
      });
      if (suggestion.outcome === 'CONVERGED') {
        return {
          outcome: 'CONVERGED',
          replayed: false,
          convergenceReason: suggestion.reason,
          plan: null,
        };
      }

      const trace: AdaptivePlanTrace = {
        schemaVersion: TRACE_VERSION,
        previousRunId: run.id,
        previousPlanId: sourcePlan.id,
        currentRound: round.currentRound,
        nextRound: suggestion.nextRound,
        maxRounds: round.maxRounds,
        reasons: suggestion.reasons,
      };
      const queries = suggestion.queries.map((query) => ({ ...query, _adaptive: trace }));
      const plan = await tx.discoveryQueryPlan.create({
        data: {
          id: planId,
          workspaceId: ctx.workspaceId,
          icpId: run.icpId,
          status: 'DRAFT',
          queries: queries as unknown as Prisma.InputJsonValue,
          estimatedVolume: null,
          estimatedCostCents: null,
        },
      });
      return { outcome: 'DRAFT', replayed: false, convergenceReason: null, plan };
    });
  }
}
