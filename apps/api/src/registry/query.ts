/**
 * `registry_frame` 查询契约（ch03 §3.9.12 / §3.9.13 的引擎侧纯函数）。
 *
 * 计划阶段产出的 filters 是不可信输入：本模块校验白名单、拒绝未知键（fail closed），
 * 再编译成参数化的 Prisma 查询（无字符串拼接 SQL）。查询只读平台表，零出网、零成本；
 * 结果映射为 `ProviderCompanyRecord`，供 T3-09 的 provider 接线走现有 receipt /
 * materialization 契约。
 *
 * 口径（与章节一致）：
 *  - 只查「最新状态未退出」的实体：`withdrawn_at IS NULL` 且 last_snapshot 仍为 PARSED
 *    （superseded 快照里的旧实体不参与候选枚举）；
 *  - 排序固定 `ORDER BY scheme, reg_number`——同快照 + 同 filters 的查询结果确定；
 *  - limit 默认 500、上限 2000，与 run 池帽（DISCOVERY_RUN_POOL_CAP）协同，超出留待下一批。
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import type { CompanyIdentifier } from '../discovery/identity';
import { normalizeDomain } from '../discovery/identity';
import type { ProviderCompanyRecord } from '../discovery/provider-contract';
import type { EmployeeBand, RegistryEntityStatus } from './frame-types';
import { EMPLOYEE_BANDS, REGISTRY_ENTITY_STATUSES } from './frame-types';

export const REGISTRY_QUERY_DEFAULT_LIMIT = 500;
export const REGISTRY_QUERY_MAX_LIMIT = 2000;

const ISO2 = /^[A-Z]{2}$/u;
const SCHEME = /^[a-z0-9_]{2,40}$/u;
const NACE_PREFIX = /^(?:\d{2,4}|\d{2}\.\d{1,2})$/u;
const POSTAL_PREFIX = /^[A-Z0-9]{1,3}$/u;

/** filters 的已知键；出现其他键即拒绝（计划校验失败，对应 400）。 */
const FILTER_KEYS = new Set([
  'source_hint',
  'country',
  'scheme',
  'nace_prefix',
  'employee_band',
  'legal_form',
  'status',
  'postal_prefix',
  'limit',
]);

export interface RegistryQueryFilters {
  country: string;
  scheme: string | null;
  nacePrefixes: string[];
  employeeBands: EmployeeBand[];
  legalForms: string[];
  status: RegistryEntityStatus;
  postalPrefix: string | null;
  limit: number;
}

export class RegistryQueryError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'RegistryQueryError';
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(issues: string[], value: unknown, path: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${path} 必须是字符串数组`);
    return [];
  }
  return value.map((entry: string) => entry.trim()).filter((entry) => entry.length > 0);
}

/** 校验计划 filters；任何结构性问题收集后抛 `RegistryQueryError`（fail closed）。 */
export function parseRegistryQueryFilters(raw: unknown): RegistryQueryFilters {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    throw new RegistryQueryError('registry_frame filters 必须是对象', ['root 必须是对象']);
  }
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.has(key)) {
      issues.push(`未知 filter：${key}（白名单：${[...FILTER_KEYS].join(', ')}）`);
    }
  }
  if (raw.source_hint !== undefined && raw.source_hint !== 'registry_frame') {
    issues.push('source_hint 只接受 registry_frame');
  }

  const country =
    typeof raw.country === 'string' ? raw.country.trim().toUpperCase() : '';
  if (!ISO2.test(country)) {
    issues.push('country 必填且必须是 ISO 3166-1 alpha-2（大写两字母）');
  }

  let scheme: string | null = null;
  if (raw.scheme !== undefined && raw.scheme !== null) {
    if (typeof raw.scheme !== 'string' || !SCHEME.test(raw.scheme.trim())) {
      issues.push('scheme 必须是小写字母/数字/下划线（≤40）');
    } else {
      scheme = raw.scheme.trim();
    }
  }

  const nacePrefixes = stringArray(issues, raw.nace_prefix, 'nace_prefix');
  for (const prefix of nacePrefixes) {
    if (!NACE_PREFIX.test(prefix)) {
      issues.push(`nace_prefix 项非法：${prefix}（2–4 位数字，或 28 / 28.13 形式）`);
    }
  }

  const bands = stringArray(issues, raw.employee_band, 'employee_band');
  for (const band of bands) {
    if (!(EMPLOYEE_BANDS as readonly string[]).includes(band)) {
      issues.push(`employee_band 项非法：${band}`);
    }
  }

  const legalForms = stringArray(issues, raw.legal_form, 'legal_form').map((form) =>
    form.toLowerCase(),
  );

  let status: RegistryEntityStatus = 'ACTIVE';
  if (raw.status !== undefined) {
    if (
      typeof raw.status !== 'string' ||
      !REGISTRY_ENTITY_STATUSES.includes(raw.status as RegistryEntityStatus)
    ) {
      issues.push(`status 必须是 ${REGISTRY_ENTITY_STATUSES.join(' | ')} 之一`);
    } else {
      status = raw.status as RegistryEntityStatus;
    }
  }

  let postalPrefix: string | null = null;
  if (raw.postal_prefix !== undefined && raw.postal_prefix !== null) {
    const candidate =
      typeof raw.postal_prefix === 'string' ? raw.postal_prefix.trim().toUpperCase() : '';
    if (!POSTAL_PREFIX.test(candidate)) {
      issues.push('postal_prefix 必须是 1–3 位字母/数字');
    } else {
      postalPrefix = candidate;
    }
  }

  let limit = REGISTRY_QUERY_DEFAULT_LIMIT;
  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== 'number' ||
      !Number.isInteger(raw.limit) ||
      raw.limit <= 0 ||
      raw.limit > REGISTRY_QUERY_MAX_LIMIT
    ) {
      issues.push(`limit 必须是 1..${REGISTRY_QUERY_MAX_LIMIT} 的整数`);
    } else {
      limit = raw.limit;
    }
  }

  if (issues.length > 0) {
    throw new RegistryQueryError(`registry_frame filters 校验失败（${issues.length} 项）`, issues);
  }
  return {
    country,
    scheme,
    nacePrefixes,
    employeeBands: bands as EmployeeBand[],
    legalForms,
    status,
    postalPrefix,
    limit,
  };
}

/**
 * 数字前缀的另一种存储形态：库内 NACE 以 `28.13` / `28.13Z` 落库，计划侧常用无点号的
 * `2813` 写法——两种都要能命中。3 位 `281` → `28.1`；4 位 `2813` → `28.13`；
 * 2 位与点号形态原样。
 */
function nacePrefixVariants(prefix: string): string[] {
  if (prefix.includes('.') || prefix.length === 2) return [prefix];
  const dotted = `${prefix.slice(0, 2)}.${prefix.slice(2)}`;
  return [prefix, dotted];
}

/** filters → Prisma 查询参数（全参数化；排序固定保证确定性）。 */
export function buildRegistryEntityQuery(filters: RegistryQueryFilters): {
  where: Prisma.RegistryEntityWhereInput;
  orderBy: Prisma.RegistryEntityOrderByWithRelationInput[];
  take: number;
} {
  const naceVariants = [...new Set(filters.nacePrefixes.flatMap(nacePrefixVariants))];
  const where: Prisma.RegistryEntityWhereInput = {
    country: filters.country,
    status: filters.status,
    withdrawnAt: null,
    lastSnapshot: { status: 'PARSED' },
    ...(filters.scheme ? { scheme: filters.scheme } : {}),
    ...(naceVariants.length > 0
      ? { OR: naceVariants.map((prefix) => ({ nace: { startsWith: prefix } })) }
      : {}),
    ...(filters.employeeBands.length > 0
      ? { employeeBand: { in: filters.employeeBands } }
      : {}),
    ...(filters.legalForms.length > 0
      ? { legalForm: { in: filters.legalForms, mode: 'insensitive' } }
      : {}),
    ...(filters.postalPrefix ? { postalCode: { startsWith: filters.postalPrefix } } : {}),
  };
  return {
    where,
    orderBy: [{ scheme: 'asc' }, { regNumber: 'asc' }],
    take: filters.limit,
  };
}

/** 计划 rationale（写进 DiscoveryQueryPlan.rationale，供 receipt/审计回溯口径）。 */
export function registryQueryRationale(filters: RegistryQueryFilters): string {
  const scope = filters.scheme ?? filters.country;
  return `本地注册库 frame 枚举（${scope}，limit ${filters.limit}）`;
}

/** employeeBand → 中位数（ch03 §3.9.13；0 → 0，1-9 → 5，…）。 */
export function employeeCountForBand(band: EmployeeBand | null | undefined): number | undefined {
  switch (band) {
    case '0':
      return 0;
    case '1-9':
      return 5;
    case '10-49':
      return 25;
    case '50-249':
      return 120;
    case '250+':
      return 500;
    default:
      return undefined;
  }
}

export interface RegistryQueryRow {
  scheme: string;
  regNumber: string;
  country: string;
  name: string;
  region: string | null;
  nace: string | null;
  naceVersion: string | null;
  employeeBand: EmployeeBand | null;
  legalForm: string | null;
  status: string;
  website: string | null;
  identifiers: unknown;
  lastSnapshotId: string;
  sourceFrame: { frameKey: string; licence: string } | null;
}

/** 查询投影：只取映射所需列（不把 attributes/address 带进候选记录）。 */
export const REGISTRY_QUERY_SELECT = {
  scheme: true,
  regNumber: true,
  country: true,
  name: true,
  region: true,
  nace: true,
  naceVersion: true,
  employeeBand: true,
  legalForm: true,
  status: true,
  website: true,
  identifiers: true,
  lastSnapshotId: true,
  sourceFrame: { select: { frameKey: true, licence: true } },
} as const;

function identifiersOf(value: unknown): Array<{ scheme: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const identifiers: Array<{ scheme: string; value: string }> = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.scheme === 'string' && typeof record.value === 'string') {
      identifiers.push({ scheme: record.scheme, value: record.value });
    }
  }
  return identifiers.length > 0 ? identifiers : null;
}

/** 单行 → ProviderCompanyRecord（§3.9.13 投影规则；domain 仅当源自带，注册库通常为 null）。 */
export function toProviderCompanyRecord(row: RegistryQueryRow): ProviderCompanyRecord {
  const identifier: CompanyIdentifier = { scheme: row.scheme, value: row.regNumber };
  const domain = row.website ? normalizeDomain(row.website) : null;
  const employeeCount = employeeCountForBand(row.employeeBand);
  return {
    externalId: `${row.scheme}:${row.regNumber}`,
    name: row.name,
    ...(domain ? { domain } : {}),
    country: row.country,
    ...(row.region ? { region: row.region } : {}),
    ...(employeeCount !== undefined ? { employeeCount } : {}),
    identifier,
    license: row.sourceFrame?.licence,
    attributes: {
      registry: {
        scheme: row.scheme,
        regNumber: row.regNumber,
        status: row.status,
        legalForm: row.legalForm,
        nace: row.nace,
        naceVersion: row.naceVersion,
        employeeBand: row.employeeBand,
        identifiers: identifiersOf(row.identifiers),
        frameKey: row.sourceFrame?.frameKey ?? null,
        snapshotId: row.lastSnapshotId,
      },
    },
  };
}

/** 执行一次本地 frame 查询（只读；app_user 即可读平台表）。 */
export async function queryRegistryEntities(
  prisma: PrismaClient,
  filters: RegistryQueryFilters,
): Promise<ProviderCompanyRecord[]> {
  const query = buildRegistryEntityQuery(filters);
  const rows = (await prisma.registryEntity.findMany({
    where: query.where,
    orderBy: query.orderBy,
    take: query.take,
    select: REGISTRY_QUERY_SELECT,
  })) as RegistryQueryRow[];
  return rows.map(toProviderCompanyRecord);
}
