---
date: 2026-11-20
title: Add controlled market candidate generation and durable recovery
---

- 起因：B1 只保存候选文档与反馈，缺少明确生成意图、受控授权、持久结果与准确消费闭环。
- 改动：新增 workspace 专用生成目的、元数据控制三表、完整结构化输入/假设输出、共享模型预算与只读恢复、authority-first 同事务 B1/ACK/终态及四个普通用户接口；补旧目的兼容、最小权限、OAS、CI 与业务追踪，不扩大工具、模型路线或资格。
- 测试：先观察实际行为 RED，再验证单元、真实 app_user 隔离 PostgreSQL、原 Router 合成提供方与真实预算/ACK/回滚、普通用户权限/全局写准入和代码优先 OAS；完整固定源与工程门按本 PR 验证记录。
- 未做：未发放业务 Grant、调用真实模型或联网、运行买家/发送链、改 SaaS 页面、迁移业务库或部署；不把合成验证视作真实市场、商业效果或生产准入。Copy/物理执行 hold 不提升。
