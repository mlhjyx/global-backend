# AGENTS.md — `/global/backend` 稳定执行入口

本文件只保留跨会话、低漂移的执行规则。当前提交、在途工作、阻塞和下一决策见 [`docs/status/current.md`](docs/status/current.md)；历史事实见 [`docs/roadmap/changelog.md`](docs/roadmap/changelog.md) 与 [`docs/evidence/README.md`](docs/evidence/README.md)。不要把本文件扩写成日期化实施日志。

## 0. 最小工作循环
开工读取工作区规则、§1 与 [`docs/status/current.md`](docs/status/current.md)、按任务查 [`docs/README.md`](docs/README.md) 第 3 节、跑 `gctl doctor`；一个任务一个 worktree、先写 RED、不越 §2 no-go；收尾跑 `pnpm docs:verify`、写 changelog 片段、如实披露未验证项。全文见 [`docs/shared/development-process.md`](docs/shared/development-process.md)。

## 1. 权威顺序

发生冲突时按以下顺序取真：

1. 仓库代码、机器合同、迁移和测试；
2. [`docs/product-scope.md`](docs/product-scope.md)、[`docs/status/current.md`](docs/status/current.md)、[`docs/architecture/current.md`](docs/architecture/current.md)、[`docs/adr/registry.md`](docs/adr/registry.md)、[`docs/status/release-plan.md`](docs/status/release-plan.md)；
3. 当前外部系统与运行证据；
4. changelog、evidence、实施记录和研究；
5. 历史聊天、旧分支、旧 worktree、Word、原型和记忆。

分支、PR、worktree、服务、凭据、模型目录和运行状态都不是耐久事实。接手、状态评估和架构决策先读相关权威页，再对结论涉及的 Git/worktree/PR/service 状态做 live 检查；不为无关事实扩大调查。自主执行、导航和影响面流程见 [`docs/CODEX-NAVIGATION-GUIDE.md`](docs/CODEX-NAVIGATION-GUIDE.md)。

## 2. 产品边界与 no-go

- 本仓包含 Buyer Intelligence 后端与 Site Builder bounded context。
- 获客边界止于不可变 `LeadQualifiedPackage`；Campaign、触达、Conversation、Opportunity/QGO/SAO、归因和 SaaS 产品 UI 不在本仓创建主状态。
- 本仓不签发、不刷新、不存储用户身份；只验证 SaaS 签发的 JWKS token 并消费 workspace/user/role claims。
- Site Builder 采用 NestJS + Temporal 固定 DAG + 有界 AI Task + `@global/contracts` SiteSpec + Astro 静态渲染；不得引入自由 Planner 代替确定性控制面。
- MCP 是传输，不是授权。任何第三方能力必须位于 ProviderAdapter、ToolBroker、预算、来源政策和审计之后。
- 不以 mock、目录可见、配置存在、测试 anchor、历史真测或开发机通过冒充生产部署、当前运行健康或用户可用。

## 3. 本机开发与运行

- 宿主机、托管服务、端口和环境准备见 `/global/CLAUDE.md` 与工作区 RUNBOOK。代码在独立 worktree 验证，依赖、生成和构建步骤见 [README](README.md#本地起步)。
- 使用工作区 launcher 管理本机服务。启动、迁移、切换和恢复按对应运维手册及独立授权操作。开发监听使用 loopback。
- 密钥只进入环境变量或 secret store。记录验证证据时保留环境、提交、时间和结果，隐藏凭据和个人信息。

## 4. 单一产品运行路径（Production Parity）

- 开发环境是生产实现的低风险运行实例，不是替代实现。凡可能由真实用户、真实数据或真实外部服务触发的能力，development、pilot 与 production 必须共用业务代码、API/Workflow/Task/数据合同、身份与权限语义、Provider 路由、验证、预算结算、持久化、幂等、重试、降级、错误和 readiness 语义，并从同一种不可变制品运行。
- 环境差异只允许位于信任根、secret、endpoint、网络暴露、资源额度、可观测性和部署拓扑等配置边界；允许项及尚未清理的迁移债务必须逐项登记在 [`environment-parity-policy.json`](docs/governance/environment-parity-policy.json)，由 `pnpm governance:verify` 校验精确源码指纹。未登记分支、失效豁免和恢复旧分支一律失败。
- 不因一致性复用生产密钥、生产租户或生产数据。开发使用独立凭据、JWKS、端点、数据与较低额度，但不得更换验证器、业务算法、状态模型或失败策略。
- Stub、Fake、Sandbox、fixture、visual gallery、Dev Token verifier 和 evaluation runner 只可由测试入口或独立测试 workspace 注入；产品 composition root、运行依赖、OCI/Release 制品与用户站点不得包含或自动 fallback 到这些能力。单元测试可与源码相邻，但必须被产品编译与制品排除。
- compiled development runtime 与 pilot/production 一样必须拥有 exact commit、artifact/image digest、迁移和 Worker 身份；缺依赖可启动诊断，但 readiness 必须失败、API 不接新工作、Worker 不消费，绝不切到合成结果或未钉住身份。「API 不接新工作」按该工作自身的依赖集合判定。唯一例外是登记的 development 快速通道（allowance `development-fast-lane-unattested-worker-trust`，见 [运维说明](docs/backend/dev-fast-lane.md)）：一个源码 customer worker 只服务一个 workspace 在开发用 Temporal 上的专属队列，API 仍须是受证镜像。

## 5. 所有权、worktree 与外部动作

- 明确、已授权的本地任务持续推进到可审查交付；普通技术选择不重复确认。先查可发现的事实，只暂停依赖未决信息或权限的部分，继续独立工作；同一动作、目标和范围的有效授权跨步骤沿用，变化部分另行确认。只读请求仍不授权修改。
- 正式架构或安全方向变更保留书面规格、独立 review 和用户明确确认；已批准的同一规格不因切换 Skill 或执行阶段重复审批。Skill 不得新增操作权限、强制无关收尾或取消项目门。
- 当前开发主体是本机的 Claude Code 代理（2026-09-21 起接替 Codex）；Codex 只在 Claude Code 指派下执行边界明确的任务；旧 Claude/Codex 会话、分支和 worktree 只作待审计 provenance，不代表当前 owner，也不得因失联而删除。
- `/global/backend` 承载 main 与现场审计；本工作区在 `/global/.agy-worktrees/backend/<topic>` 从已核验的主线创建独立分支。一个任务一个 writer。创建和根 checkout 同步的操作见 [worktree 手册](docs/backend/worktree-management.md)。
- 远端 PR 合入、根 checkout 同步和工作树清理分别执行。按工作区 fast-forward 规则保留本地现场；用同步脚本的 `status` 在根 checkout 检查。
- 开始修改前运行 `pnpm worktree:inventory`，核对分支、worktree、任务与文件 owner。与其他 writer 重叠是硬停止条件；共享工作区中不得回退他人改动。
- 保留用户删除、未跟踪文件、脏工作区、独有提交和历史证据。不得使用 `git reset --hard`、`git clean -fdx` 或未经明确授权的递归删除。
- 网络工具默认只读。push、开/改 PR、发消息、发布、部署、合并、由 Codex/operator 发起的付费调用或 evaluation、远程任务、第三方配置与凭据变更都需要用户对该动作的明确授权。正常产品请求携带有效 SaaS 签名 Budget Grant 时，该 Grant 是本次 BuildRun 的产品费用授权，不再要求聊天式逐次批准；它不授权开发者额外探测、评测或扩大额度。
- 技术完成、机器检查、独立 review、PR 里给产品负责人的说明、用户合并/发布授权是分离的门。任何一门都不能推导另一门；Codex 不自行推断合并授权。产品负责人的常设合并授权（开发代理独立审查通过、必需检查全绿后可 squash 合并）见 `DEC-AIDEV-004`，不含 ruleset/仓库设置/权限变更、部署发布与付费调用。

## 6. 实现与安全门
- 复杂改动先计划；新功能和 bugfix 必须按 RED → GREEN → refactor 做 TDD，并维持相关范围 80%+ 覆盖。
- 在系统边界做 schema 校验；外部数据、URL、身份、权限、费用和 provider 响应全部不可信，必须 fail closed。
- 业务逻辑优先不可变数据与新对象；不得静默吞错。用户面返回稳定错误，服务端记录有界诊断且不泄露秘密或个人数据。
- SQL 使用参数化/Prisma，租户数据遵守 `app_user` + `set_config('app.current_workspace_id')` + FORCE RLS；owner 连接只用于明确的平台级任务。
- 出网只能经 ToolBroker 与 source policy；执行 SSRF/global-unicast、redirect 逐跳重验、凭据剥离、超时、字节上限、预算和幂等门。已登记的例外：robots.txt、DNS、模型网关与 outbox webhook 四类（#51，见 [as-built 架构](docs/architecture/current.md) §8 第 2 项），以及制裁名单运营刷新（`apps/api/scripts/refresh-sanctions-lists.mts`，#629，PRD4-D9）：后者不经 ToolBroker 持有调用与预算回执，仍受 source_policy 与 net-guard 约束。
- API 唯一真值是 code-first [`packages/contracts/openapi/openapi.json`](packages/contracts/openapi/openapi.json)。文档引用 operationId，不手抄 path/operation 总数。
- 所有 GitHub Actions 外部 `uses:` 必须锁定已从官方 tag 只读解析的 40 位 commit SHA，并保留人类可读的版本注释。`pnpm governance:verify` 扫描全部 workflow；新增未登记或 moving-tag action 必须失败。治理脚本、机器政策、schema、runtime evidence 与 release 目录必须保持在 CODEOWNERS 最终规则块内。

## 7. Provider、追踪、证据与发布
- Provider 当前机器真值为 [`docs/governance/provider-registry.json`](docs/governance/provider-registry.json)，人类页由 `pnpm governance:providers` 生成；seed key、SourceClass 与默认 enablement 漂移必须使 CI 失败。
- Capability → Core Object → operationId → code → test → Scenario 的机器链位于 [`docs/governance/delivery-traceability.json`](docs/governance/delivery-traceability.json)。路径存在只证明 anchor 存在，不证明运行通过。
- RuntimeEvidence 必须满足 [`runtime-evidence.schema.json`](docs/governance/runtime-evidence.schema.json)，包含 commit、environment、verified_at、valid_until、evidence_kind、result 与 artifact_digest。到期证据自动降为 `HISTORICAL`，不能用于晋级。
- `PILOT`/`GA` 必须同时拥有当前 PASS RuntimeEvidence 与有效 Release Bundle。每条机器追踪链须声明 `required_evidence_kinds`，Release Bundle 的 `traceability_bindings` 必须把同一 chain、capability 与同一 evidence set 精确绑定。Release Bundle 使用 [`release-bundle.schema.json`](docs/governance/release-bundle.schema.json)，并分别记录机器检查、独立 reviewer、用户授权和 merge-method provenance。**晋级 provenance（PRD4-D12，2026-11-11 拍板）**：`external_provenance.status=OWNER_SIGNED`（verifier=`PRODUCT_OWNER_SSH_SIGNATURE`）指向 `docs/releases/authorizations/*.authorization.json` 的**产品负责人 SSH 签名回执**；回执绑定 release bundle 摘要（`external_provenance` 字段除外）、implementation commit、证据集、签名时从 GitHub 回读的必需 check 结论与独立审查记录。验证器离线重算全部绑定并验签（公钥 pin 在 [`release-authority-keys.json`](docs/governance/release-authority-keys.json)），实现见 `scripts/release-authorization.mjs`。`EXTERNAL_UNVERIFIED` 仍阻断 `PILOT`/`GA`，自证的 `VERIFIED`、URL 或模板继续被拒绝；未来的独立外部 readback verifier 另立状态接入，不开放由 bundle 调用者注入"已信任"的旁路。RuntimeEvidence 与 Release Bundle 仍都是晋级条件。
- 运行 `pnpm governance:verify` 与 `pnpm docs:verify`。不得为过 CI 删除历史、改写 evidence 或把文件移出受控范围。

## 8. 模型、评测与费用
- 当前非运行时候选合同只认 `site-builder-model-candidate-baseline/2026-08-07-v3` 及其[生成页](docs/site-builder/model-candidate-baseline.md)；这个 ID 不是 active route、质量 evidence 或 dispatch 授权。
- 生产路由、评测基础设施、评测 evidence、promotion 和 runtime adoption 必须分开变更。
- 按 [运行架构](docs/architecture/current.md#运行模式与开关) 区分旧执行预算模式、技术安全上限和 SaaS 商业计费。执行预算处于 `enforce` 时，适用请求须先验证短效、请求绑定的 Grant 并原子消费；`bypass` 只覆盖代码登记的分支，平台与模型安全门按实际接线。
- “暂不调用模型”仍表示 Codex/operator/evaluation 的零费用、离线或 create-only 边界。此类 ad-hoc/evaluation 真实 dispatch 前必须有精确 alias/protocol/credential scope、有限额度、冻结价格、请求与 campaign cap、durable settlement 和用户明确费用授权；正常产品 Grant 与该授权不能互相推导。
- 费用未知、重复物理调用、保守结算和有限重试按 [执行预算账本](docs/backend/execution-budget-ledger-states.md) 与 [durable result 策略](docs/governance/durable-result-strategies.json) 核对。
- Provider kill switch、单次 task/wire/token/output 上限、幂等和异常停用继续保留；24 小时人工 settlement attestation 不得作为正常产品运行授权或调用门。

## 9. 文档与交付

- 稳定规则写本文件或治理页；当前事实写 `docs/status/current.md`；追加历史写 changelog 片段：每个 PR 在 [`docs/roadmap/changelog.d/`](docs/roadmap/changelog.d/README.md) 放一个 `<YYYY-MM-DD>-<slug>.md`（frontmatter `date` / `pr` / `title`，正文依次写起因 / 改动 / 测试 / 未做），不直接改 `changelog.md`，由 `scripts/changelog-assemble.mjs` 手动汇编并以 `docs(changelog)` PR 提交；改了 `apps/`、`packages/`、`scripts/`、`infra/` 或根目录构建与运行时文件（`Dockerfile`、`package.json`、`pnpm-lock.yaml` 等）的 PR 缺片段时 governance 检查失败。原始/冻结证明写 evidence；架构承重决定写 ADR。
- 不在多个 current 文档复制同一事实。迁移旧文字时保留 Git provenance，并在 changelog/evidence 索引留下 successor 指针。
- 代码改动后运行相关单元/集成/E2E、lint、build、docs、ContractGraph 与安全检查；同一相关源码、配置、依赖、环境和范围的可信结果可复用，相关变化或新疑点须重验，不按消息或固定时间机械重跑。必需门不得省略；真实 provider/数据库/Temporal 验证只在范围、成本、数据与外部动作均获授权时执行。
- 提交使用 Conventional Commits。提交前检查 diff、秘密、输入校验、授权、RLS、错误泄露和回滚路径。
