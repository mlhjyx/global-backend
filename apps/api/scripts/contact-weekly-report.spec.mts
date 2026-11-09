import { describe, expect, it } from 'vitest';
import {
  parseContactWeeklyReportArgs,
  runContactWeeklyReport,
} from './contact-weekly-report.mts';
import type {
  ContactMetricsQueryRunner,
  ContactMetricsSnapshotClient,
} from '../src/enrichment/metrics/contact-metrics';

/**
 * P1-17：周报 CLI 的参数解析与执行接线（假 runner/快照客户端，零数据库）。
 */
function emptyRunner(): ContactMetricsQueryRunner {
  return { query: async () => [] };
}

function emptySnapshots(): ContactMetricsSnapshotClient & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    contactMetricsSnapshot: {
      findMany: async () => [],
      create: async (args) => {
        created.push(args);
        return args;
      },
    },
  };
}

describe('parseContactWeeklyReportArgs', () => {
  it('缺省：JSON 关、persist 开；各 flag 原样解析', () => {
    expect(parseContactWeeklyReportArgs([])).toEqual({ json: false, persist: true });
    expect(
      parseContactWeeklyReportArgs([
        '--since',
        '2026-11-02T00:00:00Z',
        '--until',
        '2026-11-09T00:00:00Z',
        '--workspace',
        'ws-1',
        '--out',
        '/tmp/report.md',
        '--json',
        '--no-persist',
      ]),
    ).toEqual({
      since: '2026-11-02T00:00:00Z',
      until: '2026-11-09T00:00:00Z',
      workspace: 'ws-1',
      out: '/tmp/report.md',
      json: true,
      persist: false,
    });
  });
});

describe('runContactWeeklyReport', () => {
  it('默认窗口 = 最近 7 天；无数据也产出完整周报与三条告警（均为 INSUFFICIENT_DATA）', async () => {
    const snapshots = emptySnapshots();
    const run = await runContactWeeklyReport(
      { runner: emptyRunner(), snapshots },
      {},
      new Date('2026-11-09T00:00:00Z'),
    );
    expect(run.metrics.window).toEqual({
      since: '2026-11-02T00:00:00.000Z',
      until: '2026-11-09T00:00:00.000Z',
    });
    expect(run.alerts.map((alert) => alert.status)).toEqual([
      'INSUFFICIENT_DATA',
      'INSUFFICIENT_DATA',
      'INSUFFICIENT_DATA',
    ]);
    expect(run.persisted).toBe(true);
    expect(snapshots.created).toHaveLength(1);
    expect(run.report).toContain('# 联系人工程周报');
  });

  it('--no-persist 不写快照；非法窗口抛错', async () => {
    const snapshots = emptySnapshots();
    await runContactWeeklyReport(
      { runner: emptyRunner(), snapshots },
      { persist: false },
      new Date('2026-11-09T00:00:00Z'),
    );
    expect(snapshots.created).toHaveLength(0);
    await expect(
      runContactWeeklyReport(
        { runner: emptyRunner(), snapshots: emptySnapshots() },
        { since: '2026-11-09T00:00:00Z', until: '2026-11-02T00:00:00Z' },
      ),
    ).rejects.toThrow('since < until');
  });
});
