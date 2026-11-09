# Golden ICP 评测集（骨架）

> 生命周期：`DRAFT`（2026-11-10 建立骨架；4 条已标注样例，其余待标注）
> 依据：产品负责人 2026-11-10 批准的「注册号锚定的多源证据图」核心切片 ⑤。

## 这是什么

一组**人工标注的 ICP 查询**，用来离线衡量获客召回质量：给一条 ICP，系统应从公司池里
挑出最相关的 10 家；`precision@10` = top-10 中人工认定的正例占比。标注是评测的唯一真值，
查询本身（`queries.yaml`）与标注（同文件内字段）一起版本化，改动进 PR 可追溯。

## 口径

- **候选池**：dev 库 `canonical_company`（按目标市场国家过滤，排除 SUPPRESSED）。
- **排序**（确定性、无模型调用，脚本 `apps/api/scripts/evaluate-golden-icp.mts`）：
  行业词命中 ISIC 节点 +3；候选自身行业/关键词/产品词面包含行业词 +2/词；目标市场匹配 +2；
  同分按域名升序。行业匹配与生产代码同一词表（`apps/api/src/registry/industry-map.ts`）。
- **precision@K**：分母固定 K（默认 10），未命中计 0——池子不够大时不虚高。
- **recall**：已标注正例中被 top-K 捞到的比例。
- **excluded_domains**：人工认定「绝不算正例」的域（如同名无关公司、平台方）；进入 top-K
  时在 `excludedInTopK` 单独列出，便于看误召回。
- **未标注查询**（`expected_domains: []`）：不计分，只输出 top-K 候选预览，供人工标注。
- **标注是抽样的、非穷尽的**：池子里同类的正确公司远多于标注的 3–5 个，所以 precision@K
  是**下限**（未标注的命中按 0 计）；解读时结合 top-K 预览人工复核。
- 候选去重：同域跨工作区只取一次；RFC 2606 占位域（`.example`）是测试合成数据，排除。

## 标注模板

新增或补标一条查询时，把下面字段补齐（YAML 内直接编辑）：

```yaml
  - id: de-industrial-pumps-distributor      # 唯一、kebab-case
    icp: 德国工业泵分销商与批发渠道           # 一句话 ICP（自由文本）
    target_markets: [德国]                    # 词表国家名/alpha-2；DACH 按地区展开
    industry_terms: [工业泵, pumps]           # 中/英/德均可，与生产词表同一匹配器
    expected_domains: [a.de, b.de]            # 人工核实过的正例（公司官网域名）
    excluded_domains: [amazon.de]             # 可空；明确不算正例的域
    labeled_by: <标注人>
    labeled_at: 2026-11-10
    notes: 标注依据一句话（如「试点名单 + 官网核实」）
```

标注步骤：跑评测脚本看 top-K 预览 → 逐域名打开官网核实是否为目标客户 → 回填字段。

## 运行

```bash
cd apps/api && node --import tsx scripts/evaluate-golden-icp.mts            # 默认 --k=10
cd apps/api && node --import tsx scripts/evaluate-golden-icp.mts --k=5 --report=/tmp/golden.json
```

## YAML 约束（受限子集）

评测脚本不依赖 js-yaml（避免为评测改锁文件触发漏洞基线重签），自带一个受限解析器。
支持的写法：注释、`version:` 标量、`queries:` 列表项、行内 `[a, b]` 列表、缩进 `- item`
块列表（缩进 2/4/6）、单/双引号字符串。不支持多行字符串、嵌套对象、锚点。解析失败会带行号报错。

## 现状与下一步

- 已标注 3 条（dev 库真实公司、试点 Impressum 可核实名单）；目标 20–30 条全标注。
- 排序器 v0 只做词面/ISIC 匹配；接入证据包 v1 的分层证据（T1/T2/T3）做加分项待
  `attributes.evidence_bundle` 覆盖足够后评估——口径变化必须在本 README 记录。
