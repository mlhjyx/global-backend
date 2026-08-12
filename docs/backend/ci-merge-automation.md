# CI / 审查与合并流程（Codex）

> 2026-07-16 起，当前开发与复核主体是 Codex。旧 Claude `merge-judge` workflow 已退役；不再使用 AI auto-merge。权威简版见 [AGENTS.md §8](../../AGENTS.md)。

## 合并模型

| 层                   | 责任                                           | 硬门                                                                                                     |
| -------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **L1 机械闸**        | GitHub ruleset + required checks               | 所有仓内声明的 context 真实通过；PR 正文的 `PASS` 不是 check provenance                                  |
| **L2 独立审查**      | 非作者 reviewer 审 diff、契约、安全/合规和证据 | 独立 GitHub review；发现问题先修复并重验，不以 CI 绿替代判断                                             |
| **L3 用户授权**      | 产品负责人对当次 merge/release 作最终确认      | 必须是独立授权 provenance；PR 正文或机器人建议不能提供                                                   |
| **L4 合并/发布回执** | 合并执行者与 Release Owner                     | 按实际 `MERGE_COMMIT / SQUASH / REBASE` 记录 source、result、parents/mapping；pilot/GA 写 Release Bundle |

四层分别取证，任一层不能推导另一层。非技术决策卡只展示作者声明和解释；受信机器人会把用户授权门固定显示为 `NOT_AUTHORIZED`，直到外部授权流程提供独立 provenance。`nontechnical decision card freshness` 保留已配置的稳定 context 名称，但实现同时验证声明的新鲜度、exact head 绑定和完整性；它不是授权或合并建议：Draft 可非阻断展示 `CURRENT_UNVERIFIED`，非 Draft 的完整 `PASS / RECOMMEND_MERGE / MERGE` 声明必须失败，直到可信外部 provenance 另行取证。

## 仓内 required contexts 与外部 ruleset

唯一机器清单是 [`.github/required-contexts.json`](../../.github/required-contexts.json)。`pnpm governance:verify` 会把每个 context 绑定到声明 workflow 的一个唯一 job，确认 event 存在，并拒绝未在机器清单逐字登记的 job-level `if` 与任何 `continue-on-error`；当前唯一获准条件是 decision-card 对 GitHub default branch 的精确不变量。required job 的 `needs` 只能指向另一个 required job，避免 GitHub 把条件跳过、容错失败或未受保护的前置依赖显示成绿色。验证器同时拒绝放宽 CODEOWNERS/review/history 保护的仓内政策，并扫描 `.github/workflows/` 的全部外部 `uses:`：每个 action 必须绑定政策中的 40 位 commit SHA 并保留版本注释；新增 workflow 也不能逃过检查。CODEOWNERS 必须以完整治理 ownership block 结尾，防止后续规则覆盖政策、schema、verifier、RuntimeEvidence、Release Bundle、Gitleaks suppression 配置或 Provider SourceClass manifest。新增/改名 context、action 或治理路径必须同时更新 workflow、清单和 mutation tests。

仓库文件**不能配置或证明** GitHub ruleset 已生效。有管理员权限的人仍须在 GitHub 外部状态中：

1. 把清单中的全部 context 配为 required；
2. 至少要求一个 approving review、CODEOWNERS review、dismiss stale review 和 conversation resolution；
3. 禁止 force push 与 branch deletion；
4. 回读 ruleset/branch protection 与真实 PR checks，保存 URL/ID/时间作为外部配置证据。

若外部配置未完成或无法回读，状态必须写 `EXTERNAL_RULESET_NOT_VERIFIED`，不能因为仓内 JSON 存在就称保护已启用。

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
required-context bootstrap 死锁。

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
凭据。只有确实需要回写 PR comment 的受信 `pull_request_target` decision-card 和
Gitleaks workflow 保留最小的 `pull-requests: write`。CI 并发键同时包含 event
类型，防止 scheduled 全量视觉基线与 main push 验证因为共享 `refs/heads/main`
而互相取消；同一 PR 的旧 synchronize run 仍会被新 head 取消。

### CI 成本与有效保护面的迁移约束

Renderer 的 Vitest 被拆成始终执行的 `test:contracts` 与真实 Astro fixture build
`test:fixtures`。fixture build、三断点 byte-pinned visual gate 和多语言 smoke build
共享 `renderer visual scope`：renderer、整个 Site Builder contracts 目录、根依赖/
TypeScript 配置
或 CI workflow 变化时全部执行；schedule、manual、缺失/不可达 diff base 时也
fail-safe 全部执行；变更路径使用 NUL 分隔并禁用 rename folding（移动受控文件时
旧路径仍进入判定），diff 自身失败时同样全跑，不能降级成 `false`。无关 PR 只
跳过这三项重任务，不能跳过 renderer contract tests。
该拓扑由 `scripts/governance-ci-topology.spec.mjs` 进行确定性结构合同校验。

`build · typecheck · test` 是 live ruleset 已强制的 context，而它依赖的
`renderer visual scope` 尚未被 live ruleset 强制。为防 upstream failure 让 build
job 被 GitHub 标为 skipped，build job 固定以 policy 批准的 `always()` 启动，并在
任何 checkout 或仓库代码执行前验证 `needs.renderer-visual-scope.result` 必须为
`success`；failure、cancelled 或 skipped 一律显式失败。这个传播合同也受拓扑
结构合同保护。

当前 live ruleset 尚未强制 `governance · traceability · release`，所以
`docs:verify`、`memory:test` 与 `decision-card:test` 暂时仍保留在已受外部 ruleset
保护的 `build · typecheck · test` 内；不能为了减少重复执行而提前移走。只有在
governance context 经 PR/main canary 稳定、被外部 ruleset 实际设为 required 并
完成回读后，才可另开 PR 消除这部分重复。仓内 required-context 清单本身不能
证明这个外部迁移已完成。

## Release Bundle 的外部 provenance

Release Bundle 中的 `CHECK_RUN`、`GITHUB_REVIEW`、`SIGNED_AUTHORIZATION`、merge SHA/parent 和 `evidence_ref` 是待验证声明，不是自证。当前仓内尚无可信外部 readback verifier，所以 `external_provenance.status` 只能有效地表达 `EXTERNAL_UNVERIFIED`；对 `PILOT/GA`，验证器始终返回 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED`。仅把字段改为 `VERIFIED`或填入 URL 会追加 `RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED`，不能解锁 promotion。未来实现必须独立回读外部对象、绑定当次仓库/PR/head/actor/result 和 receipt，并另行审查；不开放由 bundle 调用者注入“已信任”的旁路。

## Codex 收口步骤

1. 按 [worktree 管理 runbook](worktree-management.md) 用 `pnpm worktree:new <topic>` 从最新 `origin/main` 建 `/global/backend/.codex/worktrees/<topic>` 与 `codex/<topic>`，一个逻辑改动一个 PR。
2. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 跑 lint/build/test；provider/采集/富集另附真源验证。
3. 开 PR 后等待 required-context 清单中的 CI、Security、Governance 与 decision-card freshness/integrity 语义门，触发独立 review，逐条处置 inline comment 并 resolve。
4. 向用户报告改动、风险、验证和未完成项；只在用户对当次 PR 明确授权后合并。
5. 合并后在 `/global/backend` 运行 `pnpm main:sync`，以 fetch 后解析出的 `origin/main` 精确 commit 做纯 fast-forward；若远端 PR/分支由另一会话处理，它只交接已合入的精确 SHA，本地会话仍独立 fetch 和验证，不从通知推导 merge 授权。`main:sync` 遇到 HOLD 时保留现场并单独审计，不 stash/reset/clean。功能分支与本地 worktree 默认保留用于复查。删除仅是可选空间清理，须满足 `CONTRIBUTING.md` 的提交已入主线、工作区干净且未跟踪文件归属已核清条件，并取得用户明确授权。

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
- GitHub 原生 auto-merge 不作为默认执行层。即使全绿，也要满足当次用户明确授权。
- 历史 changelog/实施记录中的「自审自合」、`feat/` 等保留当时 provenance，不覆盖现行规则。
