---
date: 2026-11-02
title: Keep published tags single-manifest by disabling embedded build provenance
---

- 起因：第七班连续失败在 digest 读回——`ghcr-runtime-publication.mjs resolve` 只接受单清单媒体类型（spec 刻意拒绝 OCI index，防 attest 未检验的平台），而 containerd 镜像存储下 buildx 默认给构建产物附带 provenance/SBOM attestation 清单，推送出的 SHA 标签指向 OCI index，HEAD 请求按 Accept 返回 404（标签实际存在、可拉取）。今天之前 classic 存储产物是单清单，所以一直没暴露。
- 改动：发布 workflow 的 `docker build` 增加 `--provenance=false --sbom=false`——发布证明由 workflow 里 `actions/attest` 的独立 attestation 承担，内嵌构建证明本就冗余；resolve 契约与脚本不变。发布契约测试同步新增两条断言锁定该 flag。
- 测试：`runtime-deployment-contract.spec.mjs` + `ghcr-runtime-publication.spec.mjs` 共 23 项全绿；下一次真实发布 run 验证。
- 未做：不改镜像内容、不改变 attestation 语义与发布产物格式；历史已推送的 index 标签保持原样。
