# 待办 3 · P1 第一个身份源 = UK Companies House（官方公司注册处）

> 设计定稿 2026-07-11 · 分支 `feat/companies-house-identity` · 承接待办 2（PR #54，`resolvePersonIdentity` 4-Tier 解析缝）
> 权威决策见 `docs/adr/registry.md`；本文件只记本期设计 + 合规 + 边界。

## 0. 一句话

把 **UK Companies House**（英国官方公司注册处，`api.company-information.service.gov.uk`）接成待办 3 的**第一个身份源**：
CH 董事（active director）经 `externalIds`（scheme `uk-ch-officer`）走 **Tier 0 externalId 精确并/新建**——
**同一董事若也在 Impressum/其它源出现 → 自动并成一条**（跨源身份收口）。

本期兑现待办 2 留在 `resolveAmongCandidates` 的 **Tier 0 空缝**（机制早写好，缺「谁产 externalId + 谁写 external_id contactPoint」两端）。

## 1. 为什么是 CH（选型）

- **官方注册处、零爬取**：REST API（Basic auth，key 作 username、空 password），非爬官网 → 平台合约轨干净（对齐 TED/openFDA「官方 API 非爬」先例）。
- **董事 = 具名经济买家**：CH 依法公示公司 active director（对齐买家委员会「经济买家/决策人」维），且带**稳定 officer_id**（`/officers/{OFFICER_ID}/appointments`）→ 天然 Tier 0 精确键（跨源、跨时间稳定，不靠人名模糊）。
- **免费**（CLAUDE.md §6 免费优先）：CH 免费数据产品 + API，OGL v3.0（Crown copyright，可商用、署名义务）。

## 2. 架构（复用三层，零新 SourceClass）

延用发现四层的 **L0 Tool → ToolBroker → Provider** 分层（抄 ted/openfda 先例）：

| 层 | 文件 | 职责 |
|---|---|---|
| L0 原始 HTTP client | `adapters/companies-house.ts` | `searchCompanies(q)` + `listOfficers(number)`，Basic auth、429/5xx 退避、**数据最小化映射**（只取 name/role/resigned/officer_id）。可注入 fetch/key 测。 |
| L0 Tool（治理包装） | `tools/source-tools.ts` `companies_house.search` | `sourcePolicy:'required'` + `policyDomain:'api.company-information.service.gov.uk'` + `personalData:true` → **§8.8 用途门 fail-closed**（未登记/SUSPENDED/用途不符即拒）。 |
| Provider | `providers/companies-house.provider.ts` `CompaniesHouseContactProvider`（`ContactDiscoveryAdapter`，key=`companies_house`） | GB 门 → 公司对齐（高置信 margin）→ 取 active director → `ProviderContactRecord`（externalIds + personalData + license）。 |

**为什么经 Broker**：CH = 具名个人数据源，直连前必须过 `source_policy` 用途门（§8.8 fail-closed）。无 broker = 不允许原始出网（诚实降级空结果，绝不绕闸门）。

## 3. Tier 0 兑现（待办 2 的空缝）

待办 2 的 `resolveAmongCandidates` 已实现 Tier 0（externalId 精确），但两端缺失：

1. **产 externalId**：`ProviderContactRecord` 新增 `externalIds?: {scheme;value}[]`；CH provider 对每个董事产 `[{scheme:'uk-ch-officer', value:<OFFICER_ID>}]`。
2. **写 external_id contactPoint**：`contact-persist.ts` 的 points 循环新增 `external_id` 点（value=`${scheme}:${value}`，**与 person-identity Tier 0 查法一致**——它 `${scheme}:${value}`.toLowerCase() 比对）；并把 `externalIds` 传进 `resolvePersonIdentity`（Tier 0 生效）。

**解析优先级**（同 companyId 内，`resolveAmongCandidates`）：Tier 0 externalId → Tier 1 邮箱 → Tier 2 归一名精确 → Tier 3 高置信模糊。
- 二次跑 CH：候选已有 external_id 点 → **Tier 0 命中**并入（幂等，不重复建）。
- 跨源并：Impressum 先落「John Smith」（无 externalId）→ CH 跑「John Smith」（有 officer_id）→ Tier 0 miss（旧行无该点）→ **Tier 2 归一名精确命中** → 并入 Impressum 行 + 补写 external_id 点 → 此后 CH 再跑走 Tier 0。

## 4. 公司对齐（🔴 绝不挂错公司）

CH 是**按公司名搜**（非按域名/税号），最易错挂。三道护栏：

1. **GB 门**：`country ∈ {GB/UK/GBR/United Kingdom/…}` **或** `domain` 以 `.uk` 结尾，否则返空（不搜非英公司，防把英国某同名公司的董事挂到一家德国公司）。
2. **只留 active 公司**：`company_status === 'active'`（dissolved/liquidation 的董事无 GTM 价值且易撞名）。
3. **高置信 + margin**：`pickBestByName`（复用富集共享匹配器）要求 **score ≥ 0.9 且 margin ≥ 0.1**（比公司发现门 0.72 更严；歧义/低置信一律弃，返空）。

## 5. fan-out（同公司多源经解析缝合并）

此前 `discoverContacts`（service）与 `discoverContactsBacklog`（backlog）只用 `adapters[0]`（decision_maker），CH 永不被调用。改为**遍历全部 enabled 的 `ContactDiscoveryAdapter`**：
- 逐 adapter try/catch **fail-safe**（🔴 单 adapter 失败不阻断其余）；
- 各自以自己的 `adapterKey` 调 `persistDiscoveredContacts`；
- **同一 tx 内顺序 persist** → 后一 adapter 的 resolve 能看到前一 adapter 刚插入的行 → 同一人经 `resolvePersonIdentity` 合并（decision_maker 的 email + CH 的 officer_id 落到同一条）。
- backlog 的水位 stamp / DAT-011 / usage 记账逻辑保持。

## 6. 合规红线

| 红线 | 落实 |
|---|---|
| 🔴 **数据最小化**（GDPR Art.5(1)(c)） | 只摄 `name + officer_role + resigned_on + officer_id`。**绝不摄入** date_of_birth / nationality / occupation / 住址（`mapOfficer` 根本不映射这些字段——源头剥离）。 |
| 🔴 **具名个人 = 个人数据** | 董事一律 `personalData=true` → `persist` 写 `person.profile` 证据（`personal_data:true` 标记，`allowedActions` 不含 outreach）→ 触达前必须过 lawful-basis / suppression 门。 |
| 🔴 **license 署名义务** | CH 数据 = OGL v3.0（Crown copyright）。董事证据（external_id 点 + identity.merge）写 `field_evidence.license='OGL-UK-3.0'`（**非**硬编码 'licensed'，照 TED CC BY 先例）；attribution 串留在 `source_policy.notes` + 本文件。 |
| 🔴 **用途门 fail-closed** | `companies_house.search` = required 工具，直连前过 §8.8 门（未登记/SUSPENDED/用途不符即拒、不出网）。 |
| 单源 fail-safe | 无 key / 网络失败 / 闸门拒绝 → 返空，不抛穿（不阻断 decision_maker 等其余源）。 |

## 7. 诚实边界（不夸大）

- **不做公司富集**：本期只做 contact discovery（董事）。CH 也能富集公司法律身份（SIC/注册地址/成立日），留 P2/后续。
- **董事 ≠ 直接可达**：CH 董事**无邮箱/电话**（数据最小化 + CH 不公示邮箱）→ 不加 Reachability 分（Reachability 只认 VALID 联系点）。这是诚实的——「找到对的人」≠「联系得上」，触达仍需邮箱发现/验证。
- **可读名 best-effort**：`"SURNAME, Given"` → `"Given Surname"` + 词首大写（`titleCase`）。`McDonald`/`O'Brien` 等特殊大小写为最佳努力（不影响跨源合并——合并走 `normalizePersonName` 归一，与显示名无关）。
- **无 schema 迁移**：external_id 复用既有 `contact_point`（type='external_id'）+ `field_evidence`，零迁移（对齐待办 2 的 Tier 0 TODO：「勿为它加 schema」）。
- **`data_class` 未改**：具名董事的 `field_evidence.data_class` 沿用 persist 现默认（个人数据标记走 `person.profile` value JSON 的 `personal_data:true`，与 decision_maker 一致）；收口⑥的 data_class='red' 全路径回填是独立的活，不在本期扩面。

## 8. 实测口径（真库真 API，无 sandbox）

`scripts/verify-companies-house.mts`（app_user 硬 guard，cleanup 限 test 数据）：真英国公司（如 ASTRAZENECA/GB）→ 跑 provider → 断言真拉 active director（≥1）+ 每人 uk-ch-officer externalId + 无 DOB/nationality 入库 + personalData + OGL license 证据 → persist 落库 → external_id 点存 → **二次跑幂等**（Tier 0 命中并入）→ **跨源并**（先 seed 同名 Impressum 联系人 → CH 跑 → Tier 2 名并进同一行 + identity.merge 证据）。
