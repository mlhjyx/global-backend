# 文档与采集候选 Capability Cards

> 文档 ID：`OSS-FE-006`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 边界：技术可抓取/解析不等于数据有权使用；Source Policy、robots/ToS、个人数据和保留规则继续独立生效

## `ADP-FE-018` Docling

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 把获授权资料解析为可追溯结构化文本；不判断内容真实性、Claim 批准或素材权利 |
| 当前等价与证据 | KB 已有 `DoclingClient`；开发容器 `docling-serve:latest` 实际运行镜像 ID 已记录，但未 pin 生产版本 |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | Docling 代码 MIT；模型、OCR、第三方依赖和输入文档权利逐项核验 |
| Adapter / SoR | `DocumentParserProvider` 输出 markdown/结构/provenance；Asset/Document/Chunk 状态留我方 DB |
| Security / 数据 | 恶意 PDF/Office/图片、压缩炸弹、资源上限、sandbox、无出网生产镜像、模型预烘焙、日志最小化 |
| Test / Release Gate | MIME/魔数、畸形/加密/大文件、表格/OCR、超时/取消、解析版本、隔离、删除和回退；pin digest 后再谈生产 |
| Owner / Exit | `OWN-KB-BE`；Provider 可换，自有原文件和解析 provenance 保留，旧版本结果可重跑/标 stale |

## `ADP-FE-019` Crawl4AI

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 在受控用途下抓取公开网页；不授予抓取权，也不绕过登录、robots、ToS 或 source policy |
| 当前等价与证据 | 当前 wrapper 固定 Crawl4AI 0.9.1 不可变 digest，并有 global-unicast/pinning/fake-IP guard；开发容器运行中 |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | Apache-2.0；浏览器、站点内容、目标站条款和数据用途不由框架许可覆盖 |
| Adapter / SoR | 唯一入口 `WebCrawlerProvider`/ToolBroker；返回受限内容和 provenance，原网页不成为业务主真值 |
| Security / 数据 | SSRF/redirect/DNS rebinding/fake-IP、浏览器 sandbox、token、响应大小/超时、下载、凭据剥离、日志/PII |
| Test / Release Gate | 保留现有公网/内网负例矩阵；加 digest/SBOM、浏览器升级、robots/source-policy、取消、资源/并发和生产网络隔离 |
| Owner / Exit | `OWN-ACQUISITION-BE`；可切 Firecrawl/自建 HTTP renderer，保持 Tool Contract 和 provenance；安全 Owner 独立验 egress/SSRF |

## `ADP-FE-020` Firecrawl

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | Crawl4AI 的托管/自托管备选；不因更易用而降低出口、合规或数据出境门 |
| 当前等价与证据 | 未采用；现有 Crawl4AI 已有安全加固和真机证据 |
| 主决策 | `DEFER / FALLBACK_ONLY` |
| License / 权利 | 自托管代码 AGPL-3.0；云服务另受商业/DPA/区域条款，目标内容权利仍独立 |
| Adapter / SoR | 必须实现同一 `WebCrawlerProvider`，不得让业务读取 Firecrawl job/schema 或直接持有 API key |
| Security / 数据 | AGPL 网络使用义务、云数据出境/保留、SSRF/redirect/robots、secret、抓取缓存、供应商事故 |
| Test / Release Gate | 只有现基线达不到明确 SLO/成本才比较；用同 URL 对抗集验证安全等价、内容质量、取消、删除、成本和出口 |
| Owner / Exit | `OWN-ACQUISITION-BE`；导出/删除缓存，撤销 key，Adapter 切回 Crawl4AI；无双真值；AGPL/商业/出境另过强制 Gate |

## `ADP-FE-021` SearXNG

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 提供候选发现入口；不保证搜索结果权利、完整性、身份或适合进入线索库 |
| 当前等价与证据 | 开发环境通过 `PublicWebDiscoveryProvider` 使用；Compose 为 `searxng:latest`，实际镜像 ID 已记，未 pin |
| 主决策 | `INTEGRATE / DEV_AS_BUILT_HARDEN` |
| License / 权利 | AGPL-3.0；各搜索引擎条款、结果缓存/展示和商用使用需逐引擎核验 |
| Adapter / SoR | 只经 `searxng.search` ToolBroker/Provider；结果是 discovery hint，身份/事实必须另取 Evidence |
| Security / 数据 | 仅内网、查询可能含敏感词、引擎出境、限流、代理、管理面、日志、SSRF 和滥用 |
| Test / Release Gate | pin digest/SBOM；engine health、部分失败、零结果、限流、超时、query 脱敏、kill switch、升级和 AGPL 义务 |
| Owner / Exit | `OWN-DISCOVERY-BE`；切 Brave/Bing/其他搜索 Adapter 时保持 query/result contract，删除服务缓存和凭据 |

## 组合决定

Docling/Crawl4AI/SearXNG 是“已有开发事实 + 生产未准入”，优先工作不是换工具，而是去掉 `latest`、补 SBOM/许可/升级/退出和生产隔离。Firecrawl 只保留经 SLO 触发的替代，不与 Crawl4AI 双栈常驻。
