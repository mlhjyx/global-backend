# M1-g `design_spec` 零费用 Suite 准备决策卡

> 状态：`READY_FOR_SUITE_RE_REVIEW`；dispatch：`NOT_AUTHORIZED`；真实网络调用：`0`；模型费用：`$0.00`。

当前固定 suite 源提交：`589533051604e4577155d6ed19afcd934cbb1229`。create-only runner 已从该 clean commit 逐文件复核 50 个 source bundle 成员并生成 [v10 机器 manifest](m1-g-design-spec-suite-prep-manifest-v10.json)；source bundle SHA-256=`14894eb0832c07da841360c6c7c3ebf7b6d066be18b0d4dfa6033572ddc423f2`，manifest semantic SHA-256=`18dafb1dd97a26a333964fcfb2019cb548e6bcd9eb837733c5262748cf9e5768`，文件 SHA-256=`ca201a6b5b99cc1789ee0e5b0063144353cbccc435abe94d8fdc9dc3209165ae`。v1–v9 manifest 作为被后续审查发现取代的历史 provenance 保留，不覆盖、不作为后续 evidence 输入。

## 本 PR 冻结什么

- canonical task：`site_builder.design_spec`
- 视觉输入切片：六个 approved Family，各一组 sparse/rich，共 12 个合成 fixture；每例保存完整合成生产输入
- runnable 候选：`gpt-5.6-terra / openai-responses`、`gpt-5.5 / openai-responses`、`claude-sonnet-5 / anthropic-messages`
- 每个候选对 12 个 fixture 重复 2 次，共 72 个 target execution
- GPT-5.5 在矩阵前增加 1 个 task-shaped capability probe
- 每个 execution 最多 1 次 closed schema repair、最多 2 次 wire call
- fixture task input 必须通过与产品运行共用的完整 catalog enumeration、required-role eligibility、ranking 和 top-3 projection 从该生产输入逐字重建，不能手工拼 candidate
- fixture/prompt SHA-256 以独立常量固定；catalog 的 approved→B3→B2→B1 数据链、renderer preset digest 与 `design-catalog-v2` 合同实现纳入 source bundle
- task system prompt SHA-256 纳入 task-contract fingerprint；executor 只发送模块加载时捕获的字符串，运行前导出对象漂移即在预算/client 前拒绝
- evaluator 的 reasons/warnings 只能为空或使用 `selectedCandidateId`、`industryMatchCount`、`userAssetCoverage`、`demoFallbackCount` 四种封闭 claim；自由文本、自然语言指标、其他 candidate 或新事实均 fail-closed
- comparator：24 个 `deterministic-catalog-selection/v1` case，逐例真实执行确定性选择并冻结 expected/actual/PASS/result digest，不调用模型
- suite 自身固定 `legacyComparatorAliases=[]`；凭据必须精确覆盖三个 target alias，按 73 executions / 146 wire calls 绑定，MiniMax/Doubao extra scope 在预算和 client 前拒绝
- spend authorization 的 `preparedFixedCommitSha` 必须逐字等于执行 worktree 当前 `HEAD`，并同时匹配 suite、source-bundle contract 与 digest；任一不一致在预算/client 前拒绝
- runner 在导入 suite 前删除并本地重建 ignored 的 `packages/contracts/dist`；manifest 冻结 31 个 fixed-commit tracked contracts 文件（SHA-256=`c95bd7d5c90dd6cbe42dd35f6c58d6d0e1e473a3404efa5377e3547b99d15dd6`）及实际加载的 21 个 JS artifact（SHA-256=`d65642cc5f9b20001b4a167ec4acbd5cb9a1dac1d5e335b02da0208ffdc9cc01`），artifact-tree serializer 不调用实时 Array `map`/`join`/`sort`；构建后漂移即停止
- reservation 后、首个物理 wire 前发现 runtime drift 也会持久写入 `authorization_frozen`，恢复文件不能继续使用同一授权

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
