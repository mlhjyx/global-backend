# 度量只读 API（PR-04）

> 文档 ID：`METRICS-API-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`GUIDE`
> 生命周期依据：ch01 §3.6.5 的引擎只读端点切片（catalog / observations / rollups）。
> 状态：`GUIDE`

引擎新增只读模块 `apps/api/src/measurement/`（controller + service + module），三端点均要求
`acquisition:read`，列表统一 page envelope（`data` + `page.next_cursor` / `page.has_more`），
参数错误返回 `400 VALIDATION_ERROR`。

| 端点 | 读的表 | 说明 |
| --- | --- | --- |
| `GET /api/v1/metrics/catalog` | `metric_definition`（平台工件，app_user 只读） | 指标 ID/版本/口径/状态/负责人；字典同步前为空数组 |
| `GET /api/v1/metrics/observations` | `metric_observation`（RLS：本 workspace） | `metricId`/`from`/`to`/`cursor`/`limit`（默认 100，最大 500）；按 `window_end` 倒序 keyset 分页；数值列 double，stratum 原样 JSON |
| `GET /api/v1/metrics/rollups` | `metric_rollup_daily` / `metric_rollup_weekly`（RLS：`stratum->>'workspace_id'`） | 另有 `granularity=daily|weekly`（默认 daily）；按桶倒序 + 指标/维度 keyset 分页 |

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

`/metrics/vric`、`/metrics/scorecards`、`/evals/golden-*`、`/frames`、`/recapture-estimates`、
`/benchmarks` 等平台端点属后续切片；SaaS BFF 代理（gain-saas `apps/server/src/bff/`）与看板（PR-05）不在本 PR。
