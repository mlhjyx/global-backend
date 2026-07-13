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
} from './bigquery-patents';
import { normForMatch } from '../discovery/name-match';
import { foldedPersonNameKey, personNameKeyVariants } from '../discovery/person-name';
import { encryptPii, decryptPii, blindContactKey } from '../compliance/pii-crypto';

/** §8.8 治理域（与 googlePatentsSearchTool.compliance.policyDomain 一致）。 */
export const PATENT_POLICY_DOMAIN = 'bigquery.googleapis.com';
/** 刷新滚动窗口（年）——**必须镜像 provider RECENCY_YEARS=5**（缓存路径与直连路径同窗，护栏④）。 */
export const PATENT_CACHE_WINDOW_YEARS = 5;
/** 每轮刷新 anchor 上限（超出记 log 留 PENDING 下轮，FIFO 不饿死；judge 提出的谓词过大缓解）。 */
const MAX_ANCHORS_PER_REFRESH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_DAYS = 180;

/** 缓存行 TTL（天）：env `PATENT_CACHE_TTL_DAYS`（改名/退源行自然清理 + GDPR 存储限制），无效值回退 180。 */
function ttlDaysFromEnv(): number {
  const v = Number(process.env.PATENT_CACHE_TTL_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_TTL_DAYS;
}

/** 国别归一 → alpha-2 小写 或 ''（未知；令唯一键成立、欠并方向）。 */
function normCountryLoose(v?: string): string {
  const s = (v ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : '';
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

/** 刷新 DB 最小面（owner 连接：平台表写 + source_policy 门读）。 */
export type PatentRefreshDb = {
  patentLookupRequest: Pick<PrismaClient['patentLookupRequest'], 'findMany' | 'update'>;
  patentInventorCache: Pick<PrismaClient['patentInventorCache'], 'upsert' | 'deleteMany'>;
  patentCacheRefreshAudit: Pick<PrismaClient['patentCacheRefreshAudit'], 'create' | 'update'>;
  sourcePolicy: Pick<PrismaClient['sourcePolicy'], 'findUnique'>;
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

export type PatentRefreshStatus = 'OK' | 'SKIPPED_EMPTY' | 'DENIED' | 'FAILED';

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

  // 1) 保留期清理恒先跑（零 BQ 成本）。
  const purged = await purgeExpiredAndOutOfWindow(db, nowDate, fromYear);

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

  // 7) upsert 每行（normForMatch + 🔴encryptPii + 盲键）——确定性密文令唯一键幂等。
  const resultKeys = new Set<string>();
  let rowCount = 0;
  for (const r of scan.rows) {
    const assigneeNorm = normForMatch(r.assigneeName);
    const country = r.assigneeCountry ?? '';
    if (!assigneeNorm || !r.inventorName) continue;
    const encInventor = encryptPii(r.inventorName); // 🔴 确定性加密落盘
    const nameKey = inventorBlindKey(r.inventorName); // 🔴 Art.17 擦除盲键
    await db.patentInventorCache.upsert({
      where: { assigneeNorm_assigneeCountry_inventorName: { assigneeNorm, assigneeCountry: country, inventorName: encInventor } },
      update: { assigneeNameRaw: r.assigneeName, inventorNameKey: nameKey, windowFromYear: fromYear, windowToYear: toYear, license: GOOGLE_PATENTS_LICENSE, refreshedAt: nowDate, expiresAt },
      create: { assigneeNameRaw: r.assigneeName, assigneeNorm, assigneeCountry: country, inventorName: encInventor, inventorNameKey: nameKey, windowFromYear: fromYear, windowToYear: toYear, license: GOOGLE_PATENTS_LICENSE, refreshedAt: nowDate, expiresAt },
    });
    rowCount += 1;
    resultKeys.add(`${assigneeNorm}\u0000${country}`);
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
