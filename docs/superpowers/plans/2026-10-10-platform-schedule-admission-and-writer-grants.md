# 平台 schedule 准入与平台写入者授权：设计

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-10 会话内按 §6 的建议拍板：P1 冻结 R4（D2）、P2 RL1 期间平台 schedule 继续暂停、P3 制裁名单走运营刷新后打开制裁门（D9）。

事实基线：`origin/main@55357817`。只读核对代码、迁移与 GrowthOS 补丁，没有改库，也没有恢复任何 schedule。代码位置写作「文件:行」，迁移位置写作「迁移名 L行号」。

## 0. 结论

- **4 个平台 schedule 现在 unpause，第一步就会失败。** 涉及的 schedule：`acq-sweep`、`intent-sweep`、`sanctions-refresh`、`patents-cache-refresh`。
  - 四个工作流的第一步是 `admitPlatformSchedule`，它调用 `admit_platform_execution_budget_run_v1`。
  - 2026-09-05 的迁移已收回平台写入者对这个函数的执行权，真库测试也断言它报 `permission denied`。
- **根因不是漏授权，而是 09-05 的切换只做了 Backend 的一半。** 新的准入（v2）要求：
  1. GrowthOS 为每次工作流运行签发一张平台授权（compact JWS），绑定 schedule、workflow、run 与技术策略；
  2. 这张授权以 inbound command 交给 Backend。
  - 两个缺口：
    - GrowthOS 只有签名器，注释原文是「Cryptographic adapter only; a later durable issuer must commit before exposing bytes」，没有持久签发，也没有投递。
    - Backend 的 v2 服务注册了，但没有调用方。
  - 合同记录把这两项标为 `EXTERNAL_OWNED/PARTIAL` 与 `CUTOVER_BLOCKED`。
- **表授权是另一处缺口。** 平台写入者只对三张预算表有 SELECT，四个「带回执」写入分支要用到的 10 张表都没有授权（§1.2）。
- **就算准入和授权都补上，巡检与制裁刷新也拿不到回执。** ToolBroker 对平台调用扣住了 `crawl4ai-render/v1` 和 `sanctions-download/v1`（没有真实的工作区主体）。
- **所以「补一个授权 PR」修不好。** 怎么修取决于 D2（R4 冻结范围，PRD L0 §9.4）：
  - 保留 R4：两个仓一起补签发、投递、接线与授权（方案 A）。
  - 冻结 R4（PRD 建议）：把 4 个平台工作流迁进 customer worker，用运营配置行加金额上限准入，平台写入者这条线随之退役（方案 B，PRD L2 减负线 X.2）。
- **决定（2026-10-10）**：
  - 不在 R4 准入上继续投入（不做 A）。
  - RL1 期间平台 schedule 继续暂停（方案 C）。
  - RL1 要用的制裁名单走一条不经平台 schedule 的运营刷新路径（方案 B0）。
  - R4 冻结（D2），平台工作流迁进 customer worker 的设计另出（方案 B，PRD L2 减负线 X.2）。

## 1. 现状核实

### 1.1 准入

| 环节 | 事实 | 证据 |
|---|---|---|
| 工作流第一步 | 四个平台工作流都先调 `admitPlatformSchedule` | `temporal/acquisition.workflow.ts:35`、`temporal/intent.workflow.ts:36`、`temporal/patents-cache.workflow.ts:42`、`temporal/sanctions-refresh.workflow.ts:23` |
| 活动 | `admitPlatformSchedule` → `budgets.admitPlatformRun(...)` | `temporal/platform-schedule-authority.activities.ts:116-150`（调用在 `:133`） |
| BudgetStore | 平台 worker 用平台写入者连接构造 `PostgresBudgetStore`；`admitPlatformRun` 调 `admit_platform_execution_budget_run_v1` | `temporal/platform-worker.ts:172`；`tools/budget-store.ts:820-832` |
| 执行权已收回 | 收回平台写入者对 v1、`ingest_platform_execution_authority`、`open_authorized_tool_budget_v1`、`open_tool_budget` 的 EXECUTE，只授 v2 | `20260905193000_platform_execution_run_binding` L417、L433；注释：旧入口「cannot create a newly unbound authority or open a platform account without the exact run/workflow/policy comparison」 |
| 测试已断言 | 平台写入者调用旧入口报 `permission denied` | `packages/db/test/platform-schedule-authority.rls.spec.mjs:518-541` |
| v2 无调用方 | `PlatformExecutionBudgetAuthorityIngestionService.ingestAndAdmit(compactJws, expected)` → `ingestPlatformAndAdmit` → `ingest_and_admit_platform_execution_budget_run_v2`；服务只在模块里注册 | `execution-budget/platform-authority-ingestion.service.ts:50-68`；`execution-budget/execution-budget-authority.repository.ts:539`；`execution-budget/execution-budget.module.ts:28,40` |
| 外部缺口 | 「Platform inbound transport」为 `EXTERNAL_OWNED/PARTIAL`；「Platform lifecycle cutover」为 `CUTOVER_BLOCKED` | `docs/implementation-records/execution-budget-authority-contract.md:319,321` |
| GrowthOS | `PlatformAuthorityPlatformGrantSigner` 只是签名适配器，没有持久签发方 | growthos-source `patches/0083-platform-quote-grant-kernel-green.patch` 第 18 行 |

### 1.2 平台写入者的表授权

现有授权：
- `execution_budget_authority`、`execution_budget_authority_revocation` 的 SELECT 与 schema USAGE（`20260821090000` L1379-1383）；
- `execution_domain_ack` 的 SELECT（`20260823000000` L313-314）；
- 一组 SECURITY DEFINER 函数的 EXECUTE（预算预留 / 结算 / 释放、出网围栏、DomainAck 等）。

四个写入分支在工具调用带持久回执时，在平台写入者的事务里执行业务写入：
- 采集：`acquisition/acquisition.service.ts:249`；
- 网站巡检：`intent/website-watch.service.ts:253`；
- 专利缓存刷新：`temporal/patents-cache.activities.ts:101`；
- 制裁刷新：`sanctions/sanctions-refresh.service.ts:307`。

按代码需要的表权限：

| 表 | 需要 | 用途 | 证据 |
|---|---|---|---|
| `monitored_source` | S, U | 采集、巡检 | `acquisition.service.ts:237`；`website-watch.service.ts:241` |
| `source_fetch` | S, U | 采集、巡检（含回放读回） | `acquisition.service.ts:223,261,270`；`website-watch.service.ts:228,265,274`（插入在 `app_user` 一侧） |
| `source_entity` | S, I, U | 采集、巡检 | `acquisition.service.ts:154-216`；`website-watch.service.ts:151-215` |
| `source_entity_change` | I | 采集、巡检 | `acquisition.service.ts:217`；`website-watch.service.ts:227` |
| `sanctions_entity` | S, I, U | 制裁刷新 | `sanctions-refresh.service.ts:266-285` |
| `sanctions_source` | S, U | 制裁刷新 | `sanctions-refresh.service.ts:291` |
| `patent_inventor_tombstone` | S | 专利刷新 | `discovery/adapters/patent-inventor-cache.ts:459` |
| `patent_inventor_cache` | S, I, U, D | 专利刷新（upsert 与 deleteMany） | `patent-inventor-cache.ts:486,503` |
| `patent_lookup_request` | S, U | 专利刷新 | `patent-inventor-cache.ts:521` |
| `patent_cache_refresh_audit` | S, U | 专利刷新（行由属主创建） | `patent-inventor-cache.ts:399,530,547`；`patents-cache.activities.ts:34,113` |

这几张表没有 RLS，平台写入者是 NOBYPASSRLS。外键检查以表属主身份执行，不需要额外授权。另有两处：
- 四个写事务都用 Prisma 交互事务的默认超时（5 秒），批量写入可能超时；
- 平台写入者还没有权限清单，`app_user` 的清单见 `docs/governance/app-user-table-privileges.json`。

### 1.3 为什么今天没暴露

- 4 个平台 schedule 是 paused。
- 网站巡检的 `crawl4ai-render/v1`、制裁刷新的 `sanctions-download/v1` 被 ToolBroker 扣住，平台调用没有真实的工作区主体（`tools/tool-broker.ts:55-65`）。两条路径拿不到回执，走不到平台写入者那一支。
- `google_patents` 是 DISABLED。

## 2. 方案

### A：保留 R4，补齐逐次平台授权

要做的：
1. GrowthOS：持久的平台授权签发方，每次运行签一张，绑定 run、workflow 与策略，先落库再给出字节。还要一个签发接口（Backend 调用，HMAC 或服务身份）。改补丁线、重新发布 GrowthOS。
2. Backend：
   - 调用签发接口的客户端（就是 `/global/CLAUDE.md` §0 记的「Backend 没有调用 GrowthOS HMAC 签发端点的客户端」那一段）；
   - `admitPlatformSchedule` 改为先取授权、再走 v2；
   - 平台写入者按 §1.2 授权，配清单与真库测试；
   - 写事务设超时；
   - 迁移随镜像同窗口上线。
3. 另定：ToolBroker 对平台的两个扣留是否放开、怎么给平台产物一个真实主体。

代价：
- 两个仓、多个 PR，还要一次 GrowthOS 换版；
- 7 天续期、原生 Temporal、capability 轮询都继续保留；
- 撤销投递链仍未打通；
- 与 PRD 的 D2 建议方向相反。

### B：冻结 R4（PRD 建议），平台工作流迁进 customer worker

- **准入**：一张运营配置表（用途、schedule、每次上限、每月上限、启停），由属主写入，数据库函数按配置准入，不经 GrowthOS。
- **带回执的写入**：customer worker 没有平台写入者（`temporal/worker.ts:335`）。要另设计写入路径，可选两种：
  - 按功能给属主定义的 SECURITY DEFINER 写入函数；
  - 给 customer worker 一个专用的受限角色。
  - 这同时解决 L4-G20：发现 run 的网站监控注册目前直接跳过（#620）。
- **退役**：平台 worker、平台用的原生 Temporal、capability 轮询、GrowthOS 的 R4 补丁、7 天续期（L2 X.2：换镜像 12 步 → 1 步）。
- **代价**：RL2 规模，要先出一份迁移设计。PRD 排在第 4 周，前提是 D2 批准。

### B0：RL1 过渡，制裁名单由运营刷新

- BI-13 要在 RL1 打开制裁门，但库里只有 07-13 版的 OFAC SDN（9,810 条）；EU FSF、OFAC Consolidated 从未入库，三个源都是 DISABLED（PRD L1 §5.2）。
- 做法：一个运营脚本，以属主连接复用 `SanctionsRefreshService` 的解析与入库。
  - 它从官方地址下载，走 net-guard，不经平台 schedule，也不产生预算回执；
  - 写入走无回执那一支（`persist(prisma)`）；
  - 每次刷新留审计行，`last_refreshed_at` 更新。
- 前提：D9（制裁源 ENABLED）。原始名单里有被制裁的个人，解析层只保留实体，个人不入库：OFAC 只留 `sdnType = Entity`（`adapters/ofac-xml.ts:91`），EU FSF 只留 `subjectType = enterprise`（`adapters/eu-fsf-xml.ts:56`）。施工时用三个源的真实样本补测试，锁住这条。

### C：维持暂停（现状）

不施工。`/global/local-config/RUNBOOK.md` §1 已记下这个陷阱，避免有人直接 unpause。

## 3. 推荐与决定

- **RL1**：C + B0。
  - 平台 schedule 继续暂停；
  - D9 批准后做 B0（一个 PR：运营脚本、单测、一次性库真测、RUNBOOK 一节），给制裁门真实名单。
- **D2 批准后**：按 B 出迁移设计（准入配置表、带回执写入的新路径、退役清单），再拍板、施工。
- **不推荐 A**，除非产品负责人决定 R4 不冻结。若选 A，顺序为：
  1. GrowthOS 持久签发与签发接口；
  2. Backend 签发客户端与 v2 接线；
  3. 平台写入者授权、清单、真库测试、事务超时；
  4. ToolBroker 扣留的决定；
  5. 同一窗口上线。

## 4. 合规与安全

- A 增加跨系统密钥与签发面，撤销投递链仍未打通。
- B 去掉这部分攻击面，但新的准入配置表必须只有属主能写。延续 #619、#621 的做法：运行时角色只读，清单加真库测试。
- B0 下载的是官方公开名单。原始名单含个人，解析层结构性剔除，库里只留实体；三个源都要有测试证明个人条目不入库。

## 5. 风险

- 有人直接 unpause：第一步即报权限错误，不会花钱也不会写数据。RUNBOOK 已记。
- 制裁门长期用旧名单（B0 不做时）：RL1 的「制裁命中全部进人工复核」形同虚设。名单过期还应进 readiness 或周报提示（L1 风险 4）。
- B 的迁移设计若拖到 RL2 之后，平台写入者、R4 续期与 GrowthOS 补丁线要一直维护。

## 6. 需要产品负责人决定

| # | 决定 | 选项 | 建议 | 结果（2026-10-10） |
|---|---|---|---|---|
| P1 | D2：R4 是否冻结 | 冻结（B，PRD 建议）/ 保留并补齐（A） | 冻结 | 冻结 |
| P2 | RL1 期间平台 schedule | 继续暂停（C）/ 先按 A 补齐再恢复 | 继续暂停 | 继续暂停 |
| P3 | D9：制裁源 ENABLED 与刷新方式 | B0 运营刷新后翻 ENABLED / 等 B 迁移后再开 | B0 | B0 |

## 7. 施工步骤（拍板后）

**B0**（约 1 个 PR）：
1. 失败测试：运营脚本对三个源的解析与入库；
2. 实现：复用 `SanctionsRefreshService`，以属主连接、走 net-guard 下载；
3. 一次性库真测（CI 钉住的 pgvector 镜像，只绑 127.0.0.1）；
4. `gctl check`、独立复审、合并；
5. 产品负责人批准后在 xin 执行一次，核对行数与版本，再按 D9 翻 ENABLED。

**B**：另出设计。

**A**（若选）：按 §3 的顺序，每步一个 PR。授权迁移沿用 #621 的写法：
- 先全收再精确授予；
- 迁移内自检；
- 清单 `docs/governance/platform-writer-table-privileges.json` 加真库测试。
