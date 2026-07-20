# 现用能力硬化与退出基线

> 文档 ID：`BASE-FE-P7-002`
> 状态：`FROZEN_EVIDENCE` / `APPROVED_AT_GATE_7`
> 适用：`ADP-FE-001/002/005/018/019/021/022/024`

八项能力已经存在于仓内代码、lockfile 或 Ubuntu 开发运行环境，所以 Phase 7 不把它们退回“候选”。诚实状态是 `INTEGRATE / *_HARDEN`：承认 as-built，同时列清距离可复现部署、生产安全和可退出还有什么。本文件是后续风险队列输入，不是施工授权。

## 1. 单项硬化清单

| Card | 当前事实 | 生产前最小硬化 | 必须留存的 Release 证据 | 退出演练 |
|---|---|---|---|---|
| `001` pgvector | PostgreSQL/Prisma/RLS 主库，开发镜像 tag `pg16` | 固定扩展/镜像、HA/backup/restore、RLS 对抗、索引/升级兼容、SBOM/notice | migration digest、extension/version、RLS 矩阵、恢复 RTO/RPO、回滚结果 | 导出事实/向量并重建到 PostgreSQL 原生或替代引擎；对象 ID/租户边界不变 |
| `002` Astro | renderer lock `5.18.2`，受控 SiteSpec 渲染已存在 | 构建 sandbox、unknown component fail-closed、artifact manifest/digest、CSP/a11y/perf、版本回放 | Site Fixture 双构建、恶意输入、离线构建、旧 Release 重放、产物扫描 | 用同一 renderer-neutral SiteSpec 切换实现，旧 Astro 构建镜像保留到回放窗口结束 |
| `005` Fontsource | Noto Sans/Arabic 已锁包并随站点构建 | family/weight/subset 清单、OFL/notice、字形/RTL/CLS/体积、上传字体拒绝策略 | font license manifest、locale glyph fixture、CSP/离线/视觉回归 | semantic token 改指系统字体或另一自托管 family，不改页面/业务合同 |
| `018` Docling | 开发容器运行，Compose 为 `latest` | pin digest/版本、恶意文档 sandbox、大小/页数/时间预算、OCR/模型清单、隔离与清理 | 文档 corpus 准确率、zip bomb/畸形输入、超时/取消、SBOM、升级对照 | `DocumentParserProvider` 导向替代解析器；保留原文件和我方标准解析合同以重放 |
| `019` Crawl4AI | wrapper 固定 0.9.1 digest；开发 egress/SSRF 真机矩阵已通过 | 生产网络隔离、容量/SLO、浏览器镜像/补丁升级、凭据/日志脱敏、robots/目的门 | 公网正例+private/metadata/redirect 负例、pin/DoH 证据、超时/体积/取消、升级回滚 | `WebCrawlerProvider` 切替代；URL/task/evidence 仍在我方，缓存按政策删除 |
| `021` SearXNG | 开发容器运行，Compose 为 `latest` | pin digest、engine allowlist/条款、限流/缓存/日志隐私、网络隔离、降级 | 引擎健康矩阵、无结果/部分失败、PII 日志检查、SBOM、升级/回滚 | `SearchProvider` 切批准商业 API/其他实现；候选归并与事实核验不变 |
| `022` Temporal | dev server/UI/SDK 已运行，多个固定 workflow 已落 | 生产拓扑/TLS/auth/namespace、版本兼容、worker deployment/versioning、visibility/retention、backup/DR | replay、幂等 activity、worker 丢失/重启、长时取消、namespace/DR、升级矩阵 | 业务状态继续在我方 DB/Outbox；按 workflow 边界迁移，短任务可由受控 runner 接管，历史可审计 |
| `024` new-api | 开发统一模型/embedding 网关，Compose 为 `latest` | pin digest、AGPL/供应链、密钥域、provider/模型 allowlist、配额/审计、升级/rollback、HA | resolved model/transport、预算/取消/错误矩阵、密钥/日志扫描、SBOM、双版本 route fixture | `ModelGateway` 指向 LiteLLM/其他兼容网关；task route/evidence/cost ledger 不迁入供应商私有真值 |

## 2. 共同 Release Gate

八项都必须满足以下共同门，单项 Card 只能加严：

- **Version**：repo commit、package lock、镜像 digest、配置 schema、迁移版本和 SBOM 可互相追溯；生产禁止滚动 `latest`。
- **License**：根许可、企业目录、依赖、模型/字体/素材/数据/插件和 notices 分开核验；修改和网络服务义务有书面结论。
- **Security**：最小网络面、SSRF/egress、输入隔离、凭据、日志脱敏、RLS/租户、供应链、容量/DoS 和补丁 Owner。
- **Reliability**：超时、取消、重试、幂等、熔断、部分失败、资源回收、升级/回滚与备份/恢复均有可执行证据。
- **Observability**：trace/cost/error 不泄露秘密和个人数据；外部项目 telemetry 默认关闭或显式批准。
- **Exit**：标准导出、删除证明、替代实现 Fixture、DNS/凭据/任务切换、回退窗口和演练日期已记录。
- **Ownership**：开发、Security、Commercial、QA、Ops 的实际 assignee 被接受；责任帽不能代替人员。

## 3. Adapter 与真值规则

```text
SaaS / Domain Service
  -> our Contract + allowed actions + audit
    -> Adapter / Port
      -> external runtime

business SoR, identity, permission, release state, cost/evidence ledger
  -> remain in our controlled stores
```

- Astro/Puck 不拥有 SiteSpec/Release/Publish 授权；
- Docling/Crawl4AI/SearXNG 不拥有 Asset/Knowledge/Company/Claim 事实；
- Temporal 不替代业务状态和 Outbox，new-api 不替代 task route/预算/证据；
- pgvector 是当前主库扩展例外，但业务对象仍由我方 schema、RLS 和 migration 承重；
- 外部 runtime 的 UI、数据库、用户表、角色或任务状态不能直接暴露为 SaaS 产品合同。

## 4. Exit Plan 最低定义

“可替换”不能只写一句接口抽象。每项退出计划至少回答：

1. 哪些配置、数据、任务、产物、日志和凭据要导出/删除；
2. 进行中的任务如何 drain/cancel/replay，双写窗口如何避免双真值；
3. 哪些 ID、版本、事件和错误码必须保持兼容；
4. 替代实现如何用同一 Fixture 比较结果、权限、成本和延迟；
5. 上游不可用、许可变化或供应链事件时的最大退出时限；
6. 谁批准、谁执行、谁独立验证，最后一次演练日期是什么。

没有演练的 Exit Plan 只算设计输入，不算生产证据。

## 5. 当前不启动的硬化工作

Phase 7 只登记上述工作，不改镜像、依赖、系统服务或代码。其优先级仍服从 Site Builder release plan、安全 blocker、实际 assignee 与独立 Gate；不能以“文档已列清”为由插队当前主线。
