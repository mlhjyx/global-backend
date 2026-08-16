export type ProviderPolicyStatus =
  | 'READY'
  | 'MISSING'
  | 'SUSPENDED'
  | 'TERMS_UNREVIEWED'
  | 'TERMS_RESTRICTED'
  | 'ROBOTS_RESTRICTED'
  | 'ROBOTS_UNREVIEWED'
  | 'PURPOSE_BLOCKED'
  | 'NOT_REQUIRED'
  | 'UNKNOWN';

export type EvidenceProjectionStatus = 'PROVEN' | 'ZERO_RESULT' | 'UNKNOWN';

export class ProviderControlPlaneResponseDto {
  declare readonly scope: {
    readonly platform: readonly string[];
    readonly workspace: readonly string[];
  };

  declare readonly providers: readonly ProviderControlPlaneProviderDto[];
}

export class ProviderControlPlaneProviderDto {
  declare readonly key: string;
  declare readonly displayName: string;
  declare readonly registration: {
    readonly status: 'IMPLEMENTED' | 'PARTIAL';
    readonly exposure: 'REAL' | 'TEST_ONLY';
    readonly region: string;
    readonly category: string;
  };
  declare readonly credentialPresence: {
    readonly requirement: 'NOT_REQUIRED' | 'OPTIONAL' | 'REQUIRED';
    readonly status: 'NOT_REQUIRED' | 'CONFIGURED' | 'MISSING' | 'LEGACY_EXTERNAL' | 'UNKNOWN';
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly configured: boolean;
      readonly secret: boolean;
      readonly writeOnly: boolean;
    }[];
  };
  declare readonly searchBackends: readonly {
    readonly id: 'searxng.search' | 'serper.search' | 'brave.search';
    readonly displayName: string;
    readonly kind: 'SELF_HOSTED' | 'BYOK';
    readonly credentialStatus: 'NOT_REQUIRED' | 'CONFIGURED' | 'MISSING';
    readonly policyStatus: ProviderPolicyStatus;
    readonly routingStatus: 'DEFAULT' | 'OPT_IN_READY' | 'BLOCKED';
  }[];
  declare readonly enablement: {
    readonly status: 'ENABLED' | 'DISABLED' | 'MISSING';
  };
  declare readonly sourcePolicies: {
    readonly mode: 'NONE' | 'ADVISORY' | 'REQUIRED';
    readonly status: ProviderPolicyStatus;
    readonly domains: readonly {
      readonly domain: string;
      readonly reviewStatus: string;
      readonly allowedPurpose: readonly string[] | null;
      readonly robotsStatus: string;
      readonly termsStatus: string;
      readonly personalData: boolean;
      readonly updatedAt: string;
    }[];
  };
  declare readonly route: {
    readonly status: 'DECLARED' | 'TEST_ONLY';
    readonly lanes: readonly string[];
    readonly descriptor: string;
    readonly runtimeHealth: 'NOT_EVALUATED';
  };
  declare readonly live: {
    readonly status: 'UNKNOWN' | 'NEVER_TESTED';
    readonly reasonCode: 'CONNECTION_PROBE_NOT_IMPLEMENTED';
  };
  declare readonly persisted: {
    readonly status: 'AVAILABLE' | 'UNKNOWN';
    readonly latestRunId: string | null;
    readonly terminalStatus: 'DONE' | 'PARTIAL' | 'FAILED' | null;
    readonly completedAt: string | null;
    readonly rawCount: number | null;
    readonly acceptedCount: number | null;
    readonly boundCount: number | null;
    readonly domainCount: number | null;
    readonly authorityCount: number | null;
    readonly conflictCount: number | null;
    readonly duplicateCount: number | null;
  };
  declare readonly evidenceRail: {
    readonly raw: EvidenceProjectionStatus;
    readonly canonicalBinding: EvidenceProjectionStatus;
    readonly evidence: 'UNAVAILABLE';
    readonly lead: 'UNAVAILABLE';
    readonly outbox: 'UNAVAILABLE';
    readonly replay: 'UNAVAILABLE';
  };
  declare readonly allowedActions: {
    readonly canConfigureCredential: false;
    readonly canEnable: false;
    readonly canDisable: false;
    readonly canTestConnection: false;
    readonly reasonCodes: readonly (
      | 'FORMAL_SAAS_CONTROL_PLANE_UNAVAILABLE'
      | 'SECRET_STORE_UNAVAILABLE'
      | 'CONNECTION_PROBE_NOT_IMPLEMENTED'
      | 'PLATFORM_MUTATION_NOT_EXPOSED'
    )[];
  };
}

const closedObject = (required: string[], properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required,
  properties,
});

const nullableCount = { type: 'integer', minimum: 0, nullable: true };
const nullableString = { type: 'string', nullable: true };

export const PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA = closedObject(
  ['scope', 'providers'],
  {
    scope: closedObject(['platform', 'workspace'], {
      platform: { type: 'array', items: { type: 'string' } },
      workspace: { type: 'array', items: { type: 'string' } },
    }),
    providers: {
      type: 'array',
      items: closedObject(
        [
          'key', 'displayName', 'registration', 'credentialPresence', 'searchBackends',
          'enablement', 'sourcePolicies', 'route', 'live', 'persisted',
          'evidenceRail', 'allowedActions',
        ],
        {
          key: { type: 'string', pattern: '^[a-z0-9_]+$' },
          displayName: { type: 'string' },
          registration: closedObject(['status', 'exposure', 'region', 'category'], {
            status: { enum: ['IMPLEMENTED', 'PARTIAL'] },
            exposure: { enum: ['REAL', 'TEST_ONLY'] },
            region: { type: 'string' },
            category: { type: 'string' },
          }),
          credentialPresence: closedObject(['requirement', 'status', 'fields'], {
            requirement: { enum: ['NOT_REQUIRED', 'OPTIONAL', 'REQUIRED'] },
            status: { enum: ['NOT_REQUIRED', 'CONFIGURED', 'MISSING', 'LEGACY_EXTERNAL', 'UNKNOWN'] },
            fields: {
              type: 'array',
              items: closedObject(['key', 'label', 'configured', 'secret', 'writeOnly'], {
                key: { type: 'string' },
                label: { type: 'string' },
                configured: { type: 'boolean' },
                secret: { type: 'boolean' },
                writeOnly: { type: 'boolean' },
              }),
            },
          }),
          searchBackends: {
            type: 'array',
            items: closedObject(
              ['id', 'displayName', 'kind', 'credentialStatus', 'policyStatus', 'routingStatus'],
              {
                id: { enum: ['searxng.search', 'serper.search', 'brave.search'] },
                displayName: { type: 'string' },
                kind: { enum: ['SELF_HOSTED', 'BYOK'] },
                credentialStatus: { enum: ['NOT_REQUIRED', 'CONFIGURED', 'MISSING'] },
                policyStatus: { enum: ['READY', 'MISSING', 'SUSPENDED', 'TERMS_UNREVIEWED', 'TERMS_RESTRICTED', 'ROBOTS_RESTRICTED', 'ROBOTS_UNREVIEWED', 'PURPOSE_BLOCKED', 'NOT_REQUIRED', 'UNKNOWN'] },
                routingStatus: { enum: ['DEFAULT', 'OPT_IN_READY', 'BLOCKED'] },
              },
            ),
          },
          enablement: closedObject(['status'], { status: { enum: ['ENABLED', 'DISABLED', 'MISSING'] } }),
          sourcePolicies: closedObject(['mode', 'status', 'domains'], {
            mode: { enum: ['NONE', 'ADVISORY', 'REQUIRED'] },
            status: { enum: ['READY', 'MISSING', 'SUSPENDED', 'TERMS_UNREVIEWED', 'TERMS_RESTRICTED', 'ROBOTS_RESTRICTED', 'ROBOTS_UNREVIEWED', 'PURPOSE_BLOCKED', 'NOT_REQUIRED', 'UNKNOWN'] },
            domains: {
              type: 'array',
              items: closedObject(
                ['domain', 'reviewStatus', 'allowedPurpose', 'robotsStatus', 'termsStatus', 'personalData', 'updatedAt'],
                {
                  domain: { type: 'string' },
                  reviewStatus: { type: 'string' },
                  allowedPurpose: { type: 'array', nullable: true, items: { type: 'string' } },
                  robotsStatus: { type: 'string' },
                  termsStatus: { type: 'string' },
                  personalData: { type: 'boolean' },
                  updatedAt: { type: 'string', format: 'date-time' },
                },
              ),
            },
          }),
          route: closedObject(['status', 'lanes', 'descriptor', 'runtimeHealth'], {
            status: { enum: ['DECLARED', 'TEST_ONLY'] },
            lanes: { type: 'array', items: { type: 'string' } },
            descriptor: { type: 'string' },
            runtimeHealth: { enum: ['NOT_EVALUATED'] },
          }),
          live: closedObject(['status', 'reasonCode'], {
            status: { enum: ['UNKNOWN', 'NEVER_TESTED'] },
            reasonCode: { enum: ['CONNECTION_PROBE_NOT_IMPLEMENTED'] },
          }),
          persisted: closedObject(
            ['status', 'latestRunId', 'terminalStatus', 'completedAt', 'rawCount', 'acceptedCount', 'boundCount', 'domainCount', 'authorityCount', 'conflictCount', 'duplicateCount'],
            {
              status: { enum: ['AVAILABLE', 'UNKNOWN'] },
              latestRunId: nullableString,
              terminalStatus: { type: 'string', enum: ['DONE', 'PARTIAL', 'FAILED'], nullable: true },
              completedAt: { type: 'string', format: 'date-time', nullable: true },
              rawCount: nullableCount,
              acceptedCount: nullableCount,
              boundCount: nullableCount,
              domainCount: nullableCount,
              authorityCount: nullableCount,
              conflictCount: nullableCount,
              duplicateCount: nullableCount,
            },
          ),
          evidenceRail: closedObject(['raw', 'canonicalBinding', 'evidence', 'lead', 'outbox', 'replay'], {
            raw: { enum: ['PROVEN', 'ZERO_RESULT', 'UNKNOWN'] },
            canonicalBinding: { enum: ['PROVEN', 'ZERO_RESULT', 'UNKNOWN'] },
            evidence: { enum: ['UNAVAILABLE'] },
            lead: { enum: ['UNAVAILABLE'] },
            outbox: { enum: ['UNAVAILABLE'] },
            replay: { enum: ['UNAVAILABLE'] },
          }),
          allowedActions: closedObject(
            ['canConfigureCredential', 'canEnable', 'canDisable', 'canTestConnection', 'reasonCodes'],
            {
              canConfigureCredential: { type: 'boolean', enum: [false] },
              canEnable: { type: 'boolean', enum: [false] },
              canDisable: { type: 'boolean', enum: [false] },
              canTestConnection: { type: 'boolean', enum: [false] },
              reasonCodes: {
                type: 'array',
                items: {
                  enum: [
                    'FORMAL_SAAS_CONTROL_PLANE_UNAVAILABLE',
                    'SECRET_STORE_UNAVAILABLE',
                    'CONNECTION_PROBE_NOT_IMPLEMENTED',
                    'PLATFORM_MUTATION_NOT_EXPOSED',
                  ],
                },
              },
            },
          ),
        },
      ),
    },
  },
);
