import { ToolBroker } from "../src/tools/tool-broker";
import { ToolRegistry } from "../src/tools/tool-registry";
import {
  brazilPncpSearchTool,
  franceCompanySearchTool,
  nppesSearchTool,
  singaporeGebizSearchTool,
  ukContractsFinderSearchTool,
  ukFtsSearchTool,
  usaSpendingSearchTool,
  worldBankProcurementTool,
} from "../src/tools/source-tools";
import {
  FranceOfficialOrganizationDiscoveryProvider,
  NppesOrganizationDiscoveryProvider,
} from "../src/discovery/providers/official-organization.providers";
import {
  BrazilPncpDiscoveryProvider,
  SingaporeGebizDiscoveryProvider,
  UkContractsFinderDiscoveryProvider,
  UkFindATenderDiscoveryProvider,
  UsaSpendingAwardsDiscoveryProvider,
  WorldBankProcurementDiscoveryProvider,
} from "../src/discovery/providers/public-procurement.providers";
import type {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
} from "../src/discovery/provider-contract";

const LIVE_DIAGNOSTIC_FLAG = "--allow-live-adapter-diagnostic";
const PROVIDER_ARGUMENT_PREFIX = "--provider=";
const AUTHORIZATION_ENVIRONMENT_KEY =
  "PUBLIC_ACQUISITION_ADAPTER_DIAGNOSTIC_AUTHORIZATION";
const AUTHORIZATION_CONFIRMATION =
  "I_UNDERSTAND_THIS_IS_ADAPTER_ONLY_AND_MAKES_LIVE_REQUESTS";
const SCOPE =
  "live adapter invocation and response parsing only; this script bypasses database routing and persistence";
const NEVER_PROVES = [
  "database Provider status or database SourcePolicy authorization",
  "RawSourceRecord persistence",
  "Identity Resolver or Canonical Company persistence",
  "Evidence, Signal, Lead or LeadQualifiedPackage persistence",
  "quality-ledger accounting or replay idempotency",
  "sustained API, Worker or Outbox Relay operation",
  "production readiness, SaaS delivery or commercial conversion",
] as const;
const PERSISTENT_ACCEPTANCE_SCRIPT =
  "apps/api/scripts/verify-world-bank-procurement-persistent-funnel.mts";

type DiagnosticCase = {
  provider: CompanyDiscoveryAdapter;
  query: CompanyDiscoveryQuery;
};

type Authorization = {
  authorized: boolean;
  environment: string;
  requestedProvider?: string;
  reason?: string;
};

const environment = (
  process.env.APP_ENVIRONMENT ??
  process.env.NODE_ENV ??
  "development"
).toLocaleLowerCase("en-US");
const requestedProviders = process.argv
  .filter((argument) => argument.startsWith(PROVIDER_ARGUMENT_PREFIX))
  .map((argument) => argument.slice(PROVIDER_ARGUMENT_PREFIX.length).trim())
  .filter(Boolean);
const requestedProvider =
  requestedProviders.length === 1 ? requestedProviders[0] : undefined;
const authorization = authorize({
  environment,
  requestedProvider,
  requestedProviderCount: requestedProviders.length,
});

if (!authorization.authorized) {
  process.stderr.write(
    `${JSON.stringify(
      {
        verdict: "BLOCKED",
        scope: SCOPE,
        neverProves: NEVER_PROVES,
        persistentAcceptance: PERSISTENT_ACCEPTANCE_SCRIPT,
        authorization: {
          environment: authorization.environment,
          requestedProvider: authorization.requestedProvider ?? null,
          reason: authorization.reason,
          requiredInvocation: `${AUTHORIZATION_ENVIRONMENT_KEY}=${AUTHORIZATION_CONFIRMATION} ... ${LIVE_DIAGNOSTIC_FLAG} ${PROVIDER_ARGUMENT_PREFIX}<provider-key>`,
        },
        results: [],
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
} else {
  await runAuthorizedDiagnostic(requestedProvider!);
}

function authorize(input: {
  environment: string;
  requestedProvider?: string;
  requestedProviderCount: number;
}): Authorization {
  if (!process.argv.includes(LIVE_DIAGNOSTIC_FLAG)) {
    return {
      authorized: false,
      environment: input.environment,
      requestedProvider: input.requestedProvider,
      reason: "missing per-invocation live diagnostic flag",
    };
  }
  if (
    process.env[AUTHORIZATION_ENVIRONMENT_KEY] !== AUTHORIZATION_CONFIRMATION
  ) {
    return {
      authorized: false,
      environment: input.environment,
      requestedProvider: input.requestedProvider,
      reason: "missing exact local live-request confirmation",
    };
  }
  if (
    process.env.CI?.toLocaleLowerCase("en-US") === "true" ||
    ["production", "staging"].includes(input.environment)
  ) {
    return {
      authorized: false,
      environment: input.environment,
      requestedProvider: input.requestedProvider,
      reason:
        "live adapter diagnostics are local-only and forbidden in CI, staging and production",
    };
  }
  if (input.requestedProviderCount !== 1 || !input.requestedProvider) {
    return {
      authorized: false,
      environment: input.environment,
      reason: "exactly one provider must be selected for this invocation",
    };
  }
  return {
    authorized: true,
    environment: input.environment,
    requestedProvider: input.requestedProvider,
  };
}

async function runAuthorizedDiagnostic(providerKey: string): Promise<void> {
  const registry = new ToolRegistry();
  for (const tool of [
    franceCompanySearchTool,
    nppesSearchTool,
    worldBankProcurementTool,
    usaSpendingSearchTool,
    ukFtsSearchTool,
    brazilPncpSearchTool,
    singaporeGebizSearchTool,
    ukContractsFinderSearchTool,
  ])
    registry.register(tool);

  // This is intentionally not the database SourcePolicy. The report names that
  // limitation so this diagnostic cannot be used as persistent-funnel evidence.
  const diagnosticAllowedDomains = new Set([
    "recherche-entreprises.api.gouv.fr",
    "npiregistry.cms.hhs.gov",
    "search.worldbank.org",
    "api.usaspending.gov",
    "www.find-tender.service.gov.uk",
    "pncp.gov.br",
    "data.gov.sg",
    "www.contractsfinder.service.gov.uk",
  ]);
  const broker = new ToolBroker({
    registry,
    sourcePolicyReader: async (domain) =>
      diagnosticAllowedDomains.has(domain)
        ? { suspended: false, allowedPurpose: ["discovery"] }
        : null,
  });

  const diagnostics = buildDiagnosticCases(broker);
  const selected = diagnostics.find(
    (item) => item.provider.key === providerKey,
  );
  if (!selected) {
    process.stderr.write(
      `${JSON.stringify(
        {
          verdict: "BLOCKED",
          scope: SCOPE,
          neverProves: NEVER_PROVES,
          persistentAcceptance: PERSISTENT_ACCEPTANCE_SCRIPT,
          authorization: {
            environment,
            requestedProvider: providerKey,
            reason: "unknown provider; no adapter was called",
            allowedProviders: diagnostics.map((item) => item.provider.key),
          },
          results: [],
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  let result: Record<string, unknown>;
  try {
    const observation = await selected.provider.discoverCompanies(
      selected.query,
      {
        workspaceId: "platform",
        runId: `public-channel-adapter-diagnostic:${selected.provider.key}`,
      },
    );
    result = {
      provider: selected.provider.key,
      observation:
        observation.records.length > 0
          ? "ADAPTER_RECORDS_OBSERVED"
          : "ADAPTER_ZERO_RECORDS_OBSERVED",
      recordCount: observation.records.length,
      roles: [
        ...new Set(
          observation.records
            .map((record) => record.attributes?.source_role)
            .filter(Boolean),
        ),
      ],
      provenance: observation.records[0]?.provenance ?? null,
    };
  } catch (error) {
    result = {
      provider: selected.provider.key,
      observation: "ADAPTER_ERROR_OBSERVED",
      error:
        error instanceof Error
          ? `${error.name}:${error.message}`.slice(0, 300)
          : "UNKNOWN_ERROR",
    };
    process.exitCode = 1;
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        verdict: "ADAPTER_DIAGNOSTIC_ONLY",
        scope: SCOPE,
        neverProves: NEVER_PROVES,
        persistentAcceptance: PERSISTENT_ACCEPTANCE_SCRIPT,
        policyMode:
          "in-memory diagnostic allowlist; database Provider status and SourcePolicy were not checked",
        verifiedAt: new Date().toISOString(),
        results: [result],
      },
      null,
      2,
    )}\n`,
  );
}

function buildDiagnosticCases(broker: ToolBroker): DiagnosticCase[] {
  return [
    {
      provider: new FranceOfficialOrganizationDiscoveryProvider({ broker }),
      query: {
        sourceClass: "company_registry",
        filters: { country: "FR" },
        keywords: ["Schneider Electric"],
        limit: 5,
      },
    },
    {
      provider: new NppesOrganizationDiscoveryProvider({ broker }),
      query: {
        sourceClass: "company_registry",
        filters: { country: "US", healthcare: true, state: "MN" },
        keywords: ["Mayo Clinic"],
        limit: 5,
      },
    },
    {
      provider: new WorldBankProcurementDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "world_bank_procurement",
          country: "Kenya",
          procurement_role: "buyer",
        },
        keywords: ["water pump"],
        limit: 5,
      },
    },
    {
      provider: new UsaSpendingAwardsDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "usaspending_awards",
          country: "US",
          procurement_role: "buyer",
          since_days: 730,
        },
        keywords: ["industrial pump"],
        limit: 5,
      },
    },
    {
      provider: new UkFindATenderDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "uk_find_a_tender",
          country: "GB",
          procurement_role: "buyer",
          since_days: 30,
        },
        keywords: ["maintenance"],
        limit: 5,
      },
    },
    {
      provider: new BrazilPncpDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "brazil_pncp",
          country: "BR",
          procurement_role: "buyer",
        },
        keywords: ["serviço"],
        limit: 5,
      },
    },
    {
      provider: new SingaporeGebizDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "singapore_gebiz",
          country: "SG",
          procurement_role: "supplier",
        },
        keywords: ["pump"],
        limit: 5,
      },
    },
    {
      provider: new UkContractsFinderDiscoveryProvider({ broker }),
      query: {
        sourceClass: "public_intelligence",
        filters: {
          source_hint: "uk_contracts_finder",
          country: "GB",
          procurement_role: "buyer",
          since_days: 30,
        },
        keywords: ["maintenance"],
        limit: 5,
      },
    },
  ];
}
