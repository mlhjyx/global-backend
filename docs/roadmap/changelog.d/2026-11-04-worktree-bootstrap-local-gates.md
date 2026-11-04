---
date: 2026-11-04
title: Bootstrap new worktrees and scope pre-push gates by change type
---

- 起因：新 worktree 未装依赖时 pre-push 会静默跳过 `gctl check`，PR-1/2/3 的推送只跑了密钥扫描；`--fast` 又不含单测，本地验证实际覆盖率取决于人是否记得装依赖。
- 改动：
  - `scripts/create-worktree.mjs`：创建后自动 `gctl link-env` 并在后台执行 `pnpm install --frozen-lockfile --prefer-offline`（`WORKTREE_SKIP_INSTALL=1` 可跳过），装完前推送会被 pre-push 明确拦截。
  - 开发过程新增 §2B-2「本地验证阶梯」：纯文档 → verify-docs；代码 → `gctl check --fast` + affected 单测；DB/迁移 → 一次性库 service 组；联调 → 源码热重载；重型制品门留给 CI/发布。
  - 工作区 pre-push 钩子（`local-config/bin/git-hooks/pre-push`）按改动范围选门：纯文档只跑 verify-docs；代码缺依赖时 fail-closed；代码跑 `gctl check --fast` + `vitest related`（≤30 个改动源文件）；`GLOBAL_PREPUSH_FULL=1` 仍可升全量。
- 测试：`node --check scripts/create-worktree.mjs`；`node scripts/verify-docs.mjs`；钩子 `bash -n`。
- 未做：本地不构建运行镜像（build-once + 构建证明只在发布工作流）；affected 单测的阈值待真实 PR 观察后再调。
