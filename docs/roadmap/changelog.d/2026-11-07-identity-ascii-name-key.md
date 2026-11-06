---
date: 2026-11-07
title: Make name_country identity keys ASCII-safe for the materialization contract
---

- 起因：目录源记录首次批量入库（266 条，2026-11-06 run `8c8f6d65`）后，run 在 canonicalize 阶段以 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID` 失败。堆栈定位：物化快照契约的 `itemPlan` 用 `^[a-z][a-z0-9._:-]{0,255}$` 校验 `companyParse.dedupeKey`，而 `companyIdentity()` 的无域名 `name_country` 键是 `n:<normalizeCompanyName(name)>:<country>`——含空格或非 ASCII（"müller gmbh"、中文名）即整批拒绝。该生产者/校验器格式从未对齐过（存量 `canonical_company.dedupe_key` 零条 name_country 行，此前从未走到这条路径）。
- 改动：`name_country` 键按名称分派——纯 ASCII 单词名保持可读的 `n:<name>:<country>`（既有行为与测试不变）；名称含空格/非 ASCII 时改用 `n:h<sha256>` 形式（65 字符、ASCII、确定）。键只参与相等比较（无反向解析），跨 run/跨来源等值语义不变。
- 测试：`identity.spec` 新增中文名/含空格名 ASCII 合规、同名稳定、异名区分、纯 ASCII 保旧格式；identity + discovery-company-materialization 相关 208 用例全绿。
- 未做：不改物化契约的模式（协议 sha 不动）；不回溯存量（存量无 name_country 行）。
