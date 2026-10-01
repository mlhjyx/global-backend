# 执行授权物理接线围栏复核

> 生命周期：`REFERENCE_ONLY`
> 依据：2026-10-01 对 `docs/governance/durable-result-strategies.json` 中 `physicalExecutionWiring.protectedFiles` 四个受保护文件，自最后一次指纹匹配以来全部改动的逐提交静态复核；本记录不代表 CI、运行、发布或用户验收通过。

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
| `da2f7aeb`、`379b4514`、`0c8158ec`、`7c87ea80` | 入口断言平台出网付费上下文与围栏；平台物理调用经调度器授权，工具在传输失败后自行伪造回退结果也判失败；已开始平台物理调用后的禁联拒绝不再按零调用释放；付费调用出错按 `UNKNOWN` 结算并停用后续付费调用 | 更严格 |
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
