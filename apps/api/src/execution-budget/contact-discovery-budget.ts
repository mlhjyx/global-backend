/**
 * D7 联系人阶段独立预算账户（设计稿 docs/superpowers/plans/2026-10-31-contact-discovery.md §5.3d）。
 *
 * 联系人发现（含社媒与邮箱补全）用自己一侧的额度，不挤占 run 的查询/画像/评分预算：
 * 每轮按公司数派生一个子账户键（scope=contact.discovery、按 run 命名），
 * 上限 = min(每家公司上限 × 本轮公司数, 整轮上限)。D5 于 2026-11-02 重校为
 * 每家 20¢、整轮封顶 $2（见下方常量注释）；旧的「8 家 $0.50、每家 $0.0625」口径已废止。
 * 撞自己的上限即停；实际花费仍按账本用量结算。
 *
 * 🔴 账本事实：workspace grant 的 authority 只允许开一本 `tool_budget_account`
 * （`open_authorized_tool_budget_v1` 对第二个 accountKey 直接抛 AUTHORITY_EXHAUSTED），且
 * `execution_budget_*` 是平台表，App 不写。因此这里**不新开账本行**：子账户是同一 run 账户内的
 * 派生记账键，花费用账本剩余额的窗口差值计量（`observe`）。真正独立的第二本账需要 gain-saas
 * 以新 purpose 签发 Grant（仓外，见 PR「未做」）。
 *
 * 计量粒度是 adapter / 公司（每次模型或工具调用后账本都会落账）：单次调用最多让子账户小幅越过
 * 上限，上限之后的工作绝不会启动。计量是单调高水位：阶段开始前就持有、阶段中才释放的预留不会把
 * 已观察到的花费抹掉（只会更保守）。注意 Temporal 重试会重新取基线（每 attempt 一份上限）；
 * 重试对已结算操作走账本重放（不重复计费），残留行按 remnant 吸收（#728 纪律）——单 run 的
 * 实际联系人花费通常仍是单份上限，并始终受 run 账户剩余额约束。
 */
import { assertMicrousd } from '../tools/microusd';

export const CONTACT_DISCOVERY_BUDGET_SCOPE = 'contact.discovery' as const;

/**
 * D5 于 2026-11-02 重校（产品负责人拍板「覆盖全部 fit=match 公司」）：
 * 实测单家 ≈$0.09（官网 4 页 + 社媒 + 邮箱探测），单家上限 20¢、整轮上限 $2；
 * 整轮上限 = min(公司数 × 20¢, $2)，覆盖典型 8–16 家。旧的「8 家 $0.50」口径废止。
 */
export const CONTACT_DISCOVERY_RUN_CAP_MICROUSD = 2_000_000n;
export const CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD = 200_000n;

/** Same bound the ledger's account/operation keys use. */
const MAX_ACCOUNT_KEY_LENGTH = 200;

export function deriveContactDiscoveryAccountKey(runId: string): string {
  if (
    typeof runId !== 'string' ||
    runId.trim().length === 0 ||
    [...runId].some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new TypeError(
      'runId must be a non-empty printable string',
    );
  }
  const accountKey = `${CONTACT_DISCOVERY_BUDGET_SCOPE}:${runId}`;
  if (accountKey.length > MAX_ACCOUNT_KEY_LENGTH) {
    throw new TypeError(
      `contact discovery account key exceeds ${MAX_ACCOUNT_KEY_LENGTH} characters`,
    );
  }
  return accountKey;
}

/** 上限动态计算：min(公司数 × 每家上限, 整轮上限)。 */
export function contactDiscoveryCapMicrousd(companyCount: number): bigint {
  if (!Number.isSafeInteger(companyCount) || companyCount < 0) {
    throw new TypeError('companyCount must be a non-negative safe integer');
  }
  const scaled = BigInt(companyCount) * CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD;
  return scaled < CONTACT_DISCOVERY_RUN_CAP_MICROUSD ? scaled : CONTACT_DISCOVERY_RUN_CAP_MICROUSD;
}

/**
 * 联系人阶段的子账户守卫。`observe` 把账本（run 账户）的最新剩余额喂进来，返回子账户已花费；
 * `exhausted` 一旦为真，后续 adapter/公司一律不再启动。
 */
export interface ContactDiscoveryBudgetGuard {
  readonly accountKey: string;
  readonly capMicrousd: bigint;
  observe(remainingMicrousd: bigint): bigint;
  exhausted(): boolean;
}

export interface ContactDiscoverySubBudget extends ContactDiscoveryBudgetGuard {
  readonly spentMicrousd: bigint;
}

export function createContactDiscoverySubBudget(input: {
  runId: string;
  companyCount: number;
  /** The run account's remaining microusd when the contact stage starts. */
  startRemainingMicrousd: bigint;
}): ContactDiscoverySubBudget {
  const start = assertMicrousd('startRemainingMicrousd', input.startRemainingMicrousd);
  const accountKey = deriveContactDiscoveryAccountKey(input.runId);
  const capMicrousd = contactDiscoveryCapMicrousd(input.companyCount);
  // High-water mark: reservations held at stage start can be released (or settle below their
  // reservation) during the stage and push the remaining back above `start`. Erasing the spend
  // already observed would reopen the whole cap, so the sub account only ever grows.
  let spent = 0n;
  return Object.freeze({
    accountKey,
    capMicrousd,
    get spentMicrousd(): bigint {
      return spent;
    },
    observe(remainingMicrousd: bigint): bigint {
      if (remainingMicrousd < start && start - remainingMicrousd > spent) {
        spent = start - remainingMicrousd;
      }
      return spent;
    },
    exhausted(): boolean {
      return spent >= capMicrousd;
    },
  });
}
