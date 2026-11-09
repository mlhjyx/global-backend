---
date: 2026-11-10
pr: 977
title: SMTP RCPT probe as the verification waterfall's fallback second vote
---

- 起因：P1-06 的验证瀑布依赖第三方验证器凑「双正投票」，但缺 key 的环境里可用票数只有 1 家 → 单票 positive 永远停在 UNKNOWN、VALID 恒为 0。栈内已有免费的 `smtp.rcpt_probe` 工具（端口 25 RCPT 探测，无 key、零成本），却只被 email-guess 的自建验证器使用，没接到瀑布。
- **实测更正（2026-11-10 晚，本机 xin）**：对 gmail-smtp-in.l.google.com / mx00.1and1.com / mx.hermes.epson.de 做 25 端口探测，TCP 层被 TUN fake-ip 直接接受但 **SMTP banner 全部超时**——宿主 25 端口出网不可用。探测在现网只会得到 UNKNOWN（`smtp_no_response`），**不能**作为有效的第二票；因此接线默认**关闭**（`EMAIL_VERIFY_SMTP_PROBE_ENABLED` 缺省 false，仅显式 1/true/yes/on 启用）。第二票的现实路径是第三方验证器 key（Emailable/MillionVerifier，待提供）或具备 25 出口的探测节点。
  - 超时/无响应一律映射 UNKNOWN + error（无裁决）：既有流程不受影响（单票仍 UNKNOWN，不伪造 VALID/INVALID）；`smtp_no_response` 与 `smtp_unreachable` 分开命名，便于日后出网可用时观测。
- 改动：
  - 新增 `apps/api/src/enrichment/verification/smtp-probe.provider.ts`：`EmailVerificationProvider` 适配器，经 `broker.invoke('smtp.rcpt_probe', …)` 执行（source_policy advisory + 用途门 + 预算 + 限流 + Trace + 工具内 SSRF 护栏全部沿用工具）；映射 RCPT 2xx + 随机地址 5xx（catch-all 证伪）→ VALID、5xx/无 MX/Null MX/NXDOMAIN → INVALID、随机地址也 2xx → CATCH_ALL_RISKY·true_catch_all（acceptAll=true）、反枚举 provider（Gmail/M365…）→ UNKNOWN·unprobeable_provider（不触网）、catch-all 未证伪 → UNKNOWN·inconclusive、SMTP 不可达/MAIL FROM 拒/超时/broker 拒绝 → error 非空（无裁决，绝不凑票）。成本 0；`verification_method`/事件账如实记 `smtp_rcpt`。
  - `provider-pool.ts`：`withSmtpProbeFallback` —— 外部验证器**门后可用数 < 2** 时自动追加兜底票到瀑布末席；>=2 家可用时不追加（SMTP 不得占仲裁席）。开关 `EMAIL_VERIFY_SMTP_PROBE_ENABLED`（**缺省关**，见上；具备 25 出口的部署可显式开启）+ `data_provider.smtp_self` kill switch + broker 装配三道检查。
  - 三处瀑布消费方接线：再验证 sweep（CLI 自建 broker——APP_DATABASE_URL 缺省时优雅跳过；Schedule activity 由 worker 注入 broker）、run 内富集 activity（`deps.broker`）、HTTP 富集端点（`TOOL_BROKER` DI token，discovery.module 单实例与 provider registry 共用）。
  - `EmailVerificationProviderResult.method`：每步声明验证方式；sweep / 富集写事件账与 `contact_point.verification_method` 时按步取值（第三方 API 缺省 `third_party_api`）。
- 治理：新增 `smtp.rcpt_probe` 物理调用点，`scripts/execution-authority-policy.mjs` 的 `EXPECTED_TOOL_CALLSITES` +1（44→45，spec 同步）。
- 测试：适配器 19 条（假 broker + 假 MX：deliverable/undeliverable/catch-all/未证伪/反枚举/不可达/MAIL FROM 拒/超时/ToolPolicyDenied/egressBlocked/无 MX/Null MX/NXDOMAIN/瞬时 DNS 失败/缺 workspace/合规预检/预算账降级/幂等随机地址，零真实出网）+ 瀑布集成 5 条（两票一致→VALID、冲突→UNKNOWN、仅兜底一票→UNKNOWN、兜底票超时→provider_error、accept_all 优先压 CATCH_ALL_RISKY）；池兜底语义 7 条（默认关/显式开关/kill switch/broker/票数）与 activity 路径（含默认关时仍 skipped(provider_unconfigured) 的用例）；sweep 事件账/点 verification_method 记 smtp_rcpt。
- 未做：Truelist catch-all 解析分支（仍待编排改造）；第二票在现网仍缺（等第三方 key 或 25 出口探测节点）；兜底票经 broker 预算账——workspace 无预算账户/BudgetStore 不可用/超限时降级为无裁决的 error 票（不崩溃批量、不绕闸门），其余执行控制错误（平台出口围栏、域名 ACK、账本重放）仍原样上抛。
