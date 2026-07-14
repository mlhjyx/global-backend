import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';

export type TaxonomyKind = 'industry' | 'country' | 'product';

/** 官方码制对照（§8.2 暴露给 resolveIcpToCpv 等冷路径；schemaless JSON，键按 kind 选用）。 */
export interface TaxonomyCrosswalks {
  cpv?: string[]; // ISIC→CPV 锚（8 位码或 division/class 前缀）
  alpha3?: string[]; // country→ISO-3（TED buyer-country 格式，如 ['DEU']）
  fdaPanels?: string[]; // ISIC→FDA 医疗专科 panel 2 字母码锚（如 ['RA'] 放射）——product code 无前缀层级，靠显式 panel 父维
  fdaProductCodes?: string[]; // 直接锚定的 FDA 3 字母 product code（窄行业可跳过 panel）
  numeric?: string[];
  nace?: string[];
  naics?: string[];
  gb4754?: string[];
}

export interface CanonicalNode {
  kind: string;
  scheme: string;
  code: string;
  labelEn: string;
  labels: Record<string, string> | null;
  wikidataQid: string | null;
  osmTags: { k: string; v?: string }[] | null;
  crosswalks: TaxonomyCrosswalks | null;
}

const norm = (s: string): string => s.normalize('NFC').toLowerCase().trim();

/**
 * CPV 层级前缀：去尾零占位符（'42120000'→'4212'）。CPV 全为 8 位、子码自第一个非零位起分叉，
 * 故对全码做 startsWith 只命中锚自身；取有效前缀才能覆盖子树（42122000/42122130/42123000…）。
 */
export const cpvSubtreePrefix = (code: string): string => code.replace(/0+$/, '') || code;

/**
 * 词表归一（混合，docs/backend/vocab-taxonomy.md）：
 * 1) 确定性：normKey → TermAlias 命中 → CanonicalTaxonomy 节点（零成本零延迟）。
 * 2) 冷路径 LLM：未命中 → taxonomy.normalize（enum 约束 code 值域，杜绝幻觉）→
 *    校验 code 存在 → 写回 TermAlias(source='llm') 沉淀 → 下次确定性。
 * LLM 只在冷路径（ICP 设计 / query-plan 生成）每词一次，不碰发现热路径。
 *
 * canonical_taxonomy / term_alias 是无 RLS 平台表（app_user 只读）→ 直接用 prisma 读。
 */
@Injectable()
export class TaxonomyResolver {
  private readonly logger = new Logger('TaxonomyResolver');

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ModelGateway,
  ) {}

  /** 归一单个词到规范节点；无法归一返回 null。allowLlm=false 则只走确定性。 */
  async resolve(kind: TaxonomyKind, term: string, opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode | null> {
    const t = norm(term);
    if (!t) return null;

    const alias = await this.prisma.termAlias.findUnique({ where: { kind_term: { kind, term: t } } });
    if (alias) return this.node(kind, alias.code);

    if (opts?.allowLlm === false) return null;
    return this.llmResolve(kind, term, opts?.workspaceId);
  }

  /** 批量归一（去重）。 */
  async resolveMany(kind: TaxonomyKind, terms: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode[]> {
    const seen = new Map<string, CanonicalNode>();
    for (const term of terms) {
      const n = await this.resolve(kind, term, opts);
      if (n && !seen.has(n.code)) seen.set(n.code, n);
    }
    return [...seen.values()];
  }

  private async node(kind: string, code: string): Promise<CanonicalNode | null> {
    const row = await this.prisma.canonicalTaxonomy.findUnique({ where: { kind_code: { kind, code } } });
    if (!row) return null;
    return {
      kind: row.kind,
      scheme: row.scheme,
      code: row.code,
      labelEn: row.labelEn,
      labels: (row.labels as Record<string, string>) ?? null,
      wikidataQid: row.wikidataQid,
      osmTags: (row.osmTags as { k: string; v?: string }[]) ?? null,
      crosswalks: (row.crosswalks as TaxonomyCrosswalks) ?? null, // §8.2：列已 fetch，此前仅在映射处丢弃
    };
  }

  /** 冷路径：让 LLM 在标准码表内选一个 code（enum 约束），校验后沉淀。 */
  private async llmResolve(kind: TaxonomyKind, term: string, workspaceId?: string): Promise<CanonicalNode | null> {
    // 收口②：无真实租户上下文不走 LLM 冷路径——伪 workspace（曾用 'taxonomy'）会令
    // ai_trace/usage_ledger 的 @db.Uuid 列写入静默失败，记账全盲。确定性路径不受影响。
    if (!workspaceId) return null;
    const contract = getTask('taxonomy.normalize');
    if (!contract) return null;
    // 候选码表（该 kind 全部节点，作为 enum 约束）
    const nodes = await this.prisma.canonicalTaxonomy.findMany({ where: { kind }, select: { code: true, labelEn: true, labels: true } });
    if (!nodes.length) return null;
    const catalog = nodes.map((n) => ({ code: n.code, en: n.labelEn, zh: (n.labels as Record<string, string>)?.zh }));

    const schema = {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: ['string', 'null'], enum: [...nodes.map((n) => n.code), null], description: '归一到的标准码；无法归一则 null' },
      },
    };
    try {
      const result = await this.gateway.generateStructured<{ code: string | null }>(
        {
          task: contract.id,
          system: contract.description,
          model: contract.model,
          schema,
          prompt: `把词「${term}」归一到下面 ${kind} 标准码表中最匹配的一个 code（只能选表中已有的 code，选不到就返回 null）：\n${JSON.stringify(catalog).slice(0, 6000)}`,
        },
        { workspaceId },
      );
      const code = result.data?.code;
      if (!code) return null;
      const node = await this.node(kind, code); // 校验 code 真实存在
      if (!node) return null;
      // 沉淀：下次该词确定性命中
      await this.prisma.termAlias
        .upsert({ where: { kind_term: { kind, term: norm(term) } }, update: { code, source: 'llm' }, create: { kind, term: norm(term), code, source: 'llm' } })
        .catch((e) => this.logger.warn(`alias sediment failed: ${String(e).slice(0, 120)}`));
      return node;
    } catch (e) {
      this.logger.warn(`llm normalize failed for "${term}": ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * §2.3/§8.2 冷路径：把产品自由词精修到 crosswalk 子树内的某个 CPV 码。
   * **枚举永远限于子树前缀命中的 CPV 码**（≤ 数百），绝不走 llmResolve 的整表 slice(0,6000) 截断陷阱。
   * 先查 TermAlias 缓存；miss + allowLlm 才请求 LLM（enum 约束 code 值域），命中后校验存在 + 沉淀别名。
   */
  async resolveCpvForProduct(
    product: string,
    subtreePrefixes: string[],
    opts?: { workspaceId?: string; allowLlm?: boolean },
  ): Promise<string | null> {
    const term = norm(product);
    if (!term || !subtreePrefixes.length) return null;
    const prefixes = subtreePrefixes.map(cpvSubtreePrefix);

    const alias = await this.prisma.termAlias.findUnique({ where: { kind_term: { kind: 'cpv', term } } });
    // 缓存命中须落在**当前子树**内：别名按 (kind,term) 全局缓存、不按子树，跨 ICP 不同行业子树同产品词不可串用。
    if (alias && prefixes.some((p) => alias.code.startsWith(p))) return alias.code;
    if (opts?.allowLlm === false) return null;
    // 收口②：无真实租户上下文不走 LLM（伪 workspace 会令 ai_trace 记账静默失败）
    if (!opts?.workspaceId) return null;

    // 有界枚举：仅子树前缀命中的 CPV 码（绝不整表；这是与 llmResolve 整表 slice 的关键区别）
    const rows = await this.prisma.canonicalTaxonomy.findMany({
      where: { kind: 'cpv', OR: prefixes.map((p) => ({ code: { startsWith: p } })) },
      select: { code: true, labelEn: true, labels: true },
      take: 500,
    });
    if (!rows.length) return null;

    const contract = getTask('taxonomy.normalize');
    if (!contract) return null;
    const catalog = rows.map((n) => ({ code: n.code, en: n.labelEn, zh: (n.labels as Record<string, string>)?.zh }));
    const schema = {
      type: 'object',
      required: ['code'],
      properties: {
        code: {
          type: ['string', 'null'],
          enum: [...rows.map((n) => n.code), null],
          description: '子树内最匹配的 CPV 码；无则 null',
        },
      },
    };
    try {
      const result = await this.gateway.generateStructured<{ code: string | null }>(
        {
          task: contract.id,
          system: contract.description,
          model: contract.model,
          schema,
          prompt: `把产品「${product}」精修到下面 CPV 子码表中最匹配的一个 code（只能选表中已有 code，选不到返回 null）：\n${JSON.stringify(catalog).slice(0, 6000)}`,
        },
        { workspaceId: opts.workspaceId },
      );
      const code = result.data?.code;
      if (!code) return null;
      const node = await this.node('cpv', code); // 校验 code 真实存在
      if (!node) return null;
      await this.prisma.termAlias
        .upsert({
          where: { kind_term: { kind: 'cpv', term } },
          update: { code, source: 'llm' },
          create: { kind: 'cpv', term, code, source: 'llm' },
        })
        .catch((e) => this.logger.warn(`cpv alias sediment failed: ${String(e).slice(0, 120)}`));
      return code;
    } catch (e) {
      this.logger.warn(`cpv refine failed for "${product}": ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * §2.3（SAM.gov）冷路径：把产品自由词精修到 crosswalk 子树内的某个 NAICS 码。
   * NAICS 是**数字前缀层级**（2→6 位，无 CPV 尾零占位）→ 子树前缀 = 锚码本身（startsWith）。
   * 枚举永远限于子树前缀命中的 NAICS 码（≤ 数百），绝不整表。先查缓存；miss + allowLlm 才请求 LLM（enum 约束）。
   */
  async resolveNaicsForProduct(
    product: string,
    subtreePrefixes: string[],
    opts?: { workspaceId?: string; allowLlm?: boolean },
  ): Promise<string | null> {
    const term = norm(product);
    if (!term || !subtreePrefixes.length) return null;
    const prefixes = subtreePrefixes.map((p) => p.trim()).filter(Boolean);
    if (!prefixes.length) return null;

    const alias = await this.prisma.termAlias.findUnique({ where: { kind_term: { kind: 'naics', term } } });
    // 缓存命中须落在**当前子树**内（别名按 (kind,term) 全局缓存、不按子树，跨 ICP 不同行业子树同产品词不可串用）。
    if (alias && prefixes.some((p) => alias.code.startsWith(p))) return alias.code;
    if (opts?.allowLlm === false) return null;
    // 收口②：无真实租户上下文不走 LLM（伪 workspace 会令 ai_trace 记账静默失败）
    if (!opts?.workspaceId) return null;

    const rows = await this.prisma.canonicalTaxonomy.findMany({
      where: { kind: 'naics', OR: prefixes.map((p) => ({ code: { startsWith: p } })) },
      select: { code: true, labelEn: true, labels: true },
      take: 500,
    });
    if (!rows.length) return null;

    const contract = getTask('taxonomy.normalize');
    if (!contract) return null;
    const catalog = rows.map((n) => ({ code: n.code, en: n.labelEn, zh: (n.labels as Record<string, string>)?.zh }));
    const schema = {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: ['string', 'null'], enum: [...rows.map((n) => n.code), null], description: '子树内最匹配的 NAICS 码；无则 null' },
      },
    };
    try {
      const result = await this.gateway.generateStructured<{ code: string | null }>(
        {
          task: contract.id,
          system: contract.description,
          model: contract.model,
          schema,
          prompt: `把产品「${product}」精修到下面 NAICS 子码表中最匹配的一个 code（只能选表中已有 code，选不到返回 null）：\n${JSON.stringify(catalog).slice(0, 6000)}`,
        },
        { workspaceId: opts.workspaceId },
      );
      const code = result.data?.code;
      if (!code) return null;
      const node = await this.node('naics', code); // 校验 code 真实存在
      if (!node) return null;
      await this.prisma.termAlias
        .upsert({ where: { kind_term: { kind: 'naics', term } }, update: { code, source: 'llm' }, create: { kind: 'naics', term, code, source: 'llm' } })
        .catch((e) => this.logger.warn(`naics alias sediment failed: ${String(e).slice(0, 120)}`));
      return code;
    } catch (e) {
      this.logger.warn(`naics refine failed for "${product}": ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /**
   * §2.3（openFDA）冷路径：把产品自由词精修到 **panel 子树内**的某个 FDA product code。
   * FDA product code 是**不透明 3 字母、无前缀层级**（与 CPV 数字前缀嵌套不同）→ 枚举靠 `parentCode ∈ panelCodes`
   * 显式父维圈定（≤ 单 panel 数百），**绝不 `resolve('fda_product_code', term)` 打全 ~6000 表**（llmResolve 整表 slice 截断陷阱）。
   */
  async resolveFdaProductCode(
    product: string,
    panelCodes: string[],
    opts?: { workspaceId?: string; allowLlm?: boolean },
  ): Promise<string | null> {
    const term = norm(product);
    if (!term || !panelCodes.length) return null;

    const alias = await this.prisma.termAlias.findUnique({ where: { kind_term: { kind: 'fda_product_code', term } } });
    // 缓存命中须落在**当前 panel 子树**内（别名全局缓存、不按 panel，跨 ICP 不同专科同产品词不可串用）。
    if (alias) {
      const leaf = await this.prisma.canonicalTaxonomy.findUnique({
        where: { kind_code: { kind: 'fda_product_code', code: alias.code } },
        select: { parentCode: true },
      });
      if (leaf?.parentCode && panelCodes.includes(leaf.parentCode)) return alias.code;
    }
    if (opts?.allowLlm === false) return null;
    // 收口②：无真实租户上下文不走 LLM（伪 workspace 会令 ai_trace 记账静默失败）
    if (!opts?.workspaceId) return null;

    const rows = await this.prisma.canonicalTaxonomy.findMany({
      where: { kind: 'fda_product_code', parentCode: { in: panelCodes } },
      select: { code: true, labelEn: true, labels: true },
      take: 500,
    });
    if (!rows.length) return null;

    const contract = getTask('taxonomy.normalize');
    if (!contract) return null;
    const catalog = rows.map((n) => ({ code: n.code, en: n.labelEn, zh: (n.labels as Record<string, string>)?.zh }));
    const schema = {
      type: 'object',
      required: ['code'],
      properties: {
        code: { type: ['string', 'null'], enum: [...rows.map((n) => n.code), null], description: 'panel 子树内最匹配的 FDA product code；无则 null' },
      },
    };
    try {
      const result = await this.gateway.generateStructured<{ code: string | null }>(
        {
          task: contract.id,
          system: contract.description,
          model: contract.model,
          schema,
          prompt: `把医疗器械产品「${product}」精修到下面 FDA product code 表中最匹配的一个 code（只能选表中已有 code，选不到返回 null）：\n${JSON.stringify(catalog).slice(0, 6000)}`,
        },
        { workspaceId: opts.workspaceId },
      );
      const code = result.data?.code;
      if (!code) return null;
      const node = await this.node('fda_product_code', code); // 校验 code 真实存在
      if (!node) return null;
      await this.prisma.termAlias
        .upsert({ where: { kind_term: { kind: 'fda_product_code', term } }, update: { code, source: 'llm' }, create: { kind: 'fda_product_code', term, code, source: 'llm' } })
        .catch((e) => this.logger.warn(`fda alias sediment failed: ${String(e).slice(0, 120)}`));
      return code;
    } catch (e) {
      this.logger.warn(`fda refine failed for "${product}": ${String(e).slice(0, 120)}`);
      return null;
    }
  }

  /** panel 子树下全部 FDA product code（宽网：产品词缺失或未精修命中时，按整专科捞）。 */
  async listFdaProductCodes(panelCodes: string[]): Promise<string[]> {
    if (!panelCodes.length) return [];
    const rows = await this.prisma.canonicalTaxonomy.findMany({
      where: { kind: 'fda_product_code', parentCode: { in: panelCodes } },
      select: { code: true },
      take: 500,
    });
    return rows.map((r) => r.code);
  }
}
