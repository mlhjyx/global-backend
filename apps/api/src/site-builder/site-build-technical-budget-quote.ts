import { createHash } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { COPY_GENERATION_LOCALES } from '@global/contracts';
import {
  resolveTaskRoute,
} from './agents/task-routes';
import type { SiteBuilderGenerativeTaskId } from './agents/task-route-bindings';
import {
  crawl4aiFetchTool,
  searxngSearchTool,
} from '../tools/builtin-tools';

export const SITE_BUILD_TECHNICAL_BUDGET_QUOTE_SCHEMA =
  'site-builder-technical-budget-quote/v1' as const;

const QUOTE_TTL_MS = 5 * 60 * 1_000;
const STRUCTURED_OUTPUT_WIRE_UPPER_BOUND = 2;
const TEMPORAL_ACTIVITY_ATTEMPT_UPPER_BOUND = 2;
const MICROUSD_PER_CENT = 10_000n;
const INTAKE_REPRESENTATION_MINIMUM_MICROUSD = 1n;
const MAX_ROUTE_ALIASES = 4;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;

export interface TechnicalBudgetRoute {
  readonly primary: string;
  readonly fallbacks: readonly string[];
  readonly maxCostCents: number;
  readonly maxTokens: number;
}

export interface SiteBuildTechnicalBudgetQuote {
  readonly schemaVersion: typeof SITE_BUILD_TECHNICAL_BUDGET_QUOTE_SCHEMA;
  readonly operation: 'intake' | 'refurbish';
  readonly siteId: string | null;
  readonly requestSha256: string;
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly requiredCapMicrousd: string;
  readonly policyRevision: string;
  readonly expiresAt: string;
}

interface QuoteDependencies {
  readonly now?: () => Date;
  readonly resolveRoute?: (
    taskId: SiteBuilderGenerativeTaskId,
    env: NodeJS.ProcessEnv,
  ) => TechnicalBudgetRoute;
}

interface RouteEnvelope {
  readonly taskId: SiteBuilderGenerativeTaskId;
  readonly primary: string;
  readonly fallbacks: readonly string[];
  readonly maxCostCents: number;
  readonly maxTokens: number;
  readonly routeAliases: number;
  readonly structuredOutputWireUpperBound: number;
  readonly temporalActivityAttemptUpperBound: number;
  readonly multiplicity: number;
}

export class SiteBuildTechnicalBudgetQuoteError extends ServiceUnavailableException {
  readonly code = 'SITE_BUILD_BUDGET_QUOTE_UNAVAILABLE' as const;

  constructor() {
    super({
      error: {
        code: 'SITE_BUILD_BUDGET_QUOTE_UNAVAILABLE',
        message: 'technical budget quote is temporarily unavailable',
      },
    });
    this.name = 'SiteBuildTechnicalBudgetQuoteError';
    this.message = this.code;
  }
}

function unavailable(): never {
  throw new SiteBuildTechnicalBudgetQuoteError();
}

function checkedRequestHash(value: string): string {
  if (!SHA256.test(value)) unavailable();
  return value;
}

function checkedSiteId(value: string): string {
  if (!UUID.test(value)) unavailable();
  return value;
}

function routeEnvelope(
  taskId: SiteBuilderGenerativeTaskId,
  route: TechnicalBudgetRoute,
  multiplicity: number,
): RouteEnvelope {
  if (!route || !Number.isSafeInteger(multiplicity) || multiplicity < 1) {
    return unavailable();
  }
  const aliases = [route.primary, ...route.fallbacks];
  if (
    aliases.length < 1 ||
    aliases.length > MAX_ROUTE_ALIASES ||
    new Set(aliases).size !== aliases.length ||
    aliases.some((alias) => !MODEL_ALIAS.test(alias)) ||
    !Number.isSafeInteger(route.maxCostCents) ||
    route.maxCostCents < 1 ||
    route.maxCostCents > 100 ||
    !Number.isSafeInteger(route.maxTokens) ||
    route.maxTokens < 1
  ) {
    return unavailable();
  }
  return Object.freeze({
    taskId,
    primary: route.primary,
    fallbacks: Object.freeze([...route.fallbacks]),
    maxCostCents: route.maxCostCents,
    maxTokens: route.maxTokens,
    routeAliases: aliases.length,
    structuredOutputWireUpperBound: STRUCTURED_OUTPUT_WIRE_UPPER_BOUND,
    temporalActivityAttemptUpperBound:
      TEMPORAL_ACTIVITY_ATTEMPT_UPPER_BOUND,
    multiplicity,
  });
}

function routeCostCents(envelope: RouteEnvelope): bigint {
  return (
    BigInt(envelope.routeAliases) *
    BigInt(envelope.structuredOutputWireUpperBound) *
    BigInt(envelope.temporalActivityAttemptUpperBound) *
    BigInt(envelope.multiplicity) *
    BigInt(envelope.maxCostCents)
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Computes a platform-internal execution safety envelope. It is deliberately
 * pure: no database, workflow, provider, storage, billing or network dependency
 * is accepted by this class.
 */
@Injectable()
export class SiteBuildTechnicalBudgetQuoteService {
  private readonly now: () => Date;
  private readonly routeResolver: NonNullable<QuoteDependencies['resolveRoute']>;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    dependencies: QuoteDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.routeResolver = dependencies.resolveRoute ?? resolveTaskRoute;
  }

  quoteIntake(requestSha256: string): SiteBuildTechnicalBudgetQuote {
    const policy = Object.freeze({
      schemaVersion: SITE_BUILD_TECHNICAL_BUDGET_QUOTE_SCHEMA,
      operation: 'intake',
      executionMode: 'deterministic_demo_v0',
      paidOperations: 0,
      representationMinimumMicrousd:
        INTAKE_REPRESENTATION_MINIMUM_MICROUSD.toString(),
    });
    return this.quote(
      'intake',
      null,
      checkedRequestHash(requestSha256),
      INTAKE_REPRESENTATION_MINIMUM_MICROUSD,
      policy,
    );
  }

  quoteRefurbish(
    siteId: string,
    requestSha256: string,
  ): SiteBuildTechnicalBudgetQuote {
    let brandRoute: TechnicalBudgetRoute;
    let copyRoute: TechnicalBudgetRoute;
    try {
      brandRoute = this.routeResolver('site_builder.brand_profile', this.env);
      copyRoute = this.routeResolver('site_builder.copy', this.env);
    } catch {
      return unavailable();
    }
    const brand = routeEnvelope('site_builder.brand_profile', brandRoute, 1);
    const copy = routeEnvelope(
      'site_builder.copy',
      copyRoute,
      COPY_GENERATION_LOCALES.length,
    );
    const researchTools = Object.freeze([
      Object.freeze({
        id: crawl4aiFetchTool.id,
        version: crawl4aiFetchTool.version,
        callsPerActivityAttempt: 1,
        estimatedCents: crawl4aiFetchTool.cost.estimatedCents,
      }),
      Object.freeze({
        id: searxngSearchTool.id,
        version: searxngSearchTool.version,
        callsPerActivityAttempt: 1,
        estimatedCents: searxngSearchTool.cost.estimatedCents,
      }),
    ]);
    if (
      researchTools.some(
        (tool) =>
          !Number.isSafeInteger(tool.estimatedCents) ||
          tool.estimatedCents < 0,
      )
    ) {
      return unavailable();
    }
    const researchCents = researchTools.reduce(
      (total, tool) =>
        total +
        BigInt(tool.callsPerActivityAttempt) *
          BigInt(TEMPORAL_ACTIVITY_ATTEMPT_UPPER_BOUND) *
          BigInt(tool.estimatedCents),
      0n,
    );
    const requiredCapMicrousd =
      (routeCostCents(brand) + routeCostCents(copy) + researchCents) *
      MICROUSD_PER_CENT;
    if (requiredCapMicrousd < 1n) return unavailable();
    const policy = Object.freeze({
      schemaVersion: SITE_BUILD_TECHNICAL_BUDGET_QUOTE_SCHEMA,
      operation: 'refurbish',
      generativeTasks: Object.freeze([brand, copy]),
      researchTools,
      copyLocales: Object.freeze([...COPY_GENERATION_LOCALES]),
      microUsdPerCent: MICROUSD_PER_CENT.toString(),
    });
    return this.quote(
      'refurbish',
      checkedSiteId(siteId),
      checkedRequestHash(requestSha256),
      requiredCapMicrousd,
      policy,
    );
  }

  private quote(
    operation: 'intake' | 'refurbish',
    siteId: string | null,
    requestSha256: string,
    requiredCapMicrousd: bigint,
    policy: unknown,
  ): SiteBuildTechnicalBudgetQuote {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      return unavailable();
    }
    return Object.freeze({
      schemaVersion: SITE_BUILD_TECHNICAL_BUDGET_QUOTE_SCHEMA,
      operation,
      siteId,
      requestSha256,
      currency: 'USD',
      unit: 'microusd',
      requiredCapMicrousd: requiredCapMicrousd.toString(),
      policyRevision: digest(policy),
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS).toISOString(),
    });
  }
}
