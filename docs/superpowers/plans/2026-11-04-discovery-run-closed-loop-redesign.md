# 寻源 Run 2.0：闭环挖掘体系设计（run 与本地挖掘）

> 生命周期：`DRAFT`
> 依据：产品负责人 2026-11-04「改造 run 和本地挖掘客户的体系，需落地、闭环的设计」；前置已批：`2026-11-04-discovery-quick-deep-tiers.md`（快扫/深挖）。本文件是它的上一层结构设计，二者不冲突：两档=时间与质量分层，本文=闭环与体系。

## 一、现状诊断（实测与代码依据）

| # | 问题 | 依据 | 后果 |
| --- | --- | --- | --- |
| 1 | 搜索当主力、意图源缺位 | 最近成功 run 的 84 家公司全部来自 `public_web`（SearXNG+抓页+LLM 抽取） | 信噪比低、慢、贵；真正「刚进过货」的买家不优先 |
| 2 | 阶段屏障全串行 | workflow 顺序：查询→规范化→画像→fit→enrich→信号→联系人→监听 | 首结果要等全轮；慢公司拖全局 |
| 3 | 逐家模型判定、低并发 | `FIT_CONCURRENCY=3`，88 次 fit≈20 分钟，单次 26–55s | 时长直接由模型调用数×并发决定 |
| 4 | 判断结果不回喂 | lead 接受/拒绝、mismatch 理由只落库；ICR 与查询计划不更新 | 每轮重新猜，经验不沉淀 |
| 5 | 查询计划一次性 | 16 组查询生成后不再迭代；来源禁用（ted/samgov）不影响计划 | 无效查询空转 |
| 6 | 监听注册 0、无增量 | 最近成功 run `watches.registered=0`；重复 run 全量重跑 | 公司池是快照，不跟踪变化 |
| 7 | 触达断链 | 有 `lead_outreach_draft`（生成草稿），无发送/回复/退订/频控 | 漏斗后半段缺失 |
| 8 | 无多租户调度 | run 共抢 worker；切换镜像需先清空全部 run | 租户互相拖累；运维敏感 |
| 9 | 可观测性黑箱 | 阶段收尾才写 stats | 深挖期间界面无进度 |

外部对标（2026-11-04 调研）：
- **Clay**：waterfall 补全（多源顺序回退，只对命中的源付费）+ 信号列（融资/招聘/技术栈/意图）+ **ICP 匹配 × 意图强度两轴打分** + 命中即触发（Slack/CRM/序列） + 定时重跑保持新鲜。
- **海关/提单数据**：美国海运舱单属公开记录（AMS/FOIA）；ImportYeti 免费浏览但**无官方公开 API、抓取违反 ToS**（付费 API≈$600/年）；ImportInfo/Port Examiner 可查单公司；ImportGenius/Panjiva/Datamyne 付费；Apify/TradeData.io 提供付费包装 API。**合规的免费路径是「用户导入自有数据」**。
- **闭环外联开源件**：Mautic（IMAP 监控：退信→DNC、退订与 List-Unsubscribe、回复识别、EMAIL_ON_REPLY 停序列）、coldforge（序列、回复→取消、发送窗口/日上限、抑制表）、Twenty（开源 CRM 基座）。这些给出了触达闭环的合规模式。

## 二、目标与五个闭环

一条 run 从「你点开始」到「名单可跟进」≤15 分钟出一条完整链路；系统随着你的判断与外部变化**越跑越准**。

1. **来源闭环**：意图源优先（海关导入 → 展会 → 招标 → 搜索兜底），来源质量被持续度量并影响下一轮查询权重。
2. **流水线闭环**：按公司推进（每家一个 job 状态机），慢公司只影响自己；界面逐家可见。
3. **反馈闭环**：接受/拒绝、mismatch 理由、回复结果 → 聚合为 ICP 修正建议与查询/来源权重 → 下一轮自动生效。
4. **增量闭环**：公司池带新鲜度；监听（官网变化/招聘/招标）真正注册并定时复检；变化触发重新评分与通知。
5. **触达闭环**：草稿→审核→发送→回复识别/退信/退订→商机；频控、发送窗口、List-Unsubscribe 随行。

## 三、架构（落点）

```
ICP + 用户反馈 ──► 计划生成(权重化) ──► 查询/意图源 ──► 公司池(canonical + freshness)
                                            │                  ▲
                          ┌─────────────────┴─────────┐        │增量复检
                          ▼                           ▼        │
                  discovery_company_job（每家一行）      watches/scheduler
                   画像→精判→信号→联系人（子工作流）
                          │
                          ▼
                  leads（fit/scores/queue）+ run events（进度）
                          │
                   用户判断 / 触达结果 ──► 反馈聚合(icp_feedback) ──► 权重与 ICP 建议
```

### 3.1 公司级流水线（核心变更）

- 新增表 `discovery_company_job`：`(workspace_id, run_id, canonical_company_id)` 唯一；`stage`（profile/fit/signal/contacts/done/failed/skipped）、`attempts`、`last_error_code`、`started_at/finished_at`、`cost_cents`、`lease_until`（防重复消费）。
- 编排：run 工作流只负责建 job 批次；每家公司的推进用 **Temporal 子工作流**（`discoveryCompanyWorkflow`，每 job 一个，可取消、可观测、失败只影响自身），或等价的活动+租约批处理（决策 D2）。
- 阶段完成后写 job 行 + 发 run event；run 页按 job 聚合出「已进入 N / 完成 M / 卡在哪家」。
- 快扫/深挖变为 job 的两档推进：快扫阶段只跑 `quick-fit`（规则预筛+flash 粗判），深挖 job 跑 `profile→fit→signal→contacts`（详见两档设计）。

### 3.2 来源闭环

- **海关提单导入通道（P0，免费、合规）**：新增「买家清单导入」（CSV/粘贴：公司名、国家、地址、HS 码、近 12 月提单数/量），落 `imported_buyer`→进公司池并打 `intent:customs` 标签；导入的公司直接进入快扫名单，无需搜索与抽取。为后续供应商 adapter（TradeData.io/Apify/ImportYeti 付费 API）预留 provider 接口，但**默认关闭、条款评估后由用户开启**。
- **Trade Map（P1）**：宏观市场选择建议（选目标国家优先级），只进 ICP 建议，不进公司级名单。
- **查询权重**：每轮按查询/来源计算产出质量（accepted→match→accept 转化），EMA 存 `icp_query_performance`；计划生成读取历史权重（降低长期低产出的查询族）。

### 3.3 反馈闭环

- 数据：复用 `lead_decision` + `lead.fitReasons`；聚合表 `icp_feedback`（workspace×icp：按来源/行业/国家/查询族的接受率、mismatch 理由分布）。
- 产出：①「ICP 建议」（例如「mismatch 集中在行业 X，建议移除」「该来源 0 接受，已降权」）；②查询权重；③下一轮计划提示词注入这些事实。
- UI：寻源页与 ICP 页展示建议卡片，用户一键采纳（写回 ICP 规则）或忽略。

### 3.4 增量闭环

- 公司池 freshness：`canonical_company.last_seen_at/last_checked_at`；run 命中已存在公司时只刷新字段与信号，不重复判 fit（除 ICP 变化）。
- 监听：`registerWatchesForRun` 修到真正注册（诊断 0 的原因：robots/无 sitemap/阈值）；watches 由平台 schedule 定时复检，变化→发事件→按 ICP 重新评分→通知。
- 依赖 ICP fit 判定缓存（ICP+画像 hash），ICP 不变则复用。

### 3.5 触达闭环（M3，独立合规评审后启动）

- 发送：先自建 SMTP（企业邮箱/自有域名，SPF/DKIM/DMARC 检查；参考 coldforge 的发送窗口/日上限/序列状态机）；ESP（Instantly/Smartlead）作可选通道，需条款与付费评估。
- 回复与退订：IMAP 监控（Mautic 模式）——回复识别（Message-ID/In-Reply-To）→ 停序列 + 回复分类（感兴趣/不感兴趣/退订/自动回复）；退信→DNC；退订链接 + `List-Unsubscribe(-Post)` 头；抑制表全局生效。
- 审计与频控：每次发送落审计；per-tenant 发送配额；所有触达经 lawful-basis 与制裁/抑制门。
- UI：线索详情页「外联」页签（草稿→发送→回复时间线）。

### 3.6 调度与可观测性

- 多租户：run 调度器（per-workspace 最大并发 run=1、全局并发池、交互式优先于定时）；run 可暂停/取消（取消语义已有）。
- 模型网关：并发池 + 429 熔断与渠道切换；保留 5/25 分钟退避但改为可配置（默认收紧，见两档设计的 D 决策）。
- 事件：`run_event` 表（stage/job/level/at/detail），API 增量拉取；前端 3 秒轮询即可。

## 四、数据模型变更（M1 迁移清单）

1. `discovery_company_job`（新表，含 RLS 与 app_user 授权）。
2. `imported_buyer`（导入原始行，去重键：workspace+normalized_name+country）。
3. `icp_query_performance`（workspace×icp×query_family 的 EMA）。
4. `run_event`（增量进度）。
5. canonical_company：`last_seen_at/last_checked_at`。
6. （M3）`outreach_message` / `reply_event`。

## 五、里程碑（落地顺序，可独立验收）

- **M1（先做）**：两档实现 + `discovery_company_job` + run_event + 进度 API/UI + 海关清单导入通道（CSV→公司池→快扫名单）。
  验收：导入 200 家买家清单，≤2 分钟名单可见；搜索通道 run 仍 ≤8 分钟出首批。
- **M2**：反馈闭环（icp_feedback 聚合 + 查询权重 + ICP 建议卡）+ watches 修复与定时复检。
  验收：连续两轮 run 中，低产出来源权重下降；你拒绝的行业在下一轮 ICP 建议中被标出。
- **M3**：触达闭环（发送/回复/退订/频控，SMTP 自建优先）。
  验收：一批线索完成「草稿→发送→收到回复→自动停序列/退订落 DNC」，全链路留审计。
- **M4**：多租户调度 + 成本/配额面板。

## 六、决策点（待拍板）

- **D1 公司级流水线实现**：Temporal 子工作流（推荐：隔离/可取消/可观测）vs DB 状态机+租约 activity。
- **D2 触达通道**：先自建 SMTP（推荐，免费）vs ESP 付费通道。
- **D3 海关数据**：先导入通道（推荐，零成本零条款风险）vs 直接接付费 API（TradeData.io/Apify，~$5/千行或年费）。

## 七、风险

- 流水线化改动面大：用 patch 守卫与影子模式（先双跑对比）降低重放风险。
- 子工作流数量：单 run 公司多时子工作流爆炸（Temporal 建议批量）；限制并发子工作流数并压测。
- 触达合规：发送前必须过 lawful-basis/制裁/抑制/频控四门；退订与 DNC 全局生效；对方国家法规（CAN-SPAM/GDPR/PECR）按租户目标市场提示。
- 导入数据质量：用户 CSV 需规范化（公司名/域名/国家），冲突合并进公司池按既有 dedupe 键。

## 八、参考（2026-11-04 调研）

- Clay waterfall/signals 模式（多源回退、命中付费、两轴打分、定时重跑）
- ImportYeti / ImportInfo / Port Examiner / ImportGenius / Panjiva（提单数据可得性与条款）
- Mautic（回复识别/退订/退信 DNC）、coldforge（序列/发送窗口/日上限）、Twenty（开源 CRM 基座）
