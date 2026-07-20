# 按角色阅读任务与文档可用性验收

> 文档 ID：`BASE-FE-P8-002`
> 层级：`L3 / Usability test plan and author dry-run evidence`
> 状态：`READY_FOR_GATE_8_REVIEW`
> 测试 Owner：`OWN-QA-EVIDENCE`
> 作者走查：`AUTHOR_ROUTE_DRY_RUN`
> 独立人工状态：`NOT_RUN / BLK-FE-006`
> 核验日期：2026-07-20

## 1. 测试原则

文档可用性不是“链接能打开”。每个角色从[文档门户](../../README.md)开始，在不询问作者、不搜索聊天记录的前提下完成一个真实判断或交付任务，并指出：事实源、当前状态、阻塞、下一动作和不能推出的结论。

本轮由作者执行路径 dry-run，只证明路线存在且任务可被说明；作者不能作为独立用户、产品、设计、前端、后端、QA 或运营签发人。独立验收继续受 `BLK-FE-006` 约束。

## 2. 统一执行协议

1. 记录角色、真实执行人、日期和起点；
2. 只沿门户/Registry 链接，不使用作者口头提示；
3. 在 15 分钟内完成任务并记录实际点击路径；
4. 回答“当前是什么、目标是什么、谁负责、缺什么、证据在哪里”；
5. 发现死链、双真值、未知词或无法完成时登记 finding，不自行补猜；
6. 由文档 Owner 修正后重跑；作者与 reviewer 分开。

通过标准：找到唯一真值且没有把 Mock/目标/测试锚点/开发探针误写成已实现或已发布。超时本身是 finding，不通过“多读几遍”消除。

## 3. 角色任务

| Route ID / 角色 | 真实任务 | 必须找到 | 成功回答 | 失败信号 |
|---|---|---|---|---|
| `ROUTE-FE-001` 新成员 | 判断项目当前唯一主线和前端文档项目完成到哪 | Portal → status/product scope → program/Gate | Site Builder 是当前主线；SaaS 管理 UI 与公开站输出分层；Phase 8 只做治理 | 从 Word/GoodJob/Mock 推出当前路线 |
| `ROUTE-FE-002` 产品 | 判断“独立站发布/域名/询盘”是否可对客户承诺 | Capability Registry → Site Pack → blockers | 当前承诺止于可信开发预览；发布链 `TARGET_NOT_RUNNABLE`，受 `BLK-FE-007` 阻塞 | 把 renderer/preview 当公网发布 |
| `ROUTE-FE-003` 设计 | 为 Build 失败恢复评审页面与文案 | Page/Capability → 状态规范 → Site wireframe/copy/operations | 找到 `PAGE-FE-040..043`、失败类别、保留旧结果/取消/恢复和 Copy ID；设计仍非受控视觉稿 | 只画 happy path 或把书面低保真写成 DESIGNED |
| `ROUTE-FE-004` 前端 | 拆“发起 Build→观察→取消→预览”纵切 | 实施蓝图 → operationId → 状态/allowed actions → Scenario | 使用机器 OpenAPI、13 个 Site operation 映射、ETag/ACK/cancel/late result 语义；正式 repo/allowed actions 仍 blocked | 从手写 URL 或 Mock 角色表开工 |
| `ROUTE-FE-005` 后端/契约 | 判断前端缺口是 UI 还是机器合同 | Traceability → OpenAPI/architecture → conflict/gap | Build/Preview 部分 code-backed；Claim review、Workspace actions、Publish/Domain/Inquiry 等合同缺失且有 Owner | 因后端有表/服务就宣称前端可交付 |
| `ROUTE-FE-006` QA/证据 | 设计 Claim 未批准和 Build 取消/晚到结果的验收 | Scenario Catalog → Site operations → Release evidence spec | 区分 `CATALOG_ONLY`、`TEST_ANCHOR`、真实运行与 Release 证据；高风险需独立 reviewer | 把测试文件名或 CI 绿当用户可用 |
| `ROUTE-FE-007` 运营/客服 | 为 Build 失败写用户答复和升级路径 | 状态恢复 → Site operations/FAQ → Owner/blocker | 用户看到诚实状态、旧结果保留、可取消/重试条件、correlation 与人工兜底；实际 SLA/assignee 未定 | 承诺自动恢复或不存在的后台操作 |
| `ROUTE-FE-008` 安全/商业 | 判断 Puck/Readdy/现用八项能否进生产 | OSS Registry → Card/policy → hardening/exit | Gate 7 只批准采用组合；许可、安全、Owner、生产和退出门仍需逐项关闭 | 看到 MIT/INTEGRATE 就批准生产 |
| `ROUTE-FE-009` Release Owner | 为下一次真实用户发布建立证据包 | Release governance → Bundle template → release index | 只有真实用户生效才建 Bundle；能追到规范、实现、证据、Guide、rollback 和 learning | 为文档 Gate/开发预览创建假 Release |

## 4. 作者路径 dry-run 结果

| Route | 路径结果 | 状态 | 作者发现 |
|---|---|---|---|
| `ROUTE-FE-001` | `docs/README` → `status/current`、`product-scope`、program plan | `AUTHOR_ROUTE_DRY_RUN` | 门户需同步 Gate 7/8 状态 |
| `ROUTE-FE-002` | Capability Registry → Site Pack/operations → `BLK-FE-007` | `AUTHOR_ROUTE_DRY_RUN` | 预览/发布边界可被直接回答 |
| `ROUTE-FE-003` | Page catalog → global state → Site wireframe/copy/operations | `AUTHOR_ROUTE_DRY_RUN` | 设计资产仍为书面 source，不能误标定稿 |
| `ROUTE-FE-004` | Site blueprint → integration/OpenAPI mapping → Scenario | `AUTHOR_ROUTE_DRY_RUN` | 正式前端和 allowed actions 继续阻塞 |
| `ROUTE-FE-005` | Traceability → code/OpenAPI anchors → Conflict Registry | `AUTHOR_ROUTE_DRY_RUN` | `CON-FE-012/013` 的旧手写数字/接入文案仍需技术 Owner 另改 |
| `ROUTE-FE-006` | Scenario Catalog → release evidence spec → Site acceptance | `AUTHOR_ROUTE_DRY_RUN` | Fixture 仍 `CATALOG_ONLY`，无独立运行 |
| `ROUTE-FE-007` | global recovery → Site operations → blockers | `AUTHOR_ROUTE_DRY_RUN` | 实际运营 assignee/SLA 缺失 |
| `ROUTE-FE-008` | OSS Registry → policy/cards → runtime hardening | `AUTHOR_ROUTE_DRY_RUN` | 31 项决定与生产准入明确分开 |
| `ROUTE-FE-009` | release governance → template → empty index | `AUTHOR_ROUTE_DRY_RUN` | 当前零真实 Bundle 是正确结果 |

作者 dry-run 触发的 truth-sync 和新入口由 Phase 8 提交修正；它不是独立人工 PASS。

## 5. 独立人工执行记录

| Route | 真实执行人 | 日期 | 用时 | 结果 | Finding / evidence |
|---|---|---|---:|---|---|
| `ROUTE-FE-001..009` | `UNASSIGNED` | — | — | `NOT_RUN` | `BLK-FE-006`；Gate 8 不得隐藏 |

## 6. Finding 分级与回写

- `P0`：路线导致越权、数据/许可风险或把未发布写成已发布，立即阻断 Gate/Release；
- `P1`：找不到唯一真值、状态相互矛盾或关键任务无法完成，当前 Gate 不通过；
- `P2`：超过时限、术语/入口不清或需不必要绕路，登记 Owner 与修复期；
- `P3`：表达优化，不改变事实判断。

修复应回到唯一事实源、Registry 或门户；不得只在本验收记录中解释。复测保留原 finding 和新结果。
