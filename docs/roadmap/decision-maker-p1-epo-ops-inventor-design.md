# 待办 3 · 第二个身份源 = EPO OPS 发明人（欧洲专利局开放专利服务）

> 设计定稿 2026-07-11 · 分支 `feat/epo-ops-inventor` · 承接待办 3 首源（UK Companies House，PR #58/#59）
> 权威决策见 `docs/adr/registry.md`；立项 spec 见 `decision-maker-multi-source-spec.md` §5。本文件只记本期设计 + 合规 + 边界。

## 0. 一句话

把 **EPO OPS**（European Patent Office Open Patent Services，`ops.epo.org/3.2`）接成待办 3 的**第二个身份源**：
按**申请人（applicant=公司）**检索近期专利 → 抽**具名发明人（inventor）= 工程/研发技术买家** → 高置信对齐公司 →
经**跨源归一名（待办 2 的 Tier 2/3）**并入决策人图谱，补齐买家委员会的**技术评估席**。

## 1. 为什么 EPO OPS（选型 + 为何从 PatentsView 转）

**先说初选与转向**：待办 3 第二源原定 **USPTO PatentsView inventor**（有消歧 `inventor_id` = 干净 Tier 0）。但 PatentsView 2026-03-20 整体迁并进 USPTO Open Data Portal（`data.uspto.gov`），**API key 现需 ID.me 实名验证**（上传政府证件 + 自拍）。本项目运营方非美国身份、无美国证件 → **实名墙硬卡**。故转向 EPO OPS。

**EPO OPS 的优点**：
- **零实名验证**：`developers.epo.org` 邮箱注册 → 即时发 **Consumer Key + Secret**（OAuth2 client-credentials），免费档 3.5GB/周。无护照/自拍/美国身份。
- **官方 API、非爬**：延续 CH/TED/openFDA「官方 API 非爬」先例，平台合约轨干净。
- **发明人 = 具名技术决策人**：专利发明人依法公示，是 R&D/工程决策人（对齐买家委员会「技术评估/影响者」维），且带雇主（applicant）可做公司对齐。
- **覆盖更贴 ICP**：EPO 覆盖欧洲 + 全球（DOCDB 含美国专利），比只覆盖美国的 PatentsView 更贴本项目**欧洲市场为主**的 ICP（德国 SME/EuroBLECH 类）。
- **绿事实 CC BY 4.0**：与 TED 同一署名义务许可，复用 TED 合规先例。

**诚实取舍**（见 §3）：EPO **没有消歧到人的稳定 id**，故本源**不走 Tier 0**，走待办 2 的归一名合并——是合法的待办-3 源（补技术决策人覆盖 + 压测跨源名并健壮性），但不复刻 CH 的 Tier 0 精确键。

## 2. 架构（复用发现四层，零新 SourceClass）

延用 `L0 client → L0 Tool（ToolBroker 治理）→ Provider` 分层（抄 CH/TED/openFDA 先例）：

| 层 | 文件 | 职责 |
|---|---|---|
| L0 原始 HTTP client | **新** `adapters/epo-ops.ts` | **OAuth token 管理**（新，见下）+ `searchInventorsByApplicant(company, {sinceYear, cap})`：CQL 按 applicant+发布日检索 → 解包 biblio → 每专利的 applicants（对齐用）+ inventors（具名人）。可注入 fetch/creds 测。🔴 **数据最小化 map**：inventor 只取 `name`，**源头剥离**地址/国籍/residence。 |
| L0 Tool（治理包装） | **改** `tools/source-tools.ts` 加 `epo_ops.search` | `sourcePolicy:'required'` + `policyDomain:'ops.epo.org'` + `personalData:true` + `authRequired:true` → **§8.8 用途门 fail-closed**（未登记/SUSPENDED/用途不符即拒）。注册进 `registerSourceTools`。 |
| Provider | **新** `providers/epo-ops.provider.ts` `EpoOpsInventorProvider`（`ContactDiscoveryAdapter`，key=`epo_ops`） | 公司对齐门 → 近期发明人 → `ProviderContactRecord`（fullName + `personalData:true` + `license:'CC-BY-4.0'` + `buyingRole:'technical_buyer'`，**无 externalIds**）。 |
| 接线 | **改** `provider.registry.ts` | `contacts.push(new EpoOpsInventorProvider({broker}))` + `dataProvider` seed（key=`epo_ops`, class=`contact_discovery`, **DISABLED**——真测通过后翻 ENABLED，见 §8）+ `source_policy` 行（domain=`ops.epo.org`, CC BY 4.0 署名串入 notes）。 |

**OAuth token 管理（本源新增，CH 没有）**：EPO OPS 用 OAuth2 client-credentials：
1. `POST https://ops.epo.org/3.2/auth/accesstoken`，头 `Authorization: Basic base64(key:secret)`，体 `grant_type=client_credentials` → 返 `{access_token, expires_in≈1200s}`。
2. 业务调用带 `Authorization: Bearer <token>`。
3. **token 进程内缓存 + 过期/401 重取一次**（有界重试，绝不无限循环）；无 creds → 抛（provider fail-safe 返空）。
- 精确 auth 端点/JSON 字段路径以 key 到位后**真实 API 实测校准**（对齐 CH「契约实测通」先例；单测用注入假 fetch，不依赖线上形状）。

**为什么经 Broker**：EPO 发明人 = 具名个人数据源，直连前必过 `source_policy` 用途门（§8.8 fail-closed）。无 broker = 不允许原始出网（诚实降级空结果，绝不绕闸门）。

## 3. 身份合并（🔴 为何 EPO 不产 externalIds / 不走 Tier 0）

待办 2 的 `hasExternalIdConflict` 守卫假设「**同 scheme 不同值 = 不同人**」——对 CH `officer_id`（真人稳定 id）成立。但 EPO **无消歧到人的 id**：

- 若硬拿「公开号 + 名字」凑 externalId，**同一发明人在两件专利上 → 两个不同键** → `hasExternalIdConflict` 触发 → Tier 2 归一名精确命中被守卫**跳过** → **同一真人被误拆成两条**。这是引入 bug，绝不做。
- **正确做法**：EPO `ProviderContactRecord` **不带 `externalIds`**。合并全走待办 2 的：
  - **同源/跨专利**：`createContact` 的 dedupeKey=`contactIdentity(fullName, no-email)` → 同名同公司天然幂等（二次跑不重复建）；resolve 的 **Tier 2 归一名精确**并入。
  - **跨源**（EPO ↔ CH/Impressum 同一人）：**Tier 2/3 归一名**并入同一行（写 `identity.merge` 证据）。
- **诚实边界**：EPO 无法区分**同公司同名的两个真人**（无 person id）——与既有 `decision_maker`（Impressum，名+邮箱）同级风险，方向**欠并优于错并**（待办 2 严阈值 0.9+margin）。不夸大。

> 一句话：EPO 是「**name-merge 源**」，不是「Tier 0 源」。它证明的是跨源**名并**在第 3 个源上仍稳，而非精确键。

## 4. 公司对齐（🔴 绝不挂错公司）

按 applicant 名检索，风险同 CH（非域名/税号），四道护栏：

1. **applicant 名高置信对齐**：收集命中专利里的 distinct applicant（**先按 `normForMatch` 归一名去重**——同公司拼写变体 "Siemens AG"/"Siemens Aktiengesellschaft" 不自相竞争把 margin 压 0 而误弃），`pickBestByName` 比对 `company.name`，要求 **score ≥ 0.9 且 margin ≥ 0.1**（同 CH 严门）；歧义/低置信一律弃返空。
2. **🔴 只取独家申请人专利**（对抗复审 HIGH 修）：EPO biblio 的 `applicants[]`/`inventors[]` **无「谁属谁」映射**——合著专利（Siemens+Bosch）无法判定某发明人属哪家。故**只保留独家申请人 = 对齐公司**的专利收发明人，合著专利整条弃（applicant 比对走归一名，容同公司拼写变体）。**诚实边界：漏采 < 错挂**（合著发明人不误挂、不喂错下游邮箱猜测）。
3. **国别门**：`company.country` 与 applicant 的国别（EPO biblio `residence`/`country`）**都为 alpha-2 且冲突 → 弃**（防跨境同名并）。任一非 alpha-2/缺失 → 只靠名对齐（欠并方向）。
4. **fail-safe 返空**：无置信 applicant 命中 / 无 creds / 闸门拒 → 空、不抛穿（单源不阻断 CH/decision_maker）。

## 5. 过滤旋钮（防过采个人数据 + 不误标）

发明人 ≠ 干净「决策人」（同 CH 董事的诚实性）。用户拍板的过滤 + 标注：

- **近期窗口** `sinceYear = 当前 - 5`（CQL `pd within "…"`；只取近 5 年专利的发明人，人会离职、老发明人多已不在 → 既准又少采）。
- **每公司硬上限** `cap = 25` 位 distinct 发明人（按**归一名**去重；防大公司发明人爆量涌入）。
- **诚实标注**：`title='Inventor'`、`buyingRole='technical_buyer'`（技术评估席）、`isTargetRole=false`、`seniority` 留空（专利数据不足以断资历，不夸大）。
- **不加 Reachability**：发明人无邮箱/电话（同 CH 董事，且数据最小化剥离）。但其**姓名 + 雇主喂待办 1 邮箱猜测器**下游补邮箱 —— loop 价值（本 PR 不做，只发现）。

## 6. fan-out（同公司多源经解析缝合并）

照 CH 先例：`discoverContacts`（service）与 `discoverContactsBacklog`（backlog）已**遍历全部 enabled `ContactDiscoveryAdapter`**（逐 adapter fail-safe）。EPO 自动纳入 fan-out：
- 逐 adapter try/catch fail-safe（🔴 单源失败不阻断其余）；各自以 `adapterKey='epo_ops'` 调 `persistDiscoveredContacts`；
- **同一 tx 内顺序 persist** → EPO 发明人与 CH 董事/Impressum 决策人经 `resolvePersonIdentity` 归一名合并（同一人多源落一条）。

## 7. 合规红线

| 红线 | 落实 |
|---|---|
| 🔴 **CC BY 4.0 署名义务** | EPO OPS 数据 = CC BY 4.0（2026 起显式覆盖 API 数据）。发明人证据（identity.merge / person.profile）写 `field_evidence.license='CC-BY-4.0'`（**非**硬编码 licensed，照 TED CC BY 先例）；attribution 串留 `source_policy.notes` + 本文件。 |
| 🔴 **具名个人 = 个人数据** | 发明人一律 `personalData=true` → persist 写 `person.profile`（`personal_data:true` 标记，`allowedActions` 不含 outreach）→ 触达前必过 lawful-basis / suppression 门。 |
| 🔴 **数据最小化**（GDPR Art.5(1)(c)） | 只摄 inventor `name`。**绝不摄入** residence / 地址 / 国籍（`mapInventor` 根本不映射——源头剥离）。 |
| 🔴 **用途门 fail-closed** | `epo_ops.search` = required 工具，直连前过 §8.8 门（未登记/SUSPENDED/用途不符即拒、不出网）。 |
| 单源 fail-safe | 无 creds / 网络失败 / 闸门拒绝 / token 取不到 → 返空，不抛穿。 |

CC BY attribution 串：`Data © European Patent Office (EPO), licensed under CC BY 4.0.`

## 8. 诚实边界（不夸大）

- **不做公司富集**：本期只做 contact discovery（发明人）。EPO 也能富集技术画像（IPC/CPC 分类、同族），留后续。
- **发明人 ≠ 直接可达**：EPO 发明人**无邮箱/电话** → 不加 Reachability 分（Reachability 只认 VALID 联系点）。「找到对的人」≠「联系得上」，触达仍需邮箱发现/验证（待办 1）。
- **无 Tier 0 / 无 person id**：见 §3。同公司同名两真人无法区分（欠并方向）。
- **合著专利漏采**（§4 护栏 2）：只取独家申请人专利 → 合著专利（联合申请）的发明人不采。这是为「绝不错挂」付的覆盖代价（漏采 < 错挂），可接受；大公司/SME 多数专利为独家申请，覆盖损失有限。
- **无 schema 迁移**：不产 externalIds，复用既有 `canonical_contact` + `contact_point`（email/phone/…）+ `field_evidence`，零迁移。
- **精确 API 契约**（auth 端点 / JSON 路径 / CQL 细节）以真实 API 实测校准（对齐 CH 先例）。
- **seed 默认 DISABLED**（对抗复审 MEDIUM 修）：解析目前仅对合成 fixture 校准，真库真 API 未跑（EPO 审批中）→ `epo_ops` data_provider seed 为 **DISABLED**，待 `verify-epo-ops.mts` 真测通过后翻 ENABLED（`update:{}` 不覆盖手动改；verify 直连 provider 不经路由，DISABLED 不挡真测）。

## 9. 实测口径（真库真 API，无 sandbox）

`scripts/verify-epo-ops.mts`（app_user 硬 guard，cleanup 限 test 数据）：
- **A · 真 API**：`provider.discoverContacts` 打 EPO（真欧洲专利公司，如 SIEMENS/DE 或某泵企）→ 断言真拉 ≥1 名近期发明人 + 每人 `personalData` + CC BY license + 🔴 无地址/国籍/residence 入结果（数据最小化）。
- **B · 真落库**：`persistDiscoveredContacts` → `canonicalContact` + `person.profile` 证据；**二次跑幂等**（Tier 2 归一名命中并入 / 名 dedupeKey 不重复建）。
- **C · 跨源并**：先 seed 同名 Impressum 联系人（decision_maker，带邮箱）→ 再跑 EPO → **Tier 2 归一名并进同一行** + `identity.merge` 证据（兑现待办 2 跨源合并，第 3 个源）。
- **D · §8.8 用途门**：去掉 `source_policy` 的 discovery 用途 → EPO 直连被拒（零发明人）。
