---
date: 2026-11-10
title: Governed Companies House company-registry discovery source (acquisition vNext W4 P0, second source)
---

- 起因：获客挖掘 vNext W4 P0 第二源——Companies House 公司注册发现（复用既有受治理工具 `companies_house.search` 的 op=search），按名称从官方注册处拉 GB 注册实体，走 discovery→fit→enrich 全管线。
- 改动：
  - 新 provider `companies_house_registry`（company_registry 类；与联系人向 `companies_house` 分开注册，因 source-class 清单按 key 精确比对）：`COMPANIES_HOUSE_REGISTRY_PROVIDER=on` 才声明公司血缘（默认 off 零路由）+ data_provider 新行默认 DISABLED + 缺 `COMPANIES_HOUSE_API_KEY` fail-safe 有效空，三重关闭。
  - 只映射公司字段（注册号/名称/状态），OGL v3.0 署名义务入 license；op=search 输出本身不含 officers/个人字段。
  - 注册面：血缘契约两处、domain-ack governed 绑定、data_provider seed、provider source-class 清单、plan-query guide/priority、技术报价包络（适配器 10→11 并登记 companies_house.search 出网上界）、execution-authority callsites 49→50、provider-registry 文档重渲染。
  - 迁移 `20261110150000_companies_house_registry_provider`：发现血缘 SQL v1 白名单+attempt 三元组纯扩（合同哈希不变）。
  - raw-source 校验/归一与 canonical attributes 增加 `ch_registry`（关闭形状，只含公司字段）。
- 测试：新增 provider spec（映射/绑定/三重闸门/Broker 失败语义）；provider registry、报价包络、domain-ack、execution-authority spec 计数按真值更新。
- 未做：真实 `COMPANIES_HOUSE_API_KEY` 与真机检索留待部署后验收（默认三关关闭）；INSEE SIRENE / GLEIF 增量 / VIES / 展会原始目录属后续切片。
