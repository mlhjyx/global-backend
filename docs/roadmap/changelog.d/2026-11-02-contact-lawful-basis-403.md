---
date: 2026-11-02
title: Return the documented 403 when contact discovery has no lawful basis
---

- 起因：M4 UAT 实测 `POST /canonical-companies/:id/discover-contacts` 在缺 body 或 `{}` 时返回 400 `VALIDATION_ERROR`（`lawfulBasis` 必填先触发 DTO 校验），与 OpenAPI/`@ApiExecutionBudgetGrant` 承诺的 403 `CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED` 不一致。
- 改动：`DiscoverContactsDto.lawfulBasis` 改为可选（保留 `LAWFUL_BASIS_KINDS` 枚举校验）；缺失时交给服务层在消耗预算前以 403 拒绝；非法值仍是 400。重导出 OpenAPI 契约（请求体 `required` 去掉该字段）。
- 测试：新增 DTO 校验单测（空 body 通过校验、未知取值仍报错）；既有 service 403 用例继续覆盖拒绝路径。
- 未做：不改服务层 403 的语义与预算消费顺序；不改 `guess-emails`/`verify` 的可选 body 语义。
