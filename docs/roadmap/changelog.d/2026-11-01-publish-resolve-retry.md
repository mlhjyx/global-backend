---
date: 2026-11-01
title: Retry the GHCR digest read-back within its bounded wait
---

- 起因：第七班 run 41317912037 构建与推送都成功，但 `ghcr-runtime-publication.mjs resolve` 的 `--wait-ms` 有 60 秒硬上限，工作流把等待窗调到 120 秒后直接被判 `GHCR_INPUT_INVALID`；而 GHCR 标签可见性延迟实测超过 30 秒。
- 改动：改用「脚本内 60s 等待 + 工作流层有限重试」——最多 4 轮 resolve（每轮 60s 等待 + 15s 间隔），全失败才让步骤失败；不修改脚本本身的输入契约。
- 测试：发布契约测试 18/18 绿；下一次真实发布 run 验证。
- 未做：不改镜像内容、attestation 语义与发布产物。
