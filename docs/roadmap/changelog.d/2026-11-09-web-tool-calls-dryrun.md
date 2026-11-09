---
date: 2026-11-09
title: WEB-1 tool_calls wire verification — offline dry-run harness and minimal paid-round-trip authorization
---

- 起因：`generateChatWithTools`（WEB-1）已合入，但「真实上游在一轮里发起 tool_calls、第二轮接受 tool 消息回放」只有付费往返能证明；先把离线半边与授权口径做成可执行材料，授权后一条命令即可验证。
- 改动：
  - `apps/api/src/model-gateway/chat-tools-dryrun.ts`：web_search/web_fetch 的 tool_calls 请求/响应夹具与用量声明、输入校验（名字/上限/id 唯一与有主/`inputSchema` 可编译）、脚本化 wire（记录请求体、零网络）、按目录价与 reserve 口径的费用估算、三方编排（tool_calls 解析、回放与最终回答、身份门负例）。
  - `apps/api/scripts/web-tool-calls-dryrun.mts`：一键入口。默认离线 dry-run；`--live` 直连网关发起 2 次付费 chat-completions（需 `WEB_TOOL_CALLS_LIVE_ACK=YES` 与 `WEB_TOOL_CALLS_{BASE_URL,API_KEY,MODEL}`），打印真实 usage 与结论。
  - `docs/backend/web-tool-calls-wire-verification.md`：最小授权请求（2 次调用、预留上限 40¢、token 估算与验证项清单）与执行/回填步骤。
- 测试：`chat-tools-dryrun.spec.ts` 以真实 provider + 脚本化 wire 跑通两轮与身份负例，并覆盖输入校验与费用估算的边界值。
- 未做：真实付费往返（等产品负责人费用授权）；不部署。
