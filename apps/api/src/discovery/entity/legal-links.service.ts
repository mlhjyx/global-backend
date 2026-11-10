import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../../auth/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import type { VatValidator } from '../../registry/domain/domain-verifier';
import {
  CompanyIdentitySnapshot,
  decideCompanyLegalLinks,
  LegalEntityCandidate,
  type LinkDecision,
} from './entity-matching';
import {
  isLegalEntityScheme,
  isLegalEntityStatus,
  LegalEntityScheme,
  LegalEntityStatus,
  normalizeCountry,
  normalizeLegalValue,
} from './entity-keys';

/** VIES 校验注入点（module 默认不提供实现 → VAT 命中落 review，不出网）。 */
export const LEGAL_LINK_VAT_VALIDATOR = Symbol('LEGAL_LINK_VAT_VALIDATOR');

export const LEGAL_LINK_MAX_REQUEST_CANDIDATES = 20;
/** 概率匹配的单次 blocking 扫描上限（同一国家的实体行）。W4 装载层接入后由批量作业承接更大规模。 */
export const LEGAL_LINK_BLOCKING_SCAN_CAP = 500;

export interface LegalEntityCandidateInput {
  scheme: LegalEntityScheme;
  value: string;
  country: string;
  name: string;
  address?: string | null;
  status?: LegalEntityStatus;
  sourceProvider: string;
  evidenceUrl?: string | null;
  evidenceHash?: string | null;
  evidenceJson?: Record<string, unknown> | null;
}

export interface ResolveRequestBody {
  /** 可选：先把一批候选法人实体登记进 legal_entity，再对它们（及既有行）做消歧。 */
  candidates?: LegalEntityCandidateInput[];
}

export interface LegalLinkView {
  id: string;
  companyId: string;
  legalEntityId: string;
  confidence: number;
  matchMethod: string;
  matchRule: string;
  status: string;
  evidence: unknown;
  createdAt: string;
  updatedAt: string;
  legalEntity: {
    id: string;
    scheme: LegalEntityScheme;
    value: string;
    country: string;
    name: string;
    address: string | null;
    status: LegalEntityStatus;
    sourceProvider: string;
  };
}

type ParsedBody = ResolveRequestBody | 'invalid';

function trimmedString(raw: unknown, min: number, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length >= min && value.length <= max ? value : null;
}

/** 请求体校验（形态错误 → 'invalid' → 400 VALIDATION_ERROR）。 */
export function parseResolveBody(raw: unknown): ParsedBody {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const body = raw as Record<string, unknown>;
  const extraKeys = Object.keys(body).filter((key) => key !== 'candidates');
  if (extraKeys.length > 0) return 'invalid';
  if (body.candidates === undefined) return {};
  if (!Array.isArray(body.candidates) || body.candidates.length > LEGAL_LINK_MAX_REQUEST_CANDIDATES) {
    return 'invalid';
  }

  const candidates: LegalEntityCandidateInput[] = [];
  for (const entry of body.candidates) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'invalid';
    const candidate = entry as Record<string, unknown>;
    if (!isLegalEntityScheme(candidate.scheme)) return 'invalid';
    const scheme = candidate.scheme;
    const value = normalizeLegalValue(scheme, candidate.value);
    if (!value) return 'invalid';
    const country = normalizeCountry(candidate.country);
    if (!country) return 'invalid';
    const name = trimmedString(candidate.name, 1, 512);
    if (!name) return 'invalid';
    const address = candidate.address == null ? null : trimmedString(candidate.address, 1, 1024);
    if (candidate.address != null && !address) return 'invalid';
    const status = candidate.status == null ? 'unknown' : candidate.status;
    if (!isLegalEntityStatus(status)) return 'invalid';
    const sourceProvider = candidate.sourceProvider == null
      ? 'manual_submission'
      : trimmedString(candidate.sourceProvider, 1, 64);
    if (!sourceProvider) return 'invalid';
    const evidenceUrl = candidate.evidenceUrl == null ? null : trimmedString(candidate.evidenceUrl, 1, 2048);
    if (evidenceUrl && !/^https:\/\//u.test(evidenceUrl)) return 'invalid';
    const evidenceHash = candidate.evidenceHash;
    if (evidenceHash != null && (typeof evidenceHash !== 'string' || !/^[0-9a-f]{64}$/u.test(evidenceHash))) {
      return 'invalid';
    }
    const evidenceJson = candidate.evidenceJson;
    if (evidenceJson != null && (typeof evidenceJson !== 'object' || Array.isArray(evidenceJson))) {
      return 'invalid';
    }
    candidates.push({
      scheme,
      value,
      country,
      name,
      address,
      status,
      sourceProvider,
      evidenceUrl,
      evidenceHash: evidenceHash ?? null,
      evidenceJson: (evidenceJson as Record<string, unknown> | null) ?? null,
    });
  }
  return { candidates };
}

interface CompanyRow {
  id: string;
  name: string;
  country: string | null;
  attributes: unknown;
}

function readObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function gleifStatusToEntityStatus(attrs: Record<string, unknown> | null): LegalEntityStatus {
  const gleif = readObject(attrs?.gleif);
  const entityStatus = typeof gleif?.entity_status === 'string' ? gleif.entity_status.toUpperCase() : null;
  if (entityStatus === 'ACTIVE') return 'active';
  if (entityStatus === 'INACTIVE') return 'inactive';
  const registration = typeof gleif?.registration_status === 'string'
    ? gleif.registration_status.toUpperCase()
    : null;
  if (registration === 'MERGED' || registration === 'RETIRED') return 'dissolved';
  return 'unknown';
}

interface SelfIdentifierSource {
  scheme: LegalEntityScheme;
  value: string;
  country: string | null;
  name: string;
  status: LegalEntityStatus;
  sourceProvider: string;
  evidenceUrl: string | null;
}

/**
 * 公司自带的确定性键（GLEIF/Wikidata 的 LEI、Impressum 的 VAT）→ 快照标识 + 自实体登记输入。
 * 自实体的 country 取登记国/公司国；缺失则不登记实体行，但标识仍参与冲突/命中判定。
 */
export function companyIdentifierSources(company: CompanyRow): {
  identifiers: SelfIdentifierSource[];
  legalName: string | null;
  country: string | null;
} {
  const attrs = readObject(company.attributes);
  const gleif = readObject(attrs?.gleif);
  const wikidata = readObject(attrs?.wikidata);
  const websiteProfile = readObject(attrs?.website_profile);

  const gleifLei = typeof gleif?.lei === 'string' && gleif.lei ? gleif.lei : null;
  const wikidataLei = typeof wikidata?.lei === 'string' && wikidata.lei ? wikidata.lei : null;
  const legalName = typeof gleif?.legal_name === 'string' && gleif.legal_name.trim()
    ? gleif.legal_name.trim()
    : null;
  const registeredCountry = normalizeCountry(gleif?.registered_country);
  const companyCountry = normalizeCountry(company.country) ?? registeredCountry;

  const identifiers: SelfIdentifierSource[] = [];
  const lei = gleifLei ? normalizeLegalValue('lei', gleifLei) : wikidataLei ? normalizeLegalValue('lei', wikidataLei) : null;
  if (lei) {
    identifiers.push({
      scheme: 'lei',
      value: lei,
      country: registeredCountry ?? companyCountry,
      name: legalName ?? company.name,
      status: gleifStatusToEntityStatus(attrs),
      sourceProvider: gleifLei ? 'gleif' : 'wikidata',
      evidenceUrl: `https://search.gleif.org/#/record/${lei}`,
    });
  }
  const vat = websiteProfile?.vat_id ? normalizeLegalValue('vat', websiteProfile.vat_id) : null;
  if (vat) {
    identifiers.push({
      scheme: 'vat',
      value: vat,
      country: companyCountry,
      name: company.name,
      status: 'unknown',
      sourceProvider: 'website_profile',
      evidenceUrl: null,
    });
  }
  return { identifiers, legalName, country: companyCountry };
}

type EntityRow = {
  id: string;
  scheme: string;
  value: string;
  country: string;
  name: string;
  address: string | null;
  status: string;
};

function entityKeyOf(scheme: string, country: string, value: string): string {
  return `${scheme}:${country}:${value}`;
}

/**
 * W2 服务：法律实体消歧与公司-实体链接（租户内）。
 *
 * 写入面（resolve）：
 *  1. 把公司自带标识（GLEIF LEI / 官网 VAT）与请求体 candidates 登记/补齐到 legal_entity；
 *  2. 以确定性键 + blocking（国家+归一化名字前 4 字符）召候选；
 *  3. `decideCompanyLegalLinks` 判定，auto/review/rejected 落 company_legal_link（同对只升不降）；
 *  4. 返回该公司当前全部链接（含本次新增）。
 *
 * 只读面（list）：按置信度倒序返回公司链接与实体摘要。
 * RLS：所有读写走 `withWorkspace`（app_user + set_config 事务），谓词再显式带 workspaceId 作纵深防御。
 */
@Injectable()
export class LegalLinksService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(LEGAL_LINK_VAT_VALIDATOR)
    private readonly vatValidator?: VatValidator | null,
  ) {}

  async list(ctx: RequestContext, companyId: string): Promise<{ items: LegalLinkView[] } | 'not_found'> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findFirst({
        where: { id: companyId, workspaceId: ctx.workspaceId },
        select: { id: true },
      });
      if (!company) return 'not_found' as const;
      return { items: await this.readLinks(tx, ctx.workspaceId, companyId) };
    });
  }

  async resolve(
    ctx: RequestContext,
    companyId: string,
    rawBody: unknown,
  ): Promise<{ items: LegalLinkView[]; evaluated: number } | 'invalid' | 'not_found'> {
    const body = parseResolveBody(rawBody);
    if (body === 'invalid') return 'invalid';

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = (await tx.canonicalCompany.findFirst({
        where: { id: companyId, workspaceId: ctx.workspaceId },
        select: { id: true, name: true, country: true, attributes: true },
      })) as CompanyRow | null;
      if (!company) return 'not_found' as const;

      const sources = companyIdentifierSources(company);

      // 1) 登记自实体与请求候选（幂等：已存在的键不覆盖）。
      const register: Array<{
        scheme: LegalEntityScheme;
        value: string;
        country: string;
        name: string;
        address: string | null;
        status: LegalEntityStatus;
        sourceProvider: string;
        evidenceUrl: string | null;
        evidenceHash: string | null;
        evidenceJson: Record<string, unknown> | null;
      }> = [];
      for (const source of sources.identifiers) {
        if (!source.country) continue;
        register.push({
          scheme: source.scheme,
          value: source.value,
          country: source.country,
          name: source.name,
          address: null,
          status: source.status,
          sourceProvider: source.sourceProvider,
          evidenceUrl: source.evidenceUrl,
          evidenceHash: null,
          evidenceJson: null,
        });
      }
      for (const candidate of body.candidates ?? []) {
        register.push({
          scheme: candidate.scheme,
          value: candidate.value,
          country: candidate.country,
          name: candidate.name,
          address: candidate.address ?? null,
          status: candidate.status ?? 'unknown',
          sourceProvider: candidate.sourceProvider,
          evidenceUrl: candidate.evidenceUrl ?? null,
          evidenceHash: candidate.evidenceHash ?? null,
          evidenceJson: candidate.evidenceJson ?? null,
        });
      }
      const registeredRows = await this.upsertEntities(tx, ctx.workspaceId, register);

      // 2) 候选集：确定性键直查 + blocking 扫描（国家相同；名字前缀过滤在判定层再做）。
      const identifierInputs = [
        ...sources.identifiers.map((identifier) => ({ scheme: identifier.scheme, value: identifier.value })),
        ...(body.candidates ?? []).map((candidate) => ({ scheme: candidate.scheme, value: candidate.value })),
      ];
      const keyed = identifierInputs.length
        ? await tx.legalEntity.findMany({
            where: {
              workspaceId: ctx.workspaceId,
              OR: identifierInputs.map((identifier) => ({ scheme: identifier.scheme, value: identifier.value })),
            },
          })
        : [];
      const blocked = sources.country && (sources.legalName ?? company.name)
        ? await tx.legalEntity.findMany({
            where: { workspaceId: ctx.workspaceId, country: sources.country },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: LEGAL_LINK_BLOCKING_SCAN_CAP,
          })
        : [];

      const universe = new Map<string, EntityRow>();
      for (const row of [...registeredRows, ...keyed, ...blocked]) {
        universe.set(entityKeyOf(row.scheme, row.country, row.value), row);
      }
      const candidates: LegalEntityCandidate[] = [...universe.values()].map((row) => ({
        entityId: row.id,
        scheme: row.scheme as LegalEntityScheme,
        value: row.value,
        country: row.country,
        name: row.name,
        address: row.address,
        status: row.status as LegalEntityStatus,
      }));

      // 3) 判定（确定性优先；只有与公司无任何同 scheme 确定性关系的实体进入概率匹配）。
      const snapshot: CompanyIdentitySnapshot = {
        companyId: company.id,
        name: company.name,
        legalName: sources.legalName,
        country: sources.country,
        identifiers: sources.identifiers.map(({ scheme, value, country }) => ({ scheme, value, country })),
      };
      const decisions = await decideCompanyLegalLinks(snapshot, candidates, {
        vatValidator: this.vatValidator ?? null,
      });

      await this.persistDecisions(tx, ctx.workspaceId, companyId, decisions, universe);

      return {
        items: await this.readLinks(tx, ctx.workspaceId, companyId),
        evaluated: decisions.length,
      };
    });
  }

  /** 幂等登记：已存在的 (workspace, scheme, country, value) 不覆盖（首个写入者为证据源）。 */
  private async upsertEntities(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    register: ReadonlyArray<{
      scheme: LegalEntityScheme;
      value: string;
      country: string;
      name: string;
      address: string | null;
      status: LegalEntityStatus;
      sourceProvider: string;
      evidenceUrl: string | null;
      evidenceHash: string | null;
      evidenceJson: Record<string, unknown> | null;
    }>,
  ): Promise<EntityRow[]> {
    if (register.length === 0) return [];
    const deduped = new Map<string, (typeof register)[number]>();
    for (const entry of register) {
      const key = entityKeyOf(entry.scheme, entry.country, entry.value);
      if (!deduped.has(key)) deduped.set(key, entry);
    }
    const rows = [...deduped.values()];
    await tx.legalEntity.createMany({
      data: rows.map((row) => ({
        workspaceId,
        scheme: row.scheme,
        value: row.value,
        country: row.country,
        name: row.name,
        address: row.address,
        status: row.status,
        sourceProvider: row.sourceProvider,
        evidenceUrl: row.evidenceUrl,
        evidenceHash: row.evidenceHash,
        evidenceJson: (row.evidenceJson ?? undefined) as Prisma.InputJsonValue | undefined,
      })),
      skipDuplicates: true,
    });
    return tx.legalEntity.findMany({
      where: {
        workspaceId,
        OR: rows.map((row) => ({ scheme: row.scheme, country: row.country, value: row.value })),
      },
    });
  }

  /**
   * 落库：同 (workspace, company, entity) 只升不降（rejected < review < auto），
   * 重复 resolve 幂等；新判定更强的证据会升级既有行。
   */
  private async persistDecisions(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    companyId: string,
    decisions: ReadonlyArray<LinkDecision>,
    universe: ReadonlyMap<string, EntityRow>,
  ): Promise<void> {
    if (decisions.length === 0) return;
    const rank: Record<string, number> = { rejected: 0, review: 1, auto: 2 };
    const existing = await tx.companyLegalLink.findMany({
      where: { workspaceId, companyId },
      select: { id: true, legalEntityId: true, status: true },
    });
    const byEntity = new Map(existing.map((link) => [link.legalEntityId, link]));

    const creates: Prisma.CompanyLegalLinkCreateManyInput[] = [];
    const upgrades: Array<{
      id: string;
      status: string;
      confidence: number;
      matchMethod: string;
      matchRule: string;
      evidenceJson: Prisma.InputJsonValue;
    }> = [];
    for (const decision of decisions) {
      const entity = universe.get(
        entityKeyOf(decision.entity.scheme, decision.entity.country, decision.entity.value),
      );
      if (!entity) continue;
      const current = byEntity.get(entity.id);
      const data = {
        status: decision.status,
        confidence: decision.confidence,
        matchMethod: decision.matchMethod,
        matchRule: decision.matchRule,
        evidenceJson: decision.evidence as Prisma.InputJsonValue,
      };
      if (!current) {
        creates.push({ workspaceId, companyId, legalEntityId: entity.id, ...data });
      } else if ((rank[decision.status] ?? 0) > (rank[current.status] ?? 0)) {
        upgrades.push({ id: current.id, ...data });
      }
    }
    if (creates.length > 0) {
      await tx.companyLegalLink.createMany({ data: creates, skipDuplicates: true });
    }
    for (const upgrade of upgrades) {
      await tx.companyLegalLink.update({ where: { id: upgrade.id }, data: upgrade });
    }
  }

  private async readLinks(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    companyId: string,
  ): Promise<LegalLinkView[]> {
    const rows = await tx.companyLegalLink.findMany({
      where: { workspaceId, companyId },
      include: { legalEntity: true },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      legalEntityId: row.legalEntityId,
      confidence: row.confidence,
      matchMethod: row.matchMethod,
      matchRule: row.matchRule,
      status: row.status,
      evidence: row.evidenceJson ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      legalEntity: {
        id: row.legalEntity.id,
        scheme: row.legalEntity.scheme as LegalEntityScheme,
        value: row.legalEntity.value,
        country: row.legalEntity.country,
        name: row.legalEntity.name,
        address: row.legalEntity.address,
        status: row.legalEntity.status as LegalEntityStatus,
        sourceProvider: row.legalEntity.sourceProvider,
      },
    }));
  }
}
