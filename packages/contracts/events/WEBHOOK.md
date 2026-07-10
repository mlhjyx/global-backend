# Webhook 推送验签（收口③ push sink）

后端可选地把集成事件（envelope，见 `envelope.schema.json`）POST 到 SaaS 配置的
`SAAS_WEBHOOK_URL`。启用条件：`SAAS_WEBHOOK_URL` 与 `SAAS_WEBHOOK_SECRET` 均已配置，
且 URL 为 `https://`（dev 例外：`localhost` / `127.0.0.1`）。条件不满足时推送通道整体不启用。

## 请求形状

- `POST <SAAS_WEBHOOK_URL>`，`content-type: application/json`
- body = 单个事件 envelope（snake_case，同 `GET /events` 返回的元素）

## 签名 Header

| Header        | 值                                                        |
| ------------- | --------------------------------------------------------- |
| `x-timestamp` | 发送时刻 ISO-8601（如 `2026-07-10T09:00:00.000Z`）          |
| `x-signature` | `sha256=<hex>`，hex = `HMAC_SHA256(secret, timestamp + '.' + rawBody)` |

## 消费端验签步骤

1. 取原始请求体字节（**不要**先 JSON.parse 再序列化——键序/空白差异会破坏签名）。
2. 用共享 `SAAS_WEBHOOK_SECRET` 计算 `HMAC_SHA256(secret, x-timestamp + '.' + rawBody)`，hex 编码。
3. 与 `x-signature` 去掉 `sha256=` 前缀后做**常数时间比较**（如 `crypto.timingSafeEqual`）。
4. 校验 `x-timestamp` 与当前时间差在时间窗内（建议 **5 分钟**）——拒绝重放。
5. at-least-once 语义：按 `event_id` 去重（重试/竞态可能重复送达同一事件）。

## 响应约定

- 2xx → 视为送达（ACKED）。
- 非 2xx / 超时（10s）→ 指数退避重试（`2^attempts × 30s`，封顶 1h），连续 10 次失败进 DLQ（DEAD，人工介入）。
