---
date: 2026-11-25
pr: 1105
title: 修复 ICP 画像生成与评分倒挂、联系人串名噪音并打通全渠道社媒展示
---

- 起因：现网琏升科技意大利光伏试点数据复核暴露四类真实业务质量缺陷：(1) ICP 自动生成将竞争对手组件制造厂混入下游买家画像、把卖家工艺参数设为硬门槛并输出纯中文正则与 AI 元备注；(2) 下游纯分销/EPC 线索因 `process_required` 未声明而频繁卡在 `C3_PROCESS=unclear`，且普通电商按钮（如 `Ordina ora`）被误判为提示词注入；(3) `scoring.ts` 把所有 `weak` 线索一刀切压成 `fit=0.45`，同时未读取 `company_contact_channel`（90 条现网电话/职能邮箱/表单）和 `website_profile.trade_role`，导致真买家与无关行业混排；(4) 社媒与官网联系人混入同名异企串名、法律声明及非采购岗位，且 `company_contact_channel` 与 `structured_org.same_as` 社媒账号未在 API/作战清表展示。
- 改动：(1) 新增 `icp-output-sanitizer.ts` 并在 `icp-input-guardrails.ts` / `icp.service.ts` 接入 ICP 质量约束与确定性清洗（剔除元备注、过滤非中文市场的纯中文正则、为渠道分销/EPC 自动补齐 `process_required: false`）；(2) 新增 `icp-judge-guidance.ts` 经 `loadIcpBrief` 注入受信任判定指引，并在 `quick-scan.ts` 收紧无关行业直判 `mismatch`（零改动受冻结 `RUBRIC_SHA256` / `PROMPT_HASH`）；(3) 新增 `lead-fit-score.ts` 接入 `scoring.ts` 与 `qualify.activities.ts`，按 v2 分项分拉开 `match`/`weak` 梯度、把 `company_contact_channel` 计入可达性并把 `website_profile.trade_role` 计入 `dataQuality`；(4) 新增 `contact-quality-filter.ts` 拦截跨公司串名、法律声明、非采购岗位与空壳人；(5) 新增 `lead-channels.ts`，把 `company_contact_channel` 与 `structured_org.same_as` 全量打通到 `GET /leads`、`GET /leads/:id/package`、`GET /canonical-companies/:id` 与 `GET /reports/battle-csv`（新增可选 `scope=reviewable`）。
- 测试：新增 `icp-output-sanitizer.spec.ts`、`icp-judge-guidance.spec.ts`、`lead-fit-score.spec.ts`、`contact-quality-filter.spec.ts`、`lead-channels.spec.ts`，连同 14 个既有相关单测套件共 19 文件 398 条用例全绿，通过 `@global/api build` 及全套文档/G9/治理/密钥快门。
- 未做：猜邮占位解除、Hunter `/v2/email-finder` 升级与 Prospeo v2 验真接入在紧随其后的 PR 2 单独交付；前端列表/详情全渠道展示与精准查邮按钮在 `gain-saas` PR 3 单独交付。
