---
date: 2026-11-02
title: Trigger company understanding from intake with an execution grant, and bound JWKS fetches
---

- 起因：intake 创建 CompanyProfile 后从不发 `CompanyProfileCreated`，事件也不带 workspace 执行授权，经注册引导入驻的公司永远没有理解与 Claim/Offering；JWKS 验签的远端拉取无超时与大小上限。
- 改动：intake 接受可选 `X-Execution-Budget-Grant`（新增请求作用域 `POST /site-builder/intake`）；同事务消费并写 `CompanyProfileCreated` v2；缺授权时返回 `understanding=not_started`；新增报价 envelope 与 OpenAPI；JWKS 拉取加 2 秒超时与 64 KiB 上限。
- 测试：intake service/controller、JWKS bounded fetch、预算 envelope 共 49 个用例通过；OpenAPI 已重导出。
- 未做：不改理解工作流主体与预算语义；不在引擎内重试模型拒答（另见 fit-refusal-guard PR #736）；onboarding 的 grant 签发在前端 Phase 1 接入。
