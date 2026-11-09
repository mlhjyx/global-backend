/**
 * ch01 PR-11（离线部分）：基于合成 fixture 的 FrameAdapter 实现。
 *
 * 用途有两个：
 *  1. 给状态机驱动与契约测试套件（frame-adapter.contract.ts）一个真实可跑的样本；
 *  2. 作为后续真实适配器（Companies House、Sirene、OffeneRegister…）的参考实现。
 *
 * 它不发起网络请求、不读数据库：把内存里的合成记录当作一次已拉取的快照。
 * 合成数据里没有个人联系方式（邮箱/电话），entityKey 是虚构的登记号。
 */
import { createHash } from "node:crypto";
import {
  FrameAdapter,
  FrameAdapterContext,
  FrameEntityRef,
  FrameParseResult,
  FrameValidationCheck,
  FrameValidationReport,
  RawFrameSnapshot,
} from "./frame-adapter";

export interface FixtureFrameRecord {
  readonly entityKey: string;
  readonly name: string;
  readonly country: string;
  readonly status?: string;
  readonly attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface FixtureFrameAdapterOptions {
  readonly frameKey: string;
  readonly records: readonly FixtureFrameRecord[];
  readonly sourceUrl?: string;
  readonly parserVersion?: string;
  /** 原始登记状态里视为「不在市场」的值；命中即排除并记 status_not_active。 */
  readonly excludedStatuses?: readonly string[];
}

const DEFAULT_EXCLUDED_STATUSES = ["dissolved", "inactive", "retired"];

/** 键排序的稳定序列化：同一记录集永远得到同一 contentHash。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

export function createFixtureFrameAdapter(options: FixtureFrameAdapterOptions): FrameAdapter {
  if (options.records.length === 0) throw new Error("fixture adapter needs at least one record");
  const excluded = new Set((options.excludedStatuses ?? DEFAULT_EXCLUDED_STATUSES).map((status) => status.toLowerCase()));
  const identity = {
    frameKey: options.frameKey,
    parserVersion: options.parserVersion ?? "fixture-frame-parser/v1",
  };
  const sourceUrl = options.sourceUrl ?? `fixture://${options.frameKey}/frame-fixture.v1.json`;

  return {
    identity,
    async fetchSnapshot(ctx: FrameAdapterContext): Promise<RawFrameSnapshot> {
      const payload = new TextEncoder().encode(
        stableStringify({ frameKey: identity.frameKey, records: options.records }),
      );
      if (ctx.maxBytes !== undefined && payload.byteLength > ctx.maxBytes) {
        throw new Error(`fixture payload ${payload.byteLength} bytes exceeds maxBytes ${ctx.maxBytes}`);
      }
      return {
        frameKey: identity.frameKey,
        sourceUrl,
        fetchedAt: ctx.now().toISOString(),
        rawObjectUri: `fixture://${identity.frameKey}/frame-fixture.v1.json`,
        rowCount: options.records.length,
        contentHash: createHash("sha256").update(payload).digest("hex"),
        parserVersion: identity.parserVersion,
      };
    },
    async parse(raw: RawFrameSnapshot): Promise<FrameParseResult> {
      const entities: FrameEntityRef[] = [];
      const byReason: Record<string, number> = {};
      for (const record of options.records) {
        if (record.status !== undefined && excluded.has(record.status.toLowerCase())) {
          byReason.status_not_active = (byReason.status_not_active ?? 0) + 1;
          continue;
        }
        entities.push({
          entityKey: record.entityKey,
          name: record.name,
          country: record.country,
          ...(record.status !== undefined ? { status: record.status } : {}),
          ...(record.attributes !== undefined ? { attributes: record.attributes } : {}),
        });
      }
      entities.sort((left, right) => left.entityKey.localeCompare(right.entityKey));
      return {
        rowCount: raw.rowCount,
        entities,
        exclusions: {
          total: Object.values(byReason).reduce((sum, count) => sum + count, 0),
          byReason,
        },
      };
    },
    async validate(parsed: FrameParseResult, raw: RawFrameSnapshot): Promise<FrameValidationReport> {
      const checks: FrameValidationCheck[] = [];
      const keys = new Set(parsed.entities.map((entity) => entity.entityKey));
      checks.push({
        code: "ENTITY_KEYS_UNIQUE",
        ok: keys.size === parsed.entities.length,
        detail: `${keys.size} unique keys for ${parsed.entities.length} entities`,
      });
      checks.push({
        code: "COUNTRY_CODES",
        ok: parsed.entities.every((entity) => /^([A-Z]{2}|unknown)$/.test(entity.country)),
      });
      checks.push({
        code: "ROW_COUNT_ACCOUNTED",
        ok: parsed.entities.length + parsed.exclusions.total === raw.rowCount,
        detail: `${parsed.entities.length} entities + ${parsed.exclusions.total} excluded = ${raw.rowCount}`,
      });
      checks.push({
        code: "HAS_ENTITIES",
        ok: parsed.entities.length > 0,
      });
      return {
        state: checks.every((check) => check.ok) ? "READY" : "QUARANTINED",
        checks,
      };
    },
  };
}

/** 读取 fixture JSON（`{frameKey, records}`）为适配器选项；调用方负责路径。 */
export function fixtureOptionsFromDocument(document: unknown): FixtureFrameAdapterOptions {
  if (typeof document !== "object" || document === null) {
    throw new Error("fixture document must be an object with frameKey and records");
  }
  const { frameKey, records, sourceUrl, parserVersion, excludedStatuses } = document as {
    frameKey?: unknown;
    records?: unknown;
    sourceUrl?: unknown;
    parserVersion?: unknown;
    excludedStatuses?: unknown;
  };
  if (typeof frameKey !== "string" || frameKey === "") throw new Error("fixture document needs frameKey");
  if (!Array.isArray(records) || records.length === 0) throw new Error("fixture document needs a non-empty records array");
  return {
    frameKey,
    records: records as FixtureFrameRecord[],
    ...(typeof sourceUrl === "string" ? { sourceUrl } : {}),
    ...(typeof parserVersion === "string" ? { parserVersion } : {}),
    ...(Array.isArray(excludedStatuses) ? { excludedStatuses: excludedStatuses as string[] } : {}),
  };
}
