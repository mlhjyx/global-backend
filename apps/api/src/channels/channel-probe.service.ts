import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ChannelManifestDocument } from '@global/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { ChannelCircuitBreaker } from './connector/circuit-breaker';
import { ManifestChannelConnector } from './connector/channel-connector';
import {
  ChannelManifestError,
  collectAuthRefs,
  parseChannelManifest,
} from './connector/channel-manifest';
import { sanitizeRecordForSample } from './connector/field-extractor';
import { CHANNEL_HTTP_CLIENT, type ChannelHttpClient } from './connector/http-transport';
import { CHANNEL_SECRET_RESOLVER, type ChannelSecretResolver } from './connector/secret-resolver';

/**
 * 保存即测试（章节 §6.3.6.4）：POST /source-channels/:id/test。
 *
 * - 只对 `mode=api` 且带 manifest 的渠道执行（crawl 的试跑继续走平台抓取工作流，后续波次）；
 * - 走与正式运行相同的连接器运行时（限速/退避/熔断/认证注入），maxRequests=1；
 * - 产出 `source_channel_probe` 一行（与 run 分开，不计入 failure streak）与健康事件；
 * - 成功（recordsFound>0 且无错误）才解除 `probe_required`；样本脱敏（联系人字段只留命中布尔）；
 * - **fail-closed**：本进程没有注入出网通道（平台围栏绑定）时返回 503
 *   CHANNEL_TEST_EGRESS_UNAVAILABLE，不存在绕过治理的测试通道。
 */

export type ProbeStatus = 'SUCCEEDED' | 'FAILED';

export interface ChannelProbeResult {
  readonly probeId: string;
  readonly status: ProbeStatus;
  readonly recordsFound: number;
  readonly pagesFetched: number;
  readonly fieldFillRates: Record<string, number>;
  readonly sample: Array<Record<string, string | { present: boolean }>>;
  readonly errorCode: string | null;
  readonly durationMs: number;
  readonly circuit: string;
  readonly probeRequired: boolean;
}

type ProbeChannelRow = {
  id: string;
  name: string;
  mode: string;
  status: string;
  manifest: unknown;
  manifestSha256: string | null;
  healthState: unknown;
  consecutiveFailures: number;
  probeRequired: boolean;
};

/** 详情页展示用：密钥只报已配置/未配置（不返回值、不回完整引用）。 */
export interface AuthSecretStatus {
  readonly type: string;
  readonly secrets: Array<{ slot: string; name: string; configured: boolean }>;
}

export async function describeAuthSecrets(
  auth: ChannelManifestDocument['auth'] | undefined,
  resolver: ChannelSecretResolver | undefined,
): Promise<AuthSecretStatus | null> {
  if (!auth || auth.type === 'none') return null;
  const secrets: Array<{ slot: string; name: string; configured: boolean }> = [];
  for (const { slot, ref } of collectAuthRefs(auth)) {
    let configured = false;
    if (resolver) {
      try {
        await resolver.resolve(ref);
        configured = true;
      } catch {
        configured = false;
      }
    }
    secrets.push({ slot, name: ref.split('/').pop() ?? ref, configured });
  }
  return { type: auth.type, secrets };
}

/** 试跑样本：最多 20 条，联系人字段只留命中布尔（值绝不离开进程）。 */
export function sanitizeProbeSample(
  fieldsList: ReadonlyArray<Record<string, string | undefined>>,
): Array<Record<string, string | { present: boolean }>> {
  return fieldsList.slice(0, 20).map((fields) => sanitizeRecordForSample(fields as never));
}

@Injectable()
export class ChannelProbeService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CHANNEL_SECRET_RESOLVER) private readonly secrets?: ChannelSecretResolver,
    @Optional() @Inject(CHANNEL_HTTP_CLIENT) private readonly httpClient?: ChannelHttpClient,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  async probeChannel(ctx: RequestContext, channelId: string): Promise<ChannelProbeResult> {
    const channel = (await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.sourceChannel.findUnique({ where: { id: channelId } }),
    )) as ProbeChannelRow | null;
    if (!channel) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'channel not found' } });
    if (channel.mode !== 'api') {
      throw new ConflictException({
        error: {
          code: 'CHANNEL_TEST_UNSUPPORTED_MODE',
          message: 'only api (manifest) channels can be tested in-process; crawl trials run through the platform crawl workflow',
        },
      });
    }
    if (!channel.manifest || !channel.manifestSha256) {
      throw new ConflictException({
        error: { code: 'CHANNEL_MANIFEST_REQUIRED', message: 'channel has no manifest to test' },
      });
    }
    if (!this.httpClient || !this.secrets) {
      throw new ServiceUnavailableException({
        error: {
          code: 'CHANNEL_TEST_EGRESS_UNAVAILABLE',
          message: 'channel test egress is not wired in this process (platform egress binding pending)',
        },
      });
    }

    let manifest: ChannelManifestDocument;
    try {
      manifest = parseChannelManifest(channel.manifest);
    } catch (error) {
      if (error instanceof ChannelManifestError) {
        throw new BadRequestException({
          error: { code: error.code, message: error.message, issues: error.issues },
        });
      }
      throw error;
    }

    const startedAt = this.now();
    const breaker = new ChannelCircuitBreaker(
      (channel.healthState ?? null) as never,
      {},
      () => this.now().getTime(),
    );
    const connector = new ManifestChannelConnector({
      http: this.httpClient,
      secrets: this.secrets,
      breaker,
      now: () => this.now().getTime(),
    });
    const run = await connector.run(manifest, { maxRequests: 1 });
    const finishedAt = this.now();

    const status: ProbeStatus =
      run.errorCode === null && run.records.length > 0 ? 'SUCCEEDED' : 'FAILED';
    const errorCode = run.errorCode ?? (run.records.length === 0 ? 'CHANNEL_SCHEMA_MISMATCH' : null);
    const sample = sanitizeProbeSample(run.records.map((record) => record.fields));
    const snapshot = breaker.snapshot();

    const probeId = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const probe = await tx.sourceChannelProbe.create({
        data: {
          channelId: channel.id,
          manifestSha256: channel.manifestSha256!,
          mode: 'probe',
          status,
          pagesFetched: run.pagesFetched,
          recordsFound: run.records.length,
          sample: sample as never,
          fieldFillRates: run.fieldFillRates as never,
          errorCode,
          startedAt,
          finishedAt,
        },
        select: { id: true },
      });
      await tx.sourceChannel.update({
        where: { id: channel.id },
        data:
          status === 'SUCCEEDED'
            ? {
                probeRequired: false,
                lastSuccessAt: finishedAt,
                consecutiveFailures: 0,
                healthState: snapshot as never,
              }
            : { healthState: snapshot as never },
      });
      for (const transition of run.transitions) {
        await tx.sourceChannelHealthEvent.create({
          data: {
            channelId: channel.id,
            event: transition.event,
            detail: { from: transition.from, to: transition.to, reason: transition.reason },
          },
        });
      }
      await tx.sourceChannelHealthEvent.create({
        data: {
          channelId: channel.id,
          event: status === 'SUCCEEDED' ? 'PROBE_PASSED' : 'PROBE_FAILED',
          detail: {
            probeId: probe.id,
            recordsFound: run.records.length,
            errorCode,
            manifestSha256: channel.manifestSha256,
          },
        },
      });
      return probe.id;
    });

    return {
      probeId,
      status,
      recordsFound: run.records.length,
      pagesFetched: run.pagesFetched,
      fieldFillRates: run.fieldFillRates,
      sample,
      errorCode,
      durationMs: run.durationMs,
      circuit: snapshot.circuit,
      probeRequired: status === 'SUCCEEDED' ? false : channel.probeRequired,
    };
  }
}
