---
date: 2026-11-12
title: Extract the shared HTTP skeleton of the four email verification providers
---

- 起因：2026-11-12 审计 P2-8（CA-4）的重复代码热点之一——MillionVerifier / ZeroBounce / Emailable / Truelist 四个验证器各自复制了同一段 26 行开外的骨架：config env 解析（positiveInt/去尾斜杠/默认值）、未配置降级、超时/网络/429/非 2xx 错误映射、JSON 解析与最终结果装配（scoreEmailPoint + 错误不计费）。
- 改动：新增 `enrichment/verification/provider-http.ts`（`resolveProviderHttpConfig`、`fetchProviderJson`、`assembleProviderResult` 与公共 `VerificationMapping` 形状），四个 provider 的 `verify()` 收敛为「构造 URL → fetchProviderJson → 映射 → assembleProviderResult」；各家的 env 名字/默认值/URL/query/header/映射逻辑与 detail 组合逐字保留（含 emailable 的 `;score=`、zerobounce 的 `;sub=`、truelist 的 Bearer 头、millionverifier 的 timeout 提示参数与成本注释）。
- 测试：四个 provider 的既有 fixture 套件（emailable/millionverifier/truelist/zerobounce）与 verification-waterfall/provider-pool 套件；@global/api build + 全量单测；CI 必需检查。
- 未做：审计列出的其余重复热点（site-builder eval admission/manifest、model adapters、worker/dev-fast-lane）不在本 PR；SMTP 探测器是工具型验证器（broker 归账），不走 HTTP 骨架。
