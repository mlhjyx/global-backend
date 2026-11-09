---
date: 2026-11-09
title: Extend the domain verifier to the remaining §3.12.9 anchors — IT/ES/NL/BE/CH extractors with fixtures
---

- 起因：T3-13 校验器首波只覆盖 DE/FR/GB；ch03 §3.12.9 锚点矩阵要求逐国注册号锚点（IT REA+省、ES NIF/CIF、NL KVK、BE KBO、CH UID）与单测样例，新增国家先补矩阵再写代码。
- 改动：`apps/api/src/registry/domain/domain-verifier.ts` 的 `extractRegisterEvidence`/`registerMatches` 增加五个国家抽取器与比对规则——IT `REA MI-1234567`（省+号，省不同=不符，与 DE 法院同语义）、ES `NIF/CIF`（格式归一后全串比对）、NL `KVK`（8 位）、BE `KBO`（10 位，`0123.456.789` 与无点号等价）、CH `UID CHE-123.456.789`；全部按标签锚定（REA/NIF/CIF/KvK/KBO/CHE 字面），未打标签的数字不猜。模块头注释同步矩阵覆盖清单。另补 §3.12.10 集团门户规则：页面出现多个不同注册号时一律 AMBIGUOUS（`MULTIPLE_REGISTERS`，人工决定主实体），不因任一命中而自动 VERIFIED；为此在 `website-profile/impressum.ts` 增加只读的 `scanRegisterNumbers`（全部 HR 号码扫描，法院归属仍按 parseImpressum 首个解析），DE 单页多实体可检出。
- 测试：`domain-verifier.spec` 新增矩阵用例——五国抽取断言、五国「注册号+地址+名称 → VERIFIED（≥90）」参数化用例、IT 同号异省与 BE 异号两个 mismatch 负向、集团门户单页双 HRB → AMBIGUOUS；domain 组 29/29，registry 全组 141 项全绿；build/lint 通过。
- 未做：IT `P.IVA`/ES `Registro Mercantil 城市`/NL `BTW`/BE `TVA` 与注册号的联合强校验（VAT 路走 `VatValidator`，真实 VIES 属执行面；CH 不在 VIES，需 CH register API）；robots/停放页结构增强；不碰 Copy 文件、无迁移、未发车。
