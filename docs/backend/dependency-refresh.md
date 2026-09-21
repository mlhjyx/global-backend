# 依赖刷新 runbook

> 生命周期：`GUIDE`
> 生命周期依据：依赖刷新 runbook（#550 起）

> 适用：每月一次的批量依赖升级、Dependabot 安全更新 PR、生产漏洞基线到期前的续期。安全合同本身以 [供应链安全门](../security/README.md) 为准，本文只写操作顺序。

## 1. 为什么不让 Dependabot 自动开版本更新 PR

依赖或 GitHub Action 的任何变动都会连带三处 Dependabot 改不了的受控文件：

- **Copy fixed-source 回执**：`package.json`、`pnpm-lock.yaml`、`packages/db/prisma/schema.prisma` 等 13 个文件受内容指纹绑定，改动后 `governance · traceability · release` 以 `COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH` 失败，须重签回执。
- **Action pin**：`.github/required-contexts.json` 的 `workflow_action_pins` 逐个记录 action 的精确 commit，升级 action 必须同步。
- **生产漏洞基线的锁文件绑定**：`docs/security/production-dependency-audit-baseline.json` 的 `source.lockfile_digest` 必须等于当前 `pnpm-lock.yaml` 的摘要。PR 上不会失败（PR 检查读受信 base 的基线），但合入后 main 的 `production advisory baseline freshness · canary` 以 `BASELINE_SOURCE_LOCK_MISMATCH` 变红，直到基线重新绑定。2026-09-19/20 依赖 PR 连续合入后 main 连红 7 次即此原因。

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
rm -rf node_modules apps/*/node_modules packages/*/node_modules
pnpm install --frozen-lockfile                   # 按 CI 的方式重装：update 会额外链接 .bin，使部分测试本地假失败
pnpm audit --prod --registry=https://registry.npmjs.org --json   # 与基线 source.command 一致；目标零 advisory
node scripts/supply-chain-source-policy.mjs validate-sources --repository-root .
node scripts/copy-fixed-source-impact-resign.mjs # 只重签指纹；资格字段变化会拒绝
pnpm governance:verify
pnpm --filter @global/api build && pnpm --filter @global/api test
```

- 大版本升级（`dependabot.yml` 的 `ignore` 清单：astro、`@nestjs/*`、fast-xml-parser、`@types/node`）不进批量 PR，各自单独立项。
- Action 升级：只从官方仓库的 tag 只读解析完整 commit SHA，同时更新 workflow 里的 `uses:` 与 `required-contexts.json` 的 pin，由 `pnpm governance:verify` 校验两边一致。
- **锁文件变了就必须在同一 PR 重新绑定漏洞基线**（见第 4 节），否则合入后 main 变红。
- `copy-fixed-source-impact-resign.mjs` 报 `COPY_RESIGN_ELIGIBILITY_CHANGED` 时，说明改动影响的不只是哈希（状态、漂移文件集合或 stale scope 变了）：先查明原因，确属预期再加 `--accept-eligibility-change`。

## 4. 漏洞基线续期

基线是限时治理账，不是豁免。两种情形：

- **锁文件变动后的重新绑定**（每个改了 `pnpm-lock.yaml` 的 PR）：先提交锁文件改动，再对**该提交**执行上面的审计命令，把 `source.base_commit`、`bootstrap.base_commit` 设为该提交，`source.lockfile_digest` 设为 `sha256:` 加 `pnpm-lock.yaml` 的 SHA-256，更新 `source.captured_at`；审计结果若有变化，同步 `advisories` / `exposure` / `summary`。`governance.valid_until` 不变。同时更新 `scripts/supply-chain-gates.spec.mjs` 里钉住的基线提交、锁文件摘要与 `REPOSITORY_BASELINE_NOW`（`captured_at` 加 1 秒），并把同一审计在旧、新绑定下的 `baseline-freshness` 结果存为 `docs/evidence/security/` 下的冻结回执。先例：#544 与 2026-09-21 开发依赖告警刷新。
- **到期续期**：在 `governance.valid_until` 之前另设新的到期时间（惯例约两周），同时按上一条重新绑定。先例：#542 及其证据 [`20260920-baseline-refresh.json`](../evidence/security/20260920-baseline-refresh.json)。

本地验证：`verify` 对照基线做生产审计（应为 `PASS_CLEAR`），但不检查锁文件绑定；绑定要用与 main 上 `production advisory baseline freshness · canary` 相同的 `baseline-freshness`（应为 `FRESH`）：

```bash
node scripts/supply-chain-audit.mjs verify
pnpm audit --prod --registry=https://registry.npmjs.org --json > /tmp/audit.json
node scripts/supply-chain-audit.mjs baseline-freshness \
  --baseline docs/security/production-dependency-audit-baseline.json \
  --audit-file /tmp/audit.json --subject-commit "$(git rev-parse HEAD)" \
  --lockfile-digest "sha256:$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)" \
  --verifier-digest "sha256:$(sha256sum scripts/supply-chain-audit.mjs | cut -d' ' -f1)" \
  --source-policy-digest "sha256:$(sha256sum scripts/supply-chain-source-policy.mjs | cut -d' ' -f1)" \
  --audit-digest "sha256:$(sha256sum /tmp/audit.json | cut -d' ' -f1)" \
  --observed-at "$(date --utc +%Y-%m-%dT%H:%M:%SZ)"
pnpm governance:verify
```

## 5. Dependabot 安全更新 PR

安全更新 PR 会改锁文件，因此同样要处理 Copy 指纹**和**漏洞基线：检出该分支，运行 `node scripts/copy-fixed-source-impact-resign.mjs`，按第 4 节重新绑定基线，推送后再按正常 PR 流程合入。推送后 Dependabot 不再自动 rebase 该分支，main 前进时需手动更新。
