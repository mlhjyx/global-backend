---
date: 2026-11-20
title: Add controlled market candidate generation and durable recovery
---

- 起因：B1 只保存候选文档与反馈，缺少明确生成意图、受控授权、持久结果与准确消费闭环。
- 改动：新增 workspace 专用生成目的、元数据控制三表、完整结构化输入/假设输出、共享模型预算与只读恢复、authority-first 同事务 B1/ACK/终态及四个普通用户接口；补旧目的兼容、最小权限、OAS、CI 与业务追踪，不扩大工具、模型路线或资格。
- 回修：按独立复审修正历史终态读回、合法无结果结算分类、同 attempt 过时恢复与安全 RELEASED 重准入；仅追加 forward 完整性迁移，原冻结 SQL、数据库写闸、费用、总帽与 UNKNOWN hold 保持。
- 续修：区分原 Router 保守结算的物理未决与确定坏输出，冷恢复缺分类默认未知并持久封住公司新意图；修正 G2 对真正 merge 首次添加的历史识别，保所有冻结 SQL、原始添加身份及数据库校验，不加豁免。
- 测试：先观察实际行为 RED，再验证单元、真实 app_user 隔离 PostgreSQL、原 Router 合成提供方与真实预算/ACK/回滚、普通用户权限/全局写准入和代码优先 OAS；完整固定源与工程门按本 PR 验证记录。
- 未做：未发放业务 Grant、调用真实模型或联网、运行买家/发送链、改 SaaS 页面、迁移业务库或部署；不把合成验证视作真实市场、商业效果或生产准入。Copy/物理执行 hold 不提升。
