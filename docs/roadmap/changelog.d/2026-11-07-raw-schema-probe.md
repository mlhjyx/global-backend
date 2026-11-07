---
date: 2026-11-07
title: Add an opt-in probe that names the failing clause of a rejected raw payload
---

- 起因：目录源真实 run（`d51431d8`，镜像含 #828/#829）中 361 条入库、109 条仍 `PROVIDER_PAYLOAD_SCHEMA_INVALID`；用同一批 LLM 抽取产物本地重放 646/646 全过，静态无法定位生产拒绝形状，需要受控取样。
- 改动：`validateRawSourceProviderPayload` 在 `RAW_SOURCE_SCHEMA_PROBE=1` 时，对拒绝载荷输出一行 `[raw-source-schema-probe]` JSON——只含失败子句名（externalId/companyName/domain/country/attributes/bindings/identifier/provenance/license/…）与**无字段值**的结构摘要（字节数、词数、NFC 是否漂移、键集合、detail_url 的 scheme 类别）。探针开关默认关闭，关闭时行为与性能不变；日志写入用 try/catch 包裹，探针失败绝不改变校验结果。
- 测试：新增 `raw-source-provider-schema-probe.spec`——失败子句名正确、日志不含任何字段值（名称原文断言不出现）、开关关闭时零输出；boundary/ingestion 既有 142 用例全绿。
- 未做：未启用 env（随下一班车按需开启取样，取到形状后修复并关闭）；未改校验语义（纯重构为具名检查 + 探针）。
