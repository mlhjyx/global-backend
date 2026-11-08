---
date: 2026-11-09
title: Channel pool wave 1 — channel-manifest/v1, secret refs, HTTP connector runtime, probe and health thresholds
---

- 起因：GainOS 深化计划 v3.0 第 6 章（渠道资源池）——现有 `source_channel` 只有 crawl 形态可执行，api 形态是空契约（`config.adapter` 无执行路径），无密钥引用、无健康画像、无自动停用长尾规则（CH-1/CH-2/CH-3/CH-4/CH-7/CH-10 的数据层与运行时首波）。
- 改动：
  - 迁移 `20261109100000_channel_manifest_v1`：`source_channel` 增量列（manifest/manifest_sha256/manifest_version/connector_kind/adapter_key/base_url/auth_ref/rate_limit/pagination/field_mapping/health_state/consecutive_failures/last_success_at/disabled_reason/quota_policy/probe_required）+ 新表 `source_channel_probe`、`source_channel_health_event`；17 行历史数据 config 原值保留，ENABLED 行回填 `probe_required=false`，其余保持 true。
  - `@global/contracts` 新增 `channel-manifest/v1` JSON Schema（draft 2020-12，章节 §6.3.3 全文）与字段白名单；引擎侧 `parseChannelManifest` 做 Ajv + 语义校验（危险静态头、联系人字段仅详情模式、allowedHosts 覆盖 baseUrl、robotsPolicy=C 拒绝、JSONPath/regex 可编译）并计算 `manifest_sha256`；`configToManifest` 保持历史 crawl config 语义不变。
  - 连接器运行时 `apps/api/src/channels/connector/`：密钥引用解析（file/env，TTL 60s，错误不区分原因、绝不含值）、认证注入（none/apiKey/bearer/header/basic；oauth2 v1 明确不支持）、分页（none/page/offset/cursor/link）、令牌桶 + 每域延迟、指数退避 + Retry-After（3 次/60s）、三态熔断（5 分钟开、半开单探测、10 分钟起指数重开）、JSONPath 抽取 + transforms。物理请求只走既有 `requestPublicHttp`（https/公网 IP/逐跳重验/字节上限），且缺平台围栏绑定时一律拒绝——不存在未治理出网路径。
  - 健康与自动停用：`evaluateChannelHealth` 纯函数实现 20 次/4 天 WARNING、30 次/7 天 AUTO_DISABLED(AUTO_STREAK)；finalize 同事务维护 `consecutive_failures`/`last_success_at` 并写健康事件；API 进程内小时级扫描钩子（沿用 sweep-scheduler 周期桶模式，不新增平台 schedule）。
  - 运营台 API：`GET /source-channels/:id`（manifest + 健康摘要 + 密钥「已配置/未配置」，值永不返回）、`POST /source-channels/:id/test`（保存即测试，probe 落库、成功才解除 `probe_required`、样本联系人字段只留命中布尔）、`POST/PATCH` 支持 manifest 导入与重存（重存即置 `probe_required=true`）、manifest 渠道启用前 409 `CHANNEL_PROBE_REQUIRED`；人工启停写 MANUAL_ENABLE/MANUAL_DISABLE 事件。
- 测试：新增 manifest 校验 15 例、密钥解析 6 例、认证注入 8 例、分页 8 例、退避 5 例、熔断 6 例、连接器运行时 12 例、字段抽取 4 例、健康阈值 5 例、probe 8 例、扫描 4 例、迁移契约 5 例、服务层 manifest 9 例；更新 run recorder（阈值/事件）与既有 authz/DI 用例（新端点入矩阵）。
- 未做：api 渠道的 Temporal 执行链与平台 Grant/fence 绑定（CH-5，probe 在本波内 fail-closed 503）；source_policy 派生与官方白名单（CH-8）；crawl 形态 manifest 执行、详情页逐条抓取、oauth2、link 之外的多段/签名协议；gain-saas 运营台 UI 由主会话前端线另行施工。
