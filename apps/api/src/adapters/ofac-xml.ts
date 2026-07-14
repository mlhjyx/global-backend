import { XMLParser } from 'fast-xml-parser';

/**
 * OFAC SDN / Consolidated (Non-SDN) 名单 XML 解析器（美国财政部，公共领域 17 U.S.C. §105）。
 * 结构据 2026-07-14 一手拉取 SDN.XML：`<sdnList><sdnEntry><uid|lastName|sdnType|programList|akaList|addressList>`。
 * SDN 与 Consolidated **同 schema，共用本解析器**。
 *
 * 🔴 Phase 1 仅公司/实体：**结构性剔除 `sdnType ∈ {Individual, Vessel, Aircraft}`**——person PII 绝不
 *    物化成记录（个人隔离红线由构造满足）。别名 `<aka category=strong|weak>`（弱别名标记保留，匹配侧不 originate）。
 * fail-safe：畸形/空输入 → 空 entities，绝不抛（§5）。
 */

export const OFAC_LICENSE = 'Public Domain (U.S. Government Work)';
export const OFAC_ATTRIBUTION = 'Source: OFAC (U.S. Department of the Treasury), public domain';

export interface ParsedSanctionsAlias {
  name: string;
  quality: 'strong' | 'weak';
}

/** 一条被制裁实体（法人，🟢）。**无 person PII**（Individual 已在解析层剔除）。 */
export interface ParsedSanctionsEntity {
  externalId: string; // OFAC uid（源侧稳定 id）
  primaryName: string;
  country: string | null; // 首地址国别（原样；persist 层归一 alpha-2）
  programs: string[]; // 制裁项目/regime
  aliases: ParsedSanctionsAlias[]; // 强/弱别名（quality 保留）
}

export interface ParsedSanctionsList {
  publishDate: string | null; // ISO（源 Publish_Date=MM/DD/YYYY）
  recordCount: number | null;
  entities: ParsedSanctionsEntity[];
}

type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set(['sdnEntry', 'aka', 'program', 'address']);
const parser = new XMLParser({
  ignoreAttributes: true, // xmlns 默认命名空间无前缀，元素名可直接取
  isArray: (name) => ARRAY_TAGS.has(name),
  parseTagValue: false, // 值全当字符串（uid/name 不被数字化）
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function toStr(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  return null;
}

/** OFAC `Publish_Date` "MM/DD/YYYY" → "YYYY-MM-DD"；不可解析 → null。 */
function ofacDateToIso(raw: unknown): string | null {
  const s = toStr(raw);
  const m = s?.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

/** 实体名：优先 lastName；个别实体或含 firstName（少见）→ 拼。 */
function entityName(node: XmlNode): string | null {
  const last = toStr(node.lastName);
  const first = toStr(node.firstName);
  if (last && first) return `${first} ${last}`;
  return last ?? first;
}

export function parseOfacXml(xml: string): ParsedSanctionsList {
  const empty: ParsedSanctionsList = { publishDate: null, recordCount: null, entities: [] };
  if (!xml || !xml.trim()) return empty;

  let doc: { sdnList?: XmlNode };
  try {
    doc = parser.parse(xml) as { sdnList?: XmlNode };
  } catch {
    return empty;
  }
  const list = doc.sdnList ?? {};
  const info = (list.publshInformation as XmlNode) ?? {}; // 源侧拼写确为 "publsh"（据实）
  const publishDate = ofacDateToIso(info.Publish_Date);
  const rc = toStr(info.Record_Count);
  const recordCount = rc && /^\d+$/.test(rc) ? Number(rc) : null;

  const entities: ParsedSanctionsEntity[] = [];
  for (const entry of asArray<XmlNode>(list.sdnEntry as XmlNode | XmlNode[])) {
    if (toStr(entry.sdnType) !== 'Entity') continue; // 🔴 仅实体，Individual/Vessel/Aircraft 剔除
    const externalId = toStr(entry.uid);
    const primaryName = entityName(entry);
    if (!externalId || !primaryName) continue; // 缺稳定 id/名 → 跳过（防脏数据）

    const programs = asArray<unknown>((entry.programList as XmlNode)?.program)
      .map(toStr)
      .filter((p): p is string => !!p);

    const aliases: ParsedSanctionsAlias[] = [];
    for (const aka of asArray<XmlNode>((entry.akaList as XmlNode)?.aka as XmlNode | XmlNode[])) {
      const name = entityName(aka);
      if (!name) continue;
      aliases.push({ name, quality: toStr(aka.category) === 'weak' ? 'weak' : 'strong' });
    }

    const firstAddr = asArray<XmlNode>((entry.addressList as XmlNode)?.address as XmlNode | XmlNode[])[0];
    const country = firstAddr ? toStr(firstAddr.country) : null;

    entities.push({ externalId, primaryName, country, programs, aliases });
  }
  return { publishDate, recordCount, entities };
}
