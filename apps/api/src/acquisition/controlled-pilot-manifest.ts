import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import {
  COMPANY_IDENTITY_RULE_VERSION,
  resolveCompanyIdentity,
  type CompanyIdentityCandidate,
  type CompanyIdentityEvidence,
} from '../discovery/identity';

export const ACQUISITION_PILOT_ALLOWED_SOURCES = Object.freeze(['ted', 'gleif', 'public_web'] as const);
export const ACQUISITION_PILOT_FORBIDDEN_SOURCES = Object.freeze([
  'trade_fair',
  'google_patents',
  'samgov',
  'email_guess',
  'named_person',
  'customs',
  'trade_data',
  'campaign',
  'outreach',
  'publish',
  'openfda',
] as const);
export const ACQUISITION_PILOT_CAPS = Object.freeze({
  rawRecords: 50,
  canonicalCompanies: 30,
  enrichedCompanies: 10,
  humanReviewedCompanies: 5,
  leadQualifiedPackages: 3,
  externalRequests: 0,
  modelCalls: 0,
  repairs: 0,
  inputTokens: 0,
  outputTokens: 0,
  maxCostCents: 0,
});

const FIXTURE_CONTRACT = 'acquisition-identity-pilot-fixture/2026-08-07-v1' as const;
const MANIFEST_CONTRACT = 'acquisition-identity-pilot-prep-manifest/2026-08-07-v1' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  /\bbearer\s+[a-z0-9._~+/=-]{8,}\b/i,
  /\bsk-[a-z0-9_-]{16,}\b/i,
  /\b(?:ghp|github_pat)_[a-z0-9_]{20,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/i,
] as const);

export interface ControlledPilotFixtureRecord {
  fixtureId: string;
  source: 'ted' | 'public_web';
  incoming: CompanyIdentityEvidence;
  candidates: CompanyIdentityCandidate[];
  expectedDecision: 'AUTO_LINK' | 'REVIEW_LINK';
}

export interface ControlledPilotFixture {
  contractVersion: typeof FIXTURE_CONTRACT;
  classification: 'SYNTHETIC_PUBLIC_SAFE';
  workspace: { id: string; label: string };
  companyOffering: {
    id: string;
    companyName: string;
    offeringName: string;
    classification: 'SYNTHETIC';
  };
  icp: {
    id: string;
    version: 1;
    name: string;
    country: 'DE';
    region: 'EU';
    productTerms: string[];
    buyerOrganizationTypes: string[];
  };
  records: ControlledPilotFixtureRecord[];
  enrichmentSource: 'gleif';
}

export interface ControlledPilotManifest {
  contractVersion: typeof MANIFEST_CONTRACT;
  artifactKind: 'IDENTITY_PILOT_PREP_CREATE_ONLY_MANIFEST';
  purpose: 'identity/pilot-prep create-only manifest';
  realExecutionManifest: false;
  mode: 'CREATE_ONLY';
  dispatchAuthorization: 'NOT_AUTHORIZED';
  dispatchCapable: false;
  actualNetworkCalls: 0;
  actualModelCalls: 0;
  containsCredentials: false;
  containsPersonalData: false;
  sourceCommit: string;
  expiresAt: string;
  fixture: { path: string; contractVersion: typeof FIXTURE_CONTRACT; sha256: string };
  scope: {
    workspaceIds: [string];
    companyOfferingIds: [string];
    icpIds: [string];
    icpVersions: [1];
    countries: ['DE'];
    regions: ['EU'];
    allowedSources: typeof ACQUISITION_PILOT_ALLOWED_SOURCES;
    forbiddenSources: typeof ACQUISITION_PILOT_FORBIDDEN_SOURCES;
  };
  caps: typeof ACQUISITION_PILOT_CAPS;
  nextStage: {
    requiresCurrentTaskGraphManifest: true;
    requiresSeparateCostAuthorization: true;
    dispatchAuthorization: 'NOT_AUTHORIZED';
  };
}

export function validateControlledPilotFixture(value: unknown): ControlledPilotFixture {
  const root = record(value, 'fixture');
  exactKeys(root, ['contractVersion', 'classification', 'workspace', 'companyOffering', 'icp', 'records', 'enrichmentSource'], 'fixture');
  if (root.contractVersion !== FIXTURE_CONTRACT) fail('fixture contractVersion');
  if (root.classification !== 'SYNTHETIC_PUBLIC_SAFE') fail('fixture classification');
  if (root.enrichmentSource !== 'gleif') fail('fixture enrichment source');
  rejectSensitiveMaterial(root, 'fixture');

  const workspace = record(root.workspace, 'workspace');
  exactKeys(workspace, ['id', 'label'], 'workspace');
  uuid(workspace.id, 'workspace.id');
  text(workspace.label, 'workspace.label');

  const offering = record(root.companyOffering, 'companyOffering');
  exactKeys(offering, ['id', 'companyName', 'offeringName', 'classification'], 'companyOffering');
  uuid(offering.id, 'companyOffering.id');
  text(offering.companyName, 'companyOffering.companyName');
  text(offering.offeringName, 'companyOffering.offeringName');
  if (offering.classification !== 'SYNTHETIC') fail('companyOffering must be synthetic');

  const icp = record(root.icp, 'icp');
  exactKeys(icp, ['id', 'version', 'name', 'country', 'region', 'productTerms', 'buyerOrganizationTypes'], 'icp');
  uuid(icp.id, 'icp.id');
  if (icp.version !== 1 || icp.country !== 'DE' || icp.region !== 'EU') fail('ICP must be version 1 for DE/EU');
  text(icp.name, 'icp.name');
  stringArray(icp.productTerms, 'icp.productTerms');
  stringArray(icp.buyerOrganizationTypes, 'icp.buyerOrganizationTypes');

  if (!Array.isArray(root.records)) fail('fixture records must be an array');
  const records = root.records.map((item, index) => validateFixtureRecord(item, index));
  if (records.length !== 4) fail('fixture records must contain four closed cases');
  if (new Set(records.map((item) => item.fixtureId)).size !== records.length) fail('fixtureId must be unique');
  if (!records.some((item) => item.source === 'ted') || !records.some((item) => item.source === 'public_web')) {
    fail('fixture sources must cover ted and public_web');
  }

  return deepFreeze(clone(root)) as unknown as ControlledPilotFixture;
}

function validateFixtureRecord(value: unknown, index: number): ControlledPilotFixtureRecord {
  const item = record(value, `records[${index}]`);
  exactKeys(item, ['fixtureId', 'source', 'incoming', 'candidates', 'expectedDecision'], `records[${index}]`);
  text(item.fixtureId, `records[${index}].fixtureId`);
  if (item.source !== 'ted' && item.source !== 'public_web') fail(`records[${index}] source`);
  if (item.expectedDecision !== 'AUTO_LINK' && item.expectedDecision !== 'REVIEW_LINK') {
    fail(`records[${index}] expectedDecision`);
  }
  const incoming = companyEvidence(item.incoming, `records[${index}].incoming`);
  if (!Array.isArray(item.candidates)) fail(`records[${index}].candidates`);
  const candidates = item.candidates.map((candidate, candidateIndex) =>
    companyCandidate(candidate, `records[${index}].candidates[${candidateIndex}]`),
  );
  const decision = resolveCompanyIdentity({
    context: {
      ruleVersion: COMPANY_IDENTITY_RULE_VERSION,
      actor: { type: 'SYSTEM', id: 'acquisition.fixtureValidator' },
      decidedAt: '2026-08-07T00:00:00.000Z',
      evidence: [{ type: 'RAW_RECORD', id: String(item.fixtureId) }],
    },
    incoming,
    candidates,
  });
  if (decision.decision !== item.expectedDecision) fail(`records[${index}] expected decision drift`);
  return item as unknown as ControlledPilotFixtureRecord;
}

export function buildControlledPilotManifest(input: {
  fixture: ControlledPilotFixture;
  fixturePath: string;
  sourceCommit: string;
  expiresAt: string;
}): ControlledPilotManifest {
  const fixture = validateControlledPilotFixture(input.fixture);
  relativePath(input.fixturePath, 'fixturePath');
  commit(input.sourceCommit);
  isoTimestamp(input.expiresAt, 'expiresAt');
  return validateControlledPilotManifest({
    contractVersion: MANIFEST_CONTRACT,
    artifactKind: 'IDENTITY_PILOT_PREP_CREATE_ONLY_MANIFEST',
    purpose: 'identity/pilot-prep create-only manifest',
    realExecutionManifest: false,
    mode: 'CREATE_ONLY',
    dispatchAuthorization: 'NOT_AUTHORIZED',
    dispatchCapable: false,
    actualNetworkCalls: 0,
    actualModelCalls: 0,
    containsCredentials: false,
    containsPersonalData: false,
    sourceCommit: input.sourceCommit,
    expiresAt: input.expiresAt,
    fixture: {
      path: input.fixturePath,
      contractVersion: fixture.contractVersion,
      sha256: createHash('sha256').update(canonicalJson(fixture)).digest('hex'),
    },
    scope: {
      workspaceIds: [fixture.workspace.id],
      companyOfferingIds: [fixture.companyOffering.id],
      icpIds: [fixture.icp.id],
      icpVersions: [fixture.icp.version],
      countries: [fixture.icp.country],
      regions: [fixture.icp.region],
      allowedSources: ACQUISITION_PILOT_ALLOWED_SOURCES,
      forbiddenSources: ACQUISITION_PILOT_FORBIDDEN_SOURCES,
    },
    caps: ACQUISITION_PILOT_CAPS,
    nextStage: {
      requiresCurrentTaskGraphManifest: true,
      requiresSeparateCostAuthorization: true,
      dispatchAuthorization: 'NOT_AUTHORIZED',
    },
  });
}

export function validateControlledPilotManifest(value: unknown): ControlledPilotManifest {
  const root = record(value, 'manifest');
  exactKeys(root, [
    'contractVersion', 'artifactKind', 'purpose', 'realExecutionManifest', 'mode', 'dispatchAuthorization',
    'dispatchCapable', 'actualNetworkCalls', 'actualModelCalls', 'containsCredentials', 'containsPersonalData',
    'sourceCommit', 'expiresAt', 'fixture', 'scope', 'caps', 'nextStage',
  ], 'manifest');
  if (root.contractVersion !== MANIFEST_CONTRACT || root.artifactKind !== 'IDENTITY_PILOT_PREP_CREATE_ONLY_MANIFEST') fail('manifest identity');
  if (root.purpose !== 'identity/pilot-prep create-only manifest' || root.realExecutionManifest !== false) fail('manifest purpose');
  if (root.mode !== 'CREATE_ONLY' || root.dispatchAuthorization !== 'NOT_AUTHORIZED' || root.dispatchCapable !== false) fail('manifest authorization');
  if (root.actualNetworkCalls !== 0 || root.actualModelCalls !== 0) fail('manifest actual calls must be zero');
  if (root.containsCredentials !== false || root.containsPersonalData !== false) fail('manifest data boundary');
  commit(root.sourceCommit);
  isoTimestamp(root.expiresAt, 'expiresAt');

  const fixture = record(root.fixture, 'manifest.fixture');
  exactKeys(fixture, ['path', 'contractVersion', 'sha256'], 'manifest.fixture');
  relativePath(fixture.path, 'manifest.fixture.path');
  if (fixture.contractVersion !== FIXTURE_CONTRACT || typeof fixture.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(fixture.sha256)) fail('manifest fixture binding');

  const scope = record(root.scope, 'manifest.scope');
  exactKeys(scope, ['workspaceIds', 'companyOfferingIds', 'icpIds', 'icpVersions', 'countries', 'regions', 'allowedSources', 'forbiddenSources'], 'manifest.scope');
  oneUuid(scope.workspaceIds, 'workspaceIds');
  oneUuid(scope.companyOfferingIds, 'companyOfferingIds');
  oneUuid(scope.icpIds, 'icpIds');
  exactArray(scope.icpVersions, [1], 'icpVersions');
  exactArray(scope.countries, ['DE'], 'countries');
  exactArray(scope.regions, ['EU'], 'regions');
  exactArray(scope.allowedSources, ACQUISITION_PILOT_ALLOWED_SOURCES, 'allowedSources');
  exactArray(scope.forbiddenSources, ACQUISITION_PILOT_FORBIDDEN_SOURCES, 'forbiddenSources');

  const caps = record(root.caps, 'manifest.caps');
  exactKeys(caps, Object.keys(ACQUISITION_PILOT_CAPS), 'manifest.caps');
  if (canonicalJson(caps) !== canonicalJson(ACQUISITION_PILOT_CAPS)) fail('manifest caps');
  const nextStage = record(root.nextStage, 'manifest.nextStage');
  exactKeys(nextStage, ['requiresCurrentTaskGraphManifest', 'requiresSeparateCostAuthorization', 'dispatchAuthorization'], 'manifest.nextStage');
  if (nextStage.requiresCurrentTaskGraphManifest !== true || nextStage.requiresSeparateCostAuthorization !== true || nextStage.dispatchAuthorization !== 'NOT_AUTHORIZED') fail('next-stage gates');
  return deepFreeze(clone(root)) as unknown as ControlledPilotManifest;
}

export async function writeControlledPilotManifestCreateOnly(path: string, value: ControlledPilotManifest): Promise<void> {
  const manifest = validateControlledPilotManifest(value);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readControlledPilotFixture(path: string): Promise<ControlledPilotFixture> {
  return validateControlledPilotFixture(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

function companyEvidence(value: unknown, label: string): CompanyIdentityEvidence {
  const item = record(value, label);
  exactKeys(item, ['name', 'legalName', 'domain', 'country', 'identifier', 'sharedGroupAmbiguity'], label, true);
  text(item.name, `${label}.name`);
  optionalText(item.legalName, `${label}.legalName`);
  optionalSyntheticDomain(item.domain, `${label}.domain`);
  optionalText(item.country, `${label}.country`);
  optionalBoolean(item.sharedGroupAmbiguity, `${label}.sharedGroupAmbiguity`);
  if (item.identifier != null) identifier(item.identifier, `${label}.identifier`);
  return item as unknown as CompanyIdentityEvidence;
}

function companyCandidate(value: unknown, label: string): CompanyIdentityCandidate {
  const item = record(value, label);
  exactKeys(item, ['dedupeKey', 'name', 'legalName', 'domain', 'country', 'sharedGroupAmbiguity'], label, true);
  text(item.dedupeKey, `${label}.dedupeKey`);
  text(item.name, `${label}.name`);
  optionalText(item.legalName, `${label}.legalName`);
  optionalSyntheticDomain(item.domain, `${label}.domain`);
  optionalText(item.country, `${label}.country`);
  optionalBoolean(item.sharedGroupAmbiguity, `${label}.sharedGroupAmbiguity`);
  return item as unknown as CompanyIdentityCandidate;
}

function identifier(value: unknown, label: string): void {
  const item = record(value, label);
  exactKeys(item, ['scheme', 'value'], label);
  text(item.scheme, `${label}.scheme`);
  text(item.value, `${label}.value`);
}

function rejectSensitiveMaterial(value: unknown, label: string): void {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSensitiveMaterial(item, `${label}[${index}]`));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      if (/[^\s@]+@[^\s@]+/.test(value)) fail(`${label} contains personal data`);
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
        fail(`${label} contains credential-like value`);
      }
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(api.?key|secret|password|token|credential|bearer|operator.?email|named.?person|phone)/i.test(key)) {
      fail(`${label} contains forbidden field ${key}`);
    }
    rejectSensitiveMaterial(nested, `${label}.${key}`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, optional = false): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) fail(`${label} unknown field ${unknown.join(',')}`);
  if (!optional) {
    const missing = allowed.filter((key) => !(key in value));
    if (missing.length) fail(`${label} missing field ${missing.join(',')}`);
  }
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be non-empty text`);
}
function optionalText(value: unknown, label: string): void { if (value != null) text(value, label); }
function optionalBoolean(value: unknown, label: string): void { if (value != null && typeof value !== 'boolean') fail(`${label} must be boolean`); }
function optionalSyntheticDomain(value: unknown, label: string): void {
  if (value == null) return;
  text(value, label);
  if (!String(value).toLowerCase().endsWith('.example')) fail(`${label} must use the reserved .example suffix`);
}
function stringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) fail(`${label} must be a non-empty string array`);
}
function uuid(value: unknown, label: string): void { if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} must be UUID`); }
function oneUuid(value: unknown, label: string): void { if (!Array.isArray(value) || value.length !== 1) fail(`${label} must contain exactly one item`); uuid(value[0], label); }
function commit(value: unknown): void { if (typeof value !== 'string' || !COMMIT.test(value)) fail('sourceCommit must be a lowercase 40-hex commit'); }
function isoTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${label} must be canonical ISO-8601`);
}
function relativePath(value: unknown, label: string): void {
  text(value, label);
  if (String(value).startsWith('/') || String(value).split('/').includes('..')) fail(`${label} must be repository-relative`);
}
function exactArray(value: unknown, expected: readonly unknown[], label: string): void {
  if (!Array.isArray(value) || canonicalJson(value) !== canonicalJson(expected)) fail(`${label} is outside the frozen scope`);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function fail(message: string): never { throw new Error(message); }
