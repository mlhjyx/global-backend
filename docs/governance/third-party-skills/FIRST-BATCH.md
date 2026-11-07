# 首批导入清单（供产品负责人挑选）

> 文档 ID：`GOV-TPS-004`
> 状态：`CURRENT`
> 最后核验：2026-11-08
> 决定：2026-11-08 产品负责人选定首批 **10 个**：A 档 2 个（account-research、lead-triage）+ B 档 5 个（prospecting、cold-email、draft-outreach、stakeholder-map、account-tiering）+ C 档 3 个（competitive-intelligence、customer-research、pricing）；其余 4 个 C 档保留待后续。
> 结论：catalog 共 14 个技能。首批 10 个中，**S1 运行时先做 A 档 2 个**（与计划步 8「精选导入 2 个外部技能」一致），B 档 5 个随审批链/数据接入，C 档 3 个作为 Pack 内容进入首批。
> owner：首批 10 个与目录其余项统一登记为「产品负责人 + 平台工程（本工作区）」（2026-11-08 产品负责人确认）；引入第三方 owner 时再改。

## 1. 推荐分档

### A 档 · 已选定首批进入 S1 运行时（2 个，2026-11-08）

| 技能 | 来源 | 域 | 为什么是它 | 风险/依赖 |
| --- | --- | --- | --- | --- |
| account-research | anthropics/knowledge-work-plugins（Apache-2.0） | 账户研究 / ICP 适配 | 只读、零外链、内置不可信内容规则；只靠 `searxng.search` + `crawl4ai.fetch` 即可跑；与引擎的 understanding/发现段直接衔接；96 行，适配成本最低 | 需把聊天界面语义改写为引擎输出；CRM 不可用时不编造归属 |
| lead-triage | anthropics/knowledge-work-plugins（Apache-2.0） | 线索评分 / 路由 | 只读、零外链、粘贴线索即可 files-only 运行；与 `discovery.qualify_fit` 互补；104 行 | 路由聊天消息只作建议；不写 CRM |

**共同理由**：两者都不发送、不写 CRM、不导出，个人数据只读；都有显式注入防线；都不依赖厂商 API；Golden Set 容易在无外部动作下判定。先跑通这两个，能验证「validator → 许可/NOTICE → 安全 → Golden Set → 租户启停」整条管线而不触碰审批链。

### B 档 · 已选定首批（随审批链 / 数据接入，5 个）

| 技能 | 来源 | 域 | 依赖/风险 |
| --- | --- | --- | --- |
| prospecting | coreyhaines31/marketingskills（MIT） | 名单构建 | 名单对外导出走审批链；需去营销化；建议补注入规则；参考文件较大 |
| cold-email | coreyhaines31/marketingskills（MIT） | 外呼文案 | 发送/多通道序列走审批链；需去营销化；补注入规则 |
| draft-outreach | anthropics/knowledge-work-plugins（Apache-2.0） | 外呼草稿 | 发送/加入销售序列走审批链；收件人规则已内置 |
| stakeholder-map | anthropics/knowledge-work-plugins（Apache-2.0） | 决策人地图 | 联系人创建（CRM 写）走审批链；个人数据密度最高 |
| account-tiering | anthropics/knowledge-work-plugins（Apache-2.0） | 账户分层 | 依赖账户清单（CRM 或上传表格）；纯评分零工具 |

### C 档 · 策略/内容参考（首批选定 3 个，共 7 个）

| 技能 | 来源 | 域 | 说明 |
| --- | --- | --- | --- |
| competitive-intelligence | anthropics/knowledge-work-plugins（Apache-2.0） | 竞争情报 | 只读、可 web-only；赢单/输单数据接入后价值更大 |
| call-prep | anthropics/knowledge-work-plugins（Apache-2.0） | 会前简报 | 依赖日历/转录/邮件；当前先支持文件输入 |
| customer-research | coreyhaines31/marketingskills（MIT） | 客户研究 | 只读、显式注入防线；上游自带 13 条评测 |
| pricing | coreyhaines31/marketingskills（MIT） | 定价 | 纯策略生成、零工具；上游自带 9 条评测 |
| ideal-customer-profile | phuryn/pm-skills（MIT） | ICP | 纯策略生成；需去推广链接、改 `$ARGUMENTS` |
| beachhead-segment | phuryn/pm-skills（MIT） | 市场选择 | 纯策略生成；需去推广链接、改 `$ARGUMENTS` |
| gtm-motions | phuryn/pm-skills（MIT） | GTM 组合 | 纯策略生成；需去推广链接、中性化厂商清单 |

## 2. 选择表

| 选择 | 技能 | 档 | 备注 |
| --- | --- | --- | --- |
| ☑ | account-research | A | 已选定首批（2026-11-08） |
| ☑ | lead-triage | A | 已选定首批（2026-11-08） |
| ☑ | prospecting | B | 已选定首批（2026-11-08）；需导出审批 + 去营销化 |
| ☑ | cold-email | B | 已选定首批（2026-11-08）；需发送审批 + 去营销化 |
| ☑ | draft-outreach | B | 已选定首批（2026-11-08）；需发送/序列审批 |
| ☑ | stakeholder-map | B | 已选定首批（2026-11-08）；需 CRM 写审批 |
| ☑ | account-tiering | B | 已选定首批（2026-11-08）；需账户数据输入 |
| ☑ | competitive-intelligence | C | 已选定首批（2026-11-08） |
| ☐ | call-prep | C | 未入选首批；依赖数据源 |
| ☑ | customer-research | C | 已选定首批（2026-11-08）；上游评测可复用 |
| ☑ | pricing | C | 已选定首批（2026-11-08）；上游评测可复用 |
| ☐ | ideal-customer-profile | C | 未入选首批；需去推广链接 |
| ☐ | beachhead-segment | C | 未入选首批；需去推广链接 |
| ☐ | gtm-motions | C | 未入选首批；需去推广链接 |

## 3. 首批 10 个的组合

本次首批即 **A 档 2 个 + B 档 5 个 + C 档 `competitive-intelligence`、`customer-research`、`pricing`**。这 10 个覆盖「研究 → 分层 → 名单 → 文案 → 触达前审批 → 竞争/客户/定价」的获客主链，且高风险动作全部在审批链后面。剩余 4 个（call-prep、ideal-customer-profile、beachhead-segment、gtm-motions）作为第二批或人工参考。

## 4. 导入前必须解决的事

1. **owner 登记**：首批 10 个与目录其余项统一登记为「产品负责人 + 平台工程（本工作区）」；后续引入第三方 owner 时再改。
2. **去营销化编辑**：marketingskills 的 prospecting/cold-email 与 pm-skills 的 3 个技能（见 [`SECURITY-REVIEW.md`](SECURITY-REVIEW.md) 第 5 节）。
3. **补 `allowed-tools`**：与绑定 AI Task 的 `allowedTools` 集合严格相等（建议集合见 [`THIRD_PARTY_SKILLS.json`](THIRD_PARTY_SKILLS.json)）。
4. **补不可信内容规则**：prospecting 与 cold-email 必须显式声明外部内容只作数据。
5. **适配引擎语义**：把 artifact / Page / connector / `$ARGUMENTS` 改写为引擎输入输出契约。
6. **Golden Set 跑通**：按 [`GOLDEN-SET.md`](GOLDEN-SET.md) 的 5 条必过用例验收；扩展集可并入上游 evals。

## 5. 退出计划

清单中每项都带退出计划：Golden Set 未通过，或自登记起 180 天内未接入运行时/未被产品负责人保留，则从 catalog 移除并归档到 `_archive/`。厂商技能（marketingskills 与 pm-skills）在去营销化后若仍与上游强耦合（例如依赖其私有工具文档），应改为 clean-room 重写再导入。
