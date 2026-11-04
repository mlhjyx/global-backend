---
date: 2026-11-05
pr: 810
title: Harden the OCI build against Debian archive outages
---

- 起因：2026-11-04 起 snapshot.debian.org 全球故障（503/504、No healthy backends），而 OCI 构建要从固定日期的快照源下载约 206 MB 包：三个 PR 的构建作业在下载里挂死 3 小时以上，作业没有超时只能等 GitHub 默认 6 小时上限，并且每次构建都从零重下。
- 改动：
  - Dockerfile 的 Debian 快照源换成 Debian 官方运营的 Cloudflare 前端 `snapshot-cloudflare.debian.org`：归档字节、时间戳与 Release 签名完全相同，只是 CDN 路径不同；回退就是把主机名换回 `snapshot.debian.org`。
  - apt 的 update 与 install 都加 30 秒连接超时（保留 Retries=3）：源变慢时快速失败，不再无限挂起。
  - `build-test` 作业加 `timeout-minutes: 60`：外部依赖卡死时最多一小时就会被杀，不再拖到 6 小时。
  - OCI 构建改用 `docker buildx`，层缓存写入 Actions 缓存服务（`type=gha`, `mode=max`；fork PR 只读不写）：重复构建复用 runtime-base（Debian 包、chromium）与构建层，不再每次重下归档。
  - 治理测试 `scripts/runtime-artifact-contract.spec.mjs` 同步钉住新主机名与新的 apt 参数；其余供应链约束不变（https、固定时间戳、精确包版本、禁 trust-bypass）。
- 测试：governance 相关 specs 58 项全过；Dockerfile 与 ci.yml 的完整验证由本 PR 的 CI 执行（ci.yml 改动会跑全部重门）。
- 未做：不改本机网络代理或任何运行配置；新源随下一次镜像班车生效。
