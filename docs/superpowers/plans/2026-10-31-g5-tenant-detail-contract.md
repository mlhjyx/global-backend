# G5 决策方案：租户侧线索/公司详情与禁联名单口径

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-31 拍板按推荐组合执行（D1-A：LeadPackage 即租户详情合同；D2-B：租户 admin 可管理本 workspace 禁联名单，PRD 口径例外成立）。

事实基线：`origin/main@1ce1b7ba`，xin 运行镜像 `348fa0cb`（2026-10-30 切换），2026-10-30T19:45Z 只读核对代码、运行 env 与 gain-saas BFF。代码位置相对 `apps/api/src/`。

## 1. 问题是什么

GainOS 租户（`saas-admin` / `saas-member`）的 token 不含 `personal-data:read`（运行时 `AUTH_ROLE_SCOPE_MAP_JSON`；仅服务身份 `saas-event-consumer` 持有）。因此以下四个租户可达的 BFF 路由全部被引擎挡下（403 `SCOPE_REQUIRED`，经 BFF 表现为 502）：

| 端点 | 引擎要求 | 租户现状 |
| --- | --- | --- |
| `GET /leads/:leadId`（六维分+规则依据+公司/联系人+裁决历史） | `acquisition:read` + `personal-data:read`（`lead/lead.controller.ts:340`） | 502 |
| `GET /canonical-companies/:id`（canonical 视图+联系人+字段级 Evidence） | `acquisition:read` + `personal-data:read`（`discovery/discovery.controller.ts:353`） | 502 |
| `GET /suppressions`（禁联名单） | `compliance:manage` + `personal-data:read`（`discovery/discovery.controller.ts:519`） | 502 |
| `POST /suppressions`（加入禁联） | 仅 `compliance:manage`（`discovery/discovery.controller.ts:505`） | **可用** |

## 2. 关键事实

1. **PRD 已有一条口径**：`gain-saas/docs/prd/phase-1-01-04.md` 写「个人数据相关 scope（`personal-data:read`）一期不授予任何 SaaS 角色；个人联系方式一律不在界面出现（引擎侧公司级联系路径是唯一可达性口径）」。
2. **租户已经有一个安全的详情读模型**：`GET /leads/:leadId/package` 只要求 `acquisition:read`（`lead/lead.controller.ts:349`），返回六维分、fit 理由、公司事实、注册地址、identifiers、**公司级** `contact_points`（仅 https URL，`lead/lead-package.ts:245-250`）、`suggested_contact_path`（含 `legal_note`）、signals、evidence、sanctions、`valid_until`；明确"不含具名联系人"。GainOS 的档案包导出与运营查看已用它。
3. **GainOS 界面未依赖** `GET /leads/:leadId`、`GET /canonical-companies/:id`（验收文档 §18/§G5 结论相同；前端仅用列表、package、草稿）。
4. **禁联是 workspace 隔离的**（`suppressionRecord.workspaceId`，`discovery/discovery.service.ts:1007-1057`），不会跨租户影响；但租户 admin 目前"能写不能读"：可以 `POST`，却列不出、也拿不到 id 去 `DELETE` 或查 decisions——**盲写黑洞**。
5. `GET /suppressions/:id/decisions` 只要求 `compliance:manage`（`discovery/discovery.controller.ts:559`），与列表的额外门槛不一致。

## 3. 决定点 D1：租户的线索/公司详情

| 选项 | 内容 | 成本 | 风险 |
| --- | --- | --- | --- |
| **A（推荐）** | 确认 PRD 口径：**LeadPackage 即租户详情合同**；`GET /leads/:leadId`、`GET /canonical-companies/:id` 保持服务身份专属；gain-saas BFF 移除这两条租户路由 | 文档 + BFF 删 2 行 | 无；能力不损失（租户要的那几组事实 package 都有） |
| B | 新建裁剪版公司详情端点（`acquisition:read`，不含联系人），供未来 UI 用 | 1 个端点 + 契约 + 测试 | 暂无需求驱动，先建即负债 |
| C | 给 `saas-admin` 授予 `personal-data:read` | 改 role map + 界面脱敏 + LIA/DPA 重做 | 与 PRD 红线冲突，不建议 |

说明：被挡端点相对 package 只多三样东西——规则逐条依据/裁决历史（租户不需要）、具名联系人（红线上明确不给）、字段级 Evidence 全量（package 已有截断版）。若未来租户确实需要更多分数解释，扩展 `package.scores`/`fit.reasons` 字段即可，**不开放个人数据端点**。

## 4. 决定点 D2：禁联名单口径

租户必须能处理数据主体的反对（objection/erasure 请求），所以禁联能力本身要保留；争议只在"租户能不能看见自己 workspace 的禁联名单值（email/domain）"。

| 选项 | 内容 | 成本 | 风险 |
| --- | --- | --- | --- |
| A | 维持现状（列表要 `personal-data:read`）：租户可写不可管；建议同时把 BFF 的 suppressions 路由整体撤下，避免盲写 | 文档 + BFF 删 2 行 | 租户无法响应数据主体请求，合规缺口 |
| **B（推荐）** | `GET /suppressions` 去掉 `personal-data:read`，只留 `compliance:manage`：租户 admin 能列出/删除/查 decisions **仅限自己 workspace**（RLS 已隔离）。展示的是租户自己提交的合规记录，不是引擎采集的招揽联系人 | 后端 1 行 scope + 描述 + authz 测试；BFF 无需改动 | 需要产品负责人明确：这条对 PRD「个人联系方式不出现界面」构成**有意的例外**（仅 admin、仅本 workspace、仅禁联记录） |
| C | 只给计数/掩码摘要（`a***@…`） | 新端点 + 投影 | 管理体验差，仍要 B 的 decisions 权限 |

若选 B，`personal-data:read` 仍然不授予任何 SaaS 角色——敏感数据面（联系人、事件流）继续只对服务身份开放，红线不变。

## 5. 若按推荐（D1-A + D2-B）落地

**backend（本仓）**
1. `discovery.controller.ts`：`GET /suppressions` 的 `@RequireScopes('compliance:manage', 'personal-data:read')` 改为 `@RequireScopes('compliance:manage')`；同步 `@ApiOperation` 描述与 `authz-openapi.spec.ts` 断言。
2. 重新导出 OpenAPI（`node apps/api/dist/main.js --export-openapi`），跑 `contracts · drift · lint · breaking`。
3. 单测：admin 可列、member 403、跨 workspace 不可见（RLS 用例已覆盖，补一条列表断言）。

**gain-saas（对端会话执行）**
4. `bff/routes.ts`：移除 `GET leads/:leadId`、`GET canonical-companies/:id` 两条路由（前端未用）；`suppressions` 路由保留（admin）。
5. 验收文档 G5 改「按本方案关闭」；PRD §2 补一句「LeadPackage 是租户详情合同；禁联名单仅 admin 可见（本 workspace）」。

**验收**
- 租户 admin：`GET /suppressions` 200 且只含本 workspace；`GET /leads/:id/package` 200；BFF 不再暴露 `leads/:id`。
- 租户 member：`GET /suppressions` 403；package 200。
- 服务身份：`personal-data:read` 面（`/events`、联系人发现）不受影响。

## 6. 后续触发条件（不在本期）

- **D6（per-tenant LIA 采集页）落地后**再评估「租户可见具名联系人」：届时需要**新 scope**（如 `personal-data:tenant`）+ 每租户 LIA 校验，不复用 `personal-data:read`。
- M1/M2a（联系挖掘）上线后，若租户外呼场景需要联系人，按上一条走，不推翻本方案。

## 7. 回退

无破坏性改动：D2-B 只是放宽一个守卫，回退即恢复 `personal-data:read` 要求；D1-A 的 BFF 路由删除可随时加回。数据库无迁移。
