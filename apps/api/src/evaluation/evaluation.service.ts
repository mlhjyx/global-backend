/**
 * 评估学（获客 vNext W3）：golden set 标注、precision@k 报告、双源覆盖估计。
 *
 * 数据模型：evaluation_set / evaluation_label / coverage_estimate（迁移
 * 20261110060000_acquisition_evaluation，四表均带 workspace RLS）。所有 DB 访问
 * 经 withWorkspace（app_user + RLS），不出现裸 workspace 过滤。
 *
 * 报告口径：
 *   - 候选 = 某次 run（可限定单源）在 discovery_company_materialization_outcome
 *     里产出的去重 canonical 公司；
 *   - 判定分数 = 该 run 每个公司取一条判定记录：有 conformal 分数的优先（排序分
 *     1−conformal_score，即 FIT 票占比，越高越合格），无 conformal 分数时按
 *     verdict 档位 FIT=0.5、其余=0；按分数降序取前 k，precision 计算见 precision.ts；
 *   - 标注匹配优先级：canonical_company_id 精确 > 域名（小写）> 名称+国家。
 *
 * 覆盖估计口径见 chapman.ts 头注释（封闭总体/两源独立/同质可捕获/匹配无误）。
 * n1/n2/重叠来自「本 workspace 内已物化的公司」按 provider_key 归属、按
 * canonical_company.country × industry 限定口径——它估计的是「这两条源在
 * 该地区×品类能发现的公司总数」，不是该地区的工商登记全量。
 */
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { RequestContext } from "../auth/request-context";
import { PrismaService } from "../prisma/prisma.service";
import {
  chapmanEstimate,
  CHAPMAN_ESTIMATOR_VERSION,
  type ChapmanResult,
} from "./chapman";
import { precisionAtK, type EvaluationLabelValue } from "./precision";
import { candidateKey, coverageIdentityKey } from "./keys";

export class EvaluationSetNotFoundError extends Error {}
export class EvaluationSetExistsError extends Error {}

const SOURCE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_LABEL_BATCH = 500;

export interface CreateEvaluationSetInput {
  name: string;
  version?: number;
  icpId?: string | null;
  description?: string | null;
  createdBy?: string | null;
}

export interface EvaluationLabelInput {
  canonicalCompanyId?: string | null;
  domain?: string | null;
  name?: string | null;
  country?: string | null;
  label: EvaluationLabelValue;
  note?: string | null;
  labeledBy?: string | null;
}

export interface EvaluationSetView {
  id: string;
  name: string;
  version: number;
  icpId: string | null;
  description: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface EvaluationReportRow {
  canonicalCompanyId: string;
  name: string;
  domain: string | null;
  country: string | null;
  verdict: string;
  score: number;
  label: EvaluationLabelValue | null;
}

export interface EvaluationReport {
  set: EvaluationSetView;
  runId: string;
  providerKey: string | null;
  k: number;
  candidateCount: number;
  evaluated: number;
  hits: number;
  negatives: number;
  unlabeled: number;
  precisionAtK: number | null;
  precisionAtLabeledK: number | null;
  top: EvaluationReportRow[];
}

export interface CoverageReport {
  region: string;
  category: string;
  sourceA: string;
  sourceB: string;
  countA: number;
  countB: number;
  overlap: number;
  estimator: typeof CHAPMAN_ESTIMATOR_VERSION;
  estimable: boolean;
  reason: "EMPTY_SOURCE" | null;
  observedUnion: number;
  estimate: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  recallEstimate: number | null;
  warning: "ZERO_OVERLAP" | null;
  computedAt: Date;
}

@Injectable()
export class EvaluationService {
  constructor(private readonly prisma: PrismaService) {}

  private toSetView(row: {
    id: string;
    name: string;
    version: number;
    icpId: string | null;
    description: string | null;
    createdBy: string | null;
    createdAt: Date;
  }): EvaluationSetView {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      icpId: row.icpId,
      description: row.description,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  }

  async createSet(
    ctx: RequestContext,
    input: CreateEvaluationSetInput,
  ): Promise<EvaluationSetView> {
    const name = input.name.trim();
    const version = input.version ?? 1;
    try {
      const row = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.evaluationSet.create({
          data: {
            workspaceId: ctx.workspaceId,
            name,
            version,
            icpId: input.icpId ?? null,
            description: input.description ?? null,
            createdBy: input.createdBy ?? ctx.userId,
          },
        }),
      );
      return this.toSetView(row);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new EvaluationSetExistsError(
          `evaluation set ${name}#${version} already exists`,
        );
      }
      throw error;
    }
  }

  /** 批量 upsert 标注；同一集内同候选键覆盖（label/note/labeled_by/labeled_at）。 */
  async addLabels(
    ctx: RequestContext,
    setId: string,
    labels: EvaluationLabelInput[],
  ): Promise<{ setId: string; upserted: number }> {
    if (labels.length === 0 || labels.length > MAX_LABEL_BATCH) {
      throw new Error(`EVALUATION_LABEL_BATCH_INVALID: 1..${MAX_LABEL_BATCH}`);
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const set = await tx.evaluationSet.findUnique({ where: { id: setId } });
      if (!set) throw new EvaluationSetNotFoundError(`evaluation set ${setId} not found`);
      const now = new Date();
      for (const entry of labels) {
        const key = candidateKey(entry);
        const labeledBy = (entry.labeledBy ?? ctx.userId).trim();
        const data = {
          canonicalCompanyId: entry.canonicalCompanyId ?? null,
          domain: entry.domain?.trim().toLowerCase() ?? null,
          name: entry.name?.trim() ?? null,
          country: entry.country?.trim().toUpperCase() ?? null,
          label: entry.label,
          labeledBy,
          labeledAt: now,
          note: entry.note ?? null,
        };
        await tx.evaluationLabel.upsert({
          where: { setId_candidateKey: { setId, candidateKey: key } },
          create: {
            workspaceId: ctx.workspaceId,
            setId,
            candidateKey: key,
            ...data,
          },
          update: data,
        });
      }
      return { setId, upserted: labels.length };
    }, { timeout: 60_000 });
  }

  async report(
    ctx: RequestContext,
    setId: string,
    input: { runId: string; providerKey?: string | null; k?: number },
  ): Promise<EvaluationReport> {
    const k = input.k ?? 10;
    if (!Number.isInteger(k) || k < 1 || k > 50) {
      throw new Error("EVALUATION_REPORT_K_INVALID: k must be 1..50");
    }
    const providerKey = input.providerKey ?? null;
    if (providerKey !== null && !SOURCE_KEY.test(providerKey)) {
      throw new Error("EVALUATION_REPORT_PROVIDER_INVALID");
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const set = await tx.evaluationSet.findUnique({ where: { id: setId } });
      if (!set) throw new EvaluationSetNotFoundError(`evaluation set ${setId} not found`);

      // 候选数（与 top 列表同一过滤口径）。
      const [countRow] = await tx.$queryRaw<Array<{ candidate_count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT mo.canonical_company_id)::int AS candidate_count
        FROM discovery_company_materialization_outcome mo
        WHERE mo.workspace_id = ${ctx.workspaceId}::uuid
          AND mo.run_id = ${input.runId}::uuid
          AND mo.canonical_company_id IS NOT NULL
          AND (${providerKey}::text IS NULL OR mo.provider_key = ${providerKey}::text)
      `);

      const rows = await tx.$queryRaw<
        Array<{
          company_id: string;
          name: string;
          domain: string | null;
          country: string | null;
          verdict: string;
          score: number;
          label: string | null;
        }>
      >(Prisma.sql`
        WITH cand AS (
          SELECT DISTINCT mo.canonical_company_id AS company_id
          FROM discovery_company_materialization_outcome mo
          WHERE mo.workspace_id = ${ctx.workspaceId}::uuid
            AND mo.run_id = ${input.runId}::uuid
            AND mo.canonical_company_id IS NOT NULL
            AND (${providerKey}::text IS NULL OR mo.provider_key = ${providerKey}::text)
        ),
        j AS (
          SELECT DISTINCT ON (jr.canonical_company_id)
            jr.canonical_company_id,
            jr.verdict,
            jr.conformal_score
          FROM judgment_record jr
          WHERE jr.workspace_id = ${ctx.workspaceId}::uuid
            AND jr.run_id = ${input.runId}::uuid
          ORDER BY
            jr.canonical_company_id,
            -- 有 conformal 分数的判定优先（排序分档的依据），同级再取更权威的 judge_level
            (jr.conformal_score IS NOT NULL) DESC,
            jr.judge_level DESC,
            jr.created_at DESC
        ),
        ranked AS (
          SELECT
            c.company_id,
            cc.name,
            cc.domain,
            cc.country,
            COALESCE(j.verdict, 'UNJUDGED') AS verdict,
            COALESCE(
              1 - j.conformal_score,
              CASE WHEN j.verdict = 'FIT' THEN 0.5 ELSE 0 END
            )::float8 AS score
          FROM cand c
          JOIN canonical_company cc
            ON cc.workspace_id = ${ctx.workspaceId}::uuid AND cc.id = c.company_id
          LEFT JOIN j ON j.canonical_company_id = c.company_id
        )
        SELECT
          r.company_id,
          r.name,
          r.domain,
          r.country,
          r.verdict,
          r.score,
          l.label
        FROM ranked r
        LEFT JOIN LATERAL (
          SELECT el.label
          FROM evaluation_label el
          WHERE el.workspace_id = ${ctx.workspaceId}::uuid
            AND el.set_id = ${setId}::uuid
            AND (
              el.canonical_company_id = r.company_id
              OR (
                el.domain IS NOT NULL AND r.domain IS NOT NULL
                AND lower(el.domain) = lower(r.domain)
              )
              OR (
                el.name IS NOT NULL AND r.name IS NOT NULL
                AND lower(btrim(el.name)) = lower(btrim(r.name))
                AND (el.country IS NULL OR r.country IS NULL
                     OR lower(el.country) = lower(r.country))
              )
            )
          ORDER BY
            (el.canonical_company_id = r.company_id) DESC,
            (el.domain IS NOT NULL) DESC
          LIMIT 1
        ) l ON true
        ORDER BY r.score DESC, r.name ASC
        LIMIT ${k}
      `);

      const rowsView: EvaluationReportRow[] = rows.map((row) => ({
        canonicalCompanyId: row.company_id,
        name: row.name,
        domain: row.domain,
        country: row.country,
        verdict: row.verdict,
        score: row.score,
        label: (row.label as EvaluationLabelValue | null) ?? null,
      }));
      const precision = precisionAtK(
        rowsView.map((row) => row.label),
        k,
      );
      return {
        set: this.toSetView(set),
        runId: input.runId,
        providerKey,
        k,
        candidateCount: countRow?.candidate_count ?? 0,
        evaluated: precision.evaluated,
        hits: precision.hits,
        negatives: precision.negatives,
        unlabeled: precision.unlabeled,
        precisionAtK: precision.precisionAtK,
        precisionAtLabeledK: precision.precisionAtLabeledK,
        top: rowsView,
      };
    });
  }

  async coverage(
    ctx: RequestContext,
    input: { sourceA: string; sourceB: string; region: string; category: string },
  ): Promise<CoverageReport> {
    const { sourceA, sourceB } = input;
    const region = input.region.trim();
    const category = input.category.trim();
    if (!SOURCE_KEY.test(sourceA)) throw new Error("EVALUATION_COVERAGE_SOURCE_INVALID");
    if (!SOURCE_KEY.test(sourceB)) throw new Error("EVALUATION_COVERAGE_SOURCE_INVALID");
    if (sourceA === sourceB) {
      throw new Error("EVALUATION_COVERAGE_SOURCES_NOT_INDEPENDENT");
    }
    if (region.length === 0 || region.length > 80) {
      throw new Error("EVALUATION_COVERAGE_REGION_INVALID");
    }
    if (category.length === 0 || category.length > 200) {
      throw new Error("EVALUATION_COVERAGE_CATEGORY_INVALID");
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const [counts] = await tx.$queryRaw<
        Array<{ count_a: number; count_b: number; overlap: number }>
      >(Prisma.sql`
        WITH scoped AS (
          SELECT c.id
          FROM canonical_company c
          WHERE c.workspace_id = ${ctx.workspaceId}::uuid
            AND c.status <> 'SUPPRESSED'
            AND c.country IS NOT NULL
            AND lower(c.country) = lower(${region}::text)
            AND c.industry IS NOT NULL
            AND lower(c.industry) = lower(${category}::text)
        ),
        a AS (
          SELECT DISTINCT mo.canonical_company_id AS id
          FROM discovery_company_materialization_outcome mo
          JOIN scoped s ON s.id = mo.canonical_company_id
          WHERE mo.workspace_id = ${ctx.workspaceId}::uuid
            AND mo.provider_key = ${sourceA}::text
        ),
        b AS (
          SELECT DISTINCT mo.canonical_company_id AS id
          FROM discovery_company_materialization_outcome mo
          JOIN scoped s ON s.id = mo.canonical_company_id
          WHERE mo.workspace_id = ${ctx.workspaceId}::uuid
            AND mo.provider_key = ${sourceB}::text
        )
        SELECT
          (SELECT count(*) FROM a)::int AS count_a,
          (SELECT count(*) FROM b)::int AS count_b,
          (SELECT count(*) FROM a JOIN b USING (id))::int AS overlap
      `);
      const countA = counts?.count_a ?? 0;
      const countB = counts?.count_b ?? 0;
      const overlap = counts?.overlap ?? 0;
      const result: ChapmanResult = chapmanEstimate({
        n1: countA,
        n2: countB,
        overlap,
      });
      const identityKey = coverageIdentityKey({
        region,
        category,
        sourceA,
        sourceB,
        countA,
        countB,
        overlap,
      });
      const round6 = (value: number | null): number | null =>
        value === null ? null : Math.round(value * 1e6) / 1e6;
      await tx.coverageEstimate.createMany({
        data: [
          {
            workspaceId: ctx.workspaceId,
            region,
            category,
            sourceA,
            sourceB,
            countA,
            countB,
            overlapCount: overlap,
            estimate: round6(result.estimate),
            ciLow: round6(result.ciLow),
            ciHigh: round6(result.ciHigh),
            estimator: CHAPMAN_ESTIMATOR_VERSION,
            identityKey,
          },
        ],
        skipDuplicates: true,
      });
      const stored = await tx.coverageEstimate.findUnique({
        where: { workspaceId_identityKey: { workspaceId: ctx.workspaceId, identityKey } },
      });
      return {
        region,
        category,
        sourceA,
        sourceB,
        countA,
        countB,
        overlap,
        estimator: CHAPMAN_ESTIMATOR_VERSION,
        estimable: result.estimable,
        reason: result.estimable ? null : result.reason,
        observedUnion: result.observedUnion,
        estimate: result.estimate,
        ciLow: result.ciLow,
        ciHigh: result.ciHigh,
        recallEstimate: result.estimable ? result.recallEstimate : null,
        warning: result.warning,
        computedAt: stored?.computedAt ?? new Date(),
      };
    });
  }
}
