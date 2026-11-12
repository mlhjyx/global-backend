---
date: 2026-11-12
title: Split OCI, renderer visual and Go race gates into parallel required jobs
---

- 起因：2026-11-12 审计 P2-2：`build · typecheck · test` 单 job 串行执行 38 个步骤（install → 构建 → 单测 → PostgreSQL 套件 → OCI 镜像 → 渲染视觉 → Go race），任一失败整 job 重跑，CI p50 10.1 / p90 26.9 分钟，且 OCI/视觉/Go 三个重门在代码 PR 上把关键路径拉长 10–15 分钟。
- 改动：拆出三个并行 job 并登记为独立必需检查——`OCI runtime image · smokes`（镜像构建+三项冒烟）、`renderer visual · qualified`（视觉回归/fixture 矩阵/多语冒烟）、`temporal reader · Go race`；原 `build · typecheck · test` 保留文档门、构建、单测、PostgreSQL 语义套件、attestation 与 tree-clean。四个 job 都在每个 PR 上运行，仅步骤级 `if` 按 scope 跳过（不会出现 skipped 必需检查）；均以 `!cancelled()` 启动且在 checkout 前验证 scope 成功。`required-contexts.json` 与 `ci-merge-automation.md` 同步登记；live ruleset 加入三个新必需检查并回读。
- 测试：本 PR 自身即全量验证（ci.yml 变更触发全部重门），确认八个必需检查名称与状态；`pnpm governance:verify`。
- 未做：不拆 `build-test` 内部的 PostgreSQL 语义套件与单测（两者共享 service Postgres 与构建产物，继续留在原 job）；不动 `contracts`/`db tests` job。
