/**
 * 域名解析执行面活动（ch03 §3.12，批次 3b 骨架；env 门 DOMAIN_RESOLUTION_WORKFLOW_ENABLED 默认关）。
 *
 * 三段流水，全部经 activity（workflow 只做编排）：
 *  1. resolveRegistryDomainCandidates —— 候选生成（MultiRouteDomainResolver；模板期只有
 *     source_field=源自带 website 一条路，search/ct/cc/wikidata 等适配器接线后在 ports 注入）；
 *  2. verifyRegistryDomainCandidates —— 法务页证据校验（页面抓取适配器接线前 pages 为空，
 *     确定性判 REJECTED·NO_LEGAL_PAGE，**零出网**）；
 *  3. persistDomainResolution —— 落库（PR-3a 存储契约）：upsert 候选行、唯一 VERIFIED 选中、
 *     AMBIGUOUS/抽样生成复核工单（幂等入队）。
 *
 * 门默认关：任一活动在门关时抛 `DOMAIN_RESOLUTION_DISABLED`，零调用零落库。
 */
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import {
  MultiRouteDomainResolver,
  type DomainCandidate,
  type MultiRouteDomainResolverOptions,
} from '../registry/domain/domain-resolver';
import { PrismaDomainResolutionStore, PrismaDomainReviewTaskStore } from '../registry/domain/domain-stores.prisma';
import type { DomainResolutionStore } from '../registry/domain/domain-resolution-store';
import { buildReviewTasksFromVerification } from '../registry/domain/domain-review';
import type { DomainReviewTaskStore } from '../registry/domain/domain-review-store';
import {
  verifyDomainCandidates,
  type DomainMatchType,
  type DomainVerdict,
  type DomainVerificationSignals,
  type LegalPageText,
  type VatValidator,
} from '../registry/domain/domain-verifier';

export class DomainResolutionWorkflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DomainResolutionWorkflowError';
    this.code = code;
  }
}

export const DOMAIN_RESOLUTION_DISABLED = 'DOMAIN_RESOLUTION_DISABLED';

/** workflow 输入的公司解析面（至少带注册身份；website 走 source_field 路由）。 */
export interface DomainResolutionCompanyInput {
  companyId: string;
  scheme: string;
  regNumber: string;
  name: string;
  country: string;
  city?: string | null;
  postalCode?: string | null;
  vatId?: string | null;
  website?: string | null;
}

export interface ResolveDomainCandidatesResult {
  companyId: string;
  candidates: DomainCandidate[];
  status: 'CANDIDATES' | 'NOT_FOUND';
  notFoundReason?: 'NO_PROVIDERS' | 'NO_HITS';
}

export interface VerifyDomainCandidateResultItem {
  candidateDomain: string;
  verdict: DomainVerdict;
  score: number;
  matchType: DomainMatchType;
  signals: DomainVerificationSignals;
  rejectReasons: string[];
  evidenceUrls: string[];
}

export interface VerifyDomainCandidatesActivityResult {
  companyId: string;
  results: VerifyDomainCandidateResultItem[];
  selectedDomain: string | null;
  nameCollision: boolean;
  /** 法务页抓取适配器接线前恒为 false（空 pages → NO_LEGAL_PAGE）。 */
  pagesAvailable: boolean;
}

export interface PersistDomainResolutionInput {
  workspaceId: string;
  companyId: string;
  candidates: DomainCandidate[];
  verification: Pick<VerifyDomainCandidatesActivityResult, 'results' | 'selectedDomain' | 'nameCollision'>;
  /** VERIFIED 行的抽样复核率（0..1，默认 0 = 不抽样）。 */
  auditSampleRate?: number;
}

export interface PersistDomainResolutionResult {
  companyId: string;
  resolutionIds: Record<string, string>;
  selectedDomain: string | null;
  reviewTasksOpened: number;
}

export interface DomainResolutionPorts {
  /** 法务页抓取（外部抓取适配器接线后注入；缺省 = 不可用 → 空 pages）。 */
  fetchLegalPages?: (domain: string) => Promise<LegalPageText[]>;
  /** 额外候选路由的提供者配置（search / ct / cc / wikidata）。 */
  resolverOptions?: MultiRouteDomainResolverOptions;
  /** VIES 等 VAT 校验器（缺省无 → VAT 证据按未知处理）。 */
  vatValidator?: VatValidator;
  /**
   * 抽样复核判定器；缺省按 (workspace, company, index) 的 sha256 派生（确定性、可重放），
   * 与 auditSampleRate 比较决定是否入队。仅测试/灰度调权时注入。
   */
  auditSampler?: (companyId: string, index: number) => boolean;
}

export interface DomainResolutionActivities {
  resolveRegistryDomainCandidates(company: DomainResolutionCompanyInput): Promise<ResolveDomainCandidatesResult>;
  verifyRegistryDomainCandidates(input: {
    company: DomainResolutionCompanyInput;
    candidates: DomainCandidate[];
  }): Promise<VerifyDomainCandidatesActivityResult>;
  persistDomainResolution(input: PersistDomainResolutionInput): Promise<PersistDomainResolutionResult>;
}

type WorkspaceRunner = Pick<PrismaService, 'withWorkspace'>;

interface ActivityStores {
  resolutions: DomainResolutionStore;
  reviewTasks: DomainReviewTaskStore;
}

export interface DomainResolutionActivitiesDeps {
  prisma: WorkspaceRunner;
  ports?: DomainResolutionPorts;
  /** 缺省 = `DOMAIN_RESOLUTION_WORKFLOW_ENABLED === 'on'`（默认关）。 */
  enabled?: boolean;
  /** 测试注入内存契约；缺省 = PR-3a 的 Prisma 实现。 */
  storeFactory?: (tx: unknown) => ActivityStores;
}

const defaultStoreFactory = (tx: unknown): ActivityStores => ({
  resolutions: new PrismaDomainResolutionStore(tx as never),
  reviewTasks: new PrismaDomainReviewTaskStore(tx as never),
});

export function createDomainResolutionActivities(deps: DomainResolutionActivitiesDeps): DomainResolutionActivities {
  const enabled = deps.enabled ?? process.env.DOMAIN_RESOLUTION_WORKFLOW_ENABLED === 'on';
  const storeFactory = deps.storeFactory ?? defaultStoreFactory;

  const assertEnabled = (): void => {
    if (!enabled) {
      throw new DomainResolutionWorkflowError(
        DOMAIN_RESOLUTION_DISABLED,
        'DOMAIN_RESOLUTION_WORKFLOW_ENABLED 未开启（默认关）：解析活动拒绝执行',
      );
    }
  };

  return {
    async resolveRegistryDomainCandidates(company) {
      assertEnabled();
      const resolver = new MultiRouteDomainResolver(deps.ports?.resolverOptions ?? {});
      const result = await resolver.resolve({
        name: company.name,
        country: company.country,
        city: company.city ?? null,
        website: company.website ?? null,
      });
      return {
        companyId: company.companyId,
        candidates: result.candidates,
        status: result.status,
        ...(result.notFoundReason ? { notFoundReason: result.notFoundReason } : {}),
      };
    },

    async verifyRegistryDomainCandidates(input) {
      assertEnabled();
      const candidates: Array<{ candidateDomain: string; pages: LegalPageText[] }> = [];
      let pagesAvailable = false;
      for (const candidate of input.candidates) {
        let pages: LegalPageText[] = [];
        if (deps.ports?.fetchLegalPages) {
          try {
            pages = await deps.ports.fetchLegalPages(candidate.domain);
          } catch {
            pages = []; // 抓取失败 ≠ 证据：按无页面处理（确定性拒绝，不扣"无证据"以外的分）。
          }
        }
        if (pages.length > 0) pagesAvailable = true;
        candidates.push({ candidateDomain: candidate.domain, pages });
      }
      const verification = await verifyDomainCandidates({
        entity: {
          scheme: input.company.scheme,
          regNumber: input.company.regNumber,
          name: input.company.name,
          country: input.company.country,
          city: input.company.city ?? null,
          postalCode: input.company.postalCode ?? null,
          vatId: input.company.vatId ?? null,
        },
        candidates,
        vatValidator: deps.ports?.vatValidator,
      });
      return {
        companyId: input.company.companyId,
        results: verification.results.map((result) => ({
          candidateDomain: result.candidateDomain,
          verdict: result.verdict,
          score: result.score,
          matchType: result.matchType,
          signals: result.signals,
          rejectReasons: result.rejectReasons,
          evidenceUrls: result.evidenceUrls,
        })),
        selectedDomain: verification.selectedDomain,
        nameCollision: verification.nameCollision,
        pagesAvailable,
      };
    },

    async persistDomainResolution(input) {
      assertEnabled();
      const now = new Date().toISOString();
      return deps.prisma.withWorkspace(input.workspaceId, async (tx) => {
        const stores = storeFactory(tx);
        const routeByDomain = new Map(input.candidates.map((candidate) => [candidate.domain, candidate]));
        // 迁移 CHECK 不允许 selected=true 的非 VERIFIED 行：若本轮把「当前选中行」改判为
        // 非 VERIFIED，必须先清选中再 upsert（本事务内先清后写，外部不可见）。选中行不在
        // 本轮结果里则不动它（其证据本轮未被重新评估）。
        const existing = await stores.resolutions.listForCompany(input.workspaceId, input.companyId);
        const selected = existing.find((row) => row.selected);
        if (selected) {
          const rerun = input.verification.results.find(
            (result) =>
              result.candidateDomain === selected.candidateDomain &&
              routeByDomain.get(result.candidateDomain)?.route === selected.route,
          );
          if (rerun && rerun.verdict !== 'VERIFIED') {
            await stores.resolutions.clearSelected(input.workspaceId, input.companyId, now);
          }
        }
        const resolutionIds: Record<string, string> = {};
        for (const result of input.verification.results) {
          const route = routeByDomain.get(result.candidateDomain);
          if (!route) continue; // 防御：校验结果必须来自候选集。
          const upserted = await stores.resolutions.upsert(
            input.workspaceId,
            input.companyId,
            {
              candidateDomain: result.candidateDomain,
              route: route.route,
              routeRank: route.routeRank,
              status: result.verdict,
              matchType: result.matchType,
              confidence: result.score,
              evidenceUrl: result.evidenceUrls[0] ?? null,
              evidenceJson: {
                signals: result.signals,
                rejectReasons: result.rejectReasons,
              },
              extractorVersion: 'domain-workflow/v1',
              verifiedAt: result.verdict === 'VERIFIED' ? now : null,
            },
            now,
          );
          resolutionIds[result.candidateDomain] = upserted.id;
        }

        let selectedDomain: string | null = null;
        if (input.verification.selectedDomain) {
          const resolutionId = resolutionIds[input.verification.selectedDomain];
          if (resolutionId) {
            await stores.resolutions.selectVerified(input.workspaceId, input.companyId, resolutionId, now);
            selectedDomain = input.verification.selectedDomain;
          }
        }

        let reviewTasksOpened = 0;
        const auditSampleRate = input.auditSampleRate ?? 0;
        // VERIFIED 行的抽样复核：缺省按确定性哈希派生（activity 可重放；注入端口可覆盖）。
        const auditSampler =
          auditSampleRate > 0
            ? (index: number): boolean => {
                if (deps.ports?.auditSampler) return deps.ports.auditSampler(input.companyId, index);
                const digest = createHash('sha256')
                  .update(`${input.workspaceId}\u0001${input.companyId}\u0001audit_sample\u0001${index}`)
                  .digest();
                return digest.readUInt32BE(0) / 0x1_0000_0000 < auditSampleRate;
              }
            : undefined;
        const tasks = buildReviewTasksFromVerification(
          {
            results: input.verification.results.map((result) => ({
              candidateDomain: result.candidateDomain,
              verdict: result.verdict,
              score: result.score,
              matchType: result.matchType,
              signals: result.signals,
              rejectReasons: result.rejectReasons,
              pageRegister: null,
              pageVatId: null,
              evidenceUrls: result.evidenceUrls,
            })),
            selectedDomain: input.verification.selectedDomain,
            nameCollision: input.verification.nameCollision,
          },
          { now, auditSampleRate, ...(auditSampler ? { auditSampler } : {}) },
        );
        for (const task of tasks) {
          const resolutionId = resolutionIds[task.resolutionRef];
          if (!resolutionId) continue;
          const opened = await stores.reviewTasks.openOrGet(
            input.workspaceId,
            {
              resolutionId,
              reason: task.reason,
              priority: task.priority,
              dueAt: task.dueAt,
            },
            now,
          );
          if (opened.created) reviewTasksOpened += 1;
        }

        return {
          companyId: input.companyId,
          resolutionIds,
          selectedDomain,
          reviewTasksOpened,
        };
      });
    },
  };
}
