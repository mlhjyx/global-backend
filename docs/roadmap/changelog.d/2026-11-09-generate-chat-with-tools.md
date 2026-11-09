---
date: 2026-11-09
title: Gateway tool-call transport — generateChatWithTools over OpenAI chat completions
---

- 起因：v3.0 第 6 章 WEB-1——模型联网工具环的传输层缺失：`ModelGateway` 只有单发方法，chat-completions 传输把 `finish_reason=tool_calls` 当错误（`CHAT_COMPLETIONS_TOOL_CALL_UNEXPECTED`），模型无法请求平台执行工具。
- 改动：
  - `types.ts`：封闭消息模型（system/user/assistant(toolUses)/tool 四角色，第三方内容只能进 tool 消息）、`ChatToolDefinition`/`ChatToolUse`/`GenerateChatWithToolsInput`/`ChatResponse`；`ModelOp` 增加 `generateChatWithTools`。
  - `ModelGateway`：默认**实例方法** fail-closed（`CHAT_WITH_TOOLS_UNSUPPORTED`；不是类属性，避免 useDefineForClassFields 遮蔽子类实现）。
  - `RouterModelGateway`：新 `generateChatWithTools` 走既有 run()（预算 reserve-then-settle、身份门、风控订阅）；`messages`/`tools` 参与预算幂等键与持久路径的 prompt 字节估算；provider 包装器透传并按 `noted` 记录模型替换。**平台出网上下文（platformEgress）下该 op 一律 fail-closed**（`CHAT_WITH_TOOLS_PLATFORM_EGRESS_UNSUPPORTED`）——R4 围栏的 modelOp 白名单属于平台执行合同，扩列需平台策略版本，工具环任务按设计走客户侧运行。
  - `OpenAICompatibleProvider`：对 openai-chat-completions 传输实现 `generateChatWithTools`（`tools`/`tool_choice:auto`、assistant tool_use 回放为 tool_calls、tool 结果按 `tool_call_id` 回传）；`finish_reason=tool_calls` 正常解析，参数非 JSON / 名字非法 / 缺失 tool_calls 均按**可计费失败**（ProviderOutputError 带 usage）上报；非该传输明确 `CHAT_WITH_TOOLS_TRANSPORT_UNSUPPORTED`；v1 非流式。
- 测试：provider 7 例（解析/回放/stop/length/坏参数/缺 tool_calls/content_filter/传输拒绝）、路由器与默认网关 6 例（fail-closed、透传、无实现不兜底、路由链为空、预算键随对话变化、平台出网拒绝）；model-gateway 全目录 509 例保持全绿。
- 未做：真实 wire 一次 tool_calls 往返（属付费调用，等产品负责人费用授权）；Anthropic Messages 传输的 tool_use；流式 tool_calls 增量拼装；工具环本体（hop/预算/超时/注入防护）为 WEB-2+。未部署。
