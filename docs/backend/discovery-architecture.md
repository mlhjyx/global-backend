# 多源发现系统架构：工具契约 · Agent 编排 · MCP

> 设计依据：PRD 第 9 部分（9.2 AI 分层 / 9.4 Task Contract / 9.8 Durable Workflow / 9.11 无超级 Agent / 9.13 Tool Registry）+ 10.19（禁止直接暴露 OSS 未认证 API / 外部队列替代核心 Workflow）。
> 目标：把发现从「只挖官网单源」扩展到「多源、多工具、可编排、可选 MCP 暴露」，且**不引入超级 Agent**。

## 1. 四层模型（职责单向收窄，不合并）

```
L3 Workflow (Temporal)   拥有 顺序/状态/等待/重试/补偿/人工Gate；每次工具调用=带幂等键的 Activity。业务主状态写 Postgres，不写工作流历史。
        ↑ 只调
L2 AI Task (9.4)          有界目标 + allowedTools 白名单 + 预算 + Schema + humanGate 的认知单元。声明要用哪些 Tool，不持有工具权限；LLM 只理解/抽取/判断/建议。
        ↑ 经 Broker 发起
L1 ProviderAdapter (七类) 面向 SourceClass 的能力聚合门面。一个 Provider 内部组合多个 Tool 完成一次领域调用，把多 Tool 产物折叠成 ProviderCompanyRecord（原始 JSON 不穿透，ADR-017）。
        ↑ 组合
L0 Tool                  最细粒度原子能力，一后端一动作（searxng.search / crawl4ai.fetch / wikidata.sparql…）。无状态、无业务语义、不做权限/预算判断；产物统一带 provenance。
```

**关键结论**：Tool ≠ Provider，Tool 比 Provider 细一层。Provider 是 Tool 的**确定性组合器 + 归一器**。新增源（wikidata/gleif/opencorporates）= 新建对应 SourceClass 的 Provider，内部挂 Tool，领域层零改动（OSG-003 契约测试保证）。

**无超级 Agent 如何保证**：没有任何一层能「自由选任意工具」——Task 的工具集在契约里**静态声明（allowedTools）**，`ToolBroker` 在调用点用确定性系统兜底（权限/预算/合规/健康）。工具图的连接决策（哪个工具输出喂哪个）由**确定性的 SourceSelector/Workflow** 决定，绝不由运行时 LLM 循环决定。

## 2. Agent（AI Task）目录

发现主线的 Agent 全部是**有界 Task**，不是自主 Agent：

| Agent / Task | 目标 | Model | 可用工具 | humanGate | 必须确定性的部分 |
|---|---|---|---|---|---|
| **QueryPlanner** `discovery.query_plan` | ICP → 跨多源查询计划（选 2-4 类 source_class + 结构化 filters + 本地语言关键词） | deepseek-v4-pro | 无（纯生成，只读 ICP + source_class 目录） | ✅ DRAFT→READY | source_class 白名单校验、priority 排序、estimated_volume 与预算 Dry Run、状态机 |
| **SourceSelector** `discovery.select_sources` | 把每条抽象 query 绑定到 ENABLED/许可/区域合规/预算内的具体适配器 | gemini-2.5-flash（**可选**，多数退化为确定性路由） | 只读 Tool Registry / data_provider / source_policy | ❌ | **不变式**：确定性过滤（Kill Switch/许可/robots/SUSPENDED/成本）先短路 → AI 只对合规幸存者排序 → 确定性挑选 |
| **Discovery** `discovery.extract_company` | 执行选定工具挖候选 + 判站 + 抽取结构化属性 | gemini-2.5-flash | **每任务 allowedTools 白名单**（如仅 searxng.search + crawl4ai.fetch），不给全源工具并集 | ❌ | raw 原样落地 + 幂等去重、url-guard/robots/SUSPENDED 拦截、provenance、PER_SOURCE_LIMIT/记账 |
| **Resolver** | 多源 raw 归一 + 身份解析（域名精确 > 名称+国家）→ canonical + identity_link | **无（确定性，非 AI）** | 无，纯 DB 事务 | ❌ | 全部确定性（9.11：状态不能靠模型想象）。已实现 `identity.ts` |
| **FitGate** `discovery.qualify_fit` | 资格四门（材质/角色-竞品/工艺子集/商业模式-中介）→ match/weak/mismatch | gemini-2.5-pro | 无，只吃 ICP + 候选结构化字段 | ❌ | verdict 值域校验、fitVerdict→queue 映射 |
| **ContactFinder** | Waterfall 5/7 步：仅对 match+达阈值企业挖联系人 + 邮箱验证 | gemini-2.5-flash（可选） | contact_discovery / email_verification 适配器 | ✅ | 只对达标企业触发、去重、Suppression、预算硬约束、PII 标注 |
| **EvidenceAuditor** `evidence.audit`（新增） | 抽查 Evidence 溯源是否成立、标注营销性/绝对化表述、跨源冲突 | deepseek-v4-pro | 只读 evidence/claim/source_policy | ✅ | 许可/用途硬匹配、Suppression、冲突机检、最终 allow/deny 归 OPA（AI 只产「疑点」） |

**AI vs 确定性判据一句话**：凡「可能被模型想象、必须可重放可测、决定钱/权限/对外/合规结论」的 → 确定性代码；凡「把非结构化世界读成结构化判断/建议」的 → AI Task。

## 3. Tool Registry + ToolBroker（确定性，非 LLM）

- **Tool Registry**：Tool 的注册表 + 路由器。启动期从代码内声明装载（非动态外部注入）。`resolve({capability, sourceClass, budgetLeft, preferHealthy})` 按 能力匹配 → 健康 → 成本升序 → 风险 返回候选，走 `fallbackToolIds` 降级链。选路是**确定性规则**，非模型裁量。
- **ToolBroker**：唯一执行入口 `broker.invoke(toolId, input, ctx)`。所有强制点在这里（工具内部不自证）：
  1. 认证/RLS + 上下文 `{workspaceId, runId, taskContractId, budgetToken}`（**强制**）
  2. `allowedTools` 白名单（Task 只能调它声明的工具）
  3. 合规门：`requiresSourcePolicy` → 查 source_policy（非 SUSPENDED、robots、terms、allowed_purpose、personalData→OPA）
  4. 预算门：**reserve-then-settle**（执行前原子预留 budget token，执行后按 UsageLedger 结算）——不是 advisory Dry Run
  5. 限流门：全局令牌桶 + 每域串行（对齐 source_policy.crawl_delay_ms）
  6. 幂等/缓存：`idempotencyKey(input)`，与 raw_source_record 去重键**统一**
  7. 审计：每次调用产 Trace（taskId/toolId/version/cost/latency/policyDecision，脱敏入观测）
- **与现有 `data_provider`/`routeCompanyDiscovery` 的关系**：合并成**一个** Registry，Tool 是更细入口——Tool Registry 包裹（不是并列另一个路由器）现有 provider 路由。

## 4. MCP 结论：传输层，不是授权层

**立场**：MCP 是「工具传输/暴露协议」，不是「授权模型」。一个能自由 `list_tools`/`call_tools` 的 LLM 就是 9.11 禁止的超级 Agent。

- **第一步不做 MCP**。先做 Tool Registry + ToolBroker + Temporal 编排。
- **内部 MCP（后续可选）**：把同一份 Tool Registry 声明**投影**为 MCP tools，仅供受控编排/自研 agent 用；`list_tools` 按 Task Contract allowedTools 过滤，`call` 强制携带 budgetToken，所有 Broker 强制点照旧生效。MCP 只是 Registry 的一个出站门面，绝不替代 Registry/Policy/Temporal，也不引入自己的队列。
- **外部第三方 MCP：一律不直连业务链路**（等于暴露未认证 OSS API，违反 10.19/OSG-003）。需要第三方能力就**内化**成实现我方 ProviderAdapter 契约的防腐层（ACL），先过 OSS 准入（Capability Card/License/Security Review/Exit Plan），输出照旧进 raw_source_record 再归一。

## 5. 落地顺序（评审收敛，严格按此）

1. **扩展 `AiTaskContract`**：加 `allowedTools / inputSchema / maxCostCents / timeoutMs / retry / concurrency / toolVersion`，回填现有任务。**最先做**——「有界工具」目前只是文字承诺、代码未强制，这是最大确定性缺口。
2. **建确定性 Tool Registry + ToolBroker**（`apps/api/src/tools/`），收敛现散落在 discovery.activities.ts（sourcePolicy/usageLedger/幂等）与 adapters/（robots/url-guard）的闸门为统一前后置；把唯一调用点 `executeQuery` 的 `adapter.discoverCompanies` 改为 `broker.invoke`；先登记 searxng.search / crawl4ai.fetch / crawl4ai.deepcrawl。
3. **增量加源工具**（同 broker/adapter 契约，最便宜低风险优先）：`wikidata.sparql` + `osm.overpass`（免费、CC0、无需 source_policy），各带契约测试证明产物落 raw_source_record 且经现有 Resolver 不变。之后再 OpenCorporates/GLEIF/crt.sh/CommonCrawl/trade。
4. **多源编排**（broker 成为唯一执行路径且多源验证后）：Temporal 里加 QueryPlanner/SourceSelector；QueryPlan 人工 Gate DRAFT→READY；工具图连接**确定性**。
5. **MCP**（最后、可选）：内部 MCP server 作为 Tool Registry 的传输投影。

## 6. 待修的确定性缺口（评审点名）

- AiTaskContract 缺 allowedTools 等字段 → 「有界工具」未在代码强制（**第 1 步解决**）。
- 预算应 reserve-then-settle 原子预留，非 advisory Dry Run（并发会各自过检共同超支）。
- SourceSelector 必须「确定性过滤 → AI 排序幸存者 → 确定性挑选」，顺序不可颠倒（须测试）。
- FitGate 覆盖确定性 Fit 是**词表归一欠账的临时策略**，须带明确到期 + eval gate，否则 AI 静默拥有 Lead 状态。
- idempotencyKey 与 externalId 去重键必须统一。
- EvidenceAuditor 的 AI severity 不得自动 gate 放行，最终只由 OPA 裁决。
