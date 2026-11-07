---
date: 2026-11-08
title: Upgrade the self-hosted Crawl4AI image from 0.9.1 to the 0.9.5 security release
---

- 起因：主计划 §3.5b 安全升级（产品负责人 2026-11-08 批 D-f）。0.9.5（2026-10-14）修复 6 个协调披露通告，全部命中自托管 Docker API 的暴露面：CVE-2026-119119（渲染延迟参数无上限的 DoS）、JS 注入（css_selector/wait_for 绕过 js_code 拦截）、盲 SSRF（CacheValidator 绕过 egress proxy）、调用方指定 HuggingFace 模型（pickle RCE）、调用方正则 ReDoS、默认关闭 TLS 校验。设计见 `docs/superpowers/plans/2026-11-08-crawl4ai-095-upgrade.md`。
- 改动：
  - `infra/crawl4ai/Dockerfile`：基础镜像钉到 `unclecode/crawl4ai@sha256:0b056668…`（0.9.5）；构建期断言 `/app/config.yml` 仍含 `wall_clock_s: 300` 与 `max_pages_before_recycle: 200`（浏览器池每 200 页回收、单次抓取 300s 截止）。
  - 既有 egress 补丁（fake-IP DoH 窄回退 + 上游 global-IP 守卫/pinning proxy）、redis 持久化关闭、playwright 浏览器安装全部保留，构建期锚点检查通过。
- 测试：镜像构建 + 容器冒烟（/health、经 pinning proxy 真实抓取、内网地址拒绝）；适配器契约单测由 CI 全量覆盖。
- 回滚：`global-crawl4ai:rollback-0.9.1-20261108` 保留旧镜像；`docker tag … :local` + 重建容器即可回退（无迁移）。
- 未做：不重建/不重启正在运行的 `global-crawl4ai` 容器（发车由产品负责人流程执行）；生产侧 Crawl4AI 运维姿态不并入本仓 wrapper。
