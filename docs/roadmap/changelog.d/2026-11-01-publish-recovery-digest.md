---
date: 2026-11-01
title: Fix the publication recovery path for the containerd image store
---

- 起因：第七班重发 run 41315984975 构建成功、推送成功，但 GHCR 标签可见性延迟超过 30 秒等待窗，resolve 返回 NOT_FOUND；同时发现「已发布镜像的恢复路径」里还有一处与 #719 同源的 `.Id == config 摘要` 断言，在 containerd 存储下同样会失败（恢复模式一旦触发即挂）。
- 改动：恢复路径改用与构建步骤相同的存储无关自校验（`.Id` 与 config 摘要不等时用 `docker save` 归档内 `manifest.json` 的 Config 条目比对）；发布步骤的 resolve 等待窗 30s→120s 以吸收 GHCR 标签可见性延迟。
- 测试：发布契约测试 `runtime-deployment-contract.spec.mjs` 全绿；下一次真实发布/恢复 run 验证。
- 未做：不改镜像内容、attestation 语义与发布产物；已推送的 ea9bbbbe…d1969948 标签保持原样，恢复模式会复用并补齐 attestation。
