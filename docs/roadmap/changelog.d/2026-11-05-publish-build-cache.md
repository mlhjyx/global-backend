---
date: 2026-11-05
pr: 813
title: Share the GHCR layer cache with the runtime image publication build
---

- 起因：2026-11-05 热修发车时 `publish-runtime-image` 的构建在 apt 层被 snapshot 源的 503 卡死——发布工作流从未接过层缓存，每次发布都是冷构建，把「能否发车」继续押在 Debian 快照源的运气上（同一天 ci.yml 已由 #811 接入 registry 缓存并验证生效）。
- 改动：发布构建改为 `docker buildx build --load`，与 ci.yml 共用同一个 GHCR 缓存 manifest（`ghcr.io/mlhjyx/global-backend-buildcache:runtime-image`，`mode=max`，`ignore-error=true`）；构建步骤先 `docker login ghcr.io`（token 仍为 `secrets.GITHUB_TOKEN`）；`--provenance=false`/`--sbom=false` 与后续 `docker save`／config 摘要校验契约全部保留。
- 测试：`runtime-deployment-contract.spec.mjs`（GHCR 发布契约：单清单、publish-once、digest 回读、最小权限）全过；YAML 解析验证。端到端验证由下一次发布执行——缓存命中时构建日志应出现 `importing cache manifest` 且 apt 层跳过下载。
- 未做：不改发布协议与推送路径（仍走 `docker push` + resolve 回读 digest）；不改权限块。
