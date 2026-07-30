# M1-g `design_spec` 零费用 Suite 准备决策卡

> 状态：`READY_FOR_SUITE_REVIEW`；dispatch：`NOT_AUTHORIZED`；真实网络调用：`0`；模型费用：`$0.00`。

固定 suite 提交：`667e7629f7481b5d1baa0b44aed0621f633caed3`。create-only runner 已从该提交逐文件复核 34 个 source bundle 成员并生成 [机器 manifest](m1-g-design-spec-suite-prep-manifest.json)；source bundle SHA-256=`f12e56e32041730cbb656e4443346c978c2e384fc1f6c8159208bf898439c847`，manifest SHA-256=`9b60589e1d034d94935d8efd160fa47c51df8f88853be2c22b0f8ce6f9affc2c`。

## 本 PR 冻结什么

- canonical task：`site_builder.design_spec`
- 视觉输入切片：六个 approved Family，各一组 sparse/rich，共 12 个合成 fixture
- runnable 候选：`gpt-5.6-terra / openai-responses`、`gpt-5.5 / openai-responses`、`claude-sonnet-5 / anthropic-messages`
- 每个候选对 12 个 fixture 重复 2 次，共 72 个 target execution
- GPT-5.5 在矩阵前增加 1 个 task-shaped capability probe
- 每个 execution 最多 1 次 closed schema repair、最多 2 次 wire call
- comparator：24 个 `deterministic-catalog-selection/v1` case，只选择冻结 candidate，不调用模型

因此未来真实评测的模型清单为 73 executions、最多 146 wire calls。按任务现有 20¢ 单次物理调用硬门，规划绝对上界为 2920¢（$29.20）；它不是预计费用、凭据额度或支出授权。

## 本 PR 明确不做什么

- 不读取 `.env`，不接入 new-api 或任一上游 client
- 不采样余额，不创建 runtime/evaluation token，不保存响应
- 不把 new-api 未配置价格当作金额依据
- 不调用或恢复 MiniMax/Doubao；它们不进入 target、comparator、runtime token 或价格覆盖
- Gemini 文本继续 `deferred`
- 不改 active route、rollback、消费者、API、数据库、P4、Temporal 或 ReleaseManifest
- 不进入 `copy`、`assemble`、`assembly_fix`、`qa_summarize`、`seo_review`、图片、视频、MODEL-2 或 M2-PUBLISH

## 后续独立授权门

本 PR 合并后，才能从合并提交创建独立 fixed-commit/create-only `design_spec` evidence PR。该 PR 必须从冻结的 [OpenOx 模型广场](https://openox.tech/models) 公共价格、精确 execution/wire-call 清单、有限额度且 exact alias/protocol allowlist 的评测凭据、余额采样时间和 settlement 上限生成费用卡。

在用户看到预计费用、绝对上限、凭据额度和停止条件并再次明确授权前，真实模型调用数必须保持 0。真实 evidence、`design_spec` promotion 和 promotion 合并仍是后续三个独立决策。
