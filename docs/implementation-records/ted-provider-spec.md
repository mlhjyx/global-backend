> 【Implementation Record 2026-07-16】P1 中标发现 / P2 ICP→CPV / P3 招标 intent / P5 Schedule 已完成（PR #30/#31/#33/#38）；SAM.gov Sources Sought P4 后续也已由 PR #99 落地、默认 DISABLED，获客线当前冻结。规格正文以「§8 审查修正」+ 现有代码为准，不再是 build-ready 待实施稿。
> 【现行流程覆盖】正文中旧的 `docs/feat` 分支、自审、自合并等表述只记录当时过程；当前统一使用 `codex/<topic>` + PR + CI/Codex 审查，合并须用户明确确认，权威规则见 [../../AGENTS.md](../../AGENTS.md) §8。

# TED v3 招投标 Provider — 落地规格（build-ready）

> 2026-07-08 定。给**下一个开工会话**的权威实施规格。API 事实**均为当日活体实测 + 独立对抗复验**(4 agent research→verify),用哪个数字/字段直接照抄本文。
> 上游：[buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)（P1 需求证据源，§10.6 排 TED 第一）· [positioning-and-acquisition-backlog.md](../research/positioning-and-acquisition-backlog.md) §5 #2 · [AGENTS.md](../../AGENTS.md) §6。
> 硬规矩：真实数据、无 sandbox（§5）；多租户、**绝不硬编码行业/国家**（§3）；合规红线（§5）。

---

## 0. 为什么做 TED / 它给什么

**TED（Tenders Electronic Daily）= 欧盟公共采购官方公报**。对「获客 = 补需求证据 + 时机 + 对的人」三缺环,TED 一次给三样,且**零鉴权、零 key、官方 REST API**(不碰爬虫/ToS 灰线,是本轮最干净、最快见效的免费需求源)：

| TED 载荷 | 对我们的价值 | 落到哪 |
|---|---|---|
| **招标公告(contract notice)** = 某买家现在要买某 CPV,带投标截止日 | **需求证据 + 时机(intent)** | `attributes.intent.events[]` → 六维 Intent 维评分 |
| **中标公告(award notice)** = 谁中了标(具名中标供应商 + 国别 + 税号 + 常有官网) | **可解析的活跃公司**(潜在客户/竞品/渠道) | `canonical_company`(走既有 discovery→fit→enrich→score 管线) |
| 合同金额/CPV/NUTS 地点/程序类型 | 公司事实、匹配键 | `attributes.ted.*`(可选富集) |

**方向别搞反**：TED 招标公告描述的是**买家**的需求。本平台客户是**卖家找买家**,所以招标公告移动的是**买方组织**(若其本身是 canonical 线索)的分;中标公告移动的是**中标供应商**记录。写库前先明确每条 notice 解析到哪个实体。

---

## 1. 活 API 契约（2026-07-08 实测 + 复验,可直接照抄）

**端点**：`POST https://api.ted.europa.eu/v3/notices/search` · `Content-Type: application/json` · **零鉴权**(官方文档 `docs.ted.europa.eu/api/latest`：*"The Search API does not require a key."* 只有改 notice 的端点要 key)。

**请求体 = `PublicExpertSearchRequestV1`,严格拒未知顶层键**。合法键仅：`query` · `fields` · `limit` · `page` · `scope` · `paginationMode` · `iterationNextToken`。
⚠️ **`sortField`/`sortOrder` 不是 body 键**——排序写进 `query` 字符串里(见下)。

### 1.1 Expert query 语法（一个字符串搞定过滤+排序）

`field OP value ... SORT BY field [DESC]`。实测算子：

| 算子 | 含义 | 实测例 |
|---|---|---|
| `=` | 等于/匹配 | `classification-cpv=42000000` |
| `IN (a b c)` | 任一(空格分隔,括号内) | `buyer-country IN (DEU FRA)` |
| `OR` `( )` | 或 | `(buyer-country=DEU OR buyer-country=FRA)`(与 IN 等价) |
| `AND` | 与 | `notice-type=can-standard AND classification-cpv=42000000` |
| `NOT` | 非 | `... AND NOT buyer-country=DEU` |
| `*` | 前缀通配 | `classification-cpv=421*`(匹配 42122100 等) |
| `~("term")` | 全文包含 | `notice-title~("pump")` |
| `>=` `<=` | 范围/比较(日期、数字) | `publication-date>=20260608 AND publication-date<=20260708` |
| `SORT BY <field> [DESC]` | 排序(**在 query 内**) | `... SORT BY publication-date DESC` |

- **日期格式严格**(API 自漏正则 `[0-9]{8}|today([+-]?[0-9]*)`)：要么 `yyyymmdd` **8 位无横杠**(ISO `2026-06-08` 被拒),要么相对函数 **`today(-30)`**(=近 30 天,首选)。
- **排序**：`SORT BY publication-date DESC` 放 query 末尾。默认**升序=最旧优先(2016)**,加 `DESC` 才是最新在前。只认 `DESC`;`ASC`/`ASCENDING` 报语法错。`publication-date` 返回形如 `"2026-07-08+02:00"`(日期+时区偏移,非全时间戳)。

### 1.2 分页 & 全量抓取（硬上限,照抄）

- **`limit` 最大 = 250**(500 报 `exceeds maximum allowed value (250)`)。
- `paginationMode` 枚举 `[PAGE_NUMBER, ITERATION]`(默认 PAGE_NUMBER)。
- **PAGE_NUMBER 硬窗口 `page × limit ≤ 15000`**(超了报 `Window size (page x limit) exceeds maximum allowed value (15000)`)——经典分页只够摸到前 1.5 万条。
- **超 1.5 万 → 必须 `paginationMode:"ITERATION"` 滚动**：首调(无 token)返回 notices + 非空 `iterationNextToken`;把该 token 原样回传下一调,拿下一批 + 新 token。**滚动全程保持 `query` + `SORT BY` 逐字节不变**。PAGE_NUMBER 模式下 token 恒为 null。
- **⚠️ 本场景 iteration 是强制的**：CPV-42 段招标/中标各 6.8 万~8.2 万条,远超 1.5 万。

### 1.3 `scope`（三值,计数差异巨大）

`[ALL, ACTIVE, LATEST]`。同一 `classification-cpv=42000000`：`ALL`=182,997(全历史全版本) · `ACTIVE`=13,024(当前开放中) · `LATEST`=104(最新版切片)。
**「现在开放的机会」用 `ACTIVE`;全量回填用 `ALL`。**

### 1.4 字段目录（实测能取到的,按用途）

> 请求一个不存在的字段名,API 会**漏出全部支持字段列表**(可用于字段发现)。缺失字段=**JSON 里直接省略该键,无 null 占位**——消费方必须把缺键当 null。

**Notice 元**(标量)：`publication-number` `publication-date` `notice-type` `form-type` `procedure-type` `dispatch-date`。`notice-title` 是**多语言对象**(24 语言键 `eng`/`deu`/`fra`…);`contract-title` 多语言但只含该 notice 自身语言。

**买方(contracting authority)**：`buyer-name`(多语言对象) · `buyer-country`(ISO-3 数组) · `buyer-city`(多语言) · `buyer-email`(数组) · `buyer-internet-address`(URL 数组) · `organisation-name-buyer` `buyer-identifier` `buyer-person` `touchpoint-tel-buyer` `buyer-touchpoint-email`。

**中标经济体(仅中标公告 award notice 有)——lead-gen 核心载荷**：
- `winner-name`(**多语言对象**,如 `{"hun":["GRUNDFOS South East Europe Kft.",...]}`)—— **可靠,几乎必有**
- `winner-country`(ISO-3 数组) · `winner-identifier`(国家税号/注册号数组)—— **可靠**
- `winner-email`(真实邮箱数组,🔴 具名+角色混合) · `winner-internet-address`(公司官网 URL 数组)—— **⚠️ 经常缺失,不保证每条有**(实测有中标公告 0 邮箱/0 URL)
- `winner-city` `winner-size`(SME 码 micro/small…) · `winner-person`(自然人标志布尔数组) · `winner-decision-date` · 目录里还有 `winner-post-code` `winner-country-sub`(NUTS) `winner-contact-point` `winner-touchpoint-*`。
- **平行命名空间**(投标方视角,award notice 也有)：`organisation-name-tenderer`(多语言) `organisation-email-tenderer` `organisation-identifier-tenderer` …;另有完整 `*-subcontractor` 命名空间。

**金额**：`estimated-value-lot`(数组,需求侧预算,**招标公告也可能缺**) · `tender-value`(中标出价数组) · `result-value-notice`(标量总额) · `total-value-cur`(币种数组)。

**CPV/地点/时机**：`classification-cpv`(CPV 码数组) · `place-of-performance`(NUTS 码数组) · `place-of-performance-country-lot` · `deadline-receipt-tender-date-lot`(投标截止日数组,**招标公告有、中标公告无**) · `dispatch-date` · `contract-conclusion-date`。

> ⚠️ 跨字段数组**按位且不等长**(某 notice 5 个 winner-email vs 46 个 tender-value vs 11 个 CPV)——**别天真 zip**;要精确到「哪家中了哪标多少钱」须按 lot/result 分组键 join(建库时再探一次)。

### 1.5 Notice 类型 → 需求信号 vs 供应商揭示

| 桶 | `form-type` | `notice-type`(实测确认) | 对我们 |
|---|---|---|---|
| **需求信号**(intent/时机) | `competition` | `cn-standard` | 招标公告:开放招标,有 `deadline-receipt-tender-date-lot`、`estimated-value-*`。买方=线索,时机=截止日 |
| **需求,更早** | `planning` | `pin-*` 族(未逐一 curl 确认) | 预先信息公告:买家提前数月预告采购。最早 intent |
| **供应商揭示** | `result` | `can-standard` | 中标公告:填充 `winner-*`。中标方=待解析进 `canonical_company` 的活跃供应商 |

**过滤逻辑**：需求管线 → `notice-type=cn-standard`(+ `pin-*` 早 intent)、`scope=ACTIVE`、`deadline-receipt-tender-date-lot` 未来。供应商管线 → `notice-type=can-standard`,抓 `winner-*`。粗口径可用 `form-type=result`(所有中标变体)/`form-type=competition`(所有招标)。

### 1.6 限流现实

- **无限流响应头**(`curl -i` 只有 CloudFront/AWS 缓存头,无 `X-RateLimit`/`Retry-After`)。静态文档也未公布数值上限。
- API 由 **AWS CloudFront + AWS WAF** 前置——限流/防爬以 **WAF 挑战/`429`/`403`/CAPTCHA body** 形式出现,**不是响应头**。会话中 TED 人类文档页确实返回过 429。
- **对策**:客户端自限 **~1 req/s + 4xx 指数退避**,滚动全量当**长时低 QPS 任务**。**别把「无限流头」当「无限量」。**

### 1.7 ⚠️ 复验修正过的坑（研究稿里错的,已改)

- **不要引用 2,794,614 / 2,871,409 当 CPV-42 量**——那是**不带 CPV 过滤**的 `can-standard`/`cn-standard` 总量。CPV-42 过滤后真实是**中标 68,793 / 招标 81,948**。`AND classification-cpv=…` 过滤**确实生效**,只是研究稿把无过滤数字贴错了位置。**所有分段体量估算建库时按活计数重算。**
- **示例算子计数不可靠**:`421*`=34,774(非 3,591);`~("pump")`=16,778(非 1,110)。**任何 sizing/预算别抄研究里的数,建库时现打现算。**
- **中标联系方式是部分而非普遍**:`winner-name/-country/-identifier` 可靠,`winner-email/-internet-address` **经常缺**。管线须以 `winner-name + winner-identifier`(税号)→ `canonical_company` 解析为主,**不假设每个中标方都有邮箱/URL**;`estimated-value-lot` 同理(招标公告也可能无)。
- **建库前仍须探**:完整 `notice-type` 码表(只 curl 确认了 `cn-standard`/`can-standard`,`pin-*` 未测)、WAF 阈值、`iterationNextToken` 有效期。上线依赖某 `notice-type` 过滤前,先发 `notice-type=<码>` 看是否报枚举/语法错。

---

## 2. ICP → CPV 映射设计（多租户,不硬编码）

### 2.1 CPV 是什么 + 为什么前缀匹配是全部诀窍

CPV(Common Procurement Vocabulary,欧盟采购标的分类,Reg (EC) 213/2008)。每条 TED notice 都打 CPV 码 → CPV 是「哪些招标匹配本 workspace ICP」的**主杠杆**。

**8 位码 + 第 9 位校验位**,写作 `XXXXXXXX-Y`(如 `42122000-7`)。位数即层级:

| 层 | 有效位 | 例 |
|---|---|---|
| Division | 前 2 | `42000000` 工业机械 |
| Group | 前 3 | `421_____` |
| Class | 前 4 | `42120000` 泵与压缩机 |
| Category | 前 5 | `42122000` 泵 |
| 子类 | 6–8 | `42122130` 水泵 |

**尾部的 0 就是层级**:每个子码共享父码非零前缀 → **匹配=前缀匹配**。往左截=放宽(`42120000` 抓全部泵/压缩机子码),多留位=收窄。**存 8 位码作 key**,第 9 位校验位仅供校验/回显。~9,450 个主码——全量种子够小,但一次性塞 LLM enum 太大(见 2.4)。

**权威可下载**:SIMAP CPV 页 `https://ted.europa.eu/en/simap/cpv`;XLS `https://simap.ted.europa.eu/documents/10184/36234/cpv_2008_xls.zip`;EU Vocabularies 机读(SKOS/genericode)`https://op.europa.eu/en/web/eu-vocabularies/at-dataset/-/resource/dataset/cpv`。

### 2.2 复用既有 taxonomy(不新造)

`CanonicalTaxonomy`(平台表,无 RLS,`app_user` 只读)已具备 CPV 所需一切(`packages/db/prisma/schema.prisma` `CanonicalTaxonomy` ~L280 / `TermAlias` ~L298 / `apps/api/src/discovery/taxonomy-resolver.ts`)：
- `kind`(现 `industry`/`country`/`product`)—— **加 `cpv`**;`scheme`(现 `ISIC`/`ISO3166_1`/`HS`)—— **加 `CPV`**。
- `code` = 8 位 CPV;`parentCode` **自引用层级**——ISIC 已用它做子树匹配,CPV 前缀嵌套直接落进同列。
- `labels`(多语言,CPV 全欧盟语言标签,至少载 `zh`/`de`/`en`)。
- `crosswalks`(JSON,ISIC 节点已存 `{nace,naics}`、country 存 `{alpha3,numeric}`)—— **ISIC↔CPV crosswalk 就存这**。

`TermAlias`(`kind,term→code`,`source∈seed|llm|manual`,唯一 `(kind,term)`)= 自由文本→码缓存,把 LLM 解析沉淀成确定性查找。`TaxonomyResolver.resolve(kind,term,{allowLlm})`:确定性别名命中 → 否则 LLM 冷路径(候选码 enum 约束,不幻觉)→ 校验码存在 → upsert `TermAlias(source='llm')`。**LLM 仅冷路径(ICP 设计/查询计划),绝不上发现热路径。**

✅ **国别已零成本解决**:seed 已在每个 country 节点存 `crosswalks.alpha3`(ISO 3166-1 alpha-3),**正是 TED 的国别格式(`DEU`/`FRA`)**。country→TED = 纯字典查找,无 LLM。

### 2.3 推荐方案 =（c）混合:crosswalk 锚定 + LLM 精修 + alias 缓存

与本仓「确定性种子 + 冷路径 LLM 回填」哲学一致,LLM enum 始终有界(正确性),LLM 不可用时退化为纯确定性。

**一次性种子(平台数据)**：
1. 从 EU Vocabularies XML/genericode 全量载 CPV 树进 `canonical_taxonomy(kind='cpv',scheme='CPV',parentCode=<前缀父>,labels=<多语>)`。
2. 建 **ISIC→CPV crosswalk**,存 `crosswalks.cpv=[<cpv 码/前缀>]` 于 ISIC industry 节点。引导:对每个 ISIC 节点 LLM 提议候选 CPV division/class → 人工抽检 → 冻结进种子(`source='seed'` 平台数据,非每租户成本)。
3. CPV 标签别名(EN/DE/ZH)→ `term_alias(kind='cpv',source='seed')`。

**解析流 `resolveIcpToCpv(icp)`(冷路径,ICP 保存/查询计划时,非热路径)**：
```
输入: icp.industry(自由文本) · icp.product(自由文本,可选) · icp.targetCountries(自由文本[])
1. industryNode  = resolve('industry', icp.industry)         // 既有,确定性+LLM
2. cpvCandidates = industryNode.crosswalks.cpv                // 确定性子树,0 成本
3. if product: alias 命中 TermAlias('cpv',norm(product)) → 完;
   否则 LLM 精修,enum = 仅 cpvCandidates 子树下的码(有界 ≤ 几百) → 挑最佳 → upsert TermAlias('cpv',product,code,'llm')
   否则用 cpvCandidates(class/division 级=宽网)
4. breadth 策略: 宽 ICP→division/class 前缀; 窄 ICP→完整 8 位
5. countries: 每个 t → resolve('country',t).crosswalks.alpha3 → TED buyer-country;
   若 alpha3 ∉ TED_COVERAGE → 置 icp_fit_warning(见 2.4)
6. return { cpvCodes[], buyerCountries[], warnings }
```
**缓存三层**(均已支持):平台种子(CPV 树+crosswalk)· `term_alias(kind='cpv')` 沉淀 LLM 解析 · **每 workspace 把解析出的 `{cpvCodes,buyerCountries}` 落在 ICP 记录上 → 查询时纯读**(ICP 文本变才重解析)。

### 2.4 关键实现约束 + 国别覆盖门

- ⚠️ **`TaxonomyResolver.llmResolve` 现把整个 kind 目录塞进 prompt**(`slice(0,6000)`)——~260 ISIC/country 节点没事,**~9,450 CPV 码会静默截断**。混合设计规避此坑:**LLM enum 永远限于 crosswalk 子树,绝不 `resolve('cpv',term)` 打全表**。
- **国别覆盖 = ICP-fit 信号**:TED 只覆盖**买方在** EU/EEA + UK-legacy + 少数国。观测覆盖集(建库时按活数据刷新):
  ```
  AUT BEL BGR CHE CYP CZE DEU DNK ESP EST FIN FRA GBR GRC HRV HUN
  IRL ISL ITA LIE LTU LUX LVA MLT NLD NOR POL PRT ROU SVK SVN SWE
  ```
  = EU-27 + EEA(ISL/LIE/NOR)+ CHE + GBR。**出口卖家语义**:ICP 的**目标市场**映射到 `buyerCountries`(卖进德国 → target=德国 → `DEU`)。若目标非覆盖国(买方侧 `CN`/`US`/`JP`)→ TED 无数据 → 发 `icp_fit_warning: "TED 仅覆盖 EU/EEA/UK 买方"`,**不要静默返空**。

---

## 3. 合规分级 + 硬约束（照抄,别猜 license）

### 3.1 TED license（已核实原文,非猜测）

据 **TED 法律声明** `https://ted.europa.eu/en/legal-notice` + 委员会再利用政策：
- SIMAP 网站**编辑内容**授权 **CC BY 4.0**。
- OJEU **采购公告可自由再利用(商用/非商用)**,依 **Commission Decision 2011/833/EU**(`https://eur-lex.europa.eu/eli/dec/2011/833/oj`),**须署名 + 标注改动**。
- 声明明确警告:内容涉可识别个人/第三方作品时**需另行清权**——即再利用 license **不清个人数据/隐私权**。

**净结论**:招标/中标/CPV 事实是 🟢 **可商用,但带 CC BY / 署名义务**(非 CC0/公共领域)。**署名是 license 义务,不可省。**

### 3.2 分级表 + 为什么 🔴 成立

三条**独立**法律轨分别评级:平台合约(ToS/robots)· 版权/数据库权 · GDPR/ePrivacy。指导原则(Clearview 线)：**「公开可见 ≠ 可自由再用」——再利用 license(版权轨)不授予数据保护许可(GDPR 轨),两轨正交。**

| TED 数据元 | 级 | 为什么 | 处置 |
|---|---|---|---|
| 招标/中标事实:标题、程序、日期、截止、类型/状态 | 🟢 | 官方 OJEU,可商用再利用(2011/833/EU) | 入绿库。**附 provenance**(source=ted、notice id、发布日),下游带署名 |
| **CPV 码** / 分类 | 🟢 | 同 license,非个人 | 入库;主 ICP 匹配键 |
| 合同/中标**金额**、lot 值、币种 | 🟢 | 非个人商业事实 | 入库 |
| **买方组织**名/址/NUTS/注册号/类型 | 🟢 | 法人非自然人 | 绿库。*边界*:一人/个体户 authority → 升 🔴 |
| **中标供应商组织**名/址/组织号/国别 | 🟢 | 法人;中标事实公开商业数据 | 绿库(喂 `canonical_company`)。*边界*:个体户中标 → 🔴 |
| 买方**通用/职能联系** `procurement@`/`info@`/总机/通用 URL | 🟡 | 职能非明确自然人 | 可存;触达仅走 **ePrivacy** 渠道 |
| 买方/供应商**具名联系人**、**具名邮箱**(`jane.doe@…`)/直线 | 🔴 | 可识别个人数据(Art.4) | `personalData=true`;**隔离/加密存**,非绿库;LIA + **Art.14** 告知;保留期限制。**对齐 `decision_maker` 处置**(`person.profile` 证据 + `personal_data` 标记 + `contact-persist.ts`) |
| 源**署名串**(© European Union / TED、notice id、CC BY 4.0) | 🟢(义务) | 绿数据的 license 条件 | **必须**存 + 展示/导出处 surface |

**为什么名字在「公开可自由再用」的 notice 里 🔴 仍成立**:CC BY 4.0 / 2011/833/EU 只是**版权/数据库权**授予,**不给 GDPR 合法性依据、不给 ePrivacy 许可**。具名联系人仍是**间接收集**的个人数据 → **Art.14** 透明义务(1 个月内/首次接触时告知)+ 触达前须有**合法利益评估(LIA)**。这正是本仓对展会具名联系人 / `decision_maker` 已采取的姿态。

### 3.3 硬约束（TED provider 必守）

1. **绿事实可商用但带署名**:招标/中标/CPV/金额/日期/组织事实 → 绿库;持久化 provenance(`source='ted'`、notice id、OJS ref、发布日),下游展示/导出带署名(`Source: TED — © European Union, [year]; reused under CC BY 4.0`)。
2. **具名联系人(买方+供应商)= 🔴,隔离+标记**:绝不写绿事实表;仅存加密/隔离个人数据库,`personalData=true` + 保留期 + LIA + Art.14。复用 `decision_maker` 处置。
3. **License ≠ GDPR 依据**:别把「出现在 CC BY 公开 notice」当同意或处理个人数据的合法依据。个人数据永远需自己的 Art.6 依据(LIA)+ Art.14 透明。
4. **职能联系 `procurement@`/总机 = 🟡**:可存;触达仅走 ePrivacy 合规渠道。
5. **正确注册源**：
   - `data_provider(key='ted', class='public_intelligence', status='ENABLED', costPerCallCents=0)`
   - `source_policy(domain='api.ted.europa.eu', sourceType='tender', accessMode='api', reviewStatus='APPROVED', personalData=true, allowedPurpose=['discovery','enrichment'], retentionDays=<设定>)` —— **`personalData=true`**(notice 可能含具名联系人,即便路由是官方 API)。访问是**官方 REST API,不爬**,平台合约轨干净(不同于 RX/Algolia 灰红路)。
6. **覆盖 + 保留门**:只 ingest TED 覆盖集内买方国;所有 🔴 行套 GDPR 存储限制保留期,定时清(镜像 intent 引擎保留纪律)。
7. **边界:自然人经济体**:个体户/个人中标方或一人 authority,则「组织」本身即个人数据 → 该记录升 🔴。

---

## 4. 集成接缝（哪些文件建/改,exact）

> 发现四层 L0 Tool → L1 ProviderAdapter(按 SourceClass)→ L2 AI Task → L3 Temporal。**TED 归 `public_intelligence` 类**(同 `web_watch`/`digital_footprint`/`public_web`),**无需新 SourceClass**。

### 4.1 三个接缝（推荐先做 discovery,再 enrich,monitoring 后延）

- **(b) 中标公告 → DISCOVERY(具名中标供应商 → canonical)【推荐先做,面最小】**
  `CompanyDiscoveryAdapter`(`key='ted'`,`classes=['public_intelligence']`)。在 `executeQuery` fan-out,落 `raw_source_record` → `canonicalizeRun` → `canonical_company`,**复用既有 discovery→fit→enrich→score 全管线**。`canonicalizeRun` projection 已接线(不像 monitoring 有 gap,见下)。
- **(a) 招标公告 → INTENT(实时需求 → 动分)**
  要真移动分,须落 **`attributes.intent.events[]`**(Intent 维**唯一**读的东西,见 §4.4)。TED-aware projection:notice 买方/CPV → 解析 canonical → append `{ type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength:<0..1> }`。
- **(可选)ENRICHMENT → `attributes.ted.*`**
  `CompanyEnrichmentAdapter`(`key='ted'`),加公司 EU 招投标历史,同 `gleif`/`wikidata` 命名空间/幂等;**本身不移动 Intent**(那需 intent.events)。
- **(后延)MONITORING → 定时抓新 notice**
  `MonitoredSourceAdapter`(`providerKey='ted'`),first-seen = 新供应商中标。⚠️ **有 gap**:`TenantProjectionService.projectSource` **无调用者**(grep 确认);走 monitoring 须**另接 projection sweep**(仿 `intent.activities.ts:54–73` 在 `acquisition.workflow.ts` 尾部加)。这也是为什么中标发现走 **L1 discovery 更低风险**(其 projection `canonicalizeRun` 已接线)。

### 4.2 契约（照抄签名）

`apps/api/src/discovery/provider-contract.ts`：
```ts
// SourceClass 是闭合字面量 union(L7–14),且在 tools/tool-contract.ts:17–24 重复一份——
// 加新类要同步两处;复用 public_intelligence 则两处都不碰。
export interface CompanyDiscoveryAdapter {
  key: string; classes: SourceClass[];
  discoverCompanies(query: CompanyDiscoveryQuery, opts?: DiscoveryOptions): Promise<DiscoveryResult>;
}
export interface CompanyEnrichmentAdapter {
  key: string;
  enrichCompany(input: CompanyEnrichmentInput): Promise<EnrichmentResult>;
}
// ProviderCompanyRecord: { externalId, name, domain?, country?, region?, industry?,
//   employeeCount?, revenueUsd?, attributes?, provenance?{sourceUrl,fetchedAt,contentHash,parserVersion} }
// DiscoveryResult: { records: ProviderCompanyRecord[], costCents }
// EnrichmentResult: { matched, confidence(0..1), attributes, provenance?, costCents } — matched:false ⇒ 不写(绝不贴错身份)
```
**End-to-end 模板**：`apps/api/src/discovery/providers/trade-fair.provider.ts`(92 行,最干净)。原始 HTTP 客户端另放一文件(`apps/api/src/adapters/trade-fair-algolia.ts`),adapter **直接调**,discovery 路**不过 ToolBroker**。

### 4.3 实体解析 + 命名空间/幂等/证据

- 确定性 key:`companyIdentity({name,domain?,country?})`(`identity.ts:39–47`)→ `dedupeKey`=`d:<domain>`(域名精确)否则 `n:<normName>:<country>`。**TED 买方/供应商同域名或同名+国别 ⇒ 并入既有 canonical,否则新建。** 中标方优先用 `winner-internet-address`(有则)→ 域名 key;否则 `winner-name + winner-country`。
- 模糊名匹配(有名无净 key 时,富集用):`pickBestByName(queryName, items, getName)`(`name-match.ts:50–69`)→ `{item,score,margin}`;**阈值调用方施加**——照抄 `gleif.provider.ts` 的 `ACCEPT_THRESHOLD=0.72` + `AMBIGUITY_MARGIN` 门(`best.score<0.72 || best.margin<margin ⇒ miss`)。
- 富集命名空间/幂等/证据:`enrichRun`(`discovery.activities.ts:341–423`)。幂等 `if(existing[e.key]) continue`(375);写 `attributes.ted={...}`;逐字段 `FieldEvidence`(`field:'ted.<字段>'`、providerKey、confidence、`license:'CC BY 4.0'`、allowedActions)。信号带 TTL 刷新走 `enrichSignalsRun`(432–520,`_ts` 新鲜度)。
- `canonical_company` Prisma(`schema.prisma:490–529`):`attributes Json?` → **多数 TED 载荷免 migration**;水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt`(511–517)已在(#24 落地)。

### 4.4 评分钩子（TED 需求要真移动分,照此形状写）

`apps/api/src/lead/scoring.ts`,`WEIGHTS.intent=0.15`(L58),`RECOMMEND_THRESHOLD=0.55`(L59)。Intent 维(`intentDimension` 213–259)**只读** `attributes.intent.events[]`:
```ts
// 每事件 strength * recencyDecay(now - Date.parse(e.at))  半衰期 60d;取最强;
// at 不可解析 ⇒ recencyDecay 返 0 ⇒ 不得分 → 必写合法 ISO 时间戳(notice 发布日)
// 关键词代理排除 intent 命名空间(241,防双计),真证据压过代理
```
- **TED 需求信号移动分 iff 写成 `attributes.intent.events` 项** `{ type:string, at:<ISO>, strength:<0..1> }`。
- **Reachability 硬底**(163–164):即便强 TED Intent,无可达联系点也只到 `needs_review` 非 `recommended`。
- 加权对 event `type` 通用 → 新增 `TENDER_PUBLISHED` **无需改评分**;要自定强度在 projection 时设(仿 `intent-projection.service.ts:13–15` `TYPE_STRENGTH`)。

### 4.5 种子 / 注册（两处都要,只种 DB 行不够）

- **adapter 实例**必须在 `DiscoveryProviderRegistry` 构造器 push(`provider.registry.ts` ~L64 discovery / ~L67 enricher)。
- **`data_provider` 行**在 `seed()`(~L114)加 `ted` upsert。`seed()` 两处启动调用**都要见到新 adapter**:`worker.ts:44`(owner,loud-fail)+ `relay/outbox-relay.service.ts:32`(onModuleInit)。
- `source_policy('api.ted.europa.eu')` 行**无自动种子**——走 migration `INSERT` 或启动 upsert(§3.3.5)。
- monitoring 的 `monitored_source` TED 行也无自动种子——需 seed 脚本/`registerTedSource` helper(后延)。

### 4.6 文件清单

**建**：
- `apps/api/src/adapters/ted-api.ts` —— TED Search API v3 HTTP 客户端(零鉴权,typed notice 行;仿 `adapters/wikidata.ts`)
- `apps/api/src/discovery/providers/ted.provider.ts`(+ `.spec.ts`)—— `CompanyDiscoveryAdapter`(中标发现,**先做**)
- `apps/api/src/discovery/providers/ted-enrich.provider.ts`(+ `.spec.ts`)—— `CompanyEnrichmentAdapter`(可选,带 0.72+margin 门)
- `apps/api/src/intent/ted-intent-projection.service.ts` —— 招标公告 → `attributes.intent.events[]`(动分)
- `apps/api/src/discovery/icp-to-cpv.ts`(+ `.spec.ts`)—— `resolveIcpToCpv`(§2.3)
- `apps/api/scripts/seed-cpv.mjs` —— CPV 树 + ISIC↔CPV crosswalk 种子(§2.3)
- `apps/api/scripts/verify-ted-*.mts` —— 真实数据实测(§5 无 sandbox)
- (后延)`apps/api/src/acquisition/adapters/ted.source.ts` —— monitoring
- (可选)`apps/api/src/tools/ted-tool.ts` —— 仅当要把 TED HTTP 过 ToolBroker 门(免费零鉴权公 API,plain adapter 已够;过门只为集中限流+source_policy)

**改**：
- `apps/api/src/discovery/provider.registry.ts` —— 构造器 push 实例 + `seed()` 加 `ted`
- `packages/db/prisma/schema.prisma` + 新 migration —— **仅当**加 TED 水位列或 `source_policy` SQL 种子;`attributes.ted.*`/`attributes.intent.*` **免 migration**
- `apps/api/scripts/seed-taxonomy.mjs` 或新 seed-cpv —— CPV 种子
- (monitoring 时)`apps/api/src/temporal/acquisition.activities.ts` + `acquisition.workflow.ts` —— 补 projection sweep(填 §4.1 gap)
- (可选)`apps/api/src/tools/builtin-tools.ts` + `provider-contract.ts`&`tool-contract.ts`(仅当加新 SourceClass)

**零改复用**:`discovery.activities.ts` fan-out / `canonicalizeRun` / `enrichRun`、`discovery.workflow.ts`、`name-match.ts`、`identity.ts`、`tool-broker.ts`、`ensure-schedules.ts`。

---

## 5. 建议实施顺序（TDD + 真实数据,分阶段小 PR）

> 每阶段:先写测试(RED)→ 实现(GREEN)→ `pnpm --filter @global/api build && test` → provider 类改动**另跑真实 verify 脚本**(无 sandbox)→ docs 分支 PR + CI 绿 + 自审自合。

1. **P1 — TED HTTP 客户端 + 中标发现(最快见价值)**
   `ted-api.ts`(query 构造/滚动分页/多语言解包/缺键当 null)+ `ted.provider.ts`(中标公告 → `ProviderCompanyRecord`,`winner-name+identifier` 主解析,email/URL 可缺)+ 注册 + 种子。verify:真跑一个 ICP(如「泵,德国」→ CPV `42120000` + `DEU`)拉近 30 天中标公告,落 canonical,过 fit 门。
2. **P2 — ICP→CPV 映射**
   CPV 树 + ISIC↔CPV crosswalk 种子 + `resolveIcpToCpv`(混合,LLM enum 限子树)+ country 覆盖门/`icp_fit_warning`。verify:几个真 ICP 文本 → CPV 码集,人工核对。
3. **P3 — 招标公告 → Intent 投影(动分)**
   `ted-intent-projection.service.ts`:招标公告 buyer/CPV → canonical → `attributes.intent.events[{type:'TENDER_PUBLISHED',at,strength}]`。verify:真招标公告 → 目标公司 Intent 维 0→N、总分抬升(仿 `verify-intent-loop.mts`)。
4. **P4(可选)— `attributes.ted.*` 富集**
   公司 EU 招投标历史,0.72+margin 名匹配门。
5. **P5(后延)— Monitoring sweep + projection gap**
   `ted.source.ts` + 补 `acquisition.workflow.ts` 尾部 projection(填 §4.1 gap)+ Schedule。仅当需要「持续盯新中标」再做。
6. **横切 — 合规**:所有 provider 落库处执行 §3.3 硬约束(绿事实带署名 provenance;`winner-email`/具名联系人 🔴 隔离 + `personalData=true` + 复用 `contact-persist.ts`;`source_policy` `personalData=true`)。

**验收(dev 有界样本,真库真 API,无 sandbox)**:一个真 ICP 端到端——ICP→CPV 解析 → 拉真中标公告 → 落 canonical 过 fit → 招标公告投影动 Intent 分 → 具名联系人正确进 🔴 隔离。**别 grind 全量**(6.8 万/8.2 万条是 Schedule 增量蚕食的活)。

---

## 6. 建库前必探清单（研究已 flag,别跳过）

- [ ] 完整 `notice-type` 码表(逐个发 `notice-type=<码>` 看是否报枚举错;`pin-*` 早 intent 族)+ `form-type` 全枚举。
- [ ] 多 lot 中标公告的 **lot↔winner↔value join 键**(数组按位不等长,要精确归属须探分组字段)。
- [ ] `iterationNextToken` 有效期(假设短命,一趟抓完一个结果集)。
- [ ] WAF 阈值/退避策略实测(1 req/s 起,盯 429/403/CAPTCHA body)。
- [ ] CPV 通配 `*` 中缀/后缀语义(仅确认前缀)。
- [ ] **所有体量数字建库时按活计数重算**(§1.7:研究稿旧数已作废)。

---

## 7. Provenance

本规格由 4-agent workflow 产出(3 并行 research:API 实测 / 代码库接缝 / CPV+合规 → 1 对抗验证复验 API 事实),2026-07-08 全程活体实测、无 sandbox。原始 research 存 scratchpad(`allfields.txt` 1830 字段名、`can_resp.json` 中标公告样本等)。验证 pass 修正了研究稿的体量数字错误与中标联系方式产出率高估(§1.7 已并入)。

---

## 8. 审查修正（Codex 2026-07-08 · 已代码/活 API 复核并入 · 实施必读）

下列 8 点经 Codex 审查 + 我方**代码/活 API 复核全部确认**,实施时**按此覆盖正文对应处**:

1. **body flag 不止 7 个**:TED Swagger 还支持 `checkQuerySyntax`、`onlyLatestVersions`。**`scope=ALL` 回填必设 `onlyLatestVersions=true`**——否则被更正的 notice 会以旧版本重复摄入,污染供应商发现与 intent 历史。建库时对 Swagger 确认完整 flag 集,把期望的 latest-version 行为写死。
2. **`TaxonomyResolver.resolve()` 剥掉 crosswalks**(代码确认:`node()` 只返 `kind/scheme/code/labelEn/labels/wikidataQid/osmTags`,**无 `crosswalks`**)。§2.3 的 `industryNode.crosswalks.cpv` 取不到 → **P2 必做前置:扩 `TaxonomyResolver`/`CanonicalNode` 暴露 `crosswalks`(或直接读 `canonical_taxonomy.crosswalks`)**;country 的 `crosswalks.alpha3` 同理。
3. **国别码归一 ISO-3→alpha-2**:canonical 国别码是 **alpha-2**(`DE`;`identity.ts` dedupeKey=`n:<name>:<country.toLowerCase()>`,seed 用 `c.cca2`),TED `winner-country`/`buyer-country` 是 **ISO-3**(`DEU`)。直接用会让同一德国公司经 TED vs GLEIF/Wikidata dedupe 到**不同 key**(`n:x:deu` vs `n:x:de`)+ 国别资格规则漏判。**canonical 化前把 TED 国别转回 alpha-2**(用 country 节点 `crosswalks.alpha3` 反查)。
4. **dedupe 用 `winner-identifier`**:现 canonicalization 只按域名或 name+country;TED 中标常缺 URL 但有税号/注册号。**加 provider-id/tax-id 身份规则(或 TED 专属 canonicalization)**,否则同名同国的不同中标方会误并、改名法人会漏并。
5. **discovery 证据带 TED 署名**:`canonicalizeRun` 硬编码 `field_evidence.license='licensed'`(`discovery.activities.ts:269`),**不带** TED 署名串/notice id;§3 要求 CC BY 强制署名 → **只走 raw→canonical 会产出无法合规展示/导出的公司字段**。须为 provider `ted` 改 discovery 证据(`license='CC BY 4.0'` + notice id/attribution),不只富集路(富集路 `enrichRun` 可设 license,但发现路是硬编码)。
6. **打分前归一发布日期**:TED `publication-date`=`2026-07-08+02:00`,`scoring.ts` 的 `Date.parse()` 判 **invalid → NaN → recencyDecay=0 → Intent 不得分**(§4.4 已提「须合法 ISO」,此处明确格式)。intent 投影写 `attributes.intent.events[].at` 前**必转 `2026-07-08T00:00:00+02:00`**。
7. **教 query planner 路由 TED**:仅注册 adapter 不够——`apps/api/src/ai-tasks/task-registry.ts:340` 的 `query_plan` prompt 只在 `public_intelligence` 下列 `public_web`、`source_hint` 例子无 `ted` → planner 不生成 CPV/buyer-country 的 TED 查询,**provider 注册了却从生成计划够不到**。**须改 `task-registry.ts`**:prompt 列 `ted` + `source_hint` + CPV/buyer-country filter 契约。→ 加进 §4.6「改」清单。
8. **直连 TED 强制 source_policy**:plain discovery 路只把 SUSPENDED 域当 `blockedDomains`(`discovery.activities.ts:108`),**不查 `allowedPurpose`/`personalData`**。TED 可能返具名联系人 → 光有 DB 行不是门。§4.2「ToolBroker 可选」对**含个人数据的招投标源不成立**——改为**在 adapter 显式查 source_policy/purpose,或 HTTP 走 ToolBroker**(必走)。
