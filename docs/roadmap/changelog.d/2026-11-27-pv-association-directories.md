---
date: 2026-11-27
pr:
title: 补充 8 国及泛欧光伏协会名录入口并强化名录抽取清洗与去重
---

- 起因：行业名录发现源缺乏光伏垂直协会的显式合规入口，且抽取链路未过滤协会自身/赞助商/导航噪声、未清理官网追踪参数与非法协议、未按单国名录回填缺失国别，也缺少跨名录同域名与多国法律后缀公司名去重。
- 改动：新增 `association-directory-catalog.ts` 登记经逐站 curl 与 robots/ToS 实测合规的 32 个光伏/可再生能源协会会员名录（DE/MY/GB/CA/BR/NL/TR/AU + 泛欧 EU）并在 `provider.registry.ts` 逐域写入 `source_policy`；新增 `directory-record-cleaner.ts` 并在 `directory.provider.ts`、`identity.ts`、`company-normalization.ts` 与 `materialize-raw-companies.ts` 接入公司名规范化、噪声剔除、官网域名清洗、单国缺失国别回填及跨名录去重，不触碰 suppression、RLS 与 PII 加密门禁。
- 测试：逐站 curl 实测 50+ 个候选名录页面可达性、robots.txt 与 ToS 条款（32 个合规收录，21 类不合规/反爬/禁商用/不可达候选明确拒收）；vitest 定向单测、`@global/api` 构建与全部仓库治理门禁（changelog、文档漂移、docs:verify、G9 预算、G16 模块边界、gitleaks）通过。
- 未做：尚未部署至现网执行真实寻源流水线验真，待合并发版后抽样核查实际入池率与去重效果。
