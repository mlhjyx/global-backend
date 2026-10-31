---
date: 2026-10-30
title: Make the SSRF guard's DoH endpoints configurable with ordered fallback
---

- 起因：出网护栏在系统 DNS 全部是 mihomo fake-IP 时走 DoH 反查真实地址，端点硬编码为 Cloudflare。2026-10-29 本机 `cloudflare-dns.com` 一度不可达（`dns.google` 与 `1.1.1.1` 同时被掐、而 `doh.pub` 正常），`POST /companies` 因此全部报 `INVALID_URL`，演示工作空间的验收入口直接停摆；一个 DoH 端点的可达性不该决定整台机器的出网解析。
- 改动：
  - `apps/api/src/adapters/net-guard.ts` 新增 `NET_GUARD_DOH_ENDPOINTS`（逗号分隔、仅接受 https 绝对 URL、按序去重）；缺省仍为 Cloudflare 再 Google，配置项全部非法时回落缺省，避免一处配错误伤全部解析。
  - `dohLookup` 按配置顺序逐端点尝试（A 与 AAAA 并发），第一个给出非空答案的端点胜出；全部失败仍 fail-closed 返回 `dns_lookup_failed`，私网/fake+private 混合的拒绝逻辑不变。
  - 导出 `parseDohEndpoints` 与 `DEFAULT_DOH_ENDPOINTS` 供测试与运维核对。
- 测试：`net-guard.spec.ts` 15 例全绿——新增 4 例覆盖端点解析（缺省/空串/非法项/去重/全非法回落）、首个端点失败换下一个（断言两个端点都被请求）、全部失败仍 fail-closed、未配置时的缺省顺序。
- 未做：没有改动 fake-IP 判定、私网拒绝与连接 pin 语义；也没有把 doh.pub 写进缺省列表（属部署侧决定，用 `NET_GUARD_DOH_ENDPOINTS` 配即可）。
