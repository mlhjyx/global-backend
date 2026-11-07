# openFDA 投影上界修复与真机复测（2026-11-08）

> 结论：`openfda-search/v1` 投影与 provider 取数口径的契约冲突已修——`establishments`/`clearances`
> 的 `maxItems` 由 12 提到 50（发现 provider 的取数下限 `max(query.limit, 50) = 50`）。
> 真实 API 复测：产品码 `LLZ` + 美国进口商口径从「0 条（投影拒绝）」恢复为 **33 家**注册公司
> （抓取 50 条、按身份键去重后 33 条），每条带 FDA 注册号与 CC0 license。

## 1. 缺陷（2026-11-08 M0 步2 真测发现）

- 证据：`docs/evidence/2026-11-08-m0-step2-source-enablement.md` §2/§4.4。provider 每次请求
  `maxRecords = min(max(query.limit, 50), 250)`（生产 `query.limit=25` → 恒为 50）条，而投影
  schema 对两个数组均设 `maxItems: 12` → 真实响应在 broker 结算时被
  `TOOL_DURABLE_RESULT_PROJECTION_REJECTED` 拒绝，openFDA discovery 恒零产出。
- 单测夹具（12 条）恰好等于旧上界，掩盖了真实数据形状（典型「假对象单测掩盖真实契约」类）。

## 2. 修复（TDD）

- `durable-results/source-result-projections.ts`：`openfda-search/v1` 的 establishments/clearances
  `arraySchema(12, …)` → `arraySchema(50, …)`。未改工具侧（50 覆盖唯一生产调用方的取数口径；
  若未来有调用方传 `limit > 50`，需同步抬升该上界）。
- 结构性上限仍精确：51 条被拒（`TYPED_PROJECTION_INVALID`）；120 KiB 应用层字节门不变，
  是真正的信封上界（最大叶形状的 50 条仍会被字节门拒绝，属设计内防御）。
- 测试：RED→GREEN。新增回归——50 条真机形状可投影并逐字节还原且 <120 KiB、51 条结构性拒绝；
  边界锁定测试同步 50；「maxItems + 1」用例改为自建 50 条小载荷夹具（不依赖边界夹具长度）。

## 3. 真机复测（2026-11-08，修复后）

环境：worktree `claude/openfda-projection-fix`，源码级 `ToolBroker`（真实 `source_policy` 读取 +
test-support 内存预算账本，不写库、不建 run），`openfda.search` 真打 `api.fda.gov`。

```
=== openfda ===
   records=33
   · Straumann Manufacturing, Inc.  [US] 注册号=3024185724 importer=true
   · Merge Healthcare Incorporated  [US] 注册号=2183926 importer=true
   · DEEPHEALTH  [US] 注册号=3018733944 importer=true
   · REMINGTON MEDICAL, INC.  [US] 注册号=1056553 importer=true
   · SIEMENS MEDICAL SOLUTIONS USA, INC.  [US] 注册号=3023245 importer=true
   · KLS-Martin L.P.  [US] 注册号=1057946 importer=true
   PASS openfda 真 API 返回 ≥1 家注册公司
   PASS 每条 license=CC0-1.0
```

同日同探针的对照（修复前）见证据文档 §2：`records=0`、`TOOL_DURABLE_RESULT_PROJECTION_REJECTED`。

## 4. 边界与后续

- 本修复只解除投影契约冲突；openFDA 的第③④步启用仍随 lineage v3（PR #846）后的发车执行。
- 若真实批量存在单条记录字段极多（如 deviceNames/ownerOperatorNumbers 长期打满 64 项）导致
  信封逼近 120 KiB，会由应用层字节门按查询 fail-safe 跳过并在 trace 可见——当前 33 家样例远低于该界。
