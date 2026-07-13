# 待办 3 · BigQuery Google Patents 发明人身份源（替代被封 EPO OPS）

> 状态：代码完成 + CI 绿（342 vitest），seed **DISABLED**，真库真测待 GCP 服务账号 key。
> 这是「选项 B · 决策人多途径身份源」待办 3 的**专利发明人**能力——原定 EPO OPS（PR #61）因账号被网关封禁停摆，改走 **BigQuery Google Patents Public Data**（等价数据、更低门槛：仅需 Google 账号，无审批/无身份墙/无封号风险）。

## 1. 为什么换 EPO → BigQuery Google Patents

| | EPO OPS（PR #61 停摆） | PatentsView（弃） | **BigQuery Google Patents（本方案）** |
|---|---|---|---|
| 门槛 | 管理员审批 → 账号被封 | ID.me 美国身份墙 | 免费 GCP 项目 + 服务账号 key |
| 审批等待 | 有，且被拒 | — | 无 |
| 身份验证 | — | 要美国证件 | 无 |
| 封号风险 | 真踩到 | — | 无 |
| 覆盖 | EP/WO 为主 | 美国为主 | **全球谐调**（DOCDB/多局） |
| 额度 | ~4GB/周 | — | 1TB/月查询免费 |

数据面：`patents-public-data.patents.publications`（Google Patents Public Data，IFI CLAIMS 谐调）。取 `assignee_harmonized`（申请人=公司，含 alpha-2 country_code）+ `inventor_harmonized`（发明人=具名技术买家）+ `publication_date`（INT64 YYYYMMDD）。

## 2. 复用 #61 的对齐/合规逻辑（DRY，源无关）

provider 层（`discovery/providers/bigquery-patents.provider.ts`）几乎原样移植自 EPO 的 `epo-ops.provider.ts`——那套护栏是**源无关**的，只把 L0 数据客户端从 EPO OPS REST 换成 BigQuery：

- **高置信对齐**：applicant 名 `pickBestByName` score ≥ 0.9 且 margin ≥ 0.1（比公司发现门 0.72 更严）；低置信/歧义**即弃返空**——🔴 绝不把 A 公司发明人挂到 B 公司。
- **归一名去重 applicant 候选**：同公司拼写变体（"Siemens AG"/"Siemens Aktiengesellschaft"）不自相竞争压 margin 误弃。
- **只取独家申请人专利**：biblio 的 applicants[]/inventors[] 无「谁属谁」映射 → 合著专利（Siemens+Bosch）整条弃，防合作方员工误挂（诚实边界：漏采 < 错挂）。
- **国别门**：company 与 applicant 国别都为 alpha-2 且不同 → 弃（防跨境同名并）。
- **近 5 年 + 每公司上限 25 位** distinct 发明人（防大公司爆量 + 数据最小化）。
- **归一名并（非 Tier 0）**：Google Patents/IFI 无消歧到人的稳定 person id → **不产 externalIds**，合并走待办 2 的 `resolvePersonIdentity` Tier 2/3 归一名（硬凑「公开号+名字」键会令同一人跨专利被 `hasExternalIdConflict` 误拆）。

## 3. 🔴 合规

- **数据最小化**（GDPR Art 5(1)(c)）：发明人**只取 name**，adapter 层（`normalizeRow`）就丢弃 inventor 的 country_code 及其它字段；verify A 段有正则硬自检「结果无 residence/地址/国籍/country_code」。
- **具名个人**：`personalData=true` → persist 写 `person.profile` 证据 + lawful-basis 门前置（同 CH/EPO/INPI）。
- **署名义务**：`GOOGLE_PATENTS_LICENSE='CC-BY-4.0'` 写入 `field_evidence.license`（非硬编码 licensed）。
  ⚠️ **ENABLE 前须核实**：Google Patents Public Data 的确切 license/attribution 文案以数据集 BigQuery 元数据为准（Google Patents Public Data / IFI CLAIMS Patent Services）——real-verify 阶段确认后再翻 ENABLED。
- **§8.8 用途门 fail-closed**：`google_patents.search` = required 工具，policyDomain `bigquery.googleapis.com`，直连前过用途门（verify D 段证明去 discovery 用途 → 零发明人）。
- **成本护栏**：`maximumBytesBilled` 硬顶（默认 200GB/查询，`GOOGLE_PATENTS_MAX_GB` 可调）——BigQuery 若预估扫描超顶即拒（fail-closed），护 1TB/月免费额度。
- **fail-safe**：无 SA key / 无 project / 查询失败 / 超额 → 返空、不抛穿（单源不阻断其余）。SA key 文件 🔴 gitignored，绝不入库。

## 4. ⚠️ 规模警示（诚实边界）

`patents-public-data.patents.publications` **无 assignee 分区/聚簇** → 每次按公司查询按列**全表扫描**（`WHERE assignee LIKE` 在扫描后过滤，不减字节）。只 SELECT 2 列压字节，单查约数十 GB。

- **对有界样本/周期性 sweep**：1TB/月免费额度足够（~10–20 查询/月）。
- **不适合高频实时逐公司查**：`maximumBytesBilled` 会 fail-closed 拒超额（护额度但那次查询无结果）。
- **生产规模 fast-follow**：一次性物化「近 N 年 assignee→inventor」过滤表进自有 dataset，再对小表廉价查（后续 P 级迭代，非本 PR）。

## 5. 落地清单

| 文件 | 作用 |
|---|---|
| `adapters/bigquery-patents.ts` | L0 客户端：SQL 构造 + `maximumBytesBilled` 护栏 + `normalizeRow` 数据最小化 + 无 creds fail-safe |
| `discovery/providers/bigquery-patents.provider.ts` | 对齐/独家申请人/国别门/cap/归一名并（移植自 EPO，源无关） |
| `tools/source-tools.ts` | `google_patents.search`（required，personalData=true，policyDomain=bigquery.googleapis.com） |
| `discovery/provider.registry.ts` | fan-out push + 种子 `google_patents` **DISABLED** + `bigquery.googleapis.com` source_policy |
| `scripts/verify-google-patents.mts` | 真库真 API 四段（真 API / 落库幂等 / 跨源名并 / §8.8 门），app_user 硬 guard |
| `*.spec.ts` ×2 | 30 单测（adapter 纯函数 + 成本护栏 + provider 全护栏） |

## 6. ENABLE 前置（真库真测）

1. 建免费 GCP 项目 + 服务账号（授 BigQuery Job User），下载 JSON key（无审批/无身份墙）。
2. `.env` 设 `GOOGLE_PATENTS_SA_JSON`（key 文件路径，仓库外）+ `GOOGLE_PATENTS_PROJECT`。
3. `node --import tsx scripts/verify-google-patents.mts` 四段全绿。
4. 核实 CC BY attribution 文案 → 由 ops 手动/reseed 把 `google_patents` data_provider 翻 ENABLED。
