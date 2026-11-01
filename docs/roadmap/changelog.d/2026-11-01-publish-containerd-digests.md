---
date: 2026-11-01
title: Make the runtime image publication checks independent of the Docker storage driver
---

- 起因：第七班发布 run 41311045932 两次在同一步失败——镜像构建成功，但推送前本地校验静默退出 1。根因：GitHub runner 切换到了 containerd 镜像存储，`docker image inspect .Id` 从 config 摘要变为 manifest 摘要，而 workflow 的断言假设二者相等（6 小时前同流程在 classic 存储上成功）。
- 改动：发布 workflow 改为存储驱动无关的身份校验——构建步骤额外产出 config 摘要并在 `.Id` 与 config 摘要不等时用 `docker save` 归档内 `manifest.json` 的 Config 条目自校验；发布步骤把「拉回镜像 `.Id` 等于本地 Id」替换为「拉回镜像存档的 config 字节哈希等于构建时被 attest 的 config 摘要」，其余标签/用户/entrypoint/verifier 校验不变。
- 测试：workflow 由下一次真实发布 run 验证（本 PR 的 CI 走治理与构建门）。
- 未做：不改变镜像内容、attestation 语义与发布产物；classic 存储路径保持向后兼容（分支式断言）。
