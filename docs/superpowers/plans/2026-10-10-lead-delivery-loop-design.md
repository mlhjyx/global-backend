# 线索交付闭环：交付包 v1.1、周报、反馈、建议联系路径与开发信草稿

> 生命周期：`APPROVED`
> 生命周期依据：产品负责人 2026-10-10 会话内按 §10 的建议拍板 E1–E9，并决定客户的跟进前台只用 GrowthOS（不接其他 CRM）。

事实基线：`origin/main@9b712b97`。只读核对代码与库。对应需求 BI-15、BI-19、BI-20、BI-21、BI-22、BI-23；依赖 BI-14（公司级联系路径，施工中）。代码位置相对 `apps/api/src/`，写作「文件:行」。

## 0. 结论

- **一个读模型，三处用**：新增按线索组装的 `LeadPackage`。它同时供 accept 时的 `LeadQualified` 快照、周报导出、运营查看使用，三处口径一致。
- **事件合同**：在 v1 schema 里加**可选**字段，`snapshot_version` 仍为 1，不另开 v2 文件。依据：
  - 仓库一直这样演进（`sanctions_screening` 就是直接加进 v1 的）；
  - 架构文档主张不开 v2，以免消费者面对新旧混流（`docs/architecture/current.md:170`）；
  - 唯一的消费者 GrowthOS 只读事件类型与 ID，不读 payload 字段（tenant-web `opportunities-global-api.ts:218-223`）。
- **原因码（BI-20）**：三组枚举——拒绝原因、客户反馈原因、Fit 原因。拒绝时 `reason_code` 必填，原来的自由文本保留为备注。
- **成本（BI-19）**：
  - run 级取账本精确值；
  - 线索级 = 能归到这家公司的操作（官网画像、Fit 判定）+ run 级共享成本（规划、搜索、判站）均摊，标「分摊估算」；
  - 金额是后端账本口径，网关配价（D15）之前与上游实收不一致，导出时注明。
- **证据 URL（BI-21）**：`field_evidence` 加 `source_url` 列，在写入点补上已经算出却被丢掉的来源 URL；物化证据的 `fetched_at` 改用原始记录的抓取时间。
- **周报（BI-22）**：
  - 接口 `GET /reports/weekly?icpId=&week=` 返回 UTF-8 带 BOM 的 CSV，Excel 直接打开；
  - 每行一条本周 accepted 的线索；
  - 导出前逐条判 DataRights `EXPORT` 并留痕，红色数据不出现；
  - 末尾 5 列留给客户填写。
- **反馈（BI-23）**：
  - 新表 `lead_outcome`；
  - 单条反馈走 `POST /leads/:id/outcomes`；
  - 客户填好的周报 CSV 原样上传，走 `POST /reports/weekly/feedback`，批量入库；
  - RLS 隔离。
- **建议联系路径与开发信草稿（BI-15）**：
  - 规则选入口，顺序为供应商入驻页 > 询盘表单 > 联系页 > Impressum 页；
  - 模型按这家公司的证据与卖方资料，起草目标国语言的首封询盘，附中文译文给销售看；
  - 存为线索的草稿，周报输出；平台不发送。
- **公司注册地址**：从 Impressum 抽公司注册地址，用于寄信或样册，独资商号不存。先实测，若被安全系统拦下就停。
- **顺带修一个缺陷**：信号（招标、FDA 等）以「名称+国家」为主体键，有域名的公司却以「域名」为键，公开网页发现的公司都有域名，所以永远挂不上信号（§1.5）。

## 1. 现状核实

### 1.1 快照何时生成、读什么

- 只在 `decide(accept)` 里生成，同一个 `withWorkspace` 事务（`lead/lead.service.ts:166-461`）。依次：
  - 禁联锁、公司行 `FOR UPDATE`；
  - 读公司、联系人、联系点；
  - DataRights `STORE`、制裁核对、ICP 版本；
  - 按数据分级取最早 `fetched_at`；
  - CAS 更新线索、写 `lead_decision`、`policy_decision_log`；
  - 生成快照，写 outbox。
- 快照读：线索的 Fit 结论与六维分；`attributes.gleif.lei`、`attributes.fda.registration_number`、`attributes.intent`；联系人的职位等。`score_detail`、`fit_reasons` 只以布尔值出现（`lead/lead-qualified-snapshot.ts:133-142,189-206,231-238,255-258`）。
- `recommended_action` 恒为 `handoff_to_campaign`（`:270`）；`schemaVersion` 恒为 1（`:11`；`lead.service.ts:450`）。
- 合同由 `lead/lead-qualified-snapshot.spec.ts` 以 Ajv 校验锁住（`:24-39,222-237,356-376`）。OpenAPI 把 payload 当自由对象（`events/events.controller.ts:70`）。

### 1.2 消费者

- Backend：`GET /api/v1/events`（`events/events.controller.ts:134-175`）、`POST /api/v1/events/ack`（`:177-191`）。列表不按 ACK 状态过滤，也不校验 payload（`events/events.service.ts:124-149`）。
- GrowthOS tenant-web 只检查信封字段，不检查 `snapshot_version`，也不按 schema 校验 payload。页面只显示事件类型与 ID，对前 3 条给 ACK 按钮；请求 `limit: 50`、不带游标（`opportunities-page.tsx:79,236`）。所以它只会看到最早的 50 条 `LeadQualified`。这是 GrowthOS 侧的问题，另记。

### 1.3 新字段的数据在哪

| 字段 | 现在在哪 | 缺口 |
|---|---|---|
| 贸易角色、置信度、自有制造、在售品牌 | `canonical_company.attributes.website_profile`：`trade_role`、`trade_role_confidence`、`own_manufacturing`、`carried_brands[]`、`carries_chinese_brand`、`carries_foreign_brand`（`temporal/discovery.activities.ts:305-336`），经 sanitizer 保留 | 无 |
| 商业登记号、税号 | 同上：`register_key`（形如 `de-hrb:<法院>:<号>`）、`vat_id`（只做德国并校验，`discovery/website-profile/impressum.ts:37-70`） | 登记号没有单独拆出；`OrganizationIdentifier`（ADR-007）未实现 |
| 联系路径 | BI-14 新表 `company_contact_point`（施工中） | 依赖 BI-14 |
| 信号 | `attributes.intent.events[]`（`{type, at, strength, page_kind?, page_url?}`，最多 20 条，`intent/intent-projection.service.ts:29,388-415`）；`source_signal` 没有 URL 与摘要列 | §1.5 的挂接缺陷 |
| 证据 URL | `field_evidence` 没有 URL 列（`schema.prisma:1835-1856`）。富集写入时 `provenance.sourceUrl` 已在手却被丢掉（`discovery/company-enrichment-commit.ts:72-83`）；有 `raw_record_id` 的写入点可以联到 `raw_source_record.source_url`（`temporal/discovery-company-materialization-canonical.ts:221` 等） | 要加列并补写入 |
| Fit 原因 | `fit_reasons` = `{material, role, process, business_model, reasons[]}`，四门是自由文本，只有 verdict 是枚举（`discovery/fit-judge.ts:39-47`；`ai-tasks/task-registry.ts:413-431`）；`score_detail.ruleEvaluations[]` 是结构化的（`icp/rule-engine.ts:9-34`） | 没有原因码枚举 |
| 拒绝原因 | `lead_decision.reason` 自由文本（`lead/lead.controller.ts:45-57`） | 没有枚举，没有反馈表 |
| 成本 | 账本 `tool_budget_operation.charged_microusd`；run 经 `discovery_query_receipt`、`discovery_query_operation_attempt` 关联；公司只能经 `execution_domain_ack.domain_ack_key` 的哈希反推（Fit：`${ws}:${icp}:${company}`；画像：`${company}:${op}:website-profile`） | run 级精确，线索级要反推或分摊；工具调用次数不落库 |

### 1.4 导出与权利判定

- 没有任何导出或报表代码。
- DataRights 只在 accept 时判 `STORE`。`EXPORT` 动作已定义（`compliance/data-rights.types.ts:9`），但没有调用点。
- `GET /leads/:id` 会返回解密后的联系人，需 `personal-data:read`。周报不走这条路径。

### 1.5 信号挂不上有域名的公司

- 信号的主体键是 `companyIdentity({ name, country })`，即 `n:<名称>:<国家>`（`signals/signal-mappers.ts:99,132,170`）。
- 公司有域名时，去重键是 `d:<域名>`（`discovery/identity.ts:52-53`）。
- 重算意图时按 `subjectKey: company.dedupeKey` 精确匹配（`signals/intent-recompute.service.ts:105-107`）。
- 所以只要公司有域名（公开网页发现的公司全都有），招标、FDA 等一等信号就永远挂不上，「为什么现在」这一列会是空的。

## 2. 读模型 `LeadPackage`

- 纯组装函数，输入一个线索 ID，在 `withWorkspace` 里只读，输出一份不可变对象，包括：
  - 公司：名称、域名、国家、城市；
  - 官网画像：贸易角色与置信度、自有制造、在售品牌（外国 / 中国分列）；
  - 标识：登记号、税号、LEI；
  - 联系路径与建议联系路径；
  - 信号：最多 3 条，带 URL 与日期；
  - 六维分、总分、Fit 结论、原因码；
  - 证据 URL：至少 1 条，每条带字段名与抓取时间；
  - 制裁状态、有效期、成本、线索 ID。
- 只取 green / amber 数据，不读 `canonical_contact`，所以结构上不含具名个人。
- 三处调用：
  1. accept 时，在同一事务里组装，写入快照的新可选字段；
  2. 周报逐行调用；
  3. `GET /leads/:id/package` 给运营看（只要 `acquisition:read`）。

## 3. 事件合同：v1 增加可选字段

- `lead-qualified.v1.schema.json` 增加以下可选字段，类型严格、`additionalProperties: false` 照旧：
  - `company_profile`：`trade_role`、`trade_role_confidence`、`own_manufacturing`、`carried_brands`；
  - `identifiers_ext`：`register_key`、`vat_id`；
  - `company_contact_points[]`：`kind`、`url`、`status`；
  - `suggested_contact_path`：`kind`、`url`、`legal_note`；
  - `signals[]`；
  - `evidence_urls[]`；
  - `fit_reason_codes[]`；
  - `cost_summary`：`model_microusd`、`tool_microusd`、`total_microusd`、`basis` = `allocated_estimate`。
- 必填字段不变，所以旧载荷仍能通过新 schema 校验。
- 开发信草稿**不进事件**：它是给销售的工作底稿，不是交付事实；放在周报和读模型里。
- 契约测试补充：新字段的正反例；旧载荷仍然通过。
- 这一变化需要接口层与 SaaS 平台方确认（`docs/product-scope.md:120`），二者都是产品负责人。

## 4. 原因码（BI-20）

- **拒绝原因**（运营 reject 与客户反馈共用）：
  - `NOT_TARGET_ROLE`：是制造商或终端用户；
  - `WRONG_PRODUCT`；
  - `TOO_SMALL`、`TOO_LARGE`；
  - `ALREADY_KNOWN`；
  - `NO_IMPORT_SIGNAL`；
  - `WRONG_COUNTRY`；
  - `BAD_CONTACT_PATH`；
  - `DUPLICATE`；
  - `OTHER`。
- **正向结果**：`GOOD_FIT`、`WILL_FOLLOW_UP`（= 人工 QGO）。
- **Fit 原因码**由确定性规则从结构化来源推出，不让模型自由命名：
  - `score_detail.ruleEvaluations` 的失败规则 → `RULE_<kind>_FAIL`；
  - 资格门结论 → `FIT_MATCH` / `FIT_WEAK` / `FIT_MISMATCH`；
  - 可达性为 0 → `MISSING_CONTACT_POINT`；
  - 制裁 → `SANCTIONS_HOLD`；
  - 数据质量缺字段 → `MISSING_<field>`。
  - 四门的自由文本仍保留在 `fit_reasons` 里给人看。
- `lead_decision` 加 `reason_code`。reject 时必填，accept 时可选；旧接口不带时返回 422。运营界面目前只有接口调用，影响面小。

## 5. 周报（BI-22）

- **入口**：`GET /reports/weekly?icpId=&week=YYYY-Www`。
  - scope：`acquisition:read` + `acquisition:export`（新增）；
  - 返回 `text/csv; charset=utf-8`，带 BOM；
  - 另有一条运营命令包装这个接口。
- **行**：该 ICP 在该周（UTC，周一起）accept 的线索。
- **列**（中文表头，与 PRD 周报一致）：
  1. 公司名、域名、国家、城市；
  2. 贸易角色、置信度、自有制造、在售品牌（外国 / 中国）；
  3. 登记号、税号；
  4. 规模线索；
  5. 为什么现在（≤ 3 条，带日期与链接）；
  6. 六维分、总分、Fit 结论、原因码；
  7. 证据链接（≥ 1）；
  8. 联系路径（供应商入驻页 / 询盘表单 / 联系页 / Impressum）、建议路径、合规备注；
  9. 公司注册地址（实测通过后才有）；
  10. 开发信草稿（目标国语言）与中文译文；
  11. 制裁状态、有效期；
  12. 本条成本（分摊估算）；
  13. 线索 ID；
  14. 客户填写的 5 列：相关性 1–5、愿意联系、原因码、备注、是否已联系。
- **权利判定**：每行先判 DataRights `EXPORT` 并写 `policy_decision_log`，不允许的行不出（计数写进响应头），红色数据一律不出。CSV 防公式注入：以 `=`、`+`、`-`、`@` 开头的单元格前加 `'`。
- **格式**：RL1 只出 CSV。XLSX 要加依赖，并重新绑定漏洞基线，留到客户真的需要时再做。

## 6. 反馈（BI-23）

- 新表 `lead_outcome`：
  - `workspace_id`、`lead_id`（复合外键）；
  - `relevance`（1–5）、`willing_to_contact`、`reason_code`、`note`、`contacted`；
  - `source`（customer / operator）、`created_at`。
  - ENABLE + FORCE RLS，`app_user` 只给 SELECT / INSERT；只追加，改判就再写一行。
- 接口：`POST /leads/:id/outcomes`，以及 `POST /reports/weekly/feedback`（上传客户填好的周报 CSV，按线索 ID 匹配，逐行校验，返回接受与拒绝计数）。
- 评测脚本（BI-24）读这张表。`WILL_FOLLOW_UP` 记为人工 QGO，进周报汇总。

## 7. 建议联系路径与开发信草稿（BI-15）

- **建议路径**是确定性规则：
  - 优先级：供应商入驻页 > 询盘表单 > 联系页 > Impressum 页；
  - `legal_note` 是固定文案，例如「官网公开入口，未验证投递；首次联系请用询盘表单或电话说明来意，邮件广告需事先同意」。具体条文请法务确认。
- **开发信草稿**是新的模型任务 `outreach.first_contact_draft`：
  - **输入**（全部是公司级事实）：卖方资料（产品、认证、优势）、这家公司的贸易角色、在售品牌、匹配点与信号；不传任何人名或联系方式。
  - **输出 schema**：目标国语言的 `subject` + `body`（≤ 1,200 字符），中文 `body_zh`，引用到的证据键 `used_facts[]`。
  - **约束**：
    - 只能引用给定事实，不编造合作、价格或认证；
    - 校验 `used_facts` 是否都在输入里，不在就丢弃草稿。
  - **预算**：每条线索一次调用，在 accept 后由运营或周报生成时批量触发，走 Workspace Grant；失败不影响线索。
- 存储：新表 `lead_outreach_draft`（版本号、语言、正文、生成时间、模型身份），只追加。周报取最新一版。
- 平台不发送，也不提供发送按钮（L0 红线）。
- **回复入口**：草稿末尾附卖方自己的联系入口，由买家决定从哪里回复：
  - 卖方的 WhatsApp 一键聊天链接（`https://wa.me/<卖方号码>`，号码来自卖方资料）；
  - 卖方邮箱与官网。
  - 这样首次联系始终由买家选择渠道。后续的 WhatsApp 对话走官方 WhatsApp Business 接口，进平台收件箱（RL5），不用非官方客户端，也不对未同意的号码主动发消息。

## 8. 证据 URL 与成本

- **证据 URL**：
  - 迁移给 `field_evidence` 加可空列 `source_url`（CHECK `https://`）。
  - 写入点补写：
    - 富集的 `provenance.sourceUrl`；
    - 物化证据联 `raw_source_record` 取 URL；
    - `fetched_at` 改用原始记录的抓取时间；
    - 官网画像用 BI-14 新增的 `website_profile.source_url`。
  - 历史行不回填（库里目前 0 行）。
- **有效期**：`lead.service.ts:411-425` 现在按分级取最早的 `fetched_at`，重新抓取后也不会延长。改为每个字段取最新、字段之间取最早。
- **成本**：
  - `discovery_run.stats` 写 run 级 `cost_summary`（账本求和，按结果 schema 分模型与工具）；
  - 线索级 = 归属到该公司的操作（按 domain ACK 键反推画像与 Fit）+ run 共享成本 ÷ 本次物化的公司数；
  - `basis` 标 `allocated_estimate`。

## 9. 合规与安全

- 周报只出公司级数据与官网公开链接，不出邮箱、电话、人名。开发信草稿只基于公司事实与卖方资料。
- 导出逐行判权并留痕（补上 L4-G03 的缺口）；CSV 防公式注入；接口要专门的导出 scope。
- `lead_outcome` 是客户的商业判断，按工作区隔离，只追加，随工作区删除。
- 事件里新增的都是公司级、green 数据。删除编排目前不擦 outbox 载荷，所以事件里不放任何个人数据，这一条用测试锁住。
- 开发信草稿是模型产出：标注「草稿，需人工审阅」；不自动发送；模型调用走身份闸门与预算。

## 10. 需要产品负责人决定

| # | 决定 | 选项 | 建议（2026-10-10 均按建议拍板） |
|---|---|---|---|
| E1 | 事件版本 | v1 加可选字段 / 新开 v2 | v1 加可选字段 |
| E2 | 周报包含哪些线索 | 本周 accepted / 再加待审的 recommended | 本周 accepted（运营审过的才给客户） |
| E3 | 周报格式 | CSV / XLSX | CSV（不加依赖） |
| E4 | 线索级成本 | 分摊估算 / 只给 run 级 | 分摊估算，注明口径 |
| E5 | 开发信语言 | 目标国语言 + 中文译文 / 只目标国语言 | 两者都给 |
| E6 | 拒绝原因码 | 必填 / 可选 | 必填 |
| E7 | 信号挂接修复 | 公司同时按域名键与「名称+国家」键匹配信号 / 维持现状 | 同时匹配（与无域名公司的去重规则相同） |
| E8 | 开发信附卖方 WhatsApp 一键聊天链接 | 附 / 不附 | 附（买家先开口，合规） |
| E9 | 联系路径加公司自己的社媒主页 | 加（只认官网页脚链出的领英公司页、X 账号链接）/ 不加 | 加（只存链接；人员主页一律丢弃） |

另：客户跟进线索的前台只用 GrowthOS（2026-10-10 决定），交付经 `LeadQualified` 事件与周报 CSV，不接其他 CRM。

## 11. PR 拆分与步骤

| PR | 内容 | 依赖 |
|---|---|---|
| L1 | `field_evidence.source_url`、写入点补写、有效期取值修正；信号挂接修复（E7） | — |
| L2 | 原因码枚举、`lead_decision.reason_code`、`lead_outcome` 与 `POST /leads/:id/outcomes` | — |
| L3 | `LeadPackage` 读模型、`GET /leads/:id/package`、快照可选字段、run 与线索成本 | L1、L2、BI-14 PR-1 |
| L4 | 周报 CSV 导出与反馈 CSV 上传、导出权利判定 | L3 |
| L5 | 建议联系路径与开发信草稿任务、`lead_outreach_draft` | L3 |
| L6 | 公司注册地址抽取（先实测） | BI-14 PR-1 |

每个 PR：
1. 先写失败测试，再实现；
2. 涉及表的改动加真库测试（以 `app_user` 运行），并更新权限清单 `docs/governance/app-user-table-privileges.json`；
3. 契约改动过 contracts 门；
4. `gctl check`、独立复审后合并；
5. 带迁移的随镜像同窗口上线。
