---
date: 2026-11-19
pr:
title: Prioritize quick matches within the existing company evidence quota
---

- 起因：真实经销测试的105个深挖目标中，4家quick match排在slot51、96、102、104，全部落在50个新增补证名额之外；较早的weak先占据了排序名额；不据此推断每个名额都实际发生补证或耗尽费用。
- 改动：listDeepTargets按match先于weak，再按创建时间和公司ID稳定排序；保留500目标上限、现有50补证及25联系人补全额度、预算和资格门；实际费用随执行结果变化，不宣称与旧顺序相同。已录制的工作流目标列表不回写。
- 测试：真实PostgreSQL/app_user/RLS先复现两项RED；修后6项pool/排序测试通过，包括强候选进入前50、同级稳定顺序、排除未判与mismatch、跨工作空间隔离、501强候选仍最多500目标。相关应用回归、构建、原推送门及必需CI随PR核验。
- 未做：不增加任何额度、不将weak升级为match、不放宽来源/身份/费用保护，不改历史迁移、旧运行或生产环境。测试库基础参考数据按既有首次建库脚本补齐并单独记录，不把其结果当作严格AB。
