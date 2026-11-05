---
date: 2026-11-05
pr: 811
title: Move the OCI build layer cache to a GHCR registry manifest
---

- 起因：#810 引入的 `type=gha` 层缓存**静默失效**——2026-11-05 核实：Actions 缓存清单 121 条全部是 codeql/node/gitleaks，没有任何 buildx 条目；main 成功构建的日志里没有 cache 导入/导出段；#805 的重跑仍然完整下载了 772 秒的包。托管 runner 的 Actions 缓存服务（v2）与 runner 自带 buildx 的 gha 后端不兼容，`ignore-error=true` 把初始化失败一并吞掉了。
- 改动：OCI 构建的层缓存改为 `type=registry`，写入 `ghcr.io/mlhjyx/global-backend-buildcache:runtime-image`（`mode=max`）：不依赖 Actions 缓存服务，也没有 gha 的分支作用域问题（任何分支可读同一 manifest，可写受 fork 保护）；`build-test` 作业级增加 `packages: write`（workflow 级 permissions 块保持原样）；非 fork 的 run 登录 ghcr 读写缓存，fork PR 跳过（只读 token 读不到私有包）；构建后校验缓存 manifest 存在，缺失时发 `::warning::` 而不是红构建。
- 测试：governance 相关 specs 全过（含 workflow 级 `permissions: contents: read` 的钉扎断言——job 级权限不触碰它）；`ci.yml` YAML 解析验证。端到端验证由本 PR 的 CI 执行：它的构建导出第一份 registry 缓存 manifest，之后对同一分支的重跑应出现缓存命中（构建日志出现 `importing cache manifest`）。
- 未做：不动 Dockerfile（#810 的 Cloudflare 前端切换保持有效）；不改发布镜像工作流（它不参与层缓存）。
