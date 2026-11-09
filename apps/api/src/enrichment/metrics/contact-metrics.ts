import type { PrismaClient } from '@prisma/client';

/**
 * P1-17：联系人工程指标（计划 §2.3.12，G10）——周报脚本与 CONTACT_WEEKLY_REPORT
 * Schedule 共用的计算层。
 *
 * 口径纪律：
 *  - 全部指标按**窗口**（since..until）或**当前快照**计算，SQL 只读；
 *  - 分母为 0 一律输出 null（不是 0——「没有样本」与「0%」是不同事实）；
 *  - 发送侧指标（hard_bounce_rate / complaint_rate / send_gate_block_rate）的分母
 *    （发送条数）在 gain-saas，引擎只有退信/投诉事件与抑制行——如实标记
 *    `unavailable` 并给出绝对计数，绝不臆造发送量；
 *  - backlog_stage_conversion 属 backlog 域（ch02 §2.3.8），不在本 lane 计算。
 *
 * 告警按计划 §2.3.12 三条：VALID 覆盖率连续下降、验证错误率、获客成本超限。
 * 评估是纯函数（输入为两周/三周聚合），渠道接线（通知）留给后续切片——
 * 当前输出进周报正文与 Schedule 的返回值。
 */

export interface ContactMetricsWindow {
  since: Date;
  until: Date;
}

export interface ContactMetricsQueryRunner {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
}

export function prismaQueryRunner(prisma: PrismaClient): ContactMetricsQueryRunner {
  return {
    query: <T>(sql: string, params: unknown[]): Promise<T[]> =>
      prisma.$queryRawUnsafe<T[]>(sql, ...(params as never[])),
  };
}

export interface ProviderRateRow {
  provider: string;
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface ContactMetricsSnapshot {
  window: { since: string; until: string };
  emailStateCoverage: {
    terminal: number;
    total: number;
    rate: number | null;
  };
  validEmailCompanyCoverage: {
    withValid: number;
    matchCompanies: number;
    rate: number | null;
  };
  enrichmentHitRate: ProviderRateRow[];
  verificationValidRate: ProviderRateRow[];
  verificationDisagreement: {
    conflicts: number;
    dualVerified: number;
    rate: number | null;
  };
  verificationErrorRate: {
    errors: number;
    votes: number;
    rate: number | null;
  };
  catchAllShare: {
    catchAll: number;
    emailPoints: number;
    rate: number | null;
  };
  costPerValidEmail: {
    spendMicrousd: number;
    newValid: number;
    microusdPerValid: number | null;
  };
  reverifyFlip: {
    flipped: number;
    priorValid: number;
    rate: number | null;
  };
  sendSide: {
    hardBounces: number;
    complaints: number;
    note: string;
  };
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? numerator / denominator : null;

function int(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function computeContactMetrics(
  runner: ContactMetricsQueryRunner,
  input: ContactMetricsWindow & { workspaceId?: string },
): Promise<ContactMetricsSnapshot> {
  const ws = input.workspaceId ?? null;
  const params = [input.since, input.until] as unknown[];
  const wsClause = ws === null ? '' : ' AND workspace_id = $3';

  const [stateRows, companyRows, hitRows, voteRows, errorRows, disagreeRows, catchAllRows, costRows, flipRows, bounceRows] =
    await Promise.all([
      // 1) email_state_coverage：终态（非 UNKNOWN）÷ 全部 email 点（当前快照）。
      runner.query<{ total: unknown; terminal: unknown }>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE verification_state <> 'UNKNOWN') AS terminal
           FROM contact_point WHERE type = 'email'${ws === null ? '' : ' AND workspace_id = $1'}`,
        ws === null ? [] : [ws],
      ),
      // 2) valid_email_company_coverage：有 ≥1 VALID email 的 match 公司 ÷ match 公司（当前快照）。
      runner.query<{ match_total: unknown; match_with_valid: unknown }>(
        `WITH match_companies AS (
           SELECT DISTINCT canonical_company_id AS company_id FROM lead
            WHERE fit_verdict = 'match'${ws === null ? '' : ' AND workspace_id = $1'}
         ), valid_companies AS (
           SELECT DISTINCT c.company_id FROM contact_point p
             JOIN canonical_contact c ON c.id = p.contact_id
            WHERE p.type = 'email' AND p.verification_state = 'VALID'${ws === null ? '' : ' AND p.workspace_id = $1'}
         )
         SELECT (SELECT count(*) FROM match_companies) AS match_total,
                (SELECT count(*) FROM match_companies m
                   JOIN valid_companies v ON v.company_id = m.company_id) AS match_with_valid`,
        ws === null ? [] : [ws],
      ),
      // 3) enrichment_hit_rate：finder 命中 ÷ 真实请求（hit+miss+error，skipped_* 不是请求）。
      runner.query<{ provider_key: string; hits: unknown; requests: unknown }>(
        `SELECT provider_key,
                count(*) FILTER (WHERE outcome = 'hit') AS hits,
                count(*) FILTER (WHERE outcome IN ('hit', 'miss', 'error')) AS requests
           FROM contact_enrichment_attempt
          WHERE attempted_at >= $1 AND attempted_at < $2${wsClause}
          GROUP BY provider_key ORDER BY provider_key`,
        ws === null ? params : [...params, ws],
      ),
      // 4) verification_valid_rate：VALID ÷ 有效裁决票（error/blocked 不计入分母）。
      runner.query<{ provider_key: string; valid: unknown; votes: unknown }>(
        `SELECT provider_key,
                count(*) FILTER (WHERE verdict = 'valid') AS valid,
                count(*) FILTER (WHERE verdict IN ('valid', 'invalid', 'catch_all', 'unknown')) AS votes
           FROM contact_point_verification_event
          WHERE created_at >= $1 AND created_at < $2${wsClause}
          GROUP BY provider_key ORDER BY provider_key`,
        ws === null ? params : [...params, ws],
      ),
      // 4b) 验证供应商错误票（告警输入）：error ÷ 全部票（含 error/blocked 之外的裁决票）。
      runner.query<{ errors: unknown; votes: unknown }>(
        `SELECT count(*) FILTER (WHERE verdict = 'error') AS errors,
                count(*) FILTER (WHERE verdict <> 'blocked') AS votes
           FROM contact_point_verification_event
          WHERE created_at >= $1 AND created_at < $2${wsClause}`,
        ws === null ? params : [...params, ws],
      ),
      // 5) verification_disagreement_rate：双验样本里 valid 与 invalid 同时出现的比例。
      runner.query<{ dual: unknown; conflicts: unknown }>(
        `WITH votes AS (
           SELECT contact_point_id,
                  count(DISTINCT provider_key) AS providers,
                  bool_or(verdict = 'valid') AS has_valid,
                  bool_or(verdict = 'invalid') AS has_invalid
             FROM contact_point_verification_event
            WHERE created_at >= $1 AND created_at < $2
              AND verdict IN ('valid', 'invalid', 'catch_all', 'unknown')${wsClause}
            GROUP BY contact_point_id
         )
         SELECT count(*) FILTER (WHERE providers >= 2) AS dual,
                count(*) FILTER (WHERE providers >= 2 AND has_valid AND has_invalid) AS conflicts
           FROM votes`,
        ws === null ? params : [...params, ws],
      ),
      // 6) catch_all_share：CATCH_ALL_RISKY ÷ email 点（当前快照）。
      runner.query<{ catch_all: unknown; total: unknown }>(
        `SELECT count(*) FILTER (WHERE verification_state = 'CATCH_ALL_RISKY') AS catch_all,
                count(*) AS total
           FROM contact_point WHERE type = 'email'${ws === null ? '' : ' AND workspace_id = $1'}`,
        ws === null ? [] : [ws],
      ),
      // 7) cost_per_valid_email：窗口内 finder+验证成本 ÷ 窗口内新晋 VALID 点。
      runner.query<{ spend: unknown; new_valid: unknown }>(
        `SELECT
           (SELECT coalesce(sum(cost_microusd), 0) FROM contact_enrichment_attempt
             WHERE attempted_at >= $1 AND attempted_at < $2${wsClause}) +
           (SELECT coalesce(sum(cost_microusd), 0) FROM contact_point_verification_event
             WHERE created_at >= $1 AND created_at < $2${wsClause}) AS spend,
           (SELECT count(*) FROM contact_point
             WHERE type = 'email' AND verification_state = 'VALID'
               AND valid_since >= $1 AND valid_since < $2${wsClause}) AS new_valid`,
        ws === null ? params : [...params, ws],
      ),
      // 8) reverify_flip_rate：窗口内复验过、此前有 valid 票、当前态 INVALID 的点 ÷ 此前有 valid 票的点。
      runner.query<{ prior_valid: unknown; flipped: unknown }>(
        `WITH reverified AS (
           SELECT DISTINCT contact_point_id FROM contact_point_verification_event
            WHERE created_at >= $1 AND created_at < $2
              AND verdict IN ('valid', 'invalid', 'catch_all', 'unknown')${wsClause}
         ), prior_valid AS (
           SELECT DISTINCT e.contact_point_id
             FROM contact_point_verification_event e
             JOIN reverified r ON r.contact_point_id = e.contact_point_id
            WHERE e.created_at < $1 AND e.verdict = 'valid'${wsClause.replace('workspace_id', 'e.workspace_id')}
         )
         SELECT (SELECT count(*) FROM prior_valid) AS prior_valid,
                (SELECT count(*) FROM prior_valid p
                   JOIN contact_point point ON point.id = p.contact_point_id
                  WHERE point.verification_state = 'INVALID') AS flipped`,
        ws === null ? params : [...params, ws],
      ),
      // 9) 发送侧绝对计数（分母在 gain-saas；引擎只报事件量）。
      runner.query<{ hard_bounces: unknown; complaints: unknown }>(
        `SELECT count(*) FILTER (WHERE value->>'event' = 'hard_bounce') AS hard_bounces,
                count(*) FILTER (WHERE value->>'event' = 'complaint') AS complaints
           FROM field_evidence
          WHERE field = 'email.delivery' AND provider_key = 'smtp_transport'
            AND created_at >= $1 AND created_at < $2${wsClause}`,
        ws === null ? params : [...params, ws],
      ),
    ]);

  const state = stateRows[0];
  const errorRow = errorRows[0];
  const company = companyRows[0];
  const disagree = disagreeRows[0];
  const catchAll = catchAllRows[0];
  const cost = costRows[0];
  const flip = flipRows[0];
  const bounce = bounceRows[0];

  return {
    window: { since: input.since.toISOString(), until: input.until.toISOString() },
    emailStateCoverage: {
      terminal: int(state?.terminal),
      total: int(state?.total),
      rate: ratio(int(state?.terminal), int(state?.total)),
    },
    validEmailCompanyCoverage: {
      withValid: int(company?.match_with_valid),
      matchCompanies: int(company?.match_total),
      rate: ratio(int(company?.match_with_valid), int(company?.match_total)),
    },
    enrichmentHitRate: hitRows.map((row) => ({
      provider: row.provider_key,
      numerator: int(row.hits),
      denominator: int(row.requests),
      rate: ratio(int(row.hits), int(row.requests)),
    })),
    verificationValidRate: voteRows.map((row) => ({
      provider: row.provider_key,
      numerator: int(row.valid),
      denominator: int(row.votes),
      rate: ratio(int(row.valid), int(row.votes)),
    })),
    verificationDisagreement: {
      conflicts: int(disagree?.conflicts),
      dualVerified: int(disagree?.dual),
      rate: ratio(int(disagree?.conflicts), int(disagree?.dual)),
    },
    verificationErrorRate: {
      errors: int(errorRow?.errors),
      votes: int(errorRow?.votes),
      rate: ratio(int(errorRow?.errors), int(errorRow?.votes)),
    },
    catchAllShare: {
      catchAll: int(catchAll?.catch_all),
      emailPoints: int(catchAll?.total),
      rate: ratio(int(catchAll?.catch_all), int(catchAll?.total)),
    },
    costPerValidEmail: {
      spendMicrousd: int(cost?.spend),
      newValid: int(cost?.new_valid),
      microusdPerValid: ratio(int(cost?.spend), int(cost?.new_valid)),
    },
    reverifyFlip: {
      flipped: int(flip?.flipped),
      priorValid: int(flip?.prior_valid),
      rate: ratio(int(flip?.flipped), int(flip?.prior_valid)),
    },
    sendSide: {
      hardBounces: int(bounce?.hard_bounces),
      complaints: int(bounce?.complaints),
      note: '发送量分母在 gain-saas（引擎无发送记录）：hard_bounce_rate / complaint_rate / send_gate_block_rate 待 SaaS 报告接口接入后计算。',
    },
  };
}

// ---------------------------------------------------------------------------
// 告警（计划 §2.3.12 三条：VALID 覆盖率连续下降 / 验证错误率 / 成本超限）
// ---------------------------------------------------------------------------

export type ContactAlertStatus = 'OK' | 'FIRING' | 'INSUFFICIENT_DATA';

export interface ContactAlertEvaluation {
  id: 'valid_company_coverage_drop' | 'verification_error_rate' | 'cost_per_valid_email_overrun';
  status: ContactAlertStatus;
  severity: 'WARNING' | 'CRITICAL';
  message: string;
  observed?: number | null;
  bound?: number;
}

export const CONTACT_ALERT_BOUNDS = Object.freeze({
  /** 周环比下降 >3pp 且连续 2 周（§2.3.12）。 */
  validCoverageDropPp: 0.03,
  /** 验证供应商错误票 ÷ 全部票 >20%（§2.3.4.6 熔断口径）。 */
  verificationErrorRate: 0.2,
  /** 每个 VALID 邮箱成本 >1.5 × $0.06 = $0.09（§2.3.9 / §2.3.12）。 */
  costPerValidUsd: 0.09,
});

export function evaluateContactWeeklyAlerts(input: {
  /** 本周与前两周的 valid_email_company_coverage（缺省 = 数据不足）。 */
  validCoverageSeries: Array<number | null>;
  verificationErrors: number;
  verificationVotes: number;
  costMicrousdPerValid: number | null;
}): ContactAlertEvaluation[] {
  const bounds = CONTACT_ALERT_BOUNDS;
  const [current, previous, beforePrevious] = input.validCoverageSeries;
  let coverage: ContactAlertEvaluation;
  if (
    current === null || current === undefined ||
    previous === null || previous === undefined ||
    beforePrevious === null || beforePrevious === undefined
  ) {
    coverage = {
      id: 'valid_company_coverage_drop',
      status: 'INSUFFICIENT_DATA',
      severity: 'WARNING',
      message: '需要连续 3 周数据才能判定「连续 2 周下降 >3pp」（当前不足）',
    };
  } else {
    const dropThisWeek = previous - current > bounds.validCoverageDropPp;
    const dropLastWeek = beforePrevious - previous > bounds.validCoverageDropPp;
    coverage = {
      id: 'valid_company_coverage_drop',
      status: dropThisWeek && dropLastWeek ? 'FIRING' : 'OK',
      severity: 'WARNING',
      observed: current,
      bound: bounds.validCoverageDropPp,
      message: dropThisWeek && dropLastWeek
        ? `VALID 公司覆盖率连续 2 周下降 >3pp（本周 ${(current * 100).toFixed(1)}%，上周 ${(previous * 100).toFixed(1)}%，前周 ${(beforePrevious * 100).toFixed(1)}%）`
        : `VALID 公司覆盖率本周 ${(current * 100).toFixed(1)}%（未触发连续下降告警）`,
    };
  }

  const errorRate =
    input.verificationVotes > 0 ? input.verificationErrors / (input.verificationErrors + input.verificationVotes) : null;
  const errorAlert: ContactAlertEvaluation = {
    id: 'verification_error_rate',
    status: errorRate === null ? 'INSUFFICIENT_DATA' : errorRate > bounds.verificationErrorRate ? 'FIRING' : 'OK',
    severity: 'WARNING',
    observed: errorRate,
    bound: bounds.verificationErrorRate,
    message:
      errorRate === null
        ? '本周无验证样本'
        : `验证供应商错误率 ${(errorRate * 100).toFixed(1)}%（阈值 20%；检查 key/欠费/限流与熔断状态）`,
  };

  const costUsd =
    input.costMicrousdPerValid === null ? null : input.costMicrousdPerValid / 1_000_000;
  const costAlert: ContactAlertEvaluation = {
    id: 'cost_per_valid_email_overrun',
    status: costUsd === null ? 'INSUFFICIENT_DATA' : costUsd > bounds.costPerValidUsd ? 'FIRING' : 'OK',
    severity: 'WARNING',
    observed: costUsd,
    bound: bounds.costPerValidUsd,
    message:
      costUsd === null
        ? '本周无新增 VALID，无法计算单位获客成本'
        : `每 VALID 邮箱成本 $${costUsd.toFixed(4)}（阈值 $0.09 = 1.5 × $0.06）`,
  };

  return [coverage, errorAlert, costAlert];
}

// ---------------------------------------------------------------------------
// 周报快照（contact_metrics_snapshot，平台表）：Schedule 每周写一行，
// 「连续 2 周下降」用最近 3 条快照的覆盖率序列判定。
// ---------------------------------------------------------------------------

export interface ContactMetricsSnapshotClient {
  contactMetricsSnapshot: {
    findMany(args: {
      where: { workspaceId: string | null; capturedAt?: { lt: Date } };
      orderBy: { capturedAt: 'desc' };
      take: number;
      select: { capturedAt: true; metrics: true };
    }): Promise<Array<{ capturedAt: Date; metrics: unknown }>>;
    create(args: {
      data: {
        windowSince: Date;
        windowUntil: Date;
        workspaceId: string | null;
        metrics: unknown;
        alerts: unknown;
      };
    }): Promise<unknown>;
  };
}

/**
 * 从最近快照提取 valid_email_company_coverage 序列（新→旧）。
 * 返回 [本周前的上周, 前周, …]，供「连续 2 周下降」判定。
 */
export async function loadCoverageHistory(
  client: ContactMetricsSnapshotClient,
  input: { workspaceId: string | null; before: Date; limit?: number },
): Promise<Array<number | null>> {
  const rows = await client.contactMetricsSnapshot.findMany({
    where: { workspaceId: input.workspaceId, capturedAt: { lt: input.before } },
    orderBy: { capturedAt: 'desc' },
    take: input.limit ?? 2,
    select: { capturedAt: true, metrics: true },
  });
  return rows.map((row) => {
    const metrics = row.metrics as { validEmailCompanyCoverage?: { rate?: number | null } } | null;
    const rate = metrics?.validEmailCompanyCoverage?.rate;
    return typeof rate === 'number' ? rate : null;
  });
}

export async function persistContactMetricsSnapshot(
  client: ContactMetricsSnapshotClient,
  snapshot: ContactMetricsSnapshot,
  alerts: ContactAlertEvaluation[],
  workspaceId: string | null = null,
): Promise<void> {
  await client.contactMetricsSnapshot.create({
    data: {
      windowSince: new Date(snapshot.window.since),
      windowUntil: new Date(snapshot.window.until),
      workspaceId,
      metrics: snapshot as unknown,
      alerts: alerts as unknown,
    },
  });
}

/** 周报正文（Markdown；docs/evidence 模板同构）。 */
export function renderContactWeeklyReportMarkdown(
  current: ContactMetricsSnapshot,
  alerts: ContactAlertEvaluation[],
  previous?: ContactMetricsSnapshot,
): string {
  const pct = (value: number | null): string =>
    value === null ? 'n/a（无样本）' : `${(value * 100).toFixed(1)}%`;
  const usd = (microusd: number | null): string =>
    microusd === null ? 'n/a（无新增 VALID）' : `$${(microusd / 1_000_000).toFixed(4)}`;
  const providerTable = (rows: ProviderRateRow[]): string =>
    rows.length === 0
      ? '（本周无调用）'
      : [
          '| provider | 分子 | 分母 | 比率 |',
          '| --- | --- | --- | --- |',
          ...rows.map(
            (row) => `| \`${row.provider}\` | ${row.numerator} | ${row.denominator} | ${pct(row.rate)} |`,
          ),
        ].join('\n');

  const alertLines = alerts.map(
    (alert) => `- **${alert.id}**：${alert.status} — ${alert.message}`,
  );

  const delta = (cur: number | null, prev: number | null | undefined): string => {
    if (cur === null) return '';
    if (prev === null || prev === undefined) return '';
    const pp = (cur - prev) * 100;
    return `（周环比 ${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp）`;
  };

  return `# 联系人工程周报（${current.window.since.slice(0, 10)} → ${current.window.until.slice(0, 10)}）

> 生成：\`scripts/contact-weekly-report.mts\` / CONTACT_WEEKLY_REPORT Schedule（计划 §2.3.12，G10）。
> 口径：分母为 0 一律 n/a——「没有样本」不是「0%」。

## 覆盖

| 指标 | 值 |
| --- | --- |
| email_state_coverage（终态 ÷ 全部 email 点） | ${pct(current.emailStateCoverage.rate)}（${current.emailStateCoverage.terminal}/${current.emailStateCoverage.total}） |
| valid_email_company_coverage（≥1 VALID 的 match 公司） | ${pct(current.validEmailCompanyCoverage.rate)}${delta(current.validEmailCompanyCoverage.rate, previous?.validEmailCompanyCoverage.rate)}（${current.validEmailCompanyCoverage.withValid}/${current.validEmailCompanyCoverage.matchCompanies}） |
| catch_all_share（CATCH_ALL_RISKY ÷ email 点） | ${pct(current.catchAllShare.rate)}（${current.catchAllShare.catchAll}/${current.catchAllShare.emailPoints}） |

## 富集（finder）

${providerTable(current.enrichmentHitRate)}

## 验证

${providerTable(current.verificationValidRate)}

- 双验分歧率：${pct(current.verificationDisagreement.rate)}（${current.verificationDisagreement.conflicts}/${current.verificationDisagreement.dualVerified}）
- 复验翻转率（VALID→非 VALID）：${pct(current.reverifyFlip.rate)}（${current.reverifyFlip.flipped}/${current.reverifyFlip.priorValid}）

## 成本

- 每 VALID 邮箱成本：${usd(current.costPerValidEmail.microusdPerValid)}（花费 ${current.costPerValidEmail.spendMicrousd} 微美元 ÷ 新增 VALID ${current.costPerValidEmail.newValid}）

## 发送侧（分母在 gain-saas）

- 硬退事件计数：${current.sendSide.hardBounces}；投诉事件计数：${current.sendSide.complaints}
- ${current.sendSide.note}

## 告警（3 条，§2.3.12）

${alertLines.join('\n')}
`;
}
