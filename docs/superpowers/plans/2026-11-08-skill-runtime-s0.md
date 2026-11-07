# M1 步 7 · S0 Skill Runtime v0 落地设计文档（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-11-08 批准 D-a~D-h 按推荐值（「批准，按推荐」）；依据协调计划 `/home/xin/.claude/plans/majestic-floating-robin.md` §0.2 步 7 与 §17.8「S0」、按 §0.6 任务启动门（设计文档 / 闭环设计 / 联网研究）产出。
> 任务启动门（计划 §0.6）：① 设计文档（本文）② 闭环设计（§6）③ 联网研究（§13）→ 产品负责人过目批准 → TDD。

## 1. 背景与目标

### 1.1 现状（已核对代码，2026-11-08，main `6dd1b592`）

- 领域 AI 任务全部硬编码在 `apps/api/src/ai-tasks/task-registry.ts`（`AI_TASKS`，13 个契约），每个契约声明 `description`（同时作为抽取任务的 system prompt）、`outputSchema`、`model`、`allowedTools`、`maxCostCents`、`maxOutputTokens`、`timeoutMs`、`risk`、`humanGate`（见 `task-contract.ts:9`）。
- 结构化模型调用统一经 `apps/api/src/model-runtime/structured-task-runtime-bridge.ts:72` 的 `executeStructuredTaskWithRuntime`（prompt/schema/模型/预算键/durable receipt 都在此处按输入计算）。
- 三个计划要包化的「存量技能」与实际代码核对：
  | 计划名称 | 代码现状 |
  | --- | --- |
  | `understanding.extract` | ✅ `company_understanding.extract_claims`（`understanding.activities.ts:346`） |
  | `qualify_fit` | ✅ `discovery.qualify_fit`（`fit-judge.ts:164`） |
  | `extract_facts` | ❌ **不存在**。`seller_document.extract_facts` 只在设计/文档里出现（`docs/modules/seller-knowledge/technical.md` §6 为前瞻设计；`docs/status/implementation-matrix.md` 与 changelog 均记为 Phase 3 缺口），代码与历史提交都没有实现。→ 决策点 **D-b** |
- 没有任何技能注册、版本、启停或解析快照；「可调用行业技能」目前只是一份 task 注册表。

### 1.2 目标（S0 验收口径，计划 §0.2 步 7 / §17.8）

1. **SKILL.md 包规范 v0 + validator**（AAIF / agentskills.io 兼容，平台扩展字段不破坏标准）。
2. **注册表**：`skill_package` / `skill_version` / `skill_enablement` 三表（RLS）+ 迁移 + `app_user` 权限清单；另加**解析快照表**承载「快照不可变」（§5.3，决策点 D-d）。
3. **3 个存量技能包化**：`company.understanding.extract`、`company.understanding.extract_offerings`（替代缺失的 extract_facts，见 D-b）、`discovery.qualify_fit`；执行经 **adapter 直通**，prompt/schema/model/预算/执行收据/`ai_trace` 逐字段不变。
4. **resolver + snapshot v0**：静态映射解析（无 Pack、无 Company 维度）+ 不可变解析快照。
5. **ops 启停**：平台级 kill switch + workspace 级覆盖；引擎 ops API（`ops:read`/`ops:write`）。
6. **DoD**：零行为变化；未登记技能不可用；快照不可变；负向测试（越权/跨租户/未登记/已停用）。

### 1.3 非目标（明确不做，防扩面）

- 不做 S1 的 Pack Schema、Pack Studio、Golden Set CI、新技能（`compliance.sanctions_screen`、`quoting.incoterms_quote`）。
- 不做 zip / Git 仓库安装、租户自定义技能、技能市场（S3）。
- 不做 MCP 适配、技能互操作（A2A）、技能脚本执行（S0 明确**不执行** `scripts/`，只有 manifest 与说明文本）。
- 不改任何现有 task 契约的行为字段、预算、模型路由、执行收据、outbox 事件。
- 不改 gain-saas（ops 页面后续批次）；S0 只交付引擎 ops API。
- 不引入新依赖、不动 `pnpm-lock.yaml`（锁文件由另一会话独占；见决策点 D-c）。

## 2. 承重假设（可证伪）

1. **A1：包装不改变执行语义。** 三个 callsite 包一层 resolver 后，传入 `executeStructuredTaskWithRuntime` 的 `GenerateStructuredInput` 与 `AiContext` 逐字段相同，则执行结果（模型路由、预算键、durable receipt、`ai_trace`/`usage_ledger`）逐字节不变。证伪方式：adapter 单测深比较转发参数 + 既有 `understanding.activities.spec.ts` / `fit-judge.spec.ts` 不改仍绿 + 上线后同输入材料 `ai_trace` 的 prompt/schema/model digest 对照。
2. **A2：DB 解析 ≡ 静态目录（seed 完整时）。** 种子把 on-disk SKILL.md 写入 DB；解析器把 DB 行还原成与静态目录相同的 descriptor。证伪方式：`static resolver ≡ db resolver` 的 postgres 对照用例 + worker 接线源级测试。
3. **A3：技能版本钉住的执行语义 = 契约行为字段摘要（不含 model 字符串）。** 摘要覆盖 `id/description/allowedTools/maxCostCents/maxOutputTokens/timeoutMs/retry/concurrency/toolVersion/risk/humanGate/acceptsModelSubstitute/outputSchema`；`model` 属**部署策略**（`MODEL_ACQUISITION_*` env 可换），由快照记录实际生效值。若证伪（模型也必须纳入版本身份）→ 每次 env 变更都会新增技能版本，运维不可接受；备选是把 model 纳入 digest 并在换模型时显式登记新版本。
4. **A4：快照粒度 v0 = 每 (workspace × skill × descriptor-digest) 一行。** PRD 的「每次任务/运行生成 `ResolvedStrategySnapshot`」在 S1 接入 workflow 级解析时增加 run 维度；v0 的行是不可变的内容寻址记录，足以回答「某 workspace 何时起用哪个技能版本/契约摘要/生效模型」。若审计要求逐 run → S1 加 `run_id` 维度，不改 v0 语义。
5. **A5：不引新依赖可实现 SKILL.md 解析。** v0 用仓库自带的**严格子集** frontmatter 解析器（只接受块状映射 + 标量 + 一级 `metadata` 映射；拒绝锚点/别名/多行折叠等复杂 YAML），仅用于 dev/CI 生成产物；运行时不解析 YAML（见 §5.4）。锁文件会话释放后可替换为 `yaml` 包，行为兼容。
6. **A6：执行权威合同不因包装而漂移。** `docs/governance/durable-result-strategies.json` 的 `modelTasks` 以 `taskId + callsitePath` 声明，`execution-authority-policy.mjs` 要求 callsite 文件仍包含 taskId 字符串；包装后 callsite 仍保留 `getTask('<taskId>')` 构造输入，taskId 字符串不消失。受保护文件（`tool-broker.ts`、`router-model-gateway.ts`、`tool-broker.factory.ts`、`model-gateway.module.ts`）不碰。

## 3. 触点清单（已核对）

| 位置 | 现状 | 改动 | 风险 |
| --- | --- | --- | --- |
| `apps/api/src/skills/**`（新目录） | 无 | manifest 类型/validator、严格 frontmatter 解析器、builtin 目录生成器、静态/DB resolver、adapter、seed、ops service/controller/module | 新代码，隔离 |
| `apps/api/src/skills/builtin/<pack_type>/<skill-name>/SKILL.md`（新） | 无 | 3 个 SKILL.md（标准字段 + `metadata.platform.*` 扩展） | 内容由代码契约生成核对 |
| `apps/api/src/skills/generated/builtin-skill-catalog.ts`（新，生成物） | 无 | 由 `scripts/generate-skill-catalog.mts` 生成并入库；CI 校验新鲜度 | 生成物漂移由 spec 拦截 |
| `scripts/validate-skills.mts` / `scripts/generate-skill-catalog.mts`（新） | 无 | `skills:validate` / `skills:generate` 脚本（tsx，无新依赖） | 仅 dev/CI |
| `packages/db/prisma/migrations/20261108xxxxxx_skill_runtime_v0/migration.sql`（新） | 无 | 4 张表（3 注册表 + 1 快照）、RLS、列级授权/append-only 硬化 | additive |
| `apps/api/src/temporal/understanding.activities.ts` | `extractClaims`(`:346`)、`extractOfferings`(`:427`) 直接调 bridge | 改为经 `executeSkillWithRuntime`（新增可选 `deps.skills`，缺省为静态 resolver） | 采获线热路径，需逐字段等价测试 |
| `apps/api/src/discovery/fit-judge.ts` | `judgeFitCompany`(`:164`) 直接调 bridge | 同上；catch 中把 `SkillUnavailableError` 与预算错误同待遇**显性上抛**（避免静默 null 判） | 判定语义不变（默认路径） |
| `apps/api/src/temporal/discovery.activities.ts:1792`、`discovery.run2.activities.ts:246`、`discovery.run2.pipeline.activities.ts:419` | 调用 `judgeFitCompany` | 透传 `skills: deps.skills` | 机械 |
| `apps/api/src/temporal/worker.ts:560-645`、`dev-fast-lane-worker.ts:277` | 活动工厂装配 | 构造 `createDbSkillResolver({ prisma })` 并传给 5 个活动工厂（understanding/discovery/run2/run2-pipeline/backlog）；两文件保持同名变量与同参文本（既有源级测试守护） | 接线遗漏由源级 spec 拦截 |
| `apps/api/src/app.module.ts` | 无 skills 控制器 | 注册 `SkillsModule`（ops 端点） | 低 |
| `docs/governance/app-user-table-privileges.json` | 无技能表 | 新增 4 表授权（package: 表级 `SELECT` + `columns` 映射里的列级 `UPDATE(status,status_reason,status_updated_at,status_updated_by,updated_at)`；version: `SELECT`；enablement: `SELECT,INSERT,UPDATE,DELETE`；snapshot: `SELECT,INSERT`）。列级权限按该文件既有语义只登记在 `columns`，不重复出现在表级 | 治理门 + 真库 ACL 对账 |
| `docs/governance/durable-result-strategies.json`、`execution-authority-callsites.json` | 已有 3 个模型任务条目 | **不改**（taskId、callsitePath、锚点均保持） | — |
| `apps/api/src/tools/tool-broker.ts`、`model-gateway/router-model-gateway.ts`、`tool-broker.factory.ts`、`model-gateway.module.ts` | 受保护指纹文件 | **不碰** | — |
| `apps/api/src/model-runtime/structured-task-runtime-bridge.ts`、`apps/api/src/ai-tasks/task-registry.ts` 的现有契约字段 | 现行执行语义 | **不改**（registry 只允许增补导出辅助函数，不动既有契约） | — |
| `pnpm-lock.yaml` / `package.json` 依赖 | 锁文件他会话独占 | **不动依赖**；只在 root `package.json` 增 `skills:validate`/`skills:generate` 两个 script（不涉及锁文件） | — |
| `docs/modules/**`、`docs/status/current.md`、changelog 片段 | — | 施工 PR 内更新（AI 底座暂无模块文档，S0 建 `docs/modules/ai-foundation/technical.md` 最小版） | — |

## 4. SKILL.md 规范 v0（标准兼容 + 平台扩展）

### 4.1 目录与文件

```
apps/api/src/skills/builtin/<pack_type>/<skill-name>/
├── SKILL.md            # 必需：YAML frontmatter + Markdown 正文
├── references/         # 可选（v0 不加载，只随包存放）
└── evals/              # 可选（v0 不执行，S1 的 Golden Set 消费）
```

`<skill-name>` 必须等于 frontmatter `name`（标准要求）。`pack_type` 取八类之一（Industry / Market / Growth Motion / Channel / Data Source / Content / Compliance / Expert Playbook）；S0 三个技能暂归 `growth_motion`。

### 4.2 标准字段（AAIF / agentskills.io 原样）

| 字段 | 要求 |
| --- | --- |
| `name` | 必填；1–64 字符；`^[a-z0-9]+(-[a-z0-9]+)*$`；与目录名一致 |
| `description` | 必填；1–1024 字符；说明「做什么 + 何时用」 |
| `license` | v0 平台策略要求必填（`Proprietary` 或 SPDX 名） |
| `compatibility` | 可选；≤500 字符 |
| `metadata` | 可选；string→string 映射（平台扩展全部放这里） |
| `allowed-tools` | 可选；空格分隔的工具 id；**v0 要求与所绑定 task 契约的 `allowedTools` 集合严格相等** |

### 4.3 平台扩展（`metadata.platform.*`，全部为字符串）

| 键 | 必填 | 含义 / 校验 |
| --- | --- | --- |
| `platform.skill-key` | 是 | 平台技能键（点分，如 `company.understanding.extract`） |
| `platform.version` | 是 | 语义化版本 `^\d+\.\d+\.\d+$`（S0 不接受预发布） |
| `platform.pack-type` | 是 | 八类之一 |
| `platform.task-contract` | 是 | 绑定的 `AI_TASKS` id；必须存在 |
| `platform.task-contract-digest` | 是 | 契约行为摘要（§5.2）；必须等于运行时重算值 |
| `platform.risk` / `platform.human-gate` / `platform.budget-cents` | 否 | 人读冗余；如填写必须等于契约值（`risk`、`humanGate`、`maxCostCents`） |
| `platform.owner` | 否 | 归属团队（人读） |

### 4.4 示例（`company.understanding.extract`）

```markdown
---
name: company-understanding-extract
description: 从企业官网/文档文本抽取带类型与置信度的企业事实（Claim）。只抽文本中明确存在的信息；发现营销性/绝对化表述时输出 forbidden_expression_candidate。
license: Proprietary
allowed-tools: crawl4ai.fetch
metadata:
  platform.skill-key: company.understanding.extract
  platform.version: 1.0.0
  platform.pack-type: growth_motion
  platform.task-contract: company_understanding.extract_claims
  platform.task-contract-digest: <sha256>
  platform.risk: medium
  platform.human-gate: "true"
  platform.budget-cents: "20"
  platform.owner: OWN-BUYER-BE
---

# 公司事实抽取

输入：官网/资料库页面文本。输出：Claim 数组（type/statement/evidence/confidence）。
边界：只依据给定文本；不得编造；证据片段必须逐字来自输入。
```

正文（body）不进入运行时执行路径；平台保存其文本与摘要（`body_markdown` + `body_digest`）供 ops 查看与审计。**S0 不执行 `scripts/`。**

### 4.5 Validator 规则（`scripts/validate-skills.mts` 与单测共用）

1. 标准字段约束（§4.2）；未知顶层字段 → 警告（保持生态兼容）。
2. `metadata` 必须为 string→string；未知 `platform.*` 键 → 警告；缺必填 → 错误。
3. `platform.task-contract` 必须在 `AI_TASKS` 中；重算 `taskContractDigest` 必须匹配。
4. `allowed-tools` 与契约 `allowedTools` 集合相等。
5. `pack_type` ∈ 八类；目录 `<pack_type>/<name>` 与 manifest 一致。
6. 正文字数 ≤ 500 行（沿用标准建议）；引用文件存在且不越出技能目录（路径穿越检查）。
7. 同一 `platform.skill-key` 在目录内全局唯一。
8. **负向用例**：大写 name、`--`、缺 description、超长 license、非法版本、未知 task、digest 不符、allowed-tools 多/少一项、路径穿越引用、非字符串 metadata 值、重复 skill-key。

## 5. 设计

### 5.1 注册表数据模型（4 张表）

```sql
-- 平台目录（S3 前 workspace 行不落库，仅预留列与策略）
skill_package(
  id uuid pk, skill_key text not null,
  scope text not null default 'platform' check (scope in ('platform','workspace')),
  workspace_id uuid,              -- platform 行 NULL；workspace 行必填
  pack_type text not null, display_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  status_reason varchar(500), status_updated_at timestamptz, status_updated_by text,
  created_at, updated_at,
  check ((scope='platform') = (workspace_id is null))
);
unique skill_package_platform_key (skill_key) where workspace_id is null;
unique skill_package_workspace_key (workspace_id, skill_key) where workspace_id is not null;

-- 版本（append-only；owner seed 写）
skill_version(
  id uuid pk, package_id uuid not null fk → skill_package(id) on delete restrict,
  workspace_id uuid,             -- 镜像 package（RLS 用）
  version text not null, manifest jsonb not null, body_markdown text not null,
  manifest_digest char(64) not null, body_digest char(64) not null,
  task_contract_id text not null, task_contract_digest char(64) not null,
  created_at,
  unique (package_id, version),
  unique (package_id, manifest_digest),
  unique (id, package_id)        -- 供组合外键
);

-- 租户覆盖（缺行 = 跟随平台默认；ops 管理）
skill_enablement(
  id uuid pk, workspace_id uuid not null, package_id uuid not null fk,
  enabled boolean not null, reason varchar(500), updated_by text,
  created_at, updated_at,
  unique (workspace_id, package_id)
);

-- 解析快照（append-only，内容寻址）
skill_resolution_snapshot(
  id uuid pk, workspace_id uuid not null,
  skill_key text not null, package_id uuid not null, version_id uuid not null,
  descriptor jsonb not null, descriptor_digest char(64) not null,
  resolver_version text not null,   -- 'skill-resolver/v0'
  created_at,
  foreign key (package_id) references skill_package(id) on delete restrict,
  foreign key (version_id, package_id) references skill_version(id, package_id) on delete restrict,
  unique (workspace_id, skill_key, descriptor_digest)
);
```

- **RLS**：四表全部 `ENABLE + FORCE ROW LEVEL SECURITY`。
  - `skill_package` / `skill_version`：`USING (workspace_id IS NULL OR workspace_id = current_workspace_id())`，`WITH CHECK` 同式。平台行对所有租户可读；workspace 行只见本空间（S3 启用）。
  - `skill_enablement` / `skill_resolution_snapshot`：`workspace_id = current_workspace_id()`。
- **app_user 授权（最小化）**：
  - `skill_package`：`SELECT`；`UPDATE` 仅列级（先 `REVOKE UPDATE ON skill_package FROM app_user`，再 `GRANT UPDATE (status, status_reason, status_updated_at, status_updated_by, updated_at)`）；无 `INSERT/DELETE`（seed 走 owner）。
  - `skill_version`：仅 `SELECT`；`REVOKE UPDATE, DELETE, TRUNCATE`（append-only，先例：`site_evidence_source_snapshot`，`20260717121000`）。
  - `skill_enablement`：`SELECT, INSERT, UPDATE, DELETE`（DELETE = 撤销覆盖、回到平台默认）。
  - `skill_resolution_snapshot`：`SELECT, INSERT`；`REVOKE UPDATE, DELETE, TRUNCATE`。
- **索引**：`skill_enablement(workspace_id, package_id)` 唯一；`skill_version(package_id, created_at desc)`（取当前版本）；`skill_resolution_snapshot(workspace_id, skill_key, created_at)`。
- 迁移写法沿仓库既有模式：`BEGIN; … COMMIT;` + `lock_timeout/statement_timeout`，additive。

### 5.2 契约行为摘要（`taskContractDigest`）

```
canonicalDigest({
  id, description, allowedTools: sorted, maxCostCents, maxOutputTokens,
  timeoutMs, retry, concurrency, toolVersion,
  risk, humanGate, acceptsModelSubstitute, outputSchema
})
```

复用 `model-runtime/context-engine.ts:34` 的 `canonicalDigest`（稳定序列化 sha256）。**不含 `model`**（部署策略，见 A3）；快照 descriptor 记录解析时刻的实际 `model`。

### 5.3 解析快照 v0（descriptor）

```json
{
  "skillKey": "company.understanding.extract",
  "version": "1.0.0",
  "packType": "growth_motion",
  "taskContractId": "company_understanding.extract_claims",
  "taskContractDigest": "<sha256>",
  "manifestDigest": "<sha256>",
  "modelPolicy": "contract-default",
  "effectiveModel": "deepseek-flash",
  "allowedTools": ["crawl4ai.fetch"],
  "maxCostCents": 20,
  "maxOutputTokens": 8192,
  "timeoutMs": 180000,
  "risk": "medium",
  "humanGate": true,
  "resolverVersion": "skill-resolver/v0",
  "resolvedAt": "2026-11-08T…Z"
}
```

- 内容寻址：`descriptor_digest = canonicalDigest(descriptor)`；`INSERT … ON CONFLICT (workspace_id, skill_key, descriptor_digest) DO NOTHING`。
- **不可变**：app_user 无 UPDATE/DELETE 授权；代码层只有 insert 路径。
- 粒度与生效时延：同 descriptor 只落一行；模型 env 变化 / 技能版本变化 → 新 descriptor → 追加新行（旧行不动）。
- **写入失败即失败**（fail-closed，决策点 D-g）：解析得不到快照就不执行模型调用，避免"跑了但无审计物"。

### 5.4 运行时数据源（为什么运行时不解析 YAML）

- `scripts/generate-skill-catalog.mts` 读取全部 SKILL.md → 校验 → 生成 `apps/api/src/skills/generated/builtin-skill-catalog.ts`（含规范化 manifest、正文、摘要），入库/CI。运行时与 seed 只 import 该模块。
- CI 单测 `builtin-skills.spec.ts`：目录文件 ↔ 生成物新鲜度、manifest 合法性、digest 与 `getTask()` 重算一致。生成物过期 → RED。
- 好处：运行时零 YAML 依赖、镜像产物仍是纯 JS（`nest-cli.json` 现有 assets 机制不动）；坏 manifest 在 CI 拦截而不是启动时。

### 5.5 Resolver

```ts
interface SkillResolver {
  readonly kind: 'static' | 'db';
  resolve(skillKey: string, workspaceId: string): Promise<ResolvedSkill>;
}
```

- **StaticSkillResolver**（缺省；测试与未接线上下文）：查内置生成目录；未知 → `SKILL_NOT_REGISTERED`。不读 DB、不写快照（文档注明仅测试/无接线场景）。
- **DbSkillResolver**（生产）：`createDbSkillResolver({ prisma, ttlMs = 30_000, now? })`
  1. 读 `skill_package`（platform 行）→ 无 → `SkillUnavailableError('SKILL_NOT_REGISTERED')`。
  2. `status = DISABLED` → `('SKILL_PLATFORM_DISABLED')`。
  3. 读最新 `skill_version`（created_at desc, id desc）→ 无 → `SKILL_VERSION_MISSING`。
  4. 读 `skill_enablement`（workspace, package）：存在且 `enabled=false` → `SKILL_WORKSPACE_DISABLED`。
  5. `getTask(version.task_contract_id)`：无 → `SKILL_TASK_CONTRACT_MISSING`；重算 digest ≠ `version.task_contract_digest` → `SKILL_CONTRACT_DRIFT`（fail-closed）。
  6. 生成 descriptor → `INSERT … ON CONFLICT DO NOTHING` 写快照；写失败上抛（D-g）。
  7. 进程内缓存 `(workspaceId, skillKey)` 30s（`ttlMs` 可注入；测试置 0）。ops 启停在 API 进程内立即失效缓存；worker 在 TTL 内生效（文档写明）。
- **错误分级**：`SkillUnavailableError`（非重试：未登记/停用/漂移/版本缺失）vs DB 连接类错误（普通 Error，交给 Temporal 重试）。

### 5.6 Adapter（直通）

```ts
async function executeSkillWithRuntime<Output>(
  resolver: SkillResolver, gateway, skillKey,
  input: GenerateStructuredInput, context: AiContext, options?,
): Promise<RuntimeStructuredModelResult<Output>> {
  const descriptor = await resolver.resolve(skillKey, context.workspaceId);
  if (input.task !== descriptor.taskContractId) throw new SkillUnavailableError('SKILL_BINDING_MISMATCH');
  return executeStructuredTaskWithRuntime(gateway, input, context, options); // 原样转发
}
```

- callsite 保持现有 `getTask('<taskId>')` 构造输入（执行权威的 `taskId` 锚点因此保留），只把 bridge 调用换成 adapter。
- **fit-judge 的 catch** 追加：`SkillUnavailableError` 与 `BudgetExceededError/BudgetOperationReplayError/ExecutionControl` 同待遇显性上抛 → 整轮 run 明确失败（`PARTIAL/FAILED`），绝不静默返回 null 判。
- understanding 活动把 `SkillUnavailableError` 转成 `ApplicationFailure.nonRetryable`（沿 `policyDenialFailure` 模式，`understanding.activities.ts:132`），避免 5 次无意义重试。

### 5.7 启停语义

| 操作 | 存储 | 生效面 | 生效时延 |
| --- | --- | --- | --- |
| 平台 kill switch | `skill_package.status` | 所有 workspace | worker ≤30s（缓存 TTL）；新解析立即 |
| workspace 覆盖 | `skill_enablement` 行 | 单 workspace | 同上 |
| 撤销覆盖 | 删除 enablement 行 | 回到平台默认 | 同上 |

缺行 = 启用（保持零行为变化：迁移/seed 后无任何 enablement 行，一切照旧）。停用进行中的 run：下一次技能解析即失败（非重试），当前 run 走 partial/失败路径；这是 kill switch 的预期语义（决策点 D-f）。

### 5.8 Seed（`apps/api/src/skills/skill-catalog.seed.ts`）

- owner 连接、启动期幂等（沿 `sanctions-seed.ts` / `DiscoveryProviderRegistry.seed` 模式）。
- 在 `worker.ts` 与 `relay/outbox-relay.service.ts` 的 `initializePlatformState` 中调用；失败 loud（`holdPlatformNotReady('SKILL_CATALOG_SEED_UNAVAILABLE')` / relay 抛错），不允许"带病起服务"。
- 语义：
  - package upsert（`skill_key, scope='platform'`）；**不改 `status`**（ops 手改不被 seed 覆盖）。
  - version：按 `(package_id, version)`；已存在且 `manifest_digest` **与 `body_digest` 都相同** → no-op；任一不同 → **抛错**（要求 SKILL.md 版本号 +1，杜绝静默漂移，正文改动同样受约束）；不存在 → INSERT。
- dev fast lane worker 不 seed（沿用其"无 owner/无 seed"约束），使用同一 DB resolver；本地库缺 seed 时 fail-closed（由 managed worker/relay 常驻 seed 覆盖）。

### 5.9 Ops API（引擎，S0 不接 gain-saas 页面）

| 方法 | 路径 | Scope | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/skills` | `ops:read` | 技能列表（键/版本/状态/启用覆盖数） |
| GET | `/api/v1/skills/:skillKey` | `ops:read` | 详情（manifest/正文/版本历史） |
| PATCH | `/api/v1/skills/:skillKey/status` | `ops:write` | `{status: ACTIVE|DISABLED, reason}` 平台 kill switch（写 `status_updated_by = ctx`） |
| PUT | `/api/v1/skills/:skillKey/workspaces/:workspaceId` | `ops:write` | `{enabled, reason}` 建立/更新 workspace 覆盖 |
| DELETE | `/api/v1/skills/:skillKey/workspaces/:workspaceId` | `ops:write` | 删除覆盖 → 跟随平台默认 |

负向：租户 token（无 `ops:*`）→ 403；enablement 是租户表，`skill_enablement`/`skill_resolution_snapshot` 受 RLS——ops 覆盖接口在引擎内以 `withWorkspace(目标 workspaceId)` 打开该空间事务读写，读到的只能是目标空间行；跨空间不可见由 RLS 保证（真库负向用例覆盖）。平台行（package/version）不按 workspace 过滤，app_user `SELECT` 始终可见。

## 6. 闭环设计（§0.6 ②）

- **SoR**：技能目录与版本 = 引擎 `skill_package`/`skill_version`（平台级，owner seed 写入）；workspace 启停 = `skill_enablement`；解析事实 = `skill_resolution_snapshot`（不可变）。没有第二处注册表。
- **对外事件**：S0 **不新增 outbox 事件**（零行为变化的一部分）；技能运行证据由既有 `ai_trace`/`usage_ledger`/durable receipt 承担，技能版本通过快照关联。S1 引入 Pack/技能 run 事件时再扩展。
- **Tool Contract**：不新增工具合同；技能绑定既有 AI task 契约，`allowedTools` 只能收窄不能扩（ToolBroker 的代码强制不变）。技能不对外暴露 MCP（S3 再议）。
- **闭环位置**（计划 §17.6 能力地图）：Understand（`company.understanding.extract*`）与 Qualify（`discovery.qualify_fit`）两段；底座治理行（skill_package/version/enablement/snapshot）横向支撑。
- **端到端演示脚本（合并后 dev 验证，需产品负责人发车）**：
  1. `GET /skills` 显示 3 个技能 ACTIVE + 当前 1.0.0；
  2. 跑一次真实公司理解（官网或资料）→ `ai_trace` 记录与包装前同 task/model；`skill_resolution_snapshot` 出现对应行；
  3. `PATCH /skills/discovery.qualify_fit/status {DISABLED}` →（≤30s 后）新一轮发现 run 在 fit 阶段明确失败（非静默 0 判）→ 恢复 ACTIVE → 恢复正常；
  4. `PUT /skills/company.understanding.extract/workspaces/<ws> {enabled:false}` → 该空间理解失败、其它空间不受影响 → DELETE 覆盖后恢复。
- **负向测试**：未登记技能键不可用；平台停用不可用；workspace 停用仅本空间不可用；跨租户 enablement 不可见（RLS）；租户 token 调 ops 端点 403；契约 digest 漂移 fail-closed；快照 UPDATE/DELETE 被拒（权限）；迁移后空表时理解/判定 fail-closed（不允许"没有注册表也照跑"）。

## 7. 幂等与重试

- 解析只读 + 快照 `ON CONFLICT DO NOTHING`：重复解析/重试不产生第二行、不改旧行。
- seed 幂等；同版本不同 digest → 启动失败（要求版本号递增）。
- 技能停用错误非重试；DB 短暂故障按既有活动重试策略恢复；快照写失败按 D-g fail-closed（可重试错误类）。
- Temporal 重试语义不变：包装不改变任何活动超时/重试配置。

## 8. 权限与合规（RLS / 数据权利 / DSR）

- 四表均 FORCE RLS；租户只见本空间行；平台目录行只读。
- 无个人数据进入技能目录/启用/快照（descriptor 只含技能与契约元数据、模型名、版本、digest）。
- 技能包正文可能含业务说明，但 S0 只装平台内置技能（我们自己写的），不做租户上传。
- DSR：技能快照/启用不含 PII，不新增擦除面；后续租户自定义技能（S3）再评估。
- 审计：ops 启停记录 `status_updated_by/updated_by` 与 `reason`；结构化日志一行（skillKey, action, workspaceId, operator）。
- 受保护执行权威文件不碰；执行收据/ACK 合同不变。

## 9. 预算与成本

- 不新增模型调用；不改变 `maxCostCents`/预算键/结算路径。
- 运行期增量：每次解析缓存未命中 ≈ 3 次索引 SELECT + 1 次幂等 INSERT；30s 缓存下每 worker 每 workspace×技能 ≤ 2 次/分钟。快照行数 ≈ workspaces × 3（模型/版本变化才追加）。
- 存储：正文 + manifest 每版本数 KB；可忽略。

## 10. 迁移与回滚

- 一条 additive 迁移（4 张新表 + 索引 + RLS + 授权/REVOKE），不动既有表；按仓库规程迁移前 `pg_dump`。
- 部署顺序：迁移 → 新镜像（seed 在 worker/relay 启动期写目录）。带迁移切换按 RUNBOOK 走硬窗口（无 run）。
- 回滚：镜像回滚即回到"adapter 缺省静态直通"（若上一版无 adapter，则完全没有技能层）——4 张表残留无害；down 迁移可选（不自动执行）。
- 若 seed 失败：worker/relay 不就绪（loud），不进入"带病运行"。

## 11. 测试与 TDD 步骤（3 个 PR，stacked）

> 计划 §17.8 说 S0 = 2–3 个 PR。以下按 3 个独立可审查 PR 拆分；S0-2 依赖 S0-1，S0-3 依赖 S0-2。

**PR-S0-1（纯新增，零运行时行为）**
- RED：
  1. `skill-frontmatter.spec.ts`：严格子集解析器正/负用例（§4.5 负向清单）。
  2. `skill-manifest.spec.ts`：字段约束、platform 扩展、digest 重算、allowed-tools 集合相等。
  3. `builtin-skills.spec.ts`：3 个 SKILL.md 合法、目录↔生成物新鲜度、与 `getTask()` 契约摘要一致。
- GREEN：解析器、validator、3 个 SKILL.md、生成脚本与生成物、`skills:validate` script。
- 验收：零容器单测全绿；`pnpm skills:validate`；无任何运行时接线。

**PR-S0-2（注册表 + resolver + adapter + 接线）**
- RED：
  1. 迁移静态契约 spec（表/索引/RLS/授权/append-only REVOKE，沿 `seller-document.migration.spec.ts` 模式）。
  2. `skill-resolver.spec.ts`：静态解析成功/未知键；DB 解析（mock prisma）各失败码；缓存；descriptor 稳定性。
  3. `skill-runtime.spec.ts`：adapter 转发逐字段等价（对 mock bridge 深比较）、binding mismatch、停用错误传播。
  4. `understanding.activities` / `fit-judge` 既有套件不改仍绿 + 新增：停用时 fit-judge 显性上抛、understanding 非重试。
  5. `skill-catalog.seed.spec.ts`：幂等、digest 漂移拒写。
  6. `skill-runtime-worker-wiring.source.spec.ts`：worker / dev-fast-lane 均构造并透传 resolver（源级，沿 `worker-dev-fast-lane.source.spec.ts` 模式）。
  7. postgres（CI 真库组）：`static ≡ db` 解析对照、快照 INSERT 幂等、app_user UPDATE/DELETE 快照被拒、跨租户 enablement 不可见。
- GREEN：迁移、seed、resolver、adapter、callsite 包装、worker 接线、`app-user-table-privileges.json` 更新。
- 验收：`gctl check` 全绿 + 真库组；既有 understanding/fit 套件零改动通过。

**PR-S0-3（ops 启停 + 文档收尾）**
- RED：`skills.controller.spec.ts`（scope 负向 403、参数校验）、service 单测（status/覆盖/删除覆盖）、controller-authz 扫描通过。
- GREEN：`SkillsModule`/service/controller、`docs/modules/ai-foundation/technical.md` 最小版、`docs/status/current.md` 回写、changelog 片段。
- 验收：必需 5 项检查全绿；自审后按 DEC-AIDEV-004 squash 合并（部署需另行「发车」）。

## 12. 风险与开放问题

1. **第三个技能缺失（最高优先级决策）**：`extract_facts` 不存在；本设计用 `company.understanding.extract_offerings` 替代（D-b）。若产品负责人坚持原名，则 S0 只能交付 2 个技能，或把 extract_facts 的实现拉进本步（会突破"零行为变化"）。
2. **采获线热路径改动**：understanding/fit 正在被 M0 步 1 另一会话真跑。缓解：默认路径逐字段等价测试 + 既有套件不改 + 包装只发生在两次函数调用之间；文件面不重叠（对方在 providers/planner）。合并节奏上若与其 PR 相邻，先并其分支再 rebase（merge）。
3. **严格子集解析器**：只覆盖我们写的 manifest 形态；复杂 YAML 会被拒（明确报错）。锁文件会话释放后切 `yaml` 包。
4. **每活动 DB 解析**：30s 缓存已够；若发现热点可加进程内预热。停用生效时延 ≤30s 已写入文档。
5. **快照写失败 fail-closed**（D-g）：会放大 DB 故障面；好处是审计不断档。若产品负责人选宽松模式，改为 log-and-continue 并接受缺行。
6. **ops API 的 workspace 覆盖**依赖 ops 身份可显式切换空间（`withWorkspace(workspaceId)`）；租户 token 无法到达端点。若未来 gain-saas 代租户管理启停，需再定义"租户管理员可为自己的 workspace 启停"的 scope（S1+）。
7. **执行权威清单**：包装不新增 ModelGateway/ToolBroker 调用；callsite taskId 字符串保留。若实现时不慎把 `getTask` 移出 callsite，`governance:verify` 会拦（EXECUTION_AUTHORITY_MODEL_CALLSITE_MISSING）。
8. **并发 writer**：`understanding.activities.ts` 与 `fit-judge.ts` 若被其他在飞 PR 同时修改，按仓库规则合并后重跑相关测试。

## 13. 联网研究（§0.6 ③，2026-11-08）

1. **[Agent Skills Specification（AAIF / agentskills.io，2026-10 捐入 Linux Foundation）](https://agentskills.io/specification)**：SKILL.md = YAML frontmatter + Markdown 正文 + 可选 `scripts/`/`references/`/`assets/`；`name`（≤64、小写字母数字连字符、与目录一致）、`description`（≤1024）、`license`/`compatibility`/`metadata`（string→string）/`allowed-tools`（空格分隔，实验性）；渐进披露（元数据 ~100 tokens → 全文 <5000 tokens → 按需资源）；官方 `skills-ref` 校验器。**借**：格式与命名/字段约束、`metadata` 作为客户端扩展位、渐进披露的目录组织；**避**：不自造包格式；**建**：平台扩展统一放 `metadata.platform.*`，validator 复刻并加严标准规则（v0 无 Python `skills-ref`，用仓库内脚本等价实现）。
2. **[pydantic-ai-skills SkillRegistry（Git/S3/Local 注册源，版本钉住）](https://github.com/dougtrajano/pydantic-ai-skills/blob/f308e105913a1f68c468efaa5c4a2ec41d11a78c/docs/registries.md)**：注册源只负责把技能包同步/物化到本地，**不解析** SKILL.md（校验归 harness）；Git 源用 tag/revision 钉住并把 revision 记入日志；组合式 `FilteredRegistry/PrefixedRegistry` 做逐步引入。**借**：注册源与校验分离、以 revision/digest 记录"用的是哪一版"、先小范围 allowlist（= 我们的 3 个技能）；**避**：git 分支跟踪式注册（生产必须钉住）；**建**：DB 版本行 + 内容寻址快照即"钉住"的落地。
3. **[OpenFeature 规范（Flag Evaluation API）](https://openfeature.dev/specification/types/)**：评估返回 `value + variant + reason`（`STATIC/DEFAULT/TARGETING_MATCH/DISABLED/ERROR…`）+ 评估上下文，错误码不抛异常（返回默认值）。**借**：resolver 返回结构化 `reason`（我们映射为错误码 `SKILL_*`）与评估上下文（workspace/skill）；**避**：全局单例 provider 与动态 targeting（S0 静态映射）；**建**：v0 resolver 的确定性优先级（平台目录 → 状态 → workspace 覆盖 → 契约校验）。

结论（借/集/建/避）：**借**标准格式、注册与校验分离、版本摘要钉住、结构化评估结果；**集**无合适现成库（Python 生态不匹配 NestJS；`skills-ref` 仅作对照基准）；**建**仓库内 validator + 受限 frontmatter 解析 + DB 注册表 + 内容寻址快照；**避**分支漂移、运行时执行技能脚本、把 LLM 引入解析/启停决策。

## 14. 决策点（请产品负责人确认）

> 批准记录：产品负责人 2026-11-08 回复「批准，按推荐」——D-a~D-h 全部按下列推荐值生效。

- **D-a（范围）**：S0 按计划 §17.8 执行，三个 PR 拆分（§11）；不引入新依赖、不动锁文件。
- **D-b（第三个技能）**：`seller_knowledge.extract_facts` 在代码中不存在（Phase 3 缺口）。**推荐**：以 `company.understanding.extract_offerings` 替代，凑齐 3 个存量技能；备选 A = 只包 2 个技能、第三项等 extract_facts 实现后再包；备选 B = 把 extract_facts 实现并入本步（不推荐，破坏零行为变化）。
- **D-c（validator 依赖）**：**推荐** v0 用仓库内严格子集 frontmatter 解析器（无新依赖，锁文件不动）；锁文件会话释放后切换 `yaml` 包。
- **D-d（第四张快照表）**：计划的"三表"之外增加 `skill_resolution_snapshot` 以满足"快照不可变"DoD。**推荐**：接受；粒度 = 每 (workspace × skill × descriptor-digest) 一行。
- **D-e（ops 面范围）**：S0 只交付引擎 ops API（`ops:read`/`ops:write`），gain-saas 运营台页面与租户管理员自助启停放 S1。**推荐**：接受。
- **D-f（停用语义）**：停用对进行中的 run 立即 fail-closed（下次解析即失败，run 走 PARTIAL/FAILED，不静默）。**推荐**：接受。
- **D-g（快照写失败）**：**推荐** fail-closed（写不进快照就不执行）；备选 = log-and-continue。
- **D-h（模型策略）**：`taskContractDigest` 不含 `model`；模型属部署策略，快照记录 `effectiveModel`。**推荐**：接受（否则每次换模型 env 都要新增技能版本）。

## 15. 给产品负责人的说明

- **得到什么**：一套可治理的技能底座 v0——3 个存量 AI 技能有正式包规范（生态兼容 SKILL.md）、注册/版本/启停与不可变解析快照；ops 可一键停用/恢复任一技能，未登记技能无法执行；行为、预算、模型调用与现在逐字节一致。
- **没改什么**：不改任何 task 契约/提示词/schema/模型路由/预算/收据/事件；不动 gain-saas；不引入新依赖；不执行技能脚本；不发送任何对外内容。
- **风险与回退**：主要风险是采获线热路径包装（已用逐字段等价测试 + 既有套件不改 + 真库对照兜底）；回退 = 镜像回滚，4 张表残留无害。第三个技能 `extract_facts` 不存在，需在 D-b 中定夺替代方案。
- **建议**：批准 D-a~D-h（按推荐值）后按 §11 的 3 个 PR 顺序 TDD 施工；合并后请安排一次 dev 发车做 §6 的端到端演示（stop/start 各一轮）。
