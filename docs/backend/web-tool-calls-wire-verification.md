# WEB-1 tool_calls 真实往返：一键验证与最小授权说明

> 生命周期：`DRAFT`
> 生命周期依据：dry-run 脚本与夹具已入库（零网络可跑）；真实 wire 往返属付费调用，等产品负责人授权后执行，完成后改 `APPROVED` 并回填证据（2026-11-09）。
> 关联：`apps/api/src/model-gateway/chat-tools-dryrun.ts`、`apps/api/scripts/web-tool-calls-dryrun.mts`、changelog 2026-11-09（generateChatWithTools）。

## 1. 为什么还需要真实往返

`generateChatWithTools`（v3.0 第 6 章 WEB-1）已合入 main，单测覆盖了请求体构造、tool_calls 解析、工具结果回放、坏参数/缺 tool_calls/content_filter 失败分类、身份门负例与平台出网 fail-closed。**尚未被真实验证**的只有一件事：真实上游（new-api 网关后的模型）在一轮里按 `tools` 定义发起 `tool_calls`，以及第二次调用对 `tool` 消息回放的接受度。这必须花两次付费调用才能看到。

## 2. 一键 dry-run（零网络、零费用，随时可跑）

```bash
pnpm --filter @global/api exec tsx scripts/web-tool-calls-dryrun.mts
```

它用 `web_search`/`web_fetch` 的夹具驱动**真实 provider 代码**（fetch 换成本地脚本化 wire）：

- 输入校验：tool 名/上限、messages 上限、assistant `tool_use` id 唯一、tool 结果的 `tool_use_id` 有主、`inputSchema` 可编译；
- 第 1 轮：`finish_reason=tool_calls` 被解析为两段 `tool_use`（id/name/arguments 完好）；
- 第 2 轮：assistant `tool_calls` 回放 + `tool_call_id` 结果消息，得到 `stopReason=end` 的最终回答；
- 身份门负例：应答模型与请求不一致时必须抛 `ProviderIdentityError(MODEL_IDENTITY_MISMATCH)`；
- 费用口径：打印真实往返将产生的调用次数与两种估算（见 §3）。

退出码 0 = 全部通过；1 = 有失败项（此时不应申请真实往返，先修代码）。

## 3. 最小授权请求（真实往返）

| 项目 | 内容 |
| --- | --- |
| 付费调用次数 | **2 次** chat-completions（第 1 轮要工具、第 2 轮回放工具结果）。失败重试最多 +2 次，需单独确认 |
| 预算预留上限 | 2 × `maxCostCents`（默认 20¢/次）= **40¢**；脚本不设更高值，可再下调 |
| token 估算（目录价 100¢/Mtok） | 夹具口径约 **2¢**（每轮 1¢ 下限）；实际以 new-api 结算为准 |
| 使用的模型/网关 | 由执行时 `WEB_TOOL_CALLS_MODEL` 指定；建议先用 flash 档验证行为，不必用 pro 档 |
| 数据面 | 只发送固定研究提示词与两个工具定义；不发真实客户数据，工具结果由本地伪造，不执行真实抓取 |
| 授权对象 | 产品负责人（费用授权）；工程师执行，结果回填本文档与 PR |

授权生效方式：在会话中明确回复同意上述口径后，执行者以本机环境变量运行 `--live`（密钥只放 env，不进仓库、不进日志）。

## 4. 真实往返执行步骤（授权后）

```bash
WEB_TOOL_CALLS_LIVE_ACK=YES \
WEB_TOOL_CALLS_BASE_URL=http://127.0.0.1:3001/v1 \
WEB_TOOL_CALLS_API_KEY=… \
WEB_TOOL_CALLS_MODEL=… \
pnpm --filter @global/api exec tsx scripts/web-tool-calls-dryrun.mts --live
```

未设置 `WEB_TOOL_CALLS_LIVE_ACK=YES` 时脚本拒绝执行（退出码 2）。执行后把两轮的 `stopReason`、toolUses、usage 与结论回填到本文档 §6。

## 5. 验证项清单

| 验证项 | dry-run（本地） | --live（真实） |
| --- | --- | --- |
| 请求体：`tools`/`tool_choice=auto`/非流式 | ✅ 断言请求体 | ✅ 上游接受即证明 |
| 模型按定义发起 `tool_calls`（真实行为） | ✗ 夹具伪造 | ✅ 核心验证项 |
| `tool_use` 的 id/name/arguments 解析 | ✅ | ✅ |
| 身份门（应答 `model` 与请求一致） | ✅ 正例+负例 | ✅ 正例（负例无法令上游配合） |
| 第二轮 `tool` 消息回放被上游接受 | ✗ 夹具 | ✅ |
| usage 回报（prompt/completion tokens） | ✅ 夹具 | ✅ 打印真实值 |
| router 预算 reserve/settle 与 trace 账本 | 单测覆盖（`model-gateway.chat-tools.spec.ts`） | 不覆盖（脚本直连 provider，不建 DB/预算） |
| 坏参数/content_filter/缺 tool_calls 失败分类 | ✅ 单测 | 不覆盖（不应主动诱发） |
| 平台出网上下文 fail-closed | ✅ 单测 | 不覆盖（工具环按设计走客户侧） |

## 6. 结果回填（执行后填写）

- 执行日期/执行人：
- 模型与网关：
- 第 1 轮：stopReason=，toolUses=，usage=
- 第 2 轮：stopReason=，回答长度=，usage=
- 结论：通过 / 失败（失败时附上游响应关键字段，隐去密钥）

## 7. 风险与回退

- 真实往返只产生 2 次小请求，无数据面副作用；失败不影响任何线上功能（代码未部署或用例不依赖它）。
- 若上游不发起 `tool_calls`：先确认 `WEB_TOOL_CALLS_MODEL` 是否为支持 function calling 的模型；仍失败则记录模型名并改在 WEB-2 评估提示词/工具描述。
- 密钥只在执行终端 env 中出现；`--live` 输出不打印 Authorization。
