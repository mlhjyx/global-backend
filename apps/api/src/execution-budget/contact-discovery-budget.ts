/**
 * D7 联系人阶段独立预算账户（设计稿 docs/superpowers/plans/2026-10-31-contact-discovery.md §5.3d）。
 *
 * 联系人发现（含社媒与邮箱补全）用自己一侧的额度，不挤占 run 的查询/画像/评分预算：
 * 每轮按公司数派生一个子账户键（scope=contact.discovery、按 run 命名），上限 = 每家公司上限 ×
 * 本轮公司数，默认对齐 D5（$0.50 / 8 家 ⇒ 每家 $0.0625 = 6 页 × $0.01/页）。
 * 撞自己的上限即停；实际花费仍按账本用量结算。
 *
 * 🔴 账本事实：workspace grant 的 authority 只允许开一本 `tool_budget_account`
 * （`open_authorized_tool_budget_v1` 对第二个 accountKey 直接抛 AUTHORITY_EXHAUSTED），且
 * `execution_budget_*` 是平台表，App 不写。因此这里**不新开账本行**：子账户是同一 run 账户内的
 * 派生记账键，花费用账本剩余额的窗口差值计量（`observe`）。真正独立的第二本账需要 gain-saas
 * 以新 purpose 签发 Grant（仓外，见 PR「未做」）。
 *
 * 计量粒度是 adapter / 公司（每次模型或工具调用后账本都会落账）：单次调用最多让子账户小幅越过
 * 上限，上限之后的工作绝不会启动。
 */
export const CONTACT_DISCOVERY_BUDGET_SCOPE = 'contact.discovery' as const;

/** D5 的基准口径：8 家公司 $0.50（discoverRunContacts 的默认 Top N）。 */
export const DEFAULT_CONTACT_DISCOVERY_COMPANIES = 8 as const;
export const CONTACT_DISCOVERY_RUN_CAP_MICROUSD = 500_000n;
export const CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD =
  CONTACT_DISCOVERY_RUN_CAP_MICROUSD /
  BigInt(DEFAULT_CONTACT_DISCOVERY_COMPANIES);

/** D5 §六：每公司 ≤6 次 SMTP 探测（跨该公司全部联系人共享）。 */
export const MAX_RUN_EMAIL_PROBES_PER_COMPANY = 6 as const;

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

/** 上限动态计算：每家上限 × 本轮公司数（不写死单轮金额）。 */
export function contactDiscoveryCapMicrousd(companyCount: number): bigint {
  if (!Number.isSafeInteger(companyCount) || companyCount < 0) {
    throw new TypeError('companyCount must be a non-negative safe integer');
  }
  return BigInt(companyCount) * CONTACT_DISCOVERY_PER_COMPANY_CAP_MICROUSD;
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
  if (
    typeof input.startRemainingMicrousd !== 'bigint' ||
    input.startRemainingMicrousd < 0n
  ) {
    throw new TypeError('startRemainingMicrousd must be a non-negative bigint');
  }
  const accountKey = deriveContactDiscoveryAccountKey(input.runId);
  const capMicrousd = contactDiscoveryCapMicrousd(input.companyCount);
  // Reservations released above their settled charge can push the remaining back up; the sub
  // account never reports negative spend for that.
  const start = input.startRemainingMicrousd;
  let spent = 0n;
  return Object.freeze({
    accountKey,
    capMicrousd,
    get spentMicrousd(): bigint {
      return spent;
    },
    observe(remainingMicrousd: bigint): bigint {
      if (typeof remainingMicrousd !== 'bigint') {
        throw new TypeError('remainingMicrousd must be a bigint');
      }
      spent = remainingMicrousd >= start ? 0n : start - remainingMicrousd;
      return spent;
    },
    exhausted(): boolean {
      return spent >= capMicrousd;
    },
  });
}
