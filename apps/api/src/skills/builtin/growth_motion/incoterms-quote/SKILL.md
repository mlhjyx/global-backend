---
name: incoterms-quote
description: 按 Incoterms 2020（EXW/FOB/CFR/CIF/DDP）做确定性成本与报价建议（L1 只读）：输入成本行与可选汇率、毛利，输出分项与单价/总额及假设；不生成 PI/CI/PL 等对外单据。
license: Proprietary
metadata:
  platform.skill-key: quoting.incoterms_quote
  platform.version: 1.0.0
  platform.pack-type: growth_motion
  platform.skill-kind: service
  platform.tenant-default: enabled
  platform.service-handler: quoting.incoterms.v1
  platform.risk: medium
  platform.human-gate: "true"
  platform.owner: OWN-BUYER-BE
---

# Incoterms 报价计算（服务型技能，L1）

输入：`{ incoterm, quantity, currency, costLines[], exchangeRate?, marginPct? }`。
`costLines` 的 kind ∈ goods/packaging/inland_freight/ocean_freight/insurance/duty/other；
金额与币种必须给出；跨币种必须显式提供汇率（1 外币 = exchangeRate 报价币）。

输出：`{ incoterm, formulaVersion, currency, breakdown[], unitCost, totalUnitPrice,
totalAmount, assumptions[], warnings[] }`。

边界（红线）：

- 只产报价建议：**不生成 PI/CI/PL 或任何对外单据**，不发送。
- 汇率只取输入值，不查询外部牌价；缺汇率且跨币种时直接拒绝。
- duty 仅 DDP 计入；其他术语的进口端费用不由卖方承担。
- 不做税务/法律意见；DDP 关税按输入估算。人工确认（humanGate）后才可用于对外沟通。
