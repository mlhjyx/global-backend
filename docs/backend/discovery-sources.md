# 多源发现蓝图：数据源 → 采集方式 → 字段 → 合规 → 优先级

> 研究结论（2025-2026 现状）。目标：把发现从「只挖官网」扩展到真正多源。
> 场景基准：为 TRUMPF（德国激光/钣金设备商）找全球中大型金属加工买家。

## 映射表

| 优先级 | 数据源 | 采集方式 | 可得字段/信号 | 合规 | 落地方式 |
|---|---|---|---|---|---|
| **P0** | 官网（现状） | SearXNG general(site:/filetype:) → 噪声过滤 → Crawl4AI → Gemini 判站抽取 | 名/国/行业/员工数/产品/关键词 + 页面指纹 | 🟢🟡 逐域 robots | `PublicWebDiscoveryProvider`（已跑通） |
| **P0** | **Wikidata SPARQL** | WDQS 直连，按行业 P452 + 国家 P17 枚举，**零爬取**直接返回名+官网 P856+员工数 P1128+坐标 | 名/官网/员工数/行业/母公司/LEI/坐标 | 🟢 CC0 | `wikidata.sparql` Tool（**已实现+实测**），包成 discovery adapter |
| **P0** | **OpenStreetMap** | Overpass API 按工业标签(landuse=industrial/craft=metal_*/man_made=works)+地区，或 SearXNG osm 引擎 | 名/精确坐标/地址/OSM标签/有时官网 | 🟢 ODbL | `osm.overpass` Tool（**已实现+实测**），包成 adapter |
| **P0** | 行业协会会员名录（VDMA ~3500 家/AMT） | SearXNG general/files 定位会员目录/PDF → Crawl4AI 分页 → Gemini **列表抽取**（一页多公司） | 名/官网/地址/sector/机械 nomenclature | 🟢 公开会员册 | 新 `association_directory` adapter（industry_data） |
| **P0** | 展会参展商名录（Hannover Messe/EuroBLECH/广交会） | Hannover Messe 官方 **CSV 导出**优先；余者 SearXNG 定位 exhibitor-list → Crawl4AI → Gemini | 名/官网/展位/产品分类/国家/参展年份(活跃度) | 🟢🟡 实测 robots 允许 exhibitor 路径 | 新 `trade_fair` adapter（industry_data） |
| **P0** | GLEIF LEI | 免注册 REST + 每日 Golden Copy bulk（CC0） | 法定名/LEI/注册地址/母子实体关系 | 🟢 CC0 可商用 | 新 `gleif` adapter（company_registry），**富集/去重层**非发现入口 |
| **P1** | EU TED 招投标 | 官方开放 API + SPARQL LOD，按 CPV 品类反查需求方 | 采购方/CPV/标的/金额/中标方 | 🟢 官方开放 | 新 `ted` adapter（public_intelligence），信号型 |
| **P1** | 专利（EPO OPS/EUIPO） | 官方免费 API（注册 key，~2.5GB/周） | 申请人/技术分类 IPC/CPC/时间 | 🟢 fair-use | 新 `epo_ops`，做 tech-fit 分层非主名单 |
| **P1** | 新闻/PR 触发信号 | SearXNG news(reuters/bing) + time_range=month → Crawl4AI → Gemini 事件抽取 | 扩产/建厂/新产线/融资 + 公司/时间/规模 | 🟢🟡 存信号不转载全文 | 新 `news_signal`，**不建 canonical**，写 attributes 做 timing 打分 |
| **P1** | 招聘信号（公司自有 career 页） | 挖官网时顺带抽岗位（禁碰 Indeed 等聚合站） | CNC/激光/焊接岗位 = 产线+扩产信号 | 🟡 仅自有页 | public_web mineDomain 增量抽取，写 attributes.hiring_signals |
| **P1（上下文）** | 海关贸易 **国家级**（UN Comtrade/Eurostat Comext） | 官方免费 REST/CSV | 国家×HS 进出口额，**无公司名** | 🟢 官方免费 | 新 `comtrade` adapter（trade_data），产出市场/HS 优先级**非买家名单** |
| **P2** | Common Crawl | CDX API 免认证 / Columnar Index(Athena) 按 TLD+关键词筛全网域名 | 大规模候选域名+权重 | 🟢 CC0 | 扩量手段，产出候选域名喂 public_web mineDomain |
| **P2** | 证书透明日志 crt.sh | JSON 端点按 O=组织名/域名取证书 SAN | 从已知公司扩展关联域名/子域 | 🟢 强制公开 PKI | 富集工具，在 canonical 公司上扩域名族 |
| **P2** | Technographics（自托管 Wappalyzer） | 对已抓官网跑指纹规则库 | 技术栈标签（识别非反查） | 🟢 自托管 | mineDomain 增量，写 attributes.technographics |
| **P2** | 德国 Handelsregister | 无官方 API，走 bundesAPI/OffeneRegister bulk（数据偏旧） | 法定名/注册号/董事/成立日 | 🟡 自动化灰区 | GLEIF+Wikidata 已覆盖大部分，次优先 |
| **OUT** | B2B 目录（Europages/Kompass/wlw/ThomasNet） | — | 浅字段、噪声大 | 🔴 实测四家 robots 全封通用 UA（含点名封 ClaudeBot） | **不爬**；source_policy 登记为 SUSPENDED 黑名单 |
| **OUT** | LinkedIn/社媒直采 | — | 公司/人员动态 | 🔴 禁抓 + 个人数据 | **不做**；仅官方工具/公开公司账号 |

## 海关/贸易数据的诚实结论

分两层，不可混淆：
- **国家级（免费，绿灯）**：UN Comtrade、Eurostat Comext。国家×HS/CN8 进出口额，**确认无公司名**。只回答「哪个国家进口多少激光/钣金品类」——做 ICP 的国家/HS **优先级打分**，不是买家名单。
- **公司级（有公司名，但没有干净免费官方 API）**：美国 CBP 提单法定公开（19 USC 1431）含真实 consignee 名，但 CBP 不提供 API；印度 DGCIS 不放交易级；可靠访问实务上要么**付费 reseller**（ImportGenius ~$229+/mo、Panjiva、Volza），要么高成本 FOIA/自建 manifest 抓取（逐国 robots/legality 未定，风险高）。

**第一版做法**：`trade_data` 类只落**国家级上下文**（Comtrade/Eurostat），明确标注无公司名、不进公司发现主流程；**公司级不接付费 reseller、不自建 manifest 抓取**，但保留 `data_provider` 表 `class='trade_data'` 契约插槽，待商业授权决策后接 reseller API。对 TRUMPF（卖设备给私营金属加工厂）场景，贸易数据本就匹配偏弱（提单多是成品/零件流而非设备采购），故整体列为**上下文/信号层**而非主发现源。

## 与现有管线的集成点

1. **路由 fan-out**（`discovery.activities.ts executeQuery`）：现在 `routeCompanyDiscovery` 只取 `adapters[0]`（最低成本单源）。改为按 source_class **fan-out 到该类下全部 ENABLED 适配器**并行召回；或用 `filters.source_hint` 二级路由键选具体子源。所有源产出统一进 `raw_source_record` → `canonicalizeRun` 去重归并（已支持后到源只补缺）——天然完成跨源合并。
2. **查询计划契约**（`discovery.query_plan`）：`filters` 增加可选 `source_hint`（association/trade_fair/map/registry/news）与结构化键（fair_slug/area_name/hs_code/cpv），task description 告诉 LLM 每个 source_class 下有哪些真实可用子源。
3. **结构化源 → 官网富化**：Wikidata/OSM/GLEIF/名录产出的 website 命中率参差，统一交给现有 `mineDomain`（Crawl4AI+Gemini）判站富化——「官网单源」降格为**所有源的公共富化层**，不再是唯一发现入口。
4. **召回与信号分离**：发现类源（名录/展会/Wikidata/OSM/官网）→ canonical；信号类源（news/jobs/patents/trade-stats）不建 canonical，写 attributes 供资格门四门判别与优先级打分。
5. **Source Registry 白名单化**：从「仅读 SUSPENDED 黑名单」升级——预置 trade_fair/association/gov_registry 种子域（review_status=APPROVED + robots + access_mode）；crawl 类源抓取前查 APPROVED+robots，api 类源（wikidata/gleif/osm/ted/comtrade）access_mode=api 免爬取校验。

## 第一波落地（P0）

已就绪（本轮已建适配器）：`wikidata.sparql`、`osm.overpass` —— 接成 CompanyDiscoveryAdapter + fan-out 路由即可端到端多源。
待建：VDMA 名录列表抽取器、Hannover Messe CSV/EuroBLECH 展会器、GLEIF 富集。
