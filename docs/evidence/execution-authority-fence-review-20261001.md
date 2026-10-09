# 执行授权物理接线围栏复核

> 生命周期：`REFERENCE_ONLY`
> 依据：2026-10-01 对 `docs/governance/durable-result-strategies.json` 中 `physicalExecutionWiring.protectedFiles` 四个受保护文件，自最后一次指纹匹配以来全部改动的逐提交静态复核，及 2026-10-06 在当时 main 上的复查与独立复审（见文末）；本记录不代表 CI、运行、发布或用户验收通过。

## 背景

`scripts/execution-authority-policy.mjs` 用 sha256 锁定 Router/ToolBroker 组合的四个文件，任何改动都要先复核、再更新指纹。该检查此前没有任何 runner 执行，因此漂移一直无人察觉：

- `apps/api/src/model-gateway/router-model-gateway.ts` 的指纹最后一次匹配是 `b8dd5eb0`（2026-08-24），自 `d5e4bc42`（2026-08-26）起不再匹配；
- `apps/api/src/tools/tool-broker.ts` 与 `apps/api/src/tools/tool-broker.factory.ts` 同样在 9-02 至 9-25 间被修改，`14f79cbc`（#565）在提交说明未提及的情况下把这两个指纹更新到了当时的内容；
- `apps/api/src/model-gateway/model-gateway.module.ts` 自锁定以来没有改动。

## 方法

对每个受保护文件，取 `b8dd5eb0` 版本与当前 main 版本，先用仓库的 prettier 规范化两边，再逐段比对语义差异（#441 的大部分改动是引号与换行格式化，规范化后只剩 7 行语义差异）。检查重点：是否删除或绕过授权、预算预留与结算、持久回执、出网围栏、外部动作授权或禁联门；是否新增不经 ToolBroker / ModelGateway 的物理调用路径；费用或调用状态未知时是否仍保守处理（不释放预留、不自动发第二次物理请求）。

## `router-model-gateway.ts`（`b8dd5eb0` → 当前，+803/−180 行）

| 提交 | 改动 | 结论 |
|---|---|---|
| `d5e4bc42`（08-26） | 结构化输出的预留倍数由写死的 `2` 改为 `MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND`，该常量值为 `2` | 语义不变 |
| `da2f7aeb`（#441，09-02） | 格式化；失败时若计量依据为 `unknown`，结算状态记为 `UNKNOWN` 而非 `FAILED` | 更保守 |
| `a4f216d9`（#449，09-05） | 每次物理调用前分配持久的物理调用身份；修复重试的身份分配失败时按「只发生一次物理调用」报错、绝不发第二次；付费调用必须具备成本对账目录、结算派生密钥与回读解析器，缺任一项拒绝；必须给出输出 token 上限；预留绑定定价快照与调用上限；只有网关回读已结算、载荷可用且上游确认已知时才记为已结算，其余一律 `unknown`，账本写入失败记为 `database_ack_unknown`；模型身份必须与请求一致；「调用进行中」错误转为费用未知并保留预留；trace 只记录安全错误码；结算写库失败只做一次数据库幂等重试 | 新增 fail-closed 控制；零调用释放预留由数据库函数 `finalize_site_build_provider_wire_not_dispatched_v1` 在行锁下限定为状态恰为 `ALLOCATED` 的物理调用 |
| `379b4514`（09-05） | 调用链入口断言平台出网围栏可用 | 更严格 |
| `0c8158ec`（09-07） | 平台出网时物理调用经 `platformEgress.authorizeAndDispatch` 授权；客户侧路径不变 | 更严格 |
| `7c87ea80`（09-08） | 入口断言平台出网付费上下文；预留后校验平台出网预留；出网操作绑定预算操作键与预留 | 更严格 |

## `tool-broker.ts` 与 `tool-broker.factory.ts`（`b8dd5eb0` → `14f79cbc`）

| 提交 | 改动 | 结论 |
|---|---|---|
| `da2f7aeb`、`379b4514`、`0c8158ec`、`7c87ea80`（只改 `tool-broker.ts`） | 入口断言平台出网付费上下文与围栏；平台物理调用经调度器授权，工具在传输失败后自行伪造回退结果也判失败；已开始平台物理调用后的禁联拒绝不再按零调用释放；付费调用出错按 `UNKNOWN` 结算并停用后续付费调用 | 更严格 |
| `14f79cbc`（#565，09-25） | 个人数据产物由「一律拦截」改为「按调用准入」：必须提供存活的工作区主体并通过 RLS 准入，权利请求在执行前最后一刻判定，平台级制裁名单仍一律拦截；factory 仅在具备 Prisma 与存储配置时接入产物执行端口，否则相关调用保持拦截 | 唯一的放宽，属已批准的 G3 5.1 设计（规格 2026-09-24 §4.1），清单 `artifactPhysicalExecution.status` 同步为 `PER_CALL_SUBJECT_BINDING`，`scripts/execution-authority-policy.spec.mjs` 已有对应用例 |

## 结论

六个改动 Router 的提交与五个改动 ToolBroker 的提交，要么语义不变，要么新增 fail-closed 控制；唯一放宽的是已批准设计内、带 RLS 准入的按调用主体绑定。没有删除授权、预算、回执或出网检查，也没有新增绕过 ToolBroker / ModelGateway 的物理调用路径。据此可把 `router-model-gateway.ts` 的指纹更新为当前内容（sha256 `446e5771db74872d29c845086e5ec81e628d24d4db608f108581289b1105b324`），并确认 #565 对 ToolBroker 两个文件的指纹更新。

## 同时修复的检查脚本过时

其余 24 项失败不是代码违规，而是检查脚本跟不上重构：

- 10 项：模型投影表在 #449 中被格式化为双引号，脚本只按单引号字面串匹配；
- 11 项：五个平台 Tool 改为经 `platformExecutionToolContract("<id>")` 声明 id、schema 与产物上限，脚本只认字面 `id: "<id>"`；
- 1 项：专利计费上限常量改为指向平台合同的别名；
- 2 项：#578 新增的 `discovery.classify_trade_role` 未登记进期望清单，且它以常量调用 `getTask(WEBSITE_PROFILE_TASK)`，脚本只认字面量调用，导致源码清单检查漏掉了这个新任务。

脚本现按合同解析这些间接引用、以引号无关的方式匹配映射，并把同文件大写字符串常量的 `getTask` 调用计入清单；无法解析的大写常量参数直接报错。

## 2026-10-06 复查与独立复审

本节记录在 main `49dfd9f1` 上的复查，以及在此基础上把该 spec 接回 required 门之前做的独立复审。

- **受保护文件没有再改**：`ac024fd5..49dfd9f1` 之间没有提交改动四个受保护文件，也没有改动策略检查读取的平台执行合同、模型投影表、`source-tools.ts`、`website-profile.provider.ts` 和两份治理清单。`router-model-gateway.ts` 的 sha256 仍是 `446e5771…`；`b8dd5eb0` 版本正好对应旧指纹 `5cb68799…`。
- **问题清单没有变化**：用 main 上未修正的脚本跑当前源码，仍是上文所列的 25 项，没有新增。
- **独立复审**：另一位复审者（独立的代理会话，只读）对照实际 diff 逐行核对了上面两张表，结论全部成立，支持更新 Router 指纹。逐行确认的要点：
  - `MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND` 在 d5e4bc42 和当前 main 上都是 `2 as const`；
  - 用 prettier 规范化之后，#441 只剩一处代码改动，即 `UNKNOWN`/`FAILED` 的判定；
  - 修复重试的准备失败时，按 `callCount: 1` 报错，不再发第二次调用；
  - 「调用进行中」错误不结算，保留预留；
  - 零调用释放由 `finalize_site_build_provider_wire_not_dispatched_v1` 限定为状态恰为 `ALLOCATED` 的物理调用，而 `begin_…_v1` 在 `fetch` 之前就把状态推进为 `DISPATCH_STARTED`；
  - 客户侧路径仍直接调用 provider；
  - #565 的工作区主体在重放前和限流之后、`execute` 之前各校验一次，产物持久化失败时不释放预留。
- **勘误**：`tool-broker.factory.ts` 自 `b8dd5eb0` 以来只被 `14f79cbc` 改过，上表已注明前四个提交只改 `tool-broker.ts`。
- **复审另外指出的三点，均不阻止更新指纹，记为后续事项**：
  1. 低。`a4f216d9`（#449）之后，`settlePersistentOperation` 把 `REPLAY` 当作成功，首次结算也是如此。注释说 SQL 只在「同一终态行」时返回 `REPLAY`，但实际上，只要行已不是 `RESERVED`，`settle_site_build_spend` 就返回 `REPLAY`（`20260816220000_production_parity_budget_runtime/migration.sql`，已核对）。这不会造成预算泄漏，也不会多发一次调用：`reconcile_site_build_spend` 跳过带物理调用的支出，结算守卫触发器会校验物理调用事实。剩下的窄风险是：如果恢复任务先结算了这一行，网关可能返回一份与持久记录不一致的结果。应当修正注释或收紧判定。改 Router 就要重新复核并更新指纹，所以不在本次做。
  2. 提示。7c87ea80 之后，平台侧工具的出网授权按每次物理调用执行，前提是工具经 `ctx.dispatchPhysicalWire` 发出请求。因此围栏不再完全落在这四个钉住的文件里。`source-tools.ts` 的 `sourcePhysicalWire` 在缺少调度器时会直接拒绝，四个合同内的工具都走它，合同外的工具拿不到调度器；但 ToolBroker 并不核验工具是否真的经调度器发出了请求。可考虑把 `source-tools.ts` 与相关 adapter 也纳入指纹。
  3. 低，`b8dd5eb0` 时就已存在。客户侧工具如果在执行中途抛出 `ExternalToolActionDeniedError`，预留仍按零调用释放；在此之前可能已经发生的只有 robots.txt 抓取或 DNS 查询（例如 `crawl4ai.render` 和 SMTP 探测之前的那一步）。

据此，在本次 PR 中把 `router-model-gateway.ts` 的指纹更新为 `446e5771db74872d29c845086e5ec81e628d24d4db608f108581289b1105b324`，并把 `scripts/execution-authority-policy.spec.mjs` 移出 `MANUAL_SPECS`，接入 `governance-contracts.spec.mjs`。

## 2026-10-06 Router 改动复核（结算 REPLAY 判定）

本节对应上文后续事项 1，处理它需要修改 `router-model-gateway.ts`，所以按围栏规则先复核、再更新指纹。

- **改动**：只改 `settlePersistentOperation`，加两条分支，均走既有的 `freezeUnknownSettlement`（停用该 BuildRun 的付费调用，抛 `PaidOperationUnknownError`）：
  - 首次结算就返回 `REPLAY` 时，说明行已被其他写入方（即 provider-spend 恢复任务）结算。本次的输出不是持久记录，因此冻结并报 `SETTLEMENT_REPLAY`；失败与零调用释放路径同样冻结，与 `STALE_FENCE` 的处理一致。
  - 唯一一次 ACK 重试返回 `REPLAY` 时，要先由新增的 `SiteBuildCostLedger.confirmSettlementReplay` 回读该行，确认 status、fence、计费依据、调用次数、结果、meta 与错误码都正是本次写入的内容，才按原逻辑接受；不一致或读不到就冻结，报 `SETTLEMENT_REPLAY_UNCONFIRMED`。
- **没有放宽任何约束**：没有删除授权、预算预留与结算、持久回执、出网或禁联检查，也没有新增物理调用路径，失败只会更保守。`confirmSettlementReplay` 是只读查询，走的数据库、角色与 RLS 都与 `completeProviderSpendReconciliation` 相同（provider-wire 角色属于 `app_user`，后者对 `site_build_spend` 有 SELECT 权限，见 `20260816220000` 迁移第 883 行）。ToolBroker 本来就把 `SETTLED` 以外的结算结果都当作未知处理，本次不改动它。
- **独立复审**（只读代理）：没有 CRITICAL 或 HIGH 级问题。
  - MEDIUM 一项已修复：恢复任务以该行自身的 fence 结算，而触发器 `guard_site_build_provider_spend_settlement_v1` 对任何写入方都把 `call_count` 固定为物理调用数，所以仅比较这些字段，区分不出恢复任务写的 FAILED / RELEASED / UNKNOWN 行。现在一并比较 meta 与错误码：恢复任务的 meta 带 `site-build-provider-spend-ack-recovery/v1`，错误码也不同；超出预留的结算记为 `CAP_VARIANCE`，也已计入比较。
  - LOW 一项按设计保留：首次 `REPLAY` 在不返回输出的路径上也会冻结整个 BuildRun，此时调用方拿到的是 `PaidOperationUnknownError`，而不是原始的 provider 错误。
  - 复审没有发现依赖旧行为的调用方：Temporal 重试经 `reserveModelOperation` 重放终态行，不会再次结算。
- **未覆盖**：没有用真实 PostgreSQL 做往返验证。`router-model-gateway.postgres.spec.ts` 会在库里留下夹具且不清理，所以没有对共用的 `global_dev` 运行。jsonb 规范化、Prisma 的 Json 解析与触发器的行为只做了静态核对，并用单测模拟。
- **结论**：更新 `router-model-gateway.ts` 指纹为 `0ad768f0edf1e1ef5160db6c58025c711def8fcde69b2b3db73bd6c1cd178198`。

## 2026-10-08 Router 改动复核（模型失败原因码与可恢复分类）

起因：xin 上一次发现 run 因为一次 11 token 的非 JSON 归一回答整体失败。`isExecutionControlError` 把所有 `ProviderOutputError` 判成控制错误，发现流程里「单家失败不影响其余」的退路因此一处都没生效。修复的主体在 `execution-control-error.ts` 与 `provider-output-error.ts`，不在本围栏内。Router 只做了下面几处配套改动，按围栏规则先复核、再更新指纹。

- **改动**：
  - 修复路径上四处已有的抛错补了 `reasonCode`：修复被抑制、修复准备失败、修复调用失败、修复后仍不合 schema。
  - 其中「首次结算未定所以禁止修复」与「修复准备失败」两处，改抛 `ProviderOutputUnresolvedError`。它是 `ProviderOutputError` 的子类，但没有登记为可恢复，所以仍被判为控制错误。准备失败的那一处现在带上 `cause`，不再丢掉原错误。
  - 「修复调用失败」的外层包装按修复错误本身选类：修复又回了不能用的答案（可恢复的模型失败），仍是可恢复的 `ProviderOutputError`；网络失败、传输失败等其他情况，修复的结果未知，改抛 `ProviderOutputUnresolvedError`。判断用 `provider-output-error.ts` 导出的 `isRecoverableModelFailure`，Router 仍然不直接引入共享判定（静态规格要求它作为例外边界的消费方不引入）。
  - 通用 trace 的 `errorMessage` 对 `ProviderOutputError` 记 `类名:原因码`，其余错误仍记类名。
- **没有放宽任何约束**：
  - 授权检查（`assertExternalActionAuthorized`）、预算预留与结算、持久回执与重放投影、出网围栏、物理调用的分配与计数都没有改动。
  - 失败结算仍按 `err instanceof ProviderOutputError` 分支计费，子类走同一分支，金额不变。
  - 付费路径的 `safeProviderErrorCode` 仍返回 `PROVIDER_OUTPUT_ERROR`。
  - 没有新增物理调用路径。
  - trace 只多了原因码。原因码只能是大写代码：显式给定的必须通过 `^[A-Z][A-Z0-9_]{2,63}$`，推导的只取消息开头的代码，不会带进模型文本。
- **围栏外的配套改动**：
  - `ProviderOutputError` 与 `TaskOutputValidationError` 登记为「可恢复的模型失败」，有确定性退路的调用方可以吸收。
  - 判定只认实例的直接原型。未登记的子类，以及自身 `code`/`type`/`name` 带控制标记的实例，一律仍按控制错误处理；字段只按数据属性读取，`cause` 链照常追查。
  - 传输失败（流不可读、被截断、格式错误、上游错误事件、响应体不是 JSON）改抛未登记的 `ProviderTransportError`，与非流式下的 HTTP 错误一样失败即停。
  - 身份不符、结算未知的 `ProviderSettlementError`、合规拦截保持控制错误。付费路径上的普通 `ProviderOutputError` 即使用量里带着未知的网关结算，现在也算可恢复；付费路径只有建站在用，它不用 `isExecutionControlError` 做退路，所以行为不变。
- **独立复审**（只读代理）：
  - 第一轮：HIGH 一项是本指纹，即本节；另有 MEDIUM 五项、LOW 一项。
    - 传输失败被当作可恢复：已改为 `ProviderTransportError`。
    - 标记可被继承、并且跳过了控制标记检查：已改为按类显式登记，并在已登记的实例上照查控制标记。
    - 修复被抑制、修复准备失败被当作可恢复：已改为 `ProviderOutputUnresolvedError`，并补上 `cause`。
    - 两个子类缺原因码：已补。
    - 吸收失败后，若活动因别的原因重试，重放那次已结算的调用仍会被拒；被吸收的官网画像分类失败会写入一份没有贸易角色的画像，30 天内不重新画像。这两项列为后续事项，因为它们不比改动前更差：改动前同样的失败会让整个 run 直接失败。
  - 第二轮：没有 CRITICAL 或 HIGH，第一轮五项都核实已修；`bundleWorkflowCode` 能打包，工作流里的分类不变。新提出 MEDIUM 两项、LOW 四项，处理如下。
    - `finish_reason` 与 Responses 的 `status` 把整批失败（如 DeepSeek 的 `insufficient_system_resource`、`failed`）也当成单次回答不能用：现在只有 `content_filter`、工具调用与 `incomplete` 可恢复，各有原因码，其余报 `ProviderTransportError`。
    - 被吸收的失败到不了 run 状态，所有 Fit 判定都失败时 run 仍会 DONE：`qualifyFitForRun` 统计 `unjudged`，大于零时 run 至少 PARTIAL；官网画像统计 `unclassified`，只进 stats。
    - 200 响应体带 `error` 或没有 `choices` 被当成空回答：现在报 `ProviderTransportError`（`CHAT_COMPLETIONS_BODY_INVALID`）。
    - 修复调用遇到网络失败会被外层包装成可恢复：已按上文选类。
    - 登记入口不受限制：拒绝 `Error` 与内置错误类，并有测试限定只有 `provider-output-error.ts` 登记、且只有两个类。
    - 活动边界上丢失控制属性（Temporal 只保留类名）是改动前就有的问题，记为后续事项。
  - 第三轮：没有 CRITICAL 或 HIGH；全量 API 单测 8,970 项通过，指纹与执行授权策略检查都核过。提出 MEDIUM 两项、LOW 三项。
    - 「一家都没判出来则 FAILED」按活动的单次尝试计数：重试时已有结论的公司不再重判，可能把已有 9 家结论的 run 判成 FAILED，结论也就不进评分。已改为只降到 PARTIAL，FAILED 仍只由查询全部失败决定。
    - Fit 阶段遇传输失败时，工作流没有兜底，run 停在 RUNNING。这是已登记的 BI-25；改动前所有模型失败都会这样，现在只剩传输类，另开后续任务。
    - 登记防护漏了宿主错误类：已补 `DOMException` 与 WebAssembly 错误类（在工作流沙箱里按需查找）；扫描测试改为限定只有两个文件提到该函数，并容忍换行与尾逗号。
    - `"error": null` 会被当成错误：已改为 `!= null`（响应体与流事件两处）。
    - 修复调用会把 `ProviderWireInFlightError` 包起来，付费路径因此认不出、仍去结算别的 worker 正在用的调用。这是改动前就有的问题，只在建站付费路径；修它要改结算语义，另开后续任务，本次 Router 不再改动。
  - 没有发现合规绕过：`ExternalActionDeniedError` 仍是控制错误，修复路径照旧直接抛出。
- **结论**：更新 `router-model-gateway.ts` 指纹为 `c9fc50b3fb17090441cc36e535f78643371a1d7fabbb8468ad47e9ab96f5122a`。

## 2026-10-09 Router 改动复核（修复调用遇到「调用进行中」）

本节对应上文 2026-10-08 第三轮复审另开的后续事项：修复调用把 `ProviderWireInFlightError` 包起来，付费路径认不出。处理它要改 `router-model-gateway.ts`，所以按围栏规则先复核、再更新指纹。

- **改动**：只改 `generateStructured` 里修复调用外层的 `catch`。原来只把 `ExternalActionDeniedError` 原样抛出，其余错误一律包成 `ProviderOutputError` 或 `ProviderOutputUnresolvedError`（「repair call failed」）；现在 `ProviderWireInFlightError` 也原样抛出。没有新增引入（该类本来就从 `./providers/provider-output-error` 引入），没有新增错误构造，Router 仍不引入 `execution-budget/execution-control-error`。
- **改后的走向**：错误原样到达 `runPersistent` 已有的「调用进行中」分支：记 `MODEL_WIRE_IN_FLIGHT` trace，抛 `PaidOperationUnknownError(operationKey, "MODEL_WIRE_IN_FLIGHT")`。不结算、不收为未发出、不停用付费调用，也不换下一个 provider。这与首次调用遇到「调用进行中」时的处理相同，10-06 复审已确认过这一分支。
- **首次物理调用的结算仍然完整**（动手前逐段核对）：
  - 物理调用层面：provider 在返回首次结果之前，已经经 `physicalWireRuntime().resolve` 自己落了账。网关回读已结算时先写回执（`recordModelPhysicalWireReceipt`），再终结这次调用（`finalizeModelPhysicalWire`）。观测未知或写库 ACK 丢失时，首次结果的用量里是 `unknown`，`initialSettlementUnknown` 直接禁止修复。数据库函数 `allocate_site_build_provider_wire_v1` 也要求首次调用已是 `OBSERVED`、`settlement_status = SETTLED`、载荷可用且派生密钥相同，否则拒绝分配第二次调用（`SITE_BUILD_PROVIDER_REPAIR_NOT_AUTHORIZED`）。所以只要修复调用存在，首次调用的精确回执就已持久。修复 `catch` 从不碰首次调用的记录，本次改动也不碰。
  - 支出层面：这次支出保持 `RESERVED`，按两次调用（`MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND`）算的预留原样占着，不释放。触发器 `guard_site_build_provider_spend_settlement_v1` 只在全部物理调用都已终结（`OBSERVED`/`UNKNOWN`/`NOT_DISPATCHED`）、且 `call_count` 等于实际物理调用数时，才允许支出离开 `RESERVED`，所以只能由终结修复调用的一方来结算。目前这一方是 provider-spend 恢复任务，它的 `completeProviderSpendReconciliation` 按持久回执结算：修复调用为 `NOT_DISPATCHED` 时，按首次调用的回执精确记 `FAILED`（`MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY`，`call_count` 为 1）；有 `UNKNOWN` 或回执不全时，按预留记 `UNKNOWN` 并停用付费调用。两种情况下，首次调用的费用都计入最终扣费：要么按回执精确计入，要么连同修复调用按整笔预留保守计入。恢复任务少数情况下会停在未结算（见下文复审第 5 点），这时预留一直占着，费用同样没有丢。
  - 重试与退路：Temporal 重试经 `reserveModelOperation` 重放。支出仍是 `RESERVED`、首次调用已不是 `ALLOCATED` 时，抛 `PaidOperationUnknownError("MODEL_WIRE_ALREADY_ALLOCATED")`；支出已被恢复任务记为 `FAILED` 或 `UNKNOWN` 时，按记录的错误码抛 `PaidOperationUnknownError`。两种情况都不会再发物理调用。`site-builder/agents/ai-task.ts` 把 `PaidOperationUnknownError` 当作终态，不换下一个模型。
- **改动前的实际后果**：包装后的错误 `callCount` 为 2，合并用量里只有首次调用的已结算观测。`modelCostMeasurement` 因此给出 `estimated_upper_bound`；`site_builder.brand_profile` 用价目表里的模型时，则是只按首次调用 token 计的 `token_pricing`。Router 随后调用 `settlePersistentOperation`，状态 `FAILED`、`call_count` 2、错误码 `PROVIDER_OUTPUT_ERROR`（新增用例在改动前实测如此）。放到真库上：
  - 修复调用尚未终结或已是 `NOT_DISPATCHED` 时，实际物理调用数 1 不等于 2，或观测不全，守卫拒绝。两次结算都失败后走 `freezeUnknownSettlement("MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN")`，以错误的原因停用整个 BuildRun 的付费调用，`MODEL_WIRE_IN_FLIGHT` trace 也丢了；
  - 恢复任务已先结算时，首次结算即返回 `REPLAY`，冻结并报 `SETTLEMENT_REPLAY`；恢复任务若在两次结算之间完成，重试拿到 `REPLAY` 却回读不符，冻结并报 `SETTLEMENT_REPLAY_UNCONFIRMED`；
  - 修复调用若已被别人终结、而支出尚未结算，`call_count` 2 恰好对上，守卫放行。这包括修复调用为 `OBSERVED`，或为终态阶段 `gateway_log_missing`/`gateway_log_unavailable` 的 `UNKNOWN`（这两个阶段不强制 `UNKNOWN` 状态）。这时 Router 会抢在所有者之前终结这次支出，品牌画像任务还只按首次调用的 token 计费、少记修复调用；随后抛不属于终态的 `ProviderOutputUnresolvedError`，AiTask 换下一个模型，开一次新的付费操作。
- **可达性**：按现有 SQL，只有发出首次调用的那次执行能分配修复调用：分配要求首次调用已是 `OBSERVED`；重放时支出仍是 `RESERVED`、首次调用不是 `ALLOCATED`，就直接抛 `MODEL_WIRE_ALREADY_ALLOCATED`；`begin_site_build_provider_wire_v1` 还校验支出自身的 fence。修复调用要拿到 `READBACK_ONLY`，必须有别人在支出仍是 `RESERVED` 时把它移出 `ALLOCATED`。目前只有恢复任务会这样做：分配满 24 小时（`RECONCILIATION_EXPIRY_MS`）仍未发出的调用会被收为 `NOT_DISPATCHED`，然后才结算支出。这两步是分开的事务，后一步也可能失败，窗口就在两步之间；原执行要在分配与 `begin` 之间停顿满 24 小时才会撞上。所以这是防御性修复，针对的是罕见路径。
- **没有放宽任何约束**：授权检查（`assertExternalActionAuthorized`）、预算预留与结算、持久回执与重放、出网围栏、物理调用的分配与计数都没有改动，也没有新增物理调用路径。行为上唯一的变化：修复调用遇到「调用进行中」时，本次执行不再去结算不归它的支出，也不再以错误的原因停用整个 BuildRun 的付费调用，预留照旧保留。非付费路径不会出现这个错误，因为 `paidFetch` 只在 `ctx.paidCost` 存在时才调用 `begin`；即使出现，通用 `catch` 也会扣减整笔预留，比原来按 token 计费更保守。
- **相邻路径，未改**：修复准备阶段的 `catch` 也会遇到「修复调用已存在、且不是 `ALLOCATED`」：`allocateModelPhysicalWire` 此时抛 `PaidOperationUnknownError`，被包成 `callCount` 为 1 的 `ProviderOutputUnresolvedError`，Router 再按首次调用的回执结算 `FAILED`。守卫只在修复调用已是 `NOT_DISPATCHED` 时放行，这时金额正确，之后 AiTask 与其他修复准备失败一样换下一个模型；其余情况被拒后冻结，抛终态的 `PaidOperationUnknownError`。两种结局计费都正确，所以本次不改；只是支出上记的错误码是 `PROVIDER_OUTPUT_ERROR`，看不出是分配阶段的原因。
- **测试**：新增 3 项，改动前都失败，拿到的是包装后的 `ProviderOutputUnresolvedError`。
  - `router-model-settlement-v1.spec.ts`：照真实 provider 的做法，修复调用的 `begin` 返回 `READBACK_ONLY` 时抛 `ProviderWireInFlightError`。断言调用方拿到 `PaidOperationUnknownError(MODEL_WIRE_IN_FLIGHT)`；首次调用的回执与终结各写一次，且为已结算；修复调用既不终结也不收为未发出；不结算支出、不停用付费调用；trace 只记 `MODEL_WIRE_IN_FLIGHT`。
  - `paid-execution-gates.spec.ts`：付费门夹具下，修复确实发生在第二次物理调用上，同样不结算、不停用，trace 为 `MODEL_WIRE_IN_FLIGHT`。
  - `router-model-gateway.spec.ts`：调用方拿到的正是修复调用抛出的那个 `ProviderWireInFlightError` 实例，判为控制错误，预留整笔扣减。
- **独立复审**（只读代理）：没有 CRITICAL、HIGH 或 MEDIUM。上面关于首次调用（物理调用层面与支出层面）、改动前后果与可达性的推理，逐条对照源码成立，没有找到其他可达路径；授权、出网、回执、分配与计数都没有被削弱；三项测试去掉修复都会失败。LOW 五项：
  1. 改动前的计量不总是 `estimated_upper_bound`，守卫放行的情形也不止 `OBSERVED`，还漏了 `SETTLEMENT_REPLAY_UNCONFIRMED`：已在上文改正。
  2. 本节当时还留着复审占位：已填。
  3. 相邻的修复准备路径结局不同（守卫放行时 AiTask 会换模型，错误码记成 `PROVIDER_OUTPUT_ERROR`）：两条路径计费都正确，不改，已写进「相邻路径」一条。
  4. 代码注释说「另一个 worker 持有」不准确，目前唯一可达的情形是恢复任务把修复调用收为 `NOT_DISPATCHED`：注释已改为「另一个 worker 或恢复任务」，指纹按改后的内容更新。`MODEL_WIRE_IN_FLIGHT` trace 不带 token：首次调用的 token 已在它的回执里，本次不改。
  5. 改动前就有：恢复任务 EXPIRE 时，`completeProviderSpendReconciliation` 若返回 UNRESOLVED 而不抛错，会记 EXPIRED 并停止巡检，支出可能一直停在 `RESERVED`、预留一直占着。这是保守的，费用以预留的形式占着、没有丢，记为后续事项。
- **未覆盖**：没有用真实 PostgreSQL 做往返；守卫与恢复任务的行为只做了静态核对。
- **结论**：更新 `router-model-gateway.ts` 指纹为 `bf31b8ee89249aece725d72cc18ad97ee00fbd3ddcb86e4c147d6bf6817fb9df`。
