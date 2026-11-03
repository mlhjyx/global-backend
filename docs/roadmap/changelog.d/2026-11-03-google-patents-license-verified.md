---
date: 2026-11-03
title: Verify the Google Patents Public Data licence wording and draft the enablement LIA
---

- 起因：`google_patents` 的注册表标注 `CC-BY-4.0_UNCONFIRMED`，要求启用前重新核实数据集条款；产品负责人 2026-11-03 决定先保持禁用，并同意先做核实与 LIA 草稿。
- 改动：按 Google Cloud 官方公告原文核实为 CC BY 4.0（署名：`"Google Patents Public Data" by IFI CLAIMS Patent Services and Google, CC BY 4.0`），注册表分类改为 `CC-BY-4.0_CONFIRMED` 并重生成 `docs/backend/provider-registry.md`；新增 `docs/superpowers/plans/2026-11-03-google-patents-enablement-lia.md`（DRAFT）：许可核实结论、LIA 草稿与启用清单。
- 测试：`governance:verify` 校验注册表与生成文档一致（CI 执行）。
- 未做：未改任何运行时状态——`data_provider.google_patents` 仍 DISABLED、`PATENT_SOURCE_MODE=off`、`patents-cache-refresh` 仍暂停；LIA 待产品负责人签署，平台执行契约变更与启用另走 PR 与发布。
