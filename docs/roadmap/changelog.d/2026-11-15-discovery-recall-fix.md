---
date: 2026-11-15
title: Narrow Wikidata industry pivots and correct solar/wholesale taxonomy aliases
---

- 起因：获客发现运行里 Wikidata 按"制造业"大类召回任意制造商（家具厂、游乐设施厂等），抽样证明判定环节没有误杀。根因是 `term_alias` 把"太阳能光伏"记到半导体制造（2610/Q11661）、把泵类渠道记到机械制造（28/Q1857831），而 Wikidata provider 只按行业 QID + 国家查 P452。
- 改动：
  - 种子节点 `279` 绑定 `Q192127`（photovoltaics）并补齐太阳能光伏/光伏组件制造等别名；节点 `4659` 绑定 `Q220695`（wholesale）并补齐工业泵分销/泵类渠道等别名。
  - 新增 `discovery/wikidata-industry-scope.ts`：解析注入处只把三位以上数字类级码当作 Wikidata 枢轴；provider 对最终 QID 再做一次 fail-closed 兜底，全部过宽时返回 `EMPTY_RESULT/INDUSTRY_QID_TOO_BROAD`，开关 `DISCOVERY_WIKIDATA_BROAD_INDUSTRY_MODE=off` 可回退。
  - `vocab` 兜底表同步光伏与批发/分销的窄编号；`taxonomy.normalize` 提示词要求存在更具体类目时不得选择 Manufacturing 大类。
- 测试：新增 `wikidata-industry-scope.spec.ts`、`providers/wikidata.provider.spec.ts`；扩充 `vocab.spec.ts`、`taxonomy-vocab.spec.ts`；调整 `structured-lineage.provider.spec.ts` 的 Wikidata 夹具为窄编号。
- 未做：不改判定/评分、不改 `trade_side` 语义、不改收据/事件契约、不加数据库迁移；数据入口（结构不合格、来源白名单）与 OSM/TED 过滤另开。
