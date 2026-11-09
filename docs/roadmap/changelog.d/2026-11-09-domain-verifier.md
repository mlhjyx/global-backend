---
date: 2026-11-09
title: Add the offline domain verifier skeleton — Impressum/SIREN/CRN extraction, VIES interface and deterministic scoring (ch03 T3-13 subset)
---

- 起因：ch03 §3.12.3 的域名校验器（P2 最高优先级链路）需要一个可离线测试的确定性核心：证据抽取（注册号/VAT/地址/名称）→ 评分 → VERIFIED/AMBIGUOUS/REJECTED，且与既有 DomainResolver 候选契约衔接；抓取、VIES 真实 REST 与落库属执行面，本波只做接口与 fixture。
- 改动：
  - `apps/api/src/registry/domain/domain-verifier.ts`：`extractRegisterEvidence`（DE 复用 `parseImpressum` 取 HRB/HRA+法院；FR 抽 SIREN/SIRET/RCS 九位；GB 抽 Registered in England… 的 8 位 CRN；未抽到 = 未知而非不符）；`verifyDomainCandidate` 按 §3.12.3 公式评分（55/35/20/15|8/5，上限 100；VERIFIED ≥90、AMBIGUOUS 55–89、无硬证据最高 40）与负证据（页面注册号不符含法院不一致→REGISTER_MISMATCH；停放页→PARKED_DOMAIN；零页面→NO_LEGAL_PAGE）；`VatValidator` / `LegalPageText` 契约为离线接口（VIES fixture），VIES 故障按未知处理不影响已有硬证据。`verifyDomainCandidates` 实现同名冲突规则（≥2 个 ≥55 分→全部 AMBIGUOUS、不自动选中）与唯一 VERIFIED 选中；`toDomainResolutionDrafts` 映射 `company_domain_resolution` 行草案（状态/matchType/confidence/evidenceJson/selected）。
  - 与候选生成契约衔接：spec 用 `MultiRouteDomainResolver`（fixture 搜索 provider）产出候选直接喂校验器（域名 token、噪声过滤全链路离线）。
- 测试：`domain-verifier.spec` 覆盖评分表（100/95/75/≤40 各组合）、法院不一致与号码不符负证据、VIES 故障降级、停放/零页面、同名冲突与唯一选中、行草案映射、resolver→verifier 交接；registry 全组 13 文件 133 项全绿；build/lint 通过。
- 未做：法律页抓取与播放（执行面 T3-10/T3-12）、VIES 真实 REST、robots/停放页结构判定增强、人工复核队列（T3-15）、500 条人工标注 precision 验收；不碰 Copy 文件、无迁移、未发车。
