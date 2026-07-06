# 规范词表归一：标准化设计

> 回应「规范词表归一不够充分、行业/国家词不够全面」。现状 `discovery/vocab.ts` 是约 10 行业 + 10 国家的硬编码种子，够 demo 不够用。

## 结论：混合归一（确定性种子 + 冷路径 LLM 回填）

不靠人手维护大表，也不纯靠 LLM。落进现有「平台级注册表 + 冷路径 AI Task + 别名缓存」架构（与 DataProvider/SourcePolicy 同构，无 workspace_id/无 RLS，全局参考数据）。

## 主键标准（关键决策）

- **行业主键 = ISIC Rev.4**（联合国国际标准行业分类）。全球通用、免费、机器可读、纯数字码语言中立，且 **NACE(欧盟)/NAICS(北美)/GB-T 4754(中国)/SIC 都从它派生或有官方对照表(concordance)**，是唯一的「世界通用交换枢纽」。
  - 区域标准（NACE/NAICS/GB4754）不做主键，作「细分展开层」挂 ISIC 节点下，一次性灌官方 concordance；SIC 只做兼容别名。
  - **HS/HTS 海关编码是「产品维」不是「行业维」**，两者正交——不做行业主键，单独建 product 维供 trade_data / offering 归一。
  - **Wikidata QID 降级**为「发现执行标识符」：canonical ISIC → 一到多个 Wikidata QID / OSM 标签的 downstream 映射（供 wikidata/osm adapter 用），**不做主键**（无稳定层级/无官方对照）。
- **国家主键 = ISO 3166-1 alpha-2**（DE/US/CN，最短最稳、OSM 与多数 API 通用）。**国家维完全不需要 LLM**——一次性确定性 seed 全量 ~249 国。

## 数据结构（两张平台级表）

```
CanonicalTaxonomy   规范节点（industry/country/product 三种维，kind 区分）
  kind        'industry' | 'country' | 'product'
  scheme      'ISIC' | 'ISO3166_1' | 'HS'
  code        ISIC 叶码 / ISO alpha-2 / HS6
  parentCode  层级（ISIC 自引用，支持子树匹配）
  labelEn     规范英文名
  labels      { zh, de, native, ... } 多语言
  crosswalks  { nace:[...], naics:[...], gb4754:[...] } 官方对照
  wikidataQid / osmTags   downstream 发现标识（保留现 vocab.ts 的映射）

TermAlias           别名 → 规范节点（随用随长）
  term        归一化词（NFC+小写）
  kind        industry | country | product
  code        指向 CanonicalTaxonomy.code
  source      'seed' | 'llm' | 'manual'
```

## 归一流程 `TaxonomyResolver.resolve(kind, term)`

1. `normKey(term)` → 查 `TermAlias` 命中 → 返回规范节点（**确定性、零成本、零延迟**；所有国家词 + 高频行业词走这步）。
2. miss → **冷路径**调 `taxonomy.normalize` AI Task（复用 ModelGateway.generateStructured + AiTrace），outputSchema 用该 kind 的标准码表 **enum 约束 code 值域** → 杜绝幻觉码，或返回 no_match。
3. 校验 LLM 返回的 code 确在 CanonicalTaxonomy 中 → 写回 `TermAlias(source='llm')` 沉淀 → 下次同词变确定性。
4. resolve 结果供 `QualificationRule.field='industry'/'country'` 与查询计划路由用。

LLM 只在**冷路径**（ICP 设计 / query-plan 生成）每词一次，**不碰发现热路径**。词表随用随长、不靠人手维护——正好还上「词表归一」这笔欠账。

## 现成数据集（无需人手）

- **国家**：npm `world-countries`（单 JSON：alpha-2/3/numeric + region + 各语言 native/common 名）+ `i18n-iso-countries`（79 语言本地化名 → 中/英/德别名）+ 一条 Wikidata SPARQL（`wdt:P297` = ISO alpha-2）导出 QID↔alpha-2 对照。
- **行业**：ISIC Rev.4 官方表（UNSD）+ 官方 NACE/NAICS/GB4754 concordance（Eurostat RAMON / Census Bureau）。

## 第一步

先做**确定性 seed**（国家 100% 靠它、不等 LLM）：建 `CanonicalTaxonomy` + `TermAlias` 两表 + 一次性 seed 脚本——国家灌全量 ISO 3166-1；行业灌 ISIC Rev.4 主表 + concordance；把现有 `vocab.ts` 的中/英/德别名迁进 `TermAlias(source='seed')`、QID/OSM 标签搬进 `CanonicalTaxonomy` 列（保留作 downstream 发现标识）。这步不含 LLM，先把确定性底座和现有数据无损迁入。第二步再加 LLM 冷路径回填。
