import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
};

function badConfig(error: unknown): never {
  if (error instanceof ChannelConfigError || error instanceof ImportCsvError) {
    throw new BadRequestException({ error: { code: error.code, message: error.message } });
  }
  throw error;
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
  constructor(private readonly prisma: PrismaService) {}

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
      license?: unknown;
      tosUrl?: unknown;
      robotsPolicy?: unknown;
      owner?: unknown;
    },
  ) {
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

  async patchChannel(ctx: RequestContext, channelId: string, patch: Record<string, unknown>) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const current = await tx.sourceChannel.findUnique({ where: { id: channelId } });
      if (!current) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });

      const mode = typeof patch.mode === 'string' ? patch.mode : current.mode;
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
      const license = patch.license !== undefined ? (patch.license === null ? null : String(patch.license).trim().slice(0, 200) || null) : current.license;
      const tosUrl = patch.tosUrl !== undefined ? (patch.tosUrl === null ? null : String(patch.tosUrl).trim().slice(0, 2048) || null) : current.tosUrl;
      const robotsPolicy = patch.robotsPolicy !== undefined
        ? (patch.robotsPolicy === null ? null : String(patch.robotsPolicy))
        : current.robotsPolicy;
      if (robotsPolicy !== null && !(CHANNEL_ROBOTS_POLICIES as readonly string[]).includes(robotsPolicy)) {
        throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'robotsPolicy must be A, B or C' } });
      }
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
      }

      const row = await tx.sourceChannel.update({
        where: { id: channelId },
        data: {
          ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim().slice(0, 200) } : {}),
          mode,
          config: config as unknown as object,
          status,
          license,
          tosUrl,
          robotsPolicy,
          ...(typeof patch.owner === 'string' ? { owner: patch.owner.trim().slice(0, 200) || null } : {}),
          ...(patch.status !== undefined && status !== current.status ? { failureStreak: 0 } : {}),
        },
      });
      return channelView(row);
    });
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
    workspaceId: string;
    status: 'SUCCEEDED' | 'FAILED';
    pagesFetched: number;
    recordsFound: number;
    recordsMaterialized: number;
    failures: number;
    errorCode?: string;
  }) {
    return this.prisma.withWorkspace(input.workspaceId, async (tx) => {
      const run = await tx.sourceChannelRun.create({
        data: {
          channelId: input.channelId,
          workspaceId: input.workspaceId,
          status: input.status,
          pagesFetched: input.pagesFetched,
          recordsFound: input.recordsFound,
          recordsMaterialized: input.recordsMaterialized,
          failures: input.failures,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          finishedAt: new Date(),
        },
      });
      const channel = await tx.sourceChannel.findUnique({
        where: { id: input.channelId },
        select: { failureStreak: true, status: true },
      });
      if (!channel) return { runId: run.id, autoDisabled: false };
      const failureRate = input.pagesFetched > 0 ? input.failures / input.pagesFetched : input.failures > 0 ? 1 : 0;
      const badRound = input.status === 'FAILED' || failureRate > 0.3;
      const streak = badRound ? channel.failureStreak + 1 : 0;
      const autoDisabled = badRound && streak >= 3 && channel.status === 'ENABLED';
      await tx.sourceChannel.update({
        where: { id: input.channelId },
        data: {
          lastRunAt: new Date(),
          failureStreak: streak,
          ...(autoDisabled ? { status: 'AUTO_DISABLED' } : {}),
        },
      });
      return { runId: run.id, autoDisabled, failureStreak: streak };
    });
  }

  /**
   * 抓取通道的试跑/运行入口。抓取出网需要平台级抓取预算权威（新 `channel.crawl` purpose
   * 或平台自动化窗口），在获批前 fail-closed 返回 409——绝不绕过 ToolBroker 直连出网。
   */
  async requestCrawl(ctx: RequestContext, channelId: string, _kind: 'preview' | 'run') {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const channel = await tx.sourceChannel.findUnique({ where: { id: channelId }, select: { id: true, mode: true, status: true } });
      if (!channel) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
      if (channel.mode !== 'crawl') {
        throw new ConflictException({ error: { code: 'CHANNEL_NOT_CRAWL', message: 'channel is not a crawl channel' } });
      }
      if (channel.status !== 'ENABLED') {
        throw new ConflictException({ error: { code: 'CHANNEL_NOT_APPROVED', message: 'channel must be ENABLED before a trial run' } });
      }
      throw new ConflictException({
        error: {
          code: 'CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY',
          message:
            'crawl execution needs the platform crawl budget authority (channel.crawl purpose or platform automation); it is pending the product-owner decision — use an import channel meanwhile',
        },
      });
    });
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
