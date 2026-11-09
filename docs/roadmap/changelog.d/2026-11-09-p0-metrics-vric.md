---
date: 2026-11-09
title: Add the paired VRIC series endpoint (T0-001 STRICT + T0-002 PLUS) to the metrics API (PR-04 follow-up)
---

- 起因：PR-04 只读度量 API 只做了 catalog/observations/rollups；看板需要 VRIC 北极星趋势，且字典要求 STRICT/PLUS 并列展示、缺数据不得以 0 冒充。
- 改动：
  - `GET /api/v1/metrics/vric`（`MeasurementService.vric`）：读 `metric_rollup_daily|weekly` 中 T0-001/T0-002 的本 workspace 行（RLS 与 rollups 相同），按 bucket + stratum_key 成对成行，每侧取最高 metric_version；桶升序、返回最近 `limit` 个桶（默认 30，最大 180），显式 from/to 时以最后 limit 个桶为准并用 `page.has_more` 标记截断；某侧缺行为 `null`。
  - 控制器/操作描述/openapi 同步：新增 `GET /api/v1/metrics/vric` 到 `operation-descriptions.ts` 并重导出 `packages/contracts/openapi/openapi.json`（+106 行纯加法）。
  - `docs/metrics/metrics-api.md` v1.1：端点表补 vric、明确升序/有界窗口/缺侧 null 语义与 PR-04 余量（scorecards 需先定 ops 读路径；T0-002 通道拆分属 PR-03 rollup 余量，端点不伪造通道值）。
- 测试：`vitest run src/measurement src/docs/operation-descriptions.spec.ts` 54 例全过（vric 成对/最高版本/最近 limit 桶/周表选择/非法参数）。
- 未做：scorecards/evals/frames/recapture/benchmarks 端点、T0-002 通道拆分、BFF/看板；未发车、未部署。
