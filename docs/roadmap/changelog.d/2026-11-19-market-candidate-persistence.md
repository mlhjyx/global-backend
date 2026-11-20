---
date: 2026-11-19
title: Persist immutable market candidate documents and versioned feedback
---

- 起因：市场探索判断、用户意见与卖方事实需要独立、可冷读的版本化真值，不能复用可变 ICP 或以浏览器/内存回显冒充持久历史。
- 改动：
  - 引擎新增租户隔离的候选集合、不可变修订与追加反馈三表；稳定候选 ID、依据版本/hash/定位、原 proposal 与用户纠正分层。
  - code-first 提供已有文档 current/latest/history/detail 和四种人工反馈；公司/集合锁、CAS、持久幂等、响应丢失重放及同事务回滚；严格拒绝深层未知字段。
  - 来源软删、Claim 撤销/过期、资料或 chunk 变化时只更新本次可用性，不改历史、不回挂或返回旧下载链接；确认不提升事实等级，纠正不自动重评估或执行。
  - 初始提交只留无生产调用者的内部存储 port；未分析与合法完成空结果分开。补权限目录、对象/场景/追踪与显式 app_user PostgreSQL CI 接线。
  - 初始 Claim 锁使用 NOWAIT 与最多三次已回滚存储事务重试；按实际 JSONB 文本字节在写前拒绝容量越界。追加 forward 迁移逐条验证新增事件，不重复解析全部旧历史，保原 FK/单步指针/RLS/ACL 与已提交旧 SQL 字节。
- 测试：RED→GREEN 文档/服务/HTTP/合同/模块与一次性 PostgreSQL 的冷读、四反馈、并发、幂等、丢响应、回滚、RLS、不可变和删源反例；Prisma 漂移、RLS 目录、精确表权限及零下游写断言。
- 未做：不接生产 producer/任意创建或导入，不新增模型任务、搜索、Grant、计划、run、发送、Outbox/Temporal、供应商、依赖或 SaaS 合同 pin/UI；合成持久化不是真实市场推荐、买家有效性或商业效果。本包不执行生产迁移、seed 或部署。
