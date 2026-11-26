import { types } from "node:util";
import { ForbiddenException } from "@nestjs/common";
import { isCanonicalArtifactUuid } from "../../durable-results/artifact/artifact.types";
import { enrichContactsExecutionBudgetRequestScope } from "../../execution-budget/execution-budget-request-scope";
import { parseExecutionBudgetBinding } from "../../execution-budget/execution-budget-binding";
import { isValidLawfulBasis } from "../../discovery/compliance/email-verification-gate";
import type { LawfulBasis } from "../../discovery/provider-contract";
import type { ExecutionBroker } from "../../tools/tool-contract";
import {
  resolveConfiguredFinderProviders,
  resolveConfiguredTailFinderProviders,
} from "../finders/finder-pool";
import { checkProviderGates } from "../provider-gates";
import {
  enrichCompanyContacts,
  gateConfiguredVerificationProviders,
  loadCompanyContactEnrichmentTier,
  reachableContactEnrichmentFinders,
} from "../waterfall/enrich-company-contacts";
import { PrismaCircuitBreakerStore } from "../waterfall/circuit-breaker";
import {
  closedSafetyRecord,
  denseSafetyArray,
  EnrichmentSafetyError,
  safetyInteger,
} from "./enrichment-safety.contract";
import { EnrichmentExecutionQueryRepository } from "./enrichment-execution.repository";
import type {
  ContactEnrichmentPreparationDeps,
  ContactEnrichmentResultsAdapterDeps,
  SafetyResultsPort,
} from "./contact-enrichment-safety.composition";
import {
  listContactEnrichmentQualityFacts,
  listContactEnrichmentResults,
  readContactEnrichmentQualityFacts,
  readContactEnrichmentResult,
} from "./contact-enrichment-safety.composition";
import type {
  ContactEnrichmentSafetyOptions,
  ContactEnrichmentSafetyResult,
} from "./contact-enrichment-safety.service";

function assertBypassSafetyAddress(
  workspaceId: string,
  companyId: string,
  operationRef?: string,
): void {
  if (
    ![workspaceId, companyId].every(isCanonicalArtifactUuid) ||
    (operationRef !== undefined && !/^[a-f0-9]{64}$/.test(operationRef))
  ) {
    throw new EnrichmentSafetyError("INVALID_PLAN");
  }
}

function normalizeBypassHttpOptions(
  value: ContactEnrichmentSafetyOptions,
): ContactEnrichmentSafetyOptions {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    types.isProxy(value)
  ) {
    throw new EnrichmentSafetyError("INVALID_PLAN");
  }
  const allowed = [
    "lawfulBasis",
    "contactIds",
    "maxProviders",
    "maxProbe",
    "attemptId",
  ];
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw new EnrichmentSafetyError("INVALID_PLAN");
  }
  const row = closedSafetyRecord(value, keys as string[]);
  if (!isValidLawfulBasis(row.lawfulBasis as LawfulBasis | undefined)) {
    throw new ForbiddenException({
      error: {
        code: "CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED",
        message:
          "an explicit lawful basis is required for external contact enrichment",
      },
    });
  }
  const lawfulBasis = row.lawfulBasis as LawfulBasis;
  for (const text of [lawfulBasis.ref, lawfulBasis.note, row.attemptId]) {
    if (
      text !== undefined &&
      (typeof text !== "string" ||
        text.length > 4096 ||
        Array.from(text).some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        ))
    ) {
      throw new EnrichmentSafetyError("INVALID_PLAN");
    }
  }
  const contactIds =
    row.contactIds === undefined
      ? undefined
      : denseSafetyArray(row.contactIds, 10).map((id) => {
          if (!isCanonicalArtifactUuid(id)) {
            throw new EnrichmentSafetyError("INVALID_PLAN");
          }
          return id;
        });
  if (contactIds && new Set(contactIds).size !== contactIds.length) {
    throw new EnrichmentSafetyError("INVALID_PLAN");
  }
  return {
    lawfulBasis: {
      basis: lawfulBasis.basis,
      ...(lawfulBasis.ref === undefined ? {} : { ref: lawfulBasis.ref }),
      ...(lawfulBasis.note === undefined ? {} : { note: lawfulBasis.note }),
    },
    ...(contactIds === undefined ? {} : { contactIds: [...contactIds].sort() }),
    ...(row.maxProviders === undefined
      ? {}
      : { maxProviders: safetyInteger(row.maxProviders, 1, 3) }),
    ...(row.maxProbe === undefined
      ? {}
      : { maxProbe: safetyInteger(row.maxProbe, 1, 6) }),
    ...(row.attemptId === undefined ? {} : { attemptId: row.attemptId as string }),
  };
}

/**
 * Contact enrichment executor used when `LEGACY_EXECUTION_BUDGET_MODE=bypass`.
 * Runs the direct `enrichCompanyContacts` waterfall with stateless per-request
 * technical limits, provider/source_policy gates, suppression/DSR checks, and
 * lawful-basis enforcement without touching legacy `execution_budget_authority`
 * or `tool_budget_account`/`tool_budget_operation` DB locks. Historical read-only
 * execution views remain readable through `EnrichmentExecutionQueryRepository`.
 */
export function createBypassContactEnrichmentSafetyExecutor(deps: {
  readonly prisma: ContactEnrichmentPreparationDeps["prisma"];
  readonly env?: NodeJS.ProcessEnv;
  readonly broker: ExecutionBroker;
  readonly runWaterfall?: typeof enrichCompanyContacts;
}): SafetyResultsPort {
  const env = deps.env ?? process.env;
  const runWaterfall = deps.runWaterfall ?? enrichCompanyContacts;
  const query = new EnrichmentExecutionQueryRepository(deps.prisma);
  const resultsAdapters: ContactEnrichmentResultsAdapterDeps = {
    database: deps.prisma,
    loadById: (scope, id) => query.loadById(scope, id),
    loadByRef: (scope, operationRef) => query.loadByRef(scope, operationRef),
  };

  const notAdmitted = (
    companyId: string,
    tier: "A" | "B",
    reasonCode: string,
  ): ContactEnrichmentSafetyResult => ({
    companyId,
    tier,
    attempted: 0,
    costMicrousd: 0,
    deadlineHit: false,
    results: [],
    admission: "NOT_ADMITTED",
    reasonCode,
    qualityCoverage: "PREREQUISITE_ONLY",
  });

  const executeDirect = async (params: {
    workspaceId: string;
    companyId: string;
    accountKey: string;
    actorId: string;
    lawfulBasis: LawfulBasis;
    runId?: string;
    contactIds?: string[];
    maxProviders?: number;
    maxProbe?: number;
  }): Promise<ContactEnrichmentSafetyResult> => {
    const primary = resolveConfiguredFinderProviders(env);
    const tail = resolveConfiguredTailFinderProviders(env);
    const tier = await loadCompanyContactEnrichmentTier(
      deps.prisma,
      { workspaceId: params.workspaceId, companyId: params.companyId },
      tail.length > 0,
    );
    const reachable = reachableContactEnrichmentFinders(primary, tail, tier);
    if (reachable.length === 0) {
      return notAdmitted(params.companyId, tier, "NO_CONFIGURED_FINDER");
    }
    let enabledCount = 0;
    for (const finder of reachable) {
      if ((await checkProviderGates(deps.prisma, finder)).ok) enabledCount += 1;
    }
    if (enabledCount === 0) {
      return notAdmitted(params.companyId, tier, "NO_ENABLED_FINDER");
    }
    const verifiers = await gateConfiguredVerificationProviders(
      deps.prisma,
      env,
      deps.broker,
    );
    const result = await runWaterfall(
      {
        prisma: deps.prisma,
        ownerPrisma: deps.prisma,
        finders: primary,
        ...(tail.length > 0 ? { tailFinders: tail } : {}),
        verifiers,
        verificationBroker: deps.broker,
        circuits: new PrismaCircuitBreakerStore(deps.prisma),
        actorId: params.actorId,
      },
      {
        workspaceId: params.workspaceId,
        companyId: params.companyId,
        ...(params.contactIds === undefined
          ? {}
          : { contactIds: params.contactIds }),
        lawfulBasis: params.lawfulBasis,
        ...(params.runId === undefined ? {} : { runId: params.runId }),
        accountKey: params.accountKey,
        ...(params.maxProviders === undefined
          ? {}
          : { maxProvidersPerContact: params.maxProviders }),
        ...(params.maxProbe === undefined
          ? {}
          : { maxVerificationCalls: params.maxProbe }),
      },
    );
    if (result.skipped === "no_domain") {
      return {
        ...result,
        admission: "NOT_ADMITTED",
        reasonCode: "NO_DOMAIN",
        qualityCoverage: "PREREQUISITE_ONLY",
      };
    }
    if (result.skipped === "no_contacts") {
      return {
        ...result,
        admission: "NOT_ADMITTED",
        reasonCode: "NO_CONTACTS",
        qualityCoverage: "PREREQUISITE_ONLY",
      };
    }
    return {
      ...result,
      admission: "ADMITTED",
      qualityCoverage: "PREREQUISITE_ONLY",
    };
  };

  return {
    executeHttp: async (context, companyId, options) => {
      assertBypassSafetyAddress(context.workspaceId, companyId);
      const normalized = normalizeBypassHttpOptions(options);
      const scope = enrichContactsExecutionBudgetRequestScope(companyId, {
        attemptId: normalized.attemptId,
      });
      const accountKey = [
        "contact.enrich",
        scope.subjectType,
        scope.subjectId,
        scope.requestSha256,
      ].join(":");
      return executeDirect({
        workspaceId: context.workspaceId,
        companyId,
        accountKey,
        actorId: context.userId,
        lawfulBasis: normalized.lawfulBasis!,
        ...(normalized.contactIds === undefined
          ? {}
          : { contactIds: normalized.contactIds }),
        ...(normalized.maxProviders === undefined
          ? {}
          : { maxProviders: normalized.maxProviders }),
        ...(normalized.maxProbe === undefined
          ? {}
          : { maxProbe: normalized.maxProbe }),
      });
    },
    executeRun: async (input) => {
      assertBypassSafetyAddress(input.workspaceId, input.companyId);
      if (!isCanonicalArtifactUuid(input.businessRunId)) {
        throw new EnrichmentSafetyError("INVALID_PLAN");
      }
      const binding = parseExecutionBudgetBinding(input.binding, {
        scopeKey: input.workspaceId,
        purpose: "discovery.run",
        subjectType: "discovery_run",
      });
      const normalized = normalizeBypassHttpOptions({
        lawfulBasis: input.lawfulBasis,
      });
      return executeDirect({
        workspaceId: input.workspaceId,
        companyId: input.companyId,
        accountKey: binding.accountKey,
        actorId: input.actorId,
        lawfulBasis: normalized.lawfulBasis!,
        runId: input.businessRunId,
      });
    },
    listEnrichmentExecutions: async (context, companyId, parsed) => {
      assertBypassSafetyAddress(context.workspaceId, companyId);
      return listContactEnrichmentResults(
        resultsAdapters,
        context,
        companyId,
        parsed,
      );
    },
    readEnrichmentExecution: async (context, companyId, operationRef) => {
      assertBypassSafetyAddress(context.workspaceId, companyId, operationRef);
      return readContactEnrichmentResult(
        resultsAdapters,
        context,
        companyId,
        operationRef,
      );
    },
    listEnrichmentQualityFacts: async (context, companyId, parsed) => {
      assertBypassSafetyAddress(context.workspaceId, companyId);
      return listContactEnrichmentQualityFacts(
        resultsAdapters,
        context,
        companyId,
        parsed,
      );
    },
    readEnrichmentQualityFacts: async (context, companyId, operationRef) => {
      assertBypassSafetyAddress(context.workspaceId, companyId, operationRef);
      return readContactEnrichmentQualityFacts(
        resultsAdapters,
        context,
        companyId,
        operationRef,
      );
    },
    recoverEnrichmentExecution: async (context, companyId, operationRef) => {
      assertBypassSafetyAddress(context.workspaceId, companyId, operationRef);
      const scopes = new Set(context.scopes ?? []);
      if (
        !["acquisition:write", "contact-discovery:read", "compliance:manage"].every(
          (scope) => scopes.has(scope as never),
        )
      ) {
        throw new ForbiddenException(
          "contact enrichment recovery scope required",
        );
      }
      return readContactEnrichmentResult(
        resultsAdapters,
        context,
        companyId,
        operationRef,
      );
    },
  };
}
