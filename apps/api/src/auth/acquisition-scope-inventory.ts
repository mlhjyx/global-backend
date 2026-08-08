import type { AuthScope } from './auth-scopes';

function scopes(...values: readonly [AuthScope, ...AuthScope[]]): readonly [AuthScope, ...AuthScope[]] {
  return Object.freeze([...values]) as readonly [AuthScope, ...AuthScope[]];
}

function controllerInventory<const Operations extends Record<string, readonly [AuthScope, ...AuthScope[]]>>(
  file: string,
  operations: Operations,
) {
  return Object.freeze({ file, operations: Object.freeze({ ...operations }) });
}

/**
 * Machine-checked authorization inventory for every acquisition/compliance HTTP operation.
 * Controllers consume these exact lists, and the inventory test rejects unlisted routes.
 */
export const ACQUISITION_CONTROLLER_SCOPE_INVENTORY = Object.freeze({
  CompanyController: controllerInventory('company/company.controller.ts', {
    create: scopes('acquisition:write', 'personal-data:read'),
    list: scopes('acquisition:read', 'personal-data:read'),
    get: scopes('acquisition:read', 'personal-data:read'),
    completeness: scopes('acquisition:read'),
    confirm: scopes('acquisition:review', 'personal-data:read'),
    listOfferings: scopes('acquisition:read'),
  }),
  ClaimController: controllerInventory('claim/claim.controller.ts', {
    list: scopes('acquisition:read'),
    approve: scopes('acquisition:review'),
    reject: scopes('acquisition:review'),
    createManual: scopes('acquisition:write'),
    revoke: scopes('acquisition:review'),
    listConflicts: scopes('acquisition:read'),
    resolveConflict: scopes('acquisition:review'),
  }),
  IcpController: controllerInventory('icp/icp.controller.ts', {
    generate: scopes('acquisition:write'),
    list: scopes('acquisition:read'),
    get: scopes('acquisition:read'),
    activate: scopes('acquisition:review'),
    update: scopes('acquisition:write'),
    addRule: scopes('acquisition:write'),
    updateRule: scopes('acquisition:write'),
    deleteRule: scopes('acquisition:write'),
    runBacktest: scopes('acquisition:write'),
    listBacktests: scopes('acquisition:read'),
    generateQueryPlan: scopes('acquisition:write'),
    listQueryPlans: scopes('acquisition:read'),
    confirmQueryPlan: scopes('acquisition:review'),
  }),
  DiscoveryController: controllerInventory('discovery/discovery.controller.ts', {
    execute: scopes('acquisition:write'),
    getRun: scopes('acquisition:read'),
    listCompanies: scopes('acquisition:read', 'personal-data:read'),
    getCompany: scopes('acquisition:read', 'personal-data:read'),
    discoverContacts: scopes('acquisition:write', 'personal-data:read'),
    verify: scopes('acquisition:write', 'personal-data:read', 'compliance:manage'),
    guessEmails: scopes('acquisition:write', 'personal-data:read', 'compliance:manage'),
    addSuppression: scopes('compliance:manage'),
    listSuppressions: scopes('compliance:manage'),
    removeSuppression: scopes('compliance:manage'),
    listProviders: scopes('ops:read'),
  }),
  LeadController: controllerInventory('lead/lead.controller.ts', {
    qualify: scopes('acquisition:write'),
    list: scopes('acquisition:read'),
    queues: scopes('acquisition:read'),
    get: scopes('acquisition:read', 'personal-data:read'),
    accept: scopes('acquisition:review', 'personal-data:read'),
    reject: scopes('acquisition:review'),
    sanctionsReview: scopes('compliance:manage'),
  }),
  EventsController: controllerInventory('events/events.controller.ts', {
    list: scopes('acquisition:read', 'personal-data:read'),
    ack: scopes('acquisition:event:ack'),
  }),
  DeletionController: controllerInventory('compliance/deletion.controller.ts', {
    create: scopes('compliance:manage'),
    get: scopes('compliance:manage'),
  }),
});

/** Explicit boundary: System diagnostics and Site Builder need their own future scope design. */
export const NON_ACQUISITION_CONTROLLER_EXEMPTIONS = Object.freeze([
  'health/health.controller.ts',
  'whoami/whoami.controller.ts',
  'site-builder/assets.controller.ts',
  'site-builder/builds.controller.ts',
  'site-builder/intake.controller.ts',
  'site-builder/kb.controller.ts',
  'site-builder/site-preview.controller.ts',
  'site-builder/sites.controller.ts',
]);
