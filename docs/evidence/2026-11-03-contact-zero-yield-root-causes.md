# 零产出公司联系人抓取盲区排查（2026-11-03）

> 结论先行：M5 第三轮（[Golden Set 评估](2026-11-03-contact-golden-set-m5.md) §9）后仍零产出的 4 家
> 德/奥公司，**三家是引擎盲区、一家是输入数据质量**：`avag-pumpen.de` 卡在裸域 robots 的坏跳转
> （fail-closed 成「全站禁抓」）；`ava-berlin.de` 卡在 #748 的「markdown 人物页链接不足 3 条才补
> 原始 HTML」门槛（恰好 3 条，真实 Impressum 只在原始 HTML 锚点里）；`michalowski-gmbh.de` 选页正确，
> 但链接规范化剥掉尾斜杠，站点对无斜杠形态返回 39 字节反爬空壳、crawl4ai 全部 500；
> `jaeckel-ohg.de` 的 Impressum 确无具名人，但**首页团队区块**列了具名执行合伙人/销售/商务并附邮箱，
> 而引擎从不抽取首页自身。修复见
> [changelog 片段](../roadmap/changelog.d/2026-11-03-contact-zero-yield-root-causes.md)。
>
> 口径：数据来自本地栈镜像 `fe0c7d71`（源 `4133259f`，含 #744/#748）。方法是用镜像内**同源编译产物**
> 重放选页/robots 纯函数 + 引擎同款 crawl4ai `/md` 抓取 + `http.get` 同 UA 抓原始 HTML，并对照
> API 与 crawl4ai 服务日志。**本报告不含任何个人姓名**（人名数据仅存于本机临时目录）。

## 1. 逐家根因与证据

### 1.1 `avag-pumpen.de` — 裸域 robots.txt 的坏跳转把整站误判为禁抓

| 证据 | 结果 |
| --- | --- |
| API 日志 | `[decision_maker] skip avag-pumpen.de: robots disallow`（discover 12 秒返回 0 人） |
| `GET https://avag-pumpen.de/robots.txt` | 301，`Location: https://www.avag-pumpen.derobots.txt`（主机与文件名直接拼接、缺 `/`） |
| 该 Location 主机 | DNS 不存在 → `requestPublicHttp` 抛 `EgressBlockedError(dns_lookup_failed)` → `loadRobots` 按安全拒绝 fail-closed 成 `Disallow: /` |
| 对照：`https://www.avag-pumpen.de/robots.txt` | 200，无 `Disallow`；`isAllowedByRobots` 实测 `true` |
| 对照：`https://avag-pumpen.de/` | 301 → `https://www.avag-pumpen.de/`，200 |
| 内容侧 | `crawl4ai /md` 抓 `/unternehmen/impressum` 返回 668 字符 markdown，含具名 Vertreten durch |

站点可抓、页面可达、内容够抽取；唯一阻塞是裸域 robots 的 fail-closed。robots 约束实际被抓取的
origin——改从 www origin 抓取并以其自身 robots 为准即可。

### 1.2 `ava-berlin.de` — 选页门槛让真实 Impressum 从未入选

| 证据 | 结果 |
| --- | --- |
| API 日志 | `[decision_maker] ✓ ava-berlin.de: 0 named people`（84 秒，抓了 4 页） |
| 镜像内选页重放 | markdown 打分链接恰为 3 条：`/ueber-uns`、`/ueber-uns/hier-finden-sie-uns`、`/common/info/kontakt.html`；`scoredFromMarkdown < 3` 为假 → #748 的原始 HTML 补抽**未触发** |
| 真实 Impressum | 只在首页原始 HTML 锚点里（相对路径 `common/info/impressum.html`）；强制跑补抽时它得 100 分、排第一 |
| 固定路径 | `https://ava-berlin.de/impressum`（裸域）返回站点 404 页（crawl4ai 得 264 字符 404 文本） |
| 内容侧 | 抓真实 Impressum 页（`/common/info/impressum.html`）得 6461 字符 markdown，含 Geschäftsleitung 具名两人 |

### 1.3 `michalowski-gmbh.de` — 尾斜杠被剥掉，可抓 URL 换成反爬空壳

| 证据 | 结果 |
| --- | --- |
| API 日志 | `[decision_maker] ✓ michalowski-gmbh.de: 0 named people`（31 秒） |
| crawl4ai 服务日志 | 四个被选页面各报 `Blocked by anti-bot protection: Near-empty content (39 bytes) with HTTP 200`（HTTP 500 给引擎）：`/impressum`、`/our-team/thomas-kathmann`、`/our-team/sylvia-kathmann`、`/our-team/luca-kathmann` |
| 对照：带斜杠形态 | `curl` 对 `/impressum/` 200/67 KiB；`crawl4ai /md` 重试 `/impressum/` 成功，markdown 含具名 Geschäftsführer |
| 选页来源 | 首页原始 HTML 锚点本身就是带斜杠形态（`href="https://michalowski-gmbh.de/impressum/"`）；markdown 链接同样带斜杠 |

根因：`extractSameSiteLinks` / `extractAnchorsFromHtml` 的归一化把**返回的 URL** 也剥掉了尾斜杠
（去重目的只需归一化键）。保留站点原始形态后，四个页面都可抓且含具名人。

### 1.4 `jaeckel-ohg.de` — 团队只在首页；社媒命中确为无关同名者

| 证据 | 结果 |
| --- | --- |
| API 日志 | `[decision_maker] ✓ jaeckel-ohg.de: 0 named people`；回执 `diagnostics.social_namesake_dropped: 6` |
| Impressum/Kontakt 文本 | 确无具名人（`Verantwortlich: <公司名>`） |
| 首页 markdown（3110 字符） | 含 `Unser Team:` 区块：两位 geschäftsführender Gesellschafter、技术销售/商务等 6 人，附邮箱 |
| 社媒层 | DB 公司名是域名 slug（`jaeckel-ohg`），按其构造的 dork 在 searxng 上只回无关同名者（4 个国家、职业完全不符）；6 条被同名守卫丢弃属**正确行为** |

引擎只用首页做链接发现、从不把首页本身作为抽取目标——这是本家的直接盲区。社媒另有一条输入数据
质量问题：用真实名称检索能找到在职人员，但 DB 公司名是 slug，dork 引号搜 slug 得不到正确结果；
该问题属公司补全/命名归一，另行排期。

## 2. 修复要点（同 PR）

1. **robots**：存储域名 robots 被拒时，改判同注册域的另一主机形态（裸域 ⇄ www）的 robots；
   放行则以该 origin 为抓取起点，两个形态都拒绝才放弃。
2. **补抽门槛**：原始 HTML 锚点补抽不再以「markdown 人物页链接不足 3 条」为前提。
3. **URL 形态**：锚点与 markdown 链接保留站点给出的原始形态（含尾斜杠）；同一路径两种写法都
   出现时优先带斜杠的形态，只用归一化键去重。
4. **首页兜底抽取**：选定人物页一个人都没抽到时，抽取已抓到的首页文本（不额外抓取）。

## 3. 未覆盖

- 不回溯已入库的旧结果（重抓会把存量误报行的统计继续放大，需另行设计清理口径）。
- `jaeckel-ohg.de` 的公司名归一未在本次修复范围内（见 §1.4）。
- `ava-berlin.de` 在 DB 有两条同域公司记录（`AVA Berlin` / `AVA Fachgroßhandel`），本次未合并去重。
