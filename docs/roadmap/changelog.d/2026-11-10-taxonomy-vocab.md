---
date: 2026-11-10
title: Expand ISIC industry vocabulary with multilingual labels, CPV crosswalks and industry-role terms
---

- 起因：产品负责人反馈行业词表过稀——真实 ICP（意大利/美国/英国的「光伏产业链/零碳建筑」采购企业）在 ICP→CPV 冷路径一个 CPV 码都没解析出来，TED 采购源零查询；行业目录检索也因词表稀疏命中极低。
- 改动：
  - `apps/api/src/discovery/isic-seed.ts`：行业节点 11 → 37（新增 26 个出口/获客高频节点：电气 27/271/273/274/279、风电 2811、暖通与热泵 2819、汽车零部件 2930、设备安装/Anlagenbau 33/3320、施工 41/42/43/4321/4322、电力供应 35、化工 20、橡塑包装 22/2220、电子元器件 261、通信设备 2630、批发与进出口 46/4659/4663、软件 62、工程服务 71），每个节点给 zh/de/it/fr/es 标签（能确定的才给）；`crosswalks.cpv` 只锚定官方核验过的 CPV 族；光伏/风电/储能/热泵/EPC/零碳建筑/楼宇自控/泵阀贸易等产品词与中英德意法西别名写入 `term_alias(kind=industry)`（去重后 898 条行业词条）。
  - `apps/api/src/discovery/cpv-seed.ts`（新）：CPV 子树从脚本挪出为可测试模块，5 → 71 个码（09/24/31/32/34/42/43/44/45/71/72；对照 cpvcodes.eu 官方浏览器、EUR-Lex Reg. 213/2008 清单与 TED 公告用法核验，宁可少而准），parentCode 前缀嵌套。
  - `apps/api/scripts/seed-taxonomy.mjs`：改为从 dist 导入两份种子；industry 标签写 zh/de/it/fr/es；新增 `industry_role` 渠道角色词种子（分销商/批发商/进口商/贸易商/零售商，含 Fachhandel/Großhandel/rivenditore/distributore/distributeur/mayorista 等本地语言词）；保持幂等 upsert 并打印各 kind 计数。
  - `apps/api/src/discovery/taxonomy-vocab.spec.ts`（新）：用内存 taxonomy 桩断言「光伏/太阳能/零碳建筑/建筑电气/泵阀贸易/EPC/热泵」解析出非空 cpvCodes；种子完备性（别名不跨节点重复、ISIC↔CPV crosswalk 双向可解析、CPV 父码前缀嵌套）。
- 测试：taxonomy-vocab / icp-to-cpv / industry-map / company-normalization / icp-to-naics 五个 spec 文件 69 项全绿；`@global/api` build 通过。
- 未做：不改查询构造代码（search-localization 由并行会话维护，本 PR 只提供数据面）；不部署、不把种子写入运行库（发车后按运维窗口执行）；46 批发族与 4659 不挂 CPV 锚（避免污染 TED 中标反查，ICP 只给「批发」时走诚实的 icp_seed_gap warning）。
