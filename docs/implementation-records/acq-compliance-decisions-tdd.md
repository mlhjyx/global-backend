# 获客 Suppression / DataRights 收口 TDD 记录

> 日期：2026-08-10
> 范围：append-only suppression decision、DataRights DENY 审计、类型化 canonicalizer、动作终极闸、逐物理外部调用授权、投影物化线性化、OpenAPI 错误合同。
> 边界：本记录只证明 source/deterministic/隔离测试结果；没有部署、服务重启、真实试点数据、付费调用、fresh RuntimeEvidence 或 Release Bundle。真实试点继续 `NO-GO`。

## 一、不变量

1. `suppression_record` 是禁联事实，普通 app role 不可 DELETE；LEGAL 不可降级或由普通 API 释放。
2. release/correction 为 append-only decision；原始 requested command 与裁决 outcome 分开持久化，幂等键绑定原始 payload。
3. email/domain/company-name 在写入与消费边界使用同一 canonicalizer；legacy 值不静默失配。
4. fit、enrich、signal、watch、contact、guess 六个自动阶段在每家模型/provider/网络动作前复读公司级 suppression；进入 provider 后，每个可观察的 Tool、模型、HTTP redirect、retry/page、DNS→SMTP 与 DNS→Crawl4AI dispatch 物理边界继续复核，拒绝/异常均 terminal。
5. suppression 创建与 canonical/tenant/signal 投影物化、联系人/猜测写入、验证回写、Lead accept、Art.17 freeze/erase 共享 workspace transaction advisory lock；任一后到动作必须看到先提交的 suppression，锁序固定为 advisory→事实读取→行锁/写入。
6. 被禁 email/contact_key/domain 的联系人不进 `LeadQualifiedPackage`；剩余可达点为零时 accept fail-closed。
7. 付费模型在首个 wire 前被 suppression 拒绝时，reservation 以 `RELEASED/not_incurred/callCount=0` 收口且不冻结；若首调已发生、repair 前被拒绝，已发生 usage/settlement 必须照实结算。
8. workspace-specific robots denial 不得写入跨 workspace 共享 origin cache；普通 robots/egress 结果仍按既有 TTL 语义缓存。

## 二、RED → GREEN 证据

| Cycle                       | RED        | GREEN      | 关闭的缺口                                                                             |
| --------------------------- | ---------- | ---------- | -------------------------------------------------------------------------------------- |
| command identity            | `6c005186` | `24ee0f8c` | LEGAL release 的不同原始 reason 不再被同一 denial outcome 折叠                         |
| backlog + commit-side email | `c8ef60b9` | `5db15fac` | legacy company suppression 不再绕过自动阶段；长网络后新邮箱 suppression 不再落库       |
| Lead handoff                | `24b74f8e` | `4facf15e` | 被禁 contact ref 从快照排除，零剩余 Reachability 阻断交付                              |
| OpenAPI errors              | `42843869` | `136534ca` | suppression 操作的 400/404/409 envelope 和 UUID path 进入机器合同                      |
| linearization               | `c8b0153b` | `2ba9b395` | suppression 创建与结果提交共享 DB 线性化点；SMTP 期间新 suppression 将回写降为 BLOCKED |
| invalid provider email      | `b10a35ad` | `1beaccd9` | 非法 adapter email fail-closed，不只静默丢邮箱后仍物化具名人                           |
| action linearization        | `08272478` | `2eb830f4` | DSR writer、forward/backlog、contact/guess/verify/Lead 统一 advisory→row-lock 顺序     |
| per-candidate / OpenAPI     | `f0a8555b` | `2eb830f4` | 每个 SMTP candidate 前复核；Lead/suppression 实际错误码与 OpenAPI 闭合                 |
| provider/model wire         | `e83e48fe` | `2eb830f4` | ToolBroker、Router、provider context 与模型 repair 传播 terminal callback              |
| direct egress               | `d22503b4` | `2eb830f4` | robots、DNS、guarded HTTP redirect、direct provider 出网使用同一 callback               |
| provider propagation       | `0605e2a0` | `2eb830f4` | Companies House、INPI、Google Patents 等注册 provider 不再丢失 ExecutionContext         |
| SMTP internal wire         | `ab2a381a` | `2eb830f4` | MX-host DNS 与 SMTP connect 分别复核，DNS 后提交 suppression 不再继续 RCPT probe       |
| projection + adapters      | `4afa0adb` | `2eb830f4` | TenantProjection 同时拦 exact email 与邮箱域；adapter 内部请求 callback 可注入          |
| multi-wire inventory       | `8a7c4b82` | `2eb830f4` | GLEIF/TED/FDA/CH/INPI/OSM/Algolia/Wikidata/BigQuery 可观察 retry/page/fallback 逐次复核 |
| canonical materialization  | `a3c6201b` | `2eb830f4` | canonicalizeRun 与 suppression writer 共享线性化点                                     |
| robots cache isolation     | `22948f04` | `2eb830f4` | workspace denial 只对本次请求 fail-closed，不污染共享 robots cache                      |
| paid model settlement      | `7072d3f7` | `2eb830f4` | 首 wire 前 denial 零费用释放；repair denial 结算首调且不 fallback/freeze                |
| Crawl4AI dispatch          | `a9f61b8c` | `2eb830f4` | 目标解析前及本地 crawler POST 前分别复核                                                |
| signal materialization     | `fc7de224` | `2eb830f4` | TED/openFDA/SAM 投影在 canonical 读写前锁定并复核 append-only company suppression       |

## 三、最终本地验证

| 门                | 结果                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 聚焦 Vitest       | 最终 20 files / 234 tests PASS，覆盖 Tool/Router、HTTP/robots/Crawl4AI/SMTP、provider retry/page、projection/materialization、contact/guess/Lead、OpenAPI 与 paid settlement                                        |
| API 全量 Vitest   | 304 files PASS；4578 passed / 2 skipped                                                                                                                                                                            |
| API lint / build  | lint 0 errors、7 个既有 warnings；Nest build PASS                                                                                                                                                                  |
| OpenAPI           | development + loopback + 显式 dev token 开关下重新导出 60 paths；提交 artifact 无额外 drift；Spectral 0 errors、15 个既有 tag warnings                                                                             |
| 文档与治理        | governance 60/60 PASS；`docs:verify` 检查 121 Markdown，0 errors、1 个既有 table warning                                                                                                                           |
| PostgreSQL 16     | 前一 GREEN `017f0d9f` 的隔离无卷临时库证据：82/82 migrations PASS；`app_user` 非 superuser/non-BYPASSRLS；RLS/append-only/CHECK/LEGAL 防降级均 fail-closed。本轮新增 projection/wire 路径未重跑真实 PG，不把 mock 当并发证明 |
| 并发排序          | 前一 GREEN 已证明 advisory lock 的 A/B 会话阻塞/提交后重获；本轮新接入 DSR/materialization 路径只有行为/拓扑测试，真实 PostgreSQL 多路径并发仍是独立门                                                              |
| Copy fixed source | Copy impact + CI topology 20/20 tests PASS；实际 classifier 仅返回 schema-only `STALE_HOLD`，`dispatch_authorization=NOT_AUTHORIZED`、`pilot_eligibility=BLOCKED`                                                 |

临时 PostgreSQL 容器以 `--rm` 启动，验证结束后已停止并删除，未创建卷。这里没有 destructive down migration：append-only 合规事实不应通过普通回滚脚本抹除；生产回退必须在后续发布门中以发布前备份/隔离恢复演练或审查过的 forward fix 证明。

可观察的应用内 retry/page/redirect 已逐 wire 复核；第三方 BigQuery SDK 自身的透明内部重试仍不可由应用 callback 逐次观测，必须在未来 transport wrapper/SDK 配置治理中单列，不能把当前 gate 解释为对 SDK 内部所有 socket 的证明。平台级、尚未绑定租户/company subject 的 ingest 也不能伪造 workspace suppression 身份。

以上均为 source/deterministic/既有隔离数据库证据。Hosted GitHub checks、最终 exact-head 独立 correctness/security 复审、真实 PostgreSQL 新路径并发、合并授权、部署回读、真实 JWT、RuntimeEvidence、Release Bundle 与受控真实试点仍是分离门。
