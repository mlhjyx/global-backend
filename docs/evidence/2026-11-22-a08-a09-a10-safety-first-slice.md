# A08/A09/A10 联系人补强安全首片（私有候选，非正式集成）

> 私有源码贡献记录。固定源 `f1971170456ecf53dcc211ce4dbc851d2b786e79`。
> 两个 PG/migration 套件、真实迁移、RLS、app_user、CI/Copy 与部署验收均为 NOT_RUN，由原 E 正式窗口闭合。

## 已交付（私有纯/假端口层）

- 金额：canonical microusd 精确（1780/1700µ），显式新 micro 非法即拒，旧 cents 路径不变；SMTP 沿用原工具幂等键与 0 成本，四 producer 的 receipt/schema 闭合。
- 计划：完整潜在 slot 加总守 contact/company/authority 更紧帽；目标快照 ≤10/≤100/≤65536；unsupported 可达 provider 整次 governance_pending、0 wire。
- 准入：HTTP verify→preflight→同 tx consume+head/steps；run 复用原 ensureRunBudget binding、不消费第二 Grant；最小 lawful-basis kind/tier 与 targetCount 冻结进 frozen_limits。
- 执行：原 BudgetStore reserve 后 beforePhysicalWire 再核当前身份/价格/政策并 CAS claim；网络在 tx 外；未知/丢 ACK 不重 wire、不成本归零换供应商。
- 原结果：typed-only 冷读精确 scope/authority/account/generation/key/schema；finder 走原 artifact readVerified；显式恢复仅用原 reservation/quote/subject 协议；GET 永不恢复。
- 领域：point/event/attempt/step/ACK 同一事务端口；原写入器与四 producer 消费绑定；INVALID 保持原停止语义；SMTP 保持原 producer/consumer，不增第二 ACK。
- 读面：GET 列表/详情固定 page10 keyset、同 workspace/company 404 统一；输出仅 PREREQUISITE_ONLY 元数据、原 ledger micro 与 basis；未证明质量指标为 null+unavailableMetrics；无 PII/对象键/完整 receipt。
- DSR：在既有 freeze 同事务内清 head target_snapshot 与 step live 关联；保留原预算审计、UNKNOWN hold 与 tombstone；不宣称对象物理删除。
- 回归：selectors/caches/SMTP 票矩阵/旧四 artifact/旧 Broker 语义保持；SMTP 评分、最后成功票 provider 与原 INVALID 分支按原实现恢复。

## 未完成（必须在正式集成前关闭）

- HTTP/run 两 caller 到 safety service 的运行时装配与完整执行闭包（当前为端口与纯控制流层）。
- 具体 SQL 适配器（registry/DSR/head-step SELECT 均已有参数化源码，但未在真实库执行）。
- `docs/governance/durable-result-strategies.json` 的 artifact schema/脚本期望清单与新 producer 登记（脚本硬编码 4 schema、23 tool ids、callsite 边界），需原 E 同步脚本+清单；broker/factory 指纹已按实审查重钉。
- `packages/contracts/openapi/openapi.json` 快照未更新（应由原 E code-first 重新生成）。
- 两个 PG 套件与真实 app_user/迁移/漂移/FORCE RLS/并发/DELETE 权限。


## 2026-11-23 私有更新（不重写上方历史）

- 上方「未完成」中三项已在本私有候选 v3/v4 阶段关闭（仍为私有纯/假端口证据）：
  - HTTP/run 两 caller 到 safety service 的运行时装配与完整 execute 闭包已落地；定向套件以真实 RED→GREEN 覆盖原子准入、seal→beforePhysicalWire→persist、ACK 丢失不重放。
  - 治理登记已按两文件追加许可闭合：27 tool ids / 5 artifact schema / 4 非工具 invoke 边界，脚本与清单同步。
  - code-first 快照：由真实 `AppModule` 在 Nest `preview:true` 下离线导出（未 init/listen/close），生成 161 paths 文档 `2739c39ab5a1767c76712ea18f254dac34d672d6f3441752de09ec5b1b8fb627`，并已逐字复制到 `packages/contracts/openapi/openapi.json`；原 158 paths 与 `components.schemas` 未删改，三条结果路由 GET/GET/POST 存在。该导出仅为元数据证据，不是 HTTP/SQL/运行验收。
- 仍未关闭：真实 schema/迁移/SQL/PG/RLS/app_user、正式集成/CI/Copy 与部署；两个 PG 套件仍 `NOT_RUN`。
