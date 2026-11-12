---
date: 2026-11-12
title: Stop running governance verification twice per pull request
---

- 起因：2026-11-12 审计 P2-1：`docs:verify` 内含 `pnpm governance:verify`，而 CI 的 `build · typecheck · test` 与 `governance · traceability · release` 两个 job 各跑一次，每个 PR 重复执行约 3.5 分钟的治理测试与检查。
- 改动：`docs:verify` 只保留文档相关步骤（模型候选基线、contracts build、candidate registry、`verify-docs`、judgment eval）；`governance:verify` 由独立的 governance required context 承担；`docs-verification.md` §1 同步新语义；本地 `gctl check` 改为依次运行两者（行为不变）。
- 测试：`pnpm docs:verify`、`pnpm governance:verify`、`gctl check --fast`；Copy 回执重签（HASH_ONLY）。
- 未做：不改 workflow 文件本身（两个 job 的职责不变，只是去掉重复执行）；不拆 `build-test` 巨型 job（P2-2，单独工作流）。
