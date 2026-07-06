import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';

export type TaxonomyKind = 'industry' | 'country' | 'product';

export interface CanonicalNode {
  kind: string;
  scheme: string;
  code: string;
  labelEn: string;
  labels: Record<string, string> | null;
  wikidataQid: string | null;
  osmTags: { k: string; v?: string }[] | null;
}

const norm = (s: string): string => s.normalize('NFC').toLowerCase().trim();

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
    };
  }

  /** 冷路径：让 LLM 在标准码表内选一个 code（enum 约束），校验后沉淀。 */
  private async llmResolve(kind: TaxonomyKind, term: string, workspaceId?: string): Promise<CanonicalNode | null> {
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
        { workspaceId: workspaceId ?? 'taxonomy' },
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
}
