# 联系人补强安全首片：正式数据库集成要求

> 私有源码要求记录，未应用。固定输入 f1971170456ecf53dcc211ce4dbc851d2b786e79。
> 生命周期：`IMPLEMENTATION_RECORD`
> 原 E 独占 schema、真实迁移、权限、漂移、G5、CI 与 Copy 正式窗口。

本件不是 SQL、迁移或 PostgreSQL 验收。私有源码当前仅完成金额、计划、快照及准入端口检查点。封口、物理独占、原结果恢复、领域提交、两 caller 和 DSR 尚未交付，不能据此宣称首片完成。

## 两张业务索引，不是新钱账

- `contact_enrichment_execution`：UUID 主键、workspace/company live 关联、entrypoint、真实 business_run_id、原 authority/account/generation、原 request_sha256、独立 admission_request_sha256、稳定 operation_ref、protocol_version=1、plan_sha256、frozen_limits、target_snapshot、status、quality_coverage=PREREQUISITE_ONLY、result_revision 与时间戳。
- frozen_limits 保存原收紧 caps 及准入时已冻结的 admittedAtMs/deadlineAtMs。重试不刷新时间、目标或报价，不在 head 维护 spent/reserved/charged。
- `contact_enrichment_execution_step`：UUID、workspace/execution/contact live 关联、contact_ordinal/slot_ordinal/slot_key、phase/provider/tool_id/tool_version、canonical quote_microusd/pricing_version、depends_on_slot_key、revision、一次封口 input_fingerprint/candidate receipt 绑定、原 operation_key/budget_operation_id、receipt/digest/artifact reference、dispatch_phase/domain_state 与固定 reason。
- 未封口的 input_fingerprint、operation_key、budget_operation_id 必须显式为空。绑定由原真实工具幂等键和 reserve 后的精确原账本 operation 取得，不能从 step ordinal 猜资金键，尤其不能复制 SMTP 哈希算法。
- 所有 micro 字段由原 BIGINT 上界约束。唯一费用事实仍在原 tool_budget_account/tool_budget_operation 及其回执，不产生新钱包、余额或结算函数。

## 准入、不可变与并发

- HTTP 验证和完整业务 preflight 在消费之前。消费使用现 consumeVerifiedWorkspaceGrantInTransaction(authority, tx)，head/steps 用同一 withWorkspace tx 插入。
- binding 不含账户 id/generation/cap。同 tx 按真实 scopeKey/accountKey 读取现已开账户，核 authority、一致 scope、合法 generation 和非空 canonical cap。不能另开连接 attest 未提交账户。
- 锁序沿原 authority-first，再锁 account、execution、step、contact、point。run 沿 ensureRunBudget 的真实 binding/accountKey，不消费第二 Grant。
- head 的 HTTP 与 run 逻辑唯一性采用明确 nullable 语义。相同逻辑身份但 admission_request_sha256 不同是冲突。run 重放读取原计划，不能以新 targets/deadline 覆写。
- execution/slot 唯一，原 budget operation 只能映射一个 step。跨 authority/account/generation/price/receipt 的相同 physical input 仍受同一 pending fence。
- pending fence 至少覆盖 ADMITTED、RESERVED、RESULT_UNKNOWN、SETTLED_WAITING_APPLY。未封口 NULL、FK SET NULL、并发封口与 DSR 均要有真实 SQL 分支，不能依赖普通 UNIQUE 忽略 NULL。
- frozen identity/caps/provider/quote/input binding 不允许普通 UPDATE。revision、允许的窄状态更新、live FK 及受审 redaction 需要精确列权限，不能被全行 immutable trigger 误挡。

## 租户、删除与原协议

- 两表 FORCE RLS，所有 workspace/execution/company/contact/account/operation 关联有 scoped FK。FK SET NULL 不能清 workspace。app_user 没有 DELETE 权限。
- 受审 DSR 清 head target_snapshot 和 step live 关联、个人指纹/候选引用，保留原 ledger 审计、UNKNOWN hold 和 tombstone。不得假退款或把逻辑擦除称为对象物理删净。
- 新 Hunter artifact schema 为 contact-email-find-hunter/v1，PERSONAL_DATA/contact subject，现 encryptPii 密文 body。其六项 HTTP expected facts 全 NULL 的精确 schema 分支必须同时进入原 SQL 校验链，不能泛放未知 schema。
- 正式迁移须精确扩展原 mark_tool_budget_result_unknown_v5、load_tool_budget_result_unknown_artifact_v5、settle_tool_budget_artifact_manifest_with_receipt_v4、apply_execution_domain_ack_v1 等实际约束链。不是只改 TypeScript。
- 三验证 typed schema 及四 producer 的 receipt/subject/consumer/registry 闭合不可省略。SMTP 保原 producer/consumer，不增第二 ACK。
- 当前代 typed 冷读保持原 authority/generation 精确匹配。历史代只在真实 immutable step→原 ledger 绑定被 SQL 证明后使用窄 SELECT，不能把 query 改成当前代或泛化 catch 后重买。

## 必须后置的真实验证

当前状态统一为 NOT_RUN_PRIVATE_SCHEMA_NOT_AUTHORIZED：

- 真实 schema/迁移、漂移、FORCE RLS、scoped FK、不可变/列权限、无 DELETE、NULL/pending indexes。
- app_user 下消费与 head/step 同 rollback，独立客户端跨 account/authority/generation 同 physical input 的并发排斥。
- 原 typed 历史代冷读、artifact/facts/subject/ACK SQL 精确分支、删除与 tombstone。
- 真实迁移 ID 由 Root 在正式窗口预约，当前为空。本私有树没有预约路径、临时 DDL 或伪 PG。

两份 PG/migration spec 明确 deferred，不纳入私有 pure/fake 的 GREEN 分母。单元测试里的 COMMIT_FAKE/ROLLBACK_FAKE 只是端口顺序及失败传播，不是 PostgreSQL 事务证明。正式部署、真实供应商、费用、权限与运行效果均未验收。

## 私有已交付范围（2026-11-22 续）

以下为私有纯/假端口层已实现并有真实 RED/GREEN 回执的源码范围；不是数据库或部署验收。

- 金额（tool-cost-microusd）、冻结计划/目标快照、原始 selector/tier 共用。
- 原 SMTP producer 的属性步门与 step-bound 代理（原幂等键、原输入、不重发）。
- 仓库封口/物理 claim 端口（guard 未装配 HOLD）、原始结果 reader（typed-only 冷读 + finder readVerified）、显式恢复（仅原 reservation/quote/subject）。
- 领域提交控制流（原写入器 + 四 producer 消费绑定、SMTP 保留原 consumer）、DSR freeze 同事务 redact（保留预算审计与 UNKNOWN hold）。
- 持久执行头/步骤只读查询（参数化 SELECT，含原 plan hash/deadline 与历史代事实）。
- 共享 service（HTTP verify→preflight→原子准入；run 复用原 binding；GET 纯读；POST 恢复无 Grant/无 wire）、普通活动内 helper、结果 metadata DTO 与 code-first 控制器/OpenAPI 生成（隔离合成模块，未监听端口）。
- 原生池 preflight 组合（原 provider 构造/门/retention、完整潜在报价守帽），零供应商调用。

## 仍未闭合（正式集成必需）

- HTTP/run 生产模块到 safety service 的运行时装配与完整执行闭包（当前为端口与纯控制流层；未装配即 HOLD）。
- 具体 SQL 存储适配器（domain commit store、loadTrustedInput、guards）与真实数据库执行。
- `durable-result-strategies.json` 的 artifact schema/工具/callsite 期望清单扩展：治理脚本硬编码 4 schema、23 tool ids 与动态调用边界清单，脚本不在私有 79 路径，需原 E 同步脚本与清单；broker/factory 指纹已按审查重钉。
- `packages/contracts/openapi/openapi.json` 快照由原 E 在正式窗口 code-first 重新生成。
- 两个 PG/migration 套件与 app_user/RLS/迁移/漂移/并发/DELETE 权限的真实实证。
