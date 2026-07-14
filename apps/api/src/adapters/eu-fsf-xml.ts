import { XMLParser } from 'fast-xml-parser';
import type { ParsedSanctionsAlias, ParsedSanctionsEntity, ParsedSanctionsList } from './ofac-xml';

/**
 * EU FSF（Financial Sanctions Files，DG FISMA）合并制裁名单 XML 解析器。
 * 结构据 2026-07-14 一手拉取（固定公开 token）：`<export generationDate><sanctionEntity logicalId>`；
 * 数据在**属性**里：`<subjectType code="enterprise|person">`、`<nameAlias wholeName strong="true|false">`、
 * `<regulation programme publicationDate>`、`<address country>`。
 *
 * 🔴 Phase 1 仅公司/实体：**只保留 `subjectType code="enterprise"`，drop `person`**——person PII 不物化。
 * 每 sanctionEntity 多 nameAlias：首个 wholeName=primaryName，其余=别名（strong=true→strong，else weak）。
 * fail-safe：畸形/空 → 空 entities，绝不抛。
 */

export const EU_FSF_LICENSE = 'CC-BY-4.0'; // EU Commission reuse（Decision 2011/833/EU）——实现期核实
export const EU_FSF_ATTRIBUTION = 'Source: European Union, Financial Sanctions Files (FSF), DG FISMA';

type XmlNode = Record<string, unknown>;

const ARRAY_TAGS = new Set(['sanctionEntity', 'nameAlias', 'regulation', 'address']);
const parser = new XMLParser({
  ignoreAttributes: false, // EU 数据在属性
  attributeNamePrefix: '@_',
  isArray: (name) => ARRAY_TAGS.has(name),
  parseTagValue: false,
  parseAttributeValue: false,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const v = (node as XmlNode)[`@_${name}`];
  return typeof v === 'string' ? v.trim() || null : typeof v === 'number' ? String(v) : null;
}

export function parseEuFsf(xml: string): ParsedSanctionsList {
  const empty: ParsedSanctionsList = { publishDate: null, recordCount: null, entities: [] };
  if (!xml || !xml.trim()) return empty;

  let doc: { export?: XmlNode };
  try {
    doc = parser.parse(xml) as { export?: XmlNode };
  } catch {
    return empty;
  }
  const exp = doc.export ?? {};
  const gen = attr(exp, 'generationDate'); // "2026-06-05T15:51:25.849+02:00"
  const publishDate = gen && /^\d{4}-\d{2}-\d{2}/.test(gen) ? gen.slice(0, 10) : null;

  const entities: ParsedSanctionsEntity[] = [];
  for (const ent of asArray<XmlNode>(exp.sanctionEntity as XmlNode | XmlNode[])) {
    if (attr(ent.subjectType, 'code') !== 'enterprise') continue; // 🔴 仅实体，person 剔除
    const externalId = attr(ent, 'logicalId') ?? attr(ent, 'euReferenceNumber');
    if (!externalId) continue;

    const names = asArray<XmlNode>(ent.nameAlias as XmlNode | XmlNode[])
      .map((na) => ({ name: attr(na, 'wholeName'), strong: attr(na, 'strong') === 'true' }))
      .filter((n): n is { name: string; strong: boolean } => !!n.name);
    if (!names.length) continue;

    const primaryName = names[0].name;
    const aliases: ParsedSanctionsAlias[] = names.slice(1).map((n) => ({ name: n.name, quality: n.strong ? 'strong' : 'weak' }));

    const programs = [
      ...new Set(
        asArray<XmlNode>(ent.regulation as XmlNode | XmlNode[])
          .map((r) => attr(r, 'programme'))
          .filter((p): p is string => !!p),
      ),
    ];

    const firstAddr = asArray<XmlNode>(ent.address as XmlNode | XmlNode[])[0];
    const country = firstAddr ? attr(firstAddr, 'countryDescription') ?? attr(firstAddr, 'country') : null;

    entities.push({ externalId, primaryName, country, programs, aliases });
  }
  return { publishDate, recordCount: entities.length, entities };
}
