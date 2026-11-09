/**
 * P3 J02（设计 §4.3.5.1 / §4.3.9 W1–W2）：company pipeline 失败分类器。
 *
 * 目标：把 `COMPANY_PIPELINE_FAILED` / `QUICK_JUDGE_FAILED` 两个聚合码拆成
 * `failure-codes.ts` 里版本化的 cause（+ 其 stage），让 `discovery_company_job.last_error_code`
 * 与 `run_event` payload 100% 可归因（E4-2）。
 *
 * 为什么这个文件必须 **workflow 安全**：分类发生在 workflow 的 catch 里（W1），
 * workflow bundle 不能引入 node 内置模块。因此本文件只允许：
 *   - import `../discovery/judgment/failure-codes`（纯数据 + 查表）；
 *   - 纯函数遍历错误对象（Object/Reflect 级操作，与 `discovery.run-failure.ts` 同款）。
 * **禁止**在这里 import `@temporalio/activity`、database、model-gateway 等有副作用的模块；
 * activity 侧的包装逻辑在 `pipeline-failure-activity.ts`。
 *
 * 真实错误到达 workflow 时的形状（按 `@temporalio/common` 1.24 与
 * `DiagnosticFailureConverter` 的实际行为）：
 *   - 活动抛出的普通 Error 会被 worker 的 `DiagnosticFailureConverter` 抹掉类名与消息
 *     （非控制面错误一律 message=`Temporal execution failed`），workflow 侧只剩
 *     `ActivityFailure → cause`。所以 **activity 必须在边界先把错误换成
 *     `ApplicationFailure(type=<failure code>)`**（`pipeline-failure-activity.ts`），
 *     `applicationFailureInfo.type` 是唯一能穿过该转换器的稳定字段；
 *   - 控制面错误（`ExecutionControlError`、预算类）经转换器后 message 变成
 *     `EXECUTIONCONTROLERROR` 或两个预算哨兵，本分类器按同一套 control token 规则识别，
 *     保证它们 **永远不会** 被记成 `PROVIDER_*`（设计 §4.3.9 W2）。
 *
 * 本分类器能产出的码是 `FAILURE_CODES` 的子集：证据/硬门/输入类失败码由判定层
 * （fit-judge、gates、evidence-validate）直接写入，不经过 pipeline 异常路径；
 * 但任何 `ApplicationFailure(type=<码>)` 都会在第 1 条规则原样透传，所以 26+ 个码
 * 全部可达。
 */
import {
  FAILURE_CODES,
  isFailureCode,
  type FailureCode,
  type FailureStage,
} from '../discovery/judgment/failure-codes';

export interface PipelineFailureClassification {
  /** 版本化 cause（`failure-codes.ts` 闭集）。 */
  readonly code: FailureCode;
  /** cause 对应的 stage（闭集），写入 `run_event.payload.failureStage`。 */
  readonly failureStage: FailureStage;
}

const MAX_CAUSE_DEPTH = 8;
const MAX_PROTOTYPE_DEPTH = 8;
const MAX_TOKEN_LENGTH = 256;
/** provider HTTP 错误类的 message 形状（`${provider} ${model}: HTTP ${status}`）。 */
const HTTP_STATUS_IN_MESSAGE = /\bHTTP (\d{3})\b/u;
const LEADING_TOKEN = /^([A-Z][A-Z0-9_]{2,127})(?::|$)/u;

/**
 * 数据属性读取：own（或沿原型链）上的 data descriptor 才有值；
 * accessor/getter 视为不可读（错误对象来自活动边界，必须按数据处理，绝不执行代码）。
 */
function dataProperty(value: object, key: string, inherited: boolean): unknown {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth <= MAX_PROTOTYPE_DEPTH; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        return 'value' in descriptor ? descriptor.value : undefined;
      }
      if (!inherited) return undefined;
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    /* 敌意对象：按无该字段处理。 */
  }
  return undefined;
}

function stringProperty(value: object, key: string, inherited = false): string | undefined {
  const field = dataProperty(value, key, inherited);
  return typeof field === 'string' ? field : undefined;
}

/**
 * 控制面 token 规则：与 `execution-budget/execution-control-error.ts` 的 `controlToken`
 * 同一集合（该文件是共享分类器，不能改；本文件在 workflow 侧按 token 复刻并以单测
 * 锁定两者一致）。命中返回原 token 供细分类，未命中返回 undefined。
 */
export function controlPlaneToken(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH
  ) {
    return undefined;
  }
  const token = value.toUpperCase();
  if (
    token === 'EXECUTIONCONTROLERROR' ||
    token.includes('EXECUTION_BUDGET_') ||
    token.includes('EXECUTIONBUDGET') ||
    token.includes('BUDGET_') ||
    (token.includes('BUDGET') && token.includes('ERROR')) ||
    token.includes('BUDGETOPERATIONREPLAY') ||
    token.includes('BUDGETSTORE') ||
    token.includes('BUDGETEXCEEDED') ||
    token.includes('PAIDOPERATIONUNKNOWN') ||
    token.includes('DOMAIN_ACK_') ||
    token.includes('DOMAINACK') ||
    token.includes('DURABLE_EXECUTION_RECEIPT_') ||
    token.includes('DURABLEEXECUTIONRECEIPT') ||
    token.includes('GENERIC_OPERATION_ARTIFACT_') ||
    token.includes('GENERICOPERATIONARTIFACT') ||
    token.includes('ARTIFACTSTORAGEERROR') ||
    token.includes('PLATFORM_EGRESS_') ||
    token.includes('DURABLE_REPLAY_') ||
    token.includes('_REPLAY_')
  ) {
    return value;
  }
  return undefined;
}

/** 控制面 token → 细分失败码（预算/租约/技能各自有专属码，其余归控制面拒绝）。 */
function controlPlaneFailure(token: string): FailureCode {
  const normalized = token.toUpperCase();
  if (normalized.includes('LEASE')) return 'LEASE_LOST';
  if (normalized.includes('SKILL')) return 'SKILL_UNAVAILABLE';
  if (normalized.includes('EXCEEDED')) return 'BUDGET_EXCEEDED';
  if (normalized.includes('BUDGET') || normalized.includes('AUTHORITY')) {
    return 'BUDGET_AUTHORITY_NOT_READY';
  }
  return 'CONTROL_PLANE_REJECTED';
}

function httpStatusFailure(status: unknown): FailureCode | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  if (status === 429) return 'PROVIDER_HTTP_429';
  if (status === 402) return 'PROVIDER_HTTP_402';
  if (status === 401 || status === 403) return 'PROVIDER_HTTP_401_403';
  if (status >= 500 && status <= 599) return 'PROVIDER_HTTP_5XX';
  return undefined;
}

/** `ProviderHttpError.status` 在活动边界内可用；越界后只剩 message 里的 HTTP 状态。 */
function providerHttpFailure(
  status: unknown,
  message: string | undefined,
): FailureCode | undefined {
  const byStatus = httpStatusFailure(status);
  if (byStatus) return byStatus;
  const match = message ? HTTP_STATUS_IN_MESSAGE.exec(message) : null;
  return match ? httpStatusFailure(Number(match[1])) : undefined;
}

/** `ProviderOutputError.reasonCode`（或其 message 的前导 CODE token）→ 契约失败码。 */
const OUTPUT_REASON_RULES: ReadonlyArray<readonly [string, FailureCode]> = [
  ['CONTENT_FILTERED', 'MODEL_REFUSAL'],
  ['REFUSAL', 'MODEL_REFUSAL'],
  ['TRUNCATED', 'OUTPUT_TRUNCATED'],
  ['NOT_JSON', 'OUTPUT_NOT_JSON'],
  ['SCHEMA_INVALID', 'OUTPUT_SCHEMA_INVALID'],
  ['REPAIR', 'OUTPUT_SCHEMA_INVALID'],
  ['TASK_OUTPUT_REJECTED', 'OUTPUT_SCHEMA_INVALID'],
  ['EMPTY', 'OUTPUT_NOT_JSON'],
  ['ENUM', 'ENUM_DRIFT'],
];

function outputReasonFailure(token: string | undefined): FailureCode | undefined {
  if (!token) return undefined;
  const normalized = token.toUpperCase();
  for (const [pattern, code] of OUTPUT_REASON_RULES) {
    if (normalized.includes(pattern)) return code;
  }
  return undefined;
}

function leadingToken(message: string | undefined): string | undefined {
  if (!message) return undefined;
  return LEADING_TOKEN.exec(message)?.[1];
}

/** 单个 cause 节点的分类；无法判定返回 undefined（继续沿 cause 链下钻）。 */
function failureCodeForNode(node: object): FailureCode | undefined {
  const type = stringProperty(node, 'type');
  const code = stringProperty(node, 'code');
  const name = stringProperty(node, 'name', true);
  const reasonCode = stringProperty(node, 'reasonCode');
  const reason = stringProperty(node, 'reason');
  const message = stringProperty(node, 'message');

  // 1) 已带稳定失败码的 ApplicationFailure（activity 边界包装的产物）原样透传。
  for (const token of [type, code, name]) {
    if (isFailureCode(token)) return token;
  }

  // 2) 控制面：class 名/token 先行，绝不落到 provider 分支（设计 §4.3.9 W2）。
  const controlToken =
    controlPlaneToken(code) ?? controlPlaneToken(type) ?? controlPlaneToken(message);
  if (controlToken) return controlPlaneFailure(controlToken);
  if (name === 'ExecutionControlError') return 'CONTROL_PLANE_REJECTED';

  // 3) 预算类（失败码 v1 时代就存在的类名，防 control token 规则改动后漏认）。
  if (name === 'BudgetExceededError') return 'BUDGET_EXCEEDED';
  if (
    name === 'BudgetOperationReplayError' ||
    name === 'BudgetStoreUnavailableError' ||
    name === 'BudgetAccountUnavailableError' ||
    name === 'BudgetUnsettledOperationsError'
  ) {
    return 'BUDGET_AUTHORITY_NOT_READY';
  }

  // 4) model-gateway 真实错误类。
  if (name === 'ProviderIdentityError') return 'PROVIDER_IDENTITY_MISMATCH';
  if (name === 'ProviderTransportError') return 'PROVIDER_TRANSPORT_FAILED';
  if (name === 'ProviderHttpError') {
    return (
      providerHttpFailure(dataProperty(node, 'status', false), message) ??
      'UNKNOWN_UPSTREAM'
    );
  }
  if (name === 'ProviderWireInFlightError') return 'LEASE_LOST';
  if (name === 'ProviderSettlementError') {
    // 结算/账本故障（MODEL_SETTLEMENT_*）：不是模型输出问题，按未知上游显性上报。
    return 'UNKNOWN_UPSTREAM';
  }
  if (
    name === 'ProviderOutputError' ||
    name === 'TaskOutputValidationError' ||
    name === 'ProviderOutputUnresolvedError' ||
    name === 'ExternalActionDeniedError'
  ) {
    return (
      outputReasonFailure(reasonCode) ??
      outputReasonFailure(leadingToken(message)) ??
      'UNKNOWN_UPSTREAM'
    );
  }

  // 5) 技能运行时 / 抓取 / Temporal 超时 / DB 冲突。
  if (
    name === 'SkillUnavailableError' ||
    (typeof reason === 'string' && reason.toUpperCase().includes('SKILL'))
  ) {
    return 'SKILL_UNAVAILABLE';
  }
  if (name === 'TimeoutFailure' || name === 'TimeoutError') return 'PROVIDER_TIMEOUT';
  if (dataProperty(node, 'timeoutType', false) !== undefined) return 'PROVIDER_TIMEOUT';
  if (name === 'PrismaClientKnownRequestError') {
    return code === 'P2034' || code === 'P2028' ? 'DB_TX_CONFLICT' : undefined;
  }
  if (name === 'EgressBlockedError') return 'RETRIEVER_FETCH_FAILED';

  // 6) 只剩消息/类型 token 的失败（含 DiagnosticFailureConverter 的脱敏哨兵）。
  return (
    (isFailureCode(leadingToken(message)) ? (leadingToken(message) as FailureCode) : undefined) ??
    outputReasonFailure(leadingToken(message))
  );
}

/**
 * 沿 `cause` 链把 Temporal 失败（ActivityFailure → ApplicationFailure/TimeoutFailure → …）
 * 或普通 Error 解析成版本化失败码。未知一律 `UNKNOWN_UPSTREAM`（设计：不得静默吞掉）。
 */
export function classifyPipelineFailure(error: unknown): PipelineFailureClassification {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) break;
    visited.add(current);
    const code = failureCodeForNode(current);
    if (code) {
      return { code, failureStage: FAILURE_CODES[code].stage };
    }
    current = dataProperty(current, 'cause', false);
  }
  return {
    code: 'UNKNOWN_UPSTREAM',
    failureStage: FAILURE_CODES.UNKNOWN_UPSTREAM.stage,
  };
}
