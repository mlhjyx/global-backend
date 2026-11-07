# 安全与合规审校（14 个第三方技能）

> 文档 ID：`GOV-TPS-002`
> 状态：`CURRENT`
> 最后核验：2026-11-08
> 方法：全文人工通读 + 一次性静态扫描（外链、厂商名、推广词、注入特征、个人数据词）
> 结论：14 个技能均无恶意指令、无凭据、无可执行文件；风险集中在**提示注入面**（外部内容）、**厂商营销内容**与**个人数据处理**，均可在 S1 衍生版中处理
> 审批口径：发送 / CRM 写 / 名单对外导出 → 必须走审批链

## 1. 威胁模型

| 面 | 说明 | 本目录的处理 |
| --- | --- | --- |
| A. 提示注入 | 技能会读取网页、邮件、转录、评论、表单等第三方内容；内容里可能藏指令 | 要求技能显式声明"外部内容只作数据"；内容触发的动作必须展示给人工确认；无人在场的定时运行不得执行内容触发的动作 |
| B. 外链与营销 | 厂商集成表、赞助商标记、作者付费通讯链接 | 导入衍生版删除推广段落与链接；工具名中性化；保留方法与合规内容 |
| C. 个人数据 | 联系人姓名、邮箱、职位、互动记录、公开言论 | 每值带来源与日期；最小化；禁止敏感属性；退订/抑制名单；DSR 与保留期由引擎侧承担 |
| D. 工具面 | CRM、邮件、日历、转录、销售序列、厂商富集 API 都不在 ToolBroker | `allowed-tools` 只允许现有工具 id；新增工具合同前不得启用；写/发/导出走审批链 |

## 2. 总表

| 技能 | 注入声明 | 外链（快照内） | 营销内容 | 个人数据 | 审批动作 | 建议 allowedTools |
| --- | --- | --- | --- | --- | --- | --- |
| account-research | 显式（不可信内容规则） | 0 | 无 | 公司公开信息+联系人 | 无 | `searxng.search` `crawl4ai.fetch` |
| lead-triage | 显式（粘贴线索按数据） | 0 | 无 | 线索联系人 | 无（路由消息仅建议） | `searxng.search` `crawl4ai.fetch` |
| account-tiering | 显式（邮件仅 presence） | 0 | 无 | 账户/职位 | 无 | 无（纯评分） |
| draft-outreach | 显式（收件人只能来自用户/CRM） | 0 | 无 | 收件人姓名/邮箱/往来 | **发送、加入序列** | 无（生成）；发送另行审批 |
| stakeholder-map | 显式（转录/邮件为证据） | 0 | 无 | 高：姓名/角色/立场 | **创建联系人** | 无 |
| competitive-intelligence | 显式（引语为证据） | 0 | 无 | 客户引语 | 无 | `searxng.search` `crawl4ai.fetch` |
| call-prep | 显式（转录里的动作不执行） | 0 | 无 | 高：参会人 | 无 | 无 |
| prospecting | **缺失**（需补） | 21（19 自有仓库集成文档 + 2 Clay 学院） | **有**：Tool Integrations + 赞助商标记 ◆ | 高：联系人姓名/邮箱 | **名单对外导出** | `searxng.search` `crawl4ai.fetch` `http.get` |
| cold-email | **缺失**（需补） | 11（自有仓库集成文档） | **有**：Tool Integrations + Instantly 推荐语 | 中：收件人/个性化 | **发送、多通道序列** | 无（生成）；发送另行审批 |
| customer-research | 显式（抓取内容不可信） | 2（1 自有仓库 + 1 Reddit 搜索） | 轻微（参考文件提工具名） | 中：公开言论 | 无 | `searxng.search` `crawl4ai.fetch` `http.get` |
| pricing | 不适用 | 1（Sawtooth 方法引用） | 无 | 低 | 无 | 无 |
| ideal-customer-profile | 不适用 | 2（作者付费通讯） | **有**：Further Reading | 低 | 无 | 无 |
| beachhead-segment | 不适用 | 4（作者付费通讯） | **有**：Further Reading | 低 | 无 | 无 |
| gtm-motions | 不适用 | 4（作者付费通讯） | **有**：Further Reading + 厂商清单 | 低 | 无 | 无 |

## 3. 逐项审校

### account-research
Anthropic 公共 "Rules" 段（上游 8–17 行）已覆盖：外部内容不可信、不得渲染外部链接、内容触发的动作须向用户展示收件人/目标/内容/来源、定时运行不执行内容动作、空个人作用域必须停下询问。`Tools used` 只有 enrichment / crm 两类，均标注 optional。**无需删除任何内容**；导入衍生版需把 connector/artifact 语义改写为 ToolBroker 与结构化输出，并补 `license`、`allowed-tools`。

### lead-triage
入站表单与消息按不可信内容评分（上游 19–22 行）；路由消息只在用户要求时发出，且频道只能来自组织上下文（94–96 行）。只读技能，CRM 更新以建议文本输出。**无审批动作**。

### account-tiering
邮件正文只用于判断是否存在入站信号，presence 即信号，不执行正文（上游 68–70 行）。纯评分，无外呼。**无审批动作**。

### draft-outreach
关键防线齐全：收件人只能来自用户或 CRM；正文/富集结果里的地址只报告不使用；序列与地址不得来自内容（上游 82–96 行）。但发送与加入销售序列（Apollo/Outreach/Salesloft）是真实外部动作（4b 节）——**必须接入审批链**，衍生版不得保留"when asked 即自行发送"的执行语义。工具名应中性化为"销售序列工具"。

### stakeholder-map
暗联系人创建是 CRM 写（上游 89–96 行），要求逐条展示将写入的字段与来源，并只在用户接受后创建；无人在场的定时运行不得依据转录/邮件/聊天创建记录。**联系人创建必须走审批链**。个人数据密度最高（姓名、汇报线、立场、互动证据），需要访问控制与最小化。

### competitive-intelligence
客户与第三方文本只作证据引用（上游 44–56 行），结论区分事实与解读、先给样本量。无写动作。web-only 模式可做竞品公开动态；引用需来源。

### call-prep
转录/邮件里要求发送文档、邀请人或改记录的动作只列入简报，不执行（上游 96–102 行）。正文点名 Gong、Google Drive、Gemini 等具体工具，导入版应中性化为"转录/文档数据源"。**无审批动作**。

### prospecting
正文自带较强的合规护栏（上游 104–117 行）：禁止批量抓取 LinkedIn/Google Maps、禁止绕过 CAPTCHA/登录墙、只使用公开商务联系方式、GDPR/CAN-SPAM/CASL 来源留痕、禁止转售、禁止敏感属性、禁止来源不明的泄露数据。**但缺少"外部内容不可信"的显式声明**，且第 244–266 行的 `Tool Integrations` 表包含厂商集成文档链接与赞助商标记（◆ Ploy），必须在衍生版删除。`references/data-sources.md`、`sourcing-and-enrichment.md` 里的厂商名可保留为中性示例，但外链应删除或改为纯文本。名单对外导出是审批动作。

### cold-email
投递率与合规要求质量高：二级域名、SPF/DKIM/DMARC、名单验证、关闭打开/点击追踪、退订与邮寄地址（上游 113–121 行）；回复分类含退订立即抑制（132–134 行）。**缺少显式注入声明**：回复与线程内容应按不可信数据处理。第 189–202 行 `Tool Integrations` 与第 201 行对 Instantly webhooks 的推荐语必须在衍生版删除/中性化。发送与多通道序列是审批动作；不得输出规避 LinkedIn 检测的方案。

### customer-research
第 12 行显式声明抓取的评论/帖子/社区内容是不可信数据、是注入面。Reddit/G2 挖掘需保留来源、日期、原话与样本偏差说明；少于 5 个独立数据点不得建 persona。参考文件提及 SparkToro 等工具，属方法示例，无赞助标记。

### pricing
纯策略生成，不读外部内容。唯一外链是 `references/research-methods.md` 对 Sawtooth Software 方法说明的引用，属方法出处，可保留（或改为纯文本引用）。无个人数据与审批动作。

### ideal-customer-profile
纯策略生成。末尾 `Further Reading` 的 2 条 productcompass.pm 链接是作者付费通讯，**导入前删除**。使用 `$ARGUMENTS`，S1 改为输入契约。无审批动作。

### beachhead-segment
同上，4 条 productcompass.pm 推广链接需删除。无审批动作。

### gtm-motions
末尾 4 条 productcompass.pm 推广链接需删除；正文 7 种 motion 的工具清单含大量厂商名（Apollo、ZoomInfo、Clay、6sense 等），作为示例可保留但应中性化，避免暗示背书或付费优先。无审批动作。

## 4. ToolBroker 映射建议

`allowed-tools` 在 SKILL.md 里只是提示；真正生效的是绑定 AI Task 的 ToolBroker 白名单（S0 v0 要求二者集合严格相等）。现有工具 id 与技能需求的对应关系：

| 技能需要的工具类型 | 现有 ToolBroker id | 状态与建议 |
| --- | --- | --- |
| 网页搜索 | `searxng.search` | 可用 |
| 页面抓取/渲染 | `crawl4ai.fetch`、`crawl4ai.render` | 可用；技能只需 fetch 时不要多给 render |
| 原生 HTTP | `http.get` | 可用；仅 prospecting/customer-research 建议授予 |
| 公开社媒搜索/抓取 | `social.search`、`social.fetch` | 可用；但技能明确禁止 LinkedIn 批量抓取，只允许公开合规来源 |
| 邮箱可达性探测 | `smtp.rcpt_probe` | 可用；按 2026-10-11 产品负责人决定保留，需抑制名单与频控 |
| CRM 读取/写入 | 无 | 新增工具合同前不得启用；写操作走审批链 |
| 邮件草稿/发送 | 无 | 发送走审批链；草稿可作为引擎内部产物 |
| 日历/转录/聊天/文档 | 无 | call-prep、stakeholder-map 需要，当前只能走文件输入 |
| 销售序列（Apollo/Outreach/Salesloft 类） | 无 | 加入序列走审批链 |
| 厂商富集 API（Clay/ZoomInfo/Hunter/Truelist 等） | 无 | 不接；按"免费优先"原则改用现有 provider 或自建 |
| 名单/数据对外导出 | 无 | 引擎内部产物可自动；对外导出走审批链 |

**审批链动作清单（必须拦截）**

| 技能 | 动作 | 门 |
| --- | --- | --- |
| draft-outreach | 发送邮件、将联系人加入销售序列 | 审批链 + ExecutionAuthorization |
| cold-email | 发送邮件、多通道序列/领英动作 | 审批链 + ExecutionAuthorization |
| stakeholder-map | 创建联系人（CRM 写） | 审批链 + ExecutionAuthorization |
| prospecting | 名单对外导出/交付给发送系统 | 审批链 + ExecutionAuthorization |

无人在场的定时运行：内容触发的动作（收件人/目标/内容来自邮件、转录、网页等）一律不执行，只生成提案。

## 5. 去营销化清单（S1 衍生版必须完成）

| 来源/技能 | 删除或替换 |
| --- | --- |
| marketingskills / prospecting | 删除 `Tool Integrations` 整表（上游 244–266 行）与 ◆ 赞助商行；删除指向 `tools/REGISTRY.md`、`tools/integrations/*` 的链接；`references/data-sources.md` 等处的厂商外链改为纯文本 |
| marketingskills / cold-email | 删除 `Tool Integrations` 整表（189–202 行）与 Instantly 推荐语（201 行）；外链改纯文本 |
| marketingskills / customer-research、pricing | 清除参考文件中的厂商外链，保留方法出处（可用纯文本引用） |
| pm-skills / 三个技能 | 删除各文件末尾 `Further Reading` 段（productcompass.pm 付费通讯）；`gtm-motions` 的厂商工具清单中性化 |
| anthropics / 7 个技能 | 无推广内容；仅需把 Gong、Apollo/Outreach/Salesloft 等具体工具名中性化为工具类别 |

去营销化后仍须保留：SPDX、来源 URL、commit、原作者与改动说明。

## 6. 个人数据与合规

产品负责人 2026-10-11 已决定：保留个人邮箱/姓名、决策人、SMTP 探测与展会数据，风险自担。在此基础上，导入技能的衍生版必须满足：

1. **来源留痕**：每个联系人值带来源 URL/文件与日期（prospecting 的护栏已要求；其余技能需补）。
2. **敏感属性禁用**：不得按健康、财务困境、政治、性取向、宗教等敏感属性筛选、评分或个性化（prospecting 已明确；其余技能需补）。
3. **退订与抑制**：退订/拒绝立即全通道抑制；发送前检查抑制名单（cold-email 已要求）。
4. **最小化与保留**：只处理完成任务所需的字段；引擎侧按 DSR/TTL 策略执行删除与导出。
5. **禁止批量抓取与绕过**：不抓 LinkedIn 全量、不绕 CAPTCHA/登录墙、不使用来源不明的泄露数据（prospecting 已明确）。
6. **法律文本不是法律意见**：`prospecting/references/compliance.md` 可作为工程基线，但对外发送启用前仍需法务确认（GDPR/CAN-SPAM/CASL 的适用与文本）。

## 7. 供应链观察

- **S-01**：anthropics 仓库根 `LICENSE` 在钉住的 commit 上被追加了无关文本（见 [`VALIDATION.md`](VALIDATION.md) W-01）。已改用干净的 `sales/LICENSE`。建议 S1 在导入管线中对许可证文件做哈希与敏感/异常模式检查，不能只信仓库根文件。
- **S-02**：上游快照中没有发现私钥、API key、令牌或可疑脚本；14 个技能均为纯文本。
- **S-03**：所有来源均钉 commit 并记录 commit date；上游强制推送不会影响已归档快照与哈希。
