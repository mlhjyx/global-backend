# Crawl4AI 0.9.1 → 0.9.5 安全升级 · 落地设计文档（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：主计划 §3.5b「安全升级」定案（2026-11-04 产品负责人批准选型）；2026-11-08 产品负责人批准 D-a~D-f（D-f：0.9.5 独立镜像 PR，trafilatura sidecar 降为观察项）。
> 关联：PR-B 设计 `2026-11-04-http-cache-pr-b.md` §14。

## 1. 背景与目标

自托管 Crawl4AI Docker API（`127.0.0.1:11235`）当前基于 0.9.1。0.9.5（2026-10-14）是安全版本，修复 6 个协调披露通告，全部命中我们的暴露面（Docker API 允许请求体控制渲染参数）：

- **CVE-2026-119119**（DoS，CVSS v4 8.7 / v3.1 7.5）：`delay_before_return_html`/`mean_delay`/`max_range` 无上限 → 页面被长时间占住/限速器被拖死。
- **JS 注入**：allowlist 中的 `css_selector`/`wait_for` 可绕过 `js_code` 拦截进 `page.evaluate()`。
- **盲 SSRF**：`CacheValidator`/`check_cache_freshness` 自建 httpx 客户端，绕过 egress pinning proxy。
- **调用方指定 HuggingFace 模型**（pickle RCE）、**调用方正则 ReDoS**、**TLS 校验关闭**（默认 Chromium 参数含 `--ignore-certificate-errors`）。

目标：重打 egress 补丁镜像并重钉 digest；确认池回收与墙钟边界生效；镜像可回滚；适配器契约与发现/渠道链路回归绿。

## 2. 现状核对（2026-11-08，基础镜像内实测）

| 项 | 结果 |
| --- | --- |
| 0.9.5 多架构 index digest | `sha256:0b05666882bfb67f45d559a5b827839c54127b74aedd723f8ab338a3571b5fc9` |
| egress 补丁锚点 | `def _resolve(host, port)` / `resolve_and_pin` / `set_egress_proxy` 均存在（`patch_egress_broker.py` 可应用） |
| supervisord redis 行 | 仍匹配既有 sed 模式（`command=/usr/bin/redis-server …`），补丁失败会硬失败 |
| `limits.wall_clock_s` | `/app/config.yml` 默认 `300`（0 = 无截止） |
| `crawler.pool.max_pages_before_recycle` | `/app/config.yml` 默认 `200`（0 = 不回收） |
| 生态 | 仓库无可执行代码引用版本号；历史计划/归档文档的 0.9.1 表述不改写 |

## 3. 改动

1. `infra/crawl4ai/Dockerfile`：`FROM` 换 0.9.5 immutable digest；构建期断言 `/app/config.yml` 仍含 `wall_clock_s: 300` 与 `max_pages_before_recycle: 200`（未来基础镜像升级改名/丢默认值会在构建期硬失败）。保留既有全部补丁：redis 持久化关闭、playwright 匹配浏览器安装、fake-IP DoH 窄回退 + 上游 global-IP 守卫/pinning proxy 原样继承。
2. 镜像：构建 `global-crawl4ai:0.9.5-20261108`；打回滚 tag（旧 `global-crawl4ai:local` → `global-crawl4ai:rollback-0.9.1-20261108`）；部署时由发布流程按 compose 重新 `build crawl4ai`（tag `global-crawl4ai:local`）。
3. 无应用代码/迁移/env 变化；`web-crawler.ts` 的 `/md`、`/crawl` 请求契约不变。

## 4. 测试与验收

- 适配器契约：`web-crawler.spec.ts`、`builtin-tools*.spec.ts` 等既有单测（CI 全量）。
- 容器冒烟（本机，非生产端口）：`/health` 200；经 pinning proxy 抓一个 example.com 页面成功；拒绝内网地址（global-IP 守卫仍在）；容器日志无 redis 持久化噪声。
- 回归：发车后渠道 preview 与发现链路冒烟（产品负责人发布流程执行）。
- **回滚**：`docker tag global-crawl4ai:rollback-0.9.1-20261108 global-crawl4ai:local` + 重建 Crawl4AI 容器；或把 Dockerfile 的 `FROM` 退回旧 digest 重新构建。无数据/迁移依赖。

## 5. 风险与开放问题

| 风险 | 处理 |
| --- | --- |
| 0.9.5 改动渲染行为导致部分站抓取退化 | 冒烟 + 发车后回归；回滚 tag 一步可退 |
| egress 补丁在新版失效 | 构建期 `compile()` + 锚点检查硬失败（已实测锚点存在） |
| 上游未来改默认值 | 构建期 grep 断言 `wall_clock_s: 300` / `max_pages_before_recycle: 200` |
| 开放问题 | 无（trafilatura sidecar 按 D-f 观察项处理，见 PR-B 设计 §14.2） |

## 6. 给产品负责人的说明

- 得到什么：自托管爬虫升级到修复 6 个安全通告的版本（含 DoS/JS 注入/盲 SSRF/RCE/ReDoS/TLS），同时沿用既有的出网守卫与补丁；浏览器池每 200 页回收、单次抓取 300s 截止两道边界生效。
- 没改什么：抓取接口契约、引擎代码、数据与迁移均不变。
- 风险与回退：镜像可一步回滚到旧 tag；渲染行为差异在发车后回归中观察。
- 建议：合并；发车按主会话统一安排（重建 Crawl4AI 容器即可，无迁移）。
