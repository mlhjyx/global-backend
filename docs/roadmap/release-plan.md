# roadmap/release-plan —— 六项收口 + R0-R3 交付路线（L2）

> 2026-07-10 v2（合流定稿）。历史实施日志见 [changelog.md](changelog.md)。**最高优先=六项工程收口，替代「继续加 provider」（先不加 SAM/专利/提单/新源）。**

## 1. 六项工程收口（owner=C+Claude）

| # | 收口 | 做什么 | 验收 |
|---|---|---|---|
| ✅① | **CandidateAssessment（完成，PR #43）** | Fit/原因/评分特征/水位从 canonical_company 迁到 ICP×公司维（演进现有 Lead 表或新表 + migration） | 同 workspace 两个 ACTIVE ICP 各自独立 Fit 不互相覆盖（回归测试）；backlog sweep 按 ICP 维取件 |
| ② | **ExecutionContext + Broker 真收口** | ExecutionContext 贯穿；发现/富集/intent 主链全经 Broker；source_policy 未登记 fail-closed；BudgetLedger 真开账；allowedTools 填实；修伪 workspace trace 静默失败 | provider 无直连 HTTP（登记例外除外）；预算超限真拦截；AI trace 写入成功 |
| ✅③ | **LeadQualifiedPackage 真实交付（完成，PR #46）** | 快照 schema（v1，demand_proof 可空）入 contracts；`outbox_delivery` 按 sink 投递/重试/ACK/DLQ；`GET /events?cursor`（B 出端点）；**禁止无 handler 事件标 published** | ✅ 未注册事件 parked 不标 published；游标=交付账本行 id、任意重放 + ACK 幂等（真库 RLS 实测 24 断言）；LeadQualified 有 ajv Consumer Test（单测 + 真库端到端） |
| ④ | **OpenAPI 单一真值 + 统一信封** | 删旧 YAML；contracts 脚本改读 openapi.json；CI：导出+lint+oasdiff；contracts README 改 code-first；统一返回信封定稿 | 双源消失；破坏性变更 CI 拦截；B 读路径端点全部套用信封 |
| ⑤ | **一等 Signal + ingest-once** | `source_signal`（平台级零个人数据）+ 租户投影两层 + 状态机；TED/FDA 写 Signal；attributes.intent 降为投影；快照 scores 升 v2 填 demand_proof | 同一外部源同一时间窗**跨 workspace 只拉取一次**；信号可过期/可复算/可 backtest |
| ⑥ | **存储合规收口** | DataRightsService.evaluate() + 7 动作词表 + policy_decision_log + LIA 记录 + Art.14 通知义务判定；deletion_request/receipt + deletionWorkflow；dataClass 列；PII 列级加密；DB 角色拆分；jurisdiction_policy（含 PIPL 行） | DSR 全链演练通过；**删除编排先于任何发送上线**；具名决策人字段加密落库 |

## 1.5 获客能力「封版」定义（六收口的总验收，吸收交付包 §9.4）

满足后**封版为可消费服务**：① 输入 Company/Offering/ICP 后一个受控 Run 产出 Candidate Batch；② 每个公司/联系人带 Canonical ID、来源、Evidence、权利、时效、验证状态、成本和未知项；③ 候选带分解评分与 Reason Code；④ 用户可接受/拒绝/纠正，反馈进评测且不跨租户泄露；⑤ 支持取消/重试/Partial/预算停止/Provider 降级/公平扫描（无饿死）；⑥ OpenAPI、事件、进度、RLS、删除、审计、测试、SLO 完整；⑦ 一组真实企业样本 E2E/UAT；⑧ **输出合同被下一能力真实消费，而不是停在数据库里**。
裁决：Docling/Langfuse **不进**封版 Gate（按需后置）；Golden Set 三任务在 R2。

## 1.6 选项 B —— 决策人多途径发现与联系方式补全（业务价值线，与收口并行）

用户痛点：官网能拿决策人姓名+职务，缺「本人可用邮箱」。方案=多途径交叉 + 邮箱排列验证 + 融合档案，**不局限单一途径、不碰 LinkedIn 直爬红线**。完整立项 spec（9 条身份途径 + 5 条联系方式途径 + 融合架构 + 分期 backlog + 合规红线 + 诚实能力预期）见 **[decision-maker-multi-source-spec.md](decision-maker-multi-source-spec.md)**。
- **P0**（最省、最对痛点，复用 smtp_self）：✅ 邮箱模式排列生成器 + ✅ 公司邮箱格式学习 + ✅ 落库接线（`email-permutation`·`email-format-learning`·`email-guesser`·`email-guess-persist` + service `guessEmailsForCompany`，50 单测 + 端到端真数据实测，见 spec）；⬜ 跨源身份解析 + 接入 discovery/backlog 主链自动触发（下一步）。
- **P1**（免费绿源）：专利 inventor · 公司注册处董事 · 商标代表。
- **P2**（灰/谨慎）：LinkedIn 经搜索 · 新闻 PR · 展会演讲者。

## 2. R0-R3 路线（与交付包 R0-R5 映射：其 R0=本 R0，R1 获客 Pilot=本 R0/R1 封版，R2 Campaign=本 R1 SaaS 侧，R3 QGO Pilot=本 R1 末~R2，R4/R5=本 R3+）

| 阶段 | 本仓 C+Claude | B | A / SaaS 侧 | 退出条件（标注归属） |
|---|---|---|---|---|
| **R0 握手+收口**（2-4 周） | 收口①-④ + 删除编排启动 + 文档迁移；保持 sweep 运转 | 读路径 OpenAPI（套统一信封）+ `GET /events` + roles→scopes 映射 | JWKS+claim；登录/Workspace；Lead 队列查看页 | A 真 token 经 B 读到真实 lead（A+B+C）；LeadQualified 可被拉取并 ACK（B+C） |
| **R1 单渠道最小闭环**（6-8 周） | 收口⑤⑥完成；QualificationDecision 定版；快照 scores 升 v2 | 写路径 API + 审批校验最小版 | **Campaign 最小对象 + 邮件受控发送 + 收件箱 + QGO 手工确认**（SaaS 侧建设，参照 product-scope 附录 A） | 内部账号全链走通一次（发送段=A/SaaS，供给段=C）；0 未授权动作（A+C）；**删除编排（C）先于发送（A）上线**（联合时序门） |
| **R2 真实试点**（8-12 周） | 游标饿死根治验收（缺口 8）+ Golden Set 三任务（fit 门/抽取/CPV·FDA 映射，各 30-50 例离线集进 CI）+ ADR-007 身份图最小版 + 乘法门 backtest 基建（启用以人工确认 QGO 标签 ≥50 条为门） | 归因报表 API | 2-3 家 Design Partner 运营 | 3 家中 ≥2 激活、≥1 家 30 天内出人工确认 QGO（A+C）；数据权利/Suppression 100%（C） |
| **R3 补域** | 研究域最小 4 层版（可选提前）；新 provider（SAM/专利/提单）——**前置：ADR-007 最小版就位 + DLP 核实完成** | 发布 API | AiToEarn 1-2 平台 / Pack 内容 / SAO 回流 | 试点续约/付费意向 |

**依赖主干**：JWKS(A) → 读契约(B) → 事件出口(B+C) → SaaS Campaign 对象(A) → 审批授权(A+B) → 邮件发送(A) → 回流(A→C 标签) → QGO 确认(A) → 归因；**删除编排──必须先于──邮件发送**。可并行：收口①②④⑤⑥/研究域/Golden Set/A 的登录页。

**风险 Top5**：A 侧握手单点（契约先行+dev stub；A 延期则 API-only 试点、Scalar 门户当临时 UI）/ 发送先于删除（R1 联合时序门）/ 邮件单渠道押注（partner 自有域+小批量+B 门最小版）/ 无运维兜底（备份+告警+三 Runbook：邮件退信投诉/爬虫安全/数据删除）/ 范围回摆（ADR-001 拦住，变更须三方书面确认）。
