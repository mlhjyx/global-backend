/**
 * ch01 PR-11（离线部分）：可复用的 FrameAdapter 契约测试套件。
 *
 * 任何真实 frame 适配器（Companies House、Sirene、OffeneRegister…）接入时，
 * 在自己的 spec 里调一次：
 *
 *   defineFrameAdapterContract({
 *     name: "uk-companies-house-basic",
 *     createAdapter: () => new CompaniesHouseAdapter(...),
 *     makeContext: () => ({ asOf: "2026-11-09T00:00:00.000Z", now: () => new Date("2026-11-09T00:00:00.000Z") }),
 *   });
 *
 * 契约只约束端口语义（状态机、可复现性、行数对账、血缘、失败封装），不约束
 * 具体数据源字段。`makeContext` 必须给固定时钟，可复现性用同一 asOf 跑两次断言。
 */
import { describe, expect, it } from "vitest";
import {
  FrameAdapter,
  FrameAdapterContext,
  FrameSnapshotBundle,
  runFrameAdapter,
} from "./frame-adapter";

export interface FrameAdapterContractOptions {
  /** 适配器名称，只用于测试标题。 */
  readonly name: string;
  readonly createAdapter: () => FrameAdapter;
  /** 固定时钟 + 固定 asOf；fetch 若真实网络则不应在契约套件里使用。 */
  readonly makeContext: (overrides?: Partial<FrameAdapterContext>) => FrameAdapterContext;
  readonly expectations?: {
    /** 已知 fixture 至少会产出的实体数（防止解析器静默清空）。 */
    readonly minimumEntities?: number;
  };
}

function expectOk(bundle: FrameSnapshotBundle): void {
  expect(bundle.state, bundle.failure?.message).toBe("READY");
  expect(bundle.raw).toBeDefined();
  expect(bundle.parse).toBeDefined();
  expect(bundle.validation).toBeDefined();
}

export function defineFrameAdapterContract(options: FrameAdapterContractOptions): void {
  const context = () => options.makeContext();

  describe(`FrameAdapter contract: ${options.name}`, () => {
    it("reaches READY and records FETCHING → PARSING → VALIDATING → READY", async () => {
      const bundle = await runFrameAdapter(options.createAdapter(), context());
      expectOk(bundle);
      expect(bundle.transitions).toEqual(["FETCHING", "PARSING", "VALIDATING", "READY"]);
      expect(bundle.validation?.checks.every((check) => check.ok)).toBe(true);
      expect(bundle.raw?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(bundle.raw?.rowCount).toBe(bundle.parse?.rowCount);
      if (options.expectations?.minimumEntities !== undefined) {
        expect(bundle.parse?.entities.length ?? 0).toBeGreaterThanOrEqual(options.expectations.minimumEntities);
      }
    });

    it("is deterministic for the same as-of and clock", async () => {
      const first = await runFrameAdapter(options.createAdapter(), context());
      const second = await runFrameAdapter(options.createAdapter(), context());
      expectOk(first);
      expectOk(second);
      expect(second.raw).toEqual(first.raw);
      expect(second.parse).toEqual(first.parse);
      expect(second.transitions).toEqual(first.transitions);
    });

    it("accounts for every row as entities plus exclusions", async () => {
      const bundle = await runFrameAdapter(options.createAdapter(), context());
      expectOk(bundle);
      const parsed = bundle.parse!;
      const exclusionSum = Object.values(parsed.exclusions.byReason).reduce((sum, count) => sum + count, 0);
      expect(parsed.exclusions.total).toBe(exclusionSum);
      expect(parsed.entities.length + parsed.exclusions.total).toBe(parsed.rowCount);
    });

    it("emits unique entity keys with ISO-2 or unknown countries", async () => {
      const bundle = await runFrameAdapter(options.createAdapter(), context());
      expectOk(bundle);
      const entities = bundle.parse!.entities;
      const keys = new Set(entities.map((entity) => entity.entityKey));
      expect(keys.size).toBe(entities.length);
      for (const entity of entities) {
        expect(entity.country, entity.entityKey).toMatch(/^([A-Z]{2}|unknown)$/);
        expect(entity.entityKey.length).toBeGreaterThan(0);
      }
    });

    it("carries a frame.adapter lineage that pins the snapshot hash", async () => {
      const bundle = await runFrameAdapter(options.createAdapter(), context());
      expectOk(bundle);
      expect(bundle.lineage?.producer).toBe("frame.adapter");
      expect(bundle.lineage?.frameKey).toBe(bundle.raw?.frameKey);
      expect(bundle.lineage?.parserVersion).toBe(bundle.raw?.parserVersion);
      expect(bundle.lineage?.contentHash).toBe(bundle.raw?.contentHash);
      expect(bundle.lineage?.rowCount).toBe(bundle.raw?.rowCount);
    });

    it("wraps a fetch error as FAILED/FETCH_FAILED without parsing", async () => {
      const failing: FrameAdapter = {
        ...options.createAdapter(),
        fetchSnapshot: async () => {
          throw new Error("upstream down");
        },
      };
      const bundle = await runFrameAdapter(failing, context());
      expect(bundle.state).toBe("FAILED");
      expect(bundle.failure?.code).toBe("FETCH_FAILED");
      expect(bundle.transitions).toEqual(["FETCHING", "FAILED"]);
      expect(bundle.parse).toBeUndefined();
    });

    it("keeps a QUARANTINED verdict instead of reporting READY or FAILED", async () => {
      const base = options.createAdapter();
      const quarantining: FrameAdapter = {
        ...base,
        validate: async (parsed, raw, ctx) => {
          const report = await base.validate(parsed, raw, ctx);
          return {
            state: "QUARANTINED",
            checks: [...report.checks, { code: "CONTRACT_FORCED_QUARANTINE", ok: false }],
          };
        },
      };
      const bundle = await runFrameAdapter(quarantining, context());
      expect(bundle.state).toBe("QUARANTINED");
      expect(bundle.transitions).toEqual(["FETCHING", "PARSING", "VALIDATING", "QUARANTINED"]);
      expect(bundle.raw).toBeDefined();
      expect(bundle.parse).toBeDefined();
      expect(bundle.lineage?.contentHash).toBe(bundle.raw?.contentHash);
    });
  });
}
