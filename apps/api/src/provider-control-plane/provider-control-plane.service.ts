import { Injectable, Optional } from '@nestjs/common';
import type { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { PROVIDER_CONTROL_CATALOG, type ProviderControlDescriptor } from './provider-control-plane.catalog';
import type { ProviderControlPlaneResponseDto } from './provider-control-plane.dto';

type CredentialPresenceReader = (envKey: string) => boolean;

type ProviderRow = { key: string; status: string };
type PolicyRow = {
  domain: string;
  reviewStatus: string;
  allowedPurpose: unknown;
  robotsStatus: string;
  termsStatus: string;
  personalData: boolean;
  updatedAt: Date;
};
type QualityRow = {
  providerKey: string;
  runId: string;
  terminalStatus: string;
  rawCount: number;
  acceptedCount: number | null;
  boundCount: number | null;
  domainCount: number | null;
  authorityCount: number | null;
  conflictCount: number | null;
  duplicateCount: number;
  completedAt: Date;
};

const ACTION_REASON_CODES = Object.freeze([
  'FORMAL_SAAS_CONTROL_PLANE_UNAVAILABLE',
  'SECRET_STORE_UNAVAILABLE',
  'CONNECTION_PROBE_NOT_IMPLEMENTED',
  'PLATFORM_MUTATION_NOT_EXPOSED',
] as const);

function defaultCredentialPresence(envKey: string): boolean {
  return Boolean(process.env[envKey]?.trim());
}

function credentialPresence(
  provider: ProviderControlDescriptor,
  reader: CredentialPresenceReader,
) {
  if (provider.credentialRequirement === 'NOT_REQUIRED') {
    return { requirement: 'NOT_REQUIRED' as const, status: 'NOT_REQUIRED' as const, fields: [] };
  }
  try {
    const fields = provider.credentials.map(({ key, label, envKey, secret, writeOnly }) => ({
      key,
      label,
      configured: reader(envKey),
      secret,
      writeOnly,
    }));
    if (provider.credentialEvaluation === 'UNKNOWN') {
      return {
        requirement: provider.credentialRequirement,
        status: 'UNKNOWN' as const,
        fields,
      };
    }
    const configured = fields.length > 0 && fields.every((field) => field.configured);
    return {
      requirement: provider.credentialRequirement,
      status: configured ? ('LEGACY_EXTERNAL' as const) : ('MISSING' as const),
      fields,
    };
  } catch {
    return {
      requirement: provider.credentialRequirement,
      status: 'UNKNOWN' as const,
      fields: provider.credentials.map(({ key, label, secret, writeOnly }) => ({
        key,
        label,
        configured: false,
        secret,
        writeOnly,
      })),
    };
  }
}

function policyView(provider: Pick<ProviderControlDescriptor, 'policy'>, byDomain: Map<string, PolicyRow>) {
  if (provider.policy.mode === 'NONE') {
    return { mode: provider.policy.mode, status: 'NOT_REQUIRED' as const, domains: [] };
  }
  if (provider.policy.domains.length === 0) {
    return { mode: provider.policy.mode, status: 'UNKNOWN' as const, domains: [] };
  }
  const rows = provider.policy.domains.flatMap((domain) => {
    const row = byDomain.get(domain);
    if (!row) return [];
    return [{
      domain: row.domain,
      reviewStatus: row.reviewStatus,
      allowedPurpose: Array.isArray(row.allowedPurpose)
        ? row.allowedPurpose.filter((item): item is string => typeof item === 'string')
        : null,
      robotsStatus: row.robotsStatus,
      termsStatus: row.termsStatus,
      personalData: row.personalData,
      updatedAt: row.updatedAt.toISOString(),
    }];
  });
  let status:
    | 'READY'
    | 'MISSING'
    | 'SUSPENDED'
    | 'TERMS_UNREVIEWED'
    | 'TERMS_RESTRICTED'
    | 'ROBOTS_RESTRICTED'
    | 'ROBOTS_UNREVIEWED'
    | 'PURPOSE_BLOCKED' = 'READY';
  if (rows.some((row) => row.reviewStatus === 'SUSPENDED')) status = 'SUSPENDED';
  else if (rows.length !== provider.policy.domains.length) status = 'MISSING';
  else if (rows.some((row) => row.reviewStatus !== 'APPROVED')) return {
    mode: provider.policy.mode,
    status: 'UNKNOWN' as const,
    domains: rows,
  };
  else if (rows.some((row) => row.termsStatus === 'UNREVIEWED')) status = 'TERMS_UNREVIEWED';
  else if (rows.some((row) => row.termsStatus === 'REVIEWED_RESTRICTED')) status = 'TERMS_RESTRICTED';
  else if (rows.some((row) => row.termsStatus !== 'REVIEWED_OK')) return {
    mode: provider.policy.mode,
    status: 'UNKNOWN' as const,
    domains: rows,
  };
  else if (rows.some((row) => row.robotsStatus === 'RESTRICTS')) status = 'ROBOTS_RESTRICTED';
  else if (rows.some((row) => row.robotsStatus === 'UNREVIEWED')) status = 'ROBOTS_UNREVIEWED';
  else if (rows.some((row) => row.robotsStatus !== 'ALLOWS')) return {
    mode: provider.policy.mode,
    status: 'UNKNOWN' as const,
    domains: rows,
  };
  else if (
    rows.some(
      (row) => row.allowedPurpose !== null &&
        !row.allowedPurpose.some((purpose) => provider.policy.purposes.includes(purpose)),
    )
  ) status = 'PURPOSE_BLOCKED';
  else if (rows.some((row) => row.allowedPurpose === null)) return {
    mode: provider.policy.mode,
    status: 'UNKNOWN' as const,
    domains: rows,
  };
  return { mode: provider.policy.mode, status, domains: rows };
}

function searchBackendView(
  providerKey: string,
  reader: CredentialPresenceReader,
  byDomain: Map<string, PolicyRow>,
) {
  if (providerKey !== 'public_web') return [];
  const external = (
    id: 'serper.search' | 'brave.search',
    displayName: string,
    envKey: string,
    domain: string,
  ) => {
    let configured: boolean;
    try {
      configured = reader(envKey);
    } catch {
      configured = false;
    }
    const policyStatus = policyView({
      policy: { mode: 'REQUIRED', domains: [domain], purposes: ['discovery'] },
    }, byDomain).status;
    return {
      id,
      displayName,
      kind: 'BYOK' as const,
      credentialStatus: configured ? 'CONFIGURED' as const : 'MISSING' as const,
      policyStatus,
      routingStatus: configured && policyStatus === 'READY'
        ? 'OPT_IN_READY' as const
        : 'BLOCKED' as const,
    };
  };
  return [
    {
      id: 'searxng.search' as const,
      displayName: 'SearXNG',
      kind: 'SELF_HOSTED' as const,
      credentialStatus: 'NOT_REQUIRED' as const,
      policyStatus: 'NOT_REQUIRED' as const,
      routingStatus: 'DEFAULT' as const,
    },
    external('serper.search', 'Serper (Google)', 'SERPER_API_KEY', 'google.serper.dev'),
    external('brave.search', 'Brave Search', 'BRAVE_SEARCH_API_KEY', 'api.search.brave.com'),
  ];
}

function unknownPersisted() {
  return {
    status: 'UNKNOWN' as const,
    latestRunId: null,
    terminalStatus: null,
    completedAt: null,
    rawCount: null,
    acceptedCount: null,
    boundCount: null,
    domainCount: null,
    authorityCount: null,
    conflictCount: null,
    duplicateCount: null,
  };
}

function qualityTerminalStatus(value: string): 'DONE' | 'PARTIAL' | 'FAILED' {
  if (value === 'DONE' || value === 'PARTIAL' || value === 'FAILED') return value;
  throw new Error(`unexpected provider quality terminal status ${value}`);
}

@Injectable()
export class ProviderControlPlaneService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly readCredentialPresence: CredentialPresenceReader = defaultCredentialPresence,
  ) {}

  async list(ctx: RequestContext): Promise<ProviderControlPlaneResponseDto> {
    const policyDomains = [...new Set([
      ...PROVIDER_CONTROL_CATALOG.flatMap(({ policy }) => policy.domains),
      'google.serper.dev',
      'api.search.brave.com',
    ])];
    const [providerRows, policyRows, qualityRows] = await Promise.all([
      this.prisma.dataProvider.findMany({
        where: { key: { in: PROVIDER_CONTROL_CATALOG.map(({ key }) => key) } },
        select: { key: true, status: true },
        orderBy: { key: 'asc' },
        take: PROVIDER_CONTROL_CATALOG.length,
      }) as Promise<ProviderRow[]>,
      this.prisma.sourcePolicy.findMany({
        where: { domain: { in: policyDomains } },
        select: {
          domain: true,
          reviewStatus: true,
          allowedPurpose: true,
          robotsStatus: true,
          termsStatus: true,
          personalData: true,
          updatedAt: true,
        },
        orderBy: { domain: 'asc' },
      }) as Promise<PolicyRow[]>,
      this.prisma.withWorkspace(ctx.workspaceId, async (rawTx) => {
        const tx = rawTx as unknown as {
          providerQualityRunContribution: {
            findMany(args: object): Promise<QualityRow[]>;
          };
        };
        return tx.providerQualityRunContribution.findMany({
          select: {
            providerKey: true,
            runId: true,
            terminalStatus: true,
            rawCount: true,
            acceptedCount: true,
            boundCount: true,
            domainCount: true,
            authorityCount: true,
            conflictCount: true,
            duplicateCount: true,
            completedAt: true,
          },
          orderBy: [{ providerKey: 'asc' }, { completedAt: 'desc' }, { id: 'desc' }],
          distinct: ['providerKey'],
          take: PROVIDER_CONTROL_CATALOG.length,
        });
      }),
    ]);

    const enabledByKey = new Map(providerRows.map((row) => [row.key, row.status]));
    const policyByDomain = new Map(policyRows.map((row) => [row.domain, row]));
    const latestByProvider = Object.fromEntries(
      [...qualityRows]
        .reverse()
        .map((row) => [row.providerKey, row] as const),
    ) as Record<string, QualityRow | undefined>;

    const providers = PROVIDER_CONTROL_CATALOG.map((provider) => {
      const databaseStatus = enabledByKey.get(provider.key);
      if (databaseStatus !== undefined && databaseStatus !== 'ENABLED' && databaseStatus !== 'DISABLED') {
        throw new Error(`unexpected data_provider status for ${provider.key}`);
      }
      const enablementStatus: 'ENABLED' | 'DISABLED' | 'MISSING' =
        databaseStatus === 'ENABLED' || databaseStatus === 'DISABLED'
          ? databaseStatus
          : 'MISSING';
      const latest = latestByProvider[provider.key];
      const persisted = latest
        ? {
            status: 'AVAILABLE' as const,
            latestRunId: latest.runId,
            terminalStatus: qualityTerminalStatus(latest.terminalStatus),
            completedAt: latest.completedAt.toISOString(),
            rawCount: latest.rawCount,
            acceptedCount: latest.acceptedCount,
            boundCount: latest.boundCount,
            domainCount: latest.domainCount,
            authorityCount: latest.authorityCount,
            conflictCount: latest.conflictCount,
            duplicateCount: latest.duplicateCount,
          }
        : unknownPersisted();
      return {
        key: provider.key,
        displayName: provider.displayName,
        registration: {
          status: provider.registrationStatus,
          exposure: provider.exposure,
          region: provider.region,
          category: provider.category,
        },
        credentialPresence: credentialPresence(provider, this.readCredentialPresence),
        searchBackends: searchBackendView(provider.key, this.readCredentialPresence, policyByDomain),
        enablement: { status: enablementStatus },
        sourcePolicies: policyView(provider, policyByDomain),
        route: { ...provider.route, runtimeHealth: 'NOT_EVALUATED' as const },
        live: {
          status: 'NEVER_TESTED' as const,
          reasonCode: 'CONNECTION_PROBE_NOT_IMPLEMENTED' as const,
        },
        persisted,
        evidenceRail: {
          raw: latest ? (latest.rawCount > 0 ? 'PROVEN' as const : 'ZERO_RESULT' as const) : 'UNKNOWN' as const,
          canonicalBinding: latest?.boundCount === null || latest === undefined
            ? 'UNKNOWN' as const
            : latest.boundCount > 0
              ? 'PROVEN' as const
              : 'ZERO_RESULT' as const,
          evidence: 'UNAVAILABLE' as const,
          lead: 'UNAVAILABLE' as const,
          outbox: 'UNAVAILABLE' as const,
          replay: 'UNAVAILABLE' as const,
        },
        allowedActions: {
          canConfigureCredential: false as const,
          canEnable: false as const,
          canDisable: false as const,
          canTestConnection: false as const,
          reasonCodes: ACTION_REASON_CODES,
        },
      };
    });

    return {
      scope: {
        platform: ['registration', 'credentialPresence', 'searchBackends', 'enablement', 'sourcePolicies', 'route', 'live'],
        workspace: ['persisted', 'evidenceRail'],
      },
      providers,
    };
  }
}
