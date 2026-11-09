# 度量只读 API（PR-04）

> 文档 ID：`METRICS-API-001`
> 版本：`v1.1`（2026-11-09）
> 生命周期：`GUIDE`
> 生命周期依据：ch01 §3.6.5 的引擎只读端点切片（catalog / observations / rollups / vric）。
> 状态：`GUIDE`

引擎新增只读模块 `apps/api/src/measurement/`（controller + service + module），四端点均要求
`acquisition:read`，列表统一 page envelope（`data` + `page.next_cursor` / `page.has_more`），
参数错误返回 `400 VALIDATION_ERROR`。

| 端点 | 读的表 | 说明 |
| --- | --- | --- |
| `GET /api/v1/metrics/catalog` | `metric_definition`（平台工件，app_user 只读） | 指标 ID/版本/口径/状态/负责人；字典同步前为空数组 |
| `GET /api/v1/metrics/observations` | `metric_observation`（RLS：本 workspace） | `metricId`/`from`/`to`/`cursor`/`limit`（默认 100，最大 500）；按 `window_end` 倒序 keyset 分页；数值列 double，stratum 原样 JSON |
| `GET /api/v1/metrics/rollups` | `metric_rollup_daily` / `metric_rollup_weekly`（RLS：`stratum->>'workspace_id'`） | 另有 `granularity=daily|weekly`（默认 daily）；按桶倒序 + 指标/维度 keyset 分页 |
| `GET /api/v1/metrics/vric` | 同上两张 rollup 表（RLS 同 rollups） | VRIC 成对序列：同一 bucket + stratum 下 T0-001 STRICT 与 T0-002 PLUS 并排；桶**升序**、返回最近 `limit` 个桶（默认 30，最大 180）；某侧无数据为 `null`，不以 0 冒充；`page.has_more=true` 表示窗口被截断（如需更早数据显式给 from/to） |

## 1. 数据可见性

- `metric_observation`：租户只见 `workspace_id = 当前 workspace` 的行；平台级行（NULL）对租户不可见。
- rollup 两表没有 workspace 列，租户过滤走 `stratum->>'workspace_id'`（PR-02 的 RLS/权限负向测试覆盖）。
- 写入只属度量工作流（PR-03，owner 连接）；本 API 全部只读。

## 2. 字典同步（让 catalog 有数据）

```bash
# owner 连接（DATABASE_URL）；幂等，按 (metric_id, version) upsert
node --import tsx apps/api/scripts/measurement-sync-definitions.mts --dry-run
node --import tsx apps/api/scripts/measurement-sync-definitions.mts
```

数据源是 `docs/metrics/dictionary/*.json`（44 指标）；`metrics:lint` 保证其自洽。
未同步时 catalog 返回空数组（`has_more=false`）而不是 404——数据未就绪与路由不存在是两件事。

## 3. 分页游标

- observations：`{ w: window_end ISO, id }`（base64url JSON）；
- rollups：`{ b: bucket YYYY-MM-DD, m: metric_id, v: version, k: stratum_key }`。
客户端把上一页的 `page.next_cursor` 原样回传即可；游标不合法返回 400。

## 4. 契约与 OpenAPI

新端点已登记 `apps/api/src/docs/operation-descriptions.ts`（操作门户正文由
`operation-descriptions.spec.ts` 机械校验），并重导出 `packages/contracts/openapi/openapi.json`
（code-first 单一真值；CI 的 drift/spectral/oasdiff 三道门守护）。新增是纯加法，oasdiff 不判 breaking。

## 5. 未做（PR-04 余量）

- `/metrics/scorecards`、`/evals/golden-*`、`/frames`、`/recapture-estimates`、`/benchmarks` 等端点属后续切片；
  其中 scorecards 读平台级行（T1-008/T1-009 的 provider 分层），需要先定 ops 读路径与 scope，不是加个查询就能开。
- `/metrics/vric` 目前按 rollup 现有行成对呈现；字典 §1.3.1 要求的 T0-002 通道拆分
  （email_only/phone_only/both）尚未在 PR-03 的 rollup 查询里实现，端点不加戏、不伪造通道值。
- SaaS BFF 代理（gain-saas `apps/server/src/bff/`）与看板（PR-05）不在本切片。
