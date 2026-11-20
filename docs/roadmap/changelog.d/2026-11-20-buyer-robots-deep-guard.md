---
date: 2026-11-20
pr:
title: Preserve homepage-only robots fallback for unavailable rules
---

- 起因：普通网络失败或 HTTP 5xx 未取得 robots 规则时，空 Disallow 被缓存为无限制，深层页面被错误放行，与首页降级注释不符。
- 改动：缓存明确保留未取得规则的首页限定状态；普通网络失败及 HTTP 5xx 只放行根路径，成功空规则、200 HTML 无指令、4xx 无 robots 和显式 Disallow 延续原行为。安全拒绝、workspace suppression、physical fence 与 durable ACK 异常保留原有边界。
- 测试：离线回归覆盖网络/500/503 的首页与深层两种访问顺序、缓存复用、成功及 404/403 兼容、入口权限/SSRF、安全拒绝和物理围栏/ACK；相关单测、robots 范围覆盖、API build/lint、docs/governance、ContractGraph 与文件预算检查见任务报告。
- 未做：未进行真实 provider、模型、数据库或 Temporal 验证，未部署；普通首页网络降级仍存在，不声明全域 robots 严格 fail-closed，未重构 parser/UA 规则。
