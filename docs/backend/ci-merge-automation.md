# CI / 审查与合并流程（Claude Code）

> 生命周期：`GUIDE`
> 生命周期依据：CI、审查与合并的现行流程；2026-09-21 随 #548–#553 更新

> 2026-09-21 起，当前开发主体是 Claude Code；Codex 只在 Claude Code 指派下执行边界明确的任务。旧 Claude `merge-judge` workflow 已退役；合并遵循 `DEC-AIDEV-004`：开发代理独立审查通过、必需检查全绿并满足其余门后可 squash 合并，不包括 ruleset/仓库设置/权限变更、部署发布与付费调用。权威简版见 [AGENTS.md §8](../../AGENTS.md)。

## 合并模型

| 层                   | 责任                                           | 硬门                                                                                                     |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **L1 机械闸**        | GitHub ruleset + required checks               | 所有仓内声明的 context 真实通过；PR 正文的 `PASS` 不是 check provenance                                  |
| **L2 独立审查**      | 非作者 reviewer 审 diff、契约、安全/合规和证据 | 独立 GitHub review；发现问题先修复并重验，不以 CI 绿替代判断                                             |
| **L3 用户授权**      | merge 依 `DEC-AIDEV-004` 或当次明确授权；release 单独授权      | 必须是独立授权 provenance；PR 正文或机器人建议不能提供                                                   |
| **L4 合并/发布回执** | 合并执行者与 Release Owner                     | 按实际 `MERGE_COMMIT / SQUASH / REBASE` 记录 source、result、parents/mapping；pilot/GA 写 Release Bundle |

四层分别取证，任一层不能推导另一层。PR 正文的「给产品负责人的说明」只是作者用业务语言写的自述，不经机器解析，也不提供任何一层的证明或授权。执行合并前须独立回读实际 CI、review、未解决讨论和用户授权。见 [Source PR 说明与合并资格分离](../governance/docs-verification.md#source-pr-说明与合并资格分离)；Runtime/Release/Pilot/GA 的证明要求不变。

## 仓内 required contexts 与外部 ruleset

唯一机器清单是 [`.github/required-contexts.json`](../../.github/required-contexts.json)。`pnpm governance:verify` 会把每个 context 绑定到声明 workflow 的一个唯一 job，确认 event 存在，并拒绝未在机器清单逐字登记的 job-level `if` 与任何 `continue-on-error`；当前唯一获准条件是 `build · typecheck · test` 的 fail-closed 启动条件（见下文“CI 成本与有效保护面的迁移约束”）。required job 的 `needs` 只能指向另一个 required job，避免 GitHub 把条件跳过、容错失败或未受保护的前置依赖显示成绿色。验证器同时拒绝放宽 CODEOWNERS/review/history 保护的仓内政策，并扫描 `.github/workflows/` 的全部外部 `uses:`：每个 action 必须绑定政策中的 40 位 commit SHA 并保留版本注释；新增 workflow 也不能逃过检查。CODEOWNERS 必须以完整治理 ownership block 结尾，防止后续规则覆盖政策、schema、verifier、RuntimeEvidence、Release Bundle、Gitleaks suppression 配置或 Provider SourceClass manifest。新增/改名 context、action 或治理路径必须同时更新 workflow、清单和 mutation tests。

仓库文件**不能配置或证明** GitHub ruleset 已生效。有管理员权限的人仍须在 GitHub 外部状态中：

1. 把清单中的全部 context 配为 required；
2. 至少要求一个 approving review、CODEOWNERS review、dismiss stale review 和 conversation resolution；
3. 禁止 force push 与 branch deletion；
4. 回读 ruleset/branch protection 与真实 PR checks，保存 URL/ID/时间作为外部配置证据。

若外部配置未完成或无法回读，状态必须写 `EXTERNAL_RULESET_NOT_VERIFIED`，不能因为仓内 JSON 存在就称保护已启用。

### 2026-09-21 只读 ruleset 回读

`protect-main` 仍为 `active`，只作用于默认分支；禁止删除与 non-fast-forward，strict 同步、
review thread 必须解决、push 后撤销旧 review。与下文 2026-08-09 相比：

- required checks 已扩为 `renderer visual scope`、`build · typecheck · test`、
  `contracts · drift · lint · breaking`、`gitleaks 密钥扫描`、`governance · traceability · release`
  与 `nontechnical decision card freshness`。后者随决策卡移除，须在该变更合入后立即从 ruleset 删去，
  否则之后的 PR 会一直等待一个不再产生的检查；
- approving review 数仍为 0、未要求 CODEOWNERS review，RepositoryRole 5 仍有 `always` bypass。
  仓库只有产品负责人一个 GitHub 账号，PR 均以该账号创建，GitHub 不允许自批，上文第 2 条的批准
  目标在单账号条件下无法达成；产品负责人据此以 `DEC-AIDEV-004` 把审查职责交给开发代理，目标本身
  保留为远期要求，不据此下调。

### 2026-09-21 ruleset 变更（产品负责人授权）

#549 合入后，经产品负责人明确授权对 `protect-main` 做了两处修改，并回读确认：

- 移除 `nontechnical decision card freshness`，required checks 现为 5 项：`renderer visual scope`、
  `build · typecheck · test`、`contracts · drift · lint · breaking`、`gitleaks 密钥扫描`、
  `governance · traceability · release`；
- 关闭 strict（`strict_required_status_checks_policy: false`）：PR 绿了即可合，不再要求先并入最新 main。
  理由：单人加开发代理顺序合并、并行 PR 少，strict 带来的是每次合并后其余 PR 串行重跑（一批 4 个 PR 约多等 45 分钟），
  而它防范的"各自绿、合起来坏"在此规模下风险低。替代保护：main 每个 push 的 CI 不被取消、完整跑完；
  开发代理合并前把 PR 与最新 main 的组合在本地复核（`governance:verify`、`docs:verify`、Copy 指纹）；
  Copy 回执与 changelog 等多 PR 共改的行会产生文本冲突，迫使后合者变基重签。

删除、non-fast-forward、review thread 解决与 push 后撤销旧 review 等其余规则不变。

### 2026-08-09 只读 ruleset 回读

GitHub API 对 `main` 的实时只读回读确认仓库级 `protect-main` ruleset 为
`active`，并已禁止删除和 non-fast-forward，要求分支与 main 保持严格同步、
解决 review threads 且 push 后撤销旧 review。其余状态仍不满足目标治理：

- approving review 数为 0，未要求 CODEOWNERS review；
- required checks 只有 `build · typecheck · test`、`gitleaks 密钥扫描` 和
  `nontechnical decision card freshness`；contracts、governance 与 security
  聚合门尚未受 ruleset 强制；
- 当前 `Security` workflow 只执行 Gitleaks。它不执行依赖漏洞、source-only
  SAST、container image 或 Compose/IaC 扫描，不能被表述为完整 security gate；
- Gitleaks 的 PR job 扫描 action 计算的 first-parent PR commit range；完整
  checkout 只保证 range 可达，不代表每次 PR 都重扫仓库全历史。历史暴露面须
  另走显式审计、分诊与轮换流程；
- PR 扫描使用 base SHA 中的 `.gitleaks.toml` 与 `.gitleaksignore`，同一个 PR
  不能先放宽规则或新增 fingerprint 再隐藏本次提交；这两份 suppression 配置也
  位于终结 CODEOWNERS 块。配置变更合入后，main push 才会使用新版本；因此仍
  必须先完成外部 CODEOWNER/ruleset 配置和用户对 exact head 的授权；
- RepositoryRole 5 仍有 `always` bypass；
- classic branch-protection API 返回未配置；当前保护来自 repository ruleset。

本次只做回读，没有修改 GitHub 外部状态。安全迁移顺序是：先让产生稳定
context 的工作流进入 main，在目标 main 的 canary PR 上观察 exact context；再
单独把 contracts、governance 和 `security · required gate` 加入 ruleset，并把
批准数升为 1、启用 CODEOWNERS、移除常态 bypass；最后重新回读完整 ruleset
和真实 PR checks。`pull_request_target` 的 decision-card context 名称保持
`freshness`，只强化内部 integrity 语义，避免 base workflow 尚未合并时出现
required-context bootstrap 死锁（该 context 已于 2026-09-21 随决策卡一并移除）。

### 依赖与安全聚合门的启用顺序

2026-08-09 对 `pnpm-lock.yaml`（SHA-256
`d98a61553ffa6ea3bca177f47c7c2a82362f774697ffd4c89fa299465072e868`）执行
只读生产依赖审计：仓库默认 `npmmirror` 不实现 npm audit endpoint；显式使用
npm 官方 endpoint 后返回 36 项漏洞，其中 18 high、0 critical。这个结果只绑定
上述 lock digest 和核验时间；依赖或 advisory 数据变化后必须重跑，不得手抄为
长期基线。

因此不能直接新增一个会被 registry 错误静默跳过的绿色 job，也不能在尚未处理
既有 high findings 时把全量 audit 设成 required 后长期手工绕过。安全迁移采用：

1. 先把 audit registry、超时、JSON 解析、零 advisory 数据/endpoint 不可用的
   fail-closed 语义写成受测脚本；原始报告只存受控 artifact，PR 只显示计数和摘要；
2. 对 high findings 按 runtime reachable、build-only、transitive 和需要 major
   upgrade 分流，在独立依赖 PR 中修复并跑 API、renderer、SSRF/上传边界回归；
3. 再加入稳定的 `security · required gate`，至少聚合 dependency audit、
   source-only SAST、container image 与 Compose/IaC scan；Gitleaks 保持独立门；
4. 先在 main push 和 canary PR 观察 context 名、权限、缓存、误报与运行时间，
   再写入 required-context 清单并修改外部 ruleset；任何不可用 scanner 都必须
   返回失败或明确 HOLD，不能成功跳过。

Action SHA 升级只能通过官方 Git 仓库的 tag 做只读解析；不以 marketplace 显示文字、moving major tag 或非官方 mirror 作为 revision 真值。仓内当前精确 pin 以 required-context 清单为唯一机器真值。

CI workflow 显式把 `GITHUB_TOKEN` 收敛为 `contents: read`，checkout 不持久化
凭据。只有确实需要回写 PR comment 的 Gitleaks workflow 保留最小的
`pull-requests: write`。CI 并发键同时包含 event
类型，防止 scheduled 全量视觉基线与 main push 验证因为共享 `refs/heads/main`
而互相取消；同一 PR 的旧 synchronize run 会被新 head 取消 —— 前提是 build job
不用 `always()`（见下文），否则旧 run 无视取消、跑满全程，新 run 只能排队等待。
main 的 push 按提交分组、互不取消：GitHub 在同一并发组里只保留一个排队中的 run，
第三个 run 到达时会顶掉排队者，共用一组会让连续合并中间的 main 提交得不到验证（2026-09-21 在 `4ad5f4dc` 上实际发生）。

### CI 成本与有效保护面的迁移约束

Renderer 的 Vitest 被拆成始终执行的 `test:contracts` 与真实 Astro fixture build
`test:fixtures`。fixture build、三断点 byte-pinned visual gate 和多语言 smoke build
共享 `renderer visual scope`：renderer、整个 Site Builder contracts 目录、根依赖/
TypeScript 配置
或 CI workflow 变化时全部执行；schedule、manual、缺失/不可达 diff base 时也
fail-safe 全部执行；变更路径使用 NUL 分隔并禁用 rename folding（移动受控文件时
旧路径仍进入判定），diff 自身失败时同样全跑，不能降级成 `false`。无关 PR 只
跳过这三项重任务，不能跳过 renderer contract tests。

同一个 scope job 另外输出两项重门的范围，fallback 规则完全相同（schedule、manual、
无可用 diff base、diff 失败时一律为 `true`）：

- `run_temporal_go`：原生 Temporal reader 服务的 Go 校验（`go mod verify`、race 测试、
  vet、build，约 14 分钟）。该步骤只 bind-mount `infra/temporal-platform/server`，所以仅在
  该目录或 CI workflow 变化时执行。
- `run_oci`：OCI 运行镜像构建与 inspect、Worker fail-closed 冒烟、renderer 只读冒烟。
  采用**排除清单**：只有全部改动都落在 `docs/`、`.github/`（CI workflow 除外）、
  代理元数据目录或根目录四份说明文档时才跳过；任何未列名路径都会重建镜像，新增目录
  不会被静默漏掉。API build、单测、attestation 生成与 renderer contract tests 不受影响，始终执行。

该拓扑由 `scripts/governance-ci-topology.spec.mjs` 进行确定性结构合同校验；其中
范围判定另有行为测试，在临时 git 仓库里真实执行 scope 脚本并逐项核对三个输出。

`build · typecheck · test` 与它依赖的 `renderer visual scope` 均已被 live ruleset
强制（2026-09-21 回读）。为防 upstream failure 让 build job 被 GitHub 标为 skipped，
build job 固定以 policy 批准的 `${{ !cancelled() }}` 启动（不用 `always()`：两者在依赖
失败时都照跑，但 `always()` 的 job 无视工作流取消），并在
任何 checkout 或仓库代码执行前验证 `needs.renderer-visual-scope.result` 必须为
`success`；failure、cancelled 或 skipped 一律显式失败。这个传播合同也受拓扑
结构合同保护。

`docs:verify` 与 `memory:test` 当初留在 `build · typecheck · test`
内，是因为 `governance · traceability · release` 那时尚未被 live ruleset 强制。
2026-09-21 回读确认它已被强制，消除这部分重复的前置条件已满足；但 `docs:verify`
是 Copy fixed-source 绑定的根 package 命令，拆分须另开 PR 并同步指纹，不在本次范围。

## Release Bundle 的外部 provenance

Release Bundle 中的 `CHECK_RUN`、`GITHUB_REVIEW`、`SIGNED_AUTHORIZATION`、merge SHA/parent 和 `evidence_ref` 是待验证声明，不是自证。当前仓内尚无可信外部 readback verifier，所以 `external_provenance.status` 只能有效地表达 `EXTERNAL_UNVERIFIED`；对 `PILOT/GA`，验证器始终返回 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED`。仅把字段改为 `VERIFIED`或填入 URL 会追加 `RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED`，不能解锁 promotion。未来实现必须独立回读外部对象、绑定当次仓库/PR/head/actor/result 和 receipt，并另行审查；不开放由 bundle 调用者注入“已信任”的旁路。

## 开发代理收口步骤

1. 按 [worktree 管理 runbook](worktree-management.md) 从最新 `origin/main` 建 `.claude/worktrees/<topic>` 与 `claude/<topic>`，或用 `pnpm worktree:new <topic>` 建 `.codex/worktrees/<topic>` 与 `codex/<topic>`；两种约定都合法，一个任务一个 writer 一个 worktree，一个逻辑改动一个 PR。
2. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 跑 lint/build/test；provider/采集/富集另附真源验证。
3. 开 PR 后等待 required-context 清单中的 CI、Security 与 Governance 门，触发独立 review，逐条处置 inline comment 并 resolve。
4. 向用户报告改动、风险、验证和未完成项；按用户对当次 PR 的明确授权合并，或在 `DEC-AIDEV-004` 常设授权下于独立审查通过、必需检查在当前 head 全绿、审查线程清零，且 PR 与最新 main 的组合已在本地复核（ruleset 不再强制 strict）后合并。
5. 合并后在 `/global/backend` 运行 `node scripts/governance-main-worktree-sync.mjs apply`，以 fetch 后解析出的 `origin/main` 精确 commit 做纯 fast-forward；若远端 PR/分支由另一会话处理，它只交接已合入的精确 SHA，本地会话仍独立 fetch 和验证，不从通知推导 merge 授权。同步脚本遇到 HOLD 时保留现场并单独审计，不 stash/reset/clean。功能分支与本地 worktree 默认保留用于复查。删除仅是可选空间清理，须满足 `CONTRIBUTING.md` 的提交已入主线、工作区干净且未跟踪文件归属已核清条件，并取得用户明确授权。

## 风险分级（决定验证深度，不授予自动合并）

| 触发                                                  | 必要复核                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `schema.prisma` / migrations / RLS                    | 真 PostgreSQL 迁移、回退/兼容性、租户隔离与 owner/app_user 权限          |
| JWKS / token / role / workspace                       | 鉴权负向用例、跨租户与权限边界                                           |
| `personalData` / GDPR / LIA / suppression / Art.17    | 数据分级、lawful basis、删除/抑制时序与审计证据                          |
| source_policy / ToolBroker / SSRF / robots / 对外抓取 | 真源正例 + SUSPENDED/private/metadata/redirect 反例，不把 robots 当 SSRF |
| `packages/contracts/**`                               | 生产者/消费者同步、OpenAPI drift/lint/breaking 门                        |
| 大量删除或删/禁测试                                   | 逐文件说明去留理由，验证覆盖未倒退                                       |

## 退役记录

- `.github/workflows/claude-merge-judge.yml` 已删除；不再需要 `ANTHROPIC_API_KEY` 或 Claude GitHub App 作合并判官。
- GitHub 原生 auto-merge 不作为默认执行层。即使全绿，也要满足 `DEC-AIDEV-004` 的全部合并门或当次用户明确授权。
- 历史 changelog/实施记录中的「自审自合」、`feat/` 等保留当时 provenance，不覆盖现行规则。
