# CI / 审查与合并流程（Codex）

> 2026-07-16 起，当前开发与复核主体是 Codex。旧 Claude `merge-judge` workflow 已退役；不再使用 AI auto-merge。权威简版见 [AGENTS.md §8](../../AGENTS.md)。

## 合并模型

| 层 | 责任 | 硬门 |
|---|---|---|
| **L1 机械闸** | GitHub ruleset + CI + gitleaks + review threads | 所有必需检查绿，线程 resolved，不得强推 `main` |
| **L2 Codex 审查** | 审 diff、契约、安全/合规、真库/真源证据 | 发现问题必须先修复并重验，不以「CI 绿」替代风险判断 |
| **L3 合并授权** | 用户作最终确认 | Codex 不得自行合并；用户必须对当次 PR 明确授权 |

## Codex 收口步骤

1. 从最新 `main` 建 `codex/<topic>`，一个逻辑改动一个 PR。
2. 按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 跑 lint/build/test；provider/采集/富集另附真源验证。
3. 开 PR 后等待 `CI` 和 `Security`，触发 Codex review，逐条处置 inline comment 并 resolve。
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
