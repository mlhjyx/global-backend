---
name: sanctions-screen
description: 对一家公司名做制裁名单筛查（确定性，复用 Qualify 第五门匹配引擎），返回命中风险与名单版本证据；只读建议，不发送、不写库、不生成单证。
license: Proprietary
metadata:
  platform.skill-key: compliance.sanctions_screen
  platform.version: 1.0.0
  platform.pack-type: compliance
  platform.skill-kind: service
  platform.tenant-default: enabled
  platform.service-handler: sanctions.screen.v1
  platform.risk: low
  platform.human-gate: "false"
  platform.owner: OWN-BUYER-BE
---

# 制裁名单筛查（服务型技能）

输入：`{ companyName, country?, threshold? }`（与国家可选；threshold ∈ (0, 1] 覆盖默认召回阈值）。

输出：`{ status: clear|potential_match|not_screened, matches[], listVersions, truncated, algorithmVersion }`。
每条命中含名单源、命中的名称与别名质量、名字分/展示分、实体国家与名单版本；
命中超过 50 条时 `matches` 只保留前 50 条并置 `truncated=true`。

边界：

- 确定性执行（无模型、无工具）；名单索引来自平台制裁源，未启用或索引为空时如实返回
  `not_screened`，**不得**臆造 clear。公司名归一化后没有任何可比较 token（纯符号/空白）
  时不进行筛查并返回 `not_screened`——查询无法与名单比对时不能算「已筛查且清白」。
- 只返回名单实体（摄取层已剔除个人条目）；不输出个人联系方式。
- 只读：不写库、不发送、不产任何对外单据或文件。
- 命中结果需要人工复核；本技能不替代法务判断。
