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

唯一机器清单是 [`.github/required-contexts.json`](../../.github/required-contexts.json)。`pnpm governance:verify` 会确认每个 context 在声明的 workflow 中以 job 名存在、该 workflow 订阅预期 PR event，并拒绝放宽 CODEOWNERS/review/history 保护的仓内政策。它还扫描 `.github/workflows/` 的全部外部 `uses:`：每个 action 必须绑定政策中的 40 位 commit SHA 并保留版本注释；新增 workflow 也不能逃过检查。CODEOWNERS 必须以完整治理 ownership block 结尾，防止后续规则覆盖政策、schema、verifier、RuntimeEvidence 或 Release Bundle。新增/改名 context、action 或治理路径必须同时更新 workflow、清单和 mutation tests。

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

## Release Bundle 的外部 provenance

Release Bundle 中的 `CHECK_RUN`、`GITHUB_REVIEW`、`SIGNED_AUTHORIZATION`、merge SHA/parent 和 `evidence_ref` 是待验证声明，不是自证。当前仓内尚无可信外部 readback verifier，所以 `external_provenance.status` 只能有效地表达 `EXTERNAL_UNVERIFIED`；对 `PILOT/GA`，验证器始终返回 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED`。仅把字段改为 `VERIFIED`或填入 URL 会追加 `RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED`，不能解锁 promotion。未来实现必须独立回读外部对象、绑定当次仓库/PR/head/actor/result 和 receipt，并另行审查；不开放由 bundle 调用者注入“已信任”的旁路。

## Codex 收口步骤

1. 按 [worktree 管理 runbook](worktree-management.md) 用 `pnpm worktree:new <topic>` 从最新 `origin/main` 建 `/global/backend/.codex/worktrees/<topic>` 与 `codex/<topic>`，一个逻辑改动一个 PR。
2. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 跑 lint/build/test；provider/采集/富集另附真源验证。
3. 开 PR 后等待 required-context 清单中的 CI、Security、Governance 与 decision-card freshness/integrity 语义门，触发独立 review，逐条处置 inline comment 并 resolve。
4. 向用户报告改动、风险、验证和未完成项；只在用户对当次 PR 明确授权后合并。
5. 合并后确认 `main` 跟随 `origin/main`；功能分支与本地 worktree 默认保留用于复查。删除仅是可选空间清理，须满足 `CONTRIBUTING.md` 的提交已入主线、工作区干净、未跟踪文件归属已核清条件，并取得用户明确授权。

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
