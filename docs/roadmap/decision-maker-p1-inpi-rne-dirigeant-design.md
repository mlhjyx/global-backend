# 待办 3 · 第三个身份源 = INPI RNE dirigeants（法国注册处 · 经开放政务网关）

> 设计定稿 2026-07-11 · 分支 `feat/fr-dirigeants` · 承接待办 3 首源（UK Companies House，PR #58/#59）+ 第二源（EPO OPS 发明人，PR #61）
> 权威决策见 `docs/adr/registry.md`；立项 spec 见 `decision-maker-multi-source-spec.md` §5。本文件只记本期设计 + 合规 + 边界。

## 0. 一句话

把 **法国 dirigeants（公司注册处法定负责人）**接成待办 3 的**第三个身份源**：
按公司名检索 **API Recherche d'entreprises**（`recherche-entreprises.api.gouv.fr`，DINUM 维护，**数据源 = INPI RNE + INSEE Sirene**）→ 抽**具名 dirigeant（personne physique）= 经济买家（Gérant / Président / Directeur Général…）** → 高置信对齐公司 → 经**跨源归一名（待办 2 的 Tier 2/3）**并入决策人图谱，把董事覆盖扩到**法国核心 EU 市场**。

## 1. 为什么这条路（选型 + 为何走开放网关而非鉴权 INPI）

**先说初选与转向**：待办 3 第三源原定 **INPI RNE 鉴权 API**（`registre-national-entreprises.inpi.fr`，token via `/api/sso/login`）。评估后转向**开放政务网关**：

| 维度 | 鉴权 INPI RNE | ✅ 开放 API Recherche d'entreprises |
|---|---|---|
| 鉴权 | INPI 账号 + 申请 API 权限（**有审批延迟风险，重蹈 EPO #61 卡审批**） | **免注册、免 key、零鉴权** |
| 本会话真测 | ❌ 可能卡审批 | ✅ **已实测**（`safran` → 1926 命中，每家带 `dirigeants[]`） |
| 数据源 | INPI RNE | **同 INPI RNE**（+ INSEE Sirene）——就是 RNE 数据，只是走开放网关 |
| 对本期价值 | 只要 dirigeant 名+职务，鉴权版**无额外价值** | 同样给 dirigeant 名+职务+qualite |
| person Tier 0 | 无（法国不公示个人级 id） | 无（同）|

→ **严格劣汰**：开放网关满足硬约束「真实数据、无 sandbox、当场真测」（CLAUDE.md §5），避开 EPO #61 的审批坑。

**这条路的优点**：
- **官方政务 API、非爬**：延续 CH/TED/openFDA/EPO「官方 API 非爬」先例，平台合约轨干净。
- **dirigeant = 具名经济买家**：法定公司负责人依法公示，是「经济买家 / Owner / GM」（对齐买家委员会），比 EPO 发明人更贴「对的人」。
- **免费 + 绿事实**：Licence Ouverte 2.0（Etalab，署名义务，同 CH 的 OGL 定位）。
- **合规内建**：开放网关**自动排除 non-diffusible（entreprises non-diffusibles）**——选择不公示个人数据的公司天然不返回。

**诚实取舍**（见 §3）：法国 dirigeant **没有稳定到人的 id**（`SIREN` 是**公司** id 不是人 id），故本源**不走 Tier 0**，走待办 2 的归一名合并——是合法的待办-3 源（补法国经济买家覆盖 + 再压测跨源名并健壮性），但不复刻 CH 的 Tier 0 精确键（**与 EPO 同级**）。

## 2. 架构（复用发现四层，零新 SourceClass）

延用 `L0 client → L0 Tool（ToolBroker 治理）→ Provider` 分层（抄 CH/EPO 先例）：

| 层 | 文件 | 职责 |
|---|---|---|
| L0 原始 HTTP client | **新** `adapters/inpi-rne.ts` | `searchCompaniesWithDirigeants(name, {limit})`：`GET /search?q=<名>&per_page=N` → 每命中 `{siren, nom_raison_sociale, dirigeants[]}`（**dirigeants 内联在搜索响应**，一次调用同得公司+负责人，比 CH 少一跳）。可注入 fetch 测。🔴 **数据最小化 map**：dirigeant 只取 `nom / prenoms / qualite / type_dirigeant`，**源头剥离** `date_de_naissance` / `annee_de_naissance` / `nationalite`。 |
| L0 Tool（治理包装） | **改** `tools/source-tools.ts` 加 `inpi_rne.search` | `sourcePolicy:'required'` + `policyDomain:'recherche-entreprises.api.gouv.fr'` + `personalData:true` + `authRequired:false`（开放 API）→ **§8.8 用途门 fail-closed**（未登记/SUSPENDED/用途不符即拒）。注册进 `registerSourceTools`。 |
| Provider | **新** `providers/inpi-rne.provider.ts` `InpiRneContactProvider`（`ContactDiscoveryAdapter`，key=`inpi_rne`） | FR 门 → 公司对齐门 → dirigeant（personne physique）→ `ProviderContactRecord`（fullName + `personalData:true` + `license:'Licence-Ouverte-2.0'` + buyingRole，**无 externalIds**）。 |
| 接线 | **改** `provider.registry.ts` | `contacts.push(new InpiRneContactProvider({broker}))` + `dataProvider` seed（key=`inpi_rne`, class=`contact_discovery`, **ENABLED**——本源可本会话真测，不同于 EPO 的 DISABLED）+ `source_policy` 行（domain=`recherche-entreprises.api.gouv.fr`, Licence Ouverte 2.0 署名串入 notes）。 |

**为什么经 Broker**：dirigeant = 具名个人数据源，直连前必过 `source_policy` 用途门（§8.8 fail-closed）。无 broker = 不允许原始出网（诚实降级空结果，绝不绕闸门）。**无 OAuth**（开放 API，与 EPO 的 token 管理不同——更简单）。

## 3. 身份合并（🔴 为何法国 dirigeant 不产 externalIds / 不走 Tier 0）

同 EPO：法国 dirigeant（personne physique）**无消歧到人的稳定 id**（`nom/prenoms/qualite/DOB` 而已；法国出于隐私不公示个人级国家标识）。`SIREN` 是**公司** id，不是人 id。

- 若硬拿「SIREN + 名字」凑 person externalId，同一 dirigeant 在两家公司任职 → 两个不同键，且 `hasExternalIdConflict`（假设「同 scheme 不同值=不同人」）会误触发。**绝不做**。
- **正确做法**：`ProviderContactRecord` **不带 `externalIds`**。合并全走待办 2：
  - **同源/跨跑**：`createContact` 的 dedupeKey=`contactIdentity(fullName, no-email)`（#65 盲化）→ 同名同公司天然幂等；resolve 的 **Tier 2 归一名精确**并入。
  - **跨源**（法国 dirigeant ↔ CH 董事 / Impressum 同一人）：**Tier 2/3 归一名**并入同一行（写 `identity.merge` 证据）。

**诚实边界 · 同名两真人**（🔴 直面 #62 遗留）：本源无 email 无 externalId，是**纯名并源**——同公司两个真同名 dirigeant（法国 SME 有母女共同 gérante 之类）无法区分。这与既有 `decision_maker`（Impressum）、EPO 发明人**同级**：#62 的 Tier 2「唯一才并」**故意保留**唯一同名合并以维持幂等（≥2 才判歧义），故两同名真人会并成一条。这是 name-merge 的**内在**限制、**方向欠并优于错并**（严阈值 0.9+margin），#62 复审已把 create 路径的同名合并评为 **P2 可接受**。本源**不改共享 persist**（避免搅动 #62/#65 刚落的地基），改为：**实测显式覆盖同名场景**（§9 D），文档如实交底，不夸大。

> 一句话：法国 dirigeant 是「**name-merge 源**」（同 EPO），不是「Tier 0 源」。它证明跨源名并在**第 3 个源**上仍稳，并把经济买家覆盖扩到法国。

## 4. 公司对齐（🔴 绝不挂错公司）

按公司名检索**法国注册库**（全库皆法国公司），四道护栏：

1. **🔴 FR 门**（`isFrCompany`，country 优先，镜像 CH 的 `isUkCompany`）：`country ∈ {FR/FRA/France/…}` **或**（country 缺失时弱兜底）`domain` 以 `.fr` 结尾，否则返空。**防**：把德国 KAESER 的名字丢进法国库 → 命中「KAESER FRANCE」误挂。只对我方认定为法国的公司搜。
2. **公司名高置信对齐**：`pickBestByName`（复用富集共享匹配器）比对 `nom_raison_sociale`，要求 **score ≥ 0.9 且 margin ≥ 0.1**（同 CH/EPO 严门，比公司发现门 0.72 严）；歧义/低置信一律弃返空。
3. **只取 personne physique dirigeant**：`type_dirigeant === 'personne physique'`。**跳过** personne morale（法人负责人=另一家公司，非我们要的自然人买家）+ 跳过 `Commissaire aux comptes`（外部审计师，非买方委员会成员）。
4. **fail-safe 返空**：无置信命中 / 无 broker / 闸门拒 → 空、不抛穿（单源不阻断 CH/decision_maker/EPO）。

> 与 CH 差异：CH 搜索命中不含 officers、需二跳取董事；本 API 的 `dirigeants[]` **内联在搜索响应**，一跳同得公司+负责人。

## 5. 过滤旋钮（防过采个人数据 + 不误标）

- **每公司硬上限** `cap = 25` 位 distinct dirigeant（按**归一名**去重；防大公司负责人爆量）。
- **角色分类 + 标注**（`qualite` → buyingRole）：
  - 执行位（`gérant` / `président` / `directeur général` / `directeur` / `administrateur` / `directoire` / `associé indéfiniment responsable`）→ `economic_buyer`、`seniority='executive'`。
  - 其它 personne physique dirigeant → `decision_maker`（泛，不夸大）。
  - `title` = 可读 `qualite`（如「Gérant」「Président」）；`isTargetRole=false`（🟡 保守：结构化数据不足以断言匹配卖方 ICP 具体画像）。
- **不加 Reachability**：dirigeant 无邮箱/电话（数据最小化剥离，且 API 本就不给）→ 不加 Reachability 分（同 CH/EPO）。但其**姓名 + 雇主喂待办 1 邮箱猜测器**下游补邮箱 —— loop 价值（本 PR 不做，只发现）。

## 6. fan-out（同公司多源经解析缝合并）

照 CH/EPO 先例：`discoverContacts`（service）与 `discoverContactsBacklog`（backlog）已**遍历全部 enabled `ContactDiscoveryAdapter`**（逐 adapter fail-safe）。本源自动纳入 fan-out：
- 逐 adapter try/catch fail-safe（🔴 单源失败不阻断其余）；各自以 `adapterKey='inpi_rne'` 调 `persistDiscoveredContacts`；
- **同一 tx 内顺序 persist** → 法国 dirigeant 与 CH 董事 / Impressum 决策人经 `resolvePersonIdentity` 归一名合并（同一人多源落一条）。

## 7. 合规红线

| 红线 | 落实 |
|---|---|
| 🔴 **Licence Ouverte 2.0 署名义务** | 数据 = INSEE(Sirene) + INPI(RNE) 经 API Recherche d'entreprises（DINUM），Licence Ouverte / Open Licence 2.0（Etalab）。`ProviderContactRecord.license='Licence-Ouverte-2.0'` 随记录传递：**跨源合并**时写进 `identity.merge` 证据（`c.license`，非硬编码 licensed）；**源级** attribution 串 durably 记在 `source_policy.notes`（+ 本文件）——每条记录都受该 policy 行治理。诚实注：dirigeant 无联系点，**新建行仅 `person.profile` 证据**，沿用共享 persist 的 `license:'public'` 类（同 CH/EPO，本 PR 不动共享 persist）；把源许可回填进 `person.profile`（per-record）是**跨源改进**（同惠 EPO），归 fast-follow。 |
| 🔴 **具名个人 = 个人数据**（GDPR Art.14） | dirigeant 一律 `personalData=true` → persist 写 `person.profile`（`personal_data:true` 标记，`allowedActions` 不含 outreach）→ 触达前必过 lawful-basis / suppression 门。法国是 EU → GDPR 全套（同 CH/EPO）。 |
| 🔴 **数据最小化**（GDPR Art.5(1)(c)） | 只摄 dirigeant `nom / prenoms / qualite`。**绝不摄入** `date_de_naissance` / `annee_de_naissance` / `nationalite`（`mapDirigeant` 根本不映射——源头剥离，即便 API 主动吐出）。 |
| 🔴 **非公示尊重** | 开放网关自动排除 `entreprises non-diffusibles`（选择不公示者不返回）——合规内建，我方无需额外过滤。 |
| 🔴 **用途门 fail-closed** | `inpi_rne.search` = required 工具，直连前过 §8.8 门（未登记/SUSPENDED/用途不符即拒、不出网）。 |
| 单源 fail-safe | 无 broker / 网络失败 / 闸门拒绝 → 返空，不抛穿。 |

Licence Ouverte attribution 串：`Données INSEE (Sirene) et INPI (Registre National des Entreprises) via l'API Recherche d'entreprises (DINUM), Licence Ouverte 2.0.`

## 8. 诚实边界（不夸大）

- **不做公司富集**：本期只做 contact discovery（dirigeant）。RNE 也能富集法律身份（forme juridique / SIREN / 注册地址 / 财务），留后续。
- **dirigeant ≠ 直接可达**：无邮箱/电话 → 不加 Reachability 分。「找到对的人」≠「联系得上」，触达仍需邮箱发现/验证（待办 1）。
- **无 Tier 0 / 无 person id**：见 §3。同公司同名两真人无法区分（name-merge 内在限制，#62 已评 P2 可接受）。
- **可读名 best-effort**：`titleCase(prenoms + ' ' + nom)`。特殊大小写（`D'Angelo` 等）为最佳努力（不影响跨源合并——合并走 `normalizePersonName` 归一）。
- **无 schema 迁移**：不产 externalIds，复用既有 `canonical_contact` + `contact_point` + `field_evidence`，零迁移。
- **精确 API 契约**（JSON 路径 / 分页 / qualite 取值面）以真实 API 实测校准（对齐 CH/EPO 先例；单测用注入假 fetch，不依赖线上形状）。
- **seed 默认 ENABLED**（与 EPO 差异）：本源开放 API 可本会话真测通过 → `inpi_rne` data_provider seed 为 **ENABLED**（同 CH）。`update:{}` 不覆盖手动改。

## 9. 实测口径（真库真 API，无 sandbox）

`scripts/verify-inpi-rne.mts`（app_user 硬 guard，cleanup 限 test 数据）：
- **A · 真 API**：`provider.discoverContacts` 打真实法国公司（FR，如某泵企 / SME）→ 断言真拉 ≥1 名 dirigeant + 每人 `personalData` + Licence Ouverte license + 🔴 无 DOB/annee/nationalite 入结果（数据最小化）+ 无 externalIds。
- **B · 真落库**：`persistDiscoveredContacts` → `canonicalContact` + `person.profile` 证据；**二次跑幂等**（Tier 2 归一名命中并入 / 名 dedupeKey 不重复建）。
- **C · 跨源并**：先 seed 同名 Impressum 联系人（decision_maker，带邮箱）→ 再跑本源 → **Tier 2 归一名并进同一行** + `identity.merge` 证据（兑现待办 2 跨源合并，第 3 个源）。
- **D · 🔴 同名边界**：显式覆盖「同公司两个真同名 dirigeant」——如实观察合并行为（唯一同名→并；≥2→歧义不并），确认与 §3 交底一致（不掩盖 name-merge 内在限制）。
- **E · §8.8 用途门**：去掉 `source_policy` 的 discovery 用途 → 本源直连被拒（零 dirigeant）。
