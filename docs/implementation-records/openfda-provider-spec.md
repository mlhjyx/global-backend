> 【Implementation Record 2026-07-10】P1 器械注册发现 / P2 ICP→FDA 产品码 / P3 510(k) intent / P5 Schedule 已完成（PR #34/#36/#37/#38）；剩余 P4 富集/monitoring/foiclass 全表种子。规格正文以「§8 审查修正」+ 现有代码为准。
> 【现行流程覆盖】正文中旧的 `docs/feat` 分支、自审、自合并等表述只记录当时过程；当前统一使用 `codex/<topic>` + PR + CI/Codex 审查，合并须用户明确确认，权威规则见 [../../AGENTS.md](../../AGENTS.md) §8。

# openFDA 认证/注册库 Provider — 落地规格（build-ready）

> 2026-07-08 定。给**下一个开工会话**的权威实施规格。API 事实**均为当日活体实测**(curl 真打 `api.fda.gov`)；映射+合规经研究 agent 附实链核实。用哪个数字/字段直接照抄本文。
> **与 [ted-provider-spec.md](ted-provider-spec.md) 同构**——集成接缝(§4)完全复用 TED 那份(同 `public_intelligence` discovery/enrich 模式)，本文只写 openFDA 特有的 API 契约 / ICP→产品码映射 / 合规 / 端点接缝映射。
> 上游：[buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)（P1「认证注册库」）· [positioning-and-acquisition-backlog.md](../research/positioning-and-acquisition-backlog.md) §5 #2。
> 硬规矩：真实数据、无 sandbox（§5）；多租户、**绝不硬编码行业/国家**（§2）；合规红线（§3）。

---

## 0. 为什么做 openFDA / 它给什么

**openFDA = 美国 FDA 官方开放数据 API**(药品/器械/食品的注册、清关、召回、不良事件)。零鉴权、CC0 公共领域、官方 REST——是本轮又一个**最干净、当天可验证**的免费获客源。

**一句话价值:FDA 注册/清关库 = 一份「正在合规卖进美国」的规管品类活跃公司名单。**「注册人 = 合规卖家」；510(k) 具名申请人 + 决定日 = 新品/时机信号。

| openFDA 载荷 | 对我们的价值 | 落到哪 |
|---|---|---|
| **器械注册目录** `device/registrationlisting`(在美注册的制造商+进口商) | **可解析的活跃公司**(潜在客户/竞品/**美国进口渠道**) | `canonical_company`(走既有 discovery 管线) |
| **510(k) 清关** `device/510k`(具名申请人 + 决定日 + 产品码) | **具名公司 + 时机(新品清关)** | `canonical_company` + `attributes.intent.events[{type:'FDA_CLEARANCE'}]` |
| 产品码/器械类/专科/法规号(`device/classification` + 每记录 `openfda` 块) | 分类事实、ICP 匹配键 | `attributes.fda.*` |
| 召回 `*/enforcement` · 药品 `drug/ndc`(labeler=药企) | 质量信号(🟡，慎用)· 药企名单 | 见 §3 |

**⚠️ 文案红线(§3.B.1.2)**：FDA 明文「**注册/收录 ≠ 核准/认证/背书**」。**绝不**把 registrant 标为「FDA 认证/批准企业」；统一措辞「已在 FDA 注册/清关的 <品类> establishment(自报事实，非 FDA 核准)」。

---

## 1. 活 API 契约（2026-07-08 实测，可直接照抄）

**基址** `https://api.fda.gov` · JSON · **零鉴权**(keyless 直接 HTTP 200)。由 **api.data.gov / api-umbrella** 前置。

**限流**(api-umbrella 强制，响应无 `X-RateLimit` 头，靠 429 感知)：**无 key = 240 req/min + 1,000/天/IP**；**免费 key = 240/min + 120,000/天**(`?api_key=…`)。超限 → **HTTP 429 `OVER_RATE_LIMIT`**。→ 客户端自限 + 退避；全量抓取当低 QPS 长任务；**建议配一个免费 key**(env，走 `.env`，同中转站 key 管理)。

### 1.1 查询语法

`?search=<field>:<value>&limit=<N>&skip=<M>&count=<field>`：

| 能力 | 语法 | 实测例 |
|---|---|---|
| 等值 | `field:value` | `product_code:LLZ` |
| 布尔 | `AND` / `OR`(空格 URL 编码) | `country_code:CN AND decision_date:[2024-01-01 TO 2024-12-31]` |
| 精确(聚合/多词) | `field.exact` | `count=applicant.exact` |
| 日期范围 | `field:[YYYY-MM-DD TO YYYY-MM-DD]` | `decision_date:[2024-01-01 TO 2024-12-31]`(**用 `curl -G --data-urlencode` 或 `%5B…%5D` 编码括号**，裸括号会空返) |
| 嵌套字段 | 点号 | `registration.iso_country_code:CN` · `openfda.medical_specialty_description:Cardiovascular` |
| 缺字段 | `_missing_` / `_exists_` | `_exists_:contact` |

- **`count=<field>.exact` = 服务端聚合**(招牌功能)：秒出 top terms + 计数，**不拉全量**。实测 `count=applicant.exact` → `[Abbott 883, Siemens 782, C.R.Bard 645…]`。用于「某品类/国别谁最活跃」「枚举 distinct 值」。
- **无 `fields` 投影**(不同于 TED)——响应是**全字段记录**，消费方自己取需要的字段。

### 1.2 分页

- `limit` 每调最大 **1000**；`skip` 上限 **25,000**(实测超了报 `Skip value must 25000 or less.`)。
- **深翻 > 25,000 → `search_after` 游标**(openFDA 新增，类 TED 的 iteration token；保持 `search`/`sort` 不变逐页推进)。
- **多数 ICP 查询不需要深翻**：`count` 聚合 + 有界 product-code/国别过滤通常几千条内；真要全量历史才用 `search_after`。

### 1.3 响应结构

```jsonc
{ "meta": { "disclaimer": "...", "terms": "https://open.fda.gov/terms/",
            "license": "https://open.fda.gov/license/",  // CC0
            "last_updated": "2026-…", "results": { "skip":0, "limit":1, "total":175456 } },
  "results": [ { …记录… } ] }
```
- **`meta.results.total`** = 该 query 命中总数(sizing 用，`limit=1` 即可取)。
- **0 命中 → `{"error":{"code":"NOT_FOUND",...}}`**(合法 JSON，无 `results`)——消费方须判 `error`。
- **`openfda` 谐调块**：openFDA 给每条记录挂交叉链接字典(`device_class`/`medical_specialty_description`/`regulation_number`/`product_code`/`registration_number`；药侧 `manufacturer_name`/`pharm_class`/`application_number` 等)。**谐调是精确匹配，失败即整块缺失**——把 `openfda` 缺块/缺字段**当 null**；分类维**以记录自带 `product_code` 为准键、`openfda` 为便利富集**。

### 1.4 核心端点 + 记录字段（实测计数与结构）

| 端点 | total(实测) | 关键字段 | 对我们 |
|---|---|---|---|
| **`device/registrationlisting.json`** | 328,497(**CN 41,326**) | `establishment_type[]`、`registration{registration_number, fei_number, name, address_line_1/2, city, state_code, iso_country_code, zip_code, us_agent🔴, owner_operator, initial_importer_flag, status_code}`、`products[{product_code, created_date, exempt, openfda}]` | **公司名单主源**：在美注册的制造商/进口商 |
| **`device/510k.json`** | 175,456(2024=3,129；**CN 制造商 2024=509**) | `k_number, applicant, contact🔴, product_code, decision_date, decision_code, decision_description, country_code, device_name, address_1/2, city, state, zip_code, clearance_type, date_received, openfda{device_class, medical_specialty_description, regulation_number, registration_number, fei_number}` | **具名公司 + 时机**：`decision_date`→intent |
| **`device/classification.json`** | (全 product code 字典) | `product_code, device_name, device_class, medical_specialty_description, regulation_number, review_panel, submission_type_id, definition, gmp_exempt_flag, implant_flag` | ICP→产品码映射的**字典表**(§2) |
| `device/pma.json` | (PMA 批准) | `pma_number, applicant, decision_date, product_code, openfda` | 高风险器械批准(同 510k 形态) |
| `device/enforcement.json` | 39,430 | `recalling_firm, product_description, reason_for_recall, recall_initiation_date, classification, distribution_pattern, country` | 召回=🟡质量信号(慎用，§3) |
| `drug/ndc.json` | 136,658 | `labeler_name(=公司), brand_name, product_type, product_ndc, pharm_class, application_number, openfda` | 药企名单(§2.5) |
| `drug/enforcement.json` · `drug/drugsfda.json` | — | 同上族 | 药侧召回/批准 |
| `device/event.json`(MAUDE)· `drug/event.json`(FAERS) | — | 不良事件叙述 | **🔴🔴 默认 out-of-scope**(患者数据，§3) |

---

## 2. ICP → FDA 产品码映射设计（多租户，不硬编码）

### 2.1 FDA 器械分类体系（= CPV 的类比杠杆，但结构不同）

四层交叉、写死在 **21 CFR Parts 862–892**：

| 维度 | 是什么 | 例 | openFDA 字段 |
|---|---|---|---|
| **Product code** | **3 字母**码，标识一个通用器械类型。**过滤 registration/510k 到 ICP 品类的主杠杆**(~6,000 活跃码) | `LLZ`(放射影像处理系统) | `product_code` |
| **Device class** | 风险类 **I/II/III**(I 多豁免·II 走 510(k)·III 走 PMA)；openFDA 返 `"1"/"2"/"3"`(另 `"U"/"N"/"F"`) | `2` | `device_class` |
| **Medical specialty / panel** | **16 个专科评审组**(2 字母码 + 全称) | `RA`→Radiology · `CV`→Cardiovascular | `medical_specialty`(2 字母)· `medical_specialty_description` |
| **Regulation number** | CFR 条款号 | `892.2050` | `regulation_number` |

**`device/classification` 就是绑定这四维的字典表**(实测 `product_code:LLZ` → device_name/class 2/Radiology/892.2050)。

**⚠️ 与 CPV 的关键差异(codegen 别照搬)**：CPV 是**数字前缀嵌套**(截位放宽)；**product code 是 3 字母不透明码、无前缀层级**。放宽/收窄**不靠截位**，靠**沿 panel(16)或 device_class 两个父维聚合**。→ taxonomy 的 `parentCode` 必须**显式建 panel 父维**，不能指望字符串前缀。

**⚠️ 纠正 panel 数**：CFR 分类 panel = **16**(非 19；19 是另一套咨询委员会口径)。**建库以 openFDA `medical_specialty_description` 的活枚举为准**(建库时打一遍 `/device/classification` 取 distinct)。

### 2.2 复用既有 taxonomy（不新造，加两个 kind）

`CanonicalTaxonomy`/`TermAlias`/`TaxonomyResolver`(`apps/api/src/discovery/taxonomy-resolver.ts`)现成，新增：

| 列 | FDA 用法 |
|---|---|
| `kind` | 加 `fda_product_code`(叶)+ `fda_panel`(父，16 专科)；`fda_device_class`(可选二级父) |
| `scheme` | 加 `FDA_PRODUCT_CODE`(叶)/ `FDA_PANEL` |
| `code` | 叶 = 3 字母 product code(`LLZ`)；父 = panel 2 字母码(`RA`) |
| `parentCode` | **叶.parentCode = 其 panel 2 字母码**(自引用层级，同 ISIC 子树)。**显式建，不靠前缀** |
| `labels` | `{en: device_name, zh: <译>}`(zh 冷路径补) |
| `crosswalks` | 叶存 `{deviceClass, regulationNumber, panel}`；**ISIC/product 节点存 `{fdaProductCodes:[...]}` 或 `{fdaPanels:[...]}` 做 crosswalk** |

**权威种子源**：
- **`foiclass.zip`**(`https://www.accessdata.fda.gov/premarket/ftparea/foiclass.zip`)——`|` 分隔全表，含全部 product code + name + class + panel(2 字母)+ regulation。**离线全量 CC0，种子主源。**
- `/device/classification` 端点——同数据 JSON 化，**二次种子/校验**(建库顺手 dump distinct panel/class 校准枚举)。

### 2.3 推荐 =（c）混合：crosswalk 锚定 + LLM 子树内精修 + alias 缓存

与 TED §2.3 同哲学(确定性种子 + 冷路径 LLM 回填，LLM enum 始终有界)。

```
resolveIcpToFda(icp)  // 冷路径，ICP 保存/查询计划时，非发现热路径
输入: icp.industry(自由文本) · icp.product(可选) · icp.tradeSide(见 2.4)
1. panelCandidates ← industryNode.crosswalks.fdaPanels          // ISIC→panel crosswalk，确定性 0 成本
   (无 crosswalk → LLM 冷路径把 industry 归到 16 panel 之一，enum=16 极小)
2. if product:
     alias 命中 TermAlias('fda_product_code', norm(product)) → 用
     否则 LLM 精修: enum = **仅 panelCandidates 子树下的 product codes**(单 panel 数百量级，有界)
                    → 挑最匹配码 → upsert TermAlias(...,'llm')
     否则: panel 级宽网 → 展开 panelCandidates 下全部 product codes
3. breadth: 宽 ICP → 传 panel(用 openfda.medical_specialty_description 过滤，一次抓整专科)；
            窄 ICP → 具体 product code 集(products.product_code IN (...))
4. tradeSide/country → 见 2.4
5. return { productCodes[], panels[], deviceClasses[], establishmentTypeFilter, countryFilter }
```
**三层缓存**(均已支持)：平台种子(foiclass 全表 + ISIC↔panel crosswalk)· `TermAlias(kind='fda_product_code')` 沉淀 LLM · **每 workspace 落 `{productCodes,panels}` 在 ICP 记录 → 查询纯读**。

**⚠️ 实现约束**(同 TED §2.4 坑)：`TaxonomyResolver.llmResolve` 现把整个 kind 目录塞进 prompt(`slice(0,6000)`)——~6,000 product code **必爆/截断**。**LLM enum 永远限于 panel 子树**(单 panel 数百)，归 panel 那步 enum=16。**绝不 `resolve('fda_product_code', term)` 打全表。**

### 2.4 国家视角（FDA = 全美市场，与 TED 的 EU-only 正相反）

TED 覆盖门可能空返；**FDA 相反——每条 registration 都是「在卖进美国」**，registrant 即美国市场合规卖家，**无「目标市场不覆盖」空返**。国家维在 FDA 是**「贸易哪一侧」**，由两字段定：

- **`registration.iso_country_code`**：establishment 所在国。CN exporter ICP → `iso_country_code:CN` 捞「注册在华、卖器械进美国的制造商」(实测 41,326 家)= 潜在客户/竞品/同行。
- **`establishment_type[]`**：贸易角色——`Manufacturer` / `Contract Manufacturer` / `Foreign Exporter` / **`Importer`(美国进口商)** / `Repackager/Relabeler` / `Contract Sterilizer` 等：
  - ICP=「找中国同类制造商」→ `iso_country_code:CN AND establishment_type:Manufacturer`。
  - ICP=「找某品类**美国进口商/分销商**(=中国卖家的潜在美国买家/渠道)」→ **`registration.initial_importer_flag:Y`**(实测 60,282;**⚠️ 无 `Importer` establishment_type,见 §8.1——`establishment_type:Importer` 是错的**)+ product code。**这是出海卖家最想要的一侧。**

**映射规则**：`icp.targetMarket` 恒 = US(FDA 前提)→ **不产生覆盖 warning**；要在 ICP 里让租户选的是**「贸易哪一侧」**(找同行制造商 vs 找美国进口渠道)→ 落成 `establishmentTypeFilter`。**建库前打一遍 `/device/registrationlisting` 取 `establishment_type` distinct 枚举**(以活数据为准，别硬编码)。

### 2.5 药/食品类比（次要，v1 主攻器械）

- **药**(`drug/ndc`, `drug/drugsfda`)：杠杆 = `product_type`(如 `HUMAN PRESCRIPTION DRUG`)+ `pharm_class[]` + `application_number`(NDA/ANDA/BLA)；**公司键 = `labeler_name`**。⚠️ NDC 收录 ≠ FDA 核准(§3)。无「3 字母锐键」→ 映射靠 `pharm_class`+`product_type` 组合，精度弱于器械。
- **食品**：openFDA 食品侧**只有 `food/enforcement`(召回)+ `food/event`，无注册目录 API**(FFR 不经 openFDA)→ 食品 ICP 在 openFDA 基本只有召回信号，**不是干净的卖家名单源**。**食品 exporter 不走 openFDA**，backlog 注记即可。

---

## 3. 合规分级 + 硬约束（照抄，别猜 license）

### 3.1 openFDA / FDA 数据条款（已核实原文）

据 **openFDA Terms**(`https://open.fda.gov/terms/`)+ License(`https://open.fda.gov/license/`)：
- **公共领域 + CC0 1.0**：「public domain and made available with a **Creative Commons CC0 1.0 Universal** dedication.」→ **比 TED 更宽**(TED 是 CC BY 强制署名；**openFDA CC0，署名 requested 但 not required**)。
- **可商用**：「copy, modify, distribute, and perform the work, **even for commercial purposes**, all without asking permission.」
- **第三方例外**：非公共领域的记录会「clearly marked by a warning」——见 warning 标记的**不当 CC0**。
- **as-is 无担保**；明确免责(必须进 spec，影响「怎么用」)：
  1. **非临床/生产用**：「Do not rely on openFDA to make decisions regarding medical care.」→ 我们只做获客线索，**不得**呈现为医疗/质量背书。
  2. **注册 ≠ FDA 核准/认证/背书**(FDA 明文；`drug/ndc`「Inclusion … does not indicate FDA has verified」「NDC number does not denote FDA approval」)→ **文案红线**(§0)。
  3. **不用于识别个人**：openFDA 只服务已公开数据；FAERS 去标识化。→ **不得**反向识别自然人。
  4. **passive surveillance 不确定性**：MAUDE/FAERS「causal relationship cannot be established」→ 不良事件**不能**当质量判据。

> **净结论**：FDA 数据 **copyright 轨最干净(CC0，可商用、无署名义务)**——比 TED 还松。但 **GDPR/隐私轨与版权轨正交**(同 TED §3.2 Clearview 原则)：CC0 只清版权，**不给处理个人数据的 GDPR 依据**。凡记录点名自然人(`us_agent.name`/`contact`/narrative)，仍 🔴。

### 3.2 分级表

| FDA 数据元 | 级 | 为什么 | 处置 |
|---|---|---|---|
| establishment 名/址/`iso_country_code`/`establishment_type`/`registration_number`/`fei_number` | 🟢 | 公共领域(CC0)法人事实 | 绿库 → `canonical_company`。附 provenance(source=openfda、endpoint、record id、`created_date`)+ **标注「注册≠核准」** |
| product code/device_class/panel/regulation_number(含 `openfda` 块) | 🟢 | CC0 分类事实，非个人 | 入库；主 ICP 匹配键 |
| **510(k)** `applicant`/`k_number`/`decision_date`/`decision_code`/`device_name` · **PMA** · `drug/ndc` `labeler_name`/`pharm_class` | 🟢 | 公开清关/收录事实；法人=活跃卖家 | 绿库。**`decision_date` → `attributes.intent.events[{type:'FDA_CLEARANCE', at:decision_date, strength}]`**(镜像 TED intent 投影)。*边界*：个体户申请人→🔴 |
| establishment **职能联系**：`us_agent.business_name`(公司)、`regulatory@`/`info@`、总机 | 🟡 | 职能非明确自然人 | 可存；触达仅走合规渠道(ePrivacy/CAN-SPAM)，不当纯绿事实自由外发 |
| **`us_agent.name`/`contact`(具名个人)、具名邮箱、official correspondent** | 🔴 | 可识别个人数据(GDPR Art.4)；CC0 不给 GDPR 依据 | `personalData=true`；隔离/加密存，非绿库；EU/UK 自然人 → LIA+Art.14+保留期。**复用 `decision_maker`/`contact-persist.ts`** |
| **MAUDE/FAERS 不良事件叙述**(`mdr_text`/患者/reporter) | 🔴🔴**建议 out-of-scope** | 患者健康数据 + 偶含 reporter 身份；因果不成立、passive-surveillance 偏差 | **默认不进管线**。获客只需「谁卖什么」；患者数据**永不进绿库** |
| `*/enforcement` 召回：`recalling_firm`/`product_description`/`reason_for_recall` | 🟡 | 公司+召回事实公共领域，但语义敏感(负面)+ `reason` 偶含个人 | 可存公司/品类维事实；**不做负面画像/黑名单**；`reason` 疑含个人即 🔴 |
| 源署名串(openFDA/FDA、endpoint、CC0) | 🟢(建议非义务) | CC0 不强制署名 | 存 provenance；展示可附「Source: openFDA (U.S. FDA), public domain (CC0 1.0)」 |

### 3.3 硬约束（openFDA provider 必守）

1. **绿事实可商用、无强制署名(CC0)**：establishment/510k/PMA/NDC/产品码/日期 → 绿库；仍存 provenance。署名建议展示但**非 license 义务**(**与 TED 强制 CC BY 不同，别照搬**)。
2. **「注册/收录 ≠ FDA 核准」文案红线**：内部标签 + 对外呈现**绝不**称「FDA 认证/批准企业」；统一「已在 FDA 注册/清关的 <品类> establishment(自报，非 FDA 核准)」。
3. **具名个人(`us_agent.name`/`contact`/correspondent)= 🔴**：绝不写绿事实表；加密隔离 + `personalData=true`；EU/UK 自然人 LIA+Art.14。复用 `decision_maker`/`contact-persist.ts`。**License ≠ GDPR 依据**。
4. **不良事件(MAUDE/FAERS)默认 out-of-scope**：不摄入 narrative/患者/reporter；患者数据**永不进绿库**；要召回信号仅取 `*/enforcement` 公司-品类聚合维，不做负面画像。
5. **不识别个人 / 不做医疗判断**：遵免责——不反向识别自然人、不呈现为医疗/质量背书。
6. **边界：自然人经济体**：个体户 registrant/个人 510k 申请人 → 记录升 🔴。
7. **正确注册源**(平台合约轨比 RX/Algolia 干净——官方 API、CC0、明文可商用，非爬)：
   - `data_provider(key='openfda', class='public_intelligence', status='ENABLED', costPerCallCents=0)`
   - `source_policy(domain='api.fda.gov', sourceType='registry', accessMode='api', reviewStatus='APPROVED', personalData=true, allowedPurpose=['discovery','enrichment'], retentionDays=<设定>)` —— **`personalData=true`**(记录可能含 `us_agent`/`contact` 具名人)。
8. **第三方 warning 例外**：摄入前查 CC0 warning 标记；标记为非公共领域的记录**不当 CC0**。

---

## 4. 集成接缝（复用 TED §4，只列 openFDA 特有映射）

**代码库接缝与 TED 完全同构**——归 `public_intelligence` 类，`CompanyDiscoveryAdapter`/`CompanyEnrichmentAdapter` 契约、`executeQuery` fan-out、`canonicalizeRun`/`enrichRun`、`name-match`/`identity`、注册(`provider.registry.ts` 构造器 push + `seed()` upsert)、评分钩子(`attributes.intent.events`)、种子两处启动点——**全部照 [ted-provider-spec.md](ted-provider-spec.md) §4**。此处只列 openFDA 差异：

### 4.1 端点 → 接缝映射

| 接缝 | openFDA 端点 | 说明 |
|---|---|---|
| **DISCOVERY**(公司→canonical)**先做** | `device/registrationlisting`(公司名单)+ `device/510k`(具名申请人) | `CompanyDiscoveryAdapter`(`key='openfda'`)。establishment/applicant → `ProviderCompanyRecord`。**解析键**：优先 `registration.name`+`iso_country_code`(无域名)；510k 有 `applicant`+`country_code`。**多数记录无官网** → 靠 `name+country` 走 `identity.ts` dedupeKey(域名精确不可得时的 `n:<normName>:<country>` 路径) |
| **INTENT**(动分) | `device/510k` / `device/pma` 的 `decision_date` | projection：清关 → 解析 canonical → `attributes.intent.events[{type:'FDA_CLEARANCE', at:decision_date, strength}]`。**新增 event type 无需改评分**(TED §4.4；要自定强度在 projection 设) |
| **ENRICH**(可选) | `device/classification` + 记录 `openfda` 块 | `attributes.fda.*`(产品码/class/panel/regulation)；同 `gleif`/`wikidata` 命名空间/幂等/`FieldEvidence`(`license:'CC0-1.0'`) |
| **MONITORING**(后延) | 定时扫新 registration/510k(`created_date`/`decision_date` 增量) | 同 TED §4.1 的 monitoring gap 注意(`TenantProjectionService.projectSource` 无调用者，走 monitoring 须补 projection sweep) |

### 4.2 openFDA 特有实现点

- **无 `fields` 投影** → HTTP 客户端取全记录后自己挑字段(TED 有 `fields`，openFDA 没有)。
- **`count` 聚合优先**：sizing / 「某国某品类 top 公司」用 `count=applicant.exact` / `count=registration.name.exact`，避免拉全量(比 TED 更省)。
- **`meta.results.total` + `error.NOT_FOUND` 判空**：0 命中返 `error` 非空 `results`，客户端必判。
- **`skip≤25000` + `search_after` 深翻**：全量历史才需要，ICP 有界查询通常不用。
- **免费 API key** 走 `.env`(`OPENFDA_API_KEY`，同中转站 key 管理)，提配额到 120k/天。

### 4.3 文件清单（照 TED §4.6，openFDA 版）

**建**：`apps/api/src/adapters/openfda-api.ts`(HTTP 客户端：search 构造/count/分页/`openfda` 块解包/缺块当 null)· `apps/api/src/discovery/providers/openfda.provider.ts`(+`.spec`，**先做**注册发现)· `openfda-enrich.provider.ts`(+`.spec`，可选)· `apps/api/src/intent/openfda-intent-projection.service.ts`(510k→`FDA_CLEARANCE`)· `apps/api/src/discovery/icp-to-fda.ts`(+`.spec`)· `apps/api/scripts/seed-fda-classification.mjs`(foiclass 全表 + ISIC↔panel crosswalk)· `apps/api/scripts/verify-openfda-*.mts`。
**改**：`provider.registry.ts`(push 实例 + `seed()` 加 `openfda`)· `packages/db/prisma/schema.prisma` + migration **仅当**加 `source_policy` SQL 种子(`attributes.fda.*`/`attributes.intent.*` 免 migration)· `seed-taxonomy.mjs` 或新 seed-fda(FDA taxonomy)。
**零改复用**：`discovery.activities.ts` fan-out/`canonicalizeRun`/`enrichRun`、`name-match.ts`、`identity.ts`、`scoring.ts`(intent 维通用)。

---

## 5. 建议实施顺序（TDD + 真实数据，分阶段小 PR）

> 每阶段：测试先行(RED)→ 实现(GREEN)→ `pnpm --filter @global/api build && test` → provider 类改动**另跑真实 verify 脚本**(无 sandbox)→ docs/feat 分支 PR + CI 绿 + 自审自合。

1. **P1 — openFDA HTTP 客户端 + 器械注册发现(最快见价值)**
   `openfda-api.ts`(search/count/分页/`openfda` 块/判 `error`)+ `openfda.provider.ts`(`device/registrationlisting` establishment → `ProviderCompanyRecord`，`name+iso_country_code` 解析；`establishment_type` 分侧)+ 注册 + 种子。verify：真跑一个 ICP(如「放射影像器械，找美国进口商」→ product code + `establishment_type:Importer`)落 canonical 过 fit。
2. **P2 — ICP→FDA 产品码映射**
   `foiclass.zip` 全表 + ISIC↔panel crosswalk 种子 + `resolveIcpToFda`(混合，LLM enum 限 panel 子树)+ `tradeSide`/`establishmentTypeFilter`。verify：几个真 ICP 文本 → product code 集，人工核对。
3. **P3 — 510(k) → Intent 投影(动分)**
   `openfda-intent-projection.service.ts`：清关 `applicant`+`decision_date` → canonical → `attributes.intent.events[{type:'FDA_CLEARANCE'}]`。verify：真 510k → 目标公司 Intent 维 0→N、总分抬升(仿 `verify-intent-loop.mts`)。
4. **P4(可选)— `attributes.fda.*` 富集**(分类事实/清关历史)。
5. **P5(后延)— Monitoring sweep**(定时扫新注册/清关 + 补 projection gap)。
6. **横切 — 合规**：§3.3 硬约束(绿事实带 provenance + 「注册≠核准」语义；`us_agent.name`/`contact` 🔴 隔离 + `personalData=true` + `contact-persist.ts`；**MAUDE/FAERS 不摄入**；`source_policy` `personalData=true`)。

**验收(dev 有界样本，真库真 API，无 sandbox)**：一个真 ICP 端到端——ICP→FDA 产品码解析 → 拉真注册/清关 → 落 canonical 过 fit → 510k 投影动 Intent 分 → 具名联系人正确进 🔴 隔离、「注册≠核准」语义正确。**别 grind 全量**(32 万注册/17 万 510k 是 Schedule 增量蚕食的活)。

---

## 6. 建库前必探清单

- [ ] `establishment_type` distinct 枚举(打 `/device/registrationlisting` 取全值，别硬编码 §2.4 清单)。
- [ ] `medical_specialty_description` distinct 枚举(校准 panel=16 的活口径)。
- [ ] `search_after` 游标用法 + 有效期(深翻 >25k 才需)。
- [ ] 日期范围括号编码(`%5B…%5D` vs `--data-urlencode`)在生产客户端确认。
- [ ] 429 退避策略 + 免费 API key 配额实测(240/min、无 key 1k/天 vs key 120k/天)。
- [ ] `foiclass.zip` 字段分隔/编码(`|` 分隔，确认列序)。
- [ ] `us_agent` 子结构(`name` vs `business_name`)确认哪些字段是具名个人 🔴。

---

## 7. Provenance

API 契约由本会话 2026-07-08 **活体实测**(curl 真打 `api.fda.gov`：零鉴权、端点计数、记录结构、`count` 聚合、`skip` 上限、日期语法)。ICP→产品码映射 + 合规分级由研究 agent 附实链核实(openFDA terms=CC0、`/device/classification`、`foiclass.zip`、FDA「注册≠核准」页、FAERS 去标识化)。研究纠正两点已并入：**panel=16(非 19)**、**product code 无 CPV 式前缀层级**(taxonomy 显式建 panel 父维)。与 TED 的差异见下表。

### 附：TED vs openFDA 关键差异（codegen 别照搬）

| 维度 | TED | openFDA |
|---|---|---|
| 分类主键 | CPV(数字，**前缀嵌套**，截位放宽) | **product code(3 字母，不透明，无前缀)**；放宽靠 `parentCode=panel`(16)/`device_class` |
| License | CC BY 4.0 + 2011/833/EU，**强制署名** | **CC0 1.0**，可商用，**署名非义务** |
| 覆盖门 | EU/EEA/UK 买方，可能空返→warning | **全美市场**，无空返；国家维=贸易「哪一侧」(`establishment_type`+`iso_country_code`) |
| intent 信号 | 招标 `TENDER_PUBLISHED`(截止日) | 510(k) `decision_date` → **`FDA_CLEARANCE`**(新品/时机) |
| 特有红线 | 具名联系人 🔴 | 具名联系人 🔴 + **「注册≠核准」文案红线** + **MAUDE/FAERS 患者数据 out-of-scope** |
| taxonomy kind | 加 `cpv` | 加 `fda_product_code`(叶)+ `fda_panel`(父) |
| 种子源 | EU Vocabularies CPV XML | **`foiclass.zip`**(accessdata.fda.gov)+ `/device/classification` |
| 字段投影 | 有 `fields` 参数 | **无投影**，取全记录；但有 **`count` 服务端聚合** |
| 分页 | `limit≤250`，`page×limit≤15000`，ITERATION token | `limit≤1000`，`skip≤25000`，`search_after` 游标 |

---

## 8. 审查修正（Codex 2026-07-08 · 已活 API/代码复核并入 · 实施必读）

下列 6 点经 Codex 审查 + 我方**活 API/代码复核全部确认**,实施时**按此覆盖正文对应处**:

1. **美国进口商是 flag 不是 `establishment_type`**:活 API `count=establishment_type.exact` 确认全是长活动标签(`Manufacture Medical Device` 134,692 / `Export Device to the United States But Perform No Other Operation on Device` 43,853 / `Repack or Relabel Medical Device` / `Foreign Private Label Distributor`…),**无 `Importer` 值**。§2.4 的 `establishment_type:Importer` **错**,会返空/错。正确:**美国进口商 = `registration.initial_importer_flag:Y`(实测 60,282)**;外国出口商 = `establishment_type:"Export Device to the United States But Perform No Other Operation on Device"`;制造商 = `"Manufacture Medical Device"`。建库前 `count=establishment_type.exact` 取活枚举。
2. **按租户目标市场设门(fan-out 层)**:`executeQuery` fan-out **全部 ENABLED** `public_intelligence` adapter(`discovery.activities.ts:98`)→ openFDA 若把 `targetMarket` 恒当 US,会在目标为德/法的 workspace 也跑、**注入美国 FDA registrant 到没要美国的租户**。§2.4「无覆盖空返」只对 CPV 式品类覆盖成立;**市场门仍要有**:openFDA adapter **目标市场不含 US 且无显式 FDA/source hint 时 skip/空返 + coverage note**。
3. **registrationlisting 用 product 作用域字段**:registrationlisting 的谐调字段在**每个 product 下**(`products.openfda.*`、`products.product_code`),**顶层 `openfda.medical_specialty_description` 是 510k/PMA/classification 的**。§2.3 宽 panel 分支对 registrationlisting 直接用顶层 `openfda` 会**过滤失败/返错**。→ registrationlisting 把 panel 展开成 product codes 查 `products.product_code`,或查 `products.openfda.*`。
4. **`TaxonomyResolver.resolve()` 剥掉 crosswalks**(同 TED §8.2,代码确认 `node()` 无 `crosswalks`):`resolveIcpToFda` 依赖 `industryNode.crosswalks.fdaPanels` 取不到 → **必先扩 resolver 暴露 crosswalks 或直读 `canonical_taxonomy.crosswalks`**。
5. **打分前归一 FDA 日期**:部分 FDA 日期是紧凑 `YYYYMMDD`,`scoring.ts` 的 `Date.parse` 返 **NaN → intent 不得分**(`decision_date` 实测有 `2004-03-11`,但其他字段/端点有紧凑格式)。projection 写 `FDA_CLEARANCE` 的 `at` 前**统一转 ISO**再存。
6. **PMA/510k intent 过滤决定结果**:PMA 含 withdrawal/denial,510k 含 NSE(未实质等同)。**只对核准的投 `FDA_CLEARANCE`**:PMA 要 `decision_code:APPR`;510k 要 `decision_code`=SESE(实质等同=清关)。否则给被拒/撤回的公司误加分。
