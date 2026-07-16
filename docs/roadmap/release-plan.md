# roadmap/release-plan —— 当前主线与获客封版路线（L2）

> 2026-07-10 v2（获客合流定稿）；**2026-07-16 truth-sync（#125）与 R0 contract closeout（#126）更新**。历史实施日志见 [changelog.md](changelog.md)。
> 六项获客工程收口已完成，但自 2026-07-13 起获客 R1–R3 与所有新 provider 暂停（非取消）。**当前唯一开发主线是 Site Builder**；旧 Word、v3.1/v3.2 与研究稿不具有排期权威。

## 0. Site Builder 当前路线

### 已完成到哪里

- M0 建站快路径、Astro 渲染器、素材/KB/构建端点已存在；DQ-1 SiteSpec 1.0.0 共享类型由 #117 落地。
- DOC-12 的主要内容分发由 #119/#120 完成；2026-07-16 truth-sync 已收口项目级状态与接入说明，未把 dated proposal 升级成权威。
- #121 已完成 intake 无条件建站/触发 demo 的**行为层**修复；#123 完成禁虚构身份；#124 完成 businessEmail 隔离、LLM 真取消超时和异步失败保站。
- #126 已完成 R0 contract closeout：intake 幂等、`buildId`、去 `mode`、稳定错误码、Temporal 启动证据与 OpenAPI 同步均已落地并验证。
- R1-safety 与 R2-A1–A4 正确性门已于 2026-07-17 完成。Profile 已具备五组严格有界 schema、独立 UUID ETag/CAS、稳定 428/409/412、同站 Asset 引用门；旧脏 JSON读路径 fail-closed，Prompt/证据入口覆盖 SMTPUTF8/IDN 邮箱与电话净化。A4 接通 staging-only cleanup：Outbox→Temporal 以事件/资产双 provenance，在 presigned PUT 到期后固定等待 15 分钟受支持在途窗口，首删后 durable settle 5 分钟并二次删除+HEAD；窗口由生产代码固定，客户端/Outbox 不可缩短。该机制覆盖到期前授权、窗口内完成的 PUT 复活竞态，不把“仅到期”写成绝对保证；canonical 继续 parked 到 MF-0 scanner。Asset/KB/Build 公共错误已稳定化并脱敏，Build cancel 改 CAS，失败 cleanup 有结构化告警与 guarded redrive。以上均为 Ubuntu 开发环境验收，不代表生产部署。

### 当前关键路径与退出门

1. **R1-safety ✅ 2026-07-17 完成**：两个小 PR 分别完成 (a) SiteSpec 随机 0700/0600 临时物化、成功/异常 `finally` 清理、Renderer 固定入口与 7 变量 env allowlist；(b) 移除 Ubuntu fake-IP 的 `CRAWL4AI_ALLOW_INTERNAL_URLS`，在 API 与 Crawl4AI 两层落 global-unicast 校验、fake-IP-only 固定 DoH 回退、连接 pinning、redirect 逐跳重验及响应上限。`websiteUrl → brand research → crawl4ai`、robots 与 `http.get` 均受控，公网正例和 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 真机负例全绿。R1-min 其余 per-run staging、不可变 artifact、active pointer 原子切换、unknown component fail-closed 可与 R2/M1-c 并行，但必须在 M1-e 可见预览前完成。
2. **R2-A 正确性门（拆分 PR）✅**：R2-A1 Asset、R2-A2 KB、R2-A3 Profile schema/乐观并发、R2-A4 staging cleanup/公共错误码/跨系统集成均已收口；canonical 删除明确不属于 A4。禁止回退成 migration/API/状态机 mega PR。
3. **MF-0-thin（连续两个独立交付，总范围不缩水）**：
   - **MF0-A ✅ 2026-07-17 完成**：`AssetVariant` + RLS/FORCE RLS、单输出 recipe/checksum/复合 provenance、ready+checksummed source 门、MIME→规范扩展名精确绑定的 Variant 专属对象键、不可改写行身份/来源账本与 RLS-safe 脏升级 fail-closed 预检、`derivedKeys` 响应式共享合同及纯兼容投影；真 PostgreSQL A/B/unset 隔离、并发 unique、增量/空库 44 migrations 与 schema diff=0 已验证。仅为 Ubuntu 开发环境，不代表生产部署。
   - **MF0-B（下一项）**：SiteSpec+Profile 引用扫描器、删除 409、删除与 spec/Variant 写入共享并发门，以及 provenance 严格的 canonical+Variant 异步回收/历史 parked 对账。在 MF0-B 完成前，只允许自动清理 staging，不把 canonical object 删除描述为安全能力。
4. **M1-c**：纯 Sharp 确定性图片管线；不加入 rembg、生成图、视频、Readdy、设计 Agent、MediaJob/AssetUsage 预建。

并行泳道遵循 [Site Builder 09 §11](../site-builder/09-m1-implementation-design.md)：IT-0 效果验证、R3/R4/DI-0、MODEL-0/EVAL-bootstrap 可在依赖允许时推进；MF-1/MODEL-2 只由真实消费者/流量与独立 ADR 触发。

---

以下为**冻结的获客路线**，保留作为恢复开发时的历史计划。

## 1. 六项工程收口（历史已完成；当前暂停、无执行 owner）

| # | 收口 | 做什么 | 验收 |
|---|---|---|---|
| ✅① | **CandidateAssessment（完成，PR #43）** | Fit/原因/评分特征/水位从 canonical_company 迁到 ICP×公司维（演进现有 Lead 表或新表 + migration） | 同 workspace 两个 ACTIVE ICP 各自独立 Fit 不互相覆盖（回归测试）；backlog sweep 按 ICP 维取件 |
| ✅② | **ExecutionContext + Broker 真收口（完成，PR #51）** | ExecutionContext 贯穿；发现/富集/intent 主链全经 Broker；source_policy 未登记 fail-closed；BudgetLedger 真开账；allowedTools 填实；修伪 workspace trace 静默失败 | ✅ provider 无直连 HTTP（13 工具收编 22 处出网，业务层 grep 清零；例外四类登记：robots/DNS/模型网关/outbox webhook）；预算超限真拦截（Broker 工具门 + LLM 网关门真库实证；settle 按 token 折算，截断显性化 run 转 PARTIAL）；AI trace 写入成功（真库 15 断言：真写入 + 伪 workspace 负向对照 0 行；TED E2E 全绿；对抗复审 11 findings 全修） |
| ✅③ | **LeadQualifiedPackage 真实交付（完成，PR #46）** | 快照 schema（v1，demand_proof 可空）入 contracts；`outbox_delivery` 按 sink 投递/重试/ACK/DLQ；`GET /events?cursor`（B 出端点）；**禁止无 handler 事件标 published** | ✅ 未注册事件 parked 不标 published；游标=交付账本行 id、任意重放 + ACK 幂等（真库 RLS 实测 24 断言）；LeadQualified 有 ajv Consumer Test（单测 + 真库端到端） |
| ✅④ | **OpenAPI 单一真值 + 统一信封（完成，PR #48）** | 删旧 YAML；contracts 脚本改读 openapi.json；CI：导出+lint+oasdiff；contracts README 改 code-first；统一返回信封定稿 | ✅ 双源消失（YAML 删、5 脚本读 JSON）；破坏性变更 CI 拦截（contracts job：drift+spectral+oasdiff，`breaking-change-approved` label 放行，首跑即绿）；B 读路径 38 业务操作全套 `{data}`/`{data,page:{next_cursor,has_more}}` 信封（真库 18 断言 + 契约 ajv 校验） |
| ✅⑤ | **一等 Signal + ingest-once（完成，PR #56）** | `source_signal`（平台级零个人数据）+ 租户投影两层 + 状态机；TED/FDA 写 Signal；attributes.intent 降为投影；快照 scores 升 v2 填 demand_proof | ✅ 同一外部源同一时间窗跨 workspace 只拉取一次（`signal_ingest` 账本：指纹×6h UTC 桶唯一键；真库实测 24 条真招标一次拉取、双 workspace 各投 18 家且投影零出网）；✅ 可过期（EXPIRED/REVOKED 投影与复算剔除 + 撤即脱敏）/可复算（recompute surfaces=与增量同过滤面，重建后 unchanged 不动点）/可 backtest（双时间轴 occurred/observed 落库）；✅ demand_proof 真值进快照（v1 槽位零破坏填充，rule→additive-6dim-v2；乘法门仍待 R2 backtest）。对抗复审 3 维 21 agent 14 缺陷全修/记档 |
| ✅⑥ | **存储合规收口（完成，PR-A #60 + PR-B）** | DataRightsService.evaluate() + 7 动作词表 + policy_decision_log + LIA 记录 + Art.14 通知义务判定；deletion_request/receipt + deletionWorkflow；dataClass 列；PII 列级加密；DB 角色拆分；jurisdiction_policy（含 PIPL 行） | ✅ DSR 全链演练通过（真库 31 断言：contact/company 主体擦除 + 幂等 + 无 PII 残留 + 并发去重 + 部分失败忠实回执 + append-only 护证 + 擦除完整性；PR-A/B 各一轮对抗复审全修）；✅ 删除编排建成=满足「删除编排先于任何发送上线」时序门前置（R1 发送上线时联合校验）；✅ 具名决策人字段加密落库（PR-A） |

## 1.5 获客能力「封版」定义（六收口的总验收，吸收交付包 §9.4）

满足后**封版为可消费服务**：① 输入 Company/Offering/ICP 后一个受控 Run 产出 Candidate Batch；② 每个公司/联系人带 Canonical ID、来源、Evidence、权利、时效、验证状态、成本和未知项；③ 候选带分解评分与 Reason Code；④ 用户可接受/拒绝/纠正，反馈进评测且不跨租户泄露；⑤ 支持取消/重试/Partial/预算停止/Provider 降级/公平扫描（无饿死）；⑥ OpenAPI、事件、进度、RLS、删除、审计、测试、SLO 完整；⑦ 一组真实企业样本 E2E/UAT；⑧ **输出合同被下一能力真实消费，而不是停在数据库里**。
裁决：Docling/Langfuse **不进**封版 Gate（按需后置）；Golden Set 三任务在 R2。

## 1.6 选项 B —— 决策人多途径发现与联系方式补全（业务价值线，与收口并行）

用户痛点：官网能拿决策人姓名+职务，缺「本人可用邮箱」。方案=多途径交叉 + 邮箱排列验证 + 融合档案，**不局限单一途径、不碰 LinkedIn 直爬红线**。完整立项 spec（9 条身份途径 + 5 条联系方式途径 + 融合架构 + 分期 backlog + 合规红线 + 诚实能力预期）见 **[decision-maker-multi-source-spec.md](decision-maker-multi-source-spec.md)**。
- **P0**（最省、最对痛点，复用 smtp_self）：✅ 邮箱模式排列生成器 + ✅ 公司邮箱格式学习 + ✅ 落库接线（`email-permutation`·`email-format-learning`·`email-guesser`·`email-guess-persist` + service `guessEmailsForCompany`，50 单测 + 端到端真数据实测，见 spec）；⬜ 跨源身份解析 + 接入 discovery/backlog 主链自动触发（下一步）。
- **P1**（免费绿源）：专利 inventor · 公司注册处董事 · 商标代表。
- **P2**（灰/谨慎）：LinkedIn 经搜索 · 新闻 PR · 展会演讲者。

## 2. R0-R3 路线（与交付包 R0-R5 映射：其 R0=本 R0，R1 获客 Pilot=本 R0/R1 封版，R2 Campaign=本 R1 SaaS 侧，R3 QGO Pilot=本 R1 末~R2，R4/R5=本 R3+）

| 阶段 | 本仓领域层（历史计划） | B | A / SaaS 侧 | 退出条件（标注归属） |
|---|---|---|---|---|
| **R0 握手+收口**（2-4 周） | 收口①-④ + 删除编排启动 + 文档迁移；保持 sweep 运转 | 读路径 OpenAPI（套统一信封）+ `GET /events` + roles→scopes 映射 | JWKS+claim；登录/Workspace；Lead 队列查看页 | A 真 token 经 B 读到真实 lead（A+B+C）；LeadQualified 可被拉取并 ACK（B+C） |
| **R1 单渠道最小闭环**（6-8 周） | 收口⑤⑥完成；QualificationDecision 定版；快照 scores 升 v2 | 写路径 API + 审批校验最小版 | **Campaign 最小对象 + 邮件受控发送 + 收件箱 + QGO 手工确认**（SaaS 侧建设，参照 product-scope 附录 A） | 内部账号全链走通一次（发送段=A/SaaS，供给段=C）；0 未授权动作（A+C）；**删除编排（C）先于发送（A）上线**（联合时序门） |
| **R2 真实试点**（8-12 周） | 游标饿死根治验收（缺口 8）+ Golden Set 三任务（fit 门/抽取/CPV·FDA 映射，各 30-50 例离线集进 CI）+ ADR-007 身份图最小版 + 乘法门 backtest 基建（启用以人工确认 QGO 标签 ≥50 条为门） | 归因报表 API | 2-3 家 Design Partner 运营 | 3 家中 ≥2 激活、≥1 家 30 天内出人工确认 QGO（A+C）；数据权利/Suppression 100%（C） |
| **R3 补域** | 研究域最小 4 层版（可选提前）；新 provider（SAM/专利/提单）——**前置：ADR-007 最小版就位 + DLP 核实完成** | 发布 API | AiToEarn 1-2 平台 / Pack 内容 / SAO 回流 | 试点续约/付费意向 |

**依赖主干**：JWKS(A) → 读契约(B) → 事件出口(B+C) → SaaS Campaign 对象(A) → 审批授权(A+B) → 邮件发送(A) → 回流(A→C 标签) → QGO 确认(A) → 归因；**删除编排──必须先于──邮件发送**。可并行：收口①②④⑤⑥/研究域/Golden Set/A 的登录页。

**风险 Top5**：A 侧握手单点（契约先行+dev stub；A 延期则 API-only 试点、Scalar 门户当临时 UI）/ 发送先于删除（R1 联合时序门）/ 邮件单渠道押注（partner 自有域+小批量+B 门最小版）/ 无运维兜底（备份+告警+三 Runbook：邮件退信投诉/爬虫安全/数据删除）/ 范围回摆（ADR-001 拦住，变更须三方书面确认）。
