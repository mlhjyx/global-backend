/**
 * 召回审计脚手架（ch03 §3.17 Tier A 子集，纯函数无依赖）。
 *
 * v0 口径（必须在报告里原样声明）：
 *  - 分母 = 目标市场 frame 的冻结实体集合（不是「我们库里有多少」）；
 *  - 「找到」= 实体以注册号键（scheme + regNumber）出现在本次 run 产出池里——
 *    不做名称/域名模糊匹配（那是 T3-20 完整审计的事）；
 *  - 召回与域名解析率都给 Wilson 95% 置信区间；层内实体不足抽样量时全查（census）；
 *  - 抽样用固定 seed 的确定性 PRNG，报告记录 seed，可复算。
 *
 * v2（本波）新增：
 *  - `missedKeys`：抽样里未命中的实体键——报告可复核、可归因；
 *  - 环比对比（`compareRecallAudit`，|Δ|≥5pp 标记，ch03 §3.17.4）；
 *  - miss 归因汇总（`summarizeMissReasons`，裁决词表 Top-N + 未归因计数）。
 *
 * 本文件不 import 任何模块（可被 `node scripts/frames/recall-audit.mjs` 直接加载）。
 */

export interface RecallFrameEntity {
  scheme: string;
  regNumber: string;
  country: string;
  name?: string;
  nace?: string | null;
  employeeBand?: string | null;
}

export interface RecallPoolRecord {
  name?: string;
  registryScheme?: string | null;
  registryNumber?: string | null;
  domain?: string | null;
  contactFound?: boolean;
  contacts?: number;
}

export interface WilsonInterval {
  estimate: number;
  low: number;
  high: number;
}

export interface StratumAudit {
  stratumKey: string;
  /** frame 内该层实体总数。 */
  N: number;
  /** 抽样（或全查）数量。 */
  n: number;
  found: number;
  domainResolved: number;
  contactFound: number;
  recall: WilsonInterval | null;
  domainRate: WilsonInterval | null;
  domainRateOfFound: WilsonInterval | null;
  contactRate: WilsonInterval | null;
  census: boolean;
}

export interface RecallAuditResult {
  strata: StratumAudit[];
  totals: {
    N: number;
    n: number;
    found: number;
    domainResolved: number;
    contactFound: number;
    recall: WilsonInterval | null;
    domainRate: WilsonInterval | null;
  };
  sample: { size: number | null; seed: string | null; sampled: boolean };
  /** 未在池中出现的抽样实体数（= 召回缺口），供 miss 归因脚注。 */
  missed: number;
  /** 未命中的抽样实体键（normalizeRegKey 形式），顺序 = 层内确定性抽样顺序。 */
  missedKeys: string[];
}

/** 业务键归一：scheme 小写 + 注册号大写折叠空白（与 frame-normalize 同规则）。 */
export function normalizeRegKey(scheme: string, regNumber: string): string {
  const normalizedScheme = scheme.trim().toLowerCase();
  const normalizedNumber = regNumber.normalize('NFC').replace(/\s+/gu, ' ').trim().toUpperCase();
  return `${normalizedScheme}\u0001${normalizedNumber}`;
}

export function stratumKey(entity: RecallFrameEntity): string {
  const nace2 = entity.nace && /^\d{2}/u.test(entity.nace) ? entity.nace.slice(0, 2) : 'NA';
  const band = entity.employeeBand ?? 'NA';
  return `${entity.country || 'NA'}:${nace2}:${band}`;
}

/** Wilson score interval（95% 默认 z=1.96）；n=0 返回 null。 */
export function wilsonInterval(successes: number, n: number, z = 1.96): WilsonInterval | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const k = Math.min(Math.max(successes, 0), n);
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    estimate: p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

/** FNV-1a 32-bit：把字符串 seed 转成 PRNG 种子。 */
export function seedFromString(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32 PRNG：确定性、无依赖。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 确定性抽样：对（已按业务键排序的）输入做部分 Fisher-Yates。
 * seed = 基础 seed + 层键，层间独立、同 seed 可复算。
 */
export function seededSample<T>(
  items: T[],
  size: number,
  seed: string,
  salt = '',
): T[] {
  if (size >= items.length) return [...items];
  const random = mulberry32(seedFromString(`${seed}\u0001${salt}`));
  const pool = [...items];
  for (let i = 0; i < size; i++) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, size);
}

export interface AuditRecallInput {
  frame: RecallFrameEntity[];
  pool: RecallPoolRecord[];
  /** 每层抽样量；缺省 = census（层内全查）。 */
  sampleSize?: number | null;
  seed?: string | null;
  z?: number;
}

export function auditRecall(input: AuditRecallInput): RecallAuditResult {
  const z = input.z ?? 1.96;
  const sampleSize = input.sampleSize ?? null;
  const seed = input.seed ?? null;
  if (sampleSize !== null && (!Number.isInteger(sampleSize) || sampleSize <= 0)) {
    throw new Error(`sampleSize 必须是正整数，收到 ${String(input.sampleSize)}`);
  }

  interface PoolAggregate {
    hasDomain: boolean;
    hasContact: boolean;
  }
  const poolByKey = new Map<string, PoolAggregate>();
  for (const record of input.pool) {
    if (!record.registryScheme || !record.registryNumber) continue;
    const key = normalizeRegKey(record.registryScheme, record.registryNumber);
    const aggregate = poolByKey.get(key) ?? { hasDomain: false, hasContact: false };
    if (record.domain && record.domain.trim()) aggregate.hasDomain = true;
    if (record.contactFound === true || (record.contacts ?? 0) > 0) aggregate.hasContact = true;
    poolByKey.set(key, aggregate);
  }

  const byStratum = new Map<string, RecallFrameEntity[]>();
  for (const entity of input.frame) {
    const key = stratumKey(entity);
    const bucket = byStratum.get(key);
    if (bucket) bucket.push(entity);
    else byStratum.set(key, [entity]);
  }

  const strata: StratumAudit[] = [];
  const missedKeys: string[] = [];
  let totalN = 0;
  let totaln = 0;
  let totalFound = 0;
  let totalDomain = 0;
  let totalContact = 0;

  for (const key of [...byStratum.keys()].sort()) {
    const bucket = [...byStratum.get(key)!].sort((a, b) =>
      normalizeRegKey(a.scheme, a.regNumber).localeCompare(normalizeRegKey(b.scheme, b.regNumber)),
    );
    const census = sampleSize === null || sampleSize >= bucket.length;
    const sampled = census
      ? bucket
      : seededSample(bucket, sampleSize!, seed ?? 'default', key);

    let found = 0;
    let domainResolved = 0;
    let contactFound = 0;
    for (const entity of sampled) {
      const regKey = normalizeRegKey(entity.scheme, entity.regNumber);
      const aggregate = poolByKey.get(regKey);
      if (!aggregate) {
        missedKeys.push(regKey);
        continue;
      }
      found++;
      if (aggregate.hasDomain) domainResolved++;
      if (aggregate.hasContact) contactFound++;
    }

    const n = sampled.length;
    strata.push({
      stratumKey: key,
      N: bucket.length,
      n,
      found,
      domainResolved,
      contactFound,
      recall: wilsonInterval(found, n, z),
      domainRate: wilsonInterval(domainResolved, n, z),
      domainRateOfFound: wilsonInterval(domainResolved, found, z),
      contactRate: wilsonInterval(contactFound, n, z),
      census,
    });
    totalN += bucket.length;
    totaln += n;
    totalFound += found;
    totalDomain += domainResolved;
    totalContact += contactFound;
  }

  return {
    strata,
    totals: {
      N: totalN,
      n: totaln,
      found: totalFound,
      domainResolved: totalDomain,
      contactFound: totalContact,
      recall: wilsonInterval(totalFound, totaln, z),
      domainRate: wilsonInterval(totalDomain, totaln, z),
    },
    sample: { size: sampleSize, seed: sampleSize === null ? null : seed, sampled: sampleSize !== null },
    missed: totaln - totalFound,
    missedKeys,
  };
}

/**
 * 环比对比（ch03 §3.17.4）：与上一期报告逐层比 recall / domain_rate，
 * |Δ| ≥ thresholdPp（默认 5pp）标记，交由报告层标红并要求书面原因。
 */
export interface RecallAuditComparisonRow {
  stratumKey: string;
  /** (current - baseline) × 100；基线缺该层时为 null。 */
  recallDeltaPp: number | null;
  domainRateDeltaPp: number | null;
  flagged: boolean;
}

export interface RecallAuditComparison {
  baselinePeriod: string | null;
  thresholdPp: number;
  rows: RecallAuditComparisonRow[];
  totals: {
    recallDeltaPp: number | null;
    domainRateDeltaPp: number | null;
    flagged: boolean;
  };
  /** 本期有、基线没有的层（口径变化提示）。 */
  newStrata: string[];
  /** 基线有、本期没有的层（口径变化提示）。 */
  droppedStrata: string[];
}

function deltaPp(
  current: WilsonInterval | null,
  baseline: WilsonInterval | null | undefined,
): number | null {
  if (!current || !baseline) return null;
  return Number(((current.estimate - baseline.estimate) * 100).toFixed(1));
}

export function compareRecallAudit(
  current: RecallAuditResult,
  baseline: RecallAuditResult,
  baselinePeriod: string | null = null,
  thresholdPp = 5,
): RecallAuditComparison {
  const baselineByKey = new Map(baseline.strata.map((stratum) => [stratum.stratumKey, stratum]));
  const currentKeys = new Set(current.strata.map((stratum) => stratum.stratumKey));
  const rows: RecallAuditComparisonRow[] = current.strata.map((stratum) => {
    const previous = baselineByKey.get(stratum.stratumKey);
    const recallDelta = deltaPp(stratum.recall, previous?.recall);
    const domainDelta = deltaPp(stratum.domainRate, previous?.domainRate);
    return {
      stratumKey: stratum.stratumKey,
      recallDeltaPp: recallDelta,
      domainRateDeltaPp: domainDelta,
      flagged: [recallDelta, domainDelta].some(
        (delta) => delta !== null && Math.abs(delta) >= thresholdPp,
      ),
    };
  });
  const recallTotal = deltaPp(current.totals.recall, baseline.totals.recall);
  const domainTotal = deltaPp(current.totals.domainRate, baseline.totals.domainRate);
  return {
    baselinePeriod,
    thresholdPp,
    rows,
    totals: {
      recallDeltaPp: recallTotal,
      domainRateDeltaPp: domainTotal,
      flagged: [recallTotal, domainTotal].some(
        (delta) => delta !== null && Math.abs(delta) >= thresholdPp,
      ),
    },
    newStrata: rows.map((row) => row.stratumKey).filter((key) => !baselineByKey.has(key)).sort(),
    droppedStrata: baseline.strata
      .map((stratum) => stratum.stratumKey)
      .filter((key) => !currentKeys.has(key))
      .sort(),
  };
}

/**
 * miss 归因汇总：把人工/规则裁决（`miss_reason` 词表见 ch03 §3.17.2）落到未命中键上。
 * 未裁决的记为 unattributed——报告必须显式暴露它，防止「Top 原因」掩盖覆盖缺口。
 */
export interface RecallMissVerdict {
  scheme: string;
  regNumber: string;
  missReason: string;
}

export interface MissReasonSummary {
  missed: number;
  attributed: number;
  unattributed: number;
  reasons: Array<{ reason: string; count: number; shareOfMissed: number }>;
}

export function summarizeMissReasons(
  missedKeys: string[],
  verdicts: RecallMissVerdict[],
): MissReasonSummary {
  const reasonByKey = new Map<string, string>();
  for (const verdict of verdicts) {
    if (!verdict || typeof verdict.missReason !== 'string' || !verdict.missReason.trim()) continue;
    const key = normalizeRegKey(verdict.scheme, verdict.regNumber);
    if (!reasonByKey.has(key)) reasonByKey.set(key, verdict.missReason.trim());
  }
  const counts = new Map<string, number>();
  let attributed = 0;
  for (const key of missedKeys) {
    const reason = reasonByKey.get(key);
    if (!reason) continue;
    attributed++;
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const missed = missedKeys.length;
  const reasons = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([reason, count]) => ({
      reason,
      count,
      shareOfMissed: missed > 0 ? count / missed : 0,
    }));
  return { missed, attributed, unattributed: missed - attributed, reasons };
}

function formatInterval(interval: WilsonInterval | null): string {
  if (!interval) return '—';
  const estimate = (interval.estimate * 100).toFixed(1);
  const halfWidth = ((interval.high - interval.low) / 2) * 100;
  return `${estimate}% ±${halfWidth.toFixed(1)}pp`;
}

function formatDelta(deltaPp: number | null): string {
  if (deltaPp === null) return '—';
  return `${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(1)}pp`;
}

export interface RecallReportMeta {
  period: string;
  frameKey?: string | null;
  frameSnapshotId?: string | null;
  poolSource?: string | null;
  generatedAt?: string | null;
}

export interface RecallReportExtras {
  comparison?: RecallAuditComparison;
  missReasons?: MissReasonSummary;
}

/**
 * 固定模板月报（ch03 §3.17.4 子集）：口径声明 → 总览表 → 环比 → 召回缺口 + miss 归因
 * → 方法说明。
 */
export function renderRecallReportMarkdown(
  result: RecallAuditResult,
  meta: RecallReportMeta,
  extras: RecallReportExtras = {},
): string {
  const lines: string[] = [];
  lines.push(`# 召回审计报告 · ${meta.period}`);
  lines.push('');
  lines.push('## 口径声明');
  lines.push('');
  lines.push(`- tier：Tier A（注册口径召回，v0 脚手架口径）`);
  lines.push(`- frame：${meta.frameKey ?? '（未指定）'}${meta.frameSnapshotId ? `（snapshot ${meta.frameSnapshotId}）` : ''}`);
  lines.push(`- 产出池：${meta.poolSource ?? '（未指定）'}`);
  if (result.sample.sampled) {
    lines.push(`- 抽样：每层 n=${result.sample.size}；seed=\`${result.sample.seed ?? ''}\``);
  } else {
    lines.push('- 抽样：census（层内全查，未抽样）');
  }
  lines.push(`- 生成时间：${meta.generatedAt ?? new Date().toISOString()}`);
  lines.push('- 匹配口径：注册号键（scheme + regNumber）精确匹配；不做名称/域名模糊匹配');
  lines.push('- 置信区间：Wilson score interval，95%（z=1.96）');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push('| stratum | N | n | found | recall ±95%CI | domain_rate ±95%CI | contact_rate ±95%CI |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const stratum of result.strata) {
    lines.push(
      `| ${stratum.stratumKey} | ${stratum.N} | ${stratum.n} | ${stratum.found} | ${formatInterval(stratum.recall)} | ${formatInterval(stratum.domainRate)} | ${formatInterval(stratum.contactRate)} |`,
    );
  }
  lines.push(
    `| **合计** | ${result.totals.N} | ${result.totals.n} | ${result.totals.found} | ${formatInterval(result.totals.recall)} | ${formatInterval(result.totals.domainRate)} | — |`,
  );
  lines.push('');
  if (extras.comparison) {
    const comparison = extras.comparison;
    lines.push(
      `## 环比（vs ${comparison.baselinePeriod ?? '上一期'}，|Δ|≥${comparison.thresholdPp}pp 标 ⚠）`,
    );
    lines.push('');
    lines.push('| stratum | recall Δ | domain_rate Δ | 标记 |');
    lines.push('|---|---|---|---|');
    for (const row of comparison.rows) {
      lines.push(
        `| ${row.stratumKey} | ${formatDelta(row.recallDeltaPp)} | ${formatDelta(row.domainRateDeltaPp)} | ${row.flagged ? '⚠' : ''} |`,
      );
    }
    lines.push(
      `| **合计** | ${formatDelta(comparison.totals.recallDeltaPp)} | ${formatDelta(comparison.totals.domainRateDeltaPp)} | ${comparison.totals.flagged ? '⚠' : ''} |`,
    );
    if (comparison.newStrata.length > 0) {
      lines.push('');
      lines.push(`- 新增层（基线无，口径变化）：${comparison.newStrata.join('、')}`);
    }
    if (comparison.droppedStrata.length > 0) {
      lines.push(`- 消失层（本期无，口径变化）：${comparison.droppedStrata.join('、')}`);
    }
    lines.push('');
  }
  lines.push('## 召回缺口');
  lines.push('');
  const missRate = result.totals.n > 0 ? ((result.missed / result.totals.n) * 100).toFixed(1) : '—';
  lines.push(
    `- 抽样实体中未在产出池出现：${result.missed}/${result.totals.n}（${missRate}%）——v0 只统计注册号键未命中，miss 原因分类（NO_FRAME_COVERAGE / PIPELINE_MISS / DOMAIN_NOT_FOUND …）见下方归因。`,
  );
  if (extras.missReasons) {
    const summary = extras.missReasons;
    lines.push('');
    lines.push(`## miss 归因（Top ${Math.min(summary.reasons.length, 5)}）`);
    lines.push('');
    if (summary.reasons.length === 0) {
      lines.push('- 无裁决数据（未提供 --verdicts 或裁决未覆盖任何未命中实体）。');
    } else {
      for (const reason of summary.reasons.slice(0, 5)) {
        lines.push(
          `- ${reason.reason}：${reason.count}（占未命中 ${(reason.shareOfMissed * 100).toFixed(1)}%）`,
        );
      }
      lines.push(
        `- 未归因：${summary.unattributed}/${summary.missed}——报告显式暴露该比例，Top 原因不得掩盖裁决缺口。`,
      );
    }
  }
  lines.push('');
  lines.push('## 方法说明');
  lines.push('');
  lines.push('- 分母来自官方 frame（外部注册库），不是「我们库里有多少」——反自证原则。');
  lines.push('- 每层最少 246（p=0.8 ±5%）/384（p=0.5 ±5%）样本；层内实体不足时全查并在本报告标注。');
  lines.push('- 报告由 `scripts/frames/recall-audit.mjs` 从 frame 导出 + run 产出导出重放生成；seed 与快照 ID 已记录。');
  lines.push('');
  return lines.join('\n');
}
