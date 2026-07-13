/**
 * 待办3 · 专利发明人 **postgres scoped 缓存** L0 客户端（scale-safe #89 生产启用）。
 *
 * 机制（judge-panel 选定的 postgres_scoped_cache 合成方案）：
 *   一次共享大扫（Job User 只读 BigQuery，护栏②④⑥ 全下推 SQL）把「近5年·独家申请人·仅 name」的
 *   assignee→inventor 拉回本表 → 逐公司发现时**只读 postgres**（零 BQ 字节、零 egress、不经 broker）。
 *   把现状「N 次全表扫（吃光 1TB/月额度）」塌缩成「每刷新周期 1 次扫」。用户零额外 GCP 设置。
 *
 * 🔴 8 护栏逐条保全（见 docs/roadmap/decision-maker-p1-patent-cache-design.md）：
 *  - ③ 国别门/T1 跨境防误并：缓存存 `assigneeCountry` 进唯一键（DE"Acme"/US"Acme" 天然两行）+ 读侧
 *    **按 (assigneeNorm, assigneeCountry) 双键分组**重建合成 PatentRecord（每组=一条，携各自单国别）→
 *    provider 逐专利国别门有分流依据。**绝不只按 assigneeNorm 分组**（否则 DE/US 同名被并、T1 静默失效）。
 *  - ⑥ 数据最小化 + PII：`inventorName` **pii-crypto 确定性加密落盘**（读侧 decryptPii）；`inventorNameKey`
 *    = 归一人名**不可逆盲索引**（Art.17 擦除按人名 O(1) 命中，不泄明文）。绝无 residence/国籍/country_code。
 *  - ⑦ CC BY 4.0：`license` 列派生溯源（provider 仍从常量注入 field_evidence.license）。
 *  - ⑧ §8.8 用途门 fail-closed：**刷新侧自守**（扫 BQ 前重校 source_policy）；读侧查 postgres 无 egress，天然不需。
 *
 * 纯逻辑（{@link buildSyntheticRecords}）与 I/O（{@link readPatentCache} / {@link refreshPatentCache}）分离，便于测试。
 */
import type { PrismaClient } from '@prisma/client';
import {
  PatentRecord,
  PatentSearchOptions,
  RefreshScanResult,
  assigneeLikeAnchor,
  GOOGLE_PATENTS_LICENSE,
  MAX_INVENTORS_PER_ASSIGNEE,
} from './bigquery-patents';
import { normForMatch } from '../discovery/name-match';
import { foldedPersonNameKey, personNameKeyVariants } from '../discovery/person-name';
import { encryptPii, decryptPii, blindContactKey, piiKeyConfigured } from '../compliance/pii-crypto';

/** §8.8 治理域（与 googlePatentsSearchTool.compliance.policyDomain 一致）。 */
export const PATENT_POLICY_DOMAIN = 'bigquery.googleapis.com';
/** 🔴 kill-switch 执行点（`data_provider.key`）——seed=DISABLED，未签 LIA/DPIA 前刷新/enqueue 皆不物化 PII（P1-1）。 */
export const PATENT_PROVIDER_KEY = 'google_patents';
/** 刷新滚动窗口（年）——**必须镜像 provider RECENCY_YEARS=5**（缓存路径与直连路径同窗，护栏④）。 */
export const PATENT_CACHE_WINDOW_YEARS = 5;
/** 每轮刷新 anchor 上限（超出记 log 留 PENDING 下轮，FIFO 不饿死；judge 提出的谓词过大缓解）。 */
const MAX_ANCHORS_PER_REFRESH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 180;

/**
 * 缓存行 TTL（天）：env `PATENT_CACHE_TTL_DAYS`（改名/退源行自然清理 + GDPR 存储限制），无效值回退 180。
 * 🔴 硬顶 180d（Codex PR #93 P2-3）：运维可设**更短**（更强隐私）但绝不允许超过 DEFAULT_TTL_DAYS——
 * 加密发明人名保留期是承诺的合规上限（严于 source_policy.retentionDays），正值也 clamp。
 */
function ttlDaysFromEnv(): number {
  const v = Number(process.env.PATENT_CACHE_TTL_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), DEFAULT_TTL_DAYS) : DEFAULT_TTL_DAYS;
}

/** 国别归一 → alpha-2 小写 或 ''（未知；令唯一键成立、欠并方向）。 */
function normCountryLoose(v?: string): string {
  const s = (v ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : '';
}

/**
 * 🔴 国别冲突（与 provider `countryConflicts` **同规则**）：a、b **都为 alpha-2 且不同** → 冲突；
 * 任一未知（非 alpha-2/空）→ 不冲突（欠并方向）。用于 P1-2 按 (norm,country) 过滤——queued DE 的 assignee
 * 绝不因同归一名把扫描溜进的 US 同名公司发明人一并落库（数据最小化，与读侧国别门对齐）。
 */
function countriesConflict(a: string, b: string): boolean {
  const isA2 = (s: string): boolean => /^[a-z]{2}$/.test(s);
  return isA2(a) && isA2(b) && a !== b;
}

/**
 * 🔴 PII 密钥 preflight：不仅**存在**，还要**形态合法**（32 字节可派生）——用一次 trial derive 校验。
 * 扫 BQ 前校验，避免密钥虽非空但畸形时扫了 BQ 才在 inventorBlindKey/encryptPii 派生处炸（浪费一次扫描）。
 */
function piiPreflightOk(): boolean {
  try {
    return piiKeyConfigured() && !!blindContactKey('__patent_cache_preflight__');
  } catch {
    return false;
  }
}

/**
 * 🔴 发明人姓名**不可逆盲索引**（Art.17 擦除键）——`blindContactKey(foldedPersonNameKey(rawName))`。
 * 存**最大折叠**形（umlautFold）：归一名解析不出（罕见）→ 返 ''（该行不可按人名擦除，靠 TTL 清理；空键永不被 {@link inventorErasureKeys} 命中）。
 * 🔴 与 {@link inventorErasureKeys} 的**不变式**：foldedPersonNameKey 形恒 ∈ personNameKeyVariants → 擦除必命中（跨 umlaut 拼写收敛）。
 */
export function inventorBlindKey(rawInventorName: string): string {
  const folded = foldedPersonNameKey(rawInventorName);
  return folded ? blindContactKey(folded) : '';
}

/**
 * Art.17 擦除：给定被擦除人姓名 → 匹配缓存 `inventorNameKey` 的**盲键集**（over-suppress 变体，方向偏过禁）。
 * personNameKeyVariants 含 identityVariant 形（= {@link inventorBlindKey} 存的 normalizePersonName 形）→ 必命中
 * 存储行；多变体（变音丢弃/umlaut 折叠）额外覆盖跨拼写。空/纯称谓 → []（不误删）。
 */
export function inventorErasureKeys(subjectName: string): string[] {
  const keys = new Set<string>();
  for (const v of personNameKeyVariants(subjectName)) {
    if (v) keys.add(blindContactKey(v));
  }
  return [...keys];
}

// ── Step 2b/3 读侧（零 BQ 字节，无 egress）──────────────────────────────────

/** 读侧缓存行最小面（decryptPii 前）。 */
export interface CacheInventorRow {
  assigneeNameRaw: string;
  assigneeNorm: string;
  assigneeCountry: string;
  inventorName: string; // 🔴 加密密文；buildSyntheticRecords 内 decryptPii
}

/** 读侧 DB 最小面（app_user 或 owner 皆可——本表无 RLS）。 */
export type PatentCacheReadDb = {
  patentInventorCache: Pick<PrismaClient['patentInventorCache'], 'findMany'>;
};

/**
 * 🔴 双键分组重建合成 `PatentRecord[]`（护栏③/T1 的核心）：按 **(assigneeNorm, assigneeCountry)** 分组，
 * 每组 = 一条合成专利记录（applicants=[该组单一申请人 + 己国别]，inventors=组内 distinct 解密发明人名）。
 * 因缓存只存**独家申请人**行（护栏②刷新下推），每条合成记录 applicants.length===1 → provider 独家门恒过。
 * DE"Acme"/US"Acme" → 两组两记录各携己国别 → provider 逐专利国别门可分流（绝不并他国同名公司发明人）。
 */
export function buildSyntheticRecords(rows: CacheInventorRow[]): PatentRecord[] {
  const groups = new Map<string, { rawNames: Set<string>; country: string; inventors: string[]; seen: Set<string> }>();
  for (const r of rows) {
    const norm = r.assigneeNorm;
    if (!norm) continue;
    const country = r.assigneeCountry ?? '';
    const key = `${norm}\u0000${country}`; // NUL 分隔防 norm/country 边界歧义
    let g = groups.get(key);
    if (!g) {
      g = { rawNames: new Set<string>(), country, inventors: [], seen: new Set<string>() };
      groups.set(key, g);
    }
    if (r.assigneeNameRaw) g.rawNames.add(r.assigneeNameRaw);
    const name = decryptPii(r.inventorName).trim(); // 🔴 只在此解密
    if (name && !g.seen.has(name)) {
      g.seen.add(name);
      g.inventors.push(name);
    }
  }
  const records: PatentRecord[] = [];
  for (const g of groups.values()) {
    if (!g.inventors.length) continue;
    // 组内原名变体都同归一（"Siemens AG"/"Siemens Aktiengesellschaft"）→ 取排序首个做确定性代表原名（供 provider pickBestByName）
    const applicantName = [...g.rawNames].sort()[0];
    if (!applicantName) continue;
    records.push({
      applicants: [{ name: applicantName, country: g.country || undefined }],
      inventors: g.inventors.map((name) => ({ name })),
    });
  }
  return records;
}

/**
 * 读缓存 → 合成 `PatentRecord[]`（形状与 {@link BigQueryPatentsClient.searchPatentsByAssignee} 全等 → provider 零改）。
 * anchor（复用 assigneeLikeAnchor）→ `assigneeNameRaw` 不区分大小写 contains + 未过期 + 窗口重叠 → 双键分组重建。
 * 无锚 → 空（同直连 no-op）。**零外部 egress**（纯 postgres 读）。
 */
export async function readPatentCache(
  db: PatentCacheReadDb,
  companyName: string,
  opts: PatentSearchOptions,
  now: () => number = Date.now,
): Promise<PatentRecord[]> {
  const anchor = assigneeLikeAnchor(companyName);
  if (!anchor) return [];
  // 还原 anchor 内 token（去 %…% 包裹 + 反转义）供 contains 谓词（与直连 UPPER(name) LIKE '%TOKEN%' 同义）。
  const token = anchor.replace(/^%/, '').replace(/%$/, '').replace(/\\([\\%_])/g, '$1');
  if (!token) return [];
  const rows = await db.patentInventorCache.findMany({
    where: {
      assigneeNameRaw: { contains: token, mode: 'insensitive' },
      expiresAt: { gt: new Date(now()) },
      windowToYear: { gte: opts.fromYear }, // 护栏④ 近5年：行窗口与请求窗口重叠
    },
    select: { assigneeNameRaw: true, assigneeNorm: true, assigneeCountry: true, inventorName: true },
  });
  return buildSyntheticRecords(rows);
}

/** 设计文档命名的读客户端封装（`PatentCacheClient.searchPatentsByAssignee(db, name, opts)`）。 */
export class PatentCacheClient {
  searchPatentsByAssignee(
    db: PatentCacheReadDb,
    companyName: string,
    opts: PatentSearchOptions,
    now: () => number = Date.now,
  ): Promise<PatentRecord[]> {
    return readPatentCache(db, companyName, opts, now);
  }
}

// ── Step 6 攒集队列 enqueue（冷启动预热 + 条件触发刷新）─────────────────────

/** enqueue DB 最小面。 */
export type PatentEnqueueDb = { patentLookupRequest: Pick<PrismaClient['patentLookupRequest'], 'upsert'> };

/**
 * 把一家公司排入专利查询队列（PENDING）——驱动条件触发刷新 + 冷启动预热。幂等（同 (assigneeNorm, country) upsert）：
 * 已排队/已缓存 → 只更新 lastRequestedAt，**不复位 status**（不触发重复扫）。无有效锚/归一名 → no-op（返 enqueued:false）。
 */
export async function enqueuePatentLookup(
  db: PatentEnqueueDb,
  input: { companyName: string; country?: string },
  now: () => number = Date.now,
): Promise<{ enqueued: boolean }> {
  const anchor = assigneeLikeAnchor(input.companyName);
  const assigneeNorm = normForMatch(input.companyName);
  if (!anchor || !assigneeNorm) return { enqueued: false };
  const country = normCountryLoose(input.country);
  const nowDate = new Date(now());
  await db.patentLookupRequest.upsert({
    where: { assigneeNorm_country: { assigneeNorm, country } },
    update: { lastRequestedAt: nowDate },
    create: {
      assigneeNorm,
      country,
      anchor,
      sampleName: input.companyName.trim().slice(0, 200),
      status: 'PENDING',
      firstRequestedAt: nowDate,
      lastRequestedAt: nowDate,
    },
  });
  return { enqueued: true };
}

// ── Step 2c 刷新编排（owner 连接；一次共享大扫落库）────────────────────────

/** 刷新 DB 最小面（owner 连接：平台表写 + source_policy 门读 + data_provider kill-switch 读 + 墓碑禁扫读）。 */
export type PatentRefreshDb = {
  patentLookupRequest: Pick<PrismaClient['patentLookupRequest'], 'findMany' | 'update'>;
  patentInventorCache: Pick<PrismaClient['patentInventorCache'], 'upsert' | 'deleteMany'>;
  patentCacheRefreshAudit: Pick<PrismaClient['patentCacheRefreshAudit'], 'create' | 'update'>;
  sourcePolicy: Pick<PrismaClient['sourcePolicy'], 'findUnique'>;
  /** 🔴 kill-switch（P1-1）：`google_patents` 非 ENABLED → 不扫 BQ、不物化 PII。 */
  dataProvider: Pick<PrismaClient['dataProvider'], 'findUnique'>;
  /** 🔴 Art.17 墓碑（P2-5）：刷新 upsert 前查盲键跳过，防被擦除人 PII 重物化。 */
  patentInventorTombstone: Pick<PrismaClient['patentInventorTombstone'], 'findMany'>;
};

/** BigQuery 刷新扫描面（BigQueryPatentsClient 的子集，便于测试注入）。 */
export interface PatentRefreshScanner {
  searchInventorsForAnchorsWithStats(anchors: string[], opts: PatentSearchOptions): Promise<RefreshScanResult>;
}

export interface PatentRefreshDeps {
  db: PatentRefreshDb;
  bq: PatentRefreshScanner;
  now?: () => number;
  windowYears?: number;
  ttlDays?: number;
  maxAnchors?: number;
  log?: (msg: string) => void;
}

export type PatentRefreshStatus =
  | 'OK'
  | 'SKIPPED_EMPTY'
  | 'SKIPPED_NOSCAN' // 🔴 P2-4：BQ 未扫（无 creds/无 anchor）——队列留 PENDING，不误标 EMPTY
  | 'DENIED' // §8.8 用途门拒
  | 'DISABLED' // 🔴 P1-1：data_provider.google_patents 非 ENABLED（kill-switch）——不物化 PII
  | 'FAILED';

export interface PatentRefreshSummary {
  status: PatentRefreshStatus;
  anchorCount: number;
  rowCount: number;
  bytesScanned: number | null;
  purged: number;
  cached: number;
  empty: number;
  detail?: string;
}

/** 保留期清理（**恒先跑**，即便队列空/§8.8 拒/无 creds）：TTL 到期行 + 出滚动窗行 → GDPR 存储限制 + 护栏④。 */
async function purgeExpiredAndOutOfWindow(db: PatentRefreshDb, nowDate: Date, fromYear: number): Promise<number> {
  const expired = await db.patentInventorCache.deleteMany({ where: { expiresAt: { lte: nowDate } } });
  const outOfWindow = await db.patentInventorCache.deleteMany({ where: { windowToYear: { lt: fromYear } } });
  return expired.count + outOfWindow.count;
}

/**
 * 🔴 P1-1 kill-switch 自守：`data_provider.google_patents` 非 ENABLED（seed=DISABLED，未签 LIA/DPIA）→ 不扫、不物化。
 * 与 §8.8 门**正交**：§8.8 是用途/robots 合规门（source_policy），本门是 provider 运行开关（ENABLED/DISABLED）。
 * 缺行 → fail-closed（视为 DISABLED）。此前刷新只查 §8.8（seed=APPROVED 恒过）→ DISABLED 下仍物化 PII 的漏洞根因。
 */
async function checkProviderEnabledGate(db: PatentRefreshDb): Promise<boolean> {
  const provider = await db.dataProvider.findUnique({ where: { key: PATENT_PROVIDER_KEY }, select: { status: true } });
  return provider?.status === 'ENABLED';
}

/** 🔴 §8.8 用途门自守：未登记 fail-closed / SUSPENDED / allowedPurpose 不含 discovery → 拒扫。 */
async function checkSourcePolicyGate(db: PatentRefreshDb): Promise<{ ok: boolean; reason: string }> {
  const policy = await db.sourcePolicy.findUnique({ where: { domain: PATENT_POLICY_DOMAIN } });
  if (!policy) return { ok: false, reason: `source_policy 未登记（fail-closed）: ${PATENT_POLICY_DOMAIN}` };
  if (policy.reviewStatus === 'SUSPENDED') return { ok: false, reason: `source_policy SUSPENDED: ${PATENT_POLICY_DOMAIN}` };
  const purposes = Array.isArray(policy.allowedPurpose) ? (policy.allowedPurpose as unknown[]) : [];
  if (!purposes.includes('discovery')) {
    return { ok: false, reason: `allowedPurpose 不含 discovery: ${PATENT_POLICY_DOMAIN}` };
  }
  return { ok: true, reason: '' };
}

/**
 * 刷新编排（owner 连接）：保留期清理 → 枚举待刷队列 → 空则 SKIPPED_EMPTY → 🔴§8.8 自守 → **一次扫**（护栏②④⑥ 下推）
 * → 每行 normForMatch + 🔴encryptPii + 盲键 + upsert（确定性密文 → 唯一键幂等）→ 队列置 CACHED/EMPTY + nextRefreshAt → 写 audit。
 * fail-safe：BQ 扫描抛错 → audit FAILED、不穿透。绝不因单轮失败污染已缓存行。
 */
export async function refreshPatentCache(deps: PatentRefreshDeps): Promise<PatentRefreshSummary> {
  const now = deps.now?.() ?? Date.now();
  const nowDate = new Date(now);
  const windowYears = deps.windowYears ?? PATENT_CACHE_WINDOW_YEARS;
  const toYear = nowDate.getUTCFullYear();
  const fromYear = toYear - windowYears;
  const ttlDays = deps.ttlDays ?? ttlDaysFromEnv();
  const expiresAt = new Date(now + ttlDays * DAY_MS);
  const nextRefreshAt = new Date(now + ttlDays * DAY_MS);
  const log = deps.log ?? (() => {});
  const db = deps.db;

  // 1) 保留期清理恒先跑（零 BQ 成本；即便 kill-switch 关，既有行仍按 TTL/窗口清理 = GDPR 存储限制不受影响）。
  const purged = await purgeExpiredAndOutOfWindow(db, nowDate, fromYear);

  // 1b) 🔴 P1-1 kill-switch（保留期清理**之后**、扫 BQ **之前**）：provider DISABLED（未签 LIA/DPIA）→ 绝不扫
  //     BQ / 物化 PII。这是「seed DISABLED = 不物化」不变式的执行点（此前刷新只查 §8.8 seed=APPROVED 恒过而漏）。
  if (!(await checkProviderEnabledGate(db))) {
    await db.patentCacheRefreshAudit.create({
      data: { startedAt: nowDate, finishedAt: new Date(), anchorCount: 0, rowCount: 0, status: 'DISABLED', detail: `data_provider ${PATENT_PROVIDER_KEY} 非 ENABLED（kill-switch）; purged ${purged}` },
    });
    return { status: 'DISABLED', anchorCount: 0, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0 };
  }

  // 2) 待刷队列（PENDING 或 nextRefreshAt 到期）——FIFO。**DB 侧 take 上限**（不把全量积压拉进内存，scale-safe）：
  //    取 maxAnchors×2 缓冲（容同 anchor 多国别行）→ 下面去重到 ≤maxAnchors distinct anchors；未处理行留下轮（FIFO 不饿死）。
  const maxAnchors = deps.maxAnchors ?? MAX_ANCHORS_PER_REFRESH;
  const eligible = await db.patentLookupRequest.findMany({
    where: { OR: [{ status: 'PENDING' }, { nextRefreshAt: { lte: nowDate } }] },
    orderBy: { firstRequestedAt: 'asc' },
    take: maxAnchors * 2,
  });
  if (!eligible.length) {
    await db.patentCacheRefreshAudit.create({
      data: { startedAt: nowDate, finishedAt: new Date(), anchorCount: 0, rowCount: 0, status: 'SKIPPED_EMPTY', detail: `queue empty; purged ${purged}` },
    });
    return { status: 'SKIPPED_EMPTY', anchorCount: 0, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0 };
  }

  // 3) 🔴 §8.8 自守（扫 BQ 前）。
  const gate = await checkSourcePolicyGate(db);
  if (!gate.ok) {
    await db.patentCacheRefreshAudit.create({
      data: { startedAt: nowDate, finishedAt: new Date(), anchorCount: 0, rowCount: 0, status: 'DENIED', detail: gate.reason },
    });
    return { status: 'DENIED', anchorCount: 0, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0, detail: gate.reason };
  }

  // 4) anchor 集（去重 + capped FIFO；超上限记 log、其余留 PENDING 下轮，不饿死）。
  const allAnchors = [...new Set(eligible.map((e) => e.anchor).filter((a): a is string => !!a))];
  const capped = allAnchors.length > maxAnchors;
  const anchors = capped ? allAnchors.slice(0, maxAnchors) : allAnchors;
  if (capped) log(`patent-cache: anchor 集 ${allAnchors.length} 超上限 ${maxAnchors}——本轮取前 ${maxAnchors}（FIFO），其余留 PENDING 下轮`);
  const anchorSet = new Set(anchors);
  const processed = eligible.filter((e) => anchorSet.has(e.anchor)); // 本轮真正覆盖的队列行（capped 外的不动状态）

  // 4b) 🔴 P2-7 preflight（复审加固）：PII 密钥不仅**存在**、还须**形态合法**（trial derive）——畸形 key 时也在扫 BQ 前
  //     拦下（否则扫了才在派生处炸，浪费一次扫描）。派生失败 → FAILED，绝不扫。写阶段 try/catch 仍是后备兜底。
  if (!piiPreflightOk()) {
    await db.patentCacheRefreshAudit.create({
      data: { startedAt: nowDate, finishedAt: new Date(), anchorCount: anchors.length, rowCount: 0, status: 'FAILED', detail: 'PII_ENCRYPTION_KEY 缺失或形态非法——拒绝扫描（无法加密落盘）' },
    });
    return { status: 'FAILED', anchorCount: anchors.length, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0, detail: 'PII_ENCRYPTION_KEY 缺失或形态非法' };
  }

  // 5) audit RUNNING。
  const audit = await db.patentCacheRefreshAudit.create({
    data: { startedAt: nowDate, anchorCount: anchors.length, status: 'RUNNING' },
  });

  // 6) 一次扫（护栏②④⑥ 全下推）——带扫描字节供配额观测。
  let scan: RefreshScanResult;
  try {
    scan = await deps.bq.searchInventorsForAnchorsWithStats(anchors, { fromYear, toYear });
  } catch (err) {
    await db.patentCacheRefreshAudit.update({
      where: { id: audit.id },
      data: { finishedAt: new Date(), status: 'FAILED', detail: String(err).slice(0, 300) },
    });
    return { status: 'FAILED', anchorCount: anchors.length, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0 };
  }

  // 6b) 🔴 P2-4：BQ **未扫**（无 creds/无 anchor，scanned:false）→ 队列留 PENDING（不标 EMPTY），creds 修好下轮即重试
  //     （否则误标 EMPTY + nextRefreshAt=+180d → 缓存冷冻数月）。区分「扫了零命中」(EMPTY) vs「没扫」(留 PENDING)。
  if (scan.scanned === false) {
    await db.patentCacheRefreshAudit.update({
      where: { id: audit.id },
      data: { finishedAt: new Date(), status: 'SKIPPED_NOSCAN', detail: 'BigQuery 未扫（无 creds/无 anchor）——队列留 PENDING' },
    });
    return { status: 'SKIPPED_NOSCAN', anchorCount: anchors.length, rowCount: 0, bytesScanned: null, purged, cached: 0, empty: 0 };
  }

  // 7) 落库前**三重收窄**（数据最小化 + Art.17），把「广谱扫描命中」收敛成「与排队公司对齐的最小 PII 集」：
  //    P1-2 按已排队身份过滤（宽锚 %APPLE% 溜进的无关 assignee 不落）→ P2-5 去被擦除人墓碑（不重物化）→
  //    P2-6 每 (assigneeNorm,country) cap 到 25（对齐 provider 读侧上限，不静态化上千无用发明人 PII）。
  // 🔴 P2-7（复审 HIGH 收口）：整个写阶段（盲键 crypto + 墓碑 findMany + upsert）**全包 try/catch** → 任一步抛错
  //   标 audit FAILED、graceful 返回（不逃逸令 audit 卡 RUNNING + Temporal 重试整活动重扫 BQ 烧配额）。scan 成功后
  //   BQ 配额已花，下游任何 DB/crypto 抖动（含 rolling deploy 墓碑表未及应用）绝不触发白白重扫。
  const resultKeys = new Set<string>();
  let rowCount = 0;
  try {
    // P1-2（复审加固 · 国别作用域）：按已排队 **(assigneeNorm, country)** 身份过滤——同归一名但**国别冲突**的
    //   assignee（queued Acme/de，扫描溜进 Acme/us）不落。国别兼容规则同读侧 countryConflicts（任一未知 → 兼容，欠并）。
    const queuedByNorm = new Map<string, string[]>();
    for (const e of processed) {
      const arr = queuedByNorm.get(e.assigneeNorm);
      if (arr) arr.push(e.country ?? '');
      else queuedByNorm.set(e.assigneeNorm, [e.country ?? '']);
    }
    const scoped = scan.rows
      .map((r) => ({ r, norm: normForMatch(r.assigneeName), country: r.assigneeCountry ?? '' }))
      .filter((e) => {
        if (!e.norm || !e.r.inventorName) return false;
        const qCountries = queuedByNorm.get(e.norm);
        return !!qCountries && qCountries.some((qc) => !countriesConflict(qc, e.country));
      });
    // 盲键只对 scoped 子集算（HMAC 有成本）；供墓碑去重 + upsert 复用。
    const enriched = scoped.map((e) => ({ ...e, nameKey: inventorBlindKey(e.r.inventorName) }));

    // P2-5：按盲键查墓碑，被擦除人绝不重物化（over-suppress 侧：宁跳过也不重建被擦除 PII）。
    const candidateKeys = [...new Set(enriched.map((e) => e.nameKey).filter(Boolean))];
    const tombstoned = candidateKeys.length
      ? new Set(
          (
            await db.patentInventorTombstone.findMany({
              where: { inventorNameKey: { in: candidateKeys } },
              select: { inventorNameKey: true },
            })
          ).map((t) => t.inventorNameKey),
        )
      : new Set<string>();
    const notErased = enriched.filter((e) => !(e.nameKey && tombstoned.has(e.nameKey)));

    // P2-6：确定性排序 → 每 (assigneeNorm,country) cap 到 MAX_INVENTORS_PER_ASSIGNEE（幂等：同批每次落同一 25 位）。
    notErased.sort(
      (a, b) => a.norm.localeCompare(b.norm) || a.country.localeCompare(b.country) || a.r.inventorName.localeCompare(b.r.inventorName),
    );
    const perGroup = new Map<string, number>();
    const toUpsert: typeof notErased = [];
    for (const e of notErased) {
      const gk = `${e.norm}\u0000${e.country}`;
      const n = perGroup.get(gk) ?? 0;
      if (n >= MAX_INVENTORS_PER_ASSIGNEE) continue;
      perGroup.set(gk, n + 1);
      toUpsert.push(e);
    }

    // upsert（🔴encryptPii + 盲键）+ 记录每组保留密文集（供 over-cap/陈旧行清除）。
    const keptByGroup = new Map<string, { norm: string; country: string; enc: string[] }>();
    for (const e of toUpsert) {
      const encInventor = encryptPii(e.r.inventorName); // 🔴 确定性加密落盘
      await db.patentInventorCache.upsert({
        where: { assigneeNorm_assigneeCountry_inventorName: { assigneeNorm: e.norm, assigneeCountry: e.country, inventorName: encInventor } },
        update: { assigneeNameRaw: e.r.assigneeName, inventorNameKey: e.nameKey, windowFromYear: fromYear, windowToYear: toYear, license: GOOGLE_PATENTS_LICENSE, refreshedAt: nowDate, expiresAt },
        create: { assigneeNameRaw: e.r.assigneeName, assigneeNorm: e.norm, assigneeCountry: e.country, inventorName: encInventor, inventorNameKey: e.nameKey, windowFromYear: fromYear, windowToYear: toYear, license: GOOGLE_PATENTS_LICENSE, refreshedAt: nowDate, expiresAt },
      });
      rowCount += 1;
      const gk = `${e.norm}\u0000${e.country}`;
      resultKeys.add(gk);
      const g = keptByGroup.get(gk);
      if (g) g.enc.push(encInventor);
      else keptByGroup.set(gk, { norm: e.norm, country: e.country, enc: [encInventor] });
    }

    // P2-6（复审加固 · over-cap 清除）：把每个**本轮真刷新的组**收敛到当前 capped 集（删不在 kept 集里的旧行）——
    //   此前 cap 只挡新写，>25 的旧行/漂移的 cap 成员会驻留到 TTL 仍被 readPatentCache 读到，令上限不真正约束存量 PII。
    //   now = 刷新即「用当前 capped 集替换该组缓存」，确定性密文令其幂等（同 scan 二次刷新删 0）。
    for (const g of keptByGroup.values()) {
      await db.patentInventorCache.deleteMany({
        where: { assigneeNorm: g.norm, assigneeCountry: g.country, inventorName: { notIn: g.enc } },
      });
    }
  } catch (err) {
    await db.patentCacheRefreshAudit.update({
      where: { id: audit.id },
      data: { finishedAt: new Date(), rowCount, status: 'FAILED', detail: `persist failed: ${String(err).slice(0, 260)}` },
    });
    return { status: 'FAILED', anchorCount: anchors.length, rowCount, bytesScanned: scan.bytesScanned, purged, cached: 0, empty: 0 };
  }

  // 8) 队列状态机：本轮覆盖行 → CACHED（有结果）/ EMPTY，nextRefreshAt=now+ttl（TTL 到期可再刷）。
  let cached = 0;
  let empty = 0;
  for (const e of processed) {
    const hasResult = resultKeys.has(`${e.assigneeNorm}\u0000${e.country ?? ''}`);
    await db.patentLookupRequest.update({
      where: { id: e.id },
      data: { status: hasResult ? 'CACHED' : 'EMPTY', refreshedAt: nowDate, nextRefreshAt },
    });
    if (hasResult) cached += 1;
    else empty += 1;
  }

  // 9) audit OK（记 bytesScanned 供配额告警）。
  await db.patentCacheRefreshAudit.update({
    where: { id: audit.id },
    data: {
      finishedAt: new Date(),
      rowCount,
      bytesScanned: scan.bytesScanned != null ? BigInt(Math.round(scan.bytesScanned)) : null,
      status: 'OK',
      detail: `${capped ? `capped ${anchors.length}/${allAnchors.length}; ` : ''}purged ${purged}; cached ${cached}; empty ${empty}`,
    },
  });

  return { status: 'OK', anchorCount: anchors.length, rowCount, bytesScanned: scan.bytesScanned, purged, cached, empty };
}
