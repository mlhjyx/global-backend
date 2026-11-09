import type {
  EmailVerificationProvider,
  EmailVerificationProviderResult,
} from './email-verification-provider';
import {
  resolveVerificationVotes,
  type ResolvedVerificationVotes,
  type VerificationVote,
} from './verification-policy';

/**
 * P1-06：验证瀑布编排（纯编排层，provider 无关）。
 *
 * 顺序与停止规则（计划 §2.3.5.1 / §2.3.5.2，按成本从低到高）：
 *  1) **主验**（providers[0]，通常 MillionVerifier）：invalid 是强否定 → 立即停（INVALID）；
 *     catch_all/unknown → 停（CATCH_ALL_RISKY / UNKNOWN，进重验或解析器队列）；
 *     供应商错误（error 非空）→ 停（UNKNOWN，24–72h 重试，不换家——换家也解决不了验证侧故障）。
 *  2) **二次确认**（providers[1]，通常 Emailable）：只在主验 VALID 时调用（双正规则——
 *     单验证器 positive 永不判 VALID）。
 *  3) **仲裁**（providers[2]，留位 ZeroBounce）：前两票未收敛（正负冲突、valid+risky/unknown）
 *     且还有预算时调用；矩阵照旧（负票优先、冲突未决绝不判 VALID）。
 *
 * 预算护栏：每个地址最多 maxCalls 次供应商调用（计划 §2.3.5.3：≤6，含解析与仲裁）、
 * 成本上限 maxCostMicrousd（达到即不再发起下一步）。调用前跑 beforeCall（限流/计数钩子）。
 *
 * 本模块不写库：调用方负责给每一步落事件账（每步一行，providerKey/成本/延迟各自记录），
 * 点状态用最终 resolved 的投票矩阵结果推进。
 */

export interface WaterfallStep {
  providerKey: string;
  result: EmailVerificationProviderResult;
  /** 该步之后依据累计投票得到的暂定裁决。 */
  provisional: ResolvedVerificationVotes;
}

export interface VerificationWaterfallInput {
  email: string;
  /** 本轮之前已记录的投票（同一地址/同一桶的部分恢复）——与本次 steps 一起进投票矩阵。 */
  priorVotes?: VerificationVote[];
  /** 有序 provider 列表：主验在前；空列表 = 无可用验证器（调用方应先过滤未配置者）。 */
  providers: EmailVerificationProvider[];
  /** 执行上下文：工具型验证器（SMTP 探测）用它过 broker 归账/合规/动作门；第三方 API 验证器忽略。 */
  workspaceId?: string;
  runId?: string;
  authorizeExternalAction?: () => Promise<boolean>;
  /** 每个地址最多供应商调用次数（默认 6）。 */
  maxCalls?: number;
  /** 本地址成本上限（微美元，累计）；达到即停止后续调用。 */
  maxCostMicrousd?: number;
  /** 每步调用前的钩子（限流/计数）；抛错 = fail-fast 中止本次瀑布（限流器故障不静默续跑）。 */
  beforeCall?: (provider: EmailVerificationProvider) => Promise<void> | void;
}

export type WaterfallStopReason =
  /** 主验 invalid（5xx 强否定）——不需要第二票。 */
  | 'invalid'
  /** 主验/二次确认后状态已收敛（VALID / CATCH_ALL_RISKY / UNKNOWN 且无更多可做）。 */
  | 'settled'
  /** 供应商侧错误（网络/限流/5xx），本轮不再继续。 */
  | 'provider_error'
  /** 调用次数或成本达到上限。 */
  | 'budget'
  /** provider 列表耗尽。 */
  | 'exhausted';

export interface VerificationWaterfallOutcome {
  resolved: ResolvedVerificationVotes;
  steps: WaterfallStep[];
  providerCalls: number;
  costMicrousd: number;
  stopReason: WaterfallStopReason;
}

const DEFAULT_MAX_CALLS = 6;

function votesFrom(steps: WaterfallStep[], priorVotes: VerificationVote[] = []): VerificationVote[] {
  return [
    ...priorVotes,
    ...steps.map((step) => ({
      providerKey: step.result.providerKey,
      state: step.result.state,
      catchAllClass: step.result.catchAllClass,
      acceptAll: step.result.acceptAll,
    })),
  ];
}

/** 单步结果 → 事件账 verdict 词表（供应商原始裁决，不是矩阵结果）。 */
export function eventVerdictFromProviderResult(
  result: EmailVerificationProviderResult,
): 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'error' {
  if (result.error !== null) return 'error';
  switch (result.state) {
    case 'VALID':
      return 'valid';
    case 'INVALID':
      return 'invalid';
    case 'CATCH_ALL_RISKY':
      return 'catch_all';
    case 'UNKNOWN':
      return 'unknown';
  }
}

export async function runVerificationWaterfall(
  input: VerificationWaterfallInput,
): Promise<VerificationWaterfallOutcome> {
  const maxCalls = Math.max(1, input.maxCalls ?? DEFAULT_MAX_CALLS);
  const steps: WaterfallStep[] = [];
  let costMicrousd = 0;
  let stopReason: WaterfallStopReason = 'exhausted';

  const callNext = async (index: number): Promise<VerificationWaterfallOutcome | null> => {
    const provider = input.providers[index];
    if (!provider) return null;
    if (steps.length >= maxCalls) {
      stopReason = 'budget';
      return { resolved: resolveVerificationVotes(votesFrom(steps, input.priorVotes)), steps, providerCalls: steps.length, costMicrousd, stopReason };
    }
    if (input.maxCostMicrousd !== undefined && costMicrousd >= input.maxCostMicrousd) {
      stopReason = 'budget';
      return { resolved: resolveVerificationVotes(votesFrom(steps, input.priorVotes)), steps, providerCalls: steps.length, costMicrousd, stopReason };
    }
    await input.beforeCall?.(provider);
    const result = await provider.verify({
      email: input.email,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.authorizeExternalAction
        ? { authorizeExternalAction: input.authorizeExternalAction }
        : {}),
    });
    costMicrousd += result.costMicrousd;
    const provisional = resolveVerificationVotes([
      ...votesFrom(steps, input.priorVotes),
      {
        providerKey: result.providerKey,
        state: result.state,
        catchAllClass: result.catchAllClass,
        acceptAll: result.acceptAll,
      },
    ]);
    steps.push({ providerKey: result.providerKey, result, provisional });
    return null;
  };

  // ① 主验（列表为空时直接以「无可用验证器」收敛为 UNKNOWN——调用方应已过滤）。
  if (input.providers.length === 0) {
    stopReason = 'exhausted';
    return {
      resolved: resolveVerificationVotes(input.priorVotes ?? []),
      steps,
      providerCalls: 0,
      costMicrousd,
      stopReason,
    };
  }
  const afterPrimary = await callNext(0);
  if (afterPrimary) return afterPrimary;
  const primary = steps[0];
  if (primary.result.error !== null) {
    return {
      resolved: primary.provisional,
      steps,
      providerCalls: steps.length,
      costMicrousd,
      stopReason: 'provider_error',
    };
  }
  // 强否定立即停：invalid 不需要第二票（矩阵亦然）；catch_all/unknown 也没有可做的下一步
  // （解析器 Truelist 尚未接入——接入后在此插入解析分支）。
  if (primary.result.state !== 'VALID') {
    return {
      resolved: primary.provisional,
      steps,
      providerCalls: steps.length,
      costMicrousd,
      stopReason: 'settled',
    };
  }

  // ② 二次确认：只有主验 VALID 才花钱换第二票。
  const afterSecondary = await callNext(1);
  if (afterSecondary) return afterSecondary;
  const secondary = steps[1];
  if (!secondary) {
    // 只有一家验证器：主验 VALID 也只能停在单票 UNKNOWN（双正规则），进重验队列。
    return {
      resolved: resolveVerificationVotes(votesFrom(steps, input.priorVotes)),
      steps,
      providerCalls: steps.length,
      costMicrousd,
      stopReason: 'exhausted',
    };
  }
  if (secondary.result.error !== null) {
    // 第二票失败：保留单票 → UNKNOWN（不得判 VALID），进重验队列。
    return {
      resolved: resolveVerificationVotes(votesFrom(steps, input.priorVotes)),
      steps,
      providerCalls: steps.length,
      costMicrousd,
      stopReason: 'provider_error',
    };
  }
  const afterTwoVotes = resolveVerificationVotes(votesFrom(steps, input.priorVotes));
  // 两票收敛（VALID 双正 / INVALID / accept_all 降层）→ 停。
  if (
    afterTwoVotes.state === 'VALID' ||
    afterTwoVotes.state === 'INVALID' ||
    afterTwoVotes.reason === 'accept_all_flag'
  ) {
    return {
      resolved: afterTwoVotes,
      steps,
      providerCalls: steps.length,
      costMicrousd,
      stopReason: 'settled',
    };
  }

  // ③ 仲裁（留位：ZeroBounce 接入后作为 providers[2] 生效；当前列表通常只有两家，到此即止）。
  const afterArbiter = await callNext(2);
  if (afterArbiter) return afterArbiter;
  return {
    resolved: resolveVerificationVotes(votesFrom(steps, input.priorVotes)),
    steps,
    providerCalls: steps.length,
    costMicrousd,
    stopReason: steps.length > 2 ? 'settled' : 'exhausted',
  };
}
