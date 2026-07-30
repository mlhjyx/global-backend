# M1-g `design_spec` 零费用 Suite 准备决策卡

> 状态：`READY_FOR_SUITE_RE_REVIEW`；dispatch：`NOT_AUTHORIZED`；真实网络调用：`0`；模型费用：`$0.00`。

修复后固定 suite 提交：`d9e63cb0580d0ea9a0a30f3bbe8760f5b6f01f45`。create-only runner 已从该提交逐文件复核 46 个 source bundle 成员并生成 [v2 机器 manifest](m1-g-design-spec-suite-prep-manifest-v2.json)；source bundle SHA-256=`23ff2e81d2060e47657dc7e02f94e21de5f562923d3510bc5628ba5a567dd478`，manifest SHA-256=`f32b4765b4988bdb61f59a2d3a36d64dfb8998c25462c149e1b7aefdbaa02f42`。旧 [v1 manifest](m1-g-design-spec-suite-prep-manifest.json) 作为被审查发现取代的历史 provenance 保留，不覆盖、不作为后续 evidence 输入。

## 本 PR 冻结什么

- canonical task：`site_builder.design_spec`
- 视觉输入切片：六个 approved Family，各一组 sparse/rich，共 12 个合成 fixture
- runnable 候选：`gpt-5.6-terra / openai-responses`、`gpt-5.5 / openai-responses`、`claude-sonnet-5 / anthropic-messages`
- 每个候选对 12 个 fixture 重复 2 次，共 72 个 target execution
- GPT-5.5 在矩阵前增加 1 个 task-shaped capability probe
- 每个 execution 最多 1 次 closed schema repair、最多 2 次 wire call
- fixture/prompt SHA-256 以独立常量固定；catalog 的 approved→B3→B2→B1 数据链、renderer preset digest 与 `design-catalog-v2` 合同实现纳入 source bundle
- evaluator 对 reasons/warnings 中任何不属于已选 candidate 的 catalog-shaped 标识符 fail-closed，并校验每一次重复指标声明
- comparator：24 个 `deterministic-catalog-selection/v1` case，逐例真实执行确定性选择并冻结 expected/actual/PASS/result digest，不调用模型

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
