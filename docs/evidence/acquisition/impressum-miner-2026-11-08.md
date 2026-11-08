# A1 · Impressum 挖掘器 DoD 证据（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP A1 的验收口径（产品负责人最关心的「德国邮箱覆盖率 70–90%」）；数据文件 `impressum-miner-2026-11-08.json` 为本目录同次运行的完整记录。

## 口径

- **DoD（WP A1）**：可达 Impressum 的 DE/AT 公司 **≥80%** 产出 ≥1 个 role 邮箱 + ≥1 个电话。
- **样本**：dev 库 `canonical_company` 中 `country='DE'`、有域名且非 `.example` 合成域的公司，按 `md5(domain)` 排序取前 20（可复现、非人工挑选）；同一域名只取一家。
- **采集**：`crawl4ai.render`（headless Chromium，`CRAWLER_RENDER_DELAY_MS=3000`），每个 URL 抓取前 robots 检查（`isAllowedByRobots`）；
  首页取链失败/文本过小时回退 markdown 端点与尾斜杠变体。
- **抽取**：直接复用产品代码 `legalPageCandidates` + `collectCompanyChannels`（cfemail/JSON-LD/实体/混淆/ät/punkt 解码，电话归一，
  本站域/同组织域过滤，personal 剔除）；命中率即产品行为。脚本：`apps/api/scripts/impressum-evidence.mts`（查样本名录后立即断库，
  抓取阶段不持有数据库连接——部署窗口纪律）。

## 结果（2026-11-08 最终运行，20 家 DE 样本）

| 指标 | 值 |
| --- | --- |
| 样本 | 20 |
| robots 禁止 | 0 |
| 首页可达 | 20 |
| 可达 Impressum/联系页 | 19 |
| ≥1 role 邮箱 | 13 / 19 |
| ≥1 电话 | 13 / 19 |
| **邮箱+电话双命中** | **11 / 19 = 57.9%**（DoD ≥80%，**未达**） |

| 域 | 双命中 | role 邮箱 | 电话 | 说明 |
| --- | --- | --- | --- | --- |
| miniatur-wunderland.de | ✅ | info@miniatur-wunderland.de | +4940300680 |  |
| pumpentechnik-bass.de | ✅ | info@pumpentechnik-bass.de | +49208867554, +492088830141 |  |
| eheim-service.de | — | — | — | 渲染被反爬拦截（无任何页面文本成功抓取） |
| tsurumi.de | ✅ | vertrieb@tsurumi.eu, datenschutz@tsurumi.eu, intsales@tsurumipump.co.jp | +49211417937450, +49211417937460 |  |
| istpumpen.com | ✅ | info@istpumpen.com | +492261701430, +492261701431 |  |
| sanotact-group.de | ✅ | info@sanotact.de | +4925114210, +49251142156339 |  |
| shop.jesspumpen.de | ✗ | — | — | 登记的商城子域；主站 jesspumpen.de 试点命中 info@ + 电话（样本按登记域计入） |
| ksb.com | ✗ | — | — | 同意墙/JS 壳（渲染文本 <500 字节） |
| wasserpumpe.de | ✅ | service@wasserpumpe.de | +4921618397808 |  |
| schreiber-anlagenbau.de | ✗ | info@schreiber-anlagenbau.de, ds@schreiber-anlagenbau.de, so@schreiber-anlagenbau.de | — | 有 7 个 role 邮箱、页面未见电话（疑图片/格式缺失） |
| aquaristik-bayern.de | ✅ | mail@aquaristik-bayern.de | +4999646019360 |  |
| delock.de | ✗ | — | — | 同意墙/JS 壳 |
| de.milwaukeetool.eu | ✗ | — | +4921039600, +447725244791 | 有电话、未见邮箱 |
| apollo-goessnitz.de | ✗ | — | +4934493770, +493449377210 | 有电话、页面未见邮箱（疑图片发布） |
| telekom.de | ✅ | impressum@telekom.de | +498003303000, +498003301000 |  |
| algamdach.de | ✅ | marketing@algam.de, info@algam.de | +4989125039012, +498912503901 |  |
| allweiler.de | ✗ | — | — | 同意墙/JS 壳 |
| pumpen-plueckhahn.de | ✗ | info@pumpen-plueckhahn.de | — | 有 role 邮箱、未达电话 |
| mavex-pumpen.de | ✅ | info@mavex-pumpen.de | +49621378787 |  |
| andus.de | ✅ | anfrage@andus.de | +49049306100060, +49306100060 |  |

## 差距归因（未达 ≥80% 的部分）

- **同意墙/反爬壳（4 家）**：ksb.com、delock.de、allweiler.de、eheim-service.de —— 渲染出的可见文本不足 300 字节；
  markdown 与尾斜杠回退仍未取到正文。绕过同意墙/反爬不在本版合规边界内，需要单独的合规评估与渲染器配置能力。
- **只见电话或只见邮箱（4 家）**：schreiber-anlagenbau.de（7 邮箱 0 电话）、pumpen-plueckhahn.de（邮箱有、电话无）、
  apollo-goessnitz.de、de.milwaukeetool.eu（电话有、邮箱无）——联系方式很可能以图片发布或用了未覆盖的格式。
- **商城子域样本（1 家）**：shop.jesspumpen.de 与主站内容不同；主站域在试点中可正常命中。
- 说明：德国 TMG §5 要求 Impressum 提供电子邮箱，理论上覆盖应更高；上述缺口属**可工程化收敛**的面（渲染器、图片 OCR、
  更全格式），不是口径虚高。

## 后续项（已登记，未在本 PR 范围）

1. 渲染器侧：同意墙/JS 壳的处理（需合规评审——不绕过访问控制，但可评估标准的 cookie 选择器操作）。
2. 电话/邮箱图片发布的 OCR（本版明确不含）。
3. 更多电话格式（区号分隔「0 61 72 / 9 91 0-0」等）的确定性归一。
4. 样本扩到 50–100 家并复测（当前 20 家，单家波动 ±5pp）。

## 已知边界

- 反爬/同意墙站点（渲染文本 <300 字节且回退无效）与 robots 禁止的站点计为不可达/未命中——不绕过访问控制（合规红线）。
- 联系方式以图片发布的站点（无 OCR）不在本版口径内。
- `shop.*` 等商城子域若被登记为公司域，可能与其主站内容不同（样本按登记域原样计入）。
