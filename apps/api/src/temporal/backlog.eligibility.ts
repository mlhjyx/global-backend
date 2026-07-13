import { Prisma } from '@prisma/client';
import { GENERIC_CONTACT_TITLE } from '../discovery/provider-contract';

/**
 * 存量对账下游阶段的「收缩集」谓词 + 排序，与处理水位。
 *
 * 修的根因（PR #20 对抗式复审 HIGH #1/#2）：下游四阶段（富集/信号/监控/联系人）的 WHERE 只按
 * 「fit=match」(+域名/结果依赖) 过滤，处理成功**不改变该谓词** → 扫描集永不收缩；叠加
 * workflow 每 sweep 把游标复位为 null（无跨-sweep 持久化）+ id 随机 UUID → 每 sweep 重扫最前固定
 * N 家，预算位次后的 match 公司永久够不到。
 *
 * 治法 = **处理水位 + 「最久未处理优先」排序（LRU）**：
 *  1. 给 canonical_company 加处理水位列，各阶段处理后**无论命中/失败/跳过**都 stamp（见下「为何 stamp-all」）；
 *     WHERE 加「水位 IS NULL（从未处理）或 水位 < now-TTL（已过冷却期）」→ 已处理且新鲜的行离开当批过滤集。
 *  2. 排序 `水位 ASC NULLS FIRST, id ASC`：**从未处理（NULL）的行永远排在已处理（有时间戳）的行之前**，
 *     其次最久未处理优先。这一步是关键——只靠 (1) 的水位收缩 + 旧的 `id ASC` 排序，会退化成一个
 *     C×T 跑步机（C=单 sweep 容量、T=TTL 折算 sweep 数）：最先处理的低-id 行最先过冷却期、又因 id 最小
 *     被重新抢到最前，永远压过从未处理的高-id 尾巴 → 存量 > C×T 时高-UUID 尾巴仍永久饿死（复审已核验此代数）。
 *     NULLS FIRST 让**整个「从未处理」存量在任何行被复处理之前先被吞完**，与存量规模无关地根除饿死。
 *
 * 为何 stamp-all（含 DAT-011 抑制/抓取失败的行也 stamp）：NULLS FIRST 下，未 stamp 的行水位恒为 NULL、
 * 永远排最前 → 若不 stamp 会被每一轮重复拉取、never advance = 单 sweep 内活锁。故必须 stamp 全部拉取行，
 * 让本轮已触的行下一轮离开（新鲜）。代价：DAT-011 抑制域/瞬时失败的行要等一个 TTL 冷却期才重试（复审 2 条
 * MEDIUM）——方向安全（欠抓、非违规过抓，live suspendedDomains() 守卫每 sweep 仍跑）、有界、自愈，可接受。
 *
 * 防活锁不变式因此从「id>cursor 分页」换成「stamp-after-touch」：单 sweep 每行至多处理一次（stamp 使其
 * 离开后续轮次），轮次上限封顶单 sweep 总量。下游阶段不再需要 id 游标（args.cursor 被忽略；workflow 的
 * nextCursor 退化为「本批满 = 还有更多」哨兵）。资格门① qualifyFitBacklog 仍用 id 游标——它判定后本 ICP 的
 * Lead.fitVerdict 由 null 变值、永久离开该 ICP 过滤集、无冷却期复活，集单调收缩、无跑步机，id 游标在那里是对的。
 */

export type WatermarkField =
  | 'lastEnrichedAt'
  | 'lastSignalAt'
  | 'lastWatchAt'
  | 'contactDiscoveryAttemptedAt'
  | 'emailGuessAttemptedAt';

/**
 * 各水位的冷却期（处理后多久才重新入选）。分级依据数据时变性：
 *  - enrich（GLEIF/Wikidata 准静态法人/行业事实）：30d 月度复核，捕捉新登记数据。
 *  - signal（digital_footprint/structured_harvest 时变信号）：7d，与 attributes.<源>._ts 的刷新周期对齐。
 *  - watch（web_watch 注册基本一次性；失败/无 sitemap 的重试冷却）：14d 双周复核。
 *  - contact（多页渲染+LLM，最贵；无具名决策人属常态）：14d，让「尝试过但空」的公司歇 14d 再试。
 *  - emailGuess（SMTP RCPT 探测，MX 准静态、探测贵）：30d 月度复核，别老锤 MX。
 */
export const BACKLOG_WATERMARK_TTL_MS: Record<WatermarkField, number> = {
  lastEnrichedAt: 30 * 24 * 3600 * 1000,
  lastSignalAt: 7 * 24 * 3600 * 1000,
  lastWatchAt: 14 * 24 * 3600 * 1000,
  contactDiscoveryAttemptedAt: 14 * 24 * 3600 * 1000,
  emailGuessAttemptedAt: 30 * 24 * 3600 * 1000, // SMTP 探测贵、别老锤 MX
};

/** 处理后的冷却截止时刻：水位 < 此值（或为 null）才重新入选。 */
export function watermarkCutoff(field: WatermarkField, now: Date): Date {
  return new Date(now.getTime() - BACKLOG_WATERMARK_TTL_MS[field]);
}

// 水位「从未处理 或 已过冷却期」的 OR 子句。用逐字段字面量（非计算键）保持 Prisma 类型收窄、不落 any。
const STALE_OR: Record<WatermarkField, (cutoff: Date) => Prisma.CanonicalCompanyWhereInput[]> = {
  lastEnrichedAt: (cutoff) => [{ lastEnrichedAt: null }, { lastEnrichedAt: { lt: cutoff } }],
  lastSignalAt: (cutoff) => [{ lastSignalAt: null }, { lastSignalAt: { lt: cutoff } }],
  lastWatchAt: (cutoff) => [{ lastWatchAt: null }, { lastWatchAt: { lt: cutoff } }],
  contactDiscoveryAttemptedAt: (cutoff) => [
    { contactDiscoveryAttemptedAt: null },
    { contactDiscoveryAttemptedAt: { lt: cutoff } },
  ],
  emailGuessAttemptedAt: (cutoff) => [
    { emailGuessAttemptedAt: null },
    { emailGuessAttemptedAt: { lt: cutoff } },
  ],
};

// 「最久未处理优先」排序：水位 ASC NULLS FIRST（从未处理的 NULL 行先于任何已处理行），id ASC 决胜。
const LRU_ORDER: Record<WatermarkField, Prisma.CanonicalCompanyOrderByWithRelationInput[]> = {
  lastEnrichedAt: [{ lastEnrichedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  lastSignalAt: [{ lastSignalAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  lastWatchAt: [{ lastWatchAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  contactDiscoveryAttemptedAt: [{ contactDiscoveryAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
  emailGuessAttemptedAt: [{ emailGuessAttemptedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
};

export interface BacklogEligibleOpts {
  /** 本阶段的处理水位列。 */
  watermarkField: WatermarkField;
  /** 当前时刻（活动内 new Date()）；cutoff = now - 该字段 TTL。 */
  now: Date;
  /** 信号/监控/联系人阶段：需有域名。 */
  requireDomain?: boolean;
  /**
   * 联系人阶段：仅尚无**具名/权威**联系人的公司（与水位冷却叠加）。generic public_web 公开联系点
   * （总机 `switchboard`，非个人）不算"已找到决策人"——否则 CH/决策人源本轮无产出时，一条兜底总机
   * 联系点就把公司永久挡在后续联系人 sweep 之外（#58 P2）。
   */
  requireNoPersonContact?: boolean;
  /** 邮箱猜测阶段：仅**有缺 email 决策人**的公司（有联系人但至少一位无 email contact_point）。 */
  requireEmaillessContact?: boolean;
}

/**
 * 下游阶段收缩集谓词：存在任一 ICP 的 match Lead + 未抑制 (+域名 +无联系人) + 水位 null/过期。
 * fit=match 现挂 Lead（per ICP×公司）→ 用 `leads: { some: { fitVerdict:'match' } }` 关联子查询过滤：
 * 富集/信号/监控/联系人是**公司级**处理（一次处理多 ICP 共享），故不按 ICP 限定，任一 ICP 判 match 即入选。
 * 顶层键隐式 AND：`leads.some AND status [AND domain] [AND contacts] AND (水位null OR 水位stale)`。
 * 分页/进度不靠 id 游标，靠 stamp-after-touch（见模块头）+ backlogEligibleOrderBy 的 LRU 排序。
 */
export function backlogEligibleWhere(opts: BacklogEligibleOpts): Prisma.CanonicalCompanyWhereInput {
  const cutoff = watermarkCutoff(opts.watermarkField, opts.now);
  return {
    leads: { some: { fitVerdict: 'match' } },
    status: { not: 'SUPPRESSED' },
    ...(opts.requireDomain ? { domain: { not: null } } : {}),
    // 具名/权威联系人 = 任何非 generic switchboard 占位（含 title 为空的具名董事）；仅有 generic
    // public_web 公开联系点（title=switchboard）的公司**仍**算"无决策人"→ 继续被联系人 sweep 捞（#58 P2）。
    ...(opts.requireNoPersonContact
      ? { contacts: { none: { OR: [{ title: null }, { title: { not: GENERIC_CONTACT_TITLE } }] } } }
      : {}),
    // 有联系人但至少一位缺 email contact_point → 邮箱猜测的补全对象（与 requireNoPersonContact 互斥语义）。
    ...(opts.requireEmaillessContact
      ? { contacts: { some: { contactPoints: { none: { type: 'email' } } } } }
      : {}),
    OR: STALE_OR[opts.watermarkField](cutoff),
  };
}

/** 下游阶段排序：最久未处理优先（NULL 先），根除 id-only 排序下的 C×T 跑步机饿死。 */
export function backlogEligibleOrderBy(field: WatermarkField): Prisma.CanonicalCompanyOrderByWithRelationInput[] {
  return LRU_ORDER[field];
}
