---
date: 2026-11-04
title: Skip code gates on docs-only pull requests
---

- 起因：纯文档 PR 仍无条件跑 prisma generate、lint、build、零容器单测与 PostgreSQL 重门，`build · typecheck · test` 固定约 7 分钟；只有 `docs:verify` 是文档 PR 真正需要的门。
- 改动：
  - `renderer-visual-scope` 增加 `run_code` 输出：仅当**所有**改动都落在 `docs/*`、根 Markdown 文档（README/AGENTS/CLAUDE/CONTRIBUTING）与代理元数据目录（`.claude/.agents/.codex/.superpowers`）时为 false；`.github/`、`scripts/`、锁文件与任何代码路径一律为 true；diff 失败、定时与手动触发 fail-closed 为 true。
  - `build · typecheck · test` 的 18 个代码步骤与 `contracts` job 以 `needs.renderer-visual-scope.outputs.run_code != 'false'` 短路——默认运行，只有分类器**显式**判定纯文档才跳过；`docs:verify`、Copy 影响评估、tree-cleanliness 始终运行。
  - 机器合同 `governance-ci-topology.spec.mjs` 的 scope 用例表加入 run_code 期望（含 `.github/workflows/security.yml` 算代码这条自掩蔽防护），并锁定「默认运行」的 `!= 'false'` 语义。
- 测试：`node --test scripts/governance-ci-topology.spec.mjs` 12/12；`node scripts/verify-docs.mjs` PASS；`ci.yml` YAML 解析通过。
- 未做：不引入 affected 依赖图 / 远程缓存与 merge queue（当前规模不值）；不拆分渲染器视觉回归 job（总墙钟不变）。
