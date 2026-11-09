/**
 * ch01 PR-11（离线部分）：frame 快照适配器端口与状态机驱动。
 *
 * frame 的定义与登记见 docs/metrics/frames/frame-registry.v1.json（PR-10）；
 * 本端口只负责「把某个已登记的 frame 拉取成一次带哈希的快照」：
 *
 *   FETCHING → PARSING → VALIDATING → READY | QUARANTINED | FAILED
 *
 * 状态机语义（docs/metrics/frame-registry.md §3）：
 *  - READY：原始快照已取到，解析结果通过校验，可进入抽样/CR；
 *  - QUARANTINED：取到并解析了，但校验发现数据质量问题——保留快照，不进下游；
 *  - FAILED：拉取/解析/驱动层错误，没有可用的快照。
 *
 * 端口不碰数据库、不发网络请求（fetch 由调用方注入），也不做抽样核验
 * （每个 frame 的 200 条人工抽样是接入流程，不是适配器职责）。
 *
 * A 方案预留（2026-11-09 用户拍板）：registry_frame 以 local_query 血缘变体接入
 * registry（开关默认关），P2 实施血缘契约后由 producer=registry.query 的本地
 * 回执接入。本 PR 只有类型占位（LocalQueryFrameLineageReceipt），不实现、
 * 不 import 任何 discovery/registry 血缘文件。
 */

export type FrameSnapshotState =
  | "FETCHING"
  | "PARSING"
  | "VALIDATING"
  | "READY"
  | "QUARANTINED"
  | "FAILED";

/** 适配器的自报身份；frameKey 必须与 frame-registry.v1.json 的登记一致。 */
export interface FrameAdapterIdentity {
  readonly frameKey: string;
  /** 解析器版本；参与快照元数据，parser 变更必须升版本。 */
  readonly parserVersion: string;
}

/** 最小 HTTP 形状（与 globalThis.fetch 的 Response 子集兼容），便于注入和测试。 */
export interface FrameFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  bytes(): Promise<Uint8Array>;
}

export type FrameFetch = (url: string) => Promise<FrameFetchResponse>;

export interface FrameAdapterContext {
  /** 请求的快照时点（ISO-8601）；同一 asOf + 同一数据源必须得到同一快照。 */
  readonly asOf: string;
  /** 注入时钟：快照元数据里的 fetchedAt 走这里，测试可确定性复现。 */
  now: () => Date;
  /** 真实适配器用；fixture 适配器不需要。 */
  readonly fetch?: FrameFetch;
  /** 原始载荷安全上限，超出即 FAILED（FETCH_TOO_LARGE）。 */
  readonly maxBytes?: number;
}

/** 一次快照的原始元数据（对应 frame_snapshot 的元数据列，PR-12 落表）。 */
export interface RawFrameSnapshot {
  readonly frameKey: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  /** 原始对象位置（对象存储 URI 或 fixture:// 标识）；DB 只存元数据与引用。 */
  readonly rawObjectUri: string;
  readonly rowCount: number;
  /** 原始载荷的 sha256（hex，小写）。 */
  readonly contentHash: string;
  readonly parserVersion: string;
}

/** 解析后的实体引用。属性里不允许放个人联系方式（邮箱/电话明文）。 */
export interface FrameEntityRef {
  /** frame 自身的硬键（注册号/UID/ABN 等），在快照内唯一。 */
  readonly entityKey: string;
  readonly name: string;
  /** ISO-3166-1 alpha-2，或 unknown。 */
  readonly country: string;
  /** 原始登记状态（不做归一化，归一化在下游）。 */
  readonly status?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FrameExclusionSummary {
  readonly total: number;
  readonly byReason: Readonly<Record<string, number>>;
}

/** 解析结果：纳入实体 + 排除计数。entities + exclusions.total === rowCount。 */
export interface FrameParseResult {
  readonly rowCount: number;
  readonly entities: readonly FrameEntityRef[];
  readonly exclusions: FrameExclusionSummary;
}

export interface FrameValidationCheck {
  readonly code: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface FrameValidationReport {
  /** READY 进下游；QUARANTINED 保留快照但不进抽样/CR。 */
  readonly state: "READY" | "QUARANTINED";
  readonly checks: readonly FrameValidationCheck[];
}

export interface FrameAdapter {
  readonly identity: FrameAdapterIdentity;
  fetchSnapshot(ctx: FrameAdapterContext): Promise<RawFrameSnapshot>;
  parse(raw: RawFrameSnapshot, ctx: FrameAdapterContext): Promise<FrameParseResult>;
  validate(
    parsed: FrameParseResult,
    raw: RawFrameSnapshot,
    ctx: FrameAdapterContext,
  ): Promise<FrameValidationReport>;
}

/** 适配器路径的血缘：随快照一起交给下游/落表，证明数据来自哪次拉取。 */
export interface FrameAdapterLineage {
  readonly producer: "frame.adapter";
  readonly frameKey: string;
  readonly parserVersion: string;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly contentHash: string;
  readonly rowCount: number;
}

/**
 * A 方案预留位（仅类型，未实现）：
 * registry_frame 以 local_query 血缘变体接入 registry，开关默认关；P2 血缘
 * 契约落地后，由 producer=registry.query 的本地回执替代/并行于 frame.adapter
 * 血缘。`receipt` 的形状由 P2 契约钉死，本 PR 故意保持不透明。
 */
export interface LocalQueryFrameLineageReceipt {
  readonly producer: "registry.query";
  readonly frameKey: string;
  readonly createdAt: string;
  readonly receipt: unknown;
}

export type FrameSnapshotLineage = FrameAdapterLineage | LocalQueryFrameLineageReceipt;

export interface FrameSnapshotFailure {
  readonly code: string;
  readonly message: string;
}

export interface FrameSnapshotBundle {
  readonly frameKey: string;
  readonly state: FrameSnapshotState;
  /** 实际走过的状态序列（含最终态），用于审计/落表断言。 */
  readonly transitions: readonly FrameSnapshotState[];
  readonly raw?: RawFrameSnapshot;
  readonly parse?: FrameParseResult;
  readonly validation?: FrameValidationReport;
  readonly failure?: FrameSnapshotFailure;
  readonly lineage?: FrameAdapterLineage;
}

const CONTENT_HASH = /^[0-9a-f]{64}$/;

function isIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 驱动层对快照元数据的最小结构校验（与适配器实现无关）。 */
export function validateRawSnapshot(raw: RawFrameSnapshot, identity: FrameAdapterIdentity): string | null {
  if (raw.frameKey !== identity.frameKey) {
    return `frameKey ${raw.frameKey} does not match adapter identity ${identity.frameKey}`;
  }
  if (raw.parserVersion !== identity.parserVersion) {
    return `parserVersion ${raw.parserVersion} does not match adapter identity ${identity.parserVersion}`;
  }
  if (!/^https?:\/\/|^fixture:\/\//.test(raw.sourceUrl)) {
    return `sourceUrl must be http(s):// or fixture://, got ${raw.sourceUrl}`;
  }
  if (!isIsoTimestamp(raw.fetchedAt)) return `fetchedAt must be an ISO-8601 UTC timestamp, got ${raw.fetchedAt}`;
  if (!Number.isInteger(raw.rowCount) || raw.rowCount < 0) return `rowCount must be a non-negative integer`;
  if (!CONTENT_HASH.test(raw.contentHash)) return `contentHash must be a lowercase sha256 hex digest`;
  return null;
}

/**
 * 按 FETCHING → PARSING → VALIDATING → READY|QUARANTINED|FAILED 驱动一次快照。
 * 驱动只做结构校验与异常封装，业务校验在 adapter.validate 里。
 */
export async function runFrameAdapter(
  adapter: FrameAdapter,
  ctx: FrameAdapterContext,
): Promise<FrameSnapshotBundle> {
  const transitions: FrameSnapshotState[] = ["FETCHING"];
  const fail = (code: string, message: string): FrameSnapshotBundle => ({
    frameKey: adapter.identity.frameKey,
    state: "FAILED",
    transitions: [...transitions, "FAILED"],
    failure: { code, message },
  });
  let raw: RawFrameSnapshot;
  try {
    raw = await adapter.fetchSnapshot(ctx);
  } catch (error) {
    return fail("FETCH_FAILED", errorMessage(error));
  }
  const snapshotProblem = validateRawSnapshot(raw, adapter.identity);
  if (snapshotProblem) return fail("SNAPSHOT_INVALID", snapshotProblem);
  transitions.push("PARSING");
  let parsed: FrameParseResult;
  try {
    parsed = await adapter.parse(raw, ctx);
  } catch (error) {
    return fail("PARSE_FAILED", errorMessage(error));
  }
  if (parsed.rowCount !== raw.rowCount) {
    return fail(
      "PARSE_ROW_COUNT_MISMATCH",
      `parser reported ${parsed.rowCount} rows, snapshot has ${raw.rowCount}`,
    );
  }
  transitions.push("VALIDATING");
  let report: FrameValidationReport;
  try {
    report = await adapter.validate(parsed, raw, ctx);
  } catch (error) {
    return fail("VALIDATION_ERROR", errorMessage(error));
  }
  const finalState: FrameSnapshotState = report.state === "READY" ? "READY" : "QUARANTINED";
  transitions.push(finalState);
  const lineage: FrameAdapterLineage = {
    producer: "frame.adapter",
    frameKey: raw.frameKey,
    parserVersion: raw.parserVersion,
    sourceUrl: raw.sourceUrl,
    fetchedAt: raw.fetchedAt,
    contentHash: raw.contentHash,
    rowCount: raw.rowCount,
  };
  const bundle: FrameSnapshotBundle = {
    frameKey: adapter.identity.frameKey,
    state: finalState,
    transitions,
    raw,
    parse: parsed,
    validation: report,
    lineage,
  };
  return bundle;
}
