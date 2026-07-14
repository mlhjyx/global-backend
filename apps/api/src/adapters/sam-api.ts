import { parse } from 'csv-parse';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

/**
 * SAM.gov Contract Opportunities 公开数据抽取（`datagov` 分区，**keyless** `api_key=null` → 303 预签名 S3）。
 * 归 P4「早数月」联邦意图源。**只取绿字段**（机构/公告事实）——🔴 联系官 PII（PrimaryContact / SecondaryContact 系列）
 * 结构性**不读入**本类型（绿库红线，摄取层 payload 白名单再守一道）。
 * CSV 大（全量活跃机会 ~100MB+）且 Description 列含内嵌换行/引号 → **流式正规解析**（csv-parse），
 * 过滤 Type='Sources Sought' + sinceDays 窗，按发布日降序取 maxRecords（有界样本，绝不 grind 全量）。
 * ⚠️ 待定 delta 小文件（优化）；当前用全量 + 流式过滤控内存。
 */

const SAM_CSV_URL =
  'https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?api_key=null';
const SOURCES_SOUGHT_TYPE = 'Sources Sought';
const DEFAULT_SINCE_DAYS = 120;
const DEFAULT_MAX_RECORDS = 500;
const FETCH_TIMEOUT_MS = 240_000; // 全量 CSV 大（~100MB+），宽超时；超时/网络错误经下方 fail-safe 抛给调用方（不崩进程）
const MAX_MATCHED_SCAN = 20_000; // 内存护栏：匹配行硬顶（远超真实 Sources Sought 量），触顶停扫 + 告警
const DAY_MS = 86_400_000;
const UA = 'Mozilla/5.0 (compatible; GlobalBot/1.0)';

/** SAM 公告绿字段（🔴 无任何具名联系人字段——结构性隔离）。 */
export interface SamSourcesSought {
  noticeId: string; // 幂等锚（externalId）
  title: string;
  department: string; // Department/Ind.Agency
  subTier: string; // Sub-Tier（机构/局级 —— 买方身份主键）
  office: string; // Office
  postedDateIso: string | null; // occurredAt（归一 ISO）
  naicsCode: string; // 分类键
  responseDeadlineIso: string | null;
  popCountry?: string; // 履约地国别
  link?: string;
}

export interface SamSearchParams {
  sinceDays?: number;
  maxRecords?: number;
}

/**
 * SAM 日期 → ISO（§8.6：防 Date.parse NaN 静默 0 分 + **防本地时区错位**）。
 * 🔴 纪律同 tedDateToIso/fdaDateToIso：**绝不**把无时区字面量丢给 `new Date()`、**绝不**用本地分量构造器
 * （`new Date(y,m,d)`）——两者都按运行时时区解释，在正 UTC 偏移环境（如 Asia/Shanghai）会把纯日期整体拨回前一天。
 * 一律**先把时区显式化为 Z（当 UTC）** 再解析。SAM 抽取常见：ISO 带 Z/offset（真实主路）/ 'MM/DD/YYYY[ HH:mm]' /
 * 空格分隔 'YYYY-MM-DD HH:mm:ss'（无时区）。无法可靠归一 → null（调用方按缺时机跳过，绝不落误解析日期）。
 */
export function samDateToIso(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  // MM/DD/YYYY[ HH:mm[:ss]]（tz-less）→ 显式 UTC 构造（Date.UTC，绝不经本地时区）
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (us) {
    const ms = Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), Number(us[4] ?? 0), Number(us[5] ?? 0), Number(us[6] ?? 0));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  // ISO 日期[时间][时区]：T 或**空格**分隔；时区 = Z / ±HH / ±HHMM / ±HH:MM（SAM 真实：PostedDate
  //   '2026-07-13 23:28:13.676-04'（空格+裸 -04）、ResponseDeadLine '…T18:00:00-05:00'）。
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?)?$/);
  if (m) {
    const date = m[1];
    const time = m[2] ?? '00:00:00';
    let tz = m[3];
    // 有显式时区 → 归一到 ±HH:MM（兜 SAM 裸 '-04' / '-0500' → 无歧义、跨引擎一致）；无时区 → 当 UTC（绝不经本地时区）
    if (!tz) tz = 'Z';
    else if (tz !== 'Z') {
      const digits = tz.slice(1).replace(':', '');
      tz = `${tz[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`;
    }
    const t = Date.parse(`${date}T${time}${tz}`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** 单 CSV 行 → SamSourcesSought（**只读绿列**；🔴 Contact 列结构性不触及）。 */
export function mapSamRow(row: Record<string, string>): SamSourcesSought {
  const g = (k: string): string => (row[k] ?? '').trim();
  return {
    noticeId: g('NoticeId'),
    title: g('Title'),
    department: g('Department/Ind.Agency'),
    subTier: g('Sub-Tier'),
    office: g('Office'),
    postedDateIso: samDateToIso(row['PostedDate']),
    naicsCode: g('NaicsCode'),
    responseDeadlineIso: samDateToIso(row['ResponseDeadLine']),
    popCountry: g('PopCountry') || undefined,
    link: g('Link') || undefined,
    // 🔴 PrimaryContact*/SecondaryContact*/Awardee 一律不读入
  };
}

/**
 * 拉取近期 Sources Sought（keyless CSV → 流式过滤）。fail-safe：网络/解析失败抛给调用方（tool→broker）处置。
 */
export async function fetchSourcesSought(params?: SamSearchParams): Promise<SamSourcesSought[]> {
  const sinceDays = params?.sinceDays ?? DEFAULT_SINCE_DAYS;
  const maxRecords = params?.maxRecords ?? DEFAULT_MAX_RECORDS;
  const cutoffMs = Date.now() - sinceDays * DAY_MS;

  const res = await fetch(SAM_CSV_URL, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow', // 303 → 预签名 S3
  });
  if (!res.ok || !res.body) throw new Error(`sam.gov CSV ${res.status}`);

  const parser = parse({
    columns: true, // 首行表头 → 行对象（键名匹配列）
    relax_quotes: true, // 容忍不规范引号（SAM 数据偶有）
    relax_column_count: true, // 容忍列数抖动
    skip_records_with_error: true, // 单坏行跳过不整体崩
    bom: true,
  });
  const nodeStream = Readable.fromWeb(res.body as unknown as NodeWebReadableStream);
  // 🔴 源流错误（fetch abort/超时/网络重置）默认**不经 pipe 转发**到 parser → 会成未捕获 'error' 事件**崩进程**
  // （在 worker 里=整进程挂）。显式转发给 parser，令下面 for-await 抛出 → 由本函数 catch 归一为普通 Error →
  // 调用方（tool→broker→ingest）fail-safe 处置。契约：网络/解析失败**抛给调用方**，绝不崩进程。
  nodeStream.on('error', (e) => parser.destroy(e instanceof Error ? e : new Error(String(e))));
  nodeStream.pipe(parser);

  const matched: SamSourcesSought[] = [];
  let truncated = false;
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      if ((row['Type'] ?? '').trim() !== SOURCES_SOUGHT_TYPE) continue;
      const mapped = mapSamRow(row);
      // 窗口过滤：能解析发布日且在窗外 → 跳（无法解析日期的保留，交下游 mapper 按缺时机处置）
      if (mapped.postedDateIso && new Date(mapped.postedDateIso).getTime() < cutoffMs) continue;
      matched.push(mapped);
      if (matched.length >= MAX_MATCHED_SCAN) {
        truncated = true;
        break;
      }
    }
  } catch (e) {
    throw new Error(`sam.gov CSV 下载/解析失败: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  } finally {
    nodeStream.destroy(); // 早退（触顶 break）/异常都收尾，绝不悬挂源流
  }
  if (truncated) {
    console.warn(`[sam-api] 匹配 Sources Sought 触内存护栏上限(${MAX_MATCHED_SCAN})，停扫——更旧的可能被截断（记档：改走每日 delta）`);
  }
  // 按发布日降序取有界样本（最新优先）。纯字符串比较（ISO 定长补零=字典序即时序），
  // 不用 localeCompare——与 intent-projection mergeIntent 比较器一致性纪律对齐（避免运行时 locale 依赖）。
  matched.sort((a, b) => {
    const x = a.postedDateIso ?? '';
    const y = b.postedDateIso ?? '';
    return x < y ? 1 : x > y ? -1 : 0;
  });
  return matched.slice(0, maxRecords);
}
