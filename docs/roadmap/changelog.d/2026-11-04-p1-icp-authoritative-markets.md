---
date: 2026-11-04
title: Make the seller profile's target markets and industry authoritative for ICP generation
---

- 起因：P1 断点 B1——`icp.service.generateFromCompany` 的提示词只喂了名称/官网/已审批 Claim/产品，**没读档案的 `targetMarkets`（ISO）与 `industry`**——ICP 的目标市场由模型自行猜测。实证：workspace c3584cf9 的档案 `target_markets={MY}`，生成的 ICP 全是「珠三角电子元件/线路板制造企业」，后续查询计划的语言/国家跟着错。
- 改动：
  - 提示词注入卖方档案权威输入：目标市场按 `ISO（中文名）` 列出，附「档案为准、ICP 只细化；输出 target_markets 必须覆盖以上市场，可追加但不得替换」的指令；industry 一并注入。档案无市场/行业时提示词与行为与旧版一致。
  - 确定性后校验（不靠模型自觉）：落库前用 `completeTargetMarkets` 把模型输出的自由文本市场与档案 ISO 归一比对（复用 `targetCountryCodes` 的中文/地区词解析 + 中文国名兜底），缺哪个补哪个、已覆盖的不重复追加。
  - `vocab.ts` 新增 `COUNTRY_NAME_BY_ISO`（ISO→中文国名，未收录回退代码本身；纯新增、无既有调用方语义变化）。
- 测试：`icp.service.spec` 新增 4 用例（提示词注入含 MY（马来西亚）/行业/权威措辞且落库为模型值；模型漏掉档案市场时补齐；模型以中文名写出的档案市场不重复追加；档案无市场/行业时提示词与落库行为不变）；`icp` 相关 14 文件 76 用例全绿。
- 未做：ICP 详情页/run 页的「目标市场（来自档案）+ 模型补充」展示与不一致提示（前端，随 P1-G2/P6）；档案市场修改后的「重新生成」入口（依赖 P1-G1/G2 的 attempt 链路）；`COUNTRY_ISO` 词表扩展维持 P2 语言层范围。
