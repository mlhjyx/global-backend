# CI / 审查与合并流程（Codex）

> 2026-07-16 起，当前开发与复核主体是 Codex。旧 Claude `merge-judge` workflow 已退役；不再使用 AI auto-merge。权威简版见 [AGENTS.md §8](../../AGENTS.md)。

## 合并模型

| 层 | 责任 | 硬门 |
|---|---|---|
| **L1 机械闸** | GitHub ruleset + required checks | 所有仓内声明的 context 真实通过；PR 正文的 `PASS` 不是 check provenance |
| **L2 独立审查** | 非作者 reviewer 审 diff、契约、安全/合规和证据 | 独立 GitHub review；发现问题先修复并重验，不以 CI 绿替代判断 |
| **L3 用户授权** | 产品负责人对当次 merge/release 作最终确认 | 必须是独立授权 provenance；PR 正文或机器人建议不能提供 |
| **L4 合并/发布回执** | 合并执行者与 Release Owner | 按实际 `MERGE_COMMIT / SQUASH / REBASE` 记录 source、result、parents/mapping；pilot/GA 写 Release Bundle |

四层分别取证，任一层不能推导另一层。非技术决策卡只展示作者声明和解释；受信机器人会把用户授权门固定显示为 `NOT_AUTHORIZED`，直到外部授权流程提供独立 provenance。

## 仓内 required contexts 与外部 ruleset

唯一机器清单是 [`.github/required-contexts.json`](../../.github/required-contexts.json)。`pnpm governance:verify` 会确认每个 context 在声明的 workflow 中以 job 名存在、该 workflow 订阅预期 PR event，并拒绝放宽 CODEOWNERS/review/history 保护的仓内政策。新增/改名 context 必须同时更新 workflow、清单和 mutation tests。

仓库文件**不能配置或证明** GitHub ruleset 已生效。有管理员权限的人仍须在 GitHub 外部状态中：

1. 把清单中的全部 context 配为 required；
2. 至少要求一个 approving review、CODEOWNERS review、dismiss stale review 和 conversation resolution；
3. 禁止 force push 与 branch deletion；
4. 回读 ruleset/branch protection 与真实 PR checks，保存 URL/ID/时间作为外部配置证据。

若外部配置未完成或无法回读，状态必须写 `EXTERNAL_RULESET_NOT_VERIFIED`，不能因为仓内 JSON 存在就称保护已启用。

## Codex 收口步骤

1. 按 [worktree 管理 runbook](worktree-management.md) 用 `pnpm worktree:new <topic>` 从最新 `origin/main` 建 `/global/backend/.codex/worktrees/<topic>` 与 `codex/<topic>`，一个逻辑改动一个 PR。
2. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 跑 lint/build/test；provider/采集/富集另附真源验证。
3. 开 PR 后等待 required-context 清单中的 CI、Security、Governance 与 decision-card freshness，触发独立 review，逐条处置 inline comment 并 resolve。
4. 向用户报告改动、风险、验证和未完成项；只在用户对当次 PR 明确授权后合并。
5. 合并后确认 `main` 跟随 `origin/main`；功能分支与本地 worktree 默认保留用于复查。删除仅是可选空间清理，须满足 `CONTRIBUTING.md` 的提交已入主线、工作区干净、未跟踪文件归属已核清条件，并取得用户明确授权。

## 风险分级（决定验证深度，不授予自动合并）

| 触发 | 必要复核 |
|---|---|
| `schema.prisma` / migrations / RLS | 真 PostgreSQL 迁移、回退/兼容性、租户隔离与 owner/app_user 权限 |
| JWKS / token / role / workspace | 鉴权负向用例、跨租户与权限边界 |
| `personalData` / GDPR / LIA / suppression / Art.17 | 数据分级、lawful basis、删除/抑制时序与审计证据 |
| source_policy / ToolBroker / SSRF / robots / 对外抓取 | 真源正例 + SUSPENDED/private/metadata/redirect 反例，不把 robots 当 SSRF |
| `packages/contracts/**` | 生产者/消费者同步、OpenAPI drift/lint/breaking 门 |
| 大量删除或删/禁测试 | 逐文件说明去留理由，验证覆盖未倒退 |

## 退役记录

- `.github/workflows/claude-merge-judge.yml` 已删除；不再需要 `ANTHROPIC_API_KEY` 或 Claude GitHub App 作合并判官。
- GitHub 原生 auto-merge 不作为默认执行层。即使全绿，也要满足当次用户明确授权。
- 历史 changelog/实施记录中的「自审自合」、`feat/` 等保留当时 provenance，不覆盖现行规则。
