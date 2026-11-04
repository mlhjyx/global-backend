# 买家发现与资格判断 · 模块技术方案

> 文档 ID：`DOC-MODULE-DISCOVERY-QUALIFICATION-TECH-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草）
> 生命周期依据：承接已批准方案 D3/D4 与 §3.5；实现事实以代码与 status 为准。
> 模块产品说明：[product.md](product.md)

## 1. 变更历史

| 日期 | 变更 | 来源 |
| --- | --- | --- |
| 2026-11-02 | 初稿：run 阶段/并发/预算/评分/交付包/性能改造 | 已批准方案 |

## 2. 技术概览

- 归属：引擎 `/global/backend`（NestJS + Temporal + ToolBroker + 模型网关）。
- 编排：`discoveryWorkflow`（阶段严格串行；query 内批 2，常量 `DISCOVERY_QUERY_BATCH` 在 `apps/api/src/temporal/discovery.workflow.ts`）；活动超时 2/15/30 分钟；lease 软截止 → PARTIAL。
- 预算：每操作一次性 Grant（purpose/subject/request hash 绑定）；消费后不可复用；重试=新 request/新 Grant。

## 3. Run 阶段与并发（as-built）

| 阶段 | 并发 | 超时/重试 | 备注 |
| --- | --- | --- | --- |
| query | 批 2 | 15 分×3；上游不可用等 5/25 分 | searxng ≤3/查询、≤14 域名抽取（5 并发） |
| canonicalize | DB 批 128 | 2 分×3 | 身份归并/去重 |
| websiteProfile | 2 | 30 分×2 | 官网/Impressum，30 天 TTL |
| fit | 3 | 15 分×3 | 每公司 1 次 LLM（26–134 秒） |
| enrich | 串行 | 2 分×3 | GLEIF |
| signals | 串行（≤12 家） | 30 分×2 | 7 天 TTL |
| contacts | 2 + 18 分软限 | 30 分×2 | fit=match，lawful basis 门 |
| watches/patent/finalize | 串行 | 2–30 分 | finalize 写终态/事件 |

## 4. 评分与交付

- 六维评分（fit/role/intent/dataQuality/reachability/engagement）；规则版本随 Lead 存；制裁第五门；禁联与权利检查。
- LeadQualifiedPackage 不可变快照（scores/evidence/rights/suppression/recommended_action/valid_until）。
- 事件：`LeadQualified` 等 10 个集成事件经 outbox + ACK；SaaS 消费。

## 5. 性能改造（Phase 2b）

1. 快档抽取 + 置信度升级（配置 + golden set）。
2. 批量 LLM fit（每批 5 家；账本键/两连败语义保持）。
3. 并发 env 化 + 上游限流（query 3/4、fit 5、profile 3）。
4. 阶段流水线化（canonicalize 后即 profile；fit=match 即 signals）。
5. 跨 run 查询缓存（domain/query hash，30 天）。
6. 流式线索（每批 fit 完成即评分入队）。
7. 可恢复 run（与任务/重试合并）。

**目标**：首批线索 ≤10 分钟；25 家整轮 ≤30 分钟；召回不降。

## 6. 任务与 rerun（Phase 4）

- `DiscoveryRun` 增 `attemptNo`/`rerunOfRunId`；`POST /query-plans/:planId/rerun` 以 `planId+attemptId` 新 request hash/新 Grant；同 plan 并发 run 拒绝（advisory lock）。
- execute/rerun 支持 `Idempotency-Key`：先查后消费，避免双扣费与孤儿 run。
- SaaS `AcquisitionTask`/`TaskRun` 映射；事件消费更新 TaskRun 状态。

## 7. 实现状态与缺口

**已实现**：ICP/规则/回测/计划/确认/执行/run/线索/评分/交付包/周报；联系人阶段 M1–M4；lease 软截止。
**缺口**：query 阶段 50–70% 耗时；fit 逐公司 LLM；qualify 5 分钟超时无 heartbeat；run 无流式线索；Grant 一次性无 rerun；幂等覆盖不足；平台 schedule 暂停。

## 8. 测试

- 现有：discovery workflow/activities、fit-judge、lease、scoring、lead delivery 相关 spec。
- 需补：批量 fit 契约、冻结/重放、rerun 幂等、性能 golden set、大 workspace qualify。

## 9. 风险与回退

- 并发上调触发 429 → 配限流与退避；golden set 守召回。
- rerun 双计费 → Idempotency-Key + 账本先查。
- 失败回退：开关回旧并发/旧模型档。
