import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { Optional } from '@nestjs/common';
// 必须是值导入：构造函数参数的类型元数据（design:paramtypes）据此生成 Nest 注入令牌；
// `import type` 会在编译期被擦除，参数类型退化为 Function，@Optional() 将永远注入 undefined，
// requestCrawl 在真实进程里恒返回 PLATFORM_TEMPORAL_UNAVAILABLE（单测直接 new 时无法暴露）。
import { PlatformTemporalClient } from '../temporal/platform-temporal.client';
import { channelCrawlRequestSha256 } from '../temporal/platform-crawl-grant.client';
import {
  CHANNEL_RUN_MAX_PAGES,
} from './channel-config';
import { PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256 } from '../platform-authority/platform-authority-policy-asset';
import {
  CHANNEL_CRAWL_CONTRACT_VERSION,
  CHANNEL_CRAWL_WORKFLOW_TYPE,
  type ChannelCrawlWorkflowInput,
} from '../temporal/platform-channel-crawl';
import { recordChannelRunInTransaction } from './channel-run-recorder';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { companyIdentity } from '../discovery/identity';
import { companyMatchesSuppression } from '../discovery/suppression-value';
import {
  CHANNEL_CATEGORIES,
  CHANNEL_MODES,
  CHANNEL_ROBOTS_POLICIES,
  CHANNEL_STATUSES,
  ChannelConfigError,
  parseChannelConfig,
} from './channel-config';
import { Inject, Optional as OptionalDep } from '@nestjs/common';
import {
  CHANNEL_MANIFEST_VERSION,
  ChannelManifestError,
  collectAuthRefs,
  manifestSha256,
  parseChannelManifest,
} from './connector/channel-manifest';
import { CHANNEL_SECRET_RESOLVER, type ChannelSecretResolver } from './connector/secret-resolver';
import { describeAuthSecrets } from './channel-probe.service';
import {
  deriveSourcePolicyDrafts,
  evaluateChannelSourcePolicyGate,
  isOfficialSourceHost,
  sourcePolicyDomain,
  sourcePolicyLookupDomains,
  type ChannelPolicyRow,
  type ChannelPolicyViolation,
  type ChannelSourcePolicyDraft,
} from './channel-source-policy';
import {
  buildImportRows,
  parseCsv,
  validateImportMapping,
  ImportCsvError,
  type ImportMapping,
} from './channel-import';

type ChannelRow = {
  id: string;
  name: string;
  mode: string;
  category: string;
  status: string;
  config: unknown;
  license: string | null;
  tosUrl: string | null;
  robotsPolicy: string | null;
  owner: string | null;
  failureStreak: number;
  lastRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  // v3.0 第 6 章新增列（旧测试假对象可能缺省，视图按缺省值兜底）。
  manifest?: unknown;
  manifestSha256?: string | null;
  manifestVersion?: string | null;
  connectorKind?: string | null;
  baseUrl?: string | null;
  healthState?: unknown;
  consecutiveFailures?: number | null;
  lastSuccessAt?: Date | null;
  disabledReason?: string | null;
  probeRequired?: boolean | null;
};

function badConfig(error: unknown): never {
  if (error instanceof ChannelConfigError || error instanceof ImportCsvError) {
    throw new BadRequestException({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

function healthSummary(row: ChannelRow) {
  const state = (row.healthState ?? null) as { circuit?: string } | null;
  return {
    circuit: state?.circuit ?? 'closed',
    consecutiveFailures: row.consecutiveFailures ?? 0,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    disabledReason: row.disabledReason ?? null,
  };
}

function channelView(row: ChannelRow & { runs?: Array<Record<string, unknown>> }) {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    category: row.category,
    status: row.status,
    config: row.config,
    license: row.license,
    tosUrl: row.tosUrl,
    robotsPolicy: row.robotsPolicy,
    owner: row.owner,
    failureStreak: row.failureStreak,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    manifestSha256: row.manifestSha256 ?? null,
    manifestVersion: row.manifestVersion ?? null,
    connectorKind: row.connectorKind ?? null,
    baseUrl: row.baseUrl ?? null,
    probeRequired: row.probeRequired ?? null,
    health: healthSummary(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.runs ? { runs: row.runs } : {}),
  };
}

/**
 * M1 渠道数据源平台：平台级渠道注册 + 租户启用 + 导入通道端到端 + 运行统计/自动停用。
 *
 * 结算与出网说明：导入通道完全在库内完成（无出网）。抓取通道的执行需要平台级抓取预算权威
 * （新 purpose / 平台自动化），在获批前 `requestCrawl` 明确返回 409（不偷偷绕过 ToolBroker 出网）。
 */
@Injectable()
export class ChannelService {
  constructor(
    private readonly prisma: PrismaService,
    /** P4-P4c：平台抓取运行的启动器（TemporalModule 全局提供；单测缺省）。 */
    @Optional()
    private readonly platformTemporal?: PlatformTemporalClient,
    /** v3.0 渠道资源池：密钥引用解析器（只用于「已配置/未配置」状态展示）。 */
    @OptionalDep()
    @Inject(CHANNEL_SECRET_RESOLVER)
    private readonly secrets?: ChannelSecretResolver,
  ) {}

  async listChannels(ctx: RequestContext) {
    const rows = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.findMany({
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        include: { runs: { orderBy: { startedAt: 'desc' }, take: 5 } },
      }),
    );
    return rows.map((row) =>
      channelView({
        ...row,
        runs: row.runs.map((run) => ({
          id: run.id,
          status: run.status,
          pagesFetched: run.pagesFetched,
          recordsFound: run.recordsFound,
          recordsMaterialized: run.recordsMaterialized,
          failures: run.failures,
          truncated: run.truncated,
          errorCode: run.errorCode,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt?.toISOString() ?? null,
        })),
      }),
    );
  }

  async createChannel(
    ctx: RequestContext,
    input: {
      name?: unknown;
      mode?: unknown;
      category?: unknown;
      config?: unknown;
      manifest?: unknown;
      license?: unknown;
      tosUrl?: unknown;
      robotsPolicy?: unknown;
      owner?: unknown;
    },
  ) {
    // —— v3.0：manifest 驱动创建（transport.responseType=json → mode=api）——
    if (input.manifest !== undefined) {
      return this.createChannelFromManifest(ctx, input);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > 200) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'name must be 1–200 chars' } });
    }
    const mode = input.mode;
    if (typeof mode !== 'string' || !(CHANNEL_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: `mode must be one of ${CHANNEL_MODES.join(', ')}` } });
    }
    const category = input.category;
    if (typeof category !== 'string' || !(CHANNEL_CATEGORIES as readonly string[]).includes(category)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: `category must be one of ${CHANNEL_CATEGORIES.join(', ')}` } });
    }
    let config: unknown;
    try {
      config = parseChannelConfig(mode, input.config);
    } catch (error) {
      badConfig(error);
    }
    const robotsPolicy =
      input.robotsPolicy === undefined ? null : String(input.robotsPolicy);
    if (robotsPolicy !== null && !(CHANNEL_ROBOTS_POLICIES as readonly string[]).includes(robotsPolicy)) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'robotsPolicy must be A, B or C' } });
    }

    const row = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.create({
        data: {
          name,
          mode,
          category,
          config: config as unknown as object,
          status: 'DISABLED',
          robotsPolicy,
          ...(typeof input.license === 'string' && input.license.trim() ? { license: input.license.trim().slice(0, 200) } : {}),
          ...(typeof input.tosUrl === 'string' && input.tosUrl.trim() ? { tosUrl: input.tosUrl.trim().slice(0, 2048) } : {}),
          ...(typeof input.owner === 'string' && input.owner.trim() ? { owner: input.owner.trim().slice(0, 200) } : {}),
        },
      }),
    );
    return channelView(row);
  }

  /** manifest → 渠道列（校验→sha256→治理镜像→probe_required=true）。 */
  private manifestColumns(rawManifest: unknown): {
    manifest: Record<string, unknown>;
    document: import('@global/contracts').ChannelManifestDocument;
    manifestSha256: string;
    baseUrl: string;
    authRef: unknown;
    rateLimit: unknown;
    quotaPolicy: unknown;
    pagination: unknown;
    fieldMapping: unknown;
    governance: { license?: string; tosUrl?: string; robotsPolicy?: string };
    displayName: string;
    category: string;
  } {
    let manifest;
    try {
      manifest = parseChannelManifest(rawManifest);
    } catch (error) {
      if (error instanceof ChannelManifestError) {
        throw new BadRequestException({
          error: { code: error.code, message: error.message, issues: error.issues },
        });
      }
      throw error;
    }
    if (manifest.transport.responseType !== 'json') {
      throw new ConflictException({
        error: {
          code: 'CHANNEL_MANIFEST_HTML_UNSUPPORTED',
          message: 'html manifests are accepted by the schema but not executable in this wave; keep using crawl configs',
        },
      });
    }
    const refs = collectAuthRefs(manifest.auth);
    return {
      manifest: manifest as unknown as Record<string, unknown>,
      document: manifest,
      manifestSha256: manifestSha256(manifest),
      baseUrl: manifest.transport.baseUrl,
      authRef: refs.length > 0 ? { refs } : null,
      rateLimit: manifest.rateLimit ?? null,
      quotaPolicy:
        manifest.rateLimit?.dailyRequests === undefined
          ? null
          : { dailyRequests: manifest.rateLimit.dailyRequests },
      pagination: manifest.pagination ?? null,
      fieldMapping: manifest.fieldMapping ?? null,
      governance: {
        ...(manifest.governance ? { license: manifest.governance.license, tosUrl: manifest.governance.tosUrl, robotsPolicy: manifest.governance.robotsPolicy } : {}),
      },
      displayName: manifest.meta.name,
      category: manifest.meta.category,
    };
  }

  private async createChannelFromManifest(
    ctx: RequestContext,
    input: { name?: unknown; manifest?: unknown; owner?: unknown },
  ) {
    const columns = this.manifestColumns(input.manifest);
    const name =
      typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 200)
        : columns.displayName.slice(0, 200);
    const row = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.create({
        data: {
          name,
          mode: 'api',
          category: columns.category,
          config: { adapter: 'channel-manifest/v1' } as never,
          status: 'DISABLED',
          manifest: columns.manifest as never,
          manifestSha256: columns.manifestSha256,
          manifestVersion: CHANNEL_MANIFEST_VERSION,
          connectorKind: 'manifest',
          baseUrl: columns.baseUrl,
          authRef: columns.authRef as never,
          rateLimit: columns.rateLimit as never,
          quotaPolicy: columns.quotaPolicy as never,
          pagination: columns.pagination as never,
          fieldMapping: columns.fieldMapping as never,
          probeRequired: true,
          ...(columns.governance.license ? { license: columns.governance.license } : {}),
          ...(columns.governance.tosUrl ? { tosUrl: columns.governance.tosUrl } : {}),
          ...(columns.governance.robotsPolicy ? { robotsPolicy: columns.governance.robotsPolicy } : {}),
          ...(typeof input.owner === 'string' && input.owner.trim() ? { owner: input.owner.trim().slice(0, 200) } : {}),
        },
      }),
    );
    const created = channelView(row as never);
    // CH-8：派生草稿随保存返回（source_policy 是 app_user 只读表，落库走 owner 运营脚本）。
    return {
      ...created,
      sourcePolicyDrafts: deriveSourcePolicyDrafts(
        { id: (row as { id: string }).id, mode: 'api', category: columns.category },
        columns.document,
      ),
    };
  }

  async patchChannel(ctx: RequestContext, channelId: string, patch: Record<string, unknown>) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const current = (await tx.sourceChannel.findUnique({ where: { id: channelId } })) as ChannelRow | null;
      if (!current) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });

      const manifestColumns =
        patch.manifest !== undefined ? this.manifestColumns(patch.manifest) : null;
      const mode = manifestColumns ? 'api' : typeof patch.mode === 'string' ? patch.mode : current.mode;
      let config: unknown = current.config;
      if (patch.config !== undefined || mode !== current.mode) {
        try {
          config = parseChannelConfig(mode, patch.config ?? current.config);
        } catch (error) {
          badConfig(error);
        }
      }
      const status = typeof patch.status === 'string' ? patch.status : current.status;
      if (!(CHANNEL_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: `status must be one of ${CHANNEL_STATUSES.join(', ')}` } });
      }
      const license = manifestColumns
        ? (manifestColumns.governance.license ?? current.license)
        : patch.license !== undefined ? (patch.license === null ? null : String(patch.license).trim().slice(0, 200) || null) : current.license;
      const tosUrl = manifestColumns
        ? (manifestColumns.governance.tosUrl ?? current.tosUrl)
        : patch.tosUrl !== undefined ? (patch.tosUrl === null ? null : String(patch.tosUrl).trim().slice(0, 2048) || null) : current.tosUrl;
      const robotsPolicy = manifestColumns
        ? (manifestColumns.governance.robotsPolicy ?? current.robotsPolicy)
        : patch.robotsPolicy !== undefined
          ? (patch.robotsPolicy === null ? null : String(patch.robotsPolicy))
          : current.robotsPolicy;
      if (robotsPolicy !== null && !(CHANNEL_ROBOTS_POLICIES as readonly string[]).includes(robotsPolicy)) {
        throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'robotsPolicy must be A, B or C' } });
      }
      const hasManifest = manifestColumns !== null || current.manifest !== null && current.manifest !== undefined;
      const probeRequiredAfter = manifestColumns !== null ? true : (current.probeRequired ?? false);
      if (status === 'ENABLED') {
        // 治理硬闸门：启用前必须登记许可、条款与 robots 结论，且不是「C 不做」。
        if (!license || !tosUrl || !robotsPolicy || robotsPolicy === 'C') {
          throw new ConflictException({
            error: {
              code: 'CHANNEL_GOVERNANCE_INCOMPLETE',
              message: 'enabling a channel requires license, tosUrl and a robots policy of A or B (C never enables)',
            },
          });
        }
        if (mode === 'crawl' && robotsPolicy !== 'A') {
          throw new ConflictException({
            error: {
              code: 'CHANNEL_ROBOTS_NOT_ALLOWED',
              message: 'crawl channels can only be enabled with robots policy A (crawl allowed)',
            },
          });
        }
        // 保存即测试闸门：manifest 渠道必须先 probe 通过（legacy crawl 沿用既有流程，不在此门内）。
        // 同一请求里换 manifest 时不算「请求启用」——savedStatus 会把渠道落回 DISABLED 等 probe。
        if (mode === 'api' && hasManifest && probeRequiredAfter && manifestColumns === null) {
          throw new ConflictException({
            error: {
              code: 'CHANNEL_PROBE_REQUIRED',
              message: 'manifest channel must pass POST /source-channels/:id/test before it can be enabled',
            },
          });
        }
        // CH-8 条款闸门：allowedHosts 逐域必须有已复核的 source_policy（官方开放数据域豁免）。
        if (manifestColumns === null && mode === 'api' && hasManifest) {
          const violations = await this.enablePolicyViolations(tx, current);
          if (violations.length > 0) {
            throw new ConflictException({
              error: {
                code: 'CHANNEL_GOVERNANCE_INCOMPLETE',
                message:
                  'source_policy review is required before enabling this channel (missing/SUSPENDED/UNREVIEWED terms)',
                policyViolations: violations,
              },
            });
          }
        }
      }

      // 已启用渠道换了 manifest：新配置未 probe，保存后回到 DISABLED（章节 §6.3.2：
      // ENABLED ⇒ probe_required=false；不允许带着未测配置继续跑）。
      const savedStatus = manifestColumns !== null && status === 'ENABLED' ? 'DISABLED' : status;
      const row = await tx.sourceChannel.update({
        where: { id: channelId },
        data: {
          ...(typeof patch.name === 'string' && patch.name.trim()
            ? { name: patch.name.trim().slice(0, 200) }
            : manifestColumns
              ? { name: manifestColumns.displayName.slice(0, 200) }
              : {}),
          mode,
          config: config as unknown as object,
          status: savedStatus,
          license,
          tosUrl,
          robotsPolicy,
          ...(manifestColumns
            ? {
                manifest: manifestColumns.manifest as never,
                manifestSha256: manifestColumns.manifestSha256,
                manifestVersion: CHANNEL_MANIFEST_VERSION,
                connectorKind: 'manifest',
                baseUrl: manifestColumns.baseUrl,
                authRef: manifestColumns.authRef as never,
                rateLimit: manifestColumns.rateLimit as never,
                quotaPolicy: manifestColumns.quotaPolicy as never,
                pagination: manifestColumns.pagination as never,
                fieldMapping: manifestColumns.fieldMapping as never,
                probeRequired: true,
              }
            : {}),
          ...(savedStatus === 'DISABLED' ? { disabledReason: 'OPERATOR' } : {}),
          ...(savedStatus === 'ENABLED' ? { disabledReason: null } : {}),
          ...(typeof patch.owner === 'string' ? { owner: patch.owner.trim().slice(0, 200) || null } : {}),
          ...(patch.status !== undefined && savedStatus !== current.status ? { failureStreak: 0 } : {}),
        },
      });
      if (patch.status !== undefined && savedStatus !== current.status) {
        const events = (tx as { sourceChannelHealthEvent?: { create: (args: unknown) => Promise<unknown> } })
          .sourceChannelHealthEvent;
        if (events) {
          await events.create({
            data: {
              channelId,
              event: savedStatus === 'ENABLED' ? 'MANUAL_ENABLE' : 'MANUAL_DISABLE',
              detail: {
                previousStatus: current.status,
                manifestSha256: (row as ChannelRow).manifestSha256 ?? null,
              },
            },
          });
        }
      }
      const view = channelView(row as ChannelRow);
      const probeUrl = `/source-channels/${channelId}/test`;
      if (manifestColumns) {
        return {
          ...view,
          probeUrl,
          sourcePolicyDrafts: deriveSourcePolicyDrafts(
            { id: channelId, mode: 'api', category: manifestColumns.category },
            manifestColumns.document,
          ),
        };
      }
      return mode === 'api' && hasManifest ? { ...view, probeUrl } : view;
    });
  }

  /**
   * 启用前的逐域 source_policy 判定（只读）：source_policy 是 app_user 只读的治理表，
   * 派生写库走 owner 运营脚本 `apply-channel-source-policies.mts`。
   */
  private async enablePolicyViolations(
    tx: { sourcePolicy: { findMany: (args: never) => Promise<ChannelPolicyRow[]> } },
    current: ChannelRow,
  ): Promise<ChannelPolicyViolation[]> {
    const manifest = this.tryParseStoredManifest(current.manifest);
    if (!manifest) return [];
    const hosts = this.manifestHosts(manifest);
    const domains = sourcePolicyLookupDomains(hosts);
    if (domains.length === 0) return [];
    const policies = await tx.sourcePolicy.findMany({
      where: { domain: { in: domains } },
      select: { domain: true, reviewStatus: true, termsStatus: true, robotsStatus: true },
    } as never);
    return evaluateChannelSourcePolicyGate({ mode: current.mode, hosts, policies });
  }

  private tryParseStoredManifest(raw: unknown): import('@global/contracts').ChannelManifestDocument | null {
    if (!raw) return null;
    try {
      return parseChannelManifest(raw);
    } catch {
      return null;
    }
  }

  private manifestHosts(manifest: import('@global/contracts').ChannelManifestDocument): string[] {
    return manifest.transport.allowedHosts ?? [new URL(manifest.transport.baseUrl).hostname];
  }

  /** 渠道详情（ops:read）：manifest 全量 + 密钥「已配置/未配置」+ source_policy 逐域状态。 */
  async getChannel(ctx: RequestContext, channelId: string) {
    const row = (await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.findUnique({ where: { id: channelId } }),
    )) as ChannelRow | null;
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
    let auth: Awaited<ReturnType<typeof describeAuthSecrets>> = null;
    let sourcePolicy: {
      hosts: Array<{ host: string; domain: string; official: boolean }>;
      policies: ChannelPolicyRow[];
      violations: ChannelPolicyViolation[];
      drafts: ChannelSourcePolicyDraft[];
    } | null = null;
    const manifest = this.tryParseStoredManifest(row.manifest);
    if (manifest) {
      auth = await describeAuthSecrets(manifest.auth, this.secrets).catch(() => null);
      const hosts = this.manifestHosts(manifest);
      const domains = sourcePolicyLookupDomains(hosts);
      const policies: ChannelPolicyRow[] =
        domains.length === 0
          ? []
          : await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
              tx.sourcePolicy.findMany({
                where: { domain: { in: domains } },
                select: { domain: true, reviewStatus: true, termsStatus: true, robotsStatus: true },
              } as never),
            );
      sourcePolicy = {
        hosts: hosts.map((host) => ({
          host,
          domain: sourcePolicyDomain(host),
          official: isOfficialSourceHost(sourcePolicyDomain(host)),
        })),
        policies,
        violations: evaluateChannelSourcePolicyGate({ mode: row.mode, hosts, policies }),
        drafts: deriveSourcePolicyDrafts({ id: row.id, mode: row.mode, category: row.category }, manifest),
      };
    } else if (row.manifest) {
      auth = null;
    }
    return { ...channelView(row), manifest: row.manifest ?? null, auth, sourcePolicy };
  }

  /** 租户可见的已批准渠道（含本 workspace 是否已启用）。 */
  async listAvailable(ctx: RequestContext) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const channels = await tx.sourceChannel.findMany({
        where: { status: 'ENABLED' },
        orderBy: { name: 'asc' },
      });
      const enablements = await tx.sourceChannelEnablement.findMany({
        where: { workspaceId: ctx.workspaceId },
        select: { channelId: true },
      });
      const enabled = new Set(enablements.map((row) => row.channelId));
      return channels.map((channel) => ({
        ...channelView(channel),
        config: undefined,
        enabled: enabled.has(channel.id),
      }));
    });
  }

  async enableChannel(ctx: RequestContext, channelId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const channel = await tx.sourceChannel.findUnique({ where: { id: channelId }, select: { id: true, status: true } });
      if (!channel) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
      if (channel.status !== 'ENABLED') {
        throw new ConflictException({ error: { code: 'CHANNEL_NOT_APPROVED', message: 'only approved (ENABLED) channels can be enabled' } });
      }
      await tx.sourceChannelEnablement.upsert({
        where: {
          workspaceId_channelId: { workspaceId: ctx.workspaceId, channelId: channel.id },
        },
        update: {},
        create: { workspaceId: ctx.workspaceId, channelId: channel.id, enabledBy: ctx.userId },
      });
      return { channelId: channel.id, enabled: true };
    });
  }

  async disableChannel(ctx: RequestContext, channelId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      await tx.sourceChannelEnablement.deleteMany({
        where: { workspaceId: ctx.workspaceId, channelId },
      });
      return { channelId, enabled: false };
    });
  }

  /** 导入预览：解析 + 映射校验 + 去重/抑制命中（不写库）。 */
  async previewImport(
    ctx: RequestContext,
    input: { csv?: unknown; mapping?: unknown },
  ) {
    try {
      const csv = typeof input.csv === 'string' ? input.csv : '';
      const parsed = parseCsv(csv);
      const mapping = validateImportMapping(parsed.headers, input.mapping);
      const built = buildImportRows(parsed.headers, parsed.rows, mapping);
      const keys = built.rows.map(
        (row) => companyIdentity({ name: row.name, domain: row.domain, country: row.country }).dedupeKey,
      );
      const { existing, suppressed } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
        const existing = await tx.canonicalCompany.findMany({
          where: { dedupeKey: { in: [...new Set(keys)] } },
          select: { dedupeKey: true },
        });
        const suppressionRows = await tx.suppressionRecord.findMany({
          where: { type: { in: ['domain', 'company_name'] } },
          select: { type: true, value: true },
        });
        const suppressed = built.rows.filter((row) =>
          companyMatchesSuppression(suppressionRows, { name: row.name, domain: row.domain }),
        ).length;
        return { existing, suppressed };
      });
      const existingKeys = new Set(existing.map((row) => row.dedupeKey));
      const duplicate = keys.filter((key) => existingKeys.has(key)).length;
      return {
        headers: parsed.headers,
        mapping,
        totalRows: parsed.rows.length,
        validRows: built.rows.length,
        invalid: built.invalid.slice(0, 50),
        invalidCount: built.invalid.length,
        preview: { duplicate, suppressed },
        sample: built.rows.slice(0, 10).map((row) => ({
          rowNumber: row.rowNumber,
          name: row.name,
          domain: row.domain ?? null,
          country: row.country ?? null,
          industry: row.industry ?? null,
        })),
      };
    } catch (error) {
      badConfig(error);
    }
  }

  /** 导入提交：写 imported_buyer + 物化 canonical（私有池）+ 渠道 sighting（幂等按 dedupeKey）。 */
  async importBuyers(
    ctx: RequestContext,
    input: { csv?: unknown; mapping?: unknown; channelId?: unknown },
  ) {
    let parsed: ReturnType<typeof parseCsv>;
    let mapping: ImportMapping;
    let built: ReturnType<typeof buildImportRows>;
    try {
      parsed = parseCsv(typeof input.csv === 'string' ? input.csv : '');
      mapping = validateImportMapping(parsed.headers, input.mapping);
      built = buildImportRows(parsed.headers, parsed.rows, mapping);
    } catch (error) {
      badConfig(error);
    }
    const channelId = typeof input.channelId === 'string' ? input.channelId : undefined;
    const batchId = randomUUID();

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      if (channelId) {
        const channel = await tx.sourceChannel.findUnique({ where: { id: channelId }, select: { status: true } });
        if (!channel || channel.status !== 'ENABLED') {
          throw new ConflictException({ error: { code: 'CHANNEL_NOT_APPROVED', message: 'channel must be ENABLED to receive imports' } });
        }
      }
      const suppressionRows = await tx.suppressionRecord.findMany({
        where: { type: { in: ['domain', 'company_name'] } },
        select: { type: true, value: true },
      });
      let materialized = 0;
      let duplicates = 0;
      let suppressed = 0;
      const seenKeys = new Set<string>();
      for (const row of built.rows) {
        const identity = companyIdentity({ name: row.name, domain: row.domain, country: row.country });
        const rawRow = row.raw as never;
        if (companyMatchesSuppression(suppressionRows, { name: row.name, domain: row.domain })) {
          suppressed += 1;
          await tx.importedBuyer.create({
            data: {
              workspaceId: ctx.workspaceId,
              batchId,
              ...(channelId ? { channelId } : {}),
              rowNumber: row.rowNumber,
              rawRow,
              dedupeKey: identity.dedupeKey,
              status: 'SUPPRESSED',
            },
          });
          continue;
        }
        if (seenKeys.has(identity.dedupeKey)) {
          duplicates += 1;
          await tx.importedBuyer.create({
            data: {
              workspaceId: ctx.workspaceId,
              batchId,
              ...(channelId ? { channelId } : {}),
              rowNumber: row.rowNumber,
              rawRow,
              dedupeKey: identity.dedupeKey,
              status: 'DUPLICATE',
            },
          });
          continue;
        }
        seenKeys.add(identity.dedupeKey);
        const existing = await tx.canonicalCompany.findUnique({
          where: { workspaceId_dedupeKey: { workspaceId: ctx.workspaceId, dedupeKey: identity.dedupeKey } },
          select: { id: true },
        });
        if (existing) {
          duplicates += 1;
          await tx.importedBuyer.create({
            data: {
              workspaceId: ctx.workspaceId,
              batchId,
              ...(channelId ? { channelId } : {}),
              rowNumber: row.rowNumber,
              rawRow,
              dedupeKey: identity.dedupeKey,
              status: 'DUPLICATE',
              canonicalCompanyId: existing.id,
            },
          });
          continue;
        }
        const company = await tx.canonicalCompany.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: row.name,
            domain: row.domain ?? null,
            country: row.country ?? null,
            industry: row.industry ?? null,
            attributes: {} as never,
            dedupeKey: identity.dedupeKey,
            status: 'NEW',
          },
          select: { id: true },
        });
        await tx.companyChannelSighting.create({
          data: {
            workspaceId: ctx.workspaceId,
            companyId: company.id,
            ...(channelId ? { channelId } : {}),
            externalRef: `import:${batchId}:${row.rowNumber}`,
            seenAt: new Date(),
          },
        });
        await tx.importedBuyer.create({
          data: {
            workspaceId: ctx.workspaceId,
            batchId,
            ...(channelId ? { channelId } : {}),
            rowNumber: row.rowNumber,
            rawRow,
            dedupeKey: identity.dedupeKey,
            status: 'MATERIALIZED',
            canonicalCompanyId: company.id,
          },
        });
        materialized += 1;
      }
      return {
        batchId,
        totalRows: parsed.rows.length,
        validRows: built.rows.length,
        materialized,
        duplicates,
        suppressed,
        invalidCount: built.invalid.length,
      };
    });
  }

  /** 渠道运行收尾：落 source_channel_run，失败率 >30% 记 streak，连续 3 轮自动停用。 */
  async recordChannelRun(input: {
    channelId: string;
    workspaceId?: string;
    platform?: boolean;
    status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
    pagesFetched: number;
    recordsFound: number;
    recordsMaterialized: number;
    failures: number;
    truncated?: boolean;
    errorCode?: string;
    mode?: 'preview' | 'run';
    manifestSha256?: string;
    planDigest?: string;
    requests?: number;
    bytesFetched?: number;
    http4xx?: number;
    http5xx?: number;
    http429?: number;
    durationMs?: number;
    circuitState?: 'closed' | 'open' | 'half_open';
    operatorNote?: string;
  }) {
    const body = (tx: Parameters<typeof recordChannelRunInTransaction>[0]) =>
      recordChannelRunInTransaction(tx, {
        channelId: input.channelId,
        ...(input.platform ? {} : { triggeredByWorkspaceId: input.workspaceId }),
        status: input.status,
        pagesFetched: input.pagesFetched,
        recordsFound: input.recordsFound,
        recordsMaterialized: input.recordsMaterialized,
        failures: input.failures,
        ...(input.truncated === undefined ? {} : { truncated: input.truncated }),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.manifestSha256 === undefined ? {} : { manifestSha256: input.manifestSha256 }),
        ...(input.planDigest === undefined ? {} : { planDigest: input.planDigest }),
        ...(input.requests === undefined ? {} : { requests: input.requests }),
        ...(input.bytesFetched === undefined ? {} : { bytesFetched: input.bytesFetched }),
        ...(input.http4xx === undefined ? {} : { http4xx: input.http4xx }),
        ...(input.http5xx === undefined ? {} : { http5xx: input.http5xx }),
        ...(input.http429 === undefined ? {} : { http429: input.http429 }),
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        ...(input.circuitState === undefined ? {} : { circuitState: input.circuitState }),
        ...(input.operatorNote === undefined ? {} : { operatorNote: input.operatorNote }),
      });
    if (input.platform) {
      return this.prisma.$transaction(body as never) as unknown as Promise<{
        runId: string;
        autoDisabled: boolean;
        failureStreak: number;
      }>;
    }
    if (!input.workspaceId) {
      throw new ServiceUnavailableException({
        error: {
          code: 'CHANNEL_RUN_CONTEXT_MISSING',
          message: 'recordChannelRun requires a workspace or platform context',
        },
      });
    }
    return this.prisma.withWorkspace(input.workspaceId, body as never) as Promise<{
      runId: string;
      autoDisabled: boolean;
      failureStreak: number;
    }>;
  }

  /**
   * 抓取通道的试跑/运行入口（P4-P4c）：校验渠道后启动 platform-automation 的
   * channelCrawlWorkflow。Grant 的获取/摄入在平台 worker 内完成（那里持有
   * worker mTLS 证书与 platform writer）；API 只负责发起并返回已受理的运行。
   * 引擎缺平台客户端或端点不可用时 fail-closed（503），不再返回占位 409。
   */
  /** 渠道最近物化的抓取记录（ops:read）：选择器校验与联系使用；PII 按 OWNER-DECISION-2026-11-05 明文存储。 */
  async listChannelRecords(ctx: RequestContext, channelId: string, limitRaw?: string) {
    const parsed = limitRaw === undefined ? 50 : Number(limitRaw);
    const limit = Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 50;
    const channel = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.findUnique({ where: { id: channelId }, select: { id: true } }),
    );
    if (!channel) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
    const rows = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannelRecord.findMany({
        where: { channelId },
        orderBy: { lastSeenAt: 'desc' },
        take: limit,
      }),
    );
    return {
      channelId,
      records: rows.map((row) => ({
        id: row.id,
        crawlRunId: row.crawlRunId,
        name: row.name,
        website: row.website,
        country: row.country,
        industry: row.industry,
        products: row.products,
        keywords: row.keywords,
        contactName: row.contactName,
        contactTitle: row.contactTitle,
        email: row.email,
        phone: row.phone,
        sourceUrl: row.sourceUrl,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        contentHash: row.contentHash,
      })),
    };
  }

  async requestCrawl(ctx: RequestContext, channelId: string, kind: 'preview' | 'run') {
    const channel = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.findUnique({
        where: { id: channelId },
        select: { id: true, mode: true, status: true },
      }),
    );
    if (!channel) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
    if (channel.mode !== 'crawl') {
      throw new ConflictException({ error: { code: 'CHANNEL_NOT_CRAWL', message: 'channel is not a crawl channel' } });
    }
    if (channel.status !== 'ENABLED') {
      throw new ConflictException({ error: { code: 'CHANNEL_NOT_APPROVED', message: 'channel must be ENABLED before a trial run' } });
    }
    if (!this.platformTemporal) {
      throw new ServiceUnavailableException({
        error: {
          code: 'PLATFORM_TEMPORAL_UNAVAILABLE',
          message: 'platform crawl execution is not wired in this process',
        },
      });
    }
    const cap = (process.env.CHANNEL_CRAWL_CAP_PER_RUN_MICROUSD ?? '5000000').trim();
    if (!/^[1-9][0-9]*$/u.test(cap)) {
      throw new ServiceUnavailableException({
        error: {
          code: 'CHANNEL_CRAWL_CAP_UNAVAILABLE',
          message: 'channel crawl cap configuration is invalid',
        },
      });
    }
    const mode = kind === 'preview' ? 'preview' : 'run';
    const pageCap = mode === 'preview' ? 1 : CHANNEL_RUN_MAX_PAGES;
    const crawlRunId = randomUUID();
    const input: ChannelCrawlWorkflowInput = {
      executionContractVersion: CHANNEL_CRAWL_CONTRACT_VERSION,
      channelId,
      crawlRunId,
      mode,
      pageCap,
      requestSha256: channelCrawlRequestSha256(channelId, mode, String(pageCap)),
      technicalPolicyRevision: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
      capPerRunMicrousd: cap,
      campaignCapMicrousd: cap,
    };
    try {
      const started = await this.platformTemporal.startWorkflow({
        workflowType: CHANNEL_CRAWL_WORKFLOW_TYPE,
        workflowId: `channel-crawl-${crawlRunId}`,
        args: [input],
      });
      return {
        crawlRunId,
        workflowId: started.workflowId,
        runId: started.runId,
        mode,
        pageCap,
        accepted: true,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'PLATFORM_TEMPORAL_UNAVAILABLE') {
        throw new ServiceUnavailableException({
          error: {
            code: 'PLATFORM_TEMPORAL_UNAVAILABLE',
            message: 'platform workflow start is unavailable',
          },
        });
      }
      throw error;
    }
  }

  async listImportedBuyers(ctx: RequestContext, batchId: string) {
    const rows = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.importedBuyer.findMany({
        where: { batchId },
        orderBy: { rowNumber: 'asc' },
        take: 2000,
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      rowNumber: row.rowNumber,
      status: row.status,
      dedupeKey: row.dedupeKey,
      canonicalCompanyId: row.canonicalCompanyId,
      rawRow: row.rawRow,
    }));
  }
}
