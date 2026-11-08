# A1 落地设计 · Impressum/legal 页邮箱挖掘器（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP A1（产品负责人 2026-11-08 批准的 Phase 2 顺序 A4→A1；主会话指示「A1 是产品负责人最关心的德国邮箱覆盖率 70–90% 核心」）；调研口径见 `~/.claude/plans/reports/2026-11-08-contact-roadmap.html`。

## 1. 目标与 DoD

德国/奥地利（+瑞士）公司官网的 Impressum（法定出版信息）与联系页，法定公开 **role 邮箱与总机电话**。WP DoD（总纲 §A1）：

- 可达 Impressum 的 DE/AT 公司 **≥80% 产出 ≥1 个 role 邮箱 + ≥1 个电话**；
- mailto / 混淆解码 / 总机 / Geschäftsführer 全抽取；
- role 邮箱 `personalData=false` 落库为**公司级联系方式**（A4 的 `company_contact_channel` + 写入器）；
- 验收要附德语区真实样本的邮箱命中率证据。

## 2. 现状（复用面）

- `PublicWebDiscoveryProvider.discoverContacts` 已抓首页 + `contact|kontakt|impressum|imprint|about|legal` 链接页（`crawl4ai.fetch`，markdown，每页截 40k），`extractPublicContacts`（`adapters/contact-extractor.ts`）用确定性正则抽邮箱/tel:/国际电话/社媒——**无 LLM、无幻觉**；`buildPublicContacts` 产出 person 形状的 `ProviderContactRecord[]`，经 `persistDiscoveredContacts` 写 contact_point。
- robots：抓取前 `isAllowedByRobots(base)` 检查；`crawl4ai.render` 工具内部也强制 robots。
- `decision_maker` 有法律页链接评分 + `FIXED_PATHS`（/impressum、/kontakt…）可借鉴。
- A4 提供：分类器 `classifyContactEmail`、公司级写入器 `upsertCompanyContactChannels`、schema（email_type/source_type/source_url/robots_status/tos_status/legal_basis/verification_method 全有落点）。

## 3. 缺口（本 PR 的实现面）

1. **公司级落库路径**：adapter 契约无公司级渠道通道。扩展 `ContactDiscoveryResult` 增加可选 `companyChannels: CompanyChannelInput[]`；`contact-discovery-core`（已有 `loaded.company.id`）在**同一事务**里复读 suppression_record（email/domain 规范化比对）过滤后调 `upsertCompanyContactChannels`（与 contact 路径同纪律）。`crawl4ai.render` 加入联系人发现的持久回执生产者名单（否则回执回调会把 adapter 打成静默失败）。不新增 adapter（避开 `MAX_CONTACT_DISCOVERY_ADAPTERS=6`），升级现有 `public_web`。
2. **取数面**：现抽取只看 markdown，JSON-LD `contactPoint`（script 标签）与 Cloudflare cfemail（HTML 属性）不可达。对 impressum/contact 页改用 `crawl4ai.render`（原始 HTML，robots 内置强制），失败回退 markdown fetch。
3. **法律页发现**：首页链接评分（impressum/legal-notice 权重最高）+ 固定路径探测（DE/AT/CH 常见：/impressum、/impressum.html、/impressum/, /legal-notice、/imprint、/kontakt、/kontakt.html、/ueber-uns）；去重、同站点、上限页数不变。
4. **抽取升级**（确定性，无 LLM）：
   - `mailto:` href（decodeURIComponent，含 `?subject=` 修剪）；`tel:` href（已有）；
   - JSON-LD：`<script type="application/ld+json">` 里 `contactPoint`/`email`/`telephone`（组织级）；
   - cfemail：`data-cfemail`/`__cf_email__` XOR 解码（RFC 固定算法，纯函数）；
   - 文本混淆解码：`[at]/(at)/{at} [dot]/(dot)/{dot}`、`name (at) domain . de` 等常见形态；
   - 电话：`tel:` 与 +49/0xxx 语境的号码归一（去空格/括号/斜杠，保留前导 +；`(0)` 区号前缀归一——`+49 (0)89 …` → `+4989…`）——A4 评审 L7 指出的幂等归一在本层做。
5. **分类与分级**：邮箱一律过 `classifyContactEmail`；`role/generic_sales/procurement/management/finance/support/other` 直接作公司级渠道（amber）；判为 `personal` 的**不进公司层**，交既有 person 路径（contact_point）——守住 A4 的闸门。电话号码/表单 URL green。
   - **同组织域**：本站域（含子域）直接认可；Impressum 法定的联系邮箱常落在品牌/集团域（sanotact-group.de → info@sanotact.de、tsurumi.de → tsurumi.eu），按「非通用词根相交」认可；第三方（建站公司/gmail）词根不相交仍丢弃。该放宽只作用于公司级渠道层，contact 路径（buildPublicContacts）的「仅本站域」纪律不变。
   - **HTML 实体解码**：`info&#64;acme.de` / `&#105;nfo@…` 等防爬编码在 mailto 与可见文本两处都先解码再抽取。
6. **来源留痕**：每条渠道记 source_type（impressum/contact_page/homepage）、source_url（所在页）、robots_status=allowed、tos_status=unknown；verification_method 记 `pattern_guess`（未做 SMTP）或 `import`。

## 4. 非目标

- A6 发送合规门；SMTP 验证（A2 的范围）；邮件猜测；JSON-LD 的 `Person` 型条目的个人数据（与 role 邮箱同源但属个人，本轮丢弃）；展会/协会源（A10）。

## 5. 测试与验收

- 纯函数单测：cfemail 解码（真实样本）、JSON-LD 抽取（Person 子树跳过）、混淆解码矩阵、电话归一（国别补全/主干 0）、法律页候选发现（链接评分+固定路径），共 36 例；
- 装配测试：装配器 8 例 + provider 接线 1 例（mock crawl4ai.render/fetch → companyChannels、personal 剔除）+ core 落库 2 例（suppression email/domain 过滤、无渠道不写表）；
- 真库契约：company_contact_channel 已由 A4 的 postgres spec 覆盖；
- **DoD 证据**：`apps/api/scripts/impressum-evidence.mts`（可复现抽样：`md5(domain)` 排序；每次抓取前 robots 先检；直接复用产品抽取/装配代码），产出 `docs/evidence/acquisition/impressum-miner-<date>.json`（summary 命中率 + 逐域明细）。

## 6. 回退

纯增量（可选字段 + 新纯函数模块 + provider 内部升级）；回退 = revert 代码，DB 无迁移。

## 7. 独立审查后的修订（2026-11-08）

- **H1（致命）**：`crawl4ai.render` 不在 `contact.find_decision_makers.allowedTools` → ToolPolicyDenied 被归为 control error，整次联系人发现失败（#748 同类）。已加入白名单 + task-registry 快照与回归用例 + 治理 callsite 清单（脚本与 JSON 目录）。
- **H2**：网页可控值（sourceUrl/form_url/phone）在装配层 fail-safe 清洗（https/长度/空白/`+` 归一一律降级丢弃，绝不 throw）——防一条坏 URL 回滚整家公司所有 adapter 的事务。
- **H3**：`persistDiscoveredContacts` 返回 `suppressed` 信号；公司被抑制（SUPPRESSED / suppression 命中）时渠道一并放弃（补并发窗口用例）。
- **M1**：混淆邮箱正则全部有界（local ≤64 / label ≤63），40k 连续串从 38s 降至毫秒级（补用例）。
- **M2**：同组织域改为**词根完全相等**并拒绝冒充形态（peter.de.evil.com）；前缀启发式移除（会误收 peters-webdesign.de ↔ peter.de）。
- **M3**：`other` 分类的单段缩写 local（ds@/mm@）不冒认公司渠道（≥4 字母词形态保留，如 impressum@）。
- **M4**：证据口径按实修正（脚本的首页取链/maxPages 与产品默认不同；"role 邮箱"列含 other；电话列截断说明）。
- **M5**：技术预算信封补 `crawl4ai.render` 计数与 public_web 回退上限（fetch 14 / render 8，cap 274¢）。
- **M6**：`MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES` 2→4；固定路径按 kind 交替给全变体（/impressum、/kontakt、/impressum/…），404 时预算内可试下一个。
- L1/L4/L5/L6：cfemail 分块解码、脚本尾斜杠抓取补 robots 检查、schema URI Person 跳过、渠道条数防御性上限（32）。
