# 独立站管理运营、验收与已知限制

> 文档 ID：`FE-SITE-004`
> 层级：`L2 / Operations and acceptance specification`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_5_REVIEW`
> 内容 Owner：`OWN-PRODUCT`
> 验收责任帽子：`OWN-QA-EVIDENCE`、`OWN-OPS`、`OWN-SECURITY`（实际人员未指派）
> 关联：`SCN-FE-SITE-001..023`、`FX-FE-*`、`MET-SITE-001..034`、`ANTI-FE-001..010`

## 1. 文档用途

本文把页面规格转换成产品评审、设计验证、前端实现、后端合同、QA、运营和发布共同可执行的验收清单。它不是已运行的用户指南：正式前端、Fixture、E2E、部署、运营排班和 Release Bundle 尚不存在。

## 2. 用户/运营运行手册

### 2.1 建立 Site

1. 从 Site 列表进入 Intake，确认 Workspace、企业身份和 Site 名称。
2. 客户端为本次业务意图创建并持久化 `Idempotency-Key`；提交后禁用重复创建，但允许安全确认。
3. 收到确定 accepted 时记录 `siteId/buildId`；收到 `DEMO_LAUNCH_UNAVAILABLE` 时用同键确认。
4. Demo ready 后打开开发预览；`setup_failed` 时保留 Site，按错误类别补资料/重试/升级。

运营不得通过直接建第二个 Site 处理 ACK unknown；只有确认原请求无业务结果并由用户开始新意图时才更换 key。

### 2.2 补资料、素材与知识

1. Profile 按组保存，保留最新 ETag；冲突时比较远端/本地并让用户选择，不覆盖。
2. 素材按 presign → direct PUT → commit → processing → terminal 展示；每一步可独立恢复。
3. `duplicate` 打开已有 Asset；`rejected` 引导换文件；`failed_retryable` 重试处理而非重复上传。
4. `ASSET_IN_USE` 不删除对象；若完整 usage contract 缺，记录 correlation ID 并走受控运营排查。
5. KB aggregate gaps 显示“哪些资料类别不足”，不编造单文档状态/重试动作。
6. Claim/Evidence 未获准、冲突、过期或撤销时，新 Build fail-closed；运营不能口头批准或改数据库绕过。

### 2.3 Build 与恢复

1. 配置只展示服务端支持值：scope `site/page/section`；style 两种；locale `en/de-DE` 且先 `en`。
2. 创建后记录 buildId；遇 active conflict 打开现有任务，不新建并发任务。
3. 任务页显示 Run terminal、每步状态、更新时间、成本来源和旧 preview 是否保留。
4. Cancel 后保持 active/confirming，直到服务端确认 `cancelled`；不允许页面本地先终止。
5. 失败按输入缺口、可重试依赖、预算/配额、合同/完整性、不可恢复分类。重试生成新 Run，不改写失败 Run。
6. candidate failed 或 preview integrity failed 时，旧 active READY 仍是用户默认入口。

### 2.4 开发预览

1. 只从 Site 返回的 active preview 入口进入，不拼 hidden resolver 路径。
2. 管理面和预览均显示 `COPY-FE-SITE-001` 边界；预览保持 noindex。
3. 让用户反馈“可继续/需修改”，但该反馈不等于 Publish authorization。
4. 发现虚构事实、权利问题或严重错误时停止新 Build，记录受影响 Claim/Asset/Release；紧急处置按未来 SOP，不直接删除不可变产物。

## 3. 人工兜底矩阵

| 情况 | 用户自助 | 人工动作 | 禁止动作 | 当前 Owner 状态 |
|---|---|---|---|---|
| Intake ACK unknown | 同键确认 | 查 canonical Site/Build 与 correlation | 换键重复创建 | Ops 未指派 |
| Profile conflict | 刷新/比较/重放 | 协助解释字段来源 | 数据库强覆盖 | Product/Ops 未指派 |
| Asset commit unknown | 确认/重放 commit | 查 Asset/object provenance | 重复 PUT 新 Asset | Ops 未指派 |
| Asset in use | 打开已知引用 | 查 profile/spec/claim refs，提出解除方案 | 强删对象或 bucket 文件 | Site Ops 未指派 |
| KB partial | 补资料 | 定位失败类别/重试内部任务 | 宣称全部知识 ready | Site Ops 未指派 |
| Claim blocked/conflict | 看 Evidence/等待审核 | 按正式 SOP 由授权人决定并留审计 | AI/运营口头批准 | `BLK-FE-004/006` |
| Build active/ACK unknown | 打开当前任务/确认 | 查 workflow + DB terminal | 新建并发 Run/假 cancelled | Site Ops 未指派 |
| quota/unknown cost | 等待/申请明确路径 | 核对 ledger/hard cap | 把 estimate 当 actual、绕过 cap | Commercial/Ops 未指派 |
| Preview integrity fail | 返回旧 active | 核验 manifest/digest/object/component | 返回残缺产物/泄漏 key | Security/Ops 未指派 |
| Publish/domain/inquiry | 不可用说明 | 仅登记需求/事故输入 | 用 preview 或第三方表单临时冒充 | `BLK-FE-007` |

没有实际排班、SLA、访问权限和审计流程时，“联系运营”只是受控阻塞文案，不构成已交付兜底。

## 4. 标准 Fixture Manifest

所有 Fixture 当前只在 Registry 登记，Phase 5 不创建真实文件或 seed。后续生成时必须使用同一版本 manifest：

| Fixture | 内容 | 用途 | 生成门 | 当前状态 |
|---|---|---|---|---|
| `FX-FE-WS-001` | 合成 Workspace + operator/contributor/approver/admin | tenant/permission/denied | allowed-actions contract + 无真实账号 | `CATALOG_ONLY` |
| `FX-FE-COMPANY-001` | 合成精密零部件企业 | Intake/Profile/事实 | 明确虚构，无真实企业冒认 | `CATALOG_ONLY` |
| `FX-FE-OFFERING-001` | 两个产品 + 一个缺字段 | profile/gap/copy | 单位/市场/事实 refs | `CATALOG_ONLY` |
| `FX-FE-ASSET-001` | 自产 logo/工厂/产品/认证占位 | upload/variant/rights/delete | 固定 hash、自产/CC0 权利声明 | `CATALOG_ONLY` |
| `FX-FE-DOC-001` | 自产手册 + 故意冲突字段 | KB partial/Claim conflict | 无第三方版权/PII | `CATALOG_ONLY` |
| `FX-FE-CLAIM-001` | approved/needs_review/conflict/expired/revoked | Evidence/Approval/impact | public contract 或受控 test adapter | `CATALOG_ONLY` |
| `FX-FE-SITE-001` | draft + old active READY + new candidate/failed/ready | build/release/preview | 合成 UUID/slug，无公网域 | `CATALOG_ONLY` |
| `FX-FE-BUILD-001` | queued/running/degraded/failed/cancelled + cost variants | task/recovery/cost | 可重复时钟与响应脚本 | `CATALOG_ONLY` |
| `FX-FE-INQUIRY-001` | consent/spam/duplicate/valid visitor | future receiver/DSR | 隐私/保留/SoR 批准 | `CATALOG_ONLY_BLOCKED` |

Fixture 必须带 `fixture_version`、source/rights、PII classification、seed/reset 方法、expected object IDs、scenario variants 和 last verified commit。截图或手工改数据库不是可重复 Fixture。

## 5. Scenario 验收矩阵

### 5.1 当前纵切

| Scenario | 必须证明的结果 | UI 证据 | 合同/运行证据 | 当前判定 |
|---|---|---|---|---|
| Site 001/002 | 原子 intake、安全幂等与 ACK unknown | 页面状态/Copy/同键恢复 | OpenAPI + service/test；未来 E2E | `SPEC_READY / FE_NONE` |
| Site 003 | 分组保存、ETag 冲突不覆盖 | dirty/save/conflict/compare | profile GET/PATCH + concurrency test | 同上 |
| Site 004..006 | 上传四段、duplicate/reject/retry | task UI/键盘/网络恢复 | presign/PUT/commit/list + storage/workflow | 同上 |
| Site 007 | 引用阻止删除 | impact/409/old object retained | delete/reference/cleanup test | `SPEC_READY_WITH_CONTROLLED_FALLBACK` |
| Site 008 | KB partial 保留 ready | aggregate/gaps/补资料 | KB status + processing tests | `SPEC_READY_WITH_CONTRACT_LIMIT` |
| Site 009/010 | Claim fail-closed、撤销影响可解释 | Evidence/blocked/impact | generic Claim + internal snapshot；Site API 缺 | `BLOCKED` |
| Site 011/012 | scope/target/enum/active/quota 严格 | config/error/existing task | Build create + validation/cap tests | `SPEC_READY / FE_NONE` |
| Site 013 | degraded/skipped/cost source 分开 | step timeline/cost/a11y | Build status + cost summary | `SPEC_READY / FE_NONE` |
| Site 014/015 | 失败保旧 preview、cancel 可信 | old result/cancel confirming | Release pointer + cancel CAS/workflow | `SPEC_READY / FE_NONE` |
| Site 016/017 | active READY、完整性 fail-closed | noindex/boundary/error | resolver + digest/object/component tests | `SPEC_READY / FE_NONE` |
| Site 018 | locale 能力/降级诚实 | selector/degraded/fallback | generator enums + renderer smoke | `SPEC_READY_WITH_LIMIT` |

### 5.2 后置链

`SCN-FE-SITE-019..023` 只作为需求完整性和依赖发现，必须保持 `TARGET_NOT_RUNNABLE`。在 public Release/Publish/Domain/Inquiry/Analytics 合同、infra、隐私和 Owner 关闭前，不得用静态 prototype、第三方表单或手工部署把它们升级为通过。

## 6. 前端验收层级

| 层 | 最低覆盖 | 通过证据 |
|---|---|---|
| Contract | 13 个 operation、DTO/error/enums、ETag、idempotency | 由机器 OpenAPI 生成/校验；contract drift CI |
| Unit | 状态 reducer、error mapping、allowed-action、cost/locale formatter | 正式 repo test report |
| Component | 表单、upload task、step timeline、blocked/degraded/ACK states | 受控设计映射 + interaction/a11y tests |
| Integration | auth/workspace、polling/reconnect、presign PUT、cancel/conflict | deterministic fixture adapter；不 mock 成全成功 |
| E2E | Site 001..018 的适用变体，至少 Chrome + 键盘路径 | 部署环境、commit、fixture version、结果 |
| Accessibility | axe 类自动检查 + keyboard + screen reader + zoom/reflow | QA 与设计实际 reviewer 签发 |
| Visual/responsive | desktop/narrow/mobile 关键状态 | 受控 source/version + baseline diff review |
| Performance | management page budgets + preview public budgets | lab + field/production evidence 分开 |
| Security/privacy | tenant isolation、anti-disclosure、XSS/URL/upload、PII/logging | Security reviewer + finding disposition |
| Operations | incident/recovery/old result/diagnostic ID | Ops drill、SLA/assignee、runbook evidence |

本阶段只有规格和后端证据核验，没有正式 frontend test、E2E 或部署证据。

## 7. 指标与事件

### 7.1 当前指标方向

- 漏斗/价值：`MET-SITE-001..005/007/008`；重点是可信预览和继续行为，不是页面数。
- 可靠性：`MET-SITE-006/009/010/014`；区分处理可用、自助恢复、取消可信和 locale 降级。
- 事实/质量：`MET-SITE-011/012`；必须来自 Claim snapshot/review，不用前端字段数替代。
- 经济性：`MET-SITE-013`；reported/calculated/estimated/unknown 分层。
- 发布/域名：`MET-SITE-020..025`；只有 `BLK-FE-007` 关闭后激活。
- 询盘：`MET-SITE-030..034`；只有 receiver/validity/Conversation ACK/隐私合同后激活。

### 7.2 逻辑事件假设

`EVT-FE-001..013` 覆盖 intake accepted、preview ready/opened、profile saved、asset start/commit/terminal、claim reviewed、build start/terminal/cancel、recovery、preview accepted。它们是逻辑 schema hypothesis，不是已建 tracking：

- server outcome 优先；client 只记录意图/视图并去重；
- payload 只含 opaque object/event IDs、approved enum、timestamp/context version，不含 profile/contact/document/prompt 原文；
- baseline、denominator、bot/internal traffic、retention、consent、region、Owner 未批准前不接 SDK；
- `BLK-FE-005` 未关闭时 Gate 只检查“可测性和不误测”，不检查目标值。

### 7.3 反指标

发布评审必须同时检查 `ANTI-FE-001..010`：页面数、Build succeeded、Demo 更快、字段完成率、AI/Token 次数、发布站数量、Lead 数、通知数、停留时间、运营解决率都不能单独当成功。

## 8. Gate 5 验收与 Release readiness

| 检查 | Phase 5 结果 | 后续关闭条件 |
|---|---|---|
| 模块范围/旅程/Page 完整 | `PASS_FOR_SPEC_REVIEW` | Product Gate 5 批准 |
| 当前/目标/as-built/Mock 分开 | `PASS` | 持续 drift check |
| 合同、状态、错误和恢复可追踪 | `PASS_FOR_SPEC_REVIEW` | 正式 client + contract CI |
| 权限可实现 | `BLOCKED` | `BLK-FE-003` |
| Claim 自助闭环 | `BLOCKED` | `BLK-FE-004` |
| 视觉/组件/a11y 已设计 | `BLOCKED` | `BLK-FE-002` + 真实评审 |
| Fixture/E2E/运营演练 | `NOT_CREATED/BLOCKED` | `BLK-FE-001/006` |
| 指标可验收 | `SCHEMA_HYPOTHESIS_ONLY` | `BLK-FE-005` |
| Publish/Domain/Inquiry/Analytics | `TARGET_NOT_RUNNABLE` | `BLK-FE-007` |
| 实现/部署/用户可用 | `NONE` | 正式 repo、代码、CI、部署、Release Bundle |

## 9. 已知限制与 FAQ

**为什么不能把整个独立站模块叫 Dev-Ready？**  因为当前纵切仍缺正式前端 repo、服务端 allowed actions、Site Claim 自助闭环、设计源和实际 QA/Ops；发布链还缺完整对象/合同/infra。

**已有通用 Claim API，为什么页面仍 blocked？**  通用批准动作不等于 Site 中“该事实影响什么、当前用户是否获准、撤销后如何处理”的闭环。前端不能自行拼出业务授权。

**Build 成功后为什么不显示“已上线”？**  Build terminal、Release ready、Preview active 和 Public live 是四层状态；当前只到开发预览。

**可以先接一个第三方表单收询盘吗？**  不可以把临时表单冒充产品能力。它仍需要 consent、anti-abuse、数据保留、DSR、投递 ACK、SaaS SoR 和事故责任。

**可以用 renderer 的颜色和组件当 SaaS 设计系统吗？**  不可以。它们属于公开输出的当前实现，正式 SaaS 设计源、Token 和组件库由 `BLK-FE-002` 控制。

**哪些材料能让状态升级？**  受控设计源和 reviewer、正式 repo commit/CI、真实合同、可重复 Fixture/E2E、部署和 Release Bundle；Markdown、Mock、截图和 AI 自评都不够。
