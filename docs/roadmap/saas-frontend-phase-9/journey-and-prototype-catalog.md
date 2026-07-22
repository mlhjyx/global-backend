# 制造业端到端旅程与原型目录

> 文档 ID：`DESIGN-FE-P9-002`
> 层级：`L2 / Journey and prototype proposal`
> 状态：`DRAFT`
> 事实 Owner：`OWN-PRODUCT`
> 设计 Owner：`OWN-DESIGN`
> 关联：`GATE-FE-P9-000`
> 最后核验：2026-07-23

## 1. 使用规则

本目录补充现有 `JRN-FE-001..008`，但在产品 Gate 前不创造新的正式 `JRN-FE-*`。`JRN-P9-*` 是本阶段原型工作 ID，用于把跨域闭环、异常路径和 Figma Frame 组织在一起。

每条旅程必须给出：Actor、起点、canonical object、前置、关键决定、外部动作、成功结果、恢复、退出和不得声称的能力。原型不以页面数量验收，而以用户能否完成闭环验收。

## 2. 十二条核心旅程

| Journey | 主要 Actor | 起点 → 结果 | 必须覆盖的决定与异常 | 产品边界 |
|---|---|---|---|---|
| `JRN-P9-001` 产品发现与安全激活 | 老板/出口负责人、管理员 | 制造业方案/案例 → 注册验证 → Workspace → 安全 Demo | 邀请、会话恢复、Workspace 选择、无 entitlement、ACK unknown | 身份由 SaaS/IdP；本仓只验 token |
| `JRN-P9-002` 资料与知识引导 | 海外增长、品牌、事实审批 | 最少填写/上传/网站导入 → KB 解析 → 候选事实复核 → 补缺口或稍后继续 | 跳过/恢复、上传失败、来源权利、提取冲突、动态行业问题、删除影响 | 不固定产品族/规格/认证字段；不建 Readiness 聚合或伪精确百分比 |
| `JRN-P9-003` 可信 Site 预览 | 海外增长、内容、审批 | 企业真相 → Profile/Asset/KB → Build → 可信 Preview | 上传 ACK、Claim 阻塞、预算、degraded、取消、旧 Preview 保留 | 只承诺当前开发预览能力 |
| `JRN-P9-004` 发布、域名与维护 | 出口负责人、管理员、运营 | PublishReview → Domain/TLS → Release → 回滚/维护 | DNS 传播、证书失败、发布 ACK、旧站保留、下架、Provider 退出 | 当前为 target，不冒充已上线 |
| `JRN-P9-005` 市场到受控触达 | 海外增长、销售 | 市场/ICP → 来源计划 → Lead/Package → Outreach | Provider partial、身份歧义、Reachability、sanctions、suppression、投递 Receipt | Buyer 后端冻结；触达归 SaaS |
| `JRN-P9-006` 经销商招募 | 出口负责人、渠道销售 | 区域假设 → 经销候选 → 能力/冲突评估 → Opportunity | 区域重叠、品牌/售后能力、证据不足、拒绝原因 | 不做经销商订单/返利系统 |
| `JRN-P9-007` 招投标/展会/监管信号 | 海外增长、销售 | Signal → 企业身份 → 需求证据 → Qualification → Opportunity | 时间水位、来源权利、身份合并、信号衰减、错配纠正 | 不把公开信号冒充采购承诺 |
| `JRN-P9-008` 内容媒体到公开互动 | 内容、审批、海外增长 | Master Content → 渠道变体 → 审核/批准 → 发布 → 评论/提及 | 素材权利、模型成本、scope、排程时区、部分成功、ACK unknown | Aitoearn 是执行 Provider，不是 Content/Campaign SoR |
| `JRN-P9-009` 私密入站与分派 | 销售、客服/运营、合规 | 站点询盘/私信 → Inbox → 回复/分派 → 可追踪外部交接 | 身份歧义、翻译、附件扫描、AI 草稿、SLA、opt-out、handoff ACK unknown | Chatwoot 不拥有我方业务对象；当前不新增 RFQ 聚合，也不给出工程、CAD、报价或样品结论 |
| `JRN-P9-010` 撤销与影响分析 | 事实审批、内容、站点运营 | Claim 撤销/证书过期 → 找消费者 → 重审/重建/下架 | 历史快照、active Release、局部重建、紧急下架、申诉 | 不静默改写已发布历史 |
| `JRN-P9-011` Provider 故障与退出 | 管理员、运营、安全 | scope/凭证过期或 outage → 对账/重连 → 导出/迁移/撤销 | Webhook 重放、乱序、重复、ACK unknown、数据副本、密钥轮换 | 不长期双写两个主 Provider |
| `JRN-P9-012` 多 Workspace 代理交付与事故 | 代理 PM、客户审批、平台运营 | 显式切客户 → 委派 → 客户审批 → 执行 → 报告/交接 | 错 Workspace、数据隔离、break-glass、限时 support access、DSR | 禁止跨客户原始数据聚合 |

## 3. 跨旅程对象接力

```text
Company / Profile / Offering / Claim / Evidence / Asset / KnowledgeSource
  → Site / Content / Campaign
  → Audience / LeadQualifiedPackage / PublishJob
  → PublicInteraction / Conversation
  → external handoff receipt
  → Opportunity / QGO / SAO / Outcome（仅未来 SaaS 合同）
  → Metric / Experiment / next Decision
```

每次接力都必须保留 canonical identity、Workspace、版本、Owner、Evidence、allowed actions、Receipt 和审计；聊天摘要、Provider 标签或客户端本地状态不能成为接力真值。

当前不建立 RFQ Lite。Conversation 只保留需求原文、附件引用、翻译/摘要 provenance、分派和回复；若客户已有外部系统，可在未来批准的合同中创建受控交接并保存 receipt。完整工程评审、PLM、CPQ、CAD 签核、报价和样品流程均为 `PARK / INTEGRATE`，原型不得伪造内部工程结论。

## 4. 原型场景矩阵

每条核心旅程至少选择 normal 和两种高风险变体；关键长任务/外部动作另覆盖完整状态实验室。

| 变体族 | 必须出现的旅程 |
|---|---|
| Empty / first run | 001、002、003、005、008、009 |
| Loading / refreshing / stale | 全部对象/列表型旅程 |
| Partial / degraded | 002、003、005、007、008、009、011 |
| Denied / unavailable | 001、003、004、008、011、012 |
| Conflict / concurrent edit | 002、003、008、009、010、012 |
| Offline / local draft | 002、003、008、009 |
| ACK unknown / late result | 001、003、004、005、008、009、011 |
| Provider outage / credential expiry | 004、005、008、009、011 |
| Identity ambiguity / duplicate | 002、005、007、009 |
| Revocation / downstream impact | 004、008、009、010、011 |

## 5. 压力 Fixture

原型使用合成、脱敏且可复现的数据：

- 多行业合成 Workspace：空白首次用户、仅有官网的企业、上传过文档的企业和已有 Offering 的企业；不为所有企业预设产品层级或规格字段；
- 通用 Profile 五组、自由产品/服务描述、动态行业问题和“未知/跳过/不适用”路径；
- 中英德 UI 长文本、阿拉伯语 RTL smoke；生成站 locale 选择器只显示服务端真实能力，测试 Fixture 不冒充 runtime 支持；
- 30 个合成手册、证书、图片和网页来源，覆盖上传中、解析中、待确认、冲突、过期和删除影响；不嵌真实客户文件或 CAD 审批；
- 10,000 个 Buyer 行、多个来源、重复身份、RISKY 邮箱与 sanctions review；
- LinkedIn/X/Meta 等抽象渠道账号，每个账号能力、scope 和健康不同；
- Public comment、private message、website inquiry、外部交接 receipt 和受阻的 Opportunity 入口；
- Build、Import、Media、Publish、Sync 的 success/partial/failed/ACK unknown 运行。

Fixture 不包含真实 PII、Token、生产 URL、Provider Secret 或客户商业数据。

资料状态按来源、解析、审核和当前目标分别显示 `可用 / 需复核 / 缺失 / 过期 / 受限 / 不适用`、原因和下一动作，不生成汇总百分比。任务验证不得把某个行业的规格、材料、认证、MOQ 或产能变成通用必填，也不得加入加工可行性、公差工程判断、CAD 签核、报价/样品或内部工程批准。

## 6. 高保真选择规则

所有稳定 Page 和批准的新页面族必须有 Manifest 2.0 与注释线框。高保真代表不按任意数量选择，而按以下覆盖门选择：

视觉方向已由用户确认的五张基线冻结到页面家族层：Today、Site Editor、Buyer Development、Unified Inbox、AI Task Strategy。高保真必须按同一 Token/布局语法分别验证这些不同构图，不再生成三套方向；每张图的示例内容不得当作功能合同。

1. 每种页面表面至少一个；
2. 每个独特产品模式至少一个；
3. 每条核心旅程的关键决定点和恢复点；
4. 制造业差异化场景；
5. 发布、发送、批准、删除、计费和 Provider 退出等高风险动作；
6. 公共站转化、SaaS 日常任务、平台运营三类角色表面；
7. Desktop 主工作台和 Mobile 安全接力。

## 7. 可点击原型最低行为

所有可见的核心控件必须真实完成原型主路径：导航、筛选、保存视图、选择对象、打开 Inspector、填写表单、查看来源/冲突、批准、执行、取消、重试、重连、评论、回复、排程、返回和深链恢复。

非核心次级配置可以是视觉占位，但必须标记 `NON_INTERACTIVE_PROTOTYPE`；不可点击的控件不能做成看似可用的主按钮。

## 8. 任务验证

两轮任务验证使用相同 Scenario/Fixture：

- 第一轮：老板/出口负责人、海外增长、内容审批、销售各至少一名；
- 第二轮：Workspace 管理员、平台运营/客户成功，并复测第一轮高风险 finding；
- 指标：任务完成率、首次有效动作时间、误 Workspace/误操作率、恢复成功率、状态理解、证据信心；
- 记录参与者范围、方法、finding、反例、设计变更和未解决问题；
- 5–8 人可支持可用性 finding，不用于证明市场规模或普遍需求。
