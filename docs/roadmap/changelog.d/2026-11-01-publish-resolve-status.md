---
date: 2026-11-01
title: Retry the GHCR digest read-back by status, not by exit code
---

- 起因：`ghcr-runtime-publication.mjs resolve` 对 FOUND/NOT_FOUND 都返回退出码 0（NOT_FOUND 只打印 `{"status":"NOT_FOUND"}` 并写 `exists=false`），上一版的 `if resolve; then` 重试因此只跑一轮就放行，随后空的 `image_reference` 让断言失败。GHCR 标签可见性延迟实测可超过 60 秒。
- 改动：重试循环改为解析 resolve 的 stdout 状态字段——最多 4 轮（每轮 60s 等待 + 15s 间隔），看到 `"status":"FOUND"` 才放行。
- 测试：发布契约测试 18/18 绿；下一次真实发布 run 验证。
- 未做：不改 resolve 脚本的输入/退出契约，不改镜像内容与 attestation 语义。
