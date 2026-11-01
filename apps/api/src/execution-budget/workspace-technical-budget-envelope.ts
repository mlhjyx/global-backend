import { getTask } from '../ai-tasks/task-registry';
import {
  MAX_COMPANIES_HOUSE_CONTACT_CALLS,
  MAX_COMPANY_DISCOVERY_ADAPTERS,
  MAX_CONTACT_DISCOVERY_ADAPTERS,
  MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
  MAX_DECISION_MAKER_PAGES,
  MAX_DIGITAL_FOOTPRINT_RENDERS,
  MAX_DIRECTORY_LISTING_PAGES,
  MAX_DIRECTORY_PAGINATION,
  MAX_DIRECTORY_SEARCHES_PER_QUERY,
  MAX_DISCOVERY_ENRICH_COMPANIES,
  MAX_DISCOVERY_FIT_COMPANIES,
  MAX_DISCOVERY_PLAN_QUERIES,
  MAX_DISCOVERY_PROFILE_COMPANIES,
  MAX_WEBSITE_PROFILE_FETCHES_PER_COMPANY,
  MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY,
  MAX_DISCOVERY_PROVIDER_RECORDS,
  MAX_DISCOVERY_SIGNAL_COMPANIES,
  MAX_DISCOVERY_WATCH_COMPANIES,
  MAX_EMAIL_GUESS_CONTACTS,
  MAX_EMAIL_PROBE_CANDIDATES,
  MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
  MAX_GLEIF_FETCHES_PER_COMPANY,
  MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES,
  MAX_PUBLIC_WEB_DOMAINS_PER_QUERY,
  MAX_PUBLIC_WEB_SEARCHES_PER_QUERY,
  MAX_QUERY_TAXONOMY_COUNTRY_TERMS,
  MAX_QUERY_TAXONOMY_INDUSTRY_TERMS,
  MAX_SINGLE_SEARCH_WIRES_PER_QUERY,
  MAX_SITEMAP_HTTP_GETS,
  MAX_SOCIAL_DORKS,
  MAX_SOCIAL_FETCHES_PER_CANDIDATE,
  MAX_SOCIAL_PROFILE_FETCHES,
  MAX_STRUCTURED_HARVEST_HTTP_GETS,
  MAX_STRUCTURED_HARVEST_RENDERS,
  MAX_UNDERSTANDING_SUBPAGES,
  MAX_WIKIDATA_ENTITY_READS_PER_COMPANY,
} from '../discovery/execution-envelope';
import { TRADE_FAIRS } from '../discovery/trade-fairs';
import {
  MAX_QUERY_PLAN_INDUSTRY_TERMS,
  MAX_QUERY_PLAN_TARGET_COUNTRIES,
} from '../discovery/icp-to-cpv';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';
import {
  crawl4aiFetchTool,
  osmOverpassTool,
  searxngSearchTool,
  smtpRcptProbeTool,
  socialFetchTool,
  socialSearchTool,
  wikidataTool,
} from '../tools/builtin-tools';
import {
  companiesHouseSearchTool,
  crawl4aiRenderTool,
  gleifFetchTool,
  googlePatentsSearchTool,
  httpGetTool,
  inpiRneSearchTool,
  openFdaSearchTool,
  tedSearchTool,
  tradeFairAlgoliaTool,
  wikidataEntityTool,
} from '../tools/source-tools';
import type { Tool } from '../tools/tool-contract';
import type { WorkspaceExecutionBudgetRequest } from './execution-budget-request-scope';
import {
  WorkspaceTechnicalBudgetQuoteError,
  type WorkspaceTechnicalBudgetEnvelope,
  type WorkspaceTechnicalBudgetModelPolicy,
  type WorkspaceTechnicalBudgetPolicy,
  type WorkspaceTechnicalBudgetToolPolicy,
} from './workspace-technical-budget-quote';

export const WORKSPACE_EXECUTION_QUOTE_OPERATIONS = Object.freeze([
  'POST /companies',
  'POST /companies/:companyId/icps',
  'POST /icps/:icpId/query-plans',
  'POST /query-plans/:planId/execute',
  'POST /canonical-companies/:id/discover-contacts',
  'POST /canonical-companies/:id/guess-emails',
  'POST /contact-points/:pointId/verify',
  'POST /leads/:leadId/outreach-drafts',
  'POST /companies/:companyId/understanding/retry',
] as const satisfies readonly WorkspaceExecutionBudgetRequest['operation'][]);

const MICROUSD_PER_CENT = 10_000n;
const REPRESENTATION_MINIMUM_MICROUSD = 1n;
const TAXONOMY_INDUSTRY_PASSES = 2;
const TAXONOMY_PRODUCT_REFINEMENTS = 2;

function unavailable(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
  );
}

function invalid(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_INVALID',
  );
}

function model(
  taskId: string,
  logicalInvocations: number,
): WorkspaceTechnicalBudgetModelPolicy {
  const task = getTask(taskId);
  if (
    !task ||
    !Number.isSafeInteger(logicalInvocations) ||
    logicalInvocations < 1 ||
    !Number.isSafeInteger(task.maxCostCents) ||
    (task.maxCostCents ?? 0) < 1 ||
    !Number.isSafeInteger(task.maxOutputTokens) ||
    task.maxOutputTokens < 1 ||
    typeof task.model !== 'string' ||
    task.model.length < 1
  ) {
    return unavailable();
  }
  return Object.freeze({
    taskId,
    requestedAlias: task.model,
    logicalInvocations,
    structuredWireUpperBound: MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND,
    maxCostCents: task.maxCostCents!,
    maxOutputTokens: task.maxOutputTokens,
  });
}

function tool(
  contract: Tool<unknown, unknown>,
  maxPhysicalInvocations: number,
): WorkspaceTechnicalBudgetToolPolicy {
  if (
    !Number.isSafeInteger(maxPhysicalInvocations) ||
    maxPhysicalInvocations < 1 ||
    !Number.isSafeInteger(contract.cost.estimatedCents) ||
    contract.cost.estimatedCents < 0
  ) {
    return unavailable();
  }
  return Object.freeze({
    toolId: contract.id,
    version: contract.version,
    maxPhysicalInvocations,
    estimatedCents: contract.cost.estimatedCents,
    costUnit: contract.cost.unit,
  });
}

function contract<I, O>(value: Tool<I, O>): Tool<unknown, unknown> {
  return value as unknown as Tool<unknown, unknown>;
}

/**
 * One discovery run (POST /query-plans/:planId/execute): every model task and
 * tool wire the run can reserve, stage by stage, from the ceilings the
 * workflow and providers enforce. See discovery.workflow.ts for the stages.
 */
function discoveryRunEnvelope(
  request: WorkspaceExecutionBudgetRequest,
): WorkspaceTechnicalBudgetEnvelope {
  const queries = MAX_DISCOVERY_PLAN_QUERIES;
  const directoryPages = MAX_DIRECTORY_LISTING_PAGES * MAX_DIRECTORY_PAGINATION;
  const singleSearches = queries * MAX_SINGLE_SEARCH_WIRES_PER_QUERY;
  return ready(
    request,
    [
      // executeQuery: taxonomy cold path, then public_web and directory extraction.
      model(
        'taxonomy.normalize',
        queries * (MAX_QUERY_TAXONOMY_INDUSTRY_TERMS + MAX_QUERY_TAXONOMY_COUNTRY_TERMS),
      ),
      model('discovery.extract_company', queries * MAX_PUBLIC_WEB_DOMAINS_PER_QUERY),
      model('discovery.extract_list', queries * directoryPages),
      // profileWebsitesForRun: at most one trade-role classification per profiled company.
      model('discovery.classify_trade_role', MAX_DISCOVERY_PROFILE_COMPANIES),
      // qualifyFitForRun: one judgment per canonical company of the run.
      model('discovery.qualify_fit', MAX_DISCOVERY_FIT_COMPANIES),
    ],
    [
      tool(
        contract(searxngSearchTool),
        queries * (MAX_PUBLIC_WEB_SEARCHES_PER_QUERY + MAX_DIRECTORY_SEARCHES_PER_QUERY),
      ),
      tool(
        contract(crawl4aiFetchTool),
        queries * directoryPages +
          MAX_DISCOVERY_PROFILE_COMPANIES * MAX_WEBSITE_PROFILE_FETCHES_PER_COMPANY,
      ),
      tool(contract(wikidataTool), singleSearches),
      tool(contract(osmOverpassTool), singleSearches),
      tool(contract(tedSearchTool), singleSearches),
      tool(contract(openFdaSearchTool), singleSearches),
      tool(contract(tradeFairAlgoliaTool), queries * TRADE_FAIRS.length),
      // enrichRun: GLEIF and Wikidata facts for fit=match companies.
      tool(contract(gleifFetchTool), MAX_DISCOVERY_ENRICH_COMPANIES * MAX_GLEIF_FETCHES_PER_COMPANY),
      tool(
        contract(wikidataEntityTool),
        MAX_DISCOVERY_ENRICH_COMPANIES * MAX_WIKIDATA_ENTITY_READS_PER_COMPANY,
      ),
      // enrichSignalsRun (digital footprint + structured harvest), and profileWebsitesForRun:
      // the linked contact page of each profiled company (BI-14, switch company_contact).
      tool(
        contract(crawl4aiRenderTool),
        MAX_DISCOVERY_SIGNAL_COMPANIES *
          (MAX_DIGITAL_FOOTPRINT_RENDERS + MAX_STRUCTURED_HARVEST_RENDERS) +
          MAX_DISCOVERY_PROFILE_COMPANIES * MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY,
      ),
      tool(
        contract(httpGetTool),
        MAX_DISCOVERY_SIGNAL_COMPANIES * MAX_STRUCTURED_HARVEST_HTTP_GETS +
          MAX_DISCOVERY_WATCH_COMPANIES * MAX_SITEMAP_HTTP_GETS,
      ),
    ],
    {
      planQueries: queries,
      companyDiscoveryAdapters: MAX_COMPANY_DISCOVERY_ADAPTERS,
      providerRecords: MAX_DISCOVERY_PROVIDER_RECORDS,
      taxonomyIndustryTermsPerQuery: MAX_QUERY_TAXONOMY_INDUSTRY_TERMS,
      taxonomyCountryTermsPerQuery: MAX_QUERY_TAXONOMY_COUNTRY_TERMS,
      publicWebSearchesPerQuery: MAX_PUBLIC_WEB_SEARCHES_PER_QUERY,
      publicWebDomainsPerQuery: MAX_PUBLIC_WEB_DOMAINS_PER_QUERY,
      directorySearchesPerQuery: MAX_DIRECTORY_SEARCHES_PER_QUERY,
      directoryPagesPerQuery: directoryPages,
      tradeFairs: TRADE_FAIRS.length,
      fitCompanies: MAX_DISCOVERY_FIT_COMPANIES,
      profileCompanies: MAX_DISCOVERY_PROFILE_COMPANIES,
      enrichCompanies: MAX_DISCOVERY_ENRICH_COMPANIES,
      signalCompanies: MAX_DISCOVERY_SIGNAL_COMPANIES,
      watchCompanies: MAX_DISCOVERY_WATCH_COMPANIES,
    },
  );
}

/**
 * On-demand named-contact discovery for one company (M4): the worst-case fan-out of the six
 * contact adapters at their own enforced ceilings. Adapter bounds mirrored here:
 * - decision_maker: homepage + MAX_DECISION_MAKER_PAGES pages, one extraction per page;
 * - public_web: homepage + MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES linked pages (deterministic, no model);
 * - companies_house: MAX_COMPANIES_HOUSE_CONTACT_CALLS registry calls (search + officers);
 * - inpi_rne: one registry call;
 * - social_presence: MAX_SOCIAL_DORKS index searches + MAX_SOCIAL_PROFILE_FETCHES candidates ×
 *   MAX_SOCIAL_FETCHES_PER_CANDIDATE fetches (wayback availability + archive + live), one
 *   extraction per fetched page;
 * - bigquery_patents: one BigQuery call (cache mode may skip it).
 * The cap is a reservation ceiling, not the D5 spend target: actual usage settles per call, so a
 * company that hits fewer adapters spends far less.
 */
function contactDiscoveryEnvelope(
  request: WorkspaceExecutionBudgetRequest,
): WorkspaceTechnicalBudgetEnvelope {
  const decisionMakerFetches = 1 + MAX_DECISION_MAKER_PAGES;
  const publicWebFetches = 1 + MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES;
  const extractInvocations = MAX_DECISION_MAKER_PAGES + MAX_SOCIAL_PROFILE_FETCHES;
  const socialFetches = MAX_SOCIAL_PROFILE_FETCHES * MAX_SOCIAL_FETCHES_PER_CANDIDATE;
  return ready(
    request,
    [model('contact.find_decision_makers', extractInvocations)],
    [
      tool(contract(crawl4aiFetchTool), decisionMakerFetches + publicWebFetches),
      tool(contract(socialSearchTool), MAX_SOCIAL_DORKS),
      tool(contract(socialFetchTool), socialFetches),
      tool(contract(companiesHouseSearchTool), MAX_COMPANIES_HOUSE_CONTACT_CALLS),
      tool(contract(inpiRneSearchTool), 1),
      tool(contract(googlePatentsSearchTool), 1),
    ],
    {
      adapters: MAX_CONTACT_DISCOVERY_ADAPTERS,
      contactsPerAdapter: MAX_CONTACTS_PER_DISCOVERY_ADAPTER,
      decisionMakerPages: MAX_DECISION_MAKER_PAGES,
      publicWebLinkedPages: MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES,
      socialDorks: MAX_SOCIAL_DORKS,
      socialProfileFetches: MAX_SOCIAL_PROFILE_FETCHES,
      socialFetchesPerCandidate: MAX_SOCIAL_FETCHES_PER_CANDIDATE,
      modelLogicalInvocations: extractInvocations,
    },
  );
}

/** Seller understanding (POST /companies): homepage + subpages, per-page extraction. */
function understandingRunEnvelope(
  request: WorkspaceExecutionBudgetRequest,
): WorkspaceTechnicalBudgetEnvelope {
  const pages = 1 + MAX_UNDERSTANDING_SUBPAGES;
  return ready(
    request,
    [
      model('company_understanding.extract_claims', pages),
      model('company_understanding.extract_offerings', pages),
      model('company_understanding.extract_profile', 1),
    ],
    [tool(contract(crawl4aiFetchTool), pages)],
    { pages, subpages: MAX_UNDERSTANDING_SUBPAGES },
  );
}

function positiveBound(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid();
  }
  return value as number;
}

function emailGuessBounds(body: unknown): Readonly<{
  contacts: number;
  probesPerContact: number;
}> {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return invalid();
  }
  const record = (body ?? {}) as Record<string, unknown>;
  return Object.freeze({
    contacts: positiveBound(
      record.maxContacts,
      MAX_EMAIL_GUESS_CONTACTS,
      MAX_EMAIL_GUESS_CONTACTS,
    ),
    probesPerContact: positiveBound(
      record.maxProbe,
      MAX_EMAIL_PROBE_CANDIDATES,
      MAX_EMAIL_PROBE_CANDIDATES,
    ),
  });
}

function policy(
  request: WorkspaceExecutionBudgetRequest,
  models: readonly WorkspaceTechnicalBudgetModelPolicy[],
  tools: readonly WorkspaceTechnicalBudgetToolPolicy[],
  executionLimits: Readonly<Record<string, number>>,
): WorkspaceTechnicalBudgetPolicy {
  return Object.freeze({
    schemaVersion: 'workspace-execution-envelope/v1',
    requestScopeVersion: 'workspace-execution-budget-request-scope/v1',
    operation: request.operation,
    costBasis: 'backend_reservation_ceiling',
    currency: 'USD',
    unit: 'microusd',
    microUsdPerCent: MICROUSD_PER_CENT.toString(),
    representationMinimumMicrousd:
      REPRESENTATION_MINIMUM_MICROUSD.toString(),
    models: Object.freeze([...models]),
    tools: Object.freeze([...tools]),
    executionLimits: Object.freeze({ ...executionLimits }),
  });
}

function capMicrousd(value: WorkspaceTechnicalBudgetPolicy): bigint {
  const modelCents = value.models.reduce(
    (sum, item) =>
      sum +
      BigInt(item.logicalInvocations) *
        BigInt(item.structuredWireUpperBound) *
        BigInt(item.maxCostCents),
    0n,
  );
  const toolCents = value.tools.reduce(
    (sum, item) =>
      sum + BigInt(item.maxPhysicalInvocations) * BigInt(item.estimatedCents),
    0n,
  );
  const calculated = (modelCents + toolCents) * MICROUSD_PER_CENT;
  return calculated > 0n ? calculated : REPRESENTATION_MINIMUM_MICROUSD;
}

function ready(
  request: WorkspaceExecutionBudgetRequest,
  models: readonly WorkspaceTechnicalBudgetModelPolicy[],
  tools: readonly WorkspaceTechnicalBudgetToolPolicy[],
  executionLimits: Readonly<Record<string, number>>,
): WorkspaceTechnicalBudgetEnvelope {
  const manifest = policy(request, models, tools, executionLimits);
  return Object.freeze({
    requiredCapMicrousd: capMicrousd(manifest),
    policy: manifest,
  });
}

export function resolveWorkspaceTechnicalBudgetEnvelope(
  request: WorkspaceExecutionBudgetRequest,
): WorkspaceTechnicalBudgetEnvelope {
  switch (request.operation) {
    case 'POST /companies/:companyId/icps':
      return ready(request, [model('icp.design', 1)], [], {
        modelLogicalInvocations: 1,
      });
    case 'POST /leads/:leadId/outreach-drafts':
      // One bounded structured call per draft; the schema repair retry is the second wire.
      return ready(request, [model('outreach.first_contact_draft', 1)], [], {
        modelLogicalInvocations: 1,
      });
    case 'POST /icps/:icpId/query-plans': {
      const taxonomyLogicalInvocations =
        MAX_QUERY_PLAN_INDUSTRY_TERMS * TAXONOMY_INDUSTRY_PASSES +
        MAX_QUERY_PLAN_TARGET_COUNTRIES +
        TAXONOMY_PRODUCT_REFINEMENTS;
      return ready(
        request,
        [
          model('discovery.query_plan', 1),
          model('taxonomy.normalize', taxonomyLogicalInvocations),
        ],
        [],
        {
          industryTermsPerPass: MAX_QUERY_PLAN_INDUSTRY_TERMS,
          targetCountries: MAX_QUERY_PLAN_TARGET_COUNTRIES,
          taxonomyIndustryPasses: TAXONOMY_INDUSTRY_PASSES,
          taxonomyProductRefinements: TAXONOMY_PRODUCT_REFINEMENTS,
        },
      );
    }
    case 'POST /canonical-companies/:id/guess-emails': {
      const bounds = emailGuessBounds(request.body);
      const invocations = bounds.contacts * bounds.probesPerContact;
      return ready(
        request,
        [],
        [tool(smtpRcptProbeTool as Tool<unknown, unknown>, invocations)],
        {
          contacts: bounds.contacts,
          probesPerContact: bounds.probesPerContact,
          mxDnsReads: invocations,
          smtpRcptCommands: invocations * 2,
        },
      );
    }
    case 'POST /contact-points/:pointId/verify':
      return ready(
        request,
        [],
        [
          tool(
            smtpRcptProbeTool as Tool<unknown, unknown>,
            MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          ),
        ],
        {
          verifierInvocations: MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          mxDnsReads: MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET,
          smtpRcptCommands:
            MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET * 2,
        },
      );
    case 'POST /companies':
      return understandingRunEnvelope(request);
    case 'POST /companies/:companyId/understanding/retry':
      return understandingRunEnvelope(request);
    case 'POST /query-plans/:planId/execute':
      return discoveryRunEnvelope(request);
    case 'POST /canonical-companies/:id/discover-contacts':
      // M4: on-demand contact discovery gets its own bounded per-company envelope (D5 bounds)
      // instead of fail-closed; actual spend still settles per call against the workspace ledger.
      return contactDiscoveryEnvelope(request);
  }
}
