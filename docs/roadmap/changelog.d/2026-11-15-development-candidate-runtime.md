---
date: 2026-11-15
title: Enforce candidate instance tenant and grant allocation boundaries
---

- 起因：候选开发实例不能通过环境标签、未验证 JSON 或额外正常 Grant 获得超出指定实例、工作空间和总额度的执行能力。
- 改动：构建元数据进入不可变摘要；启动先 pending-denied，核对外部已验证缓存和实际配置后限定租户。实际 Prisma 扩展、relay、HTTP/活动入口、Grant 消费和预算账户接入范围与分配校验；到期阻止新工作并有界保留既有操作结果及结算。
- 测试：实例/源码/摘要/环境/权限/过期负例、额外 Grant 在 SQL 前拒绝、真实扩展 client 路径、异步完成/取消后的权限回收，以及原身份、预算和 relay 回归。
- 费用硬门：实际供应商逐 wire 上界尚未证明，候选模型与物理/外部工具的资源额度保持零；即使来源报价为零也在预留/外呼前以稳定控制错误拒绝。没有配置开关可替代真实费用 guard；普通 release 行为保持原样。
- 未做：真实 root 缓存安装、SaaS/Temporal 机器绑定、候选运行实例与真实付费请求。结构清单和本地测试不代表 readiness 或费用实测。
