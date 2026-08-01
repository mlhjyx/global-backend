# M1-g `design_spec` Suite/Harness 源码决策卡

> 状态：`SOURCE_PR_REVIEW_REQUIRED`；dispatch：`NOT_AUTHORIZED`；真实网络调用：`0`；模型费用：`$0.00`。

本 PR 只提交 `design_spec` canonical suite、评估器、协议执行与成本安全源码，不提交 fixed-commit manifest。PR 内部提交在 squash/rebase 审查或合并后可能不可达，不能作为权威 fixed source；此前在本分支生成的 v1–v13 manifest 已全部撤销。

## 本 PR 冻结的源码合同

- canonical task：`site_builder.design_spec`
- 六个 approved Family，各一组 sparse/rich，共 12 个合成 fixture；每例重复 2 次
- runnable 候选：`gpt-5.6-terra / openai-responses`、`gpt-5.5 / openai-responses`、`claude-sonnet-5 / anthropic-messages`
- GPT-5.5 在矩阵前增加 1 个 task-shaped capability probe
- comparator 为 24 个零模型调用的 `deterministic-catalog-selection/v1` case；`legacyComparatorAliases=[]`
- 规划矩阵为 73 executions、最多 146 wire calls；每个 execution 最多一次 repair
- 每个物理调用保留 20¢ 单次硬门；两次合法调用的聚合结算按 40¢ execution 预留额核验，不能误判为单次超限
- fixture 输入必须经产品共用的 catalog enumeration、required-role eligibility、ranking 和 top-3 projection 重建
- 输出解释仅允许 `selectedCandidateId`、`industryMatchCount`、`userAssetCoverage`、`demoFallbackCount` 四类封闭 claim
- task validator 在模块加载时捕获；admission、repair 与最终评分都不能受运行中导出对象篡改影响
- 凭据 capacity 必须精确等于 target-only 的 73/146；MiniMax、Doubao 与任何 extra scope 均在预算和 client 前拒绝
- runtime integrity、输出 token、repair reason、未知结算和超限结算继续 fail-closed，并冻结 durable authorization

73 × 2 × 20¢ = 2920¢（$29.20）仅是未授权规划上界，不是预计费用、凭据额度或支出授权。

## 本 PR 明确不做

- 不提交或声称存在权威 fixed-commit/create-only manifest
- 不读取 `.env`，不接入 new-api 或任一上游 client
- 不采样余额、不创建 token、不保存模型响应、不调用真实模型
- 不恢复 MiniMax/Doubao；Gemini 文本继续 `deferred`
- 不改 active route、rollback、消费者、API、数据库、P4、Temporal 或 ReleaseManifest
- 不进入其余五个文本任务、媒体、MODEL-2 或 M2-PUBLISH

## 合并后的独立零费用门

只有本源码 PR 经用户单独授权并进入 `origin/main` 后，才能从该主线提交创建新的 create-only manifest PR。后续 writer 必须证明 fixed source 是当时 `origin/main` 的祖先，再冻结 source bundle、execution/wire-call 清单与停止条件；该 PR 仍保持网络调用 0、费用 $0.00。

真实 evidence PR、真实费用授权、`design_spec` promotion 和 promotion 合并继续是后续独立决策。真实执行前的金额只取冻结的 [OpenOx 模型广场](https://openox.tech/models) 公共价格。
