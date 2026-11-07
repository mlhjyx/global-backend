# AI 底座（Skill Runtime）· 模块技术方案

> 文档 ID：`DOC-MODULE-AI-FOUNDATION-TECH-001`
> 生命周期：`DRAFT`
> 生命周期依据：S0 已按批准设计落地（`docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`，产品负责人 2026-11-08 批准 D-a~D-h）；S1 Pack v1 尚未开始。
> 模块产品说明：[product.md](product.md)

## 1. 变更历史

| 日期 | 变更 | 来源 |
| --- | --- | --- |
| 2026-11-08 | S0：SKILL.md 规范 v0 + validator、四张技能表（RLS/快照不可变）、三个存量技能包化、DB resolver、ops 启停 API | 同一任务的三个 stacked PR（首 PR #833） |
| 2026-11-08 | S1-1：四类 Pack Schema + 7 个内容包 + 冲突裁决 + Golden Set 骨架；S1-2：Pack 七表（RLS/append-only）+ 策略解析与快照 + skill-kind（model_task/service）+ 启动期 pack seed；S0 已发车（镜像 1982a551） | PR #847 / #856 |
| 2026-11-08 | S1-3：Pack Studio ops API（草稿/校验/试跑/评测/发布/激活/灰度/回滚）+ 确定性评测回执与发布门；`pack_version` 对 app_user 开放 INSERT（发布），UPDATE/DELETE 仍禁止 | 本 PR |

## 2. 技术概览

- 归属：引擎 `/global/backend`（NestJS + Prisma + PostgreSQL）。不引入第二套编排；技能经既有结构化任务桥执行。
- 分层：`SKILL.md`（包规范，AAIF / agentskills.io 兼容）→ 生成目录 `generated/builtin-skill-catalog.ts` → 注册表（`skill_package`/`skill_version`/`skill_enablement`）→ resolver（静态/DB）→ 直通 adapter → `executeStructuredTaskWithRuntime`。
- 红线：prompt/schema/模型/预算/执行收据与包装前逐字节一致（零行为变化）；技能只能绑定既有 AI task 契约，`allowedTools` 与契约严格相等（ToolBroker 代码强制不变）。

## 3. 包规范（SKILL.md v0）

- 目录：`apps/api/src/skills/builtin/<pack_type>/<skill-name>/SKILL.md`；标准字段 `name`/`description`/`license`/`compatibility`/`metadata`/`allowed-tools`。
- 平台扩展在 `metadata.platform.*`：`skill-key`、`version`（MAJOR.MINOR.PATCH）、`pack-type`（八类）、`task-contract`、`task-contract-digest`（另可带 `risk`/`human-gate`/`budget-cents`/`owner`，如填写必须与契约一致）。
- `task-contract-digest` = 契约行为字段的规范化 sha256（id/description/allowedTools/maxCostCents/maxOutputTokens/timeoutMs/retry/concurrency/toolVersion/risk/humanGate/acceptsModelSubstitute/outputSchema）；**不含 model**（模型属部署策略，快照记录 `effectiveModel`）。
- 解析器是严格子集（块状映射 + 标量 + 一级 metadata；拒绝锚点/块标量/流式集合），只用于 dev/CI 生成；运行时不做 YAML 解析。
- 工具链：`pnpm skills:generate`（写生成目录）/ `pnpm skills:validate`（--print-digests 可输出当前契约摘要）。

## 4. 数据模型（迁移 `20261108010000_skill_runtime_v0`）

| 表 | 作用 | RLS / 授权 |
| --- | --- | --- |
| `skill_package` | 平台技能目录（skill_key/scope/pack_type/status） | FORCE RLS：平台行（workspace_id NULL）跨空间可读；app_user 仅 SELECT + 状态列 UPDATE（kill switch） |
| `skill_version` | 版本（manifest/正文/摘要/契约绑定），append-only | FORCE RLS；app_user 仅 SELECT |
| `skill_enablement` | workspace 覆盖（enabled/reason/updated_by） | FORCE RLS；app_user CRUD（仅本空间行） |
| `skill_resolution_snapshot` | 不可变解析快照（descriptor 内容寻址），append-only | FORCE RLS；app_user SELECT + INSERT，禁止 UPDATE/DELETE |

seed（owner 连接，worker + relay 启动期）：package upsert 不覆盖 ops 状态；同 (package, version) 内容漂移大声失败（要求 SKILL.md 版本号 +1）。

## 5. 运行时

- `StaticSkillResolver`：编译进二进制的内置目录（测试/未接线缺省；不读 DB）。
- `createDbSkillResolver`：平台状态 → 最新版本 → workspace 覆盖 → 本构建绑定校验（digest 一致）→ 写快照（`ON CONFLICT DO NOTHING`）；错误码 `SKILL_NOT_REGISTERED`/`SKILL_PLATFORM_DISABLED`/`SKILL_WORKSPACE_DISABLED`/`SKILL_VERSION_MISSING`/`SKILL_BINDING_UNAVAILABLE`/`SKILL_CONTRACT_DRIFT`（fail-closed）；结果缓存 30s（worker 内的生效时延）。
- `executeSkillWithRuntime`：解析 + 绑定校验后原样调用既有桥；`SKILL_BINDING_MISMATCH` 拒绝执行。
- 已包化调用点：`company.understanding.extract`（claims）、`company.understanding.extract_offerings`、`discovery.qualify_fit`（fit-judge 全路径）。
- 停用/漂移的传播：understanding 转 Temporal nonRetryable；fit 判定整轮显性失败（不静默 0 判）。

## 6. ops API（S0）

`GET /api/v1/skills`、`GET /api/v1/skills/:skillKey`、`PATCH /api/v1/skills/:skillKey/status`、`GET|PUT|DELETE /api/v1/skills/:skillKey/workspaces/:workspaceId`。仅 `ops:read`/`ops:write`；租户 token 403。启停对执行侧最迟 30s 生效。

## 7. 测试

- 零容器：frontmatter/manifest 负向 30 例；resolver 失败码与缓存；adapter 逐字段转发；迁移静态契约（表/RLS/授权/清单）；调用点行为（skill key、nonRetryable、fit 显性上抛）；worker 接线源级守卫。
- 真库：`packages/db/test/skill-runtime.rls.spec.mjs`（service 组，一次性库）——平台目录跨空间可读、enablement/快照 RLS 隔离、版本/快照 append-only、目录列级 UPDATE。
- 治理：`app-user-table-privileges.postgres.spec.ts`（全表 ACL 对账）与 `raw-sql-parameter-types.postgres.spec.ts` 通过。

## 8. S1 Pack v1（进行中）

- **Pack 目录**：`pack_package` / `pack_draft`（可变草稿）/ `pack_version`（append-only）/ `pack_activation`（激活日志，platform 默认 + workspace 白名单灰度）/ `pack_enablement` / `eval_receipt` / `strategy_resolution_snapshot`（策略快照，内容寻址）。启动期 owner seed 7 个内置内容包（版本漂移大声失败；只为缺省包补平台激活）。
- **策略解析**：`createDbStrategyResolver` 按选择器（industries/markets/motions；合规与数据源边界为通用包）选包，复用 S1-1 的确定性冲突裁决，渲染 ≤2000 字策略简报并写策略快照；DB 版本与构建目录摘要不一致 → `PACK_VERSION_DRIFT` fail-closed；30s 缓存。
- **skill-kind**：`platform.skill-kind`（model_task | service）与 `platform.tenant-default`；service 技能绑定闭集 handler（sanctions/quoting，实现随 S1-4），不绑定 task contract、不声明工具；`tenant-default: disabled` 的技能需显式 workspace 启用（`SKILL_TENANT_NOT_ENABLED`）。
- **Pack Studio（S1-3）**：`/packs` ops API——草稿可编辑（`pack_draft`），validate（schema/语义/单包冲突模拟）→ dry-run（按选择器解析并给出与当前版本的简报差异）→ eval（运行 `evals/evals.json` 的确定性用例，写不可变 `eval_receipt`）→ publish（要求当前摘要已校验且存在匹配、30 天内、通过的回执）→ activate（platform 默认或 workspace 白名单灰度；回滚=激活旧版本）；workspace 启停覆盖与 `/skills` 同构。发布的新版本不参与内置目录摘要比对（不可变版本行 + 发布门自证），内置目录只钉住 seed 的同版本行。
- **尚未接线**：策略简报的消费方是 S1-4 的新技能；S0 三个存量技能输入不变。

## 9. 状态与缺口

- 已实现：S0 全部内容（见上）；部署尚未发车（运行镜像以 `local-config/global/runtime.compose.env` 为准）。
- 缺口（后续）：S1-4 两个新技能与导入 A 档（Pack 表/解析器/快照/skill-kind 在 S1-2、Studio/回执/发布门在 S1-3 落地）；`seller_document.extract_facts` 尚不存在（Phase 3），S0 以 extract_offerings 替代（设计 D-b）；租户自定义技能/zip/Git 安装（S3）；跨 run 的 run 级快照维度（S1 接入 workflow 时扩展）。
- 回退：镜像回滚即回到无技能层（表残留无害）；ops 可将任一技能平台级 DISABLED。
