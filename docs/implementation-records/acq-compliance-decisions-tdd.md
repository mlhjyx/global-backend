# 获客 Suppression / DataRights 收口 TDD 记录

> 日期：2026-08-10
> 范围：append-only suppression decision、DataRights DENY 审计、类型化 canonicalizer、动作终极闸、OpenAPI 错误合同。
> 边界：本记录只证明 source/deterministic/隔离测试结果；没有部署、服务重启、真实试点数据、付费调用、fresh RuntimeEvidence 或 Release Bundle。真实试点继续 `NO-GO`。

## 一、不变量

1. `suppression_record` 是禁联事实，普通 app role 不可 DELETE；LEGAL 不可降级或由普通 API 释放。
2. release/correction 为 append-only decision；原始 requested command 与裁决 outcome 分开持久化，幂等键绑定原始 payload。
3. email/domain/company-name 在写入与消费边界使用同一 canonicalizer；legacy 值不静默失配。
4. fit、enrich、signal、watch、contact、guess 六个自动阶段在每家模型/provider/网络动作前复读公司级 suppression。
5. suppression 创建与联系人/猜测写入、验证回写、Lead accept 共享 workspace transaction advisory lock；任一后到动作必须看到先提交的 suppression。
6. 被禁邮箱的联系人不进 `LeadQualifiedPackage`；剩余可达点为零时 accept fail-closed。

## 二、RED → GREEN 证据

| Cycle                       | RED        | GREEN      | 关闭的缺口                                                                             |
| --------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------- |
| command identity            | `6c005186` | `24ee0f8c` | LEGAL release 的不同原始 reason 不再被同一 denial outcome 折叠                         |
| backlog + commit-side email | `c8ef60b9` | `5db15fac` | legacy company suppression 不再绕过自动阶段；长网络后新邮箱 suppression 不再落库       |
| Lead handoff                | `24b74f8e` | `4facf15e` | 被禁 contact ref 从快照排除，零剩余 Reachability 阻断交付                              |
| OpenAPI errors              | `42843869` | `136534ca` | suppression 操作的 400/404/409 envelope 和 UUID path 进入机器合同                      |
| linearization               | `c8b0153b` | `2ba9b395` | suppression 创建与结果提交共享 DB 线性化点；SMTP 期间新 suppression 将回写降为 BLOCKED |
| invalid provider email      | `b10a35ad` | `1beaccd9` | 非法 adapter email fail-closed，不只静默丢邮箱后仍物化具名人                           |

## 三、最终本地验证

| 门                | 结果                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 聚焦 Vitest       | 5 files / 84 tests PASS，覆盖 suppression governance/value/migration、company terminal gate、contact/guess persistence、backlog、LeadQualified/DataRights                                                          |
| API 全量 Vitest   | 298 files PASS；4534 passed / 2 skipped                                                                                                                                                                            |
| API lint / build  | lint 0 errors、7 个既有 warnings；Nest build PASS                                                                                                                                                                  |
| OpenAPI           | development + loopback + 显式 dev token 开关下重新导出 60 paths；提交 artifact 无额外 drift；Spectral 0 errors、15 个既有 tag warnings                                                                             |
| 文档与治理        | governance 60/60 PASS；`docs:verify` 检查 121 Markdown，0 errors、1 个既有 table warning                                                                                                                           |
| PostgreSQL 16     | 隔离无卷临时库 82/82 migrations PASS；`app_user` 为 non-superuser/non-BYPASSRLS；RLS 跨 workspace 负例、Suppression DELETE、Decision UPDATE/DELETE、requested/outcome CHECK、LEGAL 防降级/事实防改写均 fail-closed |
| 并发排序          | 会话 A 持有 workspace suppression advisory lock 时，会话 B 在 500 ms statement timeout 内不能取得；A 提交后 B 成功重获                                                                                             |
| Copy fixed source | 8/8 tests PASS；实际 classifier 仅返回 schema-only `STALE_HOLD`，`dispatch_authorization=NOT_AUTHORIZED`、`pilot_eligibility=BLOCKED`                                                                              |

临时 PostgreSQL 容器以 `--rm` 启动，验证结束后已停止并删除，未创建卷。这里没有 destructive down migration：append-only 合规事实不应通过普通回滚脚本抹除；生产回退必须在后续发布门中以发布前备份/隔离恢复演练或审查过的 forward fix 证明。

以上均为 source/deterministic/隔离数据库证据。Hosted GitHub checks、独立 correctness/security 复审、合并授权、部署回读、真实 JWT、RuntimeEvidence、Release Bundle 与受控真实试点仍是分离门。
