# 实现状态矩阵（设计 ↔ 实现）

> 文档 ID：`DOC-STATUS-IMPLEMENTATION-MATRIX-001`
> 生命周期：`CURRENT`
> 最后核验：2026-11-08（M2 收官回写；其余行沿用 2026-11-02 基线）
> 用法：排期与验收的唯一矩阵；详细证据见各模块 `technical.md` 与 `status/current.md`。

| 模块 | 能力 | 设计 | 实现 | 测试 | 运行 | 缺口/下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 账户与工作空间 | 注册/登录/会话 | APPROVED | gain-saas as-built | 部分 | 运行 | 限流已落库（2026-11-02）；CSRF/cookie Secure 待核 |
| 01 | 工作空间/成员/切换 | APPROVED | as-built | 少 | 运行 | `/api/workspace/context`（角色/允许动作/引导态）已上线（2026-11-03）；Entitlement 预算与计费仍待 Phase 1b/二期 |
| 01 | 注册引导 | APPROVED | gain-saas as-built（2026-11-03 上线） | 有（onboarding 控制器 8 例 + BFF 门禁） | 运行 | 注册页「创建账号」口径与邀请码显隐已整改；公司名去留等字段细则留 Phase 5 |
| 02 卖家知识中心 | 公司档案/Offering/Claim | APPROVED | 引擎 as-built | 中 | 运行 | `targetMarkets`/`businessEmail`/`Offering.source` 已落（#743，2026-11-02 迁移） |
| 02 | 资料库（上传/解析/检索） | APPROVED | as-built（2026-11-05 上线并验收） | 中 | 运行 | —（#747/#749/#751：presign/commit、Docling→分块→BGE-M3→pgvector 检索） |
| 02 | 文档事实抽取/审批 | APPROVED | as-built（抽取→Claim/Evidence→审批） | 中 | 运行 | 资料消费扩展（Phase 3）本轮冻结 |
| 02 | 理解双源/ICP 消费 | APPROVED | as-built（官网 + 资料库双源，2026-11-05） | 中 | 运行 | — |
| 03 买家知识网络 | canonical/证据/联系人 | APPROVED | as-built（M1–M4） | 中 | 运行 | 联系方式分类 v2 与 Impressum 公司级联系人已入 main（A4 #875 / A1 #888，2026-11-08，随下一班镜像生效）；背调（Phase 3 冻结）、customs 源（RL2）仍缺 |
| 03 | 禁联/信号 | APPROVED | as-built | 中 | 运行 | 站内通知（P5 alerts）与禁联名单设置页（gain-saas #108）已上线（2026-11） |
| 04 发现与资格 | ICP/计划/run/线索/交付包 | APPROVED | as-built | 强 | 运行 | Run 2.0 / cheap-first enforce 已上线并验收（2026-11-07）；逐源启用（Q33③）按路线图推进 |
| 04 | 任务/重试（SaaS） | APPROVED | as-built（前移并入 Run 2.0） | 强 | 运行 | AcquisitionTask/TaskRun 映射、rerun 新 run/新 Grant、attempt 串链与双击幂等已验收（2026-11-06） |
| 05 独立站 | M1（intake/素材/KB/Release） | APPROVED | as-built | 中 | 运行 | 冻结（PRD4-D1）；M2/M3 未实现 |
| 06 内容与 GEO | 目标 | 设计 | 缺 | — | — | 后续模块 |
| 07 触达与会话 | 受控邮件触达（email first） | APPROVED（M2 步 11 设计，2026-11-08 合入） | as-built（批次/草稿/L2 审批门/逐封发送门/审计包/DNC/退订/回复即停；gain-saas #104/#106/#107 + 引擎 #883/#896） | 强（离线 E2E 16/16 + dkimpy、部署态负向复跑 #900、Playwright 触达用例） | 部分（部署可用；发送开关默认关、仅回环白名单、16 收件人上限） | 生产发送需产品负责人开启；真实域名 SPF/DKIM/DMARC 实检待域名（D1②） |
| 08 机会与 QGO | 机会/QGO/SAO/Outcome | APPROVED（M2 步 10 设计 #853） | as-built（QGO/SAO/Opportunity/Outcome + CandidateBatch v2 + 事件入 inbox，2026-11-08） | 强（E2E-M2.10 全链 + 负向 400 三层文案） | 运行 | 报价/订单/单证属 M3 |
| 09 学习与增长 | 目标 | 设计 | 部分（成本归集 usage_ledger→cost_ledger 已上线 #824/#825；技能运行时 S0/S1 已入 main；记忆层 D-MA-7 设计已批未施工） | 中 | 部分 | Phase 8 平台学习层（法务前置）；记忆层与跨租户驾驶舱待排期 |
| 平台 | R4 平台权威 | 设计 | gain-saas 迁移完成 | 中 | 运行 | GrowthOS 退役收尾 |
| 平台 | 事件消费 | APPROVED | as-built | 少 | 运行 | 即时触发/对账/毒事件隔离（Phase 6） |
| 平台 | 可观测性 | APPROVED | 部分（ai_trace、agent 决策轨迹、站内 alerts 已上线） | 少 | 部分 | 统一 metrics/告警与 OTel 追踪（Phase 6） |
| 平台 | 成本账本 | APPROVED | as-built（#824/#825） | 中 | 运行 | 2026-11-06 真实 run 验证事件 cost=1.18 与 `cost_ledger` 1,180,000µUSD 一致；花费上限目前只覆盖 discovery 模型成本（B10 三账对齐） |
| 平台 | 备份 | APPROVED | as-built（db-backup 每日 03:30 覆盖 global_dev、new-api、原生 Temporal 与 gain-saas 5433，保留 7 份） | — | 运行 | 异地副本待有真实客户数据后（2026-10-01 决定） |
| CI/CD | 5 项必需检查 | APPROVED | as-built | 强 | 运行 | 2026-11 加固（#810/#811/#813：作业超时、registry 缓存、Debian 快照前端） |
| CI/CD | dev 自动发布 | APPROVED | 缺 | — | — | Phase 1b（发布仍为 workflow_dispatch + 产品负责人发车，按设计不自动） |
| 前端 | 六步主链路 | APPROVED | as-built（P6 导航重构（任务为轴）+ Campaign/Inbox/寻源过程页） | 强（Playwright 主链路 11 用例 + CI e2e、移动端 11 页冒烟、视觉基线；e2e fixme=0） | 运行 | 详情页渐进完善；零术语 lint 已在 CI |
| 前端 | 资料库/背调/任务中心 | APPROVED | 部分（任务中心、资料库、触达页已上线；背调缺） | 中 | 运行 | 背调（Phase 3 冻结） |

## 图例

- 设计：`APPROVED` / `DRAFT` / `SUPERSEDED`。
- 实现：`as-built` / `部分` / `缺`。
- 测试：`强` / `中` / `少` / `无`。
- 运行：`运行` / `部分` / `—`（无运行证据）。

## M2 收官回写（2026-11-08）

本日按 M2 验收台账回写 02/03/04/07/08/09/平台/前端各行。证据：`docs/evidence/2026-11-08-m2-acceptance.md`（M2 汇编）、`docs/evidence/2026-11-08-m2-2-acceptance.md`（M2.2 指标闭环）、`docs/evidence/step13-l2-closure-20261108/`（基线 #899 + 修复后部署态复跑 #900）、`docs/evidence/outreach-11-x-gaps-20261108/`（步 11 五缺口）；SaaS 侧 PR：gain-saas #75/#78/#79/#80/#82/#89/#94/#104/#106/#107/#108/#111/#115/#116。
