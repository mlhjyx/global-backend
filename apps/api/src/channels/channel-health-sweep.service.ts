import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHANNEL_WARNING_FAILURE_COUNT,
  evaluateChannelHealth,
} from './channel-health';

/**
 * 健康扫描钩子（章节 §6.3.6.6 的「每日扫描」）：
 * 覆盖「不再运行」的静默渠道——没有新 run 也要能触发 4 天/7 天判定。
 * 不新增平台 schedule（那需要新的 Temporal workflow 与未获授权的平台运行），
 * 沿用 SweepSchedulerService 的「API 进程内周期桶」模式，直接调用服务层纯函数。
 *
 * - 判定逻辑全部在 evaluateChannelHealth（纯函数，单测覆盖）；
 * - 只扫描 ENABLED 且 consecutiveFailures ≥20 的渠道（其余不可能触发）；
 * - 预警按「上次成功之后」去重，自动停用只发生一次（ENABLED→AUTO_DISABLED）；
 * - 幂等：重复扫描不会重复写事件/重复停用；多实例并发的最坏情况是重复预警事件，
 *   在单实例开发环境可接受（上线多实例前加 advisory lock，登记为后续项）。
 */

export interface ChannelHealthSweepResult {
  readonly scanned: number;
  readonly warned: number;
  readonly autoDisabled: number;
}

const DURATION = /^(\d+)\s*(ms|s|m|h)$/iu;

export function parseSweepIntervalMs(text: string | undefined, fallbackMs: number): number {
  if (!text) return fallbackMs;
  const match = DURATION.exec(text.trim());
  if (!match) return fallbackMs;
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
  return value > 0 ? value * factor : fallbackMs;
}

function sweepEnabled(): boolean {
  return !/^(0|false|off|no)$/iu.test((process.env.CHANNEL_HEALTH_SWEEP_ENABLED ?? 'on').trim());
}

@Injectable()
export class ChannelHealthSweepService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  onModuleInit(): void {
    if (!sweepEnabled()) {
      console.log('[channel-health-sweep] disabled by CHANNEL_HEALTH_SWEEP_ENABLED');
      return;
    }
    const intervalMs = parseSweepIntervalMs(process.env.CHANNEL_HEALTH_SWEEP_INTERVAL, 3_600_000);
    void this.safeTick();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, Math.max(intervalMs, 60_000));
    this.timer.unref?.();
    console.log(`[channel-health-sweep] started (interval ${Math.max(intervalMs, 60_000)}ms)`);
  }

  /** 启动/周期路径不因数据库暂不可用而挂掉进程（readiness 自有闸门）。 */
  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (error) {
      console.warn(
        `[channel-health-sweep] tick failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now: Date = this.now()): Promise<ChannelHealthSweepResult> {
    if (this.ticking) return { scanned: 0, warned: 0, autoDisabled: 0 };
    this.ticking = true;
    try {
      return await this.sweep(now);
    } finally {
      this.ticking = false;
    }
  }

  async sweep(now: Date): Promise<ChannelHealthSweepResult> {
    const rows = (await this.prisma.sourceChannel.findMany({
      where: {
        status: 'ENABLED',
        consecutiveFailures: { gte: CHANNEL_WARNING_FAILURE_COUNT },
      },
      select: {
        id: true,
        name: true,
        status: true,
        consecutiveFailures: true,
        lastSuccessAt: true,
        createdAt: true,
      },
    })) as Array<{
      id: string;
      name: string;
      status: string;
      consecutiveFailures: number;
      lastSuccessAt: Date | null;
      createdAt: Date | null;
    }>;

    let warned = 0;
    let autoDisabled = 0;
    for (const row of rows) {
      const verdict = evaluateChannelHealth({
        consecutiveFailures: row.consecutiveFailures,
        lastSuccessAt: row.lastSuccessAt,
        fallbackSince: row.createdAt,
        now,
      });
      if (verdict.action === 'NONE') continue;
      await this.prisma.$transaction(async (tx) => {
        if (verdict.action === 'AUTO_DISABLE') {
          await tx.sourceChannel.update({
            where: { id: row.id },
            data: { status: 'AUTO_DISABLED', disabledReason: 'AUTO_STREAK' },
          });
          await tx.sourceChannelHealthEvent.create({
            data: {
              channelId: row.id,
              event: 'AUTO_DISABLED_30_7D',
              detail: {
                consecutiveFailures: row.consecutiveFailures,
                lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
              },
            },
          });
          autoDisabled += 1;
          return;
        }
        const reference = row.lastSuccessAt ?? row.createdAt ?? new Date(0);
        const existing = await tx.sourceChannelHealthEvent.findFirst({
          where: {
            channelId: row.id,
            event: 'WARNING_20_4D',
            createdAt: { gte: reference },
          },
          select: { id: true },
        });
        if (existing) return;
        await tx.sourceChannelHealthEvent.create({
          data: {
            channelId: row.id,
            event: 'WARNING_20_4D',
            detail: {
              consecutiveFailures: row.consecutiveFailures,
              lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
            },
          },
        });
        warned += 1;
      });
    }
    return { scanned: rows.length, warned, autoDisabled };
  }
}
