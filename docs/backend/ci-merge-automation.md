# CI / 合并自动化：merge-judge（合并就绪判官）

> 目标：**不用人一直手动判断/点合并**，但也**不让敏感改动裸奔进 main**。
> 三层防护 + 风险分级：绿灯**且**低风险才自动合；高风险永远升级到人。

## 三层架构

| 层 | 作用 | 现状 |
|---|---|---|
| **L1 机械闸**（分支保护 ruleset `protect-main`） | PR 必需 + CI(lint/build/test) + gitleaks + 审查线程 resolved + 禁强推/禁删 main | ✅ 已启用 |
| **L2 AI 判官**（merge-judge） | 审 diff → **风险分级** → 批准(低危) / 标 `needs-human`(高危) / HOLD(闸未绿) | C 已用 / B 待启 |
| **L3 合并执行** | GitHub 原生 auto-merge：低危+闸绿自动合；高危挂起等人 | 随 B 启用 |

## 风险分级策略（判官的核心规则）

**🟢 低风险 → 判官批准 → 可自动合**
- 文档 / `chore` / CI 配置 / 依赖补丁
- 纯新增、隔离的 provider/adapter + 其单测
- 不触碰：DB schema、RLS、鉴权、合规、对外抓取、无大量删除

**🔴 高风险 → 判官标 `needs-human`，不自动合（即便闸全绿）**
- `packages/db/prisma/migrations/**` 或 `schema.prisma` 变更（**DB 迁移**）
- RLS / 鉴权 / 权限 / workspace 隔离 逻辑
- GDPR / 个人数据分级 / suppression / lawful-basis（合规红线，见 [buyer-intelligence-v3.md §10.3](buyer-intelligence-v3.md)）
- 对外抓取 / SSRF / source_policy / ToolBroker 闸门
- 大量删除、禁用/删除测试、密钥类改动

**HOLD**：任一必需检查未绿、或有未 resolved 审查线程 → 不合，等修复。

### 自动升级规则（路径/关键词触发，判官必守）

风险分级不能靠"感觉"。判官（人或 CI）拿到 `git diff origin/main...HEAD --name-only` 后，**只要命中下表任一路径 glob 或关键词，一律强制 `needs-human` + 关闭 auto-merge**（即便 CI 全绿）——这是机械底线，不容判官酌情放行。命不中才进入低危自动合通道。

| 触发（路径 glob / 关键词） | 命中即 | 对应 CONTRIBUTING 级别 |
|---|---|---|
| `packages/db/prisma/schema.prisma`、`packages/db/prisma/migrations/**` | `needs-human` | 实质 |
| diff 含 `RLS`、`current_workspace_id`、`set_config`、`app_user`、`policy`（鉴权/租户隔离） | `needs-human` | 实质 |
| diff 含 `JWKS`、`token`、`auth`、`role`、`workspace` 逻辑改动 | `needs-human` | 实质 |
| diff 含 `personalData`、`lawful`、`suppression`、`GDPR`、`Art.17`、`LIA`、`DPIA`（合规红线） | `needs-human` | 实质 |
| `source_policy`、`ToolBroker`、`SSRF`、`robots`、对外抓取适配器新增/改动 | `needs-human` | 实质 |
| 单 PR 删除 > 200 行、或删除/禁用测试文件 | `needs-human` | 实质 |
| `packages/contracts/**`（跨 app 共享契约，改一处两端受影响） | `needs-human` | 实质 |

**落地方式**：C 方案（会话判官）按上表 `--name-only` + `git diff` 关键词扫；B 方案（CI 判官）把上表写进 judge prompt 的 hard-rule 段。命中即打 GitHub label `needs-human` 并**不**执行 `gh pr merge --auto`。上表与 [CONTRIBUTING.md](../../CONTRIBUTING.md) 的「PR 粒度分级」实质级对齐——两处改动需同步。

> 判官**只判断、只评论/批准，从不自己 merge**；合并由 L3 的 auto-merge（低危）或人（高危）完成。

## 实现选项

### C —— Claude Code 会话当判官（现在在用，零配置零成本）
用现有 `gh` 授权，按需或定时跑一个判官 agent：拉开放 PR → `gh pr checks` + 查 review threads + `git diff origin/main...` 风险扫描 → 产出结构化裁决（decision/risk_tier/blocking/high_risk）。低危可 `gh pr merge --squash`，高危评论 `needs-human`。
- 触发：人工调用，或 `/schedule`(cron) 定时扫开放 PR。
- 判官 prompt 见本仓会话记录（已在 PR #1 实跑，裁决 NEEDS_HUMAN——正确识别 migration+GDPR+SSRF 高敏面）。

### B —— Claude 进 CI（事件驱动、全自动，长期推荐）
`.github/workflows/claude-merge-judge.yml`（已随本 PR 提交，**无 key 时自动跳过**）。每次 PR opened/synchronize 触发 Claude 按上面风险策略审+批准/挡，配合 auto-merge = 真正不用人管。
**启用步骤**（任一）：
1. 安装 **Claude GitHub App**（在 GitHub 仓库 → Settings → GitHub Apps，或 Claude Code 里 `/install-github-app`），浏览器授权一次；或
2. 仓库 → Settings → Secrets and variables → Actions → 新增 secret **`ANTHROPIC_API_KEY`**。
   同时开 repo 的 **Allow auto-merge**（Settings → General → Pull Requests）。
- 成本：走 Claude 订阅（App）或 API 用量（key）。
- 注：`anthropics/claude-code-action` 的输入项可能随版本变化，启用前对照其 README 校准一次。

### A —— 仅原生 auto-merge（无 AI 判断）
Settings → General 开 Allow auto-merge，PR 上 `gh pr merge <n> --auto --squash`：闸绿即自动合。最省事但**不分风险**——高危改动也会自动合，故仅作 B 的执行层，不单用。

## 自动化程度（当前策略）

- **低危 PR**：判官批准 + auto-merge → 无人工。
- **高危 PR**：判官标 `needs-human` + 评论 → 人复核后手动合（或补一次人工 Approve）。
- 团队增至 ≥2 活跃开发后：把分支保护 `required_approving_review_count` 调 **1**（强制一名同事 Approve），进一步收紧。

## 分支 / PR 纪律（配套）

- **一功能一小 PR**（PR #1 是「地基」大 PR 的例外）：更易审、CI 更快、回滚更细、判官分级更准。
- 分支 `feat/` `fix/` `docs/` `chore/`；Conventional Commits；从最新 main 切。
- 见 [CONTRIBUTING.md](../../CONTRIBUTING.md) 与 [CLAUDE.md §8](../../CLAUDE.md)。
