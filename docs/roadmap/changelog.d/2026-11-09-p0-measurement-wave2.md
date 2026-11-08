---
date: 2026-11-09
title: Add ch01 wave 2 — golden sampling scaffold, frame registry matrix, paired RR1/RR3, multi-frame log-linear CR, VRIC PLUS caliber
---

- 起因：ch01（测量与真值）第二波要求把「金标集、frame 分母、回复口径、三源捕获回捞、VRIC PLUS」从计划文本落成可校验的脚手架与口径；不采购任何付费数据、不发车、不部署。
- 改动：
  - 指标字典升 v1.1：新增 §1.3.1 VRIC PLUS 口径细则（phone VALID 四条件、email_only/phone_only/both 强制通道拆分、引擎侧上界声明）；§1.4 增加 RR1/RR3 机器实现与成对声明校验；§6 三源 log-linear 落地说明；§2 映射补 frame/golden。
  - 新增 `docs/metrics/frame-registry.md` + `docs/metrics/frames/frame-registry.v1.json`（19 法域矩阵：许可、获取方式、频率、规模、坑；全部 DRAFT，未接入）+ `scripts/metrics/frame-registry.mjs` 校验器（唯一键、枚举、ACTIVE 需 license）与测试。
  - 新增金标抽样脚手架：`evals/golden-discovery/`（README、`schema/golden-manifest.schema.json`、`v1/manifest.template.json`：accounts 500 / contacts_strict 500 / contacts_plus 500，三层配额与固定 seed）+ `scripts/metrics/golden-sampling.mjs`（确定性分层抽样、最大余数配额、欠采样如实报告、refs SHA-256）+ `scripts/metrics/sql/golden-pool-{accounts,contacts}.sql`（只读导出模板，联系人 ref 用盲化 dedupe_key）+ 合成样例池与测试。
  - 新增 `scripts/metrics/reply-rate.mjs`：RR1/RR3 成对计算（`unknown>0` 无 `ê` 拒绝出数）、Wilson CI、`--check` 拒绝单口径声明；测试含章节示例复算（0.42%/0.58%）。
  - 扩展 `scripts/metrics/capture-recapture.mjs`：`--frame` 重复传参；三源键簇捕获矩阵、8 个分层 log-linear 模型（G²+AIC 选型，饱和模型 df=0 单列）、参数化 bootstrap 95% CI（固定 seed）、两两交集/模型跨度诊断门；修复 IPF 缺失格边际处理（只在可观测格上匹配边际，缺失格按乘性结构外推）；测试含已知 N 的回收（20,000 → CI 覆盖真值）。
  - `funnel-baseline.mjs` 的 VRIC 输出增加 PLUS 通道拆分（email_only/phone_only/both）。
  - 新增 `scripts/metrics/lib/prng.mjs`（播种 PRNG/Poisson/分位数）与 `scripts/metrics/lib/psql.test.mjs` 等单测；`scripts/governance-contracts.spec.mjs` 导入全部 metrics 测试进入 CI 可达链。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 golden-sampling/frame-registry/reply-rate/多源 CR 用例）；`node scripts/verify-docs.mjs` PASS（0 errors）；`node --test scripts/governance-contracts.spec.mjs` 393+ 全绿（本地，含可达性检查）；未跑全量 build（无 TS/依赖变更，CI 承担）。
- 未做：不采购付费 frame/竞品数据；不做真实金标标注（PR-08 属产品负责人）；frame 适配器与 `frame_registry` 表（PR-11/12）、CR 的 Splink/LCMCR（PR-13 余量）、度量台与看板不在本波。
