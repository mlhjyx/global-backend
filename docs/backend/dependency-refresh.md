# 依赖刷新 runbook

> 适用：每月一次的批量依赖升级、Dependabot 安全更新 PR、生产漏洞基线到期前的续期。安全合同本身以 [供应链安全门](../security/README.md) 为准，本文只写操作顺序。

## 1. 为什么不让 Dependabot 自动开版本更新 PR

依赖或 GitHub Action 的任何变动都会连带两处 Dependabot 改不了的受控文件：

- **Copy fixed-source 回执**：`package.json`、`pnpm-lock.yaml`、`packages/db/prisma/schema.prisma` 等 13 个文件受内容指纹绑定，改动后 `governance · traceability · release` 以 `COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH` 失败，须重签回执。
- **Action pin**：`.github/required-contexts.json` 的 `workflow_action_pins` 逐个记录 action 的精确 commit，升级 action 必须同步。

因此版本更新 PR 结构性必挂（截至 2026-09-21，76 个 Dependabot PR 中 56 个未合即关）。`.github/dependabot.yml` 现以 `open-pull-requests-limit: 0` 关闭版本更新，只保留安全更新；常规升级改为下述每月批量 PR。

## 2. 节奏与硬期限

- **每月一次**批量 PR，覆盖 npm 与 GitHub Actions。
- **硬期限**：必须在 `docs/security/production-dependency-audit-baseline.json` 的 `governance.valid_until` **之前**合入续期。过期后所有 PR 的 `production dependency delta · canary` 都会失败，包括续期 PR 自身（它读取受信 base 上已过期的基线）。这也是该检查不能设为 required 的原因。

## 3. 批量升级

```bash
pnpm worktree:new deps-refresh-YYYYMMDD
cd /global/backend/.codex/worktrees/deps-refresh-YYYYMMDD
pnpm install --frozen-lockfile
pnpm update -r                                   # 范围内的 minor / patch
pnpm audit --prod                                # 目标：零 production advisory
node scripts/supply-chain-source-policy.mjs validate-sources --repository-root .
node scripts/copy-fixed-source-impact-resign.mjs # 只重签指纹；资格字段变化会拒绝
pnpm governance:verify
pnpm --filter @global/api build && pnpm --filter @global/api test
```

- 大版本升级（`dependabot.yml` 的 `ignore` 清单：astro、`@nestjs/*`、fast-xml-parser、`@types/node`）不进批量 PR，各自单独立项。
- Action 升级：只从官方仓库的 tag 只读解析完整 commit SHA，同时更新 workflow 里的 `uses:` 与 `required-contexts.json` 的 pin，由 `pnpm governance:verify` 校验两边一致。
- `copy-fixed-source-impact-resign.mjs` 报 `COPY_RESIGN_ELIGIBILITY_CHANGED` 时，说明改动影响的不只是哈希（状态、漂移文件集合或 stale scope 变了）：先查明原因，确属预期再加 `--accept-eligibility-change`。

## 4. 漏洞基线续期

基线是限时治理账，不是豁免。续期 PR 须把 `production-dependency-audit-baseline.json` 绑定到新的 base commit 与锁文件摘要、更新 `captured_at`，并设置新的 `valid_until`（惯例约两周）。先例见 #542 及其证据 [`20260920-baseline-refresh.json`](../evidence/security/20260920-baseline-refresh.json)。本地验证：

```bash
node scripts/supply-chain-audit.mjs verify
pnpm governance:verify
```

## 5. Dependabot 安全更新 PR

安全更新 PR 同样会碰到 Copy 指纹。处理方式：检出该分支，运行 `node scripts/copy-fixed-source-impact-resign.mjs` 并推送这一提交，再按正常 PR 流程合入。推送后 Dependabot 不再自动 rebase 该分支，main 前进时需手动更新。
