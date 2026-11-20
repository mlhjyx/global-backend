---
date: 2026-11-20
pr:
title: Retain required qualification rule operands during creation
---

- 起因：新建规则的 value 只有 Swagger 装饰器，在应用白名单验证中被移除，合法标量或数组随后可能落为 null。
- 改动：为 CreateRuleDto.value 增加必填非 null 验证，使 value 保留在白名单中；保留数值 0、布尔 false 和数组，不改变 UpdateRuleDto 的既有可选语义。
- 测试：通过与应用相同的真实 Nest ValidationPipe 验证创建值保留、缺失/undefined/null 拒绝及 PATCH 兼容；回归涵盖已有三家公司 name/domain 数组和规则权重约束。
- 未做：未修改规则运算符类型体系、服务持久化、迁移或历史数据，未调用真实 API、数据库、服务、模型或 provider，也未部署。
