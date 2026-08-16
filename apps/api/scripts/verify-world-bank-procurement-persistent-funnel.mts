/**
 * 官方获客渠道真实持久化验收。
 * 支持 world_bank / france / usaspending / nppes / ror / wikidata / uk_fts /
 * uk_contracts_finder / brazil_pncp / singapore_gebiz / sec_edgar /
 * mexico_denue。
 *
 * 创建一个随机隔离 workspace 和 ICP，通过真实 Temporal Worker 执行：
 * 官方 API -> RawSourceRecord -> IdentityLink/强标识 -> CanonicalCompany -> Lead。
 * 实验数据故意保留，便于事后审计；脚本不提交、不推送，也不触碰其他 workspace。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { ModelProviderRegistry } from "../src/model-gateway/model-provider.registry";
import { ModelRouter } from "../src/model-gateway/model-router";
import { RouterModelGateway } from "../src/model-gateway/router-model-gateway";
import { StubModelProvider } from "../src/model-gateway/providers/stub-model.provider";
import { createDiscoveryActivities } from "../src/temporal/discovery.activities";
import { DiscoveryProviderRegistry } from "../src/discovery/provider.registry";
import {
  buildToolBroker,
  providerStatusReaderFrom,
  sourcePolicyReaderFrom,
} from "../src/tools/tool-broker.factory";
import { DISCOVERY_WORKFLOW } from "../src/temporal/understanding.constants";
import {
  acquisitionReplayEvidence,
  brazilPncpAuthorityEvidenceIsConsistent,
  brazilPncpCanaryExpectation,
  brazilPncpCanaryOverrides,
  brazilPncpPaginationEvidence,
  contractsFinderCanaryExpectation,
  contractsFinderCanaryOverrides,
  contractsFinderPaginationEvidence,
  matchesContractsFinderLocation,
  providerQualityRows,
  readBrazilPncpCanaryEvidence,
  readMexicoDenueCanaryEvidence,
  readEuEcolabelCanaryEvidence,
  readRorCanaryEvidence,
  readSecEdgarCanaryEvidence,
  secEdgarQualityCanPass,
  readUsaSpendingCanaryEvidence,
  readUkProcurementCanaryEvidence,
  readWorldBankCanaryEvidence,
  runCanaryCleanup,
  SUPPORTED_PERSISTENT_ACQUISITION_CANARIES,
  usaSpendingCanaryExpectation,
  usaSpendingCanaryOverrides,
  usaSpendingPaginationEvidence,
  usaSpendingPositiveQualityCanPass,
  worldBankCanaryExpectation,
  worldBankCanaryOverrides,
  worldBankCanaryTriggerSignals,
  worldBankPaginationEvidence,
  worldBankPositiveQualityCanPass,
  worldBankPositiveRunCanPass,
  worldBankRunStatusIsTruthful,
  zeroResultQualityCanPass,
} from "./verify-world-bank-procurement-persistent-funnel.support";

for (const line of readFileSync(
  new URL("../.env", import.meta.url),
  "utf8",
).split("\n")) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  if (match && !line.trimStart().startsWith("#")) {
    process.env[match[1]] ??= match[2].replace(/^["']|["']$/gu, "");
  }
}

// Local acceptance may intentionally use one non-owner connection. This keeps
// an unrelated/stale DATABASE_URL from the repository .env from overriding the
// explicitly supplied RLS-enforced APP_DATABASE_URL.
const databaseUrl =
  process.env.ACQUISITION_CANARY_APP_ONLY === "true"
    ? undefined
    : process.env.DATABASE_URL;
const appDatabaseUrl = process.env.APP_DATABASE_URL;
const temporalAddress = process.env.TEMPORAL_ADDRESS;
if (!appDatabaseUrl || !temporalAddress) {
  throw new Error("APP_DATABASE_URL and TEMPORAL_ADDRESS are required");
}

const canaryName = process.env.ACQUISITION_CANARY ?? "world_bank";
const canaryCaseId = process.env.ACQUISITION_CANARY_CASE_ID;
const { region: contractsFinderRegion, keyword: contractsFinderKeyword } =
  contractsFinderCanaryOverrides(process.env);
const contractsFinderExpectation = contractsFinderCanaryExpectation(
  process.env.ACQUISITION_CANARY_EXPECT,
);
const contractsFinderRequirePagination =
  process.env.ACQUISITION_CANARY_REQUIRE_PAGINATION === "true";
const {
  country: worldBankCountry,
  keyword: worldBankKeyword,
  limit: worldBankLimit,
} = worldBankCanaryOverrides(process.env);
const worldBankExpectation = worldBankCanaryExpectation(
  process.env.ACQUISITION_CANARY_EXPECT,
);
const {
  keyword: usaSpendingKeyword,
  sinceDays: usaSpendingSinceDays,
  limit: usaSpendingLimit,
} = usaSpendingCanaryOverrides(process.env);
const usaSpendingExpectation = usaSpendingCanaryExpectation(
  process.env.ACQUISITION_CANARY_EXPECT,
);
const {
  keyword: brazilPncpKeyword,
  state: brazilPncpState,
  limit: brazilPncpLimit,
} = brazilPncpCanaryOverrides(process.env);
const brazilPncpExpectation = brazilPncpCanaryExpectation(
  process.env.ACQUISITION_CANARY_EXPECT,
);
const mexicoDenueOrganizationName = (
  process.env.ACQUISITION_CANARY_ORGANIZATION_NAME ?? "NISSAN MEXICANA"
)
  .normalize("NFKC")
  .trim()
  .replaceAll(/\s+/gu, " ");
const mexicoDenueStateCode = (
  process.env.ACQUISITION_CANARY_STATE_CODE ?? "01"
).trim();
const mexicoDenueLimit = Number(process.env.ACQUISITION_CANARY_LIMIT ?? "5");
const PROVIDER_TOGGLE_LOCK_ID = 8_132_026_001;
const temporarilyEnabledCanaries = new Set([
  "usaspending",
  "uk_contracts_finder",
  "brazil_pncp",
  "ror",
  "sec_edgar",
  "mexico_denue",
  "eu_ecolabel",
]);
const providerPreEnabled =
  process.env.ACQUISITION_CANARY_PROVIDER_PRE_ENABLED === "true";
const verifyReplay = process.env.ACQUISITION_CANARY_VERIFY_REPLAY === "true";

if (["sec_edgar", "mexico_denue"].includes(canaryName) && !verifyReplay) {
  throw new Error(
    `${canaryName.toLocaleUpperCase("en-US")}_CANARY_REPLAY_REQUIRED`,
  );
}

if (temporarilyEnabledCanaries.has(canaryName)) {
  if (!databaseUrl && !providerPreEnabled) {
    throw new Error(
      `${canaryName} temporary provider toggle requires DATABASE_URL or explicit pre-enabled mode`,
    );
  }
  if (databaseUrl && providerPreEnabled) {
    throw new Error(
      "pre-enabled provider mode requires ACQUISITION_CANARY_APP_ONLY=true",
    );
  }
  const ownerUrl = new URL(databaseUrl ?? appDatabaseUrl);
  const tenantUrl = new URL(appDatabaseUrl);
  const environment = (
    process.env.APP_ENVIRONMENT ?? "development"
  ).toLocaleLowerCase("en-US");
  const localHost = (host: string) =>
    host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (
    process.env.ACQUISITION_CANARY_ALLOW_TEMPORARY_PROVIDER_ENABLE !== "true" ||
    ["production", "staging"].includes(environment) ||
    !localHost(ownerUrl.hostname) ||
    !localHost(tenantUrl.hostname) ||
    ownerUrl.host !== tenantUrl.host ||
    ownerUrl.pathname !== tenantUrl.pathname ||
    !/(?:acceptance|experiment|test)$/u.test(ownerUrl.pathname)
  ) {
    throw new Error(
      `${canaryName} canary may temporarily enable the provider only on an explicitly authorized local acceptance/test database`,
    );
  }
}
const canary =
  canaryName === "france"
    ? {
        key: "fr_company",
        label: "France official organization",
        workspaceLabel: "France official organization canary",
        sellerIndustry: "industrial electrical equipment",
        icpName: "French industrial electrical organizations",
        companyAttributes: {
          industry: "industrial electrical equipment",
          organizationRole: "organization",
        },
        painPoints: ["industrial electrification", "energy management"],
        triggerSignals: ["official registry presence"],
        valueProps: ["industrial electrical equipment"],
        targetMarkets: ["France"],
        query: {
          source_class: "company_registry",
          filters: { source_hint: "fr_company", country: "FR" },
          keywords: ["Schneider Electric"],
          priority: 1,
          limit: 10,
        },
        officialUrlPrefix: "https://recherche-entreprises.api.gouv.fr/search",
        requiredIdentifierScheme: "siren",
      }
    : canaryName === "nppes"
      ? {
          key: "nppes",
          label: "NPPES US healthcare organizations",
          workspaceLabel: "NPPES healthcare organization canary",
          sellerIndustry: "healthcare equipment",
          icpName: "United States healthcare organizations",
          companyAttributes: {
            industry: "healthcare",
            organizationRole: "organization",
          },
          painPoints: ["clinical operations", "facility equipment"],
          triggerSignals: ["official NPI-2 registry presence"],
          valueProps: ["healthcare equipment"],
          targetMarkets: ["United States"],
          query: {
            source_class: "company_registry",
            filters: {
              source_hint: "nppes",
              country: "US",
              healthcare: true,
              npi: "1881018208",
            },
            keywords: [],
            priority: 1,
            limit: 1,
          },
          officialUrlPrefix: "https://npiregistry.cms.hhs.gov/api/",
          requiredIdentifierScheme: "us_npi",
        }
      : canaryName === "ror"
        ? {
            key: "ror",
            label: "ROR active research organization",
            workspaceLabel: "ROR organization canary",
            sellerIndustry: "research infrastructure",
            icpName: "United Kingdom research organizations",
            companyAttributes: {
              industry: "research and education",
              organizationRole: "organization",
            },
            painPoints: ["research infrastructure", "institutional operations"],
            triggerSignals: ["active ROR registry presence"],
            valueProps: ["research infrastructure equipment"],
            targetMarkets: ["United Kingdom"],
            query: {
              source_class: "company_registry",
              filters: {
                source_hint: "ror",
                country: "GB",
                organization_types: ["education"],
              },
              keywords: ["052gg0110"],
              priority: 1,
              limit: 1,
            },
            officialUrlPrefix: "https://api.ror.org/v2/organizations",
            requiredIdentifierScheme: "ror-id",
          }
        : canaryName === "sec_edgar"
          ? {
              key: "sec_edgar",
              label: "SEC EDGAR exchange-directory filer",
              workspaceLabel: "SEC EDGAR filer canary",
              sellerIndustry: "enterprise technology equipment",
              icpName: "SEC exchange-directory technology filers",
              companyAttributes: {
                industry: "technology",
                organizationRole: "organization",
              },
              painPoints: [
                "enterprise infrastructure",
                "operational modernization",
              ],
              triggerSignals: ["SEC exchange-directory presence"],
              valueProps: ["enterprise technology equipment"],
              targetMarkets: ["United States securities market"],
              query: {
                source_class: "company_registry",
                filters: { source_hint: "sec_edgar", ticker: "AAPL" },
                keywords: [],
                priority: 1,
                limit: 1,
              },
              officialUrlPrefix:
                "https://www.sec.gov/files/company_tickers_exchange.json",
              requiredIdentifierScheme: "cik",
            }
          : canaryName === "mexico_denue"
            ? {
                key: "mexico_denue",
                label: "Mexico DENUE exact-name organization establishment",
                workspaceLabel: "Mexico DENUE organization canary",
                sellerIndustry: "industrial equipment",
                icpName: "Mexico industrial organizations",
                companyAttributes: {
                  industry: "industrial manufacturing",
                  organizationRole: "organization",
                },
                painPoints: [
                  "industrial operations",
                  "equipment modernization",
                ],
                triggerSignals: ["official DENUE establishment presence"],
                valueProps: ["industrial equipment"],
                targetMarkets: ["Mexico"],
                query: {
                  source_class: "company_registry",
                  filters: {
                    source_hint: "mexico_denue",
                    country: "MX",
                    state_code: mexicoDenueStateCode,
                    organization_name: mexicoDenueOrganizationName,
                  },
                  keywords: [],
                  priority: 1,
                  limit: mexicoDenueLimit,
                },
                officialUrlPrefix:
                  "https://www.inegi.org.mx/app/api/denue/v1/consulta/Nombre/",
                requiredIdentifierScheme: null,
              }
            : canaryName === "eu_ecolabel"
              ? {
                  key: "eu_ecolabel",
                  label: "EU Ecolabel organization product-award evidence",
                  workspaceLabel: "EU Ecolabel organization canary",
                  sellerIndustry: "professional hygiene equipment",
                  icpName: "Austrian professional hygiene organizations",
                  companyAttributes: {
                    industry: "professional hygiene",
                    organizationRole: "organization",
                  },
                  painPoints: ["sustainable product certification"],
                  triggerSignals: ["official EU Ecolabel product award"],
                  valueProps: ["professional hygiene equipment"],
                  targetMarkets: ["Austria"],
                  query: {
                    source_class: "public_intelligence",
                    filters: {
                      source_hint: "eu_ecolabel",
                      country: "Austria",
                      organization_name:
                        "Hagleitner Hygiene International GmbH",
                    },
                    keywords: [],
                    priority: 1,
                    limit: 10,
                  },
                  officialUrlPrefix:
                    "https://apps.data.env.service.ec.europa.eu/dataquery/v2/ecolabel/products",
                  requiredIdentifierScheme: null,
                }
              : canaryName === "wikidata"
                ? {
                    key: "wikidata",
                    label: "Wikidata structured company discovery",
                    workspaceLabel: "Wikidata company discovery canary",
                    sellerIndustry: "industrial manufacturing equipment",
                    icpName: "German manufacturing organizations",
                    companyAttributes: {
                      industry: "manufacturing",
                      organizationRole: "organization",
                    },
                    painPoints: [
                      "production efficiency",
                      "industrial modernization",
                    ],
                    triggerSignals: ["structured industry classification"],
                    valueProps: ["industrial manufacturing equipment"],
                    targetMarkets: ["Germany"],
                    query: {
                      source_class: "company_registry",
                      filters: {
                        source_hint: "wikidata",
                        country: "Germany",
                        industry: "knife manufacturing",
                        _industryQids: ["Q1436188"],
                        _countryQid: "Q183",
                      },
                      keywords: ["knife"],
                      priority: 1,
                      limit: 1,
                    },
                    officialUrlPrefix: "https://www.wikidata.org/wiki/",
                    requiredIdentifierScheme: "wikidata-qid",
                  }
                : canaryName === "uk_fts"
                  ? {
                      key: "uk_find_a_tender",
                      label: "UK Find a Tender active buyer demand",
                      workspaceLabel: "UK Find a Tender buyer demand canary",
                      sellerIndustry: "industrial maintenance equipment",
                      icpName:
                        "United Kingdom public-sector maintenance buyers",
                      companyAttributes: {
                        industry: "public procurement",
                        organizationRole: "buyer",
                      },
                      painPoints: ["asset maintenance", "service continuity"],
                      triggerSignals: ["active public tender"],
                      valueProps: [
                        "industrial maintenance equipment",
                        "maintenance services",
                      ],
                      targetMarkets: ["United Kingdom"],
                      query: {
                        source_class: "public_intelligence",
                        filters: {
                          source_hint: "uk_find_a_tender",
                          country: "GB",
                          procurement_role: "buyer",
                          since_days: 30,
                        },
                        // Keep the live canary on a current first-page term. Narrow,
                        // product-specific terms are covered by deterministic
                        // pagination tests and can legitimately require several live
                        // pages, which makes a smoke canary needlessly timing-sensitive.
                        keywords: ["maintenance"],
                        priority: 1,
                        limit: 1,
                      },
                      officialUrlPrefix:
                        "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages",
                      requiredIdentifierScheme: null,
                    }
                  : canaryName === "uk_contracts_finder"
                    ? {
                        key: "uk_contracts_finder",
                        label: "UK Contracts Finder active buyer demand",
                        workspaceLabel:
                          "UK Contracts Finder buyer demand canary",
                        sellerIndustry: "industrial maintenance equipment",
                        icpName:
                          "United Kingdom public-sector maintenance buyers",
                        companyAttributes: {
                          industry: "public procurement",
                          organizationRole: "buyer",
                        },
                        painPoints: ["asset maintenance", "service continuity"],
                        triggerSignals: ["active public tender"],
                        valueProps: [
                          "industrial maintenance equipment",
                          "maintenance services",
                        ],
                        targetMarkets: ["United Kingdom"],
                        query: {
                          source_class: "public_intelligence",
                          filters: {
                            source_hint: "uk_contracts_finder",
                            country: "United Kingdom",
                            region: contractsFinderRegion,
                            procurement_role: "buyer",
                            since_days: 30,
                          },
                          keywords: [contractsFinderKeyword],
                          priority: 1,
                          limit: 1,
                        },
                        officialUrlPrefix:
                          "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search",
                        requiredIdentifierScheme: null,
                      }
                    : canaryName === "brazil_pncp"
                      ? {
                          key: "brazil_pncp",
                          label: "Brazil PNCP active buyer demand",
                          workspaceLabel: "Brazil PNCP buyer demand canary",
                          sellerIndustry: "industrial equipment",
                          icpName: "Brazil public-sector equipment buyers",
                          companyAttributes: {
                            industry: "public procurement",
                            organizationRole: "buyer",
                          },
                          painPoints: [
                            "equipment procurement",
                            "public service continuity",
                          ],
                          triggerSignals: ["open public procurement"],
                          valueProps: ["industrial equipment"],
                          targetMarkets: ["Brazil"],
                          query: {
                            source_class: "public_intelligence",
                            filters: {
                              source_hint: "brazil_pncp",
                              country: "BR",
                              procurement_role: "buyer",
                              ...(brazilPncpState
                                ? { state: brazilPncpState }
                                : {}),
                            },
                            keywords: [brazilPncpKeyword],
                            priority: 1,
                            limit: brazilPncpLimit,
                          },
                          officialUrlPrefix:
                            "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta",
                          requiredIdentifierScheme: null,
                        }
                      : canaryName === "singapore_gebiz"
                        ? {
                            key: "singapore_gebiz",
                            label:
                              "Singapore GeBIZ historical awarded suppliers",
                            workspaceLabel:
                              "Singapore GeBIZ supplier intelligence canary",
                            sellerIndustry: "industrial pumping equipment",
                            icpName:
                              "Singapore historical industrial equipment suppliers",
                            companyAttributes: {
                              industry: "industrial equipment",
                              organizationRole: "supplier",
                            },
                            painPoints: [
                              "public procurement delivery",
                              "equipment supply",
                            ],
                            triggerSignals: [
                              "historical public contract award",
                            ],
                            valueProps: ["industrial pumps"],
                            targetMarkets: ["Singapore"],
                            query: {
                              source_class: "public_intelligence",
                              filters: {
                                source_hint: "singapore_gebiz",
                                country: "SG",
                                procurement_role: "supplier",
                              },
                              keywords: ["pump"],
                              priority: 1,
                              limit: 10,
                            },
                            officialUrlPrefix:
                              "https://data.gov.sg/api/action/datastore_search",
                            requiredIdentifierScheme: null,
                          }
                        : canaryName === "usaspending"
                          ? {
                              key: "usaspending_awards",
                              label:
                                "USAspending federal awards buyer intelligence",
                              workspaceLabel: "USAspending awards canary",
                              sellerIndustry: "industrial pumping equipment",
                              icpName:
                                "United States federal industrial equipment buyers",
                              companyAttributes: {
                                industry: "public procurement",
                                organizationRole: "buyer",
                              },
                              painPoints: [
                                "industrial equipment maintenance",
                                "pump replacement",
                              ],
                              triggerSignals: [
                                "historical federal contract award",
                                "repeat federal procurement",
                              ],
                              valueProps: [
                                "industrial equipment",
                                "maintenance equipment",
                              ],
                              targetMarkets: ["United States"],
                              query: {
                                source_class: "public_intelligence",
                                filters: {
                                  source_hint: "usaspending_awards",
                                  country: "US",
                                  procurement_role: "buyer",
                                  since_days: usaSpendingSinceDays,
                                },
                                keywords: [usaSpendingKeyword],
                                priority: 1,
                                limit: usaSpendingLimit,
                              },
                              officialUrlPrefix:
                                "https://api.usaspending.gov/api/v2/search/spending_by_award/",
                              requiredIdentifierScheme: null,
                            }
                          : {
                              key: "world_bank_procurement",
                              label: "World Bank procurement",
                              workspaceLabel: "World Bank procurement canary",
                              sellerIndustry: "industrial water equipment",
                              icpName: `${worldBankCountry} public infrastructure buyers`,
                              companyAttributes: {
                                industry: "public water infrastructure",
                                organizationRole: "buyer",
                              },
                              painPoints: [
                                "water supply reliability",
                                "pump and treatment capacity",
                              ],
                              triggerSignals: worldBankCanaryTriggerSignals(),
                              valueProps: [
                                "industrial pumps",
                                "water treatment equipment",
                              ],
                              targetMarkets: [worldBankCountry],
                              query: {
                                source_class: "public_intelligence",
                                filters: {
                                  source_hint: "world_bank_procurement",
                                  country: worldBankCountry,
                                  procurement_role: "buyer",
                                },
                                keywords: [worldBankKeyword],
                                priority: 1,
                                limit: worldBankLimit,
                              },
                              officialUrlPrefix:
                                "https://search.worldbank.org/api/v2/procnotices",
                              requiredIdentifierScheme: null,
                            };
if (
  !(SUPPORTED_PERSISTENT_ACQUISITION_CANARIES as readonly string[]).includes(
    canaryName,
  )
) {
  throw new Error(`unsupported ACQUISITION_CANARY: ${canaryName}`);
}

const workspaceId = randomUUID();
const workflowId = `${canary.key}-canary-${workspaceId}`;
const canaryTaskQueue = `acquisition-canary-${workspaceId}`;
const appDb = new PrismaService();
const controlDb = new PrismaClient({
  datasourceUrl: databaseUrl ?? appDatabaseUrl,
});
let temporal: Connection | undefined;
let embeddedWorkerConnection: NativeConnection | undefined;
let providerToggleLockHeld = false;
let originalProviderStatus: string | undefined;
let retainedRunId: string | undefined;
let executionError: unknown;
let replayEvidence: unknown;
let secEdgarRelayEvidence: unknown;
let finalReport: Record<string, unknown> | undefined;

// Bind acceptance to the current source tree. Falling back to an arbitrary
// pre-existing dist bundle can make a green canary validate stale workflow code.
const workflowsPath = fileURLToPath(
  new URL("../src/temporal/workflows.ts", import.meta.url),
);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`acceptance failed: ${message}`);
}

const SEC_EDGAR_PROHIBITED_FIELDS = new Set([
  "address",
  "addresses",
  "country",
  "domain",
  "ein",
  "filings",
  "former_names",
  "formernames",
  "phone",
  "telephone",
  "website",
  "websites",
]);

function assertNoSecEdgarProhibitedFields(
  value: unknown,
  context: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecEdgarProhibitedFields(item, context);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    assert(
      !SEC_EDGAR_PROHIBITED_FIELDS.has(key.toLocaleLowerCase("en-US")),
      `${context} must not persist prohibited SEC field ${key}`,
    );
    assertNoSecEdgarProhibitedFields(nested, context);
  }
}

function exactJsonObject(
  value: unknown,
  expectedKeys: readonly string[],
  context: string,
): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${context} must be an object`,
  );
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...expectedKeys].sort();
  assert(
    isDeepStrictEqual(actual, expected),
    `${context} keys must match the exact allowlist`,
  );
  return value as Record<string, unknown>;
}

function isSafeDenueWebsite(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname.includes(".")
    );
  } catch {
    return false;
  }
}

function resolveRootCompanyId(
  companyId: string,
  mappings: readonly { sourceCompanyId: string; canonicalCompanyId: string }[],
): string {
  const bySource = new Map(
    mappings.map((mapping) => [
      mapping.sourceCompanyId,
      mapping.canonicalCompanyId,
    ]),
  );
  const visited = new Set<string>();
  let current = companyId;
  while (bySource.has(current)) {
    assert(
      !visited.has(current),
      "active canonical mapping must not contain a cycle",
    );
    visited.add(current);
    current = bySource.get(current)!;
  }
  return current;
}

await appDb.$connect();
await controlDb.$connect();

try {
  const appRole = await appDb.$queryRaw<
    { role: string; superuser: boolean; bypassrls: boolean }[]
  >`SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = current_user`;
  assert(
    appRole[0] && !appRole[0].superuser && !appRole[0].bypassrls,
    "app connection must enforce RLS",
  );

  if (temporarilyEnabledCanaries.has(canaryName)) {
    const lock = await controlDb.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${PROVIDER_TOGGLE_LOCK_ID}) AS locked
    `;
    assert(
      lock[0]?.locked,
      "another provider-toggle canary is already running",
    );
    providerToggleLockHeld = true;
  }
  let provider = await controlDb.dataProvider.findUnique({
    where: { key: canary.key },
  });
  originalProviderStatus = provider?.status;
  if (
    databaseUrl &&
    temporarilyEnabledCanaries.has(canaryName) &&
    provider?.status === "DISABLED"
  ) {
    provider = await controlDb.dataProvider.update({
      where: { key: canary.key },
      data: { status: "ENABLED" },
    });
  }
  assert(
    provider?.status === "ENABLED",
    `${canary.key} provider must be ENABLED`,
  );

  if (canaryName === "sec_edgar") {
    const secUserAgent = process.env.SEC_EDGAR_USER_AGENT?.trim();
    const monitoredEmail = secUserAgent?.match(
      /[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/iu,
    );
    assert(
      process.env.SEC_EDGAR_USER_AGENT_CONFIRMED_MONITORED === "true",
      "SEC canary requires an explicit monitored-contact confirmation",
    );
    assert(
      secUserAgent && secUserAgent.length <= 160 && monitoredEmail,
      "SEC canary requires a bounded organization User-Agent with a contact email",
    );
    const contactDomain = monitoredEmail[1]!.toLocaleLowerCase("en-US");
    assert(
      !["example.com", "example.net", "example.org"].includes(contactDomain) &&
        !/(?:^|\.)(?:example|invalid|test)$/u.test(contactDomain),
      "SEC canary contact must not use a reserved placeholder domain",
    );
    const secPolicies = await controlDb.sourcePolicy.findMany({
      where: { domain: { in: ["www.sec.gov", "data.sec.gov"] } },
      select: {
        domain: true,
        reviewStatus: true,
        personalData: true,
        allowedPurpose: true,
      },
    });
    const directoryPolicy = secPolicies.find(
      (policy) => policy.domain === "www.sec.gov",
    );
    const submissionsPolicy = secPolicies.find(
      (policy) => policy.domain === "data.sec.gov",
    );
    assert(
      directoryPolicy?.reviewStatus === "APPROVED" &&
        directoryPolicy.personalData === false &&
        Array.isArray(directoryPolicy.allowedPurpose) &&
        directoryPolicy.allowedPurpose.includes("discovery"),
      "SEC directory policy must be APPROVED for non-personal discovery",
    );
    assert(
      submissionsPolicy?.reviewStatus === "APPROVED" &&
        submissionsPolicy.personalData === true &&
        Array.isArray(submissionsPolicy.allowedPurpose) &&
        submissionsPolicy.allowedPurpose.includes("enrichment"),
      "SEC submissions policy must be APPROVED for personal-data-aware enrichment only",
    );
  }

  if (databaseUrl) {
    await controlDb.workspace.create({
      data: {
        id: workspaceId,
        name: `${canary.workspaceLabel} ${new Date().toISOString()}`,
      },
    });
  } else {
    await appDb.withWorkspace(workspaceId, (tx) =>
      tx.workspace.create({
        data: {
          id: workspaceId,
          name: `${canary.workspaceLabel} ${new Date().toISOString()}`,
        },
      }),
    );
  }

  const seeded = await appDb.withWorkspace(workspaceId, async (tx) => {
    const seller = await tx.companyProfile.create({
      data: {
        workspaceId,
        name: "Local Industrial Water Systems Seller",
        industry: canary.sellerIndustry,
      },
    });
    const icp = await tx.icpDefinition.create({
      data: {
        workspaceId,
        companyId: seller.id,
        name: canary.icpName,
        status: "ACTIVE",
        companyAttributes: canary.companyAttributes,
        painPoints: canary.painPoints,
        triggerSignals: canary.triggerSignals,
        valueProps: canary.valueProps,
        targetMarkets: canary.targetMarkets,
      },
    });
    const plan = await tx.discoveryQueryPlan.create({
      data: {
        workspaceId,
        icpId: icp.id,
        status: "READY",
        queries: [canary.query],
        estimatedVolume: canary.query.limit,
        estimatedCostCents: 0,
      },
    });
    const run = await tx.discoveryRun.create({
      data: { workspaceId, planId: plan.id, icpId: icp.id, status: "RUNNING" },
    });
    return {
      sellerId: seller.id,
      icpId: icp.id,
      planId: plan.id,
      runId: run.id,
    };
  });
  retainedRunId = seeded.runId;

  const aiBefore = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.aiTrace.count(),
  );
  const secSignalBefore =
    canaryName === "sec_edgar"
      ? {
          sourceSignals: await controlDb.sourceSignal.count({
            where: { providerKey: "sec_edgar" },
          }),
          signalIngests: await controlDb.signalIngest.count({
            where: { providerKey: "sec_edgar" },
          }),
        }
      : null;
  const modelProviders = new ModelProviderRegistry();
  modelProviders.register(new StubModelProvider());
  const modelGateway = new RouterModelGateway(new ModelRouter(modelProviders));
  const broker = buildToolBroker({
    sourcePolicyReader: sourcePolicyReaderFrom(appDb),
    providerStatusReader: providerStatusReaderFrom(appDb),
  });
  const providers = new DiscoveryProviderRegistry({
    gateway: modelGateway,
    broker,
    prisma: appDb,
  });
  const activities = createDiscoveryActivities({
    prisma: appDb,
    providers,
    gateway: modelGateway,
    broker,
  });
  embeddedWorkerConnection = await NativeConnection.connect({
    address: temporalAddress,
  });
  const embeddedWorker = await Worker.create({
    connection: embeddedWorkerConnection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    // A unique queue prevents this bounded worker from stealing unrelated
    // scheduled/relay work from the shared development queue.
    taskQueue: canaryTaskQueue,
    workflowsPath,
    activities,
  });
  temporal = await Connection.connect({ address: temporalAddress });
  const client = new Client({
    connection: temporal,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
  });
  await embeddedWorker.runUntil(async () => {
    const handle = await client.workflow.start(DISCOVERY_WORKFLOW, {
      taskQueue: canaryTaskQueue,
      workflowId,
      args: [
        {
          workspaceId,
          runId: seeded.runId,
          planId: seeded.planId,
          icpId: seeded.icpId,
        },
      ],
    });
    await handle.result();
  });

  const evidence = await appDb.withWorkspace(workspaceId, async (tx) => {
    const run = await tx.discoveryRun.findUniqueOrThrow({
      where: { id: seeded.runId },
    });
    const raw = await tx.rawSourceRecord.findMany({
      where: { runId: seeded.runId },
      orderBy: [{ sourceUrl: "asc" }, { externalId: "asc" }],
      select: {
        id: true,
        providerKey: true,
        sourceClass: true,
        externalId: true,
        sourceUrl: true,
        fetchedAt: true,
        contentHash: true,
        parserVersion: true,
        ingestKey: true,
        payloadHash: true,
        payloadBytes: true,
        ingestVersion: true,
        ingestStatus: true,
        dispositionCode: true,
        retentionDays: true,
        expiresAt: true,
        sourcePolicySnapshot: true,
        payload: true,
      },
    });
    const rawIds = raw.map((record) => record.id);
    const links = await tx.identityLink.findMany({
      where: { rawRecordId: { in: rawIds } },
      orderBy: { rawRecordId: "asc" },
      select: {
        rawRecordId: true,
        canonicalId: true,
        status: true,
        matchRule: true,
        resolverVersion: true,
      },
    });
    const canonicalIds = [...new Set(links.map((link) => link.canonicalId))];
    const activeAliasMappings = await tx.organizationCanonicalMapping.findMany({
      where: { sourceCompanyId: { in: canonicalIds }, status: "ACTIVE" },
      select: { sourceCompanyId: true, canonicalCompanyId: true },
    });
    const companies = await tx.canonicalCompany.findMany({
      where: { id: { in: canonicalIds } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        country: true,
        region: true,
        domain: true,
        status: true,
        dedupeKey: true,
      },
    });
    const leads = await tx.lead.findMany({
      where: { icpId: seeded.icpId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        canonicalCompanyId: true,
        status: true,
        fitVerdict: true,
        queue: true,
        totalScore: true,
      },
    });
    const quality = await tx.providerQualityRunContribution.findMany({
      where: { runId: seeded.runId },
      select: {
        providerKey: true,
        terminalStatus: true,
        attemptedCount: true,
        successCount: true,
        zeroResultCount: true,
        failureCount: true,
        failedRunCount: true,
        processedCount: true,
        rawCount: true,
        acceptedCount: true,
        boundCount: true,
        domainCount: true,
        authorityCount: true,
        conflictCount: true,
        duplicateCount: true,
      },
    });
    const identifiers = await tx.organizationIdentifier.findMany({
      where: { companyId: { in: canonicalIds } },
      orderBy: [{ scheme: "asc" }, { normalizedValue: "asc" }],
      select: {
        rawRecordId: true,
        companyId: true,
        scheme: true,
        jurisdiction: true,
        normalizedValue: true,
        authorityProviderKey: true,
        status: true,
        validatorVersion: true,
      },
    });
    const events = await tx.outboxEvent.findMany({
      where: { workspaceId },
      orderBy: { occurredAt: "asc" },
      select: {
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        publishedAt: true,
      },
    });
    const fieldEvidence = await tx.fieldEvidence.findMany({
      where: { rawRecordId: { in: rawIds } },
      orderBy: [{ rawRecordId: "asc" }, { field: "asc" }],
      select: {
        rawRecordId: true,
        entityId: true,
        entityType: true,
        field: true,
        value: true,
        providerKey: true,
        license: true,
        allowedActions: true,
        dataClass: true,
        fetchedAt: true,
      },
    });
    const canonicalFieldEvidence = await tx.fieldEvidence.findMany({
      where: { entityId: { in: canonicalIds } },
      orderBy: [{ entityId: "asc" }, { field: "asc" }],
      select: {
        rawRecordId: true,
        entityId: true,
        field: true,
        value: true,
        providerKey: true,
        license: true,
      },
    });
    return {
      run,
      raw,
      links,
      companies,
      activeAliasMappings,
      leads,
      quality,
      identifiers,
      events,
      fieldEvidence,
      canonicalFieldEvidence,
    };
  });

  const aiAfter = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.aiTrace.count(),
  );
  const secSignalAfter =
    canaryName === "sec_edgar"
      ? {
          sourceSignals: await controlDb.sourceSignal.count({
            where: { providerKey: "sec_edgar" },
          }),
          signalIngests: await controlDb.signalIngest.count({
            where: { providerKey: "sec_edgar" },
          }),
        }
      : null;
  const sourceUrls = [
    ...new Set(evidence.raw.map((record) => record.sourceUrl).filter(Boolean)),
  ];
  const acceptedRaw = evidence.raw.filter(
    (record) => record.ingestStatus === "ACCEPTED",
  );
  const activeLinks = evidence.links.filter((link) => link.status === "ACTIVE");
  const ukProcurementEvidence = ["uk_fts", "uk_contracts_finder"].includes(
    canaryName,
  )
    ? acceptedRaw.map((record) =>
        readUkProcurementCanaryEvidence(
          record.payload,
          canary.query.keywords,
          evidence.run.completedAt ?? new Date(),
        ),
      )
    : [];
  const brazilPncpEvidence =
    canaryName === "brazil_pncp"
      ? acceptedRaw.map((record) => ({
          rawRecordId: record.id,
          canonicalCompanyId: activeLinks.find(
            (link) => link.rawRecordId === record.id,
          )?.canonicalId,
          ...readBrazilPncpCanaryEvidence(
            record.payload,
            brazilPncpKeyword,
            evidence.run.completedAt ?? new Date(),
          ),
        }))
      : [];
  const rorEvidence =
    canaryName === "ror"
      ? acceptedRaw.map((record) => ({
          rawRecordId: record.id,
          canonicalCompanyId: activeLinks.find(
            (link) => link.rawRecordId === record.id,
          )?.canonicalId,
          ...readRorCanaryEvidence(record.payload),
        }))
      : [];
  const mexicoDenueEvidence =
    canaryName === "mexico_denue"
      ? acceptedRaw.map((record) => ({
          rawRecordId: record.id,
          canonicalCompanyId: activeLinks.find(
            (link) => link.rawRecordId === record.id,
          )?.canonicalId,
          ...readMexicoDenueCanaryEvidence(record.payload),
        }))
      : [];
  const euEcolabelEvidence =
    canaryName === "eu_ecolabel"
      ? acceptedRaw.map((record) => ({
          rawRecordId: record.id,
          canonicalCompanyId: activeLinks.find(
            (link) => link.rawRecordId === record.id,
          )?.canonicalId,
          ...readEuEcolabelCanaryEvidence(record.payload),
        }))
      : [];
  const secDirectoryRaw =
    canaryName === "sec_edgar"
      ? acceptedRaw.filter(
          (record) =>
            record.parserVersion === "sec-edgar-company-tickers-exchange/1",
        )
      : [];
  const secSubmissionRaw =
    canaryName === "sec_edgar"
      ? acceptedRaw.filter(
          (record) => record.parserVersion === "sec-edgar-submissions/2",
        )
      : [];
  const secEdgarEvidence =
    canaryName === "sec_edgar"
      ? secDirectoryRaw.map((record) => ({
          rawRecordId: record.id,
          canonicalCompanyId: activeLinks.find(
            (link) => link.rawRecordId === record.id,
          )?.canonicalId,
          ...readSecEdgarCanaryEvidence(record.payload),
        }))
      : [];
  const worldBankEvidence =
    canaryName === "world_bank"
      ? acceptedRaw.map((record) =>
          readWorldBankCanaryEvidence(record.payload, canary.query.keywords),
        )
      : [];
  const usaSpendingEvidence =
    canaryName === "usaspending"
      ? acceptedRaw.map((record) =>
          readUsaSpendingCanaryEvidence(record.payload, canary.query.keywords),
        )
      : [];

  assert(
    ["DONE", "PARTIAL"].includes(evidence.run.status),
    "discovery run must reach DONE or PARTIAL",
  );
  assert(evidence.run.completedAt, "discovery run must have completedAt");
  const expectsZero =
    (canaryName === "uk_contracts_finder" &&
      contractsFinderExpectation === "zero") ||
    (canaryName === "world_bank" && worldBankExpectation === "zero") ||
    (canaryName === "usaspending" && usaSpendingExpectation === "zero") ||
    (canaryName === "brazil_pncp" && brazilPncpExpectation === "zero");
  if (expectsZero) {
    assert(
      evidence.run.status === "DONE",
      "zero-result control must complete as DONE",
    );
    assert(
      evidence.raw.length === 0,
      "zero-result control must not persist Raw records",
    );
    assert(
      activeLinks.length === 0,
      "zero-result control must not persist identity links",
    );
    assert(
      evidence.companies.length === 0,
      "zero-result control must not persist canonical companies",
    );
    assert(
      evidence.leads.length === 0,
      "zero-result control must not persist leads",
    );
    assert(
      evidence.identifiers.length === 0,
      "zero-result control must not persist identifiers",
    );
    assert(
      zeroResultQualityCanPass(
        providerQualityRows(evidence.quality, canary.key),
        canary.key,
      ),
      "zero-result control must persist exactly one successful zero-result provider contribution",
    );
  } else {
    assert(
      acceptedRaw.length > 0,
      "official source must persist at least one accepted Raw record",
    );
    assert(
      activeLinks.length > 0,
      "at least one accepted Raw record must have an ACTIVE identity link",
    );
    assert(
      evidence.companies.length > 0,
      "identity resolution must persist canonical companies",
    );
    assert(
      evidence.leads.length > 0,
      "fit evaluation must persist ICP-scoped leads",
    );
  }
  assert(
    evidence.raw.every((record) => record.providerKey === canary.key),
    `every Raw record must come from ${canary.key}`,
  );
  assert(
    acceptedRaw.every(
      (record) =>
        (record.sourceUrl?.startsWith(canary.officialUrlPrefix) ||
          (canaryName === "sec_edgar" &&
            record.sourceUrl?.startsWith(
              "https://data.sec.gov/submissions/CIK",
            ))) &&
        /^[a-f0-9]{64}$/u.test(record.contentHash ?? "") &&
        Boolean(record.parserVersion),
    ),
    "accepted Raw records must retain official URL, content hash and parser version",
  );
  assert(
    evidence.quality.some((row) => row.providerKey === canary.key),
    "provider quality ledger must persist the run contribution",
  );
  if (canary.requiredIdentifierScheme) {
    assert(
      evidence.identifiers.some(
        (identifier) =>
          identifier.scheme === canary.requiredIdentifierScheme &&
          identifier.authorityProviderKey === canary.key &&
          identifier.status === "ACTIVE",
      ),
      `${canary.key} must persist an ACTIVE ${canary.requiredIdentifierScheme} authority identifier`,
    );
  }
  if (canaryName === "ror") {
    assert(
      rorEvidence.length === acceptedRaw.length &&
        rorEvidence.every(
          (item) =>
            item.name &&
            item.country === "GB" &&
            item.status === "active" &&
            item.organizationTypes.includes("education") &&
            /^https:\/\/ror\.org\/0[0-9a-hjkmnp-tv-z]{6}[0-9]{2}$/u.test(
              item.rorId ?? "",
            ) &&
            !item.topLevelDomain &&
            item.domainIdentityStatus === "source_reported_evidence_only",
        ),
      "ROR Raw must retain an active scoped organization while keeping reported domains out of top-level identity",
    );
    assert(
      rorEvidence.every(
        (item) =>
          evidence.identifiers.filter(
            (identifier) =>
              identifier.rawRecordId === item.rawRecordId &&
              identifier.companyId === item.canonicalCompanyId &&
              identifier.scheme === "ror-id" &&
              identifier.jurisdiction === "GLOBAL" &&
              identifier.normalizedValue === item.rorId &&
              identifier.authorityProviderKey === canary.key &&
              identifier.status === "ACTIVE" &&
              identifier.validatorVersion === "ror-id-v1",
          ).length === 1,
      ),
      "each ROR Raw must bind its checksum-valid ror-id to one matching ACTIVE Canonical Company identifier",
    );
  }
  if (canaryName === "eu_ecolabel") {
    const euEcolabelCompany = evidence.companies[0];
    const canonicalDomainIsIndependentlyEvidenced =
      euEcolabelCompany?.domain === null ||
      evidence.canonicalFieldEvidence.some(
        (item) =>
          item.entityId === euEcolabelCompany?.id &&
          item.field === "domain" &&
          item.value === euEcolabelCompany.domain &&
          item.providerKey !== canary.key &&
          !acceptedRaw.some(
            (record) => record.id === item.rawRecordId,
          ),
      );
    assert(
      euEcolabelEvidence.length === acceptedRaw.length &&
        euEcolabelEvidence.every(
          (item) =>
            item.name === "Hagleitner Hygiene International GmbH" &&
            item.country === "AT" &&
            item.licenceNumber &&
            item.itemId &&
            item.certificationScope ===
              "product_award_not_organization_certification" &&
            item.rightsNotice &&
            !item.topLevelDomain &&
            item.identifiers.length === 0,
        ),
      "EU Ecolabel Raw must retain bounded product-award evidence without promoting licence or catalogue fields to company identity",
    );
    assert(
      activeLinks.length === acceptedRaw.length &&
        acceptedRaw.every(
          (record) =>
            activeLinks.filter((link) => link.rawRecordId === record.id)
              .length === 1,
        ),
      "every EU Ecolabel Raw must have exactly one ACTIVE identity link",
    );
    assert(
      evidence.companies.length === 1 &&
        euEcolabelCompany?.name ===
          "Hagleitner Hygiene International GmbH" &&
        euEcolabelCompany.country === "AT" &&
        canonicalDomainIsIndependentlyEvidenced,
      "EU Ecolabel product rows must resolve to one Austrian Canonical Company and any later domain must have independent non-EU evidence",
    );
    assert(
      evidence.identifiers.every(
        (identifier) =>
          identifier.authorityProviderKey !== canary.key &&
          !acceptedRaw.some(
            (record) => record.id === identifier.rawRecordId,
          ),
      ),
      "EU Ecolabel licence and item fields must never become organization identifiers; independently evidenced identifiers may remain",
    );
    assert(
      evidence.fieldEvidence.length >= acceptedRaw.length &&
        evidence.fieldEvidence.every(
          (item) =>
            item.providerKey === canary.key &&
            item.license === "EC-REUSE-CC-BY-4.0",
        ),
      "EU Ecolabel Evidence must retain provider and reuse-license attribution",
    );
    assert(
      worldBankPositiveQualityCanPass(
        providerQualityRows(evidence.quality, canary.key),
        canary.key,
        acceptedRaw.length,
      ),
      "EU Ecolabel quality ledger must account for every accepted and bound product-award row",
    );
    assert(
      !evidence.events.some((event) => event.eventType === "LeadQualified"),
      "EU Ecolabel canary must not hand unreviewed Leads to SaaS",
    );
  }
  if (canaryName === "mexico_denue") {
    const denueToken = process.env.MEXICO_DENUE_TOKEN?.trim();
    const forbiddenRawFields =
      /"(?:telefono|correo_e|calle|num_exterior|num_interior|cp|latitud|longitud|ageb|colonia)"\s*:/iu;
    assert(denueToken, "DENUE canary must have a process-memory Token");
    assert(
      evidence.run.status === "DONE",
      "DENUE positive canary must finish DONE",
    );
    assert(
      mexicoDenueEvidence.length === acceptedRaw.length &&
        mexicoDenueEvidence.every(
          (item) =>
            item.externalId === `mexico-denue:${item.denueId}` &&
            item.name &&
            item.country === "MX" &&
            /^\d{26}[MSU]\d$/u.test(item.clee ?? "") &&
            /^\d{10}$/u.test(item.denueId ?? "") &&
            item.tradeName &&
            item.legalName &&
            [item.tradeName, item.legalName].some(
              (value) =>
                value
                  ?.normalize("NFKC")
                  .trim()
                  .replaceAll(/\s+/gu, " ")
                  .toLocaleLowerCase("es-MX") ===
                mexicoDenueOrganizationName.toLocaleLowerCase("es-MX"),
            ) &&
            item.identityStatus ===
              "source_native_establishment_evidence_only" &&
            !item.topLevelDomain &&
            item.identifiers.length === 0 &&
            isSafeDenueWebsite(item.reportedWebsiteCandidate),
        ),
      "DENUE Raw must retain exact organization-establishment evidence without promoting a domain or identifier",
    );
    assert(
      acceptedRaw.every(
        (record) => !forbiddenRawFields.test(JSON.stringify(record.payload)),
      ),
      "DENUE Raw must structurally exclude contact and precise-location fields",
    );
    assert(
      acceptedRaw.every((record) =>
        record.sourceUrl?.endsWith("/REDACTED_TOKEN"),
      ) &&
        !JSON.stringify({ sourceUrls, raw: evidence.raw }).includes(denueToken),
      "DENUE Raw and report inputs must retain only redacted source URLs and no process Token",
    );
    assert(
      activeLinks.length === acceptedRaw.length &&
        acceptedRaw.every(
          (record) =>
            activeLinks.filter((link) => link.rawRecordId === record.id)
              .length === 1,
        ),
      "every accepted DENUE Raw record must have exactly one ACTIVE weak identity link",
    );
    assert(
      evidence.companies.every(
        (company) => company.country === "MX" && company.domain === null,
      ),
      "DENUE canonical companies must remain in Mexico without inventing a domain",
    );
    assert(
      evidence.activeAliasMappings.length === 0,
      "DENUE canary must resolve directly to root companies",
    );
    assert(
      evidence.identifiers.length === 0,
      "DENUE CLEE and Id must not become authority identifiers",
    );
    assert(
      evidence.fieldEvidence.length >= acceptedRaw.length &&
        evidence.fieldEvidence.every(
          (item) =>
            item.providerKey === canary.key &&
            item.license === "INEGI_FREE_USE_WITH_ATTRIBUTION",
        ),
      "DENUE must retain organization FieldEvidence with the source licence",
    );
    const leadCompanyIds = new Set(
      evidence.leads.map((lead) => lead.canonicalCompanyId),
    );
    assert(
      evidence.companies.every((company) => leadCompanyIds.has(company.id)) &&
        evidence.leads.every(
          (lead) => lead.fitVerdict === "weak" && lead.queue === "needs_review",
        ),
      "DENUE establishments must remain weak research Leads in needs_review",
    );
    assert(
      worldBankPositiveQualityCanPass(
        providerQualityRows(evidence.quality, canary.key),
        canary.key,
        acceptedRaw.length,
      ),
      "DENUE quality ledger must exactly account for accepted and bound organizations without conflicts",
    );
    assert(
      !evidence.events.some((event) => event.eventType === "LeadQualified"),
      "DENUE canary must not hand unreviewed Leads to SaaS",
    );
  }
  if (canaryName === "sec_edgar") {
    assert(
      acceptedRaw.length === 2 &&
        secDirectoryRaw.length === 1 &&
        secSubmissionRaw.length === 1,
      "SEC canary must persist exactly one directory Raw and one sanitized submissions Raw",
    );
    const secRaw = secDirectoryRaw[0]!;
    const submissionRaw = secSubmissionRaw[0]!;
    const sourcePolicySnapshot =
      secRaw.sourcePolicySnapshot &&
      typeof secRaw.sourcePolicySnapshot === "object" &&
      !Array.isArray(secRaw.sourcePolicySnapshot)
        ? (secRaw.sourcePolicySnapshot as Record<string, unknown>)
        : {};
    assert(
      secRaw.externalId === "sec-edgar:0000320193" &&
        secRaw.sourceClass === "company_registry" &&
        secRaw.sourceUrl === canary.officialUrlPrefix &&
        secRaw.parserVersion === "sec-edgar-company-tickers-exchange/1" &&
        secRaw.fetchedAt instanceof Date &&
        !Number.isNaN(secRaw.fetchedAt.getTime()) &&
        /^[a-f0-9]{64}$/u.test(secRaw.contentHash ?? "") &&
        /^external:[a-f0-9]{64}$/u.test(secRaw.ingestKey ?? "") &&
        /^[a-f0-9]{64}$/u.test(secRaw.payloadHash ?? "") &&
        Number.isInteger(secRaw.payloadBytes) &&
        (secRaw.payloadBytes ?? 0) > 0 &&
        secRaw.ingestVersion === "raw-source/v2" &&
        secRaw.dispositionCode === null &&
        secRaw.retentionDays === 365 &&
        secRaw.expiresAt instanceof Date &&
        secRaw.expiresAt.getTime() > secRaw.fetchedAt.getTime() &&
        sourcePolicySnapshot.kind === "source_policy" &&
        sourcePolicySnapshot.domain === "www.sec.gov" &&
        sourcePolicySnapshot.reviewStatus === "APPROVED" &&
        sourcePolicySnapshot.retentionDays === 365,
      "SEC Raw must retain the exact official directory provenance, v2 receipt and approved 365-day policy snapshot",
    );
    const secPayload = exactJsonObject(
      secRaw.payload,
      [
        "attributes",
        "externalId",
        "identifier",
        "identifiers",
        "license",
        "name",
        "provenance",
      ],
      "SEC Raw payload",
    );
    const secAttributes = exactJsonObject(
      secPayload.attributes,
      ["sec_edgar"],
      "SEC Raw attributes",
    );
    exactJsonObject(
      secAttributes.sec_edgar,
      ["cik", "disclaimer", "exchange", "identity_scope", "ticker"],
      "SEC Raw sec_edgar facts",
    );
    const secIdentifier = exactJsonObject(
      secPayload.identifier,
      ["jurisdiction", "scheme", "value"],
      "SEC Raw primary identifier",
    );
    assert(
      Array.isArray(secPayload.identifiers) &&
        secPayload.identifiers.length === 1,
      "SEC Raw must contain exactly one authority identifier",
    );
    const secIdentifierListItem = exactJsonObject(
      secPayload.identifiers[0],
      ["jurisdiction", "scheme", "value"],
      "SEC Raw identifier list item",
    );
    assert(
      isDeepStrictEqual(secIdentifier, secIdentifierListItem),
      "SEC Raw primary identifier and identifier list must be identical",
    );
    exactJsonObject(
      secPayload.provenance,
      ["contentHash", "fetchedAt", "parserVersion", "sourceUrl"],
      "SEC Raw provenance",
    );
    assertNoSecEdgarProhibitedFields(secRaw.payload, "SEC Raw payload");
    const submissionPolicySnapshot =
      submissionRaw.sourcePolicySnapshot &&
      typeof submissionRaw.sourcePolicySnapshot === "object" &&
      !Array.isArray(submissionRaw.sourcePolicySnapshot)
        ? (submissionRaw.sourcePolicySnapshot as Record<string, unknown>)
        : {};
    assert(
      submissionRaw.externalId === "sec-edgar-submission:0000320193" &&
        submissionRaw.sourceClass === "company_registry" &&
        submissionRaw.sourceUrl ===
          "https://data.sec.gov/submissions/CIK0000320193.json" &&
        submissionRaw.parserVersion === "sec-edgar-submissions/2" &&
        submissionRaw.fetchedAt instanceof Date &&
        !Number.isNaN(submissionRaw.fetchedAt.getTime()) &&
        /^[a-f0-9]{64}$/u.test(submissionRaw.contentHash ?? "") &&
        /^external:[a-f0-9]{64}$/u.test(submissionRaw.ingestKey ?? "") &&
        /^[a-f0-9]{64}$/u.test(submissionRaw.payloadHash ?? "") &&
        Number.isInteger(submissionRaw.payloadBytes) &&
        (submissionRaw.payloadBytes ?? 0) > 0 &&
        submissionRaw.ingestVersion === "raw-source/v2" &&
        submissionRaw.dispositionCode === null &&
        submissionRaw.retentionDays === 365 &&
        submissionRaw.expiresAt instanceof Date &&
        submissionPolicySnapshot.kind === "source_policy" &&
        submissionPolicySnapshot.domain === "data.sec.gov" &&
        submissionPolicySnapshot.reviewStatus === "APPROVED" &&
        submissionPolicySnapshot.retentionDays === 365,
      "SEC submissions Raw must retain exact data.sec.gov provenance and the approved enrichment policy snapshot",
    );
    const submissionPayload = exactJsonObject(
      submissionRaw.payload,
      [
        "attributes",
        "externalId",
        "identifiers",
        "license",
        "name",
        "provenance",
      ],
      "SEC submissions Raw payload",
    );
    const submissionAttributes = exactJsonObject(
      submissionPayload.attributes,
      ["sec_edgar_submission"],
      "SEC submissions Raw attributes",
    );
    const submissionClassification = exactJsonObject(
      submissionAttributes.sec_edgar_submission,
      ["cik", "entity_type", "schema_version", "semantic_scope"],
      "SEC submissions classification",
    );
    assert(
      submissionPayload.externalId === "sec-edgar-submission:0000320193" &&
        submissionPayload.name === "Apple Inc." &&
        submissionPayload.license === "US-GOV-PUBLIC-INFO" &&
        Array.isArray(submissionPayload.identifiers) &&
        submissionPayload.identifiers.length === 1 &&
        isDeepStrictEqual(submissionPayload.identifiers[0], {
          scheme: "cik",
          jurisdiction: "US",
          value: "0000320193",
        }) &&
        submissionClassification.schema_version ===
          "sec-edgar-submission-observation/v1" &&
        submissionClassification.cik === "0000320193" &&
        submissionClassification.entity_type === "operating" &&
        submissionClassification.semantic_scope ===
          "sec_filer_classification_only",
      "SEC submissions Raw must contain only the versioned directory-bound filer classification",
    );
    exactJsonObject(
      submissionPayload.provenance,
      ["contentHash", "fetchedAt", "parserVersion", "sourceUrl"],
      "SEC submissions Raw provenance",
    );
    assertNoSecEdgarProhibitedFields(
      submissionRaw.payload,
      "SEC submissions Raw payload",
    );
    assert(
      secEdgarEvidence.length === 1 &&
        secEdgarEvidence.every(
          (item) =>
            item.name === "Apple Inc." &&
            item.cik === "0000320193" &&
            item.ticker === "AAPL" &&
            Boolean(item.exchange) &&
            item.identityScope === "US securities filer namespace" &&
            Boolean(item.disclaimer) &&
            !item.country &&
            !item.topLevelDomain,
        ),
      "SEC Raw must retain exactly one bounded AAPL directory filer without inventing country or domain",
    );
    assert(
      evidence.identifiers.length === 1 &&
        secEdgarEvidence.every(
          (item) =>
            evidence.identifiers.filter(
              (identifier) =>
                identifier.rawRecordId === item.rawRecordId &&
                identifier.companyId === item.canonicalCompanyId &&
                identifier.scheme === "cik" &&
                identifier.jurisdiction === "US" &&
                identifier.normalizedValue === item.cik &&
                identifier.authorityProviderKey === canary.key &&
                identifier.status === "ACTIVE" &&
                identifier.validatorVersion === "cik-v1",
            ).length === 1,
        ),
      "each SEC Raw must bind its strict CIK to one matching ACTIVE Canonical Company identifier",
    );
    assert(
      activeLinks.length === 2 &&
        activeLinks.filter((link) => link.rawRecordId === secRaw.id).length ===
          1 &&
        activeLinks.filter((link) => link.rawRecordId === submissionRaw.id)
          .length === 1 &&
        new Set(activeLinks.map((link) => link.canonicalId)).size === 1 &&
        evidence.companies.length === 1 &&
        evidence.companies[0]?.name === "Apple Inc." &&
        evidence.companies[0]?.country === null &&
        evidence.companies[0]?.domain === null &&
        evidence.companies[0]?.dedupeKey === "id:cik:0000320193",
      "SEC directory and submissions Raw must resolve to the same countryless and domainless Canonical Company",
    );
    const directoryEvidence = evidence.fieldEvidence.filter(
      (item) => item.rawRecordId === secRaw.id,
    );
    const submissionEvidence = evidence.fieldEvidence.filter(
      (item) => item.rawRecordId === submissionRaw.id,
    );
    assert(
      evidence.fieldEvidence.length === 5 &&
        directoryEvidence.length === 2 &&
        directoryEvidence
          .map((item) => item.field)
          .sort()
          .join(",") === "attributes,name" &&
        submissionEvidence.length === 3 &&
        submissionEvidence
          .map((item) => item.field)
          .sort()
          .join(",") ===
          "sec_edgar.submission_entity_type,sec_edgar.submission_schema_version,sec_edgar.submission_semantic_scope" &&
        evidence.fieldEvidence.every(
          (item) =>
            item.providerKey === canary.key &&
            [secRaw.id, submissionRaw.id].includes(item.rawRecordId ?? "") &&
            item.entityId === evidence.companies[0]?.id &&
            item.entityType === "company" &&
            item.dataClass === "green" &&
            item.license === "US-GOV-PUBLIC-INFO" &&
            item.fetchedAt instanceof Date &&
            !Number.isNaN(item.fetchedAt.getTime()),
        ) &&
        directoryEvidence.every(
          (item) =>
            Array.isArray(item.allowedActions) &&
            item.allowedActions.length === 2 &&
            item.allowedActions.includes("display") &&
            item.allowedActions.includes("match"),
        ) &&
        submissionEvidence.every(
          (item) =>
            Array.isArray(item.allowedActions) &&
            item.allowedActions.length === 1 &&
            item.allowedActions[0] === "display" &&
            !item.allowedActions.includes("match"),
        ),
      "SEC directory evidence may support matching, but submissions classification evidence must be display-only",
    );
    for (const item of evidence.fieldEvidence) {
      assertNoSecEdgarProhibitedFields(
        item.value,
        `SEC ${item.field} evidence`,
      );
    }
    const nameEvidence = evidence.fieldEvidence.find(
      (item) => item.field === "name",
    );
    const attributesEvidence = evidence.fieldEvidence.find(
      (item) => item.field === "attributes",
    );
    assert(
      isDeepStrictEqual(nameEvidence?.value, secPayload.name) &&
        isDeepStrictEqual(attributesEvidence?.value, secPayload.attributes),
      "SEC FieldEvidence values must exactly equal the allowlisted Raw name and attributes values",
    );
    assert(
      submissionEvidence.some(
        (item) =>
          item.field === "sec_edgar.submission_schema_version" &&
          item.value === "sec-edgar-submission-observation/v1",
      ) &&
        submissionEvidence.some(
          (item) =>
            item.field === "sec_edgar.submission_entity_type" &&
            item.value === "operating",
        ) &&
        submissionEvidence.some(
          (item) =>
            item.field === "sec_edgar.submission_semantic_scope" &&
            item.value === "sec_filer_classification_only",
        ),
      "SEC submissions evidence must exactly match the sanitized classification projection",
    );
    assert(
      secEdgarQualityCanPass(evidence.quality),
      "SEC quality ledger must contain the exact two-step SEC contribution and truthful companion zero-result attempts",
    );
    assert(
      evidence.leads.length === 1 &&
        ["DISCOVERED", "REVIEW"].includes(evidence.leads[0]?.status ?? "") &&
        evidence.leads[0]?.fitVerdict === "weak" &&
        evidence.leads[0]?.queue === "needs_review",
      "SEC directory plus filer classification must remain a weak non-qualified lead pending commercial fit evidence",
    );
    assert(
      evidence.events.every((event) => event.eventType !== "LeadQualified"),
      "SEC filer classification canary must not emit LeadQualified",
    );
    assert(
      secSignalBefore !== null &&
        secSignalAfter !== null &&
        secSignalAfter.sourceSignals === secSignalBefore.sourceSignals &&
        secSignalAfter.signalIngests === secSignalBefore.signalIngests,
      "SEC directory and filer classification must not create SourceSignal or SignalIngest rows",
    );
  }
  assert(
    evidence.events.some(
      (event) => event.eventType === "DiscoveryRunCompleted",
    ),
    "DiscoveryRunCompleted must be written to the outbox",
  );
  if (["uk_fts", "uk_contracts_finder"].includes(canaryName) && !expectsZero) {
    assert(
      ukProcurementEvidence.some(
        (item) =>
          item.sourceRole === "buyer" &&
          item.signalStage === "planning_or_tender" &&
          item.status === "active" &&
          (canaryName !== "uk_contracts_finder" ||
            item.deadlineIsCurrent === true) &&
          (canaryName === "uk_contracts_finder" ||
            (typeof item.noticeUrl === "string" &&
              item.noticeUrl.startsWith(
                "https://www.find-tender.service.gov.uk/Notice/",
              ))) &&
          typeof item.deadline === "string" &&
          Array.isArray(item.cpvCodes) &&
          item.cpvCodes.length > 0,
      ),
      "UK Raw must retain active buyer demand, official notice URL, deadline and CPV codes",
    );
  }
  if (canaryName === "uk_contracts_finder" && !expectsZero) {
    assert(
      ukProcurementEvidence.some((item) => item.positiveKeywordMatch),
      "Contracts Finder positive evidence must match the buyer name or procurement title, never description alone",
    );
    assert(
      ukProcurementEvidence.every(
        (item) =>
          item.country === "United Kingdom" &&
          item.region === contractsFinderRegion,
      ),
      `Contracts Finder Raw must use country=United Kingdom and region=${contractsFinderRegion}`,
    );
    assert(
      evidence.companies.every((company) =>
        matchesContractsFinderLocation(company, contractsFinderRegion),
      ),
      `Contracts Finder canonical companies must use country=United Kingdom and region=${contractsFinderRegion}`,
    );
  }
  const paginationEvidence =
    canaryName === "uk_contracts_finder"
      ? contractsFinderPaginationEvidence(sourceUrls, evidence.run.stats)
      : {
          acceptedFromContinuation: false,
          maxPagesExhausted: false,
          proved: false,
        };
  if (
    canaryName === "uk_contracts_finder" &&
    contractsFinderRequirePagination
  ) {
    assert(
      paginationEvidence.proved,
      "Contracts Finder pagination proof requires an accepted cursor URL or max-page truncation fact",
    );
  }
  const brazilPncpPagination =
    canaryName === "brazil_pncp"
      ? brazilPncpPaginationEvidence(brazilPncpEvidence)
      : {
          acceptedPageOne: false,
          acceptedPageTwo: false,
          frozenQuery: false,
          proved: false,
        };
  if (canaryName === "brazil_pncp" && !expectsZero) {
    const publicIntelligence = (
      evidence.run.stats &&
      typeof evidence.run.stats === "object" &&
      !Array.isArray(evidence.run.stats)
        ? (evidence.run.stats as Record<string, unknown>)
        : {}
    ).perSource;
    const sourceStats =
      publicIntelligence &&
      typeof publicIntelligence === "object" &&
      !Array.isArray(publicIntelligence)
        ? (publicIntelligence as Record<string, unknown>).public_intelligence
        : undefined;
    const paginationTruncated =
      sourceStats &&
      typeof sourceStats === "object" &&
      !Array.isArray(sourceStats)
        ? (sourceStats as Record<string, unknown>).paginationTruncated === true
        : false;
    assert(
      evidence.run.status === "DONE" && !paginationTruncated,
      "PNCP positive canary must finish DONE without pagination truncation",
    );
    assert(
      brazilPncpEvidence.length === acceptedRaw.length &&
        brazilPncpEvidence.every(
          (item) =>
            item.companyName &&
            item.title &&
            item.controlNumber &&
            item.country === "BR" &&
            item.sourceRole === "buyer" &&
            item.signalStage === "open_for_proposals" &&
            item.positiveTitleKeywordMatch &&
            item.deadlineIsCurrent &&
            item.sourcePage &&
            item.sourcePage > 0 &&
            /^\d{8}$/u.test(item.queryDateFinal ?? "") &&
            item.queryState === brazilPncpState &&
            item.queryKeywords.includes(
              brazilPncpKeyword.normalize("NFKC").toLocaleLowerCase("pt-BR"),
            ) &&
            /^[a-f0-9]{64}$/u.test(item.queryFingerprint ?? "") &&
            !item.rawDomain &&
            !item.rawIdentifier,
        ),
      "PNCP must persist a current buyer opportunity whose title matches the Portuguese keyword",
    );
    assert(
      activeLinks.length === acceptedRaw.length &&
        acceptedRaw.every(
          (record) =>
            activeLinks.filter((link) => link.rawRecordId === record.id)
              .length === 1,
        ),
      "every accepted PNCP Raw record must have exactly one ACTIVE identity link",
    );
    assert(
      evidence.companies.every((company) => company.country === "BR"),
      "PNCP canonical companies must remain in Brazil",
    );
    assert(
      evidence.activeAliasMappings.length === 0,
      "PNCP canary must resolve directly to root companies",
    );
    const leadCompanyIds = new Set(
      evidence.leads.map((lead) => lead.canonicalCompanyId),
    );
    assert(
      evidence.companies.every((company) => leadCompanyIds.has(company.id)) &&
        evidence.leads.every(
          (lead) =>
            lead.status === "DISCOVERED" &&
            lead.fitVerdict === "weak" &&
            lead.queue === "needs_review",
        ),
      "PNCP companies must remain weak canary Leads in needs_review",
    );
    assert(
      brazilPncpEvidence.every((item) =>
        brazilPncpAuthorityEvidenceIsConsistent(
          item,
          evidence.identifiers,
          canary.key,
        ),
      ),
      "PNCP CNPJ evidence must be absent when invalid, or checksum-validated and linked to one matching ACTIVE br-cnpj authority identifier",
    );
    assert(
      worldBankPositiveQualityCanPass(
        providerQualityRows(evidence.quality, canary.key),
        canary.key,
        acceptedRaw.length,
      ),
      "PNCP quality ledger must exactly account for accepted and bound buyers without conflicts",
    );
    assert(
      !evidence.events.some((event) => event.eventType === "LeadQualified"),
      "PNCP canary must not hand unreviewed Leads to SaaS",
    );
  }
  const usaSpendingPagination =
    canaryName === "usaspending"
      ? usaSpendingPaginationEvidence(usaSpendingEvidence)
      : {
          acceptedPageOne: false,
          acceptedPageTwo: false,
          frozenQueryFingerprint: false,
          proved: false,
        };
  if (canaryName === "usaspending" && !expectsZero) {
    const publicIntelligence = (
      evidence.run.stats &&
      typeof evidence.run.stats === "object" &&
      !Array.isArray(evidence.run.stats)
        ? (evidence.run.stats as Record<string, unknown>)
        : {}
    ).perSource;
    const publicIntelligenceStats =
      publicIntelligence &&
      typeof publicIntelligence === "object" &&
      !Array.isArray(publicIntelligence)
        ? (publicIntelligence as Record<string, unknown>).public_intelligence
        : undefined;
    const paginationTruncated =
      publicIntelligenceStats &&
      typeof publicIntelligenceStats === "object" &&
      !Array.isArray(publicIntelligenceStats)
        ? (publicIntelligenceStats as Record<string, unknown>)
            .paginationTruncated === true
        : false;
    assert(
      evidence.run.status === "DONE" && !paginationTruncated,
      "USAspending positive canary must finish DONE without pagination truncation",
    );
    assert(
      usaSpendingEvidence.length === acceptedRaw.length &&
        usaSpendingEvidence.every(
          (item) =>
            item.companyName &&
            item.country === "US" &&
            item.sourceRole === "buyer" &&
            item.signalStage === "historical_award_buyer" &&
            item.awardId &&
            item.parentAgency &&
            item.subAgency &&
            item.parentAgency !== item.subAgency &&
            item.parentSubagencyNameMatches &&
            item.positiveKeywordMatch &&
            (item.startDate || item.endDate) &&
            item.startDateValid &&
            item.endDateValid &&
            item.sourcePage &&
            item.sourcePage > 0 &&
            item.queryStartDateValid &&
            item.queryEndDateValid &&
            item.queryKeywords.includes(usaSpendingKeyword) &&
            /^[a-f0-9]{64}$/u.test(item.queryFingerprint ?? "") &&
            !item.recipientRetained &&
            !item.descriptionRetained &&
            !item.rawDomain &&
            !item.rawIdentifier &&
            !item.rawIdentifiers,
        ),
      "USAspending Raw must retain explicit bounded query-match proof without description, recipient or organization identity invention",
    );
    assert(
      activeLinks.length === acceptedRaw.length &&
        acceptedRaw.every(
          (record) =>
            activeLinks.filter((link) => link.rawRecordId === record.id)
              .length === 1,
        ),
      "every accepted USAspending Raw record must have exactly one ACTIVE identity link",
    );
    assert(
      evidence.companies.every((company) => company.country === "US"),
      "USAspending canonical companies must remain in the United States",
    );
    assert(
      evidence.activeAliasMappings.length === 0,
      "USAspending canary must resolve directly to root companies",
    );
    const leadCompanyIds = new Set(
      evidence.leads.map((lead) => lead.canonicalCompanyId),
    );
    assert(
      evidence.companies.every((company) => leadCompanyIds.has(company.id)) &&
        evidence.leads.every(
          (lead) =>
            lead.status === "DISCOVERED" &&
            lead.fitVerdict === "weak" &&
            lead.queue === "needs_review",
        ),
      "USAspending companies must remain weak historical research Leads in needs_review",
    );
    assert(
      evidence.identifiers.length === 0,
      "USAspending award IDs must never become organization identifiers",
    );
    assert(
      usaSpendingPositiveQualityCanPass(
        providerQualityRows(evidence.quality, canary.key),
        acceptedRaw.length,
      ),
      "USAspending quality ledger must exactly account for accepted and bound historical buyers without conflicts",
    );
    assert(
      !evidence.events.some((event) => event.eventType === "LeadQualified"),
      "USAspending discovery must not hand historical research Leads to SaaS",
    );
  }
  const worldBankPagination =
    canaryName === "world_bank"
      ? worldBankPaginationEvidence(sourceUrls, evidence.run.stats)
      : {
          acceptedContinuation: false,
          paginationTruncated: false,
          proved: false,
        };
  if (canaryName === "world_bank") {
    assert(
      worldBankRunStatusIsTruthful(evidence.run.status, evidence.run.stats),
      "World Bank pagination truncation must be reported as PARTIAL with dataQualityBlocked=true, never DONE",
    );
    if (!expectsZero) {
      assert(
        evidence.run.status === "DONE" &&
          worldBankPositiveRunCanPass(evidence.run.status, evidence.run.stats),
        "World Bank nonzero canary must finish DONE; PARTIAL is diagnostic evidence and cannot PASS",
      );
      assert(
        worldBankEvidence.length === acceptedRaw.length &&
          worldBankEvidence.every(
            (item) =>
              item.companyName &&
              item.country === worldBankCountry &&
              item.sourceRole === "procurement_buyer_or_implementing_agency" &&
              item.signalStage === "published_notice" &&
              item.noticeId &&
              item.title &&
              item.positiveKeywordMatch &&
              !item.projectNameWasPromoted,
          ),
        "World Bank Raw must retain a matching buyer/implementing-agency notice in the requested country without promoting project name to company",
      );
      assert(
        acceptedRaw.every((record) =>
          activeLinks.some((link) => link.rawRecordId === record.id),
        ),
        "every accepted World Bank Raw record must have an ACTIVE identity link",
      );
      assert(
        evidence.companies.every(
          (company) =>
            company.country === worldBankCountry && company.domain === null,
        ),
        "World Bank canonical companies must stay in the requested country and must not invent a domain",
      );
      assert(
        evidence.activeAliasMappings.length === 0,
        "World Bank identity links must resolve to root canonical companies, not active aliases",
      );
      const leadCompanyIds = new Set(
        evidence.leads.map((lead) => lead.canonicalCompanyId),
      );
      assert(
        evidence.companies.every((company) => leadCompanyIds.has(company.id)),
        "every World Bank canonical company in the run must reach an ICP-scoped Lead",
      );
      assert(
        evidence.identifiers.length === 0,
        "World Bank notices provide no admitted strong organization identifier and must not create one",
      );
      assert(
        worldBankPositiveQualityCanPass(
          providerQualityRows(evidence.quality, canary.key),
          canary.key,
          acceptedRaw.length,
        ),
        "World Bank quality ledger must exactly account for accepted and bound buyer records without conflicts",
      );
    }
  }

  if (verifyReplay) {
    assert(
      !expectsZero,
      "replay verification requires a positive canary with accepted Raw records",
    );
    const before = await appDb.withWorkspace(workspaceId, async (tx) => {
      const [
        canonicalCompanies,
        leads,
        fieldEvidence,
        authorityIdentifiers,
        identityLinks,
        mappings,
      ] = await Promise.all([
        tx.canonicalCompany.count(),
        tx.lead.count(),
        tx.fieldEvidence.count(),
        tx.organizationIdentifier.count(),
        tx.identityLink.count(),
        tx.organizationCanonicalMapping.findMany({
          where: { status: "ACTIVE" },
          select: { sourceCompanyId: true, canonicalCompanyId: true },
        }),
      ]);
      return {
        counts: {
          canonicalCompanies,
          leads,
          fieldEvidence,
          authorityIdentifiers,
          identityLinks,
        },
        mappings,
      };
    });
    const baselineRootCompanyIds = activeLinks.map((link) =>
      resolveRootCompanyId(link.canonicalId, before.mappings),
    );

    // Re-run only the deterministic persistence stage over the exact same Raw
    // rows. A second provider fetch would create new Raw observations and is
    // therefore not evidence that identity materialization itself is idempotent.
    const replayResult = await activities.canonicalizeRun({
      workspaceId,
      runId: seeded.runId,
    });
    const after = await appDb.withWorkspace(workspaceId, async (tx) => {
      const [
        canonicalCompanies,
        leads,
        fieldEvidence,
        authorityIdentifiers,
        identityLinks,
        links,
        mappings,
      ] = await Promise.all([
        tx.canonicalCompany.count(),
        tx.lead.count(),
        tx.fieldEvidence.count(),
        tx.organizationIdentifier.count(),
        tx.identityLink.count(),
        tx.identityLink.findMany({
          where: {
            rawRecordId: { in: acceptedRaw.map((record) => record.id) },
            status: "ACTIVE",
          },
          select: { rawRecordId: true, canonicalId: true },
        }),
        tx.organizationCanonicalMapping.findMany({
          where: { status: "ACTIVE" },
          select: { sourceCompanyId: true, canonicalCompanyId: true },
        }),
      ]);
      return {
        counts: {
          canonicalCompanies,
          leads,
          fieldEvidence,
          authorityIdentifiers,
          identityLinks,
        },
        links,
        mappings,
      };
    });
    replayEvidence = acquisitionReplayEvidence({
      honestTerminal:
        ["DONE", "PARTIAL"].includes(evidence.run.status) &&
        (canaryName !== "world_bank" ||
          worldBankRunStatusIsTruthful(
            evidence.run.status,
            evidence.run.stats,
          )),
      providerKey: canary.key,
      acceptedRawIds: acceptedRaw.map((record) => record.id),
      resolvedLinks: after.links.map((link) => ({
        rawRecordId: link.rawRecordId,
        rootCompanyId: resolveRootCompanyId(link.canonicalId, after.mappings),
      })),
      baselineRootCompanyIds,
      beforeCounts: before.counts,
      afterCounts: after.counts,
      identityQuality: replayResult.identityQuality,
    });
    assert(
      replayEvidence &&
        typeof replayEvidence === "object" &&
        "proved" in replayEvidence &&
        replayEvidence.proved === true,
      "same-Raw canonicalization replay must bind every Raw to a first-run root without adding companies, leads, evidence, identifiers or links",
    );
  }

  if (canaryName === "sec_edgar") {
    let relayObservation: {
      lead: {
        id: string;
        status: string;
        fitVerdict: string | null;
        queue: string;
        totalScore: number | null;
      } | null;
      events: { eventType: string; publishedAt: Date | null }[];
    } | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      relayObservation = await appDb.withWorkspace(workspaceId, async (tx) => ({
        lead: await tx.lead.findFirst({
          where: { icpId: seeded.icpId },
          select: {
            id: true,
            status: true,
            fitVerdict: true,
            queue: true,
            totalScore: true,
          },
        }),
        events: await tx.outboxEvent.findMany({
          where: { workspaceId },
          orderBy: { occurredAt: "asc" },
          select: { eventType: true, publishedAt: true },
        }),
      }));
      const leadsScoredPublished = relayObservation.events.some(
        (event) =>
          event.eventType === "LeadsScored" &&
          event.publishedAt instanceof Date,
      );
      if (relayObservation.lead?.status === "REVIEW" && leadsScoredPublished)
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert(
      relayObservation?.lead?.status === "REVIEW" &&
        relayObservation.lead.fitVerdict === "weak" &&
        relayObservation.lead.queue === "needs_review",
      "SEC directory-only candidate must settle as a weak REVIEW lead after relay scoring",
    );
    const requiredPublishedEvents = [
      "DiscoveryRunCompleted",
      "QualifyRequested",
      "LeadsScored",
    ];
    assert(
      requiredPublishedEvents.every((eventType) =>
        relayObservation?.events.some(
          (event) =>
            event.eventType === eventType && event.publishedAt instanceof Date,
        ),
      ),
      "SEC canary must prove Relay published discovery, qualification request and scoring events",
    );
    assert(
      relayObservation.events.every(
        (event) => event.eventType !== "LeadQualified",
      ),
      "SEC directory-only canary must remain absent from LeadQualified after relay scoring",
    );
    secEdgarRelayEvidence = {
      lead: relayObservation.lead,
      publishedEventTypes: relayObservation.events
        .filter((event) => event.publishedAt instanceof Date)
        .map((event) => event.eventType),
      leadQualifiedEmitted: false,
    };
  }

  finalReport = {
    verdict:
      canaryName === "brazil_pncp" && expectsZero ? "CONTROL_PASS" : "PASS",
    scope:
      "macOS isolated local experiment; not Ubuntu or production acceptance",
    canaryKey: canary.key,
    ...(canaryCaseId ? { canaryCaseId } : {}),
    canary: canary.label,
    retainedExperiment: true,
    sourceDataMode: "live-official-http",
    modelMode: "stub",
    modelScoringProved: false,
    positiveChannelProved: !expectsZero && acceptedRaw.length > 0,
    workspaceId,
    workflowId,
    ...seeded,
    run: {
      status: evidence.run.status,
      completedAt: evidence.run.completedAt,
      stats: evidence.run.stats,
    },
    ...(verifyReplay ? { replayEvidence } : {}),
    counts: {
      raw: evidence.raw.length,
      acceptedRaw: acceptedRaw.length,
      activeIdentityLinks: activeLinks.length,
      canonicalCompanies: evidence.companies.length,
      activeAliasMappings: evidence.activeAliasMappings.length,
      leads: evidence.leads.length,
      authorityIdentifiers: evidence.identifiers.length,
      aiCalls: aiAfter - aiBefore,
      ...(canaryName === "sec_edgar" && secSignalBefore && secSignalAfter
        ? {
            secSourceSignalGrowth:
              secSignalAfter.sourceSignals - secSignalBefore.sourceSignals,
            secSignalIngestGrowth:
              secSignalAfter.signalIngests - secSignalBefore.signalIngests,
          }
        : {}),
    },
    sourceUrls,
    ...(canaryName === "ror"
      ? {
          organizationEvidence: rorEvidence,
          identityClaim:
            "ROR ID is checksum-validated organization authority; reported domains remain source evidence and are not promoted to domain identity",
        }
      : {}),
    ...(canaryName === "sec_edgar"
      ? {
          organizationEvidence: secEdgarEvidence,
          fieldEvidence: evidence.fieldEvidence.map((item) => ({
            rawRecordId: item.rawRecordId,
            entityId: item.entityId,
            entityType: item.entityType,
            field: item.field,
            providerKey: item.providerKey,
            license: item.license,
            allowedActions: item.allowedActions,
            dataClass: item.dataClass,
            fetchedAt: item.fetchedAt,
          })),
          relayEvidence: secEdgarRelayEvidence,
          identityClaim:
            "CIK is a strict SEC filer namespace identifier; no country, domain, filing history or commercial fit is asserted",
        }
      : {}),
    ...(canaryName === "mexico_denue"
      ? {
          requestedCountry: "MX",
          requestedStateCode: mexicoDenueStateCode,
          requestedOrganizationName: mexicoDenueOrganizationName,
          requestedLimit: mexicoDenueLimit,
          organizationEvidence: mexicoDenueEvidence,
          fieldEvidence: evidence.fieldEvidence.map((item) => ({
            rawRecordId: item.rawRecordId,
            entityId: item.entityId,
            entityType: item.entityType,
            field: item.field,
            providerKey: item.providerKey,
            license: item.license,
            allowedActions: item.allowedActions,
            dataClass: item.dataClass,
            fetchedAt: item.fetchedAt,
          })),
          identityClaim:
            "CLEE and DENUE Id remain source-native establishment evidence only; name-country weak binding creates no authority identifier or domain identity",
        }
      : {}),
    ...(canaryName === "eu_ecolabel"
      ? {
          organizationEvidence: euEcolabelEvidence,
          identityClaim:
            "exact organization name plus AT weak binding only; product licence numbers remain evidence and are never organization identifiers",
        }
      : {}),
    ...(canaryName === "uk_contracts_finder"
      ? {
          expectation: contractsFinderExpectation,
          paginationEvidence,
        }
      : {}),
    ...(canaryName === "world_bank"
      ? {
          expectation: worldBankExpectation,
          requestedCountry: worldBankCountry,
          requestedKeyword: worldBankKeyword,
          requestedLimit: worldBankLimit,
          paginationEvidence: worldBankPagination,
          procurementEvidence: worldBankEvidence,
          identityClaim:
            "name-country binding only; no authority identifier or domain asserted",
        }
      : {}),
    ...(canaryName === "usaspending"
      ? {
          expectation: usaSpendingExpectation,
          requestedCountry: "US",
          requestedKeyword: usaSpendingKeyword,
          requestedSinceDays: usaSpendingSinceDays,
          requestedLimit: usaSpendingLimit,
          paginationEvidence: usaSpendingPagination,
          procurementEvidence: usaSpendingEvidence,
          identityClaim:
            "parent-agency plus sub-agency and US weak binding only; award IDs are event identifiers",
        }
      : {}),
    ...(["uk_fts", "uk_contracts_finder"].includes(canaryName)
      ? { procurementEvidence: ukProcurementEvidence }
      : {}),
    ...(canaryName === "brazil_pncp"
      ? {
          expectation: brazilPncpExpectation,
          requestedCountry: "BR",
          requestedState: brazilPncpState,
          requestedKeyword: brazilPncpKeyword,
          requestedLimit: brazilPncpLimit,
          paginationEvidence: brazilPncpPagination,
          procurementEvidence: brazilPncpEvidence,
          identityClaim:
            "a buyer CNPJ is authoritative only when checksum-valid, equal to the PNCP control prefix and persisted as the same ACTIVE br-cnpj identifier; otherwise claim and identifier are absent",
        }
      : {}),
    paginationObserved:
      canaryName === "world_bank"
        ? worldBankPagination.proved
        : canaryName === "usaspending"
          ? usaSpendingPagination.proved
          : canaryName === "brazil_pncp"
            ? brazilPncpPagination.proved
            : paginationEvidence.proved,
    paginationNote:
      canaryName === "world_bank"
        ? worldBankPagination.proved
          ? "Continuation is evidenced by an accepted official World Bank URL whose os offset is greater than zero."
          : "No accepted World Bank continuation record was observed; truncation alone is not treated as pagination proof."
        : canaryName === "usaspending"
          ? usaSpendingPagination.proved
            ? "Continuation is evidenced by accepted Raw procurement facts whose persisted source_page is greater than one."
            : "No accepted USAspending continuation-page Raw fact was observed."
          : canaryName === "brazil_pncp"
            ? brazilPncpPagination.proved
              ? "Continuation is evidenced by accepted PNCP Raw facts from page one and a later page under one frozen query."
              : "No accepted PNCP continuation-page Raw fact was observed."
            : paginationEvidence.proved
              ? "Continuation is evidenced by an accepted cursor URL or a bounded max-page truncation fact."
              : "No live continuation fact was observed; deterministic continuation semantics remain covered by provider tests.",
    companies: evidence.companies,
    identifiers: evidence.identifiers,
    leadsAtDiscoveryCompletion: evidence.leads,
    providerQuality: evidence.quality,
    outboxAtDiscoveryCompletion: evidence.events,
  };
  if (canaryName === "mexico_denue") {
    const denueToken = process.env.MEXICO_DENUE_TOKEN?.trim();
    assert(
      denueToken && !JSON.stringify(finalReport).includes(denueToken),
      "DENUE final report must not contain the process Token",
    );
  }
} catch (error) {
  executionError = error;
}

let cleanupError: unknown;
try {
  await runCanaryCleanup({
    restoreProvider: async () => {
      if (
        !databaseUrl ||
        !temporarilyEnabledCanaries.has(canaryName) ||
        !originalProviderStatus
      )
        return;
      const current = await controlDb.dataProvider.findUnique({
        where: { key: canary.key },
      });
      if (current?.status !== originalProviderStatus) {
        await controlDb.dataProvider.update({
          where: { key: canary.key },
          data: {
            status: originalProviderStatus as
              "ENABLED" | "DISABLED" | "DEGRADED",
          },
        });
      }
      const restored = await controlDb.dataProvider.findUnique({
        where: { key: canary.key },
      });
      assert(
        restored?.status === originalProviderStatus,
        `${canary.key} provider status must be restored exactly`,
      );
    },
    finalizeRun: async () => {
      if (!retainedRunId) return;
      await appDb.withWorkspace(workspaceId, async (tx) => {
        await tx.discoveryRun.updateMany({
          where: { id: retainedRunId, status: "RUNNING" },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            stats: {
              failure: {
                stage: "acceptance_harness",
                errorCode: "CANARY_ABORTED",
              },
            },
          },
        });
      });
    },
    releaseToggleLock: async () => {
      if (!providerToggleLockHeld) return;
      const released = await controlDb.$queryRaw<{ released: boolean }[]>`
        SELECT pg_advisory_unlock(${PROVIDER_TOGGLE_LOCK_ID}) AS released
      `;
      assert(
        released[0]?.released,
        "provider toggle advisory lock must be released",
      );
    },
  });
} catch (error) {
  cleanupError = error;
}
await temporal?.close();
await embeddedWorkerConnection?.close();
await appDb.$disconnect();
await controlDb.$disconnect();
if (cleanupError) throw cleanupError;
if (executionError) throw executionError;
if (!finalReport) throw new Error("CANARY_REPORT_MISSING");
console.log(JSON.stringify(finalReport, null, 2));
