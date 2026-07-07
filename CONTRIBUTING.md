# 贡献指南（团队协作流程）

> 面向团队成员与 Claude Code 会话。权威简版另见 [CLAUDE.md §8](CLAUDE.md)。

## 分支

- **不在 `main` 上直接提交**。`main` 受保护，只经 PR 合入。
- 功能分支：`feat/<topic>`、修复 `fix/<topic>`、文档 `docs/<topic>`，从最新 `main` 切出。

## 提交信息（Conventional Commits）

`type(scope): 摘要` —— `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf`。
正文说清「为什么 + 如何验证」。

## 本地必绿（提 PR 前）

```bash
pnpm install
pnpm --filter @global/db generate          # schema 变更后
pnpm --filter @global/api build            # nest build = tsc 全量类型检查
pnpm --filter @global/api test             # vitest
```

**provider / 采集 / 富集类改动**：另需**真实数据实测**（无 sandbox，见 [CLAUDE.md §5](CLAUDE.md)）：

```bash
cd apps/api && node --import tsx scripts/verify-*.mts
```

## Pull Request

- `gh pr create --base main`，按 `.github/pull_request_template.md` 填（概述 / 改动分组 / 测试 / 合规 / 待续）。
- **CI 必须绿**才可合：
  - `CI`（`.github/workflows/ci.yml`）：install → prisma generate → build → test。
  - `Security`（`.github/workflows/security.yml`）：gitleaks 密钥扫描。
- **代码审查**：仓库启用了 Codex 自动审查（开 PR / 标 ready / 评论 `@codex review` 触发）。处置每条 inline 意见后在该线程回复并 resolve。
- CI 只跑**纯单测**（无 DB/网络）；需要 DB/真源的验证走本地 `verify-*` 脚本，不进 CI。

## 合规红线（涉数据源/联系人）

数据分级 🟢公司事实(可商用) / 🟡职能邮箱(ePrivacy) / 🔴人名·联系人(默认隔离 + LIA)。
抓取守 robots/ToS；「法定公开 ≠ 可自由再分发」。详见 [buyer-intelligence-v3.md](docs/backend/buyer-intelligence-v3.md)。
