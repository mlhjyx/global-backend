---
date: 2026-11-09
title: Add the deterministic ICP-industry to NACE mapping and per-frame source attributes (ch03 T3-05 subset)
---

- 起因：ch03 T3-05——registry 查询要按 ICP 行业真正过滤，需要把行业自由词与 taxonomy 的 ISIC 码确定性映射到 NACE 前缀；FR Sirene 的 `diffusionCommerciale=false`（当事人反对商业推介）必须在装载时采集并随候选记录流到下游触达过滤。
- 改动：
  - `apps/api/src/registry/industry-map.ts`：`canonicalNace`（NAF `28.13Z`/无点号 `2813` → NACE 类目 `28.13`）、`nacePrefixesForIndustryTerms`（复用 `ISIC_SEED` 别名+`crosswalks.nace` 做中/英/德词面匹配，CJK 子串与 ≥4 字符拉丁子串覆盖德语复合词）、`nacePrefixesForIsicCodes`（taxonomy 注入的 ISIC 码直查交叉表）、`resolveNacePrefixes`（显式 nace_prefix > 行业词 > ISIC 码）。ISIC seed 的 C28 节点补 `valve/valves/阀门/工业阀门/ventil(e)` 别名。
  - 装载器：`mapping.fields.attributes`（name → 指针，≤10 项校验）把源特有属性写入 `registry_entity.attributes`（排序存储、纳入 contentHash 与 diff）；`mapping.constants.naceVersion` 常量兜底；NACE 装载时归一（FR fixture 的 `28.13Z` → `28.13`，原始码可从源快照回放）。
  - `registry/query.ts`：候选记录带 `attributes.registry.sourceAttributes`（如 `diffusionCommerciale: 'false'`），查询层不做隐式过滤，语义留给下游触达过滤消费。
  - `registry-frame` provider 适配器：无显式 nace_prefix 时用 industry 自由词 / `_industryCodes` 做确定性映射（此前刻意透传为空）。
  - FR 帧 fixture/config：新增 `diffusionCommerciale` 列与 attributes 映射、`naceVersion: NAF-rev2`。
- 测试：`industry-map.spec`（归一变体/中英德词面/ISIC 交叉/优先级/不可用输入）；装载器 spec（属性采集与 contentHash 敏感性、naceVersion 常量、NACE 归一、attributes 配置校验负向）；catalog 与适配器 spec 更新（FR 行断言 `28.13`/`NAF-rev2`/`diffusionCommerciale` 透传；industry 词映射 OR 谓词、显式前缀优先）。registry + 适配器 12 文件 118 项全绿；build 通过。
- 未做：查询/物化层的 diffusion 硬过滤（列级谓词与 P4 抑制联动，留在执行面/投影卡片）；`full NAF→NACE` 官方对照表（当前确定性口径：剥国家后缀 + 2 位部门近似）；不碰 Copy 绑定文件、无迁移、未发车。
