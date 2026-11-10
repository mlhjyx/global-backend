/**
 * Q33② 兜底配额：discovery run 总池帽（`DISCOVERY_RUN_POOL_CAP`，默认 500）。
 *
 * 获客挖掘 vNext（2026-11-10 计划 §3 W1）：`DISCOVERY_UNCAPPED=on` 时本帽退为
 * 防爆安全界——未配置时默认取解析上界（10 万，余额先于它耗尽）；显式 env 与
 * `off` 语义不变。唯一收紧条件仍是执行预算账户（Grant cap = min(估算包络, 客户可用余额)）。
 *
 * 物化发生在全部查询之后（workflow：query stage → canonicalizeRun），查询期看不到已物化数，
 * 所以闸门只落在 governed 物化批内：批事务先 seed 本 run 已入池公司（outcome 表 distinct
 * `canonical_company_id`），逐候选写前判定——已在池的公司放行（不增长），会新增公司且池已满
 * 的行跳过，落 `NOT_CANONICALIZABLE` + `RUN_POOL_CAP_REACHED`（设计 §4.1）。
 *
 * 设计：docs/superpowers/plans/2026-11-05-run-pool-cap.md。
 */
import {
  ambientProcessEnv,
  discoveryUncappedEnabled,
} from './execution-envelope';

export const DEFAULT_RUN_POOL_CAP = 500;
/** 上限本身只做防御性封顶；正常配置远小于此值。 */
export const RUN_POOL_CAP_MAX = 100_000;
/** 去帽模式未配置 `DISCOVERY_RUN_POOL_CAP` 时的默认防爆界：等于解析上界。 */
export const UNCAPPED_RUN_POOL_CAP = RUN_POOL_CAP_MAX;
/** outcome 的 `NOT_CANONICALIZABLE` 原因：本 run 的公司池已达上限，跳过该公司的物化。 */
export const RUN_POOL_CAP_REACHED_REASON = 'RUN_POOL_CAP_REACHED';

export type RunPoolCapSetting =
  | Readonly<{ mode: 'off' }>
  | Readonly<{ mode: 'enforce'; cap: number }>;

/** 未配置/畸形值时的回退值：off 模式 500；去帽模式取防爆界（失败方向仍取「设闸」）。 */
export function defaultRunPoolCap(
  env: NodeJS.ProcessEnv = ambientProcessEnv(),
): number {
  return discoveryUncappedEnabled(env)
    ? UNCAPPED_RUN_POOL_CAP
    : DEFAULT_RUN_POOL_CAP;
}

/**
 * `off` 关闭闸门；纯十进制正整数按原值启用；未设置或任何非法值回退默认
 * （off 模式 500 / 去帽模式 10 万）——失败方向取「仍然设闸」，畸形配置不会静默放开配额。
 */
export function parseRunPoolCap(
  raw: string | undefined = ambientProcessEnv().DISCOVERY_RUN_POOL_CAP,
  env: NodeJS.ProcessEnv = ambientProcessEnv(),
): RunPoolCapSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'off') return Object.freeze({ mode: 'off' });
  if (/^\d+$/u.test(value)) {
    const cap = Number(value);
    if (Number.isSafeInteger(cap) && cap >= 1 && cap <= RUN_POOL_CAP_MAX) {
      return Object.freeze({ mode: 'enforce', cap });
    }
  }
  return Object.freeze({ mode: 'enforce', cap: defaultRunPoolCap(env) });
}

/** 批内闸门：seed 的 run 池成员 + 本批已放行成员。 */
export interface RunPoolGate {
  /** 该公司是否已在本 run 池内（重复命中不增长）。 */
  has(companyId: string): boolean;
  /** 池是否已达上限。 */
  full(): boolean;
  /** 记录一家已放行写入的公司。 */
  note(companyId: string): void;
}

export function createRunPoolGate(cap: number, seeded: Iterable<string>): RunPoolGate {
  const members = new Set<string>();
  for (const id of seeded) {
    if (typeof id === 'string' && id.length > 0) members.add(id);
  }
  return {
    has: (companyId) => members.has(companyId),
    full: () => members.size >= cap,
    note: (companyId) => {
      members.add(companyId);
    },
  };
}

/**
 * 写前判定：`companyId` 已知时先看是否已在池（在池 → 放行）；公司 id 未知（新建）或未入池
 * 的既有公司，池满即阻塞。调用方只在「本来会 CANONICALIZED」的路径上询问，终态
 * （suppressed/restricted/expired/隔离/无身份）不经过这里。
 */
export function poolCapBlocks(gate: RunPoolGate, companyId: string | null): boolean {
  if (companyId !== null && gate.has(companyId)) return false;
  return gate.full();
}
