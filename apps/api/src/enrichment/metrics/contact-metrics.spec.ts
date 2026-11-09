import { describe, expect, it } from 'vitest';
import {
  computeContactMetrics,
  CONTACT_ALERT_BOUNDS,
  evaluateContactWeeklyAlerts,
  loadCoverageHistory,
  renderContactWeeklyReportMarkdown,
  type ContactMetricsQueryRunner,
  type ContactMetricsSnapshotClient,
} from './contact-metrics';

/**
 * P1-17：指标口径与告警评估——假查询器 + 假快照客户端，零数据库。
 * 覆盖 BigInt 映射、分母为 0 → null、三类告警的 OK/FIRING/INSUFFICIENT_DATA 与渲染。
 */
const WINDOW = { since: new Date('2026-11-02T00:00:00Z'), until: new Date('2026-11-09T00:00:00Z') };

/** 按调用顺序返回预置结果（computeContactMetrics 的 Promise.all 顺序是确定的）。 */
function queuedRunner(responses: unknown[][]): ContactMetricsQueryRunner & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let index = 0;
  return {
    calls,
    query: async <T>(sql: string, params: unknown[]): Promise<T[]> => {
      calls.push({ sql, params });
      const response = responses[index] ?? [];
      index += 1;
      return response as T[];
    },
  };
}

describe('computeContactMetrics：聚合映射', () => {
  it('BigInt 成本转 number；分母 0 → rate=null；空 provider 列表保留空数组', async () => {
    const runner = queuedRunner([
      [{ total: 100n, terminal: 99n }], // email_state_coverage
      [{ match_total: 40n, match_with_valid: 14n }], // valid company coverage
      [{ provider_key: 'hunter', hits: 6n, requests: 20n }], // hit rate
      [{ provider_key: 'millionverifier', valid: 8n, votes: 16n }], // valid rate
      [{ errors: 1n, votes: 17n }], // error rate
      [{ dual: 10n, conflicts: 3n }], // disagreement
      [{ catch_all: 30n, total: 100n }], // catch-all share
      [{ spend: 600_000n, new_valid: 10n }], // cost per valid
      [{ prior_valid: 20n, flipped: 1n }], // reverify flip
      [{ hard_bounces: 2n, complaints: 0n }], // send side
    ]);
    const metrics = await computeContactMetrics(runner, WINDOW);
    expect(metrics.emailStateCoverage).toMatchObject({ terminal: 99, total: 100, rate: 0.99 });
    expect(metrics.validEmailCompanyCoverage.rate).toBeCloseTo(0.35);
    expect(metrics.enrichmentHitRate).toEqual([
      { provider: 'hunter', numerator: 6, denominator: 20, rate: 0.3 },
    ]);
    expect(metrics.verificationValidRate[0]).toMatchObject({ denominator: 16, rate: 0.5 });
    expect(metrics.verificationErrorRate.rate).toBeCloseTo(1 / 17);
    expect(metrics.verificationDisagreement.rate).toBeCloseTo(0.3);
    expect(metrics.catchAllShare.rate).toBeCloseTo(0.3);
    expect(metrics.costPerValidEmail).toMatchObject({ spendMicrousd: 600_000, newValid: 10, microusdPerValid: 60_000 });
    expect(metrics.reverifyFlip.rate).toBeCloseTo(0.05);
    expect(metrics.sendSide).toMatchObject({ hardBounces: 2, complaints: 0 });

    // 分母为 0：不是 0%，是「没有样本」。
    const empty = queuedRunner([[{ total: 0n, terminal: 0n }]]);
    const none = await computeContactMetrics(empty, WINDOW);
    expect(none.emailStateCoverage.rate).toBeNull();
    expect(none.enrichmentHitRate).toEqual([]);
    expect(none.costPerValidEmail.microusdPerValid).toBeNull();
  });

  it('workspaceId 过滤进入每条查询的 $3 参数', async () => {
    const runner = queuedRunner([]);
    await computeContactMetrics(runner, { ...WINDOW, workspaceId: 'ws-1' });
    const scoped = runner.calls.filter((call) => call.sql.includes('workspace_id = $1'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call.params).toEqual(['ws-1']);
    }
    const windowed = runner.calls.filter((call) => call.sql.includes('$2'));
    expect(windowed.length).toBeGreaterThan(0);
    for (const call of windowed) {
      expect(call.params).toEqual([WINDOW.since, WINDOW.until, 'ws-1']);
    }
  });

  it('默认窗口不带租户参数', async () => {
    const runner = queuedRunner([]);
    await computeContactMetrics(runner, WINDOW);
    for (const call of runner.calls.filter((entry) => entry.sql.includes('$1'))) {
      expect(call.params).toEqual([WINDOW.since, WINDOW.until]);
    }
  });
});

describe('evaluateContactWeeklyAlerts：三条告警', () => {
  const base = {
    verificationErrors: 1,
    verificationVotes: 19,
    costMicrousdPerValid: 50_000,
  };

  it('VALID 覆盖率：数据不足 → INSUFFICIENT_DATA；连续 2 周下降 >3pp → FIRING；单周下降不触发', () => {
    expect(
      evaluateContactWeeklyAlerts({ ...base, validCoverageSeries: [0.4, null, null] })[0],
    ).toMatchObject({ id: 'valid_company_coverage_drop', status: 'INSUFFICIENT_DATA' });
    expect(
      evaluateContactWeeklyAlerts({ ...base, validCoverageSeries: [0.3, 0.36, 0.41] })[0],
    ).toMatchObject({ status: 'FIRING', observed: 0.3 });
    expect(
      evaluateContactWeeklyAlerts({ ...base, validCoverageSeries: [0.39, 0.4, 0.41] })[0],
    ).toMatchObject({ status: 'OK' });
  });

  it('验证错误率：>20% FIRING、≤20% OK、无样本 INSUFFICIENT_DATA', () => {
    const status = (errors: number, votes: number): string =>
      evaluateContactWeeklyAlerts({
        ...base,
        validCoverageSeries: [0.4, 0.4, 0.4],
        verificationErrors: errors,
        verificationVotes: votes,
      })[1]!.status;
    expect(status(3, 7)).toBe('FIRING'); // 30%
    expect(status(2, 8)).toBe('OK'); // 20%，严格大于才告警
    expect(status(0, 0)).toBe('INSUFFICIENT_DATA');
  });

  it('成本超限：> $0.09/valid FIRING；null INSUFFICIENT_DATA', () => {
    const status = (cost: number | null): string =>
      evaluateContactWeeklyAlerts({
        ...base,
        validCoverageSeries: [0.4, 0.4, 0.4],
        costMicrousdPerValid: cost,
      })[2]!.status;
    expect(status(100_000)).toBe('FIRING');
    expect(status(CONTACT_ALERT_BOUNDS.costPerValidUsd * 1_000_000)).toBe('OK');
    expect(status(null)).toBe('INSUFFICIENT_DATA');
  });
});

describe('renderContactWeeklyReportMarkdown', () => {
  it('包含全部段落与 n/a 口径；无调用时 provider 表显示占位', async () => {
    const metrics = await computeContactMetrics(queuedRunner([]), WINDOW);
    const alerts = evaluateContactWeeklyAlerts({
      validCoverageSeries: [null, null, null],
      verificationErrors: 0,
      verificationVotes: 0,
      costMicrousdPerValid: null,
    });
    const report = renderContactWeeklyReportMarkdown(metrics, alerts);
    for (const heading of ['## 覆盖', '## 富集（finder）', '## 验证', '## 成本', '## 发送侧', '## 告警']) {
      expect(report).toContain(heading);
    }
    expect(report).toContain('n/a（无样本）');
    expect(report).toContain('无新增 VALID');
    expect(report).toContain('（本周无调用）');
    expect(report).toContain('hard_bounce_rate / complaint_rate / send_gate_block_rate 待 SaaS 报告接口接入后计算');
    expect(report).toContain('INSUFFICIENT_DATA');
  });
});

describe('loadCoverageHistory', () => {
  it('按 capturedAt 倒序取最近快照的覆盖率（缺字段 → null）', async () => {
    const client = {
      contactMetricsSnapshot: {
        findMany: async () => [
          { capturedAt: new Date('2026-10-26'), metrics: { validEmailCompanyCoverage: { rate: 0.31 } } },
          { capturedAt: new Date('2026-10-19'), metrics: {} },
        ],
        create: async () => undefined,
      },
    } as ContactMetricsSnapshotClient;
    expect(await loadCoverageHistory(client, { workspaceId: null, before: WINDOW.since })).toEqual([
      0.31,
      null,
    ]);
  });
});
