---
date: 2026-11-21
title: Patch release security dependencies and preserve native libc selection
---

- 起因：Effect 与 Astro 的生产依赖公告需要真实补丁修复；Astro 修复版提高 Node 下限，正常锁重解析还必须保留原生平台的 libc 选择语义。
- 改动：
  - 精确钉住 Effect 3.22.1、Astro 7.4.7，Node 引擎下限与运行镜像同步至已审 22.23.4 digest。
  - 固定 pnpm 9.15.9 并显式采用当前 libc 架构，正常 full-metadata 解析保留原生选择器，不手改锁或放宽为 any。
  - 同逻辑单元重绑真实生产审计和 Copy 指纹，资格、漏洞零例外及来源准入边界不放宽。
- 测试：真实 pnpm metadata 夹具已观察选择器丢失的 RED 与配置修复后的 GREEN；完整安全下限套件、可信来源入口和全图平台字段核验通过。真实审计、API、renderer 与 OCI 结果以同 PR 的冻结收单为准，不套用前置 PR 或旧失败头。
- 未做：未改变业务 API、schema/迁移、权限、预算、模型与发送边界；未更改服务、运行配置或镜像绑定，未部署或调用真实业务。
