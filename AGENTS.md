# AGENTS.md — `/global/backend` 稳定执行入口

本文件只保留跨会话、低漂移的执行规则。当前提交、在途工作、阻塞和下一决策见 [`docs/status/current.md`](docs/status/current.md)；历史事实见 [`docs/roadmap/changelog.md`](docs/roadmap/changelog.md) 与 [`docs/evidence/README.md`](docs/evidence/README.md)。不要把本文件扩写成日期化实施日志。

## 1. 权威顺序

发生冲突时按以下顺序取真：

1. 仓库代码、机器合同、迁移和测试；
2. [`docs/product-scope.md`](docs/product-scope.md)、[`docs/status/current.md`](docs/status/current.md)、[`docs/architecture/current.md`](docs/architecture/current.md)、[`docs/adr/registry.md`](docs/adr/registry.md)、[`docs/roadmap/release-plan.md`](docs/roadmap/release-plan.md)；
3. 当前外部系统与运行证据；
4. changelog、evidence、实施记录和研究；
5. 历史聊天、旧分支、旧 worktree、Word、原型和记忆。

分支、PR、worktree、服务、凭据、模型目录和运行状态都不是耐久事实。接手、状态评估和架构决策必须先读权威页，再做 live Git/worktree/PR/service 检查。导航和影响面流程见 [`docs/CODEX-NAVIGATION-GUIDE.md`](docs/CODEX-NAVIGATION-GUIDE.md)。

## 2. 产品边界与 no-go

- 本仓包含 Buyer Intelligence 后端与 Site Builder bounded context。
- 获客边界止于不可变 `LeadQualifiedPackage`；Campaign、触达、Conversation、Opportunity/QGO/SAO、归因和 SaaS 产品 UI 不在本仓创建主状态。
- 本仓不签发、不刷新、不存储用户身份；只验证 SaaS 签发的 JWKS token 并消费 workspace/user/role claims。
- Site Builder 采用 NestJS + Temporal 固定 DAG + 有界 AI Task + `@global/contracts` SiteSpec + Astro 静态渲染；不得引入自由 Planner 代替确定性控制面。
- MCP 是传输，不是授权。任何第三方能力必须位于 ProviderAdapter、ToolBroker、预算、来源政策和审计之后。
- 不以 mock、目录可见、配置存在、测试 anchor、历史真测或开发机通过冒充生产部署、当前运行健康或用户可用。

## 3. 当前开发环境的稳定约束

- 唯一施工仓库是 Ubuntu 上的 `/global/backend`；Mac 只作为 SSH 客户端。
- Compose 一律使用 `docker compose -p global ...`。不得未经迁移审计执行 `down -v`、删除固定 `global-*` 容器或卷；先读 [`docs/backend/compose-project-migration.md`](docs/backend/compose-project-migration.md)。
- Temporal 由 `temporal-dev.service` 管理，不另起手工开发服务。
- 开发端口只绑定 `127.0.0.1`；跨主机访问使用 SSH 转发，不向 Tailscale 或公网直接暴露。
- 密钥只进入环境变量或 secret store；不得读取、打印、提交或在文档中保存 token、密码、凭据指纹之外的秘密。

最小启动与验证序列：

```bash
pnpm install --frozen-lockfile
docker compose -p global up -d
DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm --filter @global/db exec prisma migrate deploy
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api build
pnpm --filter @global/api test
```

## 4. 所有权、worktree 与外部动作

- Codex 是当前开发主体；旧 Claude/Codex 会话、分支和 worktree 只作待审计 provenance，不代表当前 owner，也不得因失联而删除。
- `/global/backend` 主工作区只作 main 与现场审计；功能施工使用 `/global/backend/.codex/worktrees/<topic>` 的持久隔离 worktree 与 `codex/<topic>` 分支。
- 远端 PR 合入后，根 `main` 以 `node scripts/governance-main-worktree-sync.mjs status` 只读检查、以同一脚本的 `apply` 动作受控跟随；后者固定 `/usr/bin/git` 与闭合执行环境，只允许 fetch 后把 `origin/main` 解析成精确 commit，再对该 commit 执行 `merge --ff-only`，必须证明入站路径不触碰本地 tracked/untracked/ignored 现场，并在操作前后保持完整 status 一致。它不代替 PR/CI/review/用户合并授权，也不 stash、reset、clean 或清理分支/worktree。
- 开始修改前运行 `pnpm worktree:inventory`，核对分支、worktree、任务与文件 owner。与其他 writer 重叠是硬停止条件；共享工作区中不得回退他人改动。
- 保留用户删除、未跟踪文件、脏工作区、独有提交和历史证据。不得使用 `git reset --hard`、`git clean -fdx` 或未经明确授权的递归删除。
- 网络工具默认只读。push、开/改 PR、发消息、发布、部署、合并、付费调用、远程任务、第三方配置与凭据变更都需要用户对该动作的明确授权。
- 技术完成、机器检查、独立 review、产品决策卡、用户合并/发布授权是分离的门。任何一门都不能推导另一门；Codex 不自行推断合并授权。

## 5. 实现与安全门

- 复杂改动先计划；新功能和 bugfix 必须按 RED → GREEN → refactor 做 TDD，并维持相关范围 80%+ 覆盖。
- 在系统边界做 schema 校验；外部数据、URL、身份、权限、费用和 provider 响应全部不可信，必须 fail closed。
- 业务逻辑优先不可变数据与新对象；不得静默吞错。用户面返回稳定错误，服务端记录有界诊断且不泄露秘密或个人数据。
- SQL 使用参数化/Prisma，租户数据遵守 `app_user` + `set_config('app.current_workspace_id')` + FORCE RLS；owner 连接只用于明确的平台级任务。
- 出网只能经 ToolBroker 与 source policy；执行 SSRF/global-unicast、redirect 逐跳重验、凭据剥离、超时、字节上限、预算和幂等门。
- API 唯一真值是 code-first [`packages/contracts/openapi/openapi.json`](packages/contracts/openapi/openapi.json)。文档引用 operationId，不手抄 path/operation 总数。
- 所有 GitHub Actions 外部 `uses:` 必须锁定已从官方 tag 只读解析的 40 位 commit SHA，并保留人类可读的版本注释。`pnpm governance:verify` 扫描全部 workflow；新增未登记或 moving-tag action 必须失败。治理脚本、机器政策、schema、runtime evidence 与 release 目录必须保持在 CODEOWNERS 最终规则块内。

## 6. Provider、追踪、证据与发布

- Provider 当前机器真值为 [`docs/governance/provider-registry.json`](docs/governance/provider-registry.json)，人类页由 `pnpm governance:providers` 生成；seed key、SourceClass 与默认 enablement 漂移必须使 CI 失败。
- Capability → Core Object → operationId → code → test → Scenario 的机器链位于 [`docs/governance/delivery-traceability.json`](docs/governance/delivery-traceability.json)。路径存在只证明 anchor 存在，不证明运行通过。
- RuntimeEvidence 必须满足 [`runtime-evidence.schema.json`](docs/governance/runtime-evidence.schema.json)，包含 commit、environment、verified_at、valid_until、evidence_kind、result 与 artifact_digest。到期证据自动降为 `HISTORICAL`，不能用于晋级。
- `PILOT`/`GA` 必须同时拥有当前 PASS RuntimeEvidence 与有效 Release Bundle。每条机器追踪链须声明 `required_evidence_kinds`，Release Bundle 的 `traceability_bindings` 必须把同一 chain、capability 与同一 evidence set 精确绑定。Release Bundle 使用 [`release-bundle.schema.json`](docs/governance/release-bundle.schema.json)，并分别记录机器检查、独立 reviewer、用户授权和 merge-method provenance。这些字段和 URL 仅是声明；在可信的独立外部 readback verifier 绑定其身份与内容前，`external_provenance` 必须保持 `EXTERNAL_UNVERIFIED`，验证器必须阻断晋级。伪造 `VERIFIED`、URL 或模板都不是发布证据。
- 运行 `pnpm governance:verify` 与 `pnpm docs:verify`。不得为过 CI 删除历史、改写 evidence 或把文件移出受控范围。

## 7. 模型、评测与费用

- 当前非运行时候选合同只认 `site-builder-model-candidate-baseline/2026-08-07-v3` 及其[生成页](docs/site-builder/model-candidate-baseline.md)；这个 ID 不是 active route、质量 evidence 或 dispatch 授权。
- 生产路由、评测基础设施、评测 evidence、promotion 和 runtime adoption 必须分开变更。
- “暂不调用模型”表示零费用、离线或 create-only。真实 dispatch 前必须有精确 alias/protocol/credential scope、有限额度、冻结价格、请求与 campaign cap、durable settlement 和用户明确费用授权。
- 未知余额、价格、scope、身份、结算或输出上限一律停止；不得扩大候选、顺手测试媒体或使用通用渠道“测试”按钮制造真实费用。
- 模型失败、非 2xx、响应解析失败、超时与 repair 都必须按已观察费用结算；unknown settlement 不得冒充零费用。

## 8. 文档与交付

- 稳定规则写本文件或治理页；当前事实写 `docs/status/current.md`；追加历史写 changelog；原始/冻结证明写 evidence；架构承重决定写 ADR。
- 不在多个 current 文档复制同一事实。迁移旧文字时保留 Git provenance，并在 changelog/evidence 索引留下 successor 指针。
- 代码改动后运行相关单元/集成/E2E、lint、build、docs、ContractGraph 与安全检查；真实 provider/数据库/Temporal 验证只在范围、成本、数据与外部动作均获授权时执行。
- 提交使用 Conventional Commits。提交前检查 diff、秘密、输入校验、授权、RLS、错误泄露和回滚路径。
