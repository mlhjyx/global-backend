> 生命周期：`REFERENCE_ONLY`
> 生命周期依据：追加式实施日志；当前状态见 docs/status/current.md

> 【写法变更 2026-10-14】新条目不再直接写进本文件：每个 PR 在 [changelog.d/](changelog.d/README.md) 放一个片段，由 `scripts/changelog-assemble.mjs` 按日期倒序汇编进来。
> 【定位变更 2026-07-10】本文件已降级为**追加式实施日志（changelog）**，不再代表当前状态。当前状态见 [../status/current.md](../status/current.md)，路线见 [../status/release-plan.md](../status/release-plan.md)，顶层设计见 [../product-scope.md](../product-scope.md)。
> 【环境勘误 2026-07-16】历史条目中的 Mac/WSL 路径、手动 Temporal、旧模型与“Crawl4AI 已有 SSRF 防护”等只记录当时验证；当前 Ubuntu `/global/backend` 环境与安全边界以 AGENTS、architecture/current 与 release-plan 为准。

## 2026-11-11 · DB 侧 Raw writer 闸门对齐 TED 纯数字国家税号——修复 run 4121e533 的 RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID (#1001)

- 起因：#1000 在应用层对 TED 的 `identifier` / `attributes.ted.winner_identifier` 放行了纯数字国家税号（意大利 partita IVA 等，公司登记事实），但 Raw writer 的 **DB 侧**独立复核函数 `raw_source_ted_national_identifier_contact_valid_v1` 仍用「防电话 PII」守卫拒绝纯数字串。真实数据提交触发 `RAW_SOURCE_WRITER_PAYLOAD_SCHEMA_INVALID`，executeQuery 事务失败、整轮 run FAILED（run 4121e533）。
- 改动：迁移 `20261110140000_ted_numeric_national_identifier` — `CREATE OR REPLACE` 该函数，放行 6–20 位纯数字（scheme 已带国别 `ted-natid:<iso2>`，不会跨法人串号）；其余文本仍必须通过 `raw_source_text_contact_safe_v2`（电话/邮箱/人名守卫对联系人字段不变）。函数 ACL 随 `CREATE OR REPLACE` 保留。
- 测试：真库事务内（BEGIN→替换→验证→ROLLBACK）——5 条真实 TED 记录（含纯数字税号）经应用层归一后全部通过 `raw_source_provider_payload_valid_v2('ted', …)`；电话形态（`+49 30 …`、含字母/非 ASCII 数字的伪标识）仍被拒；disposable 治理套件的既有负向用例不受影响。
- 未做：不动应用层规则（#1000 已合入）；不改其他 provider 的标识闸门。

## 2026-11-10 · 域名解析与召回审计两条 Temporal workflow + run 产出池导出（ch03 执行面 3b） (#974)

- 起因：ch03 §3.12/§3.17 的执行面需要把已合入的解析/复核契约（T3-13/T3-15）与两表存储（PR-3a）接成可编排的流水；召回审计此前只有 CLI 文件通道，缺 run 产出池导出与 workflow 编排。
- 改动：
  - `apps/api/src/registry/recall-pool-export.ts` + `.prisma.ts`：run 产出池导出——按 `discovery_company_materialization_outcome` 去重到公司，注册身份只从 `registry_frame` 类提供者的 `scheme:number` externalId 解析，联系人数取 `canonical_contact` 计数；规范排序 + sha256 指纹，输出即 `recall-audit.mjs --pool` 输入。配套 `scripts/frames/recall-pool-export.mts` CLI（owner 只读 + 显式 workspace 过滤）。
  - `apps/api/src/registry/recall-frame-export.prisma.ts`：frame 导出的共享取数层（CLI 与 Temporal 活动同口径，`recall-frame-export.mts` 改为复用它）。
  - `apps/api/src/temporal/domain-resolution.{activities,workflow}.ts`：逐公司 resolve → verify → persist 的有界编排（≤50 公司、按 companyId 排序确定性重放）；落库走 PR-3a 存储契约（upsert / 唯一 VERIFIED 选中 / 复核工单幂等入队），VERIFIED 行可按 `auditSampleRate` 确定性抽样进复核。
  - `apps/api/src/temporal/recall-audit.{activities,workflow}.ts`：frame 导出 → 池导出 → `auditRecall`（Wilson 95% CI）的编排；载荷护栏（frame ≤5000 行、池 ≤20000 行，超限点名 CLI 文件通道）。
  - worker 注册面：`customer-workflows.ts` 导出两条 workflow，`worker.ts` 注册两个活动工厂（`createDomainResolutionActivities` / `createRecallAuditActivities`），不注册任何 schedule。
  - 灰度门默认关：`DOMAIN_RESOLUTION_WORKFLOW_ENABLED` / `RECALL_AUDIT_WORKFLOW_ENABLED` 未开时活动一律抛 `DOMAIN_RESOLUTION_DISABLED` / `RECALL_AUDIT_DISABLED`，零调用零落库；本 PR 未在任何 env/compose/夹具里开启。
- 测试：池导出单测 7 例（解析/去重合并/哈希可复算/与 auditRecall 直连）；两条 workflow 编排单测 8 例 + 活动单测 19 例（灰度门、零页面确定性 NO_LEGAL_PAGE、注入页面证据走通 VERIFIED、落库幂等/选中/复核入队、改判前清选中、frame/池护栏）；`pnpm --filter @global/api build` 全量类型检查绿。
- 未做：真实页面抓取与 search/ct/cc/wikidata 适配器接线（ports 已留位，接线后即为生产路径）；selected 行回写 `canonical_company.domain`；审计报告落盘持久化（仍走 CLI 文件通道）；灰度开启与 schedule 注册属后续授权动作。

## 2026-11-10 · 模型驱动联网搜索的工具环与任务登记（获客通路 A 第一步） (#975)

- 起因：获客需要一个受治理的「模型自己规划检索、按证据产出候选」通路（用户 2026-11-09/10 决策：路线 A=模型工具环+栈内搜索，不采用模型厂商原生 grounding）。本批只做工具环与任务契约本体，执行器（SearXNG/DeepSeek）与 provider 接线在后续 PR。
- 改动：
  - `apps/api/src/discovery/model-web-search/model-web-search.ts`：工具环——模型经 `web_search` 调用执行器（依赖注入），轮数与调用数上限、工具输入二次校验、最终答案严格 JSON（域名字法、https 证据必填、去重、countryCode 白名单），fail-closed 错误码（NOT_JSON/ANSWER_INVALID/EVIDENCE_MISSING/UNKNOWN_TOOL/ROUND_BUDGET/TOOL_BUDGET/MAX_TOKENS/TOOL_INPUT_INVALID）。
  - 新 AI Task `discovery.web_search_candidates`（flash 档、allowedTools=searxng.search）与六处登记面：`ai-tasks/task-registry.ts`、`durable-results/model-result-projections.ts`（MODEL_RESULT_TASK_IDS、schema `discovery-web-search-candidates/v1`、投影定义与注册）、`durable-results/durable-result-strategy.ts`（typedProjectionSchemaValues）、`durable-results/model-result-projection-bounds.spec.ts`（EXPECTED_BOUNDS）、`docs/governance/durable-result-strategies.json`（modelTasks 条目）、`scripts/execution-authority-policy.mjs` 与 spec（任务 14→15，含计数断言）。
  - G9 基线微调（经本 PR 评审）：`apps/api/src/ai-tasks/task-registry.ts` 931→974、`apps/api/src/durable-results/model-result-projections.ts` 1744→1784，均因新增任务/投影，理由见基线 reason 字段。
  - 门户介绍（`apps/api/src/docs/portal-intro.ts`）：分域表补齐 JudgmentReview/Metrics/Outreach/Channels/Seller Documents/Packs-Skills-Agents/Campaign；主链路补 enrich-contacts、contact-eligibility、判定复核（claim/resolve、judgments 查询与统计）与四个 metrics 端点；重导出 `packages/contracts/openapi/openapi.json`（137 路径不变，仅 info.description 变化）。
- 测试：`model-web-search.spec.ts` 4 例（工具环、围栏 JSON、非法域/缺证据/越权工具/预算/截断）；`model-result-projection-bounds.spec.ts` 81 项；`node --test scripts/execution-authority-policy.spec.mjs` 17/17；`node scripts/check-file-budgets.mjs` OK（warn 4）。
- 未做：执行器接线（SearXNG 免费执行器、DeepSeek `deepseek.search/fetch` 工具）与 `model_web_search` discovery provider 注册、run 预算帽、20–30 条 golden ICP 评估集——均在后续 PR。

## 2026-11-10 · Add DeepSeek search and fetch tools to the governed tool broker (#976)

- 起因：获客通路 A（模型驱动联网搜索）已定「模型工具环 + ToolBroker」，需要付费搜索执行后端；DeepSeek 提供独立 Search/Fetch JSON API（5 元/1000 次成功请求，按成功计费）。
- 改动：
  - 新增 `deepseek.search` / `deepseek.fetch` 两个 Tool（`apps/api/src/tools/deepseek-tools.ts`，经 `registerBuiltinTools` 注册）：sourcePolicy=none、sourceClass=public_intelligence、rateLimit 5 rps、estimatedCents 按整数美分上限取整（1 美分/次计费请求）；缺 key 返回 degraded 空结果而非抛错。
  - `deepseek.search` 只输出 url+title 并丢弃个人主页 URL（与 searxng.search 同口径，personalData:false）；`deepseek.fetch` 返回 ≤32k 字符正文并先查目标站 robots.txt（personalData:true，与 social.fetch 同类）。
  - 新增适配器 `apps/api/src/adapters/deepseek-tools.ts`（固定主机、拒绝重定向、30s 超时、响应体硬上限、429/5xx/网络错误有界重试、每次物理发信前过授权与 beforePhysicalWire）。
  - 新增 `deepseek-search/v1`、`deepseek-fetch/v1` typed projection；模型联网搜索执行器绑定 `brokerBackedDeepSeekWebSearch`（broker.invoke('deepseek.search', …)）。
  - 抽共享文本整形 `apps/api/src/tools/durable-text.ts`（searxng/social/deepseek 共用），`builtin-tools.ts` 降到 800 行以下并按 G9 规则删除其基线条目。
  - 治理清单：EXPECTED_TOOL_IDS 20→22、tool callsites 44→45、`durable-result-strategies.json` tools +2；`catalog-result-projections.ts` 基线按评审上调（G9 记录于 PR）。
- 测试：适配器/工具/执行器单测（fetch mock，无真实出网），覆盖成功、限速、402、无 key 降级、投影与 replay；`gctl check --fast`。
- 未做：不部署、不发车；`discovery.web_search_candidates` 任务的 allowedTools 尚未加入 deepseek.search（由模型工具环接线 PR 决定）；deepseek.fetch 暂无调用方。

## 2026-11-10 · SMTP RCPT probe as the verification waterfall's fallback second vote (#977)

- 起因：P1-06 的验证瀑布依赖第三方验证器凑「双正投票」，但缺 key 的环境里可用票数只有 1 家 → 单票 positive 永远停在 UNKNOWN、VALID 恒为 0。栈内已有免费的 `smtp.rcpt_probe` 工具（端口 25 RCPT 探测，无 key、零成本），却只被 email-guess 的自建验证器使用，没接到瀑布。
- **实测更正（2026-11-10 晚，本机 xin）**：对 gmail-smtp-in.l.google.com / mx00.1and1.com / mx.hermes.epson.de 做 25 端口探测，TCP 层被 TUN fake-ip 直接接受但 **SMTP banner 全部超时**——宿主 25 端口出网不可用。探测在现网只会得到 UNKNOWN（`smtp_no_response`），**不能**作为有效的第二票；因此接线默认**关闭**（`EMAIL_VERIFY_SMTP_PROBE_ENABLED` 缺省 false，仅显式 1/true/yes/on 启用）。第二票的现实路径是第三方验证器 key（Emailable/MillionVerifier，待提供）或具备 25 出口的探测节点。
  - 超时/无响应一律映射 UNKNOWN + error（无裁决）：既有流程不受影响（单票仍 UNKNOWN，不伪造 VALID/INVALID）；`smtp_no_response` 与 `smtp_unreachable` 分开命名，便于日后出网可用时观测。
- 改动：
  - 新增 `apps/api/src/enrichment/verification/smtp-probe.provider.ts`：`EmailVerificationProvider` 适配器，经 `broker.invoke('smtp.rcpt_probe', …)` 执行（source_policy advisory + 用途门 + 预算 + 限流 + Trace + 工具内 SSRF 护栏全部沿用工具）；映射 RCPT 2xx + 随机地址 5xx（catch-all 证伪）→ VALID、5xx/无 MX/Null MX/NXDOMAIN → INVALID、随机地址也 2xx → CATCH_ALL_RISKY·true_catch_all（acceptAll=true）、反枚举 provider（Gmail/M365…）→ UNKNOWN·unprobeable_provider（不触网）、catch-all 未证伪 → UNKNOWN·inconclusive、SMTP 不可达/MAIL FROM 拒/超时/broker 拒绝 → error 非空（无裁决，绝不凑票）。成本 0；`verification_method`/事件账如实记 `smtp_rcpt`。
  - `provider-pool.ts`：`withSmtpProbeFallback` —— 外部验证器**门后可用数 < 2** 时自动追加兜底票到瀑布末席；>=2 家可用时不追加（SMTP 不得占仲裁席）。开关 `EMAIL_VERIFY_SMTP_PROBE_ENABLED`（**缺省关**，见上；具备 25 出口的部署可显式开启）+ `data_provider.smtp_self` kill switch + broker 装配三道检查。
  - 三处瀑布消费方接线：再验证 sweep（CLI 自建 broker——APP_DATABASE_URL 缺省时优雅跳过；Schedule activity 由 worker 注入 broker）、run 内富集 activity（`deps.broker`）、HTTP 富集端点（`TOOL_BROKER` DI token，discovery.module 单实例与 provider registry 共用）。
  - `EmailVerificationProviderResult.method`：每步声明验证方式；sweep / 富集写事件账与 `contact_point.verification_method` 时按步取值（第三方 API 缺省 `third_party_api`）。
- 治理：新增 `smtp.rcpt_probe` 物理调用点，`scripts/execution-authority-policy.mjs` 的 `EXPECTED_TOOL_CALLSITES` +1（44→45，spec 同步）。
- 测试：适配器 19 条（假 broker + 假 MX：deliverable/undeliverable/catch-all/未证伪/反枚举/不可达/MAIL FROM 拒/超时/ToolPolicyDenied/egressBlocked/无 MX/Null MX/NXDOMAIN/瞬时 DNS 失败/缺 workspace/合规预检/预算账降级/幂等随机地址，零真实出网）+ 瀑布集成 5 条（两票一致→VALID、冲突→UNKNOWN、仅兜底一票→UNKNOWN、兜底票超时→provider_error、accept_all 优先压 CATCH_ALL_RISKY）；池兜底语义 7 条（默认关/显式开关/kill switch/broker/票数）与 activity 路径（含默认关时仍 skipped(provider_unconfigured) 的用例）；sweep 事件账/点 verification_method 记 smtp_rcpt。
- 未做：Truelist catch-all 解析分支（仍待编排改造）；第二票在现网仍缺（等第三方 key 或 25 出口探测节点）；兜底票经 broker 预算账——workspace 无预算账户/BudgetStore 不可用/超限时降级为无裁决的 error 票（不崩溃批量、不绕闸门），其余执行控制错误（平台出口围栏、域名 ACK、账本重放）仍原样上抛。

## 2026-11-10 · Backfill country/industry normalization and phone/LinkedIn contact completion (#978)

- 起因：dev 库 canonical_company 的 country 里 `DE` 与 `德国` 并存（846/72 行），判定链按 ISO 读 country 导致国家门静默失效；industry 2303 行为空、非空行是自由文本；公司级电话仅 1 条（邮箱 280），LinkedIn 公司页只有 11 条——数据脏且稀。
- 改动：
  - 新增 `discovery/company-normalization.ts`：country 变体（中/英/德名、alpha-2/alpha-3）→ ISO alpha-2；NULL country 仅用登记级证据补（GLEIF 注册国、VAT 前缀）；空 industry 用 ISIC 词表（industry-map 同一匹配器）+ TED CPV/FDA 交叉表确定性推断，非空值永不覆盖。
  - `registry/industry-map.ts` 导出 `matchIsicNodesForTerms`（节点级匹配，含命中词），原 `nacePrefixesForIndustryTerms` 行为不变。
  - 新增 `scripts/backfill-company-normalization.mts`（默认 dry-run，`--apply` 落库，幂等，版本/原值条件更新；owner 跨租户连接为预期）。
  - 新增 `discovery/contact-completion.ts` + `scripts/complete-contact-channels.mts`：复用 A1/A4 Impressum 装配器与 BI-14 首页链接解析，抓取（robots 先检）→ phone/form_url 写 company_contact_channel、LinkedIn 公司页写 company_contact_point（只补不删）；邮箱不进本管线。
  - `attributes.industry_normalization` / `attributes.evidence_bundle` 加入 canonical 属性白名单（后者供后续 shadow 证据包使用）。
- 测试：单测覆盖归一函数（变体/未知值不猜/幂等）、industry 推断（词表/CPV/FDA 端口）、联系点装配（电话/LinkedIn/表单/无邮箱）与 sanitizer 白名单；dev 库真跑计数见 `docs/evidence/2026-11-10-multi-source-evidence-graph-slice.md`。
- 未做：不从域名 TLD 猜国家；未接 pipeline 热路径（CLI 回填）；LinkedIn 补全只写公司页 URL，不解析个人主页。

## 2026-11-10 · Enforced cross-source evidence gate and tiered evidence bundle in the judgment chain (#978)

- 起因：公司理解仍是官网单源；富集结果各写各的 attributes，判定链无法表达「FIT/NOT_FIT 需跨源佐证」。产品负责人 2026-11-10 决定取消影子期：证据包与佐证门直接按 enforce 生效（fail-closed、可回滚开关）。
- 改动：
  - 新增 `discovery/evidence-bundle.ts`：T1（官方注册/招投标/专利）/T2（Wikidata）/T3（官网/技术足迹）分层证据包；判定链在 FIT/NOT_FIT 落地前按当前属性现场装配（零出网），并把包随判定记录同事务写回 `attributes.evidence_bundle`（审计面；落库键名避开属性 sanitizer 黑名单，长数字标识拆分/前缀化）。
  - 判定快照（judge prompt）新增 `cross_source_evidence` 摘要——证据分层真实参与理解输入。
  - 新增 `discovery/judgment/corroboration.ts`：FIT/NOT_FIT 需 ≥2 个独立分层，否则 fail-closed 降级 UNKNOWN（Lead=weak/待复核，绝不自动推荐或自动拒绝）；v2 判定链与 v1 路径同口径；降级与评估记入 `judgment_record.sampling.corroboration`。`JUDGE_CORROBORATION_MODE` 默认 `enforce`（非法值 fail-closed 到 enforce），`shadow`/`off` 为回滚开关。
  - 新增 `scripts/build-evidence-bundle.mts`（DE 样本构建 + 对最近判定的同口径离线佐证样例）。
  - 新增 `docs/eval/golden-icp/`（26 条 ICP 查询 YAML，3 条已标注；口径/标注模板见 README）与 `scripts/evaluate-golden-icp.mts`、`src/discovery/golden-icp.ts`（受限 YAML 解析、确定性排序、precision@K/recall）。
- 测试：单测覆盖证据包装配与属性 sanitizer 回环、佐证评估/降级矩阵（enforce/shadow/off、单层/无包）、判定链降级与证据包写回、golden ICP 解析与 precision@K；dev 库真跑样例见 `docs/evidence/2026-11-10-multi-source-evidence-graph-slice.md`。
- 未做：golden 集 26 条查询中 23 条待标注；companies_house/inpi_rne/google_patents/samgov 暂无 canonical 属性命名空间，暂不计入 T1（留了抽取位）。

## 2026-11-10 · 注册即建档第 1 步——理解预览与 onboarding facts 端点（ONBOARDING-PREVIEW-1） (#979)

- 起因：产品负责人 2026-11-10 批准「注册即建档」客户旅程重构（先官网 → 理解预览 → 勾选完成注册）。当前 onboarding 让客户手填六项事实，理解结果在注册完成后才出现；行业是自由文本，无法受控。第 1 步把顺序反过来：官网先提交，理解结果变成客户可勾选的候选，行业改受控词表。
- 改动：
  - **档案保存受控行业码**：`company_profile.industry_code TEXT NULL`（迁移 `20261110100000_company_industry_code`，可空无回填）；`industry` 继续存展示标签，供旧界面与上游 NACE 词面映射读取。`CompanyDto` 增加 `industryCode`。
  - **`GET /api/v1/companies/:companyId/understanding-preview`**（acquisition:read）：只读聚合一次真实 understanding run 的落库结果——状态（not_started/queued/running/ready/failed）、`stage:code` 失败标签、已分析页数（knowledge_source type=website 按 URI 去重）、行业候选（profile.industry 经 term_alias 精确/子串归一到 canonical_taxonomy(kind=industry)，归不上只给原文）+ 受控词表、产品候选（offering 带来源页/原文）、市场候选（summary/claim 陈述里确定性识别的国家名，拉丁别名 ≥4 字符避免 "contact us" 类误报，命中才建议并附原句）。
  - **`POST /api/v1/companies/:companyId/onboarding-facts`**（acquisition:write，无 Grant）：客户勾选结果写回同一档案；industryCode 以词表校验并回填标签；products upsert 为 Offering(source=onboarding) 并清理本路径管理的旧行；同事务复用 `synthesizeProfileClaimDrafts` 生成 NEEDS_REVIEW Claim 草稿。只允许 DRAFT/REVIEW，ENRICHING 返回 409 ONBOARDING_FACTS_NOT_ALLOWED，避免 understanding 的 extract_profile 稍后覆盖客户选择。
  - **PATCH /companies/:id** 接受 `industryCode`；改成自由文本行业时清空旧受控码，保持两列同源。
  - **审查修复**：接受重试即清 `understandingFailedAt/LastError`（预览从 failed 回 queued，并恢复 10 分钟重复启动守卫）；onboarding-facts 拒绝「DRAFT + 官网 + 无失败标记」（已排队）的写入并拒绝 JSON null；市场国家只认词边界（Romania 不再命中 Oman/Niger/Mali），产品/市场/页数只收与当前官网同站的溯源；市场候选补 `labelEn/labels`。
  - 两个新操作的 `operation-descriptions` 与 OpenAPI 契约重导出。
  - **随并 main 的治理修复**：#977（SMTP 第二票）与 #976（deepseek 工具）各自把物理工具调用点从 44 改到 45，文本不冲突但合并后实际 46，main 的 Governance 因此红；按 `scripts/execution-authority-policy.mjs` 的真值把 spec 的两处数字断言改为 46。
- 设计约束：不新增 AI Task、不新增工具调用点、不新增预算 purpose/quote operation——预览复用 `POST /companies`（既有 understanding.run 预算），完成路径零模型调用。因此未改 `scripts/execution-authority-policy.*`、`builtin-tools.ts` 与 quote envelope。
- 测试：`src/company` 47 例（新增市场词边界、同站过滤、排队态守卫、JSON null 等 5 例）、operation-descriptions/authz-openapi/controller-authz 合计 75 例全绿；`nest build`、spectral、G9 体量门、`governance:verify`、`execution-authority-policy.spec`（合并最新 main 后 17 例）全绿；OpenAPI 重导出 139 paths（+2）；Copy 固定源回执重签（合并最新 main 后 UNCHANGED）。
- 未做：SaaS 侧 onboarding 反向流程（gain-saas 仓单独 PR）；逐页抓取失败/预计时间的 run 事件投影（第 2 步）；NAF→NACE 全表映射（T3-05）与词表扩容仍按原路线。

## 2026-11-10 · 社媒信号采集——changedetection/RSSHub 归因落库 company_signal (#981)

- 起因：免费社媒信号栈（changedetection.io @ 127.0.0.1:5055、RSSHub @ 127.0.0.1:1200，RUNBOOK §16）已上线，但信号仍停在两个服务里，引擎无法查询、也无法用于触发式外联。本批把两类信号归因到 canonical_company 并落库为可查询的公司信号（只读公开页面/公开信息源，不含任何平台写操作自动化）。
- 改动：
  - 迁移 `20261110020000_company_signal`：新表 `company_signal`（`workspace_id` 必填、`company_id` 可空 FK `canonical_company` ON DELETE SET NULL、`provider_key`、`signal_kind`（rss_item|page_change）、`source_url`、`title`、`excerpt`、`observed_at` timestamptz、`fingerprint` char(64)、`ingest_key`；唯一 `(workspace_id, ingest_key)`；索引 `(workspace_id, company_id, observed_at DESC)`）；ENABLE+FORCE RLS + `current_workspace_id()` 租户策略；app_user 授予 SELECT/INSERT/UPDATE，并同步 `docs/governance/app-user-table-privileges.json`。Prisma model `CompanySignal` 同步。
  - `apps/api/src/signals/company-signals.ts`（纯逻辑，无网络 I/O）：RSS2/Atom 解析（fast-xml-parser；CDATA 与缺失字段宽容、缺 title/link 计 dropped、非 RSS/Atom 响应标 `recognized=false` 不静默吞）、changedetection watches 映射（`last_changed > 0` 才算信号，越界时间戳显式跳过）、指纹 `sha256(provider|source_url|title|observed_at 秒)`、域名归因（精确 > 子域 > 同注册域；多租户托管后缀如 wordpress.com/github.io 禁用同注册域近似；未匹配 `company_id = null` 仍落库）、`createMany(skipDuplicates)` 幂等写入；返回 `{inserted, skipped, matched}`。
  - CLI `apps/api/scripts/signals/ingest-signals.mts`（出网只在这里）：`--workspace` 必填、`--rss <route|url>` 可重复（缺省读 `SIGNAL_RSS_ROUTES`，逗号分隔）、`--include-watch-changes`；拉取复用仓库治理出口 `requestPublicHttp`（net-guard：global-unicast、每跳重定向重新解析并**固定连接 IP** 防 DNS rebinding、流式 5 MB 上限、20s 墙钟超时、跨域剥离凭据；本机 RSSHub/changedetection 回环 origin 按配置放行，changedetection 请求禁跟随重定向避免 x-api-key 外泄）；网络完成后先校验 workspace 存在（打错 UUID 不产生孤儿行），再逐源用 `PrismaService.withWorkspace`（app_user + `set_config`）开短事务落库，归因查询失败与写入失败都会回滚该源；源级失败退出码 1、参数错误退出码 2。
- 测试：新增 `company-signals.spec.ts`（解析/指纹/归因/落库口径，含多租户托管后缀与 IDN 用例）与 `ingest-signals.spec.mts`（argv 解析、治理出口拒绝可见、非 RSS/JSON 错误、本机 resolver 固定回环、逐源失败隔离、collect→persist 幂等），共 33 例，fetch/DNS 注入不触网；新增 `packages/db/test/company-signal.rls.spec.mjs`（service 组真库，app_user：上下文内写入/跨租户不可见/WITH CHECK 拒写/无 DELETE，4/4）。`pnpm --filter @global/api test` 全量 13198 例（12954 通过、244 跳过、0 失败；重构前一轮曾有 4 个负载超时文件，单跑 50/50 通过，非本次改动）；`pnpm --filter @global/api build` 绿；`node scripts/check-file-budgets.mjs` OK（parseRssFeed 复杂度 21 为 warn）。迁移在本机一次性库过 Prisma 漂移门 / G5 RLS 目录门（175 张表、121 张 workspace RLS）/ app_user 权限清单门（27 例）。真实数据演示（dev 库，app_user + set_config 事务）：Nees Pumpen 官网 RSS 10 条全归因、RSSHub 路由 12 条未归因（github.com），插入 22、归因 10；重跑插入 0、跳过 22（幂等）。页面变更入库路径以临时演示 watch 实测过 1 条（`last_changed>0` 后入库；演示后 watch 与行已清理；三个真实 watch 当前从未变更，故不产生信号）。
- 未做：changedetection `/diff/{uuid}` 正文未落 `excerpt`（列表元数据已足够触发，正文拉取留待后续）；调度接线（Schedule / run 内 activity）未做，本批只有 CLI 手动执行；未归因信号的规则回填与人工归因界面未做；ToolBroker/source_policy 化未做——出网暂留运营 CLI（经 net-guard，类比制裁名单运营刷新路径），RUNBOOK §16 的「引擎侧 provider/tool」是后续工程，是否登记 §6 例外待产品负责人拍板。

## 2026-11-10 · model_web_search discovery provider 接线（获客通路 A 闭环） (#985)

- 起因：工具环（#975）与执行器工具（#976）已在 main，但没有任何 discovery provider 调用 `discovery.web_search_candidates`，run 永远不会走到模型联网搜索。本批把 provider 接进注册面与执行面，闭合「生成查询→检索→候选→入库」这一边（用户 2026-11-10 闭环要求）。
- 改动：
  - 新 provider `apps/api/src/discovery/providers/model-web-search.provider.ts`（key `model_web_search`，public_intelligence）：两段式——探索环 `runModelWebSearch`（模型规划检索词，经 ToolBroker 走 SearXNG 或 DeepSeek，搜索回执为 auxiliary）+ 结构确认 `discovery.web_search_candidates`（generateStructured 持久投影，**该回执即公司血缘**，producerId=任务 id）。最终候选必须能在实际检索结果里按主机名找到出处，否则丢弃（防模型臆造域名）；blockedDomains 生效；env `MODEL_WEB_SEARCH_PROVIDER=on` 为第一开关（默认 off 时返回有效空血缘），`MODEL_WEB_SEARCH_EXECUTOR=searxng|deepseek` 选执行器。
  - 血缘契约扩一个 provider key：`company-discovery-lineage.ts`（union + `PROVIDER_RECEIPT_CONTRACT`）、`discovery-query-governed-lineage.ts`（`PROVIDER_CONTRACT`）、`durable-results/domain-ack-consumer-bindings.ts`（governed 回执绑定；另补 `deepseek.search` 的 product consumer 绑定与 `discovery.activities.ts` 的 producer 白名单）。
  - 注册与路由面：`provider.registry.ts`（构造 push + data_provider seed ENABLED，第二道 kill switch）、`provider-source-classes.json`、`plan-query-sources.ts`（planner 指南 + cheap-first 优先级 60）、`execution-envelope.ts` `MAX_COMPANY_DISCOVERY_ADAPTERS` 8→9。
  - 报价信封（`workspace-technical-budget-envelope.ts`）：补 `discovery.web_search_candidates` 模型上界（每查询 ≤ `MODEL_WEB_SEARCH_MAX_ROUNDS`+1 次）与两种搜索执行器工具上界；新常量 `MODEL_WEB_SEARCH_MAX_ROUNDS/MAX_TOOL_CALLS`（工具环默认值改用同一常量）。
  - 治理：`docs/governance/provider-registry.json` 新增 `model_web_search`（IMPLEMENTED，ENABLED），`docs/backend/provider-registry.md` 重新生成。
- 测试：新增 `model-web-search.provider.spec.ts`（默认关零调用、缺 gateway 诚实降级、证据落地只保留检索结果中的公司、blockedDomains、已结算失败→零记录有效血缘、执行控制错误穿透、探索失败→有效空血缘）；`provider.registry.spec.ts` 精确清单同步；`workspace-technical-budget-quote.controller.spec.ts` 报价上界随适配器 9 更新。
- 未做：DeepSeek 执行器真实联网的端到端费用验证（需真实 key 往返，费用授权后单独发车验证）；golden ICP 评估集（下一步）；发现 run 的 20–30 条真实样本验收（发车后做）。

## 2026-11-10 · 公司触发信号只读端点（P1-18 闭环读侧） (#986)

- 起因：P1-18（#981）已把 changedetection/RSSHub 信号归因落库到 `company_signal`，但没有任何读接口，SaaS 公司/线索详情无法展示「触发信号」——闭环接线清单第 2 项的缺口。
- 改动：
  - 新 `GET /api/v1/companies/{companyId}/signals`（`signals/company-signals.controller.ts` + `company-signals.service.ts`，`SignalsModule` 注册进 app.module）：只读 `company_signal` 中已归因到该公司的行（company_id 非空且等于路径公司），按 `observed_at` 倒序 keyset 分页（base64url cursor，limit 默认 20/最大 100）；RLS 走 `withWorkspace`，查询同时显式带 workspaceId/companyId 纵深防御；只返回元数据（providerKey/signalKind/sourceUrl/title/excerpt/observedAt）。
  - 接口门户说明（`docs/operation-descriptions.ts`）与 OpenAPI 契约重导出。
- 测试：`company-signals.service.spec.ts`（分页映射/游标往返/非法 limit/cursor、RLS 事务参数）；OpenAPI 重导出后 contracts drift 门校验。
- 未做：SaaS 公司详情「触发信号」块（gain-saas 侧 PR 跟随）；signal 消费的 ops-check 告警（接线清单第 7 项）。

## 2026-11-10 · 查询血缘 SQL 白名单再扩——registry_frame 与 model_web_search (#987)

- 起因：`append_discovery_query_lineage_v1` 的 providers 白名单与 attempt 三元组仍是硬编码（上次扩于 20261108160000）。2026-11-10 真实 run 实测：registry_frame（A 方案，数据源 ENABLED + `REGISTRY_FRAME_PROVIDER=on`）在 append 阶段被 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID` 拒绝，整个 run FAILED；WEB-1 的 model_web_search 同样不在白名单内。
- 改动：新迁移 `20261110050000_discovery_query_lineage_provider_allowlist_widen`（纯 `CREATE OR REPLACE FUNCTION append_discovery_query_lineage_v1`，无表结构变更）：
  - providers 白名单增 `model_web_search`（限 public_intelligence）与 `registry_frame`（限 company_registry）；
  - attempt 三元组增 `discovery.web_search_candidates / ModelWebSearchDiscoveryProvider / discovery-web-search-candidates/v1` 与 `registry.query / RegistryFrameDiscoveryProvider / registry-query/v1`，与 code 侧 `PROVIDER_CONTRACT`/`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 一致。
  - v1 合同哈希、命令/回执字段与其余校验不变（纯 widen；历史回执不含新源，重放语义不变）。
- 测试：迁移在本机库事务内解析/创建后 ROLLBACK（语法与依赖通过）；发车后真实 run 复验。
- 未做：raw source writer 的 provider CASE 白名单（`write_raw_source_record_v2_legacy`）未扩——治理管线走 Prisma DML 不经过该函数，registry_frame 实测止于血缘 append 而非 raw 写入；如未来有路径使用该 SQL writer 需同步扩。

## 2026-11-10 · 模型联网搜索工具环轮数上调（4→6 轮 / 8→10 次搜索）并提示尽早作答 (#988)

- 起因：真实 run（2026-11-10，9d0e3065）中 deepseek-flash 在 4 轮往返后仍在检索，工具环报 `MODEL_WEB_SEARCH_ROUND_BUDGET_EXCEEDED`，`model_web_search` 查询以空结果收尾（回执合法、provider 在场、record_count=0）。4 轮对 3 轮检索 + 最终作答的节奏过紧。
- 改动：`MODEL_WEB_SEARCH_MAX_ROUNDS` 4→6、`MODEL_WEB_SEARCH_MAX_TOOL_CALLS` 8→10（报价信封与工具环默认值共用同一常量，自动跟随）；系统提示补一句「检索 2–3 轮、证据足够就立即给出最终 JSON，不要无限检索」。
- 报价：`discovery.web_search_candidates` 每查询模型上界 5→7 次、SearXNG/DeepSeek 搜索工具上界 8→10 次，discovery.run 技术报价上界随之更新（spec 同步按真值）。
- 测试：预算信封 spec 与 quote 控制器 spec 更新；工具环单测沿用显式上限不受影响。
- 未做：DeepSeek 执行器真实付费往返（仍在 searxng 执行器上验证链路）。

## 2026-11-10 · 理解流程准入租期 30 分钟——修复 onboarding 理解预览在慢抓取时卡死 (#990)

- 起因：2026-11-10 前端实测 onboarding 理解预览无限转圈；根因是 understanding.run 没有 admission lease——crawl4ai 上游 502 重试把流程拖过 Grant 5 分钟窗口后，`crawlPages`/`extractAndPersistProfile` 全部报 `EXECUTION_BUDGET_GRANT_EXPIRED`，工作流卡死到超时。
- 改动：沿用 20261009170000（discovery.run 3h）/20261010110000（ICP 30min）的既有机制，新迁移 `20261110090000_understanding_admission_lease` 把 `understanding.run + company` 加入租期（consumed_at + 30 分钟）：CHECK 约束放行该配对，`consume_workspace_execution_authority` 逐字复制上一版仅新增一个 CASE 分支；attest 的 COALESCE 判期逻辑不变，Grant 本身仍在自己的窗口内被呈现与准入，撤销/scope/cap/耗尽检查不变，无回填。
- 测试：`understanding-admission-lease.migration.spec.ts`（单一事务、无回填、约束精确、consume 与上一版仅差一个分支）；迁移在本机库事务内创建后 ROLLBACK 验证。
- 部署：需与镜像同窗口（运行时取最后完成的迁移）。
- 未做：前端失败态已由 #149 自带的 failed 视图覆盖（本轮未改动）；Grant 本身窗口（quote 5 分钟）不变——admission lease 只延长「准入后」的有效期。

## 2026-11-10 · 模型联网搜索：超出搜索预算的调用改为结算消息，不再让整次检索作废 (#991)

- 起因：真实 run（28b50fe2，镜像 1afd8b79）中 deepseek-flash 单轮并行发起多条 web_search，累计越过 10 次上限后工具环抛 `MODEL_WEB_SEARCH_TOOL_BUDGET_EXCEEDED`，该查询以合法空回执收尾（provider 在场、record_count=0）。
- 改动：`runModelWebSearch` 对超预算的调用不再抛错，改为回填一条含错误码的结算消息（「不会再有新搜索结果，请立即输出最终 JSON」）继续工具环；搜索执行次数与成本仍被原上限钳制，轮数上限仍是硬失败（`ROUND_BUDGET_EXCEEDED`）。未授权工具仍立即拒绝。
- 测试：原「越限即失败」用例改为「越限+始终不作答 → 轮数硬限」；新增「越限后模型作答 → 正常返回且越限查询未发出」用例。
- 未做：不改变报价信封常量（上限不变，仅越限时行为更健壮）。

## 2026-11-10 · Add DISCOVERY_UNCAPPED to replace product caps with safety bounds (#992)

- 起因：2026-11-10 产品负责人拍板「预算不由平台决定」——挖掘的产出被平台产品帽（每查询每源 25 条记录、run 总池 500、每源每轮 ≤100 家公司、快扫池 500、模型联网搜索工具环 6 轮/10 次、联系人阶段整轮 $2）钳制，与客户充值余额无关；计划 `docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md` §3 W1。
- 改动：
  - 新增开关 `DISCOVERY_UNCAPPED`（默认 off，畸形值回退 off）：off 时行为逐字节不变；on 时上列产品帽改为**防爆安全界**，各由 env 可调（`DISCOVERY_MAX_PROVIDER_RECORDS` 默认 1000、`DISCOVERY_RUN_POOL_CAP` 默认 10 万、`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_*` 默认不再裁剪、`DISCOVERY_QUICK_SCAN_POOL_LIMIT` 默认 5 万、`DISCOVERY_MODEL_WEB_SEARCH_MAX_ROUNDS/TOOL_CALLS` 默认 24/100），默认值远高于客户余额可支付量级。
  - 真正的收紧条件落到执行预算：quote 只给估算包络上界，签发侧按 Grant cap = min(估算包络, 客户可用余额) 钳制（引擎 quote 合同刻意不含商业字段），引擎账本逐次 reserve/settle，余额耗尽是唯一停止条件；联系人阶段整轮 $2 产品帽在去帽模式下退场，仅保留每家 $0.20 安全界。
  - 去帽模式下计划提示的配额话术改为余额准入语义；每源查询预算默认换算回 66 条（= 全部计划查询数），不再先于余额裁剪查询副本；executionLimits 增加 `discoveryUncapped: 1` 审计标记（off 时字段缺席）。
  - 限流与出口治理（ToolBroker source_policy、rate limit）不随开关变化。
- 测试：新增/扩展 execution-envelope、run-pool-cap、plan-query-sources、quick-scan、model-web-search、contact-discovery-budget、workspace-technical-budget-envelope 各 spec 的 off/on 双态断言（off 断言与既有精确数字一致；on 报价数字按真实运行填写）。
- 未做：存量计划 `2026-11-05-cheap-first-provider-routing.md` 中的产品帽口径未回改（由 vNext 计划 §5 裁决取代）；开关默认 off，部署后由验收会话确认余额闸链路再开启；gain-saas 侧余额钳制（min 的余额一半）不在本仓库。

## 2026-11-10 · Acquisition vNext W3 evaluation sets, precision@k, Chapman coverage and source-yield accounting (#993)

- 起因：获客挖掘 vNext 要求「覆盖率是可测的量」（golden set precision@k、双源捕获-再捕获 recall 估计、每源边际产出会计、账单三方对账），计划 docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md §3 W3。
- 改动：
  - 迁移 20261110130000_acquisition_evaluation 追加四张租户表（均 ENABLE+FORCE RLS）：evaluation_set、evaluation_label、source_yield_ledger、coverage_estimate；app_user 权限同步登记到 docs/governance/app-user-table-privileges.json。
  - 新模块 apps/api/src/evaluation：POST /evaluation/sets、POST /evaluation/sets/:id/labels、GET /evaluation/sets/:id/report（precision@k）、GET /evaluation/coverage（Chapman 估计 + 95% CI，自动存证）。
  - source_yield_ledger 生产写入接入 discovery finalizeRun 同事务（幂等），并提供 backfill-source-yield-ledger 回填脚本与 evaluation-import-golden-set 导入脚本。
  - /metrics 新增 GET /metrics/source-yield（按日/周×源聚合）与 GET /metrics/billing-reconciliation（usage_ledger ↔ tool_budget_operation ↔ tool_budget_account 三方视图，标注余额来源表）。
- 测试：Chapman 数值/零重叠/一边为空边界、precision@k 口径、对账差额、候选/覆盖身份键、迁移结构单测；OpenAPI 重导出，operation-descriptions 全覆盖。
- 未做：真实 golden set 标注样例由产品负责人提供后导入（≥100 家）；覆盖估计的真实双源数据要等 W4 原始源装载器上线后在真实 run 上取数；客户钱包余额真值仍在 gain-saas，对账的余额侧只到执行包络。

## 2026-11-10 · Deterministic source coverage fill for query plans and Wikidata subclass closure (#994)

- 起因：2026-11-10 真实 run 实测两个缺陷——①查询规划器漏排可用源：14 条查询只覆盖 5 个源，`model_web_search`（模型联网搜索）一条查询都没排到；提示词只有「结构化源优先、public_web 兜底」的口头引导，没有任何强制覆盖校验。②Wikidata 发现源只按 `P452` 精确行业标签匹配，公司行业常登记为目标行业的子类，命中很稀。
- 改动：
  - `icp.service.generateQueryPlan` 在 TED/FDA 冷路径注入之后、存库之前新增确定性后处理 `withSourceCoverage`（`apps/api/src/discovery/plan-query-sources.ts`）：对「已启用 + 声明公司血缘 + 在 `PLANNER_SOURCE_GUIDE` 可规划集合内」却未出现在任何查询 `filters.source_hint` 的源，按 ICP 主画像（首个目标国 + 行业词）合成一条兜底查询（`keywords: []`、`priority` 末位、rationale「覆盖补齐」），并遵守 `MAX_DISCOVERY_PLAN_QUERIES` 封口。
  - 排除项：TED/openFDA（冷路径注入负责）、`trade_fair`（无匹配展会时勿盲补，2026-11-02 全空查询教训）、`registry_frame`（仅当首个目标国已有 PARSED 快照的注册库装载时补，装载状态未知时补并在 rationale 标注「注册库未装载」warning）。
  - `adapters/wikidata.ts` 行业匹配改为两段式：先跑现有 `P452` 精确匹配（快路径），零命中时回退 `?industry wdt:P279* ?root` 子类闭包查询一次，提升 Wikidata 命中率。
- 测试：`plan-query-sources.spec.ts` 新增 9 个覆盖补齐用例（缺源补查询、已覆盖不重复、trade_fair/ted/openfda 不盲补、registry_frame 装载/未装载/未知/无 ISO2 四分支、无国家行业时省略过滤、首目标国取值、封口与满额不动）；`adapters/wikidata.spec.ts` 新增 2 个 SPARQL 形态断言（精确快路径命中时零闭包调用；零命中时闭包查询含 `P279*` 且保留国家/官网约束）；`icp.service.spec.ts` 更新两处受影响断言并新增装载态接线用例。
- 未做：Wikidata 闭包扩展（P279）结果未加去重排序之外的处理；registry_frame 的覆盖面仍按首个目标国判定，多市场 ICP 不逐国补；查询计划 UI 无「覆盖补齐」专属呈现（依赖既有 rationale 展示）。

## 2026-11-10 · Expand ISIC industry vocabulary with multilingual labels, CPV crosswalks and industry-role terms (#995)

- 起因：产品负责人反馈行业词表过稀——真实 ICP（意大利/美国/英国的「光伏产业链/零碳建筑」采购企业）在 ICP→CPV 冷路径一个 CPV 码都没解析出来，TED 采购源零查询；行业目录检索也因词表稀疏命中极低。
- 改动：
  - `apps/api/src/discovery/isic-seed.ts`：行业节点 11 → 37（新增 26 个出口/获客高频节点：电气 27/271/273/274/279、风电 2811、暖通与热泵 2819、汽车零部件 2930、设备安装/Anlagenbau 33/3320、施工 41/42/43/4321/4322、电力供应 35、化工 20、橡塑包装 22/2220、电子元器件 261、通信设备 2630、批发与进出口 46/4659/4663、软件 62、工程服务 71），每个节点给 zh/de/it/fr/es 标签（能确定的才给）；`crosswalks.cpv` 只锚定官方核验过的 CPV 族；光伏/风电/储能/热泵/EPC/零碳建筑/楼宇自控/泵阀贸易等产品词与中英德意法西别名写入 `term_alias(kind=industry)`（去重后 898 条行业词条）。
  - `apps/api/src/discovery/cpv-seed.ts`（新）：CPV 子树从脚本挪出为可测试模块，5 → 71 个码（09/24/31/32/34/42/43/44/45/71/72；对照 cpvcodes.eu 官方浏览器、EUR-Lex Reg. 213/2008 清单与 TED 公告用法核验，宁可少而准），parentCode 前缀嵌套。
  - `apps/api/scripts/seed-taxonomy.mjs`：改为从 dist 导入两份种子；industry 标签写 zh/de/it/fr/es；新增 `industry_role` 渠道角色词种子（分销商/批发商/进口商/贸易商/零售商，含 Fachhandel/Großhandel/rivenditore/distributore/distributeur/mayorista 等本地语言词）；保持幂等 upsert 并打印各 kind 计数。
  - `apps/api/src/discovery/taxonomy-vocab.spec.ts`（新）：用内存 taxonomy 桩断言「光伏/太阳能/零碳建筑/建筑电气/泵阀贸易/EPC/热泵」解析出非空 cpvCodes；种子完备性（别名不跨节点重复、ISIC↔CPV crosswalk 双向可解析、CPV 父码前缀嵌套）。
- 测试：taxonomy-vocab / icp-to-cpv / industry-map / company-normalization / icp-to-naics 五个 spec 文件 69 项全绿；`@global/api` build 通过。
- 未做：不改查询构造代码（search-localization 由并行会话维护，本 PR 只提供数据面）；不部署、不把种子写入运行库（发车后按运维窗口执行）；46 批发族与 4659 不挂 CPV 锚（避免污染 TED 中标反查，ICP 只给「批发」时走诚实的 icp_seed_gap warning）。

## 2026-11-10 · Source compliance matrix, governed OpenCorporates source and de/fr/it/es industry role terms (acquisition vNext W4) (#996)

- 起因：获客挖掘 vNext（`docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md` §3 W4）要求原始源下沉前先过合规矩阵，并把 OpenCorporates 作为 P0 第一源接入受治理发现管线；查询计划的本地语言词表同时补齐德/法/意/西的行业角色词。
- 改动：
  - 新平台表 `source_compliance_matrix`（迁移 `20261110080000_source_compliance_matrix`）：许可分类/robots/ToS/个人数据分级/保留期/责任人；初始行覆盖 openstreetmap、wikidata、ted、openfda、companies_house、inpi_rne、gleif、google_patents 与新源 opencorporates（approved_at 留空＝商用订阅签署前不得上线）。app_user 只读。
  - 工具 broker 源合规闸门：声明 `compliance.sourceKey` 的新源工具在 `SOURCE_COMPLIANCE_GATE=enforce` 时要求矩阵已批准行（未登记/未批准=fail-closed）；默认 off 行为不变，未声明 sourceKey 的旧源只走既有 source_policy。
  - 新受治理工具 `opencorporates.search`（`opencorporates-search/v1` typed projection，provider `opencorporates`，company_registry 类，完整血缘回执 producer=opencorporates.search）；`OPENCORPORATES_PROVIDER` 默认 off、`data_provider.opencorporates` 默认 DISABLED、缺 `OPENCORPORATES_API_TOKEN` 时 fail-safe 有效空。
  - 发现治理 SQL（`append_discovery_query_lineage_v1`）白名单与 attempt 三元组扩入 opencorporates（纯 widen，合同哈希不变）。
  - `search-localization` 的 de/fr/it/es 分销商角色词各加一组行业词（Fachhandel/Importeur、importateur/négociant、importatore/commerciante、importador/comerciante 等），既有前三项顺序不变。
  - 注册面同步：task/execution-authority 计数（23 tools / 49 callsites）、durable-result-strategies、domain-ack 两处绑定、receipt facts、provider registry/source classes/plan-query-sources、技术报价包络（适配器 9→10 并登记 opencorporates 搜索出网上界）。
- 测试：新增适配器/工具/provider/迁移/合规闸门单测与投影边界样例；`execution-authority-policy.spec`、provider registry、plan-query、durable-results 计数按真值更新；`gctl check` 全绿（CI 为准）。
- 未做：OpenCorporates 商用订阅与真实 key 未配置，真实限流/配额实测留待部署后验收；Companies House / INSEE SIRENE / 展会原始目录等其余 P0 源与本地语言真实 run 留待后续切片。

## 2026-11-10 · Deep-acquisition W2 legal entity graph and company-to-entity disambiguation (#997)

- 起因：获客挖掘 vNext 计划（`docs/superpowers/plans/2026-11-10-deep-acquisition-vnext.md`，经计划 PR 单独合入）§3 W2——深度优先要求公司记录可落到法人实体，同名异地与集团/子公司分开；现有 canonical_company 只有域名/名称级去重，没有实体图谱。
- 改动：
  - 迁移 `20261110070000_legal_entity_graph`：新表 `legal_entity`（租户级，身份键 workspace+scheme+country+value，scheme ∈ lei/vat/hrb/siren/ch/kvk/cvr/bolagsverket/other）与 `company_legal_link`（confidence、match_method、match_rule、status auto/review/rejected、证据 JSON），双表 ENABLE+FORCE RLS；设计取舍（为何租户级、为何 country 入键、HRB/VAT 的 caveat）写在迁移头注释。
  - 匹配引擎 `apps/api/src/discovery/entity/`：确定性键优先（复用 registry 的 LEI/VAT 归一；HRB/SIREN/CH/KVK/CVR/bolagsverket 规范式），VIES 校验留 `VatValidator` 注入点（默认不出网，VAT 命中落 review）；无键时 Fellegi–Sunter 概率匹配骨架（blocking=国家+归一化名字前 4 字符，名称/国家/地址字段权重表可配，双阈值 auto/review）；同 scheme 键冲突 → rejected 留档（同名异法人硬门）。
  - 端点：`POST /companies/{companyId}/legal-links/resolve`（登记自实体/候选 → 消歧 → 落库 → 返回链接；acquisition:write）与 `GET /companies/{companyId}/legal-links`（acquisition:read），operation-descriptions 与 OpenAPI 同步。不自动合并两个已存在的 canonical 公司。
- 测试：新增单测覆盖标识规范式、确定性键命中/VIES 三态、同名异法人反例、概率匹配双阈值分档与 blocking 拒配；迁移静态契约 spec（词表闭合/唯一键/复合外键/RLS/授权与 docs/governance/app-user-table-privileges.json 清单一致）。真库面由 CI 的 prisma-drift、rls-catalog、app-user-table-privileges 三道门复核。
- 未做：概率权重表未用标注数据拟合（起始值 + 版本号 fellegi_sunter_v1，W5 主动学习重校准）；父子/集团边（parent_lei 已在证据中，边表留给图谱后续波次）；人工复核端点与「合并两个 canonical 公司」流程；W4 源装载器（legal_entity 目前由 GLEIF/官网 VAT 与 resolve 请求体 candidates 填充）。

## 2026-11-10 · 修复验证 run 的三处源失败：public_web 空检索串、web_search 确认截断、TED/openFDA 投影拒绝 (#998)

- 起因：2026-11-10 的验证 run 97a4fa1b 以 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH` 整体失败，TED / model_web_search / public_web 三源零产出。逐层定位：
  - 覆盖补齐把 ICP 原始主画像（市场词「意大利（IT）」、中文行业词「太阳能光伏」）抄进 public_web 查询：`targetCountries` 不剥「（IT）」尾注 → 国家识别落空、语言回退 en → 中文词被检索语言过滤整体剥离 → `searches.length===0` → provider 抛 `ApplicationFailure.nonRetryable(DISCOVERY_MARKET_UNSUPPORTED)` → 治理血缘计划构建器把「provider reject」判成血缘失配，整轮 run 失败；
  - `discovery.web_search_candidates` 结构确认在 8_192 输出预算下被 deepseek-flash 推理吃满（finish=length、content 为空）→ `STRUCTURED_OUTPUT_EMPTY_TRUNCATED` → 确认环节整段作废、0 条记录；
  - ted.provider 请求 `maxRecords=max(limit,50)`（去帽后 250），超过持久投影 `ted-search/v1` 的 awards 上限 32（另受 120 KiB 聚合门约束）→ `TOOL_DURABLE_RESULT_PROJECTION_REJECTED`，TED 恒 0 条；openFDA 同型（请求 250 vs establishments 上限 50，本 ICP 未触发）。
- 改动：
  - `apps/api/src/discovery/search-localization.ts`：新增 `stripMarketQualifier`，`targetCountries` 逐词剥掉「（IT）」类尾注后再匹配国家与语言；`searchLanguagesForMarkets` 复用同一剥离。
  - `apps/api/src/discovery/plan-query-sources.ts`：覆盖补齐的 firstTarget 先剥尾注（registry_frame ISO2 解析随之恢复）；补齐查询借用本轮已规划查询里市场语言可用的关键词（≤3、去重），不再只带 ICP 原词——中文行业词交给只认市场语言的源（public_web）只会得到空检索串。
  - `apps/api/src/discovery/providers/public-web.provider.ts`：空检索串改为 fail-safe 空结果 + 有效空血缘（与 ted / model_web_search 同约定，AGENTS.md §5 单源失败不阻断其余源），`DISCOVERY_MARKET_UNSUPPORTED` 错误码留在日志。
  - `apps/api/src/discovery/providers/ted.provider.ts`、`openfda.provider.ts`：请求量钳进持久投影契约（TED awards ≤32、openFDA establishments ≤50）。
  - `apps/api/src/ai-tasks/task-registry.ts`：`discovery.web_search_candidates` 输出预算 8_192 → 16_000（与 icp.design / discovery.query_plan 同档）。
- 测试：plan-query-sources / search-localization / public-web-search-first / task-registry / ted / openfda / source-result-projections 7 个 spec 264 项通过；gctl check 全绿（含零容器单测）。
- 未做：上调持久投影契约（TED/openFDA 每查询更多记录）属平台级改动（120 KiB 聚合门与 schema 上限要一起动），另行评审；signal-query 的 TED/openFDA 默认 maxRecords（100/200）超出同一契约，signal 恢复启用前需先对齐。

## 2026-11-10 · 未应用迁移改名到已应用迁移之后——修复合并顺序导致的 MIGRATION_REVISION_MISMATCH (#999)

- 起因：`20261110090000_understanding_admission_lease` 已在本机库应用；随后合并的 #996（080000_source_compliance_matrix）与 #997（070000_legal_entity_graph）名字排在 090000 之前且未应用。prisma 按名字顺序应用后，库「最新完成迁移（finished_at）」会小于镜像的 migration_revision（按名字取最大），运行时报 `MIGRATION_REVISION_MISMATCH` 拒绝启动（2026-11-10 发车 dry-run 实测拦截，未切换）。
- 改动：把两个**未应用**迁移目录改名到 090000 之后——`20261110080000_source_compliance_matrix` → `20261110110000_source_compliance_matrix`、`20261110070000_legal_entity_graph` → `20261110120000_legal_entity_graph`。仅目录改名，SQL 内容不变；已应用迁移不改名（迁移只前进）。后续在飞迁移按「合并时大于当前已应用最大名」重新取号（W3 060000 → 20261110130000 由其 PR 自行改名）。
- 测试：prisma 漂移门在一次性库全链重放通过；gctl switch-backend dry-run 的迁移顺序检查通过后发车。
- 未做：不改变任何表结构；不动运行现场。

## 2026-11-10 · 修复验证 run 遗留的三处采集缺陷：web_search 单条非法域作废整批、单公司抓取失败连坐、TED 数字税号与超长数组拒收 (#1000)

- 起因：run 7a616c8a（fded81d1）的漏斗分析暴露三处非阻塞缺陷：① model_web_search 探索环里一条非法域名（`candidates[11]`）让整批候选作废；② profileCompanyOnce 把单家公司的站点抓取失败（crawl4ai 反爬/502/超时）放大成活动失败，deep 阶段 11 个目标 7 个连带失败（PARTIAL failure_rate_high）；③ TED 真实中标数据 85/88 条被 raw schema 拒收——纯数字国家税号（意大利 partita IVA 11 位）撞上防电话 PII 守卫、CPV 数组超 20 项触发容器守卫、名称含 ’/–/" 或超 16 词。
- 改动：
  - `apps/api/src/discovery/model-web-search/model-web-search.ts`：`parseModelWebSearchAnswer` 改为**按条过滤**——单条候选域名/证据/名称不合规只丢该条，全部丢光才报错；每条候选仍在 provider 层做域名与「证据必须出现在真实检索结果」的落地校验。
  - `apps/api/src/temporal/discovery.run2.pipeline.activities.ts`：`profileCompanyOnce` 的失败边界改为「账本/预算/回执类失败上抛，其余软失败 + 日志」——覆盖档案抓取与持久化两段；`RUN_LEVEL_FAILURE_TOKENS` 定义在文件头。
  - `apps/api/src/discovery/providers/ted.provider.ts`：CPV/买方国别去重并截断到 20；联合体整句 winner-identifier 不再当标识符；名称排版标点（’ – "）换 ASCII、超 16 词按词截断。
  - `apps/api/src/discovery/raw-source-provider-schema.ts`：仅对 ted 的 identifier / attributes.ted.winner_identifier 放行纯数字国家税号（6–20 位；登记号是公司事实、scheme 已带国别，防电话守卫的意图不受影响）。
- 测试：真实 TED 数据探针（257 条中标→公司记录）通过率 19/257 → **257/257**；ted/model-web-search/schema-probe/public-web-raw-governance/directory/openfda/run2 活动与失败接线共 11 个 spec 全绿；gctl check 全量通过。
- 未做：taxonomy「太阳能光伏→ISIC 2610（半导体）」导致的 wikidata 精度问题（40 家 mismatch 的主因）未在本 PR 处理，按 vNext 词表路线另行评估；signals 阶段 BUDGET_AUTHORITY_NOT_READY 属既有平台预算权威缺口。

## 2026-11-10 · Governed Companies House company-registry discovery source (acquisition vNext W4 P0, second source) (#1002)

- 起因：获客挖掘 vNext W4 P0 第二源——Companies House 公司注册发现（复用既有受治理工具 `companies_house.search` 的 op=search），按名称从官方注册处拉 GB 注册实体，走 discovery→fit→enrich 全管线。
- 改动：
  - 新 provider `companies_house_registry`（company_registry 类；与联系人向 `companies_house` 分开注册，因 source-class 清单按 key 精确比对）：`COMPANIES_HOUSE_REGISTRY_PROVIDER=on` 才声明公司血缘（默认 off 零路由）+ data_provider 新行默认 DISABLED + 缺 `COMPANIES_HOUSE_API_KEY` fail-safe 有效空，三重关闭。
  - 只映射公司字段（注册号/名称/状态），OGL v3.0 署名义务入 license；op=search 输出本身不含 officers/个人字段。
  - 注册面：血缘契约两处、domain-ack governed 绑定、data_provider seed、provider source-class 清单、plan-query guide/priority、技术报价包络（适配器 10→11 并登记 companies_house.search 出网上界）、execution-authority callsites 49→50、provider-registry 文档重渲染。
  - 迁移 `20261110150000_companies_house_registry_provider`：发现血缘 SQL v1 白名单+attempt 三元组纯扩（合同哈希不变）。
  - raw-source 校验/归一与 canonical attributes 增加 `ch_registry`（关闭形状，只含公司字段）。
- 测试：新增 provider spec（映射/绑定/三重闸门/Broker 失败语义）；provider registry、报价包络、domain-ack、execution-authority spec 计数按真值更新。
- 未做：真实 `COMPANIES_HOUSE_API_KEY` 与真机检索留待部署后验收（默认三关关闭）；INSEE SIRENE / GLEIF 增量 / VIES / 展会原始目录属后续切片。

## 2026-11-09 · Add the P0 measurement wave 1 — metric dictionary, read-only funnel and RISKY baselines, capture-recapture scaffold (#902)

- 起因：GainOS 深化计划 v3.0 第 1 章（测量与真值，P0）要求先有分母与真值再谈优化；当前「召回率」「precision」「可触达率」从未被测量，库内「有邮箱」存在三种口径，RISKY 270 条邮件从未做过邮箱级验证。
- 改动：
  - 新增 `docs/metrics/metric-dictionary.md`：v1.0 指标字典，T0–T4 + Guardrail 共 44 个指标（VRIC_1000_STRICT/PLUS 分离、RR1/RR3 强制成对报告、分子/分母/排除项/窗口/分层/CI 规则、口径与现有表的映射、版本与变更流程）。
  - 新增 `scripts/metrics/funnel-baseline.mjs`：只读漏斗基线脚本（`PGOPTIONS=-c default_transaction_read_only=on`；公司池→lead→fit=match→域名→邮箱→电话→VALID，按 workspace/国家/来源拆分，Wilson 95% CI，不解密 PII）。
  - 新增 `scripts/metrics/risky-inventory.mjs`：只读 RISKY 盘点脚本（status×catch_all×verification_method×source_type×email_type 交叉表、公司/域名级汇总、SMTP 探测聚合，不读取 `contact_point.value`）。
  - 新增 `scripts/metrics/capture-recapture.mjs` + `scripts/metrics/lib/psql.mjs`：两 frame 确定性键匹配（domain/registry_id/归一 name+country）+ Chapman 估计量与诊断门（m11<5 不出 N̂），为 ch01 PR-13 留接口。
  - 新增 `scripts/metrics/capture-recapture.test.mjs` 与 `scripts/metrics/lib/psql.test.mjs`（node:test，26 例）并从 `scripts/governance-contracts.spec.mjs` 导入，使 `docs:verify` 的可达性检查成立。
  - 新增两份时点证据：`docs/evidence/2026-11-09-funnel-baseline.md`（全库 2,423 公司/403 match/73 有邮箱 18.1%/4 电话/0 VALID；主租户 787/128/9/0）与 `docs/evidence/2026-11-09-risky-inventory.md`（274 邮箱=270 RISKY（246 从未验证+24 pattern_guess）+3 UNVERIFIED+1 INVALID；250 条无 source_type；135 次 SMTP 探测均为域名级）。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 26/26 通过（等价于 `cd scripts/metrics && node --test`；本机 Node v22.23.1 的测试运行器不接受目录参数）；两个数据库脚本已在 `global_dev` 只读实跑，写语句实测被只读事务拒绝；`pnpm docs:verify` 的 verify-docs 子项本地已通过（0 errors）。
- 未做：不部署、不发车；不改任何主链代码与数据库 schema；金标集（E3）、frame 抽样召回、竞品对照（E5）与三源 log-linear CR 不在本波。

## 2026-11-09 · Wave 0 backend hardening — campaign job reaping, budget readback, quickJudge gate, sanctions freshness, Prisma drift gate (#903)

- 起因：2026-11-08 六套全局审查确认的五条高优缺陷（ch08 §2.2/§2.3）：campaign 规划 job 可永久 RUNNING 且阻塞后续规划；$15/30 天花费窗口只统计 discovery 模型成本；quickJudge 批量路径绕过逐家出网闸门；制裁名单陈旧 28 天而筛查照跑；Prisma datamodel 与真库分叉 20 表且 CI 无漂移门。
- 改动：
  - campaign：launcher 显式 `workflowExecutionTimeout=60m / workflowRunTimeout=50m / workflowTaskTimeout=30s`；失败回写重试提到 8 次，重试耗尽改由 outbox 集成事件 `CampaignPlanJobFailed` 兜底（SaaS 拉取后置 FAILED）。
  - 成本护栏 C1：新增服务身份只读端点 `GET /api/v1/execution-budget/window-usage`（`tool_budget_operation.charged_microusd` 实扣为窗口口径，含在途预留与 byPurpose 聚合；`BUDGET_READBACK_SERVICE_TOKEN` + 仅回环）。
  - quickJudge：批量协议 `authorizeExternalAction` 不再恒 true，wire 前用 `companyMayUseExternalProcessingMany` 单事务逐家重校验；被拒整批降级逐家、被禁联公司 skipped。
  - 制裁陈旧门：qualify/decide 前检查 `sanctions_source.last_refreshed_at`（7/14 天三档，`SANCTIONS_LIST_MAX_AGE_DAYS`/`SANCTIONS_LIST_BLOCK_AGE_DAYS` 可配）；blocked 整批 `sanctions_hold`、stale 不产 `recommended` 且 accept 拒绝；`sanctions_screening_result` 增 `list_stale/list_age_days/list_snapshot`；新增 `SanctionsListStale` 集成事件与 `docs/backend/sanctions-operator-refresh.md` §5。
  - worker：显式并发上限 `WORKER_MAX_CONCURRENT_{ACTIVITY,WORKFLOW,LOCAL}`（默认 12/8/4，非法值启动即失败）。
  - 数据门：CI 新增 Prisma 漂移门（`packages/db/scripts/prisma-drift-gate.mjs`：一次性库 `migrate deploy` 后 `prisma migrate diff --from-url --to-schema-datamodel`），基线允许清单 ratchet（当前 110 条已知差异 = 20 张 SQL-only 表 + 列级分叉 + enum 值缺口，均带 owner/到期日），见 `docs/backend/prisma-schema-drift.md`。
- 测试：新增/扩展 `campaign-plan.launcher.spec.ts`、`campaign-planning.workflow.spec.ts`、`campaign-planning.activities.spec.ts`、`execution-budget-window-usage.service.spec.ts`、`budget-readback-service-token.guard.spec.ts`、`discovery.run2.activities.spec.ts`（TOCTOU 负向）、`sanctions-freshness.spec.ts`、`sanctions-screening.spec.ts`、`qualify.activities.spec.ts`（三档）、`lead-qualified-snapshot.spec.ts`（decide stale）、`worker-concurrency.spec.ts`；`gctl check` 全绿。
- 未做：SaaS 侧窗口判定切 max(ledger, engine)+fail-closed 缓存、`CampaignPlanJobReaperService`（75 分钟）、`CampaignPlanJobFailed`/`SanctionsListStale` 的 SaaS 消费端均在 gain-saas，另行排期；worker 并发值的压测校准与部署待发车；20 张 SQL-only 表补齐 datamodel（P5c-BE-30）后基线逐条删除。

## 2026-11-09 · Add ch01 wave 2 — golden sampling scaffold, frame registry matrix, paired RR1/RR3, multi-frame log-linear CR, VRIC PLUS caliber (#904)

- 起因：ch01（测量与真值）第二波要求把「金标集、frame 分母、回复口径、三源捕获回捞、VRIC PLUS」从计划文本落成可校验的脚手架与口径；不采购任何付费数据、不发车、不部署。
- 改动：
  - 指标字典升 v1.1：新增 §1.3.1 VRIC PLUS 口径细则（phone VALID 四条件、email_only/phone_only/both 强制通道拆分、引擎侧上界声明）；§1.4 增加 RR1/RR3 机器实现与成对声明校验；§6 三源 log-linear 落地说明；§2 映射补 frame/golden。
  - 新增 `docs/metrics/frame-registry.md` + `docs/metrics/frames/frame-registry.v1.json`（19 法域矩阵：许可、获取方式、频率、规模、坑；全部 DRAFT，未接入）+ `scripts/metrics/frame-registry.mjs` 校验器（唯一键、枚举、ACTIVE 需 license）与测试。
  - 新增金标抽样脚手架：`evals/golden-discovery/`（README、`schema/golden-manifest.schema.json`、`v1/manifest.template.json`：accounts 500 / contacts_strict 500 / contacts_plus 500，三层配额与固定 seed）+ `scripts/metrics/golden-sampling.mjs`（确定性分层抽样、最大余数配额、欠采样如实报告、refs SHA-256）+ `scripts/metrics/sql/golden-pool-{accounts,contacts}.sql`（只读导出模板，联系人 ref 用盲化 dedupe_key）+ 合成样例池与测试。
  - 新增 `scripts/metrics/reply-rate.mjs`：RR1/RR3 成对计算（`unknown>0` 无 `ê` 拒绝出数）、Wilson CI、`--check` 拒绝单口径声明；测试含章节示例复算（0.42%/0.58%）。
  - 扩展 `scripts/metrics/capture-recapture.mjs`：`--frame` 重复传参；三源键簇捕获矩阵、8 个分层 log-linear 模型（G²+AIC 选型，饱和模型 df=0 单列）、参数化 bootstrap 95% CI（固定 seed）、两两交集/模型跨度诊断门；修复 IPF 缺失格边际处理（只在可观测格上匹配边际，缺失格按乘性结构外推）；测试含已知 N 的回收（20,000 → CI 覆盖真值）。
  - `funnel-baseline.mjs` 的 VRIC 输出增加 PLUS 通道拆分（email_only/phone_only/both）。
  - 新增 `scripts/metrics/lib/prng.mjs`（播种 PRNG/Poisson/分位数）与 `scripts/metrics/lib/psql.test.mjs` 等单测；`scripts/governance-contracts.spec.mjs` 导入全部 metrics 测试进入 CI 可达链。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 golden-sampling/frame-registry/reply-rate/多源 CR 用例）；`node scripts/verify-docs.mjs` PASS（0 errors）；`node --test scripts/governance-contracts.spec.mjs` 393+ 全绿（本地，含可达性检查）；未跑全量 build（无 TS/依赖变更，CI 承担）。
- 未做：不采购付费 frame/竞品数据；不做真实金标标注（PR-08 属产品负责人）；frame 适配器与 `frame_registry` 表（PR-11/12）、CR 的 Splink/LCMCR（PR-13 余量）、度量台与看板不在本波。

## 2026-11-09 · Machine-read the metric dictionary and enforce it in CI (metrics:lint), plus the PR metric-impact block (#904)

- 起因：ch01 PR-01 要求指标字典落到机器可读、可 lint 的一等公民（字段齐全、公式来源存在、版本递增）；PR-16 要求补文档入口与 PR 模板的「指标影响」栏。
- 改动：
  - 新增 `docs/metrics/dictionary/` 六份 `metric-definition/v1` JSON（t0-vric / t1-coverage / t2-reachability / t3-engagement / t4-business / guardrails），共 44 个指标；每指标含 id/name/tier/unit/owner/status/version/effectiveFrom/exprStatus（全部 PENDING，ch01 允许的显式标注，EXPLAIN 需只读副本）/definition/分子/分母/排除项/窗口/分层/CI 方法/benchmark/changelog。
  - 新增 `docs/metrics/schemas/metric-definition.v1.schema.json`（单指标 JSON Schema）与 `docs/metrics/schemas/sources.v1.json`（数据源登记：existing 18 / planned 8 / saas 5；ACTIVE 指标只许引用 existing）。
  - 新增 `scripts/metrics/metrics-lint.mjs`：零依赖校验器——未知字段拒绝（typo 防线）、ID/名称唯一、tier 与 ID 前缀及文件一致、来源必须登记、ratio 类必须有分母、窗口/分层/CI 词表闭合（GUARDRAIL 允许 ci=none）、changelog 版本 1..N 连续且末条等于 version；`--json` 供机器读；非零退出供 CI。
  - 新增 `docs/metrics/README.md` 门户（PR-16）；`.github/pull_request_template.md` 增加「指标影响」栏（指标 ID/口径是否升版本/是否重跑金标）。
  - 指标字典升 v1.2：§7-5 改为机器化已落地（JSON 而非 YAML 的理由：仓库无可直接引用的 YAML 依赖，引入会动锁文件与 Copy 绑定）；§8 增 v1.2 条目。
  - `scripts/governance-contracts.spec.mjs` 导入 `metrics-lint.test.mjs`，使字典 lint（44 指标、0 问题）与 frame registry 校验（19 法域、0 问题）随 `docs:verify` 在 CI 强制执行。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 lint 9 例：checked-in 字典全过、未知字段、来源未登记、ACTIVE 用 planned 源、版本缺口、跨文件重复、故意改坏判红）；`node scripts/metrics/metrics-lint.mjs` 0 问题；`node scripts/verify-docs.mjs` PASS；`node --test scripts/governance-contracts.spec.mjs` 全绿（含 spec 可达性）。
- 未做：未做 `EXPLAIN` 级公式校验（需数据库，CI 不连库）；未动 frame 适配器/DB 迁移（P2 会话在改引擎 registry/snapshot）；未采购任何数据；未做真实金标标注。

## 2026-11-09 · Channel pool wave 1 — channel-manifest/v1, secret refs, HTTP connector runtime, probe and health thresholds (#905)

- 起因：GainOS 深化计划 v3.0 第 6 章（渠道资源池）——现有 `source_channel` 只有 crawl 形态可执行，api 形态是空契约（`config.adapter` 无执行路径），无密钥引用、无健康画像、无自动停用长尾规则（CH-1/CH-2/CH-3/CH-4/CH-7/CH-10 的数据层与运行时首波）。
- 改动：
  - 迁移 `20261109100000_channel_manifest_v1`：`source_channel` 增量列（manifest/manifest_sha256/manifest_version/connector_kind/adapter_key/base_url/auth_ref/rate_limit/pagination/field_mapping/health_state/consecutive_failures/last_success_at/disabled_reason/quota_policy/probe_required）+ 新表 `source_channel_probe`、`source_channel_health_event`；17 行历史数据 config 原值保留，ENABLED 行回填 `probe_required=false`，其余保持 true。
  - `@global/contracts` 新增 `channel-manifest/v1` JSON Schema（draft 2020-12，章节 §6.3.3 全文）与字段白名单；引擎侧 `parseChannelManifest` 做 Ajv + 语义校验（危险静态头、联系人字段仅详情模式、allowedHosts 覆盖 baseUrl、robotsPolicy=C 拒绝、JSONPath/regex 可编译）并计算 `manifest_sha256`；`configToManifest` 保持历史 crawl config 语义不变。
  - 连接器运行时 `apps/api/src/channels/connector/`：密钥引用解析（file/env，TTL 60s，错误不区分原因、绝不含值）、认证注入（none/apiKey/bearer/header/basic；oauth2 v1 明确不支持）、分页（none/page/offset/cursor/link）、令牌桶 + 每域延迟、指数退避 + Retry-After（3 次/60s）、三态熔断（5 分钟开、半开单探测、10 分钟起指数重开）、JSONPath 抽取 + transforms。物理请求只走既有 `requestPublicHttp`（https/公网 IP/逐跳重验/字节上限），且缺平台围栏绑定时一律拒绝——不存在未治理出网路径。
  - 健康与自动停用：`evaluateChannelHealth` 纯函数实现 20 次/4 天 WARNING、30 次/7 天 AUTO_DISABLED(AUTO_STREAK)；finalize 同事务维护 `consecutive_failures`/`last_success_at` 并写健康事件；API 进程内小时级扫描钩子（沿用 sweep-scheduler 周期桶模式，不新增平台 schedule）。
  - 运营台 API：`GET /source-channels/:id`（manifest + 健康摘要 + 密钥「已配置/未配置」，值永不返回）、`POST /source-channels/:id/test`（保存即测试，probe 落库、成功才解除 `probe_required`、样本联系人字段只留命中布尔）、`POST/PATCH` 支持 manifest 导入与重存（重存即置 `probe_required=true`）、manifest 渠道启用前 409 `CHANNEL_PROBE_REQUIRED`；人工启停写 MANUAL_ENABLE/MANUAL_DISABLE 事件。
- 测试：新增 manifest 校验 15 例、密钥解析 6 例、认证注入 8 例、分页 8 例、退避 5 例、熔断 6 例、连接器运行时 12 例、字段抽取 4 例、健康阈值 5 例、probe 8 例、扫描 4 例、迁移契约 5 例、服务层 manifest 9 例；更新 run recorder（阈值/事件）与既有 authz/DI 用例（新端点入矩阵）。
- 未做：api 渠道的 Temporal 执行链与平台 Grant/fence 绑定（CH-5，probe 在本波内 fail-closed 503）；source_policy 派生与官方白名单（CH-8）；crawl 形态 manifest 执行、详情页逐条抓取、oauth2、link 之外的多段/签名协议；gain-saas 运营台 UI 由主会话前端线另行施工。

## 2026-11-09 · Four-state contact point verification with an append-only verification ledger (#906)

- 起因：效果审计（2026-11-08）显示 274 条邮箱里 250 条从未验证、24 条仅 pattern 猜测，`contact_point` 没有四态、缺 `source_type`/`verification_method`，验证事实散落在自建 SMTP 的单一返回码里，全库 VALID=0 无法区分「未验证」与「劣质」。
- 改动：
  - 迁移 `20261109120000_contact_point_four_state`：`contact_point` 增 `verification_state`（VALID/INVALID/CATCH_ALL_RISKY/UNKNOWN）等十列与形状/等价约束；`source_type` 回填 `legacy_unclassified` 后收紧 NOT NULL；`verification_method` 增 `third_party_api`；存量按 RISKY→UNKNOWN（仅 catch_all 域进 CATCH_ALL_RISKY）回填并排入重验队列。
  - 新表 `contact_point_verification_event`（append-only 事件账）：唯一幂等键 (workspace, point, provider, request_hash)，RLS 强制，`app_user` 仅 SELECT/INSERT。
  - 纯函数状态机 `contact-point-verification-state`（四态↔legacy status 投影、verdict 映射、转换表、来源分类）与事件写入器 `contact-point-verification-event`。
  - 三处写入路径改造：联系人发现按 adapter/来源页映射 `source_type`；邮箱猜测同步写四态；`verifyContactPoint` 同事务推进状态机并写事件账（BLOCKED 只记账不改状态）。
  - 回填脚本 `apps/api/scripts/backfill-contact-domain-blind-key.mts`（解密→域 HMAC 盲索引，幂等分批、dry-run、不落明文）。
- 测试：状态机/映射纯函数单测（转换表全分支）；迁移静态契约 spec + 迁移后 PostgreSQL 行为 spec（CHECK/valid_since 等价/source_type NOT NULL/事件账幂等与 RLS append-only，接入 CI Raw SQL 步骤）。
- 未做：单一写入器架构守卫（P1-02 后续）；富集尝试账与 catch-all 策略表（P1-08/P1-13 各自迁移）；读侧迁移到 `verification_state`。

## 2026-11-09 · Add the registry frame foundation (data model, loader v0, deterministic merge v0, recall audit scaffold) (#907)

- 起因：GainOS v3.0 第 3 章（召回与枚举，P2）第一波——召回率从未测量、注册库源缺失的原因是「分母不存在」。本步先做与外部网络无关的地基：frame 数据模型、CSV/JSON 装载器 v0、确定性硬键归并 v0、召回审计脚手架与域名解析接口占位（ch03 T3-01/T3-03/T3-16/T3-20/T3-12 的子集）。
- 改动：
  - 迁移 `20261109100000_registry_frames`：新增 5 张平台表（无 RLS，app_user 只读，写入只经平台 ops/owner 连接）——`registry_frame`（帧定义）、`registry_snapshot`（文件级快照元数据 + sha256 可回放）、`registry_entity`（归一实体，业务键 `(scheme, reg_number)` + contentHash）、`registry_entity_change`（append-only ADDED/UPDATED/WITHDRAWN/REAPPEARED 事件，唯一键幂等）、`registry_entity_link`（硬键 CONFIRMED / 软键 PROPOSED 的跨帧链接与人工复核队列）；同步 `docs/governance/app-user-table-privileges.json`。
  - `apps/api/src/registry/`：帧配置校验（`frame-types.ts`）、RFC 4180 CSV 与点分路径 JSON 解析（`frame-parse.ts`）、单行归一与 contentHash（`frame-normalize.ts`）、装载计划纯函数（`frame-loader.ts`，连续两个快照缺席才 WITHDRAWN、重放幂等）、装载编排（`frame-importer.ts`，同 sha256 快照幂等、行级校验 fail-closed、`--allow-partial`）、确定性归并 v0（`merge.ts`：LEI/注册号交叉引用 CONFIRMED，VAT/域名 PROPOSED，名称 trigram 只生成候选对）、域名解析接口占位（`domain/domain-resolver.ts`：search/ct/cc 三路 provider 契约 + fixture 实现）、召回审计计算（`recall-audit.ts`：Wilson 95% CI、分层确定性抽样、固定模板报告）、Prisma store（`frame-store.prisma.ts`，owner 连接）。
  - `scripts/frames/`：`import-frame.mts`（装载 CLI，支持 `--dry-run`/`--allow-partial`/`--propose-links`）、`recall-audit.mjs`（审计 CLI，Node 原生 type-strip 直接运行）、2 个 frame 配置 + 2 个 fixture（Companies House 风格 CSV、GLEIF 风格 JSON）+ 召回审计样例输入。
- 测试：vitest 覆盖 CSV/JSON 解析边界（引号/换行/BOM/缺列）、行级归一（状态/法律形式映射、LEI/VAT/域名非法即拒）、装载幂等（同文件重导零写入、变更检测、单次缺席不退出/两次才 WITHDRAWN、重现 REAPPEARED）、硬键归并（LEI CONFIRMED、namespace 隔离、identifiers 交叉引用、VAT/域名 PROPOSED、trigram 候选不自动合并、输入顺序无关）与 Wilson/抽样/报告；`scripts/frames/recall-audit.spec.mjs`（node --test）覆盖审计 CLI 的 census/抽样/落盘/参数失败；两个 fixture 通过 `import-frame` 端到端装载（内存 store）。
- 未做：真实注册库接入（T3-04 起）、MinIO 快照对象存储与 Temporal 工作流（T3-03 完整版）、Splink 概率归并（T3-16 后续）、Tier A 人工裁决与 run2 状态机接线（T3-20 后续）、域名候选的真实搜索/CT/CC 网络适配器（T3-11/T3-12 后续，本波只有接口 + fixture）。

## 2026-11-09 · Third-party email verification adapter, vote policy and catch-all send tiers (#908)

- 起因：自建 SMTP 探查在反枚举（M365/GWS）、catch-all 与 25 端口限流下结构性拿不到 VALID，市场成熟的第三方验证 API 一个都没接入；catch-all 地址也没有分数分层与发送国家白名单。
- 改动：
  - `apps/api/src/enrichment/verification/`：`EmailVerificationProvider` 接口 + `MillionVerifierProvider`（fetch、env 凭据、8s 超时、429/5xx/超时/畸形体统一降级 UNKNOWN 且不抛）；结果映射四态与 0–100 基础分，`accept_all=true` 一律降为 CATCH_ALL_RISKY。
  - 验证投票策略 `resolveVerificationVotes`（双正规则：单验证器 positive 永不判 VALID；正负冲突判 UNKNOWN；accept_all 优先）与评分 `scoreEmailPoint`（基础分/一致性/pattern/供应商信心/90 天衰减/软退信/投诉）。
  - catch-all 发送分层 `catch-all-policy`：≥70 正常、40–69 灰度、<40 抑制；灰度白名单仅 US/FR（DE 永不进入），配置可从 env 覆盖。
  - `data_provider.millionverifier` seed（默认 DISABLED）+ `source_policy.api.millionverifier.com` 登记（未登记即 fail-closed）。
- 测试：假 HTTP fixture 契约测试（200/429/5xx/超时/畸形体/缺凭据）、投票矩阵 12 组组合、评分分量与分层边界值；治理 provider registry 条目同步。
- 未做：Emailable/Truelist/ZeroBounce 适配器与真实验证瀑布编排（P1-04/05/06 后续）；真实 key 到位后的 scorecard 验收。

## 2026-11-09 · Batch re-verification CLI for existing contact point emails (#909)

- 起因：迁移把 274 条存量邮箱排进 UNKNOWN 重验队列，但没有任何批处理入口能消费该队列；人工逐点调用 HTTP 验证既慢又缺幂等与成本记账。
- 改动：
  - `apps/api/scripts/reverify-contact-points.mts`：按 `next_reverify_at`（或 `--ignore-schedule` 按状态）取有界批次，逐点过 suppression（email/domain/company_name/contact_key 四类）与人名邮箱合规门，再调第三方验证器（限流 `--rate`）；供应商原始裁决与投票裁决后的四态分别落事件账与点状态（同事务）。
  - 幂等：`request_hash = sha256(pointId|providerKey|密文值|周期桶)`，同桶重跑不重复计费（调用前预查事件账）；`--dry-run` 离线只报选点与门状态。
  - 门：`PII_ENCRYPTION_KEY` 必需；live 模式要求 `data_provider.millionverifier` ENABLED + `source_policy` 已登记未 SUSPENDED + `MILLIONVERIFIER_API_KEY`。
- 测试：内存 fake 覆盖单验证器 positive 不判 VALID、invalid→INVALID、accept_all→CATCH_ALL_RISKY、网络错误不改状态、合规门/suppression 不触网、幂等预查与 dry-run。
- 未做：Temporal 每日 Schedule `CONTACT_REVERIFY_SWEEP` 接线（P1-19 后续，activity 复用 `runReverifySweep`）；真实 key 到位后的小批实测。

## 2026-11-09 · P3 J01 — judgment failure taxonomy v1 (failure-codes) (#910)

- 起因：ch04 §4.3.5 失败分类学（D4-6）。「45% 失败」无法按 stage×cause 归因，`COMPANY_PIPELINE_FAILED` 聚合码不可拆分，重试策略只能按消息猜。
- 改动：新增 `apps/api/src/discovery/judgment/failure-codes.ts`——8 个 stage、26 个版本化 cause、5 种 outcome 的闭集，每个 cause 带 `retryable` 与默认处置（retry/failover/degraded/failed/skipped）；14 个 `GATE_*` reason 闭集；未知 cause 查表 fail-closed（抛 `UNKNOWN_FAILURE_CODE`），只有显式 `normalizeFailureCode` 才落到 `UNKNOWN_UPSTREAM`；版本常量 `failure-codes/v1`，改表须升版本并同步 J02/J22 清单。
- 测试：`failure-codes.spec.ts` 6 例——映射 100% 合法、码集合快照、重试语义（429/5xx/超时/租约/事务可重试；预算/鉴权/证据类不可重试）、未知码 fail-closed、gate 码闭集唯一且与失败码不重叠。
- 未做：J02 管线失败归因接线、Temporal `nonRetryableErrorTypes` 清单、J22 值班 runbook（下一批）。

## 2026-11-09 · Derive source_policy drafts from channel manifests and gate channel enablement on reviewed terms (#911)

- 起因：v3.0 第 6 章 CH-8——渠道 ENABLED 前必须对 `allowedHosts` 逐域有已复核的 `source_policy`（reviewStatus=APPROVED、termsStatus∈{REVIEWED_OK, REVIEWED_RESTRICTED}），官方开放数据域豁免；现状注册与治理是两套手写数据、无派生、无一致性校验。
- 改动：
  - 新模块 `apps/api/src/channels/channel-source-policy.ts`：manifest → source_policy 草稿纯函数（domain 去 www、按类别映射 source_type、api 默认 robots ALLOWS、官方白名单 `*.gov`/`*.europa.eu`/GLEIF/Wikidata/Overpass 直接 REVIEWED_OK 并注明 official-open-data）、启用闸门评估（缺失/暂停/条款未复核/crawl robots 受限四类违规）与 owner 脚本的 upsert 输入（更新不覆盖人工 terms/review/robots 结论）。
  - `ChannelService`：manifest 创建/重存的响应返回 `sourcePolicyDrafts`；详情返回逐域 source_policy 状态与违规清单；manifest 渠道启用前新增条款闸门（409 `CHANNEL_GOVERNANCE_INCOMPLETE` + `policyViolations`），官方域豁免。
  - 新 owner 运营脚本 `apps/api/scripts/apply-channel-source-policies.mts`：`--channel <uuid> [--dry-run]`，用 owner 连接幂等落库派生行——`source_policy` 保持 app_user 只读（2026-10-09 加固与 CI 权限门不变），不做运行时写权限放宽。
- 测试：派生矩阵（类别映射/www 归一/通配跳过/官方白名单/crawl robots 保持 UNREVIEWED）、闸门矩阵（缺行/暂停/未复核/受限条款/crawl robots/官方豁免多域）、服务层启用门与详情、upsert 输入不覆盖人工结论。
- 未做：渠道不再被启用后的自动停用不接线（政策 SUSPENDED 只在物理出网前由 ToolBroker 阻断，章节 §6.3.6.5 的约定）；未部署。

## 2026-11-09 · P3 J09 — fit-v2 rubric 工件、judge-output/v2 严格 schema 与提示词 hash 冻结 (#912)

- 起因：ch04 §4.3.3 的深判契约（D4-4）：模型只产出 criterion 级判断，最终 verdict 由确定性代码聚合；提示词与 rubric 必须同源、可冻结、可回归。
- 改动：
  - `apps/api/src/discovery/judgment/fit-rubric.ts`：fit-v2 五 criterion（材质/角色/工艺/商业模式/规模）+ 权重（0.25/0.30/0.20/0.15/0.10）+ 逐档 0–10 锚点（按设计原文的两种档位形状）+ 必填证据 + C2 硬失败阈值；canonical JSON 的 sha256 作为 `RUBRIC_SHA256`。
  - `judge-output-v2.ts`：judge-output/v2 严格 JSON Schema（additionalProperties=false、全 required、枚举闭集、证据 6 条上限、rationale/span/url 长度）与无依赖结构校验器 `validateJudgeOutputV2`。
  - `judge-prompt.ts`：system/user 模板从 rubric 常量插值生成（禁止手抄锚点），`PROMPT_HASH` 冻结系统提示词+模板+rubric+schema+采样；`buildJudgePrompt` 返回 hash 与版本。
- 测试：`fit-rubric.spec.ts` 9 例——权重和=1、锚点完整性（10/0/unclear+中间档、闭集键）、rubric hash 冻结、prompt hash 冻结、锚点逐字出现在 prompt、构造器占位符替换、金样例通过校验、多余/缺失/枚举漂移/重复 criterion/证据超限/越界分数全拒绝。
- 未做：任务注册表与技能包接线（J03 拆分 quick_judge/qualify_fit 时一并）、确定性聚合器与证据校验（J10）、金标（J13）。

## 2026-11-09 · Finish PR-13 matching and diagnostics, add the golden rubric/schemas, and ship the first metric-observation snapshot runner (#913)

- 起因：ch01 剩余卡要求补齐 PR-13（概率匹配、敏感性、下界）、PR-08 的机器侧（rubric 与金标 schema）以及「下一组指标实现」；不部署、不采购、不触碰 frame 适配器/DB 迁移。
- 改动：
  - `scripts/metrics/capture-recapture.mjs` 扩展（PR-13 余量）：Jaro–Winkler 相似度；Splink 式第二段概率匹配——blocking（姓名首 token+国家 / 邮编前缀+国家）、固定权重 Fellegi–Sunter 形状评分（domain/registry 硬键 ±6、name 0–5、国家/城市/邮编 ±）、阈值 auto≥8 / review 4–8 / reject<4、已由确定性硬键合并的对不重复评分；`--probabilistic` 输出复核队列；Chao (1987) 下界 `D + f1²/(2·f2)`；三 frame 自动留一法敏感性（k=2 子集回退 Chapman，跨度 >40% 降置信）。
  - 新增 `evals/golden-discovery/rubric-v1.md`（字段级标注手册：证据优先、保守 unknown、κ≥0.6 门槛、双标与裁决流程、PII 规则）与 `schema/golden-item.schema.json`、`golden-label.schema.json`、`golden-run.schema.json`（PR-08 机器侧；标注本体仍待产品负责人安排）。
  - 新增 `scripts/metrics/metrics-snapshot.mjs`（下一组指标实现）：只读计算 T0-001/T0-002（按 workspace）、T1-008（按 provider）、T1-009（按 disposition）、T2-001/T2-005/T2-007/T2-008（按国家，T2-008 用 Poisson bootstrap），输出 `metric-observation/v1` 行（metricId/version/stratum/window/counts/value/Wilson 或 bootstrap CI/computationHash），供 PR-03 直接落表；无裁决分母的 T2-002/003/004/009 显式 SKIPPED 而不是把 0 当测得率。
  - `docs/metrics/metric-dictionary.md` 升 v1.3（§6 增补概率匹配/Chao/敏感性、§8 changelog）；`scripts/metrics/README.md` 增补新脚本；`scripts/governance-contracts.spec.mjs` 导入 `metrics-snapshot.test.mjs`（字典版本与运行器一致性、来源约束、SKIPPED 结构）。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（CR 33 例含概率匹配阈值/复核队列/Chao/留一法；snapshot 4 例结构测试）；`scripts/metrics/metrics-snapshot.mjs` 在 `global_dev` 只读实跑（T1-008 55.0%、T1-009 65.7% SCHEMA_INVALID、T2-001 18.1%、T2-008 0.93/账户）；`node scripts/verify-docs.mjs` PASS；governance 全绿（含可达性）。
- 未做：固定权重非 EM（Splink 训练/latent class 属后续）；k>3 与 LCMCR 未实现；真实金标标注（PR-08 人工部分）未做；未动 frame 适配器/DB 迁移；未采购数据。

## 2026-11-09 · Two-phase channel run accounting preserves fetched pages on failure and adds PARTIAL status (#914)

- 起因：v3.0 第 6 章 CH-6 / CP-G7——渠道运行失败或取消时 workflow 拿不到 activity 的中间结果，`source_channel_run.pages_fetched` 一律落 0：日页帽被失败 run 系统性低估，首页失败之外的坏轮无法如实归因。
- 改动：
  - 迁移 `20261109140000_channel_run_dimensions`：`source_channel_run` 增加两段式落账与运行维度列（mode/manifest_sha256/plan_digest/requests/bytes_fetched/http_4xx/http_5xx/http_429/duration_ms/circuit_state/operator_note），status 词表加入 `PARTIAL`；历史 10 行 1 页试跑回填 `mode='preview'`。
  - `runChannelCrawl` 开始即写 RUNNING 行（crawl_run_id 幂等），逐页用 `GREATEST` 单调更新 `pages_fetched`/`requests`（进度写失败不阻断抓取）。
  - `finalizeChannelCrawl` 的 FAILED/取消分支以 RUNNING 行已记录的实际页数为准（不再写 0）；成功分支回填 mode/requests/duration 维度。
  - `PARTIAL` 语义：被页帽/日配额截断但已有产出时落 PARTIAL——不计失败率坏轮、按成功信号清零失败连击并刷新 last_success_at；recorder 的 finalize 重放判定改为「既有行非 RUNNING 才算重放」，两段式行首次收敛仍正常推进 streak。
- 测试：活动级（RUNNING 行、逐页进度、失败保留页数、PARTIAL 结局）、workflow（PARTIAL 透传）、recorder（RUNNING 非重放、PARTIAL 非坏轮+成功信号）、迁移静态契约与 schema 同步；一次性库重放 + Prisma drift 门见 PR。
- 未做：`bytes_fetched`/`http_4xx/5xx/429`/`circuit_state` 列已建但本波 crawl 路径无数据源（留给 api 渠道执行链 CH-5 回填）；未部署。

## 2026-11-09 · P3 J03 — 终判 judge 模型路由护栏（JUDGE_MODEL_ALLOWLIST、override 拒绝、启动自检、替换收紧） (#915)

- 起因：ch04 §4.3.3.6（D4-10）。线上实测 `MODEL_ACQUISITION_TASK_MODELS={"discovery.qualify_fit":"gemini-3.8-flash"}` 把 L2 深判钉在 flash 档，是「判定 45% 失败」的直接工程根因之一；judge 的模型身份必须有代码级护栏，而不是靠运维记得别写错 env。
- 改动：
  - 新增 `apps/api/src/ai-tasks/judge-model-routing.ts`（零依赖）：终判任务集合 `JUDGE_FINAL_VERDICT_TASK_IDS`（当前仅 `discovery.qualify_fit`）、pro 档白名单 `JUDGE_MODEL_ALLOWLIST`（deepseek-v4-pro / gemini-4-argon-high / gpt-5.6-sol）、`JUDGE_ALLOW_FLASH=true` 显式降档逃生口、`filterJudgeSubstitutes`（终判的模型身份替换只接受白名单目标，过滤为空即只收精确身份，fail closed）、`assertJudgeModelRouting`（启动自检）。
  - `task-registry.ts`：终判任务的非白名单 per-task override 被忽略、回落 tier 默认并留痕（`judgeModelOverrideRejections`，启动日志打印）；新增 `enforceJudgeModelRouting({mode})`。API（`main.ts`）与 worker（`temporal/worker.ts`）启动时调用：受控模式（pilot/production）下终判解析到白名单外模型即抛错不启动（fail-closed）；development/test 只告警（本地开发与 CI 契约导出/Nest 启动验证不因缺模型 env 而失败）。
  - `router-model-gateway.ts`：`acceptsModelSubstitute` 的部署级替换对终判任务先过 `filterJudgeSubstitutes`——`deepseek-v4-pro>deepseek-v4-flash` 这类同代理降档不再作用于最终 verdict；普通获客任务语义不变（D14 不变）。
- 测试：`judge-model-routing.spec.ts` 新增 12 例（集合/白名单快照、override 解析、替换过滤、自检四条路径）；`task-registry.spec.ts` 新增 3 例（flash override 被忽略并留痕、`JUDGE_ALLOW_FLASH=true` 放行、tier 本身是 flash 时自检失败）；`router-model-identity-substitution.spec.ts` 的替换主体改用非 judge 任务，并新增「judge 拒绝 flash 替换」与「仅 JUDGE_ALLOW_FLASH=true 放行」两例。
- 上线注意：发车后线上那条 `discovery.qualify_fit: gemini-3.8-flash` override 会被代码忽略并打 warn（深判回落到 reasoning tier）；运维应同步从运行 env 删除该键。若 reasoning tier 本身被配成 flash，进程会启动失败（刻意 fail-closed）。
- 未做：`discovery.quick_judge` / `discovery.qualify_fit` 双契约拆分与 `judge-output/v2` schema 换代（依赖技能目录与金标，和 J06 写入改造一起做）；`judgment_record.model_*` 三列落库（依赖 J04 建表 + J06 写入）。

## 2026-11-09 · Add the weekly and monthly report generator on top of metric observations (PR-15 template side) (#916)

- 起因：ch01 PR-15 要求周/月报按固定模板从指标实现生成；度量 API（PR-03/04）与源记分卡（PR-06）尚未接线，本波先交付只读模板侧，避免手写数字。
- 改动：
  - 新增 `scripts/metrics/report.mjs`：读取 `metrics-snapshot.mjs` 产出的 `metric-observation/v1`（支持多个 `--snapshot` 合并），按 ch01 §3.6.7 固定模板渲染周报/月报（北极星 → 覆盖 → 可触达 → 质量门 → 源 → 风险），月报额外含召回/金标与成本对账章节；未接线（recall/golden/PSI/cost）、不可测（T2-002/003/004/009 的 SKIPPED 原因）与缺失观测三种状态显式分列，n<30 自动加「样本不足」标记；输出 markdown + JSON（`--out` / `--out-json`）。
  - 新增 `docs/metrics/reporting.md`（节奏、命令、模板、写作纪律、与 PR-03/04/06 的接线关系）与真实快照生成的样例 `docs/metrics/report-samples/2026-11-09-weekly-sample.md`（VRIC=0、email 覆盖 18.1%、phone 1.0%、contacts/account 0.93；VALID 率与 catch-all 按设计显示不可测）。
  - `scripts/governance-contracts.spec.mjs` 导入 `report.test.mjs`（7 例：ISO 周标签、ALL 行选择、模板渲染、小样本标记、月报独有章节、缺失即缺失、确定性输出），使模板随 `docs:verify` 进 CI。
  - `docs/metrics/README.md` 门户与 `scripts/metrics/README.md` 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 report 7 例）；真实快照+渲染端到端实跑；`node scripts/verify-docs.mjs` PASS；governance 全绿。
- 未做：未改引擎 `report/weekly-report.service.ts`（依赖度量 API PR-03/04，且 CSV 外部形态保持不变的要求待接线时验证）；未做连续两周与一期月报的运营节奏（快照可用了，节奏由产品负责人启动）；未接 PSI/金标/成本。

## 2026-11-09 · P3 J04 — judgment quality tables v1 (migration + Prisma datamodel + RLS) (#917)

- 起因：ch04 判定质量（§4.3.2.8 / §4.3.4.2 / §4.3.7.3 / §4.3.8.1 / §4.3.8.3）的六张表只存在于设计稿，硬门结果、判定记录、conformal 阈值与人工复核队列都没有落库结构；判定质量工作流（J05+）无法接线。
- 改动：
  - 迁移 `20261109130000_judgment_quality_v1`：新建 `hard_gate_result`、`gate_enrichment_task`、`judgment_record`、`conformal_threshold`、`judgment_review_task`、`judgment_golden_label` 六表，含设计稿的 CHECK 约束、replay/查询索引与 workspace RLS。
  - `packages/db/prisma/schema.prisma`：新增六个 model（`@@map` 到表名）；`judgment_record` 对 `discovery_run`/`canonical_company`/`icp_definition` 建关系（run 为单列 FK `ON DELETE SET NULL`，修正设计稿复合 FK 与 SET NULL 的不可实现组合；company/icp 单列 FK `ON DELETE CASCADE`），三个既有 model 补反向关系数组。
  - 权限按状态机语义：`judgment_record`/`hard_gate_result`/`judgment_golden_label` append-only（app_user 仅 SELECT,INSERT）；`gate_enrichment_task`/`judgment_review_task` 可状态转移（SELECT,INSERT,UPDATE）；`conformal_threshold` 全局表不开 RLS、app_user 仅 SELECT。`docs/governance/app-user-table-privileges.json` 同步。
  - 4 条 Prisma 不可建模索引（2 个 COALESCE 表达式唯一索引、2 个部分索引）由迁移 SQL 实现；实测 Prisma 6.1 的 migrate diff 忽略这两类索引，故不登记 drift-baseline（否则触发 ratchet 的 STALE 判定），行为记入迁移头注释。
- 测试：`app-user-table-privileges.postgres.spec.ts` 新增六表负向用例——append-only 表 UPDATE/DELETE 42501、状态机表 DELETE 42501、跨 workspace SELECT 0 行、允许的写入通过且回滚、`conformal_threshold` INSERT 42501；漂移门与迁移 repeat-deploy 幂等验证通过。
- 未做：判定工作流写入路径（gates.ts / judgment-record.ts）与复核 API（J05/J06 批次）。

## 2026-11-09 · Extend the registry frame foundation — query contract, multi-source frame catalog, recall report v2 (#918)

- 起因：ch03 P2 第二波（#907 地基合入后的下一批卡片）——给「frame → 候选枚举」补上可执行的查询契约，把 frame 从 2 个样例扩到 4 个源形态（含 FR Sirene 的 `;` 分隔与 NAF 编码、US SAM 的嵌套 JSON），并让召回审计报告支持环比与 miss 归因（ch03 §3.9.12 / §3.17.4）。
- 改动：
  - `apps/api/src/registry/query.ts`：`registry_frame` filters 白名单校验（未知键拒绝、country ISO2、nace 前缀 2–4 位数字或 `28.13` 形式、规模带枚举、法定形式大小写不敏感、limit 默认 500 上限 2000）→ 参数化 Prisma 查询（固定 `ORDER BY scheme, reg_number`，只查 `withdrawn_at IS NULL` 且 last_snapshot 仍为 PARSED）→ `ProviderCompanyRecord` 映射（externalId `scheme:regNumber`、identifier、员工带中位数、licence/attributes.registry provenance）。
  - `scripts/frames/query-preview.mts`：查询契约的可运行入口（只读，`--database-url`/env），输出 rationale + filters + records。
  - 多 source 帧：新增 `fr_sirene`（INSEE stock 风格 CSV，`;` 分隔、NAF 28.13Z、trancheEffectifs 映射）与 `us_sam`（SAM.gov entityData 嵌套 JSON、UEI 主键、州入 region）两个帧配置与 fixture；`scripts/frames/frames/catalog.json` 登记全部 4 帧（frame-catalog.spec 强制覆盖与装载断言）。`frame-normalize` 的 NACE 校验扩展到国家派生码（`28.13Z`/`2813`）。
  - 召回审计 v2（`recall-audit.ts` + `recall-audit.mjs`）：结果新增 `missedKeys`；`--baseline` 环比（逐层 recall/domain_rate Δpp，|Δ|≥5pp 标 ⚠，缺层提示）；`--verdicts` miss 归因（Top-5 原因 + 未归因计数，防止 Top 原因掩盖裁决缺口）。
- 测试：vitest 100 项（query 契约 16 项 + catalog 装载 6 项 + 既有 78 项全部保持绿）；`node --test scripts/frames/recall-audit.spec.mjs` 7 项（含环比、归因、非法 baseline）；一次性库端到端：4 帧装载 13 实体后，FR/DE/US 的 filters 查询命中与排除行为符合口径，scratch 库已删。
- 未做：`registry_frame` 尚未注册为 discovery provider（T3-09：计划路由 + receipt + materialization 接线）；FR `diffusionCommerciale` 过滤与 NAF→NACE 全表映射（T3-05）；真实注册库接入与发车（不在本波）。

## 2026-11-09 · P3 J10 — 确定性聚合器 R0–R4 与证据校验（judge-aggregate/v1、evidence-validate/v1） (#919)

- 起因：ch04 §4.3.3.4（D4-4）——模型自报总分不可复现；最终 verdict 必须由确定性代码聚合，模型输出只保留 `verdict_proposed` 作诊断。
- 改动：
  - `apps/api/src/discovery/judgment/aggregate-judgment.ts`：纯函数 `aggregateJudgment`，按设计顺序执行 R0 反注入（证据命中页面内嵌指令 → 该 criterion 强制 unclear）、R1 硬失败（C1/C2 ≤2 且证据有效 → NOT_FIT，不被加权分救回）、R2 证据门（任何 applicable criterion unclear/无有效证据 → UNKNOWN）、R3 加权分（仅 applicable 项按权重重新归一）、R4 判定（≥7.0 且每项 ≥5 → FIT；≤3.5 → NOT_FIT；其余 UNKNOWN）。阈值来自 rubric 常量（`aggregationRulesSnapshot` 供单测对账），reason 为闭集 `JUDGMENT_REASON_CODES`。结构错误（重复/缺失 criterion、缺证据报告）直接抛错。
  - `evidence-validate.ts`：证据校验 `validateEvidence`（设计 §4.3.3.5）——URL 必须通过注入的域白名单/source_policy 门；span 必须去空白后逐字出现在本次输入快照；website/impressum 证据超过 30 天记 `EVIDENCE_STALE`；抓取时间非法 fail-closed；命中注入模式记 `PROMPT_INJECTION_DETECTED`。注册库/目录证据不参与新鲜度判定。
- 测试：`aggregate-judgment.spec.ts` 15 例 + `evidence-validate.spec.ts` 10 例——设计原文三个边界（C2=0 竞品 vs 其余 9 分、C1 unclear vs 其余 9 分、全 6–7 borderline）逐条落测；另覆盖硬失败需证据、注入、权重归一、score 缺失、全不适用、确定性、结构错误 fail-closed。
- 未做：conformal（R5，L4 工件）、门引擎（J05）与 `judgment_record` 写入（J06）、任务注册表接线（J03）。

## 2026-11-09 · Daily contact re-verification schedule reusing the sweep core (#920)

- 起因：P1-19 需要把存量邮箱重验队列（迁移回填的 UNKNOWN、VALID 90 天 TTL、catch-all 复检）从「人工 CLI」升级为周期任务；CLI 的取数/落库逻辑原先只在脚本里，Schedule 无法复用。
- 改动：
  - 再验证核心从 `apps/api/scripts/reverify-contact-points.mts` 提到 `apps/api/src/enrichment/verification/reverify-sweep.ts`（取点/suppression/合规门/限流/幂等/事件账/状态机全部同源），CLI 只留参数解析与单次执行；新增每轮成本上限 `maxCostMicrousd`（达到即停、候选保持 due）。
  - 新 Schedule `contact-reverify-sweep`（默认 24h，`CONTACT_REVERIFY_SWEEP_EVERY` 可调）+ `contactReverifySweepWorkflow` + `createContactReverifyActivities`（owner 连接，复用 sweep 核心；每轮 ≤500、供应商限流默认 2/s、成本上限默认 $5/轮）。
  - **注册即 paused**：启用是运维决定（`data_provider.millionverifier=ENABLED` + `MILLIONVERIFIER_API_KEY` + 成本 cap）；未启用时活动三重门任一不满足即返回 `skipped`、零调用零成本。已存在的 Schedule 只 reconcile action，不动暂停状态。
- 测试：活动边界 spec（kill switch / source_policy 未登记 / 凭据缺失 → skipped 零调用；门全过 → ran 且有界）；sweep 成本上限用例；ensure-schedules spec 更新为 13 个 Schedule 并断言新条目 24h + 默认 paused。
- 未做：翻转率周报指标（P1-17）；把本 Schedule 纳入平台预算 authority（启用时若需平台自动化预算，再按 P1-11 的 Grant 方案迁移）。

## 2026-11-09 · Add the offline read-only source scorecard with a reject-reason dictionary (PR-06 script side) (#921)

- 起因：ch01 PR-06 要求源记分卡能回答「每个源产出多少、拒了多少、为什么拒、值不值得留」；`source_scorecard_daily` 表与日任务依赖 PR-02/03，本波先交付只读离线版并把「目录 74% 拒收」拆成原因码。
- 改动：
  - 新增 `scripts/metrics/source-scorecard.mjs`：按 provider 聚合窗口内 raw/接受/拒收/隔离、`disposition_code` 原因拆分（对照字典，未登记码报 `UNKNOWN_DISPOSITION_CODE` 漂移信号）、全量公司归因（公司数/唯一贡献/有域名）、成本与新鲜度，输出 `source-scorecard-daily/v1` 行（含幂等 `contentHash`，供 PR-03 的 `(day, provider_key)` 主键落表）；混合 source_class 显式标记。
  - 新增 `docs/metrics/schemas/reject-reasons.v1.json`：9 个原因码的含义/owner/处置动作（来源 `raw-source-ingestion.ts` 与线上实际值）。
  - 新增 `docs/metrics/source-scorecard.md`（字段口径、用法、PR-06 验收对照）与真实基线证据 `docs/evidence/2026-11-09-source-scorecard.md`：directory 73.8% 被拒/隔离拆为 SCHEMA_INVALID 70.1% / POLICY_MISSING 26.6% / KEY_DRIFT 3.3%；public_web 接受率 91.8% 但隔离 267 条全为 key drift；5 个 provider 全部有读数；cost_per_valid_contact 因 VALID=0 显式不可算。
  - `source-scorecard.test.mjs`（6 例：聚合、原因拆分与 74% 断言、未知码漂移、混合 class、幂等哈希、空 provider）导入 governance-contracts，随 `docs:verify` 进 CI；门户与 metrics README 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿；`source-scorecard.mjs --days 30` 只读实跑；`verify-docs` PASS；governance 全绿。
- 未做：`source_scorecard_daily` 写入、看板/告警（PR-02/03）；成本与 provider 的映射（tool_budget_operation）；`precision_sample`（金标）；未触碰 `evals/golden-judgments/`（另一会话在建）。

## 2026-11-09 · P3 J11 — judge 金标清单 v1（15 例）与确定性 CI 校验 (#922)

- 起因：ch04 §4.3.10.1 层 D —— rubric/schema/聚合器已经冻结（J09/J10），但没有金标用例把「什么输入必须得到什么 verdict」钉死；没有它，任何 prompt/rubric 漂移都只能靠人眼发现。
- 改动：
  - `evals/golden-judgments/`：`manifest.json`（`golden-judgments/v1`，含 rubric/prompt/schema 身份与每例 fileSha256、inputDigest、split、expectedLabel、expectedReasonCodes）+ 15 个手写用例，覆盖 FIT 金样例、C1/C2 双硬门竞品、证据缺失/span 不匹配/过期/URL 拒绝、页面注入、borderline、低分 NOT_FIT、规模越界、模型拒答、全不适用、score 缺失、权重归一。
  - `scripts/validate-judgment-evals.mts`：零模型、零数据库的确定性校验——manifest 身份与代码常量（RUBRIC_VERSION/RUBRIC_SHA256/PROMPT_HASH/judge-output 版本）一致；fixture sha256 与 inputDigest 与 manifest 逐字一致；输出过 judge-output/v2 结构校验；证据校验 + 确定性聚合后的 verdict 与 reason 码与期望完全一致；锚点完整性与 required ensure 场景覆盖；PII（邮箱/电话）扫描。
  - `package.json`：`docs:verify` 追加该脚本（Copy 绑定文件已按流程重签），CI 的治理 job 每 PR 自动执行。
- 测试：本地 `pnpm exec tsx scripts/validate-judgment-evals.mts` 15/15 用例通过；故意改一个 case 的 expectedLabel 或 fixture sha256 会红（负向验证在实现时手工跑过）。
- 未做：金标真实标注集（J13，需双人标注与 kappa）、模型层跑分与 eval_receipt（J19）、conformal 数学单测（J15）。

## 2026-11-09 · Emailable as the second verification vote (#923)

- 起因：双正规则（单验证器永不判 VALID）需要第二家独立验证器；P1-04 的验证瀑布里 Emailable 是官方指定的「二次确认」票。
- 改动：
  - `apps/api/src/enrichment/verification/emailable.provider.ts`：`EmailableProvider`（GET `/v1/verify`，env 凭据，8s 超时，429/5xx/超时/畸形体统一降级 UNKNOWN 且不抛，$0.0076/条按事件账计费）。
  - 映射：`deliverable→VALID`（只有 `accept_all=false` 才判 VALID，缺字段保守进 catch-all 层）、`undeliverable/disposable→INVALID`、`risky→CATCH_ALL_RISKY·true_catch_all`（accept_all=true）或 `UNKNOWN`（否则，risky 不是地址级证据）、`unknown→UNKNOWN`（有效裁决、error=null、按次计费）；供应商自带 score 留痕到 detail，基础分用 scoreEmailPoint 统一口径。
  - `data_provider.emailable` seed（默认 DISABLED）+ `source_policy.api.emailable.com` 登记 + 治理 registry 条目与生成文档。
- 测试：假 HTTP 契约测试（缺凭据/200 deliverable/unknown/429/5xx/超时/畸形体、accept_all 三态、risky 分流、env 非法回退），零真实出网。
- 未做：Truelist enhanced catch-all 解析与 ZeroBounce 仲裁（P1-05）；把两家验证器编排成验证瀑布并接入再验证/发现路径（P1-06，当前 sweep 仍只走 MillionVerifier）。

## 2026-11-09 · Channel record watchlist — review status, sampling endpoint and rejection-rate disable (#924)

- 起因：v3.0 第 6 章 CH-7 / CP-G8——渠道产出直接进共享池，没有观察名单、没有人工抽检；手册要求「新渠道首 3 轮产出 PENDING、抽检 ≥20 条后才可批量并入正式池」，REJECTED 率 >20% 时渠道回 DISABLED。
- 改动：
  - 迁移 `20261109150000_channel_record_review`：`source_channel_record` 增 `review_status`（PENDING|APPROVED|REJECTED，默认 PENDING）、`reviewed_by`/`reviewed_at` 审计足迹与 `materialized_company_id` 引用位（跨租户口径未定，只留列不建外键）；三态审计一致性 CHECK；`(channel_id, review_status)` 索引。存量 48 行保持 PENDING（从未抽检，不伪造 APPROVED）。
  - 物化写入器：新观测 create 显式 `review_status=PENDING`；重复观测的 update 不改抽检结论（人工决定不被覆盖）。
  - `GET /source-channels/:id/records`：支持 `reviewStatus` 过滤并返回三态计数与审计字段。
  - `POST /source-channels/:id/records/review`（ops:write）：批量置 APPROVED/REJECTED；跨渠道/非法 id 拒绝；已抽检 ≥20 条且 REJECTED 率 >20% 时渠道回 `DISABLED(reason=GOVERNANCE)` 并写健康事件（detail.reason=RECORD_REJECTION_RATE）。
- 测试：物化写入器（PENDING/不覆盖）、抽检服务（审计字段、过滤与计数、20 条与 20% 双阈值、非法输入）、迁移静态契约、authz 矩阵与 operation 描述。
- 未做：「并入正式池」（写 materialized_company_id + companyChannelSighting）因平台渠道记录到租户公司的跨租户口径未定，留待产品拍板后单独卡片；未部署。

## 2026-11-09 · P3 J02 pipeline failure attribution — typed codes replace the aggregate, quickScan heartbeat/cancel (#925)

- 起因：公司级深挖管线的 351 条 failed 全部写同一个 `COMPANY_PIPELINE_FAILED`（2026-11-08 只读审计：`last_error_code` 100% 聚合码），抓取失败、模型 429、预算截断、Temporal 超时无法区分；快扫活动 `quickJudgeBatch` 无心跳、无取消检查（实测 27.8 分钟超出 15 分钟 startToClose），批量/逐家失败也只写 `QUICK_JUDGE_FAILED`（设计 §4.3.5.1 / §4.3.9 W1/W2/W4，P3 J02）。
- 改动：
  - 新增 workflow 安全的纯函数分类器 `apps/api/src/temporal/pipeline-failure-taxonomy.ts`：沿 `ActivityFailure → ApplicationFailure/TimeoutFailure → cause` 链按 name/type/code/reasonCode/message-token 解析（不做自由文本 regex），映射 ProviderHttpError（429/402/401·403/5xx）、ProviderOutputError（NOT_JSON/TRUNCATED/SCHEMA_INVALID/ENUM_DRIFT/MODEL_REFUSAL）、ProviderIdentityError、ProviderTransportError、预算/控制面（`isExecutionControlError` 同款 control token：预算 → BUDGET_*、域 ACK/回执/围栏 → CONTROL_PLANE_REJECTED、租约 → LEASE_LOST）、SkillUnavailableError、Prisma P2034/P2028、Temporal 超时、EgressBlockedError；未知一律 `UNKNOWN_UPSTREAM`。
  - 新增活动边界包装 `apps/api/src/temporal/pipeline-failure-activity.ts`：worker 的 `DiagnosticFailureConverter` 会把普通 Error 的类名/消息全部脱敏（只剩 `applicationFailureInfo.type` 能过 Temporal 边界），故 `profileCompanyOnce`/`fitCompanyOnce`/`signalsCompanyOnce`/`contactsCompanyOnce` 统一把异常换成 `ApplicationFailure(type=<failure code>)`（保持 retryable，不改变现有重试次数；nonRetryable 矩阵留给 J22）。
  - 失败码表升 `failure-codes/v2`，新增 `PROVIDER_IDENTITY_MISMATCH`、`PROVIDER_TRANSPORT_FAILED`、`CONTROL_PLANE_REJECTED`（同步 `failure-codes.spec.ts` 快照与重试语义）。
  - workflow catch 用分类结果写 `mark('failed', { errorCode, failureStage })`；`updateCompanyJobStage` 扩展 `failureStage` 并写进 `run_event.payload`（不新增 DB 列/迁移），`last_error_code` 保持写具体码；`DEEP_STOPPED` 取消路径不变。
  - W4：`quickJudgeBatch` 活动开始与每批后 `heartbeat()`（池 500 家 × 8 家/批），批间检查 `cancellationSignal.aborted` 并抛 `CancelledFailure`；批量协议与逐家判定失败按分类码写 `last_error_code`/事件/轨迹，规则兜底的 `company_done` 事件附 `failureCode/failureStage`；`discovery.workflow.ts` 为快扫单独配置 `quickScanActs`（heartbeatTimeout 10 分钟，修 27.8 分钟 > 15 分钟 startToClose 的既有缺陷）。
- 测试：新增 `pipeline-failure-taxonomy.spec.ts`（映射表 100% 可达 + ActivityFailure/TimeoutFailure/普通 Error/控制面/未知/循环 cause 共 12 例）、`pipeline-failure-activity.spec.ts`（包装、取消透传、ApplicationFailure 保留）、`pipeline-failure-wiring.source.spec.ts`（聚合码字面量不得回归）；扩展 `discovery.run2.pipeline.workflow.spec.ts`（具体码 + stage、控制面不落 provider）、`discovery.run2.activities.spec.ts`（心跳次数、批间取消、逐家/批量失败码）；`discovery-workflow-knobs.replay.spec.ts` 5 例 replay 通过（heartbeatTimeout 不影响历史重放）；零容器全量单测与 `gctl check --fast` 全绿。
- 未做：按码收紧的 Temporal `nonRetryableErrorTypes` 重试矩阵与 failover 策略（J22）；`ProviderSettlementError`（MODEL_SETTLEMENT_*）暂按 `UNKNOWN_UPSTREAM` 显性上报、无专属码；`fit-judge.ts` 内部吞掉的模型错误（返回 null → 规则兜底）仍无法带出原始 cause，只能按批量失败码归因。

## 2026-11-09 · Add the zero-model golden replay runner with G1/G2/G3 gates and a mutation-tested demo set (PR-07 script side) (#926)

- 起因：ch01 PR-07 要求金标 runner 能装载/求值/做 diff/被变异测试打红；引擎侧 `apps/api/src/measurement/golden/` 与 `golden_eval_run` 落表依赖 PR-02/04，本波先交付零模型的 replay 脚本实现。
- 改动：
  - 新增 `scripts/metrics/golden-run.mjs`：读取 `evals/golden-discovery/` 目录契约（items=golden-item/v1、labels=golden-label/v1 且必须 adjudicated=true、predictions=冻结快照），计算逐字段 accuracy/precision/recall/Cohen's κ/混淆矩阵；执行 G1 绝对门（fit precision ≥0.80 / recall ≥0.75）、G3 字段门（domain_correct、is_company ≥0.95；email valid precision ≥0.95）与 G2 相对门（较 `--baseline` 任一指标跌 >2pp 判红）；缺字段记 SKIP；输出 `golden-run/v1`（metrics/gates/diff/sampleSha256/items）+ markdown，失败退出码非零；未裁决标签与未登记标签字段直接拒绝。
  - 新增合成演示夹具 `evals/golden-discovery/fixtures/replay-demo/`（4 条，无真实 PII），同时作为变异测试基准。
  - 新增 `scripts/metrics/golden-run.test.mjs`（8 例：demo 全过、κ 教科书算例、两处变异必红、未裁决/未知字段拒绝、G2 相对门、diff、确定性），导入 governance-contracts 随 `docs:verify` 进 CI；`evals/golden-discovery/README.md` 增 replay 用法与契约；门户与 metrics README 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 8 例）；demo replay 实跑 PASS；`verify-docs` PASS；governance 全绿。
- 未做：引擎 `apps/api/src/measurement/golden/` 模块与 `golden_eval_run` 落表（依赖 PR-02/04）；`--live` 模式（需规划/判定流水线）；真实金标标注（PR-08 人工）；未触碰 `evals/golden-judgments/`（J11 在建）。

## 2026-11-09 · Register registry_frame as a discovery provider (routing surface only; execution awaits the local_query lineage design) (#927)

- 起因：ch03 T3-09——把本地注册库 frame 枚举（`registry_entity` 平台表 + `registry/query.ts` 契约）注册进 discovery 的 provider/路由面。执行面撞上 2026-11-08 收紧的 governed-lineage 契约：零出网本地查询无物理调用可出 durable 回执，按现行契约无法通过物化准入，需要单独的架构批准。
- 改动：
  - `apps/api/src/discovery/providers/registry-frame.provider.ts`：`registry_frame` 适配器（`company_registry` 类），把计划 filters 白名单映射到本地查询并返回 `ProviderCompanyRecord`（成本恒 0）；**刻意不声明 `companyResultLineage`**，因此被路由闸门恒排除（计划期计 `SOURCE_LINEAGE_UNAVAILABLE`）——这是预期行为，由单测钉死。
  - 注册与路由面：`provider-source-classes.json` 增 `registry_frame → company_registry`；`provider.registry.ts` 注册适配器 + seed `data_provider`（`registry_frame`，DISABLED，成本 0，第二道 kill switch）；`plan-query-sources.ts` 路由优先级 5（零出网第一优先）与 planner guide 条目；`MAX_COMPANY_DISCOVERY_ADAPTERS` 7→8（技术报价上界随注册面同步，既有 envelope 断言更新）。
  - 治理登记：`docs/governance/provider-registry.json` 新增条目（PARTIAL、default DISABLED、`governed_lineage_pending_local_query` gate）并重生成 `docs/backend/provider-registry.md`。
  - 书面设计（待产品负责人拍板，未施工）：`docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md`——local_query 血缘变体（`registry.query` producer、resultDigest 定义、回放/审计语义、增量改动清单、风险与回退）。
- 测试：新增适配器 spec（无库诚实空、filters 映射、成本 0、非法 filters fail-safe）与注册/路由断言（注册但不可路由、seed DISABLED、计划期 `SOURCE_LINEAGE_UNAVAILABLE` 钉死、cheap-first 裁剪时 registry_frame 副本优先于 wikidata）；技术报价 envelope spec 按适配器 8 更新（fit 判定上界 11,550→13,200 家/run、requiredCap 559,798→625,798 cents）。`pnpm governance:verify` 通过（23 providers）。
- 未做：执行面接线（等 local_query 设计获批）；ICP 行业词→NACE 前缀映射（T3-05）；本波不碰 Copy 绑定文件、无迁移、未发车。

## 2026-11-09 · Run the golden replay CLI as a CI smoke gate on every docs:verify pass (PR-09 precursor) (#928)

- 起因：ch01 PR-09 要求金标回归能在 CI 判红；真正的路径触发与夜间跑批依赖度量 API（PR-04）与真实金标（PR-08），本波先把「零模型 replay 链路」做成每次 CI 必跑的冒烟门。
- 改动：
  - 新增 `scripts/metrics/golden-ci-smoke.test.mjs`：以真实子进程执行 `golden-run.mjs`——demo 集必须退出 0 且 `passed=true`；同集的变异副本（改坏 `is_company`）必须退出 1 且 `G3_is_company` 判红；`--out` 落盘产物必须是合法 `golden-run/v1`。
  - 该测试导入 `scripts/governance-contracts.spec.mjs`，随 `docs:verify` 在每次 PR 的 governance 检查中运行（3 例，约 1 秒）；`evals/golden-discovery/README.md` 增补说明。
- 测试：`node --test scripts/metrics/golden-ci-smoke.test.mjs` 3/3；governance 472/472；`verify-docs` PASS；本地 pre-push 门按既定处理跳过（`GLOBAL_SKIP_PREPUSH=1`，gitleaks 照常）。
- 未做：路径触发（改 prompt/skill/判定代码才跑真实金标）、夜间 live 跑批、真实金标目录接入（待 PR-08 标注与 PR-04 API）；未触碰 `evals/golden-judgments/`。

## 2026-11-09 · P3 J17 — 人工复核队列 API、优先级/SLA 与结论回流 (#929)

- 起因：ch04 §4.3.8 —— UNKNOWN/borderline 只能靠人判，但没有队列就没有 SLO、没有回流、没有 overturn 度量；J04 已建好 `judgment_review_task`/`judgment_golden_label` 两张表，本卡把队列跑起来。
- 改动：
  - `apps/api/src/discovery/judgment/review-queue.ts`：优先级公式（UNKNOWN/CONFORMAL_ABSTAIN 高价值=P0，其余 UNKNOWN/BORDERLINE=P1，RANDOM_AUDIT=P2，DRIFT_AUDIT/APPEAL=P3）与 SLA（24h/72h/120h/168h）；`enqueueReviewTask`（同 record+reason 幂等）；`listReviewTasks`（priority/dueAt/id 升序、keyset 游标、含公司名与判定）；`claimReviewTask`（queued→in_review，同人幂等）；`resolveReviewTask`（单事务：状态校验 → 写新 `judgment_record`（`model_requested='human'`、`prompt_hash=sha256('human-judgment/v1')`、attempt+1、criteria 支持人工覆写）→ 回流 `judgment_golden_label`（split=candidate、 annotatorHash 只存稳定哈希）→ 任务 resolved）；`judgmentReviewStats`（状态/原因/优先级分布 + overturn rate）。
  - `judgment-review.controller.ts`：`GET /api/v1/judgment-reviews`、`POST :id/claim`、`POST :id/resolve`（acquisition:review）、`GET /api/v1/judgments/:id`（acquisition:read）、`GET /api/v1/judgments/stats`；typed 错误映射 404/409/400。
  - `packages/db/test/judgment-review-queue.rls.spec.mjs` + ci-manifest service 组：真库生命周期（enqueue→list→claim→resolve→stats、同人认领幂等、重复 resolve 拒绝、跨租户不可见）。
- 测试：`review-queue.spec.ts` 6 例纯函数单测；库上 spec 由 service 组在 CI 执行；OpenAPI 已重导出。
- 未做：`upsertLeadFit` Lead 投影（留给 J06 与 record 写入一起接，避免两处映射）、P0 24h SLA 报表（ops 报表，J16/J20 一并做）、BFF/gain-saas 运营台页面。

## 2026-11-09 · Add the measurement core tables — metric definition, observation and daily/weekly rollups (ch01 PR-02, held for a schema window) (#930)

- 起因：ch01 PR-02 要求把指标字典、观测与日/周聚合落成数据库表，作为度量工作流（PR-03）与 API（PR-04）的地基；本次只做四表迁移与权限，不接线任何运行时。
- 改动：
  - 迁移 `20261109160000_measurement_core_v1`：`metric_definition`（平台工件，唯一 `(metric_id, version)`，状态/层级/版本 CHECK）、`metric_observation`（append-only，`workspace_id IS NULL` = 平台级，身份唯一键含 computation_hash）、`metric_rollup_daily` / `metric_rollup_weekly`（物化聚合，主键含 stratum_key）。RLS：observation 按 `workspace_id`；rollup 两表按 `stratum->>'workspace_id'` 表达式 + 表达式索引；平台行对租户不可见。权限：字典只读；observation 仅 SELECT/INSERT；rollup 可 SELECT/INSERT/UPDATE（upsert），DELETE 一律拒绝。
  - Prisma datamodel 四模型同步（`packages/db/prisma/schema.prisma`），与迁移逐列对齐；有意差异：Prisma 不支持 Json 进主键/唯一键，改用并列的 `stratum_key`（排序键规范化 JSON 文本，应用层写入）；数值列 NUMERIC(20,6) ↔ Decimal(20,6)。
  - 权限清单 `docs/governance/app-user-table-privileges.json` 增四表；`app-user-table-privileges.postgres.spec.ts` 增「measurement core tables」负向块（RLS 隔离、跨 workspace 与平台行拒绝、append-only、rollup upsert/拒删、字典只读）。
  - Copy 固定源回执重签（schema.prisma 属 Copy 绑定文件；仅哈希位移，资格状态保持 main 既有的 STALE_HOLD）。
- 测试：一次性 pgvector Postgres 容器全量回放 200+ 迁移通过（含本迁移）；RLS/权限探针实测（自己的 workspace 可见、他人 0 行；平台行与跨租户写入被 RLS 拒；observation UPDATE/DELETE 与 rollup DELETE 被 42501 拒；rollup upsert 生效；字典 INSERT 拒、SELECT 允许）。
- 未做：不接线工作流/API/事件（PR-03/04）；不部署不发车；**本 PR 按协调要求在「schema 窗口」通知前不合并**（届时按当时 main 重签 Copy 回执再合）。

## 2026-11-09 · Add the L0 hard-gate engine with idempotent gate-result writes (#931)

- 起因：P3 判定质量 J05——把「没资格被判定」与「判定为不是目标」分开记账；池噪声 34.8% 与「77% match 无域名」的结构性来源是缺失数据被当成中性分。
- 改动：
  - 新增 `apps/api/src/discovery/judgment/gates.ts`：门引擎与决策表纯函数——G1 制裁（新鲜度四态 fresh/yellow/red/not_screened，72h/7d 阈值）、G2 禁联 + ICP 排除（镜像 EXCLUSION 只记录不排除）、G3 国家（ISO 归一 + DACH 地区词展开）、G4 规模（点值 / band 区间）、G5 域名/可验证性（无域名或 DEAD → UNKNOWN 进补数队列，不进 LLM judge）；门集与每门均带版本（`gates-v1`）。
  - `evaluateGates(tx, ctx)` 是写入门结果的唯一入口：G1→G5 短路语义（FAIL 短路、UNKNOWN 继续）、逐门写 `hard_gate_result`（表达式唯一索引 replay 键 + `skipDuplicates` 幂等）、UNKNOWN 的 G3/G4/G5 写 `gate_enrichment_task(queued)`；reason_code 走 `GATE_REASON_CODES` 闭集校验（未登记即抛错 fail-closed）。
  - 新增 `apps/api/src/discovery/judgment/gates.spec.ts`：每门 × PASS/FAIL/UNKNOWN/NOT_APPLICABLE 决策表、G1 四态与阈值边界、短路顺序、replay 幂等、闭集校验、同输入同 digest 确定性。
- 测试：`APP_DATABASE_URL= pnpm --filter @global/api test`（零容器）；`gctl check --fast`。
- 未做：G6 自指 / G7 存活 / G8 行业排除（设计 §4.3.2.7 第二批）；W8 的 `sanctions-gate.ts` 接线与 `freshness()` 改造留给 J07；快扫 G5 前置（W9）与 judge 路径接线留给 J07；连续 >14 天的 `SANCTIONS_HARD_STOP` env 熔断按本卡「不用 env」暂未实现。

## 2026-11-09 · Verification waterfall — primary, second vote, arbitration with per-address budgets (#932)

- 起因：P1-06——即便两家验证器 key 都到位，再验证链路也只用一家，双正规则永远凑不齐、VALID 永远是 0。验证瀑布（主验→二次确认→仲裁）是 ch02 的出口判据（G2 ≥35%）的直接前置。
- 改动：
  - `apps/api/src/enrichment/verification/verification-waterfall.ts`：provider 无关的编排——主验 invalid 立即停（强否定）；主验 catch_all/unknown 停（解析器未接入前不烧第二票）；主验 VALID 才调二次确认（双正）；前两票未收敛（1:1 冲突 / valid+risky）且存在仲裁者时调第三家。每地址 ≤6 次调用、成本上限、`beforeCall` 限流挂点，返回逐步结果供事件账逐行落账。
  - `provider-pool.ts`：按固定顺序返回凭据已配置的验证器（MillionVerifier → Emailable），kill switch 仍由调用方逐家过 `checkProviderGates`。
  - 再验证核心 `runReverifySweep` 改为接收 provider 列表并走瀑布：逐 provider 幂等预查（崩溃恢复只补跑缺失的那家）、每步一行事件账（原始裁决/成本/延迟）、点状态用投票矩阵的最终结果推进（INVALID 清空 catch-all、UNKNOWN 不动既有分类）。
  - CLI 与 Schedule activity 均构建验证器池并逐家过门；无可用验证器时 CLI 拒绝、activity 返回 skipped（零调用）。
- 测试：瀑布 14 条（双正 VALID、单票 UNKNOWN、invalid 即停、catch_all/unknown 即停、provider_error 不换家、accept_all 优先、仲裁 2:1 与冲突、maxCalls/成本上限、beforeCall 次数、原始裁决→事件词表）；池 4 条；sweep/activity 单测全部迁移到 provider 列表语义（83 用例全绿）。
- 未做：Truelist enhanced（catch-all 解析器）与 ZeroBounce 适配器（瀑布的第三位已留好，接入后无需改编排）；`contact-eligibility` 发送门（P1-16）。

## 2026-11-09 · Add the deterministic ICP-industry to NACE mapping and per-frame source attributes (ch03 T3-05 subset) (#933)

- 起因：ch03 T3-05——registry 查询要按 ICP 行业真正过滤，需要把行业自由词与 taxonomy 的 ISIC 码确定性映射到 NACE 前缀；FR Sirene 的 `diffusionCommerciale=false`（当事人反对商业推介）必须在装载时采集并随候选记录流到下游触达过滤。
- 改动：
  - `apps/api/src/registry/industry-map.ts`：`canonicalNace`（NAF `28.13Z`/无点号 `2813` → NACE 类目 `28.13`）、`nacePrefixesForIndustryTerms`（复用 `ISIC_SEED` 别名+`crosswalks.nace` 做中/英/德词面匹配，CJK 子串与 ≥4 字符拉丁子串覆盖德语复合词）、`nacePrefixesForIsicCodes`（taxonomy 注入的 ISIC 码直查交叉表）、`resolveNacePrefixes`（显式 nace_prefix > 行业词 > ISIC 码）。ISIC seed 的 C28 节点补 `valve/valves/阀门/工业阀门/ventil(e)` 别名。
  - 装载器：`mapping.fields.attributes`（name → 指针，≤10 项校验）把源特有属性写入 `registry_entity.attributes`（排序存储、纳入 contentHash 与 diff）；`mapping.constants.naceVersion` 常量兜底；NACE 装载时归一（FR fixture 的 `28.13Z` → `28.13`，原始码可从源快照回放）。
  - `registry/query.ts`：候选记录带 `attributes.registry.sourceAttributes`（如 `diffusionCommerciale: 'false'`），查询层不做隐式过滤，语义留给下游触达过滤消费。
  - `registry-frame` provider 适配器：无显式 nace_prefix 时用 industry 自由词 / `_industryCodes` 做确定性映射（此前刻意透传为空）。
  - FR 帧 fixture/config：新增 `diffusionCommerciale` 列与 attributes 映射、`naceVersion: NAF-rev2`。
- 测试：`industry-map.spec`（归一变体/中英德词面/ISIC 交叉/优先级/不可用输入）；装载器 spec（属性采集与 contentHash 敏感性、naceVersion 常量、NACE 归一、attributes 配置校验负向）；catalog 与适配器 spec 更新（FR 行断言 `28.13`/`NAF-rev2`/`diffusionCommerciale` 透传；industry 词映射 OR 谓词、显式前缀优先）。registry + 适配器 12 文件 118 项全绿；build 通过。
- 未做：查询/物化层的 diffusion 硬过滤（列级谓词与 P4 抑制联动，留在执行面/投影卡片）；`full NAF→NACE` 官方对照表（当前确定性口径：剥国家后缀 + 2 位部门近似）；不碰 Copy 绑定文件、无迁移、未发车。

## 2026-11-09 · P3 J06（第一批）— 判定记录唯一写入入口与 replay 幂等 (#934)

- 起因：ch04 §4.3.4.4 —— 判定记录必须一次尝试一行、append-only、可复算；写入语义（replay key、同输入重试不翻行、冲突显式报错）必须有唯一实现，否则每个调用点都会各写一份。
- 改动：
  - `apps/api/src/discovery/judgment/judgment-record.ts`：`recordJudgment(tx, input)` 唯一写入入口——闭集校验（verdict/judgeLevel/label/数域/64 位 hex 摘要）、失败码经 `failure-codes.ts` 派生 `stage/cause/outcome/retryable`、`createMany(skipDuplicates)` 依赖迁移中的 replay 唯一键实现 INSERT…ON CONFLICT DO NOTHING；同输入不同 verdict → `JUDGMENT_RECORD_REPLAY_CONFLICT`（绝不静默覆盖）。配套纯函数：`judgmentInputDigest`/`judgmentOutputDigest`/`collectEvidenceRefs`/`buildRecordedCriteria`。
  - `packages/db/test/judgment-record.rls.spec.mjs`（db-tests service 组）：真库验证「新写入→同 attempt 重试不翻行→冲突 verdict 抛错→新 attempt 追加」与失败码派生列。
- 测试：`judgment-record.spec.ts` 8 例纯函数/校验/replay 单测；库上 spec 2 例；`gctl check --fast` 全绿。
- 未做：`fit-judge.ts` 的 shadow 接线（等 J03b 双契约拆分后，把 judge-output/v2 + 聚合器 + 本写入器 + `upsertLeadFit` 串成一个事务）；模型层金标跑分（J13/J19）。

## 2026-11-09 · Add the measurement rollup workflow — first ten metrics into metric_observation plus daily and weekly rollups (ch01 PR-03) (#935)

- 起因：ch01 PR-03 要在 PR-02 的四表上跑通「采集 → 观测 → 日/周聚合」，让指标第一次以带窗口与哈希的 append-only 观测入库；本切片不接调度（平台 Schedule 属运维窗口），提供工作流 + 活动 + 本地运行/回填命令。
- 改动：
  - `apps/api/src/measurement/metric-queries.ts`：首批 10 个指标的只读 SQL（T0-001/002、T1-008/009、T2-001/005/007/008 实现；T2-002/009 登记并显式 skipReason）；窗口语义 snapshot=目标日、rolling 7d=[dayStart-6d, dayEnd]，SQL 只出计数，CI 在 TS 计算。
  - `apps/api/src/measurement/rollup.ts`（纯函数）：stratum_key 规范 JSON、computation_hash、Wilson 区间、参数化 bootstrap（比率型计数，固定 seed）、最近观测挑选、日/周 rollup 行构建；`rollup.spec.ts` 11 例。
  - `apps/api/src/measurement/run.ts`：按日运行——逐指标查询→构建观测→`INSERT … ON CONFLICT ON CONSTRAINT metric_observation_identity_key DO NOTHING`→日/周 rollup upsert（DISTINCT ON 取每 stratum 最新观测）；owner 连接作为平台级服务写者；`run.spec.ts` 5 例（含跳过语义与调用计数）。
  - `apps/api/src/temporal/measurement.workflow.ts` + `measurement.activities.ts`：`measurementRollupWorkflow({day})`，15 分钟活动超时、3 次重试；worker 注册（`createMeasurementActivities({ ownerDb })`）并由 `customer-workflows` 导出；`measurement.workflow.spec.ts` 2 例（含非法日期非重试失败）。
  - `apps/api/scripts/measurement-rollup.mts`：默认 UTC 昨天，`--day` 单日，`--backfill-days N` 逐日回填（与实时同实现，幂等）。
  - `docs/metrics/rollup-workflow.md` 说明指标表、幂等/迟到口径、运行命令、调度待运维窗口与 PR-04 衔接。
- 测试：SQL 形状在 `global_dev` 只读复核（T0-001 403/0、T2-001 403/73、T1-009 三原因与分母一致）；本地无完整 node_modules，vitest 由 CI 执行；`verify-docs` 本地 PASS。
- 未做：每日 Temporal Schedule 注册（平台执行合同/运维窗口）；PR-04 API 与看板；T2-002/009 的自动纳管（等分母）；未触碰 Copy 绑定文件与 `evals/golden-judgments/`。

## 2026-11-09 · Add the frozen-frame export for recall audits; record the T3-19 vs PR-06 scorecard overlap assessment (#936)

- 起因：P2 看板先做 T3-19 对比评估——P0 的 PR-06 源记分卡（`scripts/metrics/source-scorecard.mjs`，raw_source_record 数据面、日粒度、8 指标中 5 项已实现）与本卡的 registry 记分卡在**能力形态上重叠 ≈60–70%（>50% 阈值）、可复用代码≈0、registry 侧当前可计算的差异化指标为 0**（域名解析/金标精度/多帧边际增益均未落地）。按规则转 T3-20 Tier A 审计导出骨架；评估记录见 `docs/superpowers/plans/2026-11-09-t3-19-scorecard-overlap-assessment.md`（T3-19 后续建议：扩展 ch01 记分卡家族而非另立并行子系统）。
- 改动：
  - `apps/api/src/registry/recall-frame-export.ts`：`buildRecallFrameExport`——把某 frame 快照的冻结实体集（`last_snapshot_id = snapshot.id` 且未退出）规范排序 + 行级校验 + 逐行 JSON 的 sha256，产出 `recall-frame-export/v1`（manifest：frameKey/snapshotId/sha256/rowCount/exportedAt）。输入乱序不影响哈希；重复业务键/空必填字段 fail-closed。
  - `scripts/frames/recall-frame-export.mts`：只读导出 CLI（默认取最近 PARSED 快照，可指定 snapshot；DATABASE_URL 缺省读 packages/db/.env），产物直接作为 `recall-audit.mjs --frame` 输入；报告记录 snapshotId+sha256+seed 即可完整复算。
  - README 审计流程补「冻结 frame → 抽样输入」一段；产物池导出明确挂起等执行面（local_query 血缘获批）。
- 测试：`recall-frame-export.spec`（确定性哈希/空白归一/变更敏感/重复键与空字段负向/导出→auditRecall 直连可复算）；registry 全组 12 文件 119 项全绿；真库端到端：一次性库迁移 → 装载 FR 帧（3 实体）→ 导出冻结集（manifest sha256 + snapshotId）→ 跑审计 CLI 得到分层报告（FR:28:1-9/10-49/250+，found 2/3），库已删。
- 未做：产物池（run 侧）导出与 Temporal 审计工作流（等执行面）；运营台下钻页（P5）；不碰 Copy 绑定文件、无迁移、未发车。

## 2026-11-09 · Single contact_point writer enforced by an architecture guard (#937)

- 起因：P1-02 收尾——四态落地后仍有三处（联系人发现 / 邮箱猜测 / 验证回写）各自直写 `contact_point`；四态列、legacy status 投影、`valid_since` 等价约束、catch-all 子类与验证事件账是一个不变量集合，三路各写各的必然分叉（历史上已出现 RISKY 清 verifiedAt、状态与事件账不一致）。
- 改动：
  - 新增 `apps/api/src/discovery/contact-point-writer.ts` 作为唯一写入器：`upsertObservedContactPoint`（发现，首见优先）、`upsertGuessedEmailPoint`（猜测，含四态列与保守降级）、`setEmailPointState`（HTTP verify 与再验证 sweep 共用的状态机回写，含 `dispositionOnly` 的 BLOCKED 处置）、`linkLastVerificationEvent`。
  - 三处调用点与管理服务、再验证 sweep 全部改走写入器；行为与载荷逐字段保持原样（现有 215 个相关用例不改断言即全绿）。
  - 新增架构守卫 `contact-point-writer.guard.spec.ts`：扫描 `apps/api/src/**`（排除测试与写入器自身），任何 `contactPoint.create/upsert/update/updateMany/createMany/delete/deleteMany(` 或原生 SQL 写入 `contact_point` 都会失败并打印迁移指引；守卫自身带正/负例，防止空转。
- 测试：写入器守卫 3 条（无直写、匹配器正负例、写入器原语存在）；受影响 19 个 spec 文件 215 用例全绿；build/lint 通过。
- 未做：读侧迁到 `verification_state`（读投影仍用 `status`）；`phone_type` 写入方（P1-14）。

## 2026-11-09 · Gateway tool-call transport — generateChatWithTools over OpenAI chat completions (#938)

- 起因：v3.0 第 6 章 WEB-1——模型联网工具环的传输层缺失：`ModelGateway` 只有单发方法，chat-completions 传输把 `finish_reason=tool_calls` 当错误（`CHAT_COMPLETIONS_TOOL_CALL_UNEXPECTED`），模型无法请求平台执行工具。
- 改动：
  - `types.ts`：封闭消息模型（system/user/assistant(toolUses)/tool 四角色，第三方内容只能进 tool 消息）、`ChatToolDefinition`/`ChatToolUse`/`GenerateChatWithToolsInput`/`ChatResponse`；`ModelOp` 增加 `generateChatWithTools`。
  - `ModelGateway`：默认**实例方法** fail-closed（`CHAT_WITH_TOOLS_UNSUPPORTED`；不是类属性，避免 useDefineForClassFields 遮蔽子类实现）。
  - `RouterModelGateway`：新 `generateChatWithTools` 走既有 run()（预算 reserve-then-settle、身份门、风控订阅）；`messages`/`tools` 参与预算幂等键与持久路径的 prompt 字节估算；provider 包装器透传并按 `noted` 记录模型替换。**平台出网上下文（platformEgress）下该 op 一律 fail-closed**（`CHAT_WITH_TOOLS_PLATFORM_EGRESS_UNSUPPORTED`）——R4 围栏的 modelOp 白名单属于平台执行合同，扩列需平台策略版本，工具环任务按设计走客户侧运行。
  - `OpenAICompatibleProvider`：对 openai-chat-completions 传输实现 `generateChatWithTools`（`tools`/`tool_choice:auto`、assistant tool_use 回放为 tool_calls、tool 结果按 `tool_call_id` 回传）；`finish_reason=tool_calls` 正常解析，参数非 JSON / 名字非法 / 缺失 tool_calls 均按**可计费失败**（ProviderOutputError 带 usage）上报；非该传输明确 `CHAT_WITH_TOOLS_TRANSPORT_UNSUPPORTED`；v1 非流式。
- 测试：provider 7 例（解析/回放/stop/length/坏参数/缺 tool_calls/content_filter/传输拒绝）、路由器与默认网关 6 例（fail-closed、透传、无实现不兜底、路由链为空、预算键随对话变化、平台出网拒绝）；model-gateway 全目录 509 例保持全绿。
- 未做：真实 wire 一次 tool_calls 往返（属付费调用，等产品负责人费用授权）；Anthropic Messages 传输的 tool_use；流式 tool_calls 增量拼装；工具环本体（hop/预算/超时/注入防护）为 WEB-2+。未部署。

## 2026-11-09 · P3 J03b — judge 双契约拆分（discovery.quick_judge）与 judge-output/v2 生产接线（JUDGE_CONTRACT_MODE，默认 off） (#939)

- 起因：ch04 §4.3.3.6（W5）与 §4.3.9 W3。L1 快扫与 L2 深判共用 `discovery.qualify_fit`，一条 task 级 override 会同时改写深判模型；L2 深判仍直接取模型自报 verdict，未经 criterion 级证据校验与确定性聚合。
- 改动：
  - 契约拆分（Part A，行为保持）：新增 `discovery.quick_judge`（flash 档、批量 judgments 协议、provisional 粗筛），`quickJudgeBatch` 的批量路径改用该契约与同名技能键；单家降级路径仍在 `discovery.qualify_fit`。新增内置技能 `growth_motion/discovery-quick-judge`（SKILL.md + 5 例 evals）并重新生成技能目录。
  - v2 判定路径（Part B，默认关）：新增 `apps/api/src/discovery/fit-judge-v2.ts`——`buildJudgePrompt`（fit-v2 rubric/冻结 prompt hash）→ 网关结构化调用（task 仍为 `discovery.qualify_fit`，schema 换 judge-output/v2，非 durable）→ `validateJudgeOutputV2` → `validateEvidence`（域门/快照子串/30 天新鲜度/注入防护）→ `aggregateJudgment`（R0–R4）→ FitJudgment（FIT→match / UNKNOWN→weak / NOT_FIT→mismatch）。
  - `JUDGE_CONTRACT_MODE=off|shadow|enforce`（默认 off，非法值回落 off）：off 走旧路径完全不变；shadow 仍用 v1 产 Lead、额外跑一次 v2 并生成 `judgment_record` 草稿（同 run 每家最多一次、失败只记日志）；enforce 只用 v2 聚合 verdict。`judgment_record` 与 Lead 投影在同一个 `prisma.withWorkspace` 事务内写入（`recordJudgment` + `upsertLeadFit`，设计 §4.3.4.4）。
  - 治理同步：`EXPECTED_MODEL_TASKS` 13→14（quick_judge，schema `quick-judgment/v1`）、`MODEL_RESULT_TASK_IDS`/投影注册、`durable-result-strategies.json` modelTasks、run 级预算包络新增 `discovery.quick_judge`（500 家池 / 8 家每批 = 63 次上限）、技能目录与 evals 清单。
- 测试：`fit-judge-v2.spec.ts`（聚合 verdict→Lead 映射、证据域门/子串/拒答、记录字段与 digest、三模式分派、shadow 成本护栏与失败不影响 Lead、enforce 路径）、`quickJudgeBatch` 契约断言（task/model/skillKey）、记录写入同事务顺序断言；`pnpm skills:validate`、execution-authority policy spec、environment-parity spec、`tsx scripts/validate-judgment-evals.mts` 全绿。
- 上线注意：`JUDGE_CONTRACT_MODE` 默认 off，本 PR 不改变生产判定。worker 重启会 seed 新技能目录。v2 调用暂为非 durable（judge-output/v2 尚无注册的 durable 投影），影子期记录无 durable_receipt。
- 未做：`JUDGE_CONTRACT_MODE=shadow/enforce` 的线上开启与金标回归（J13 模型层评测）、L3 面板与 conformal 弃权（k=1 单采样，sampling 如实记录）、`judgment_record.run_id` 回填真实 run id（当前留空，FK 只接受真实 discovery_run 行）、v2 的 durable 结果投影与 replay 保护。

## 2026-11-09 · P3 J18 — 金标晋升/季度退役 CLI 与分布报表 (#940)

- 起因：ch04 §4.3.8.3 —— 复核结论先入 `candidate`，需人工批量评审后晋升 `calib`/`test` 才进校准与回归；没有晋升/退役工具，金标池只会越积越乱且无法轮换。表为 append-only（J04 授权 SELECT/INSERT），故晋升与退役都必须**追加新 split 的行**。
- 改动：
  - `apps/api/src/discovery/judgment/golden-label.ts`：纯函数 `planPromotion`（按 labeledAt 升序、limit、`--ids` 白名单、已晋升幂等跳过）与 `planRetirement`（保留最新 N 行、其余退役）；`promoteGoldenLabels` / `retireGoldenLabels` / `goldenLabelSummary` 三个 withWorkspace 事务封装；dedupe key = 七维内容键。
  - `scripts/judgment/promote-golden-labels.mts`：ops CLI（`--to calib|test|retired`、`--limit`、`--ids`、`--dry-run`、`--retire-keep/--from-split`、`--summary`），输出 JSON 摘要，非零退出表示失败；连接优先 app_user（RLS 生效）。
  - `packages/db/test/golden-label.rls.spec.mjs`（db-tests service 组）：晋升追加/原行不变/重跑只晋升剩余/退役幂等/跨租户不可见。
- 测试：`golden-label.spec.ts` 5 例纯函数；库上 spec 2 例；`nest build` 通过。
- 未做：晋升审批流（本周由质量负责人跑 CLI 评审）、overturn 周报（J16 与度量报表一并做）、真实标注集（J13，需人力）。

## 2026-11-09 · Add the read-only metrics API — catalog, observations and rollups with keyset pagination (ch01 PR-04) (#941)

- 起因：ch01 PR-04 要求把度量工作流（PR-03）写入的观测与聚合以只读 API 暴露给运营与后续看板；本切片实现 catalog/observations/rollups 三端点。
- 改动：
  - 新增 `apps/api/src/measurement/measurement.controller.ts` + `measurement.service.ts` + `measurement.module.ts`（AppModule 挂载）：`GET /metrics/catalog`（metric_definition 平台只读）、`GET /metrics/observations`（metric_observation，本 workspace RLS，window_end 倒序 keyset 分页）、`GET /metrics/rollups`（daily|weekly 两表，桶倒序 + 指标/维度 keyset）；统一 `acquisition:read` scope 与 page envelope；参数/游标不合法 400 VALIDATION_ERROR；数值列 double、stratum 原样 JSON。
  - 新增 `apps/api/scripts/measurement-sync-definitions.mts`：把 `docs/metrics/dictionary/*.json`（44 指标）幂等 upsert 到 `metric_definition`（owner 连接，按 (metric_id, version)，content_hash 记录内容指纹），使 catalog 开箱有 30+ 指标。
  - `apps/api/src/docs/operation-descriptions.ts` 增加三条操作描述（operation-descriptions.spec 机械校验）；重导出 `packages/contracts/openapi/openapi.json`（新增纯加法，oasdiff 不判 breaking）。
  - 新增 `measurement.service.spec.ts`（游标往返/非法输入/分页/表选择/映射，5 例）与 `docs/metrics/metrics-api.md`（端点、可见性、游标、同步命令、余量）。
- 测试：service 单测随 vitest 执行；本地重导出 openapi 后 `git status` 干净（由 CI 的 drift/spectral/oasdiff 复核）；`verify-docs` PASS。
- 未做：/metrics/vric、scorecards、evals、frames、recapture、benchmarks 端点为后续切片；SaaS BFF 代理与看板（PR-05）不在本 PR；未部署不发车。

## 2026-11-09 · Add the offline domain verifier skeleton — Impressum/SIREN/CRN extraction, VIES interface and deterministic scoring (ch03 T3-13 subset) (#942)

- 起因：ch03 §3.12.3 的域名校验器（P2 最高优先级链路）需要一个可离线测试的确定性核心：证据抽取（注册号/VAT/地址/名称）→ 评分 → VERIFIED/AMBIGUOUS/REJECTED，且与既有 DomainResolver 候选契约衔接；抓取、VIES 真实 REST 与落库属执行面，本波只做接口与 fixture。
- 改动：
  - `apps/api/src/registry/domain/domain-verifier.ts`：`extractRegisterEvidence`（DE 复用 `parseImpressum` 取 HRB/HRA+法院；FR 抽 SIREN/SIRET/RCS 九位；GB 抽 Registered in England… 的 8 位 CRN；未抽到 = 未知而非不符）；`verifyDomainCandidate` 按 §3.12.3 公式评分（55/35/20/15|8/5，上限 100；VERIFIED ≥90、AMBIGUOUS 55–89、无硬证据最高 40）与负证据（页面注册号不符含法院不一致→REGISTER_MISMATCH；停放页→PARKED_DOMAIN；零页面→NO_LEGAL_PAGE）；`VatValidator` / `LegalPageText` 契约为离线接口（VIES fixture），VIES 故障按未知处理不影响已有硬证据。`verifyDomainCandidates` 实现同名冲突规则（≥2 个 ≥55 分→全部 AMBIGUOUS、不自动选中）与唯一 VERIFIED 选中；`toDomainResolutionDrafts` 映射 `company_domain_resolution` 行草案（状态/matchType/confidence/evidenceJson/selected）。
  - 与候选生成契约衔接：spec 用 `MultiRouteDomainResolver`（fixture 搜索 provider）产出候选直接喂校验器（域名 token、噪声过滤全链路离线）。
- 测试：`domain-verifier.spec` 覆盖评分表（100/95/75/≤40 各组合）、法院不一致与号码不符负证据、VIES 故障降级、停放/零页面、同名冲突与唯一选中、行草案映射、resolver→verifier 交接；registry 全组 13 文件 133 项全绿；build/lint 通过。
- 未做：法律页抓取与播放（执行面 T3-10/T3-12）、VIES 真实 REST、robots/停放页结构判定增强、人工复核队列（T3-15）、500 条人工标注 precision 验收；不碰 Copy 文件、无迁移、未发车。

## 2026-11-09 · Website candidate search goes through ToolBroker instead of direct SearXNG egress (#943)

- 起因：v3.0 第 6 章 WEB-10 / 审计「未登记出网路径」——`company/website-candidates.ts` 直接 import `searxSearch` 并发调用自托管 SearXNG，绕过了 ToolBroker 的 source_policy、预算、限流、幂等与 Trace 账本。
- 改动：
  - `website-candidates.ts`：删除直连 `searxSearch` 依赖；搜索执行器改为注入 `SEARXNG_SEARCH`（签名带 `{workspaceId, correlationId}` 上下文），缺失时 **fail-closed 503 `WEBSITE_CANDIDATE_SEARCH_UNAVAILABLE`**（且不触达数据库）。
  - 新增 `brokerBackedSearxSearch(broker)`：经 `ToolBroker.invoke('searxng.search', …)` 执行，映射 durable 投影（url/title）回 `SearxResponse`；策略拒绝/预算不足按既有「搜索失败返回空列表」语义容错，拒绝事件由 Broker traceRecorder 落 warn。
  - `company.module.ts`：`SEARXNG_SEARCH` 改为 `buildToolBroker({sourcePolicyReader, prisma, budgetStore})` 工厂（`TOOL_BUDGET_STORE` 由全局 ModelGatewayModule 提供），不再有未登记出网路径。
- 测试：无执行器 → 503 且不读库；Broker 适配器（工具 id/入参/上下文透传、投影映射、空 url 过滤）；Broker 拒绝 → 空列表容错；既有排序/查询用例保持全绿。
- 未做：端到端真搜验证（需 dev 栈真跑，发车后由发车验收覆盖）；未部署。

## 2026-11-09 · ZeroBounce arbiter and Truelist catch-all resolver adapters (#944)

- 起因：P1-05——验证瀑布的仲裁席（ZeroBounce）与 catch-all 解析席（Truelist）是计划 §2.3.5.1 的既定组成；#932 的瀑布第三个位置已留好但无适配器。
- 改动：
  - `zerobounce.provider.ts`：`/v2/validate` 客户端（env 凭据、8s abort、429/5xx/超时/畸形体统一 UNKNOWN 不抛、$0.0099/条按事件账计费）；`valid→VALID`、`invalid/spamtrap/abuse/do_not_mail→INVALID`、`catch-all→CATCH_ALL_RISKY·true_catch_all`、`unknown→UNKNOWN`（有效裁决 error=null 计费）、响应内 `error` 字段→UNKNOWN 不计费。入 provider 池作为**仲裁席**（第三次调用，仅在前两票未收敛时发生）。
  - `truelist.provider.ts`：`/api/v1/verify_inline` 客户端（Bearer 鉴权、$0.0014/条、enhanced 3 credits 以账单为准）；`ok→VALID`（enhanced 解析成功的地址级证据）、`email_invalid/disposable→INVALID`、`accept_all→CATCH_ALL_RISKY·true_catch_all`、`unknown→UNKNOWN`。**暂不入池**——瀑布的「主验 unknown/catch_all → 解析器 → 地址级 valid 需第二票」分支属于后续编排改造，按位置取席会把它误当仲裁席。
  - `data_provider.zerobounce` / `data_provider.truelist` seed（DISABLED）+ `source_policy.api.zerobounce.net` / `api.truelist.io` 登记 + 治理 registry 条目与生成文档（providers=26）。
- 测试：两套假 HTTP 契约测试（缺凭据/各映射态/未知态计费/429/5xx/超时/畸形体/Bearer 与 query 断言），零真实出网；池顺序断言含 ZeroBounce 仲裁席与 Truelist 不入池。
- 未做：Truelist 解析分支的瀑布编排接线（主验 unknown/catch_all → 解析器 → 第二票）；真实 key 到位后按供应商实际响应校准映射并跑 scorecard。

## 2026-11-09 · P3 J21 — 存量重判批次规划器（只读）与操作手册 (#945)

- 起因：ch04 §4.3.9 J21 —— 5,013 家存量需要在 v2 判定上线后分批重判；没有规划器，「给谁判、多少钱、会不会超帽」只能拍脑袋，超帽后还会把「完成率」做成假指标。
- 改动：
  - `apps/api/src/discovery/judgment/rejudge-plan.ts`：确定性规划——有域名优先排序、定长批次切分、成本估算（9900 micros/家，设计实测均值），**超帽拒绝规划而不是静默截断**；非法参数 fail-closed。
  - `scripts/judgment/rejudge-batch.mts`：只读 CLI——从 ACTIVE ICP × 未用当前 `prompt_hash`/`rubric_version` 判过的 canonical_company 生成候选，输出批次/成本/超帽检查；`--execute` 显式拒绝（发车后才允许真实执行）。
  - `docs/backend/judgment-rejudge-batch.md`：规划/执行/异常停手/回滚（env 置回 off + worker 重启 <5 分钟）/验收口径。
- 测试：`rejudge-plan.spec.ts` 5 例（排序、切批与估算、超帽拒绝与显式限额、非法参数、确定性）。
- 顺带修正：J18 的金标 CLI 与本次 CLI 统一放在 `apps/api/scripts/judgment/`（root `scripts/` 在 pnpm 严格布局下解析不到 `@prisma/client`，且需在 app 包上下文运行）；CLI 读查询包在 `set_config` 事务里以满足 RLS（owner 连接同样受 `current_workspace_id()` 约束）。
- 未做：真实重判执行与每批完成率/失败率/成本证据（需发车后由 worker 执行，本手册已写执行步骤与停手条件）。

## 2026-11-09 · Extend the domain verifier to the remaining §3.12.9 anchors — IT/ES/NL/BE/CH extractors with fixtures (#946)

- 起因：T3-13 校验器首波只覆盖 DE/FR/GB；ch03 §3.12.9 锚点矩阵要求逐国注册号锚点（IT REA+省、ES NIF/CIF、NL KVK、BE KBO、CH UID）与单测样例，新增国家先补矩阵再写代码。
- 改动：`apps/api/src/registry/domain/domain-verifier.ts` 的 `extractRegisterEvidence`/`registerMatches` 增加五个国家抽取器与比对规则——IT `REA MI-1234567`（省+号，省不同=不符，与 DE 法院同语义）、ES `NIF/CIF`（格式归一后全串比对）、NL `KVK`（8 位）、BE `KBO`（10 位，`0123.456.789` 与无点号等价）、CH `UID CHE-123.456.789`；全部按标签锚定（REA/NIF/CIF/KvK/KBO/CHE 字面），未打标签的数字不猜。模块头注释同步矩阵覆盖清单。另补 §3.12.10 集团门户规则：页面出现多个不同注册号时一律 AMBIGUOUS（`MULTIPLE_REGISTERS`，人工决定主实体），不因任一命中而自动 VERIFIED；为此在 `website-profile/impressum.ts` 增加只读的 `scanRegisterNumbers`（全部 HR 号码扫描，法院归属仍按 parseImpressum 首个解析），DE 单页多实体可检出。
- 测试：`domain-verifier.spec` 新增矩阵用例——五国抽取断言、五国「注册号+地址+名称 → VERIFIED（≥90）」参数化用例、IT 同号异省与 BE 异号两个 mismatch 负向、集团门户单页双 HRB → AMBIGUOUS；domain 组 29/29，registry 全组 141 项全绿；build/lint 通过。
- 未做：IT `P.IVA`/ES `Registro Mercantil 城市`/NL `BTW`/BE `TVA` 与注册号的联合强校验（VAT 路走 `VatValidator`，真实 VIES 属执行面；CH 不在 VIES，需 CH register API）；robots/停放页结构增强；不碰 Copy 文件、无迁移、未发车。

## 2026-11-09 · Wire the L0 sanctions gate into quick scan and deep judge with a deduped stale alert (#947)

- 起因：P3 J07（设计 §4.3.2.2 W8）——J05 的门引擎已在库里，但判定链从未调用它；制裁名单陈旧（当前真实数据 `eu_fsf` 最近一次刷新 FAILED）既不会标记结果，也不会告警。
- 改动：
  - `apps/api/src/discovery/judgment/gate-chain.ts`：L0 门链接线层——`evaluateL0Gates` 归一化门链结论（G1 四态 fresh/yellow/red/not_screened、G5 UNKNOWN、补数门集合），`quickScanGateBlock`/`deepJudgeGateBlock` 执行模式矩阵（与 `JUDGE_CONTRACT_MODE` 协同：深判 off 不评估 L0、shadow 记录不拦截、enforce FAIL 拦截；快扫总是评估、但 G1 拦截仅 enforce）。`SANCTIONS_LIST_STALE` 告警复用已注册的 `SanctionsListStale` outbox 集成事件，按「workspace × 状态 × 失败/缺刷新源集合」去重（6 小时常量窗口 + 进程内缓存 + 库内回看）。
  - `SanctionsScreeningService.freshness()`：四态口径与门引擎同源（72h/168h 常量）；`screen()` 结果带 `stale` 标记（yellow/red）。`eu_fsf` FAILED 且超 168h 推导 red。
  - 深判接线：`fitCompanyOnce`（run2 流水线）在模型调用前评估 L0——enforce 下 FAIL 不调模型、job 记 NOT_FIT；yellow/red 不拦截，`sanctionsStale` 随 `lead.fitReasons` 落库。快扫 `quickJudgeBatch` 把 stale 标记写进 `company_done` 事件。
  - `docs/backend/sanctions-operator-refresh.md` §7：四态口径、告警载荷与去重、处置顺序。
- 测试：`gate-chain.spec.ts`（四态 × 红线：eu_fsf FAILED→red、yellow/red 不判 NOT_FIT、模式矩阵、告警去重 6h、replay 幂等、补数任务写入）；`sanctions-screening.spec.ts` 四态与 `screen().stale`；`discovery.run2.activities.spec.ts` shadow/enforce 快扫行为；`discovery.run2.pipeline.activities.gate.spec.ts` 深判三种模式。
- 未做：影子期金标对比（L0 记录 vs 旧路径产出的一致性报表）；legacy `discovery.activities.ts` 的 `qualifyFitForRun` 未接线（当前生产走 run2 快扫 + companyPipeline；该路径等 run2 开关全量后随旧链路退役）；`>14 天硬停` 的 env 熔断仍按「不用 env」保持未实现（red 只标记 + 告警，不拦截判定，执行在 J20）。

## 2026-11-09 · Quick scan runs the G5 domain gate first and queues domainless companies for enrichment (#947)

- 起因：P3 J08（设计 §4.3.2.6 W9）——「77% match 无域名」的池噪声来自把无官网/死域公司直接送 LLM 判定；G5 门要前置到批量粗判之前，UNKNOWN 的进补数队列而不是烧模型费用。
- 改动：
  - `quickJudgeBatch`（`apps/api/src/temporal/discovery.run2.activities.ts`）在批量判前逐家评估 L0 门链：无域名（`GATE_DOMAIN_MISSING`）或 DEAD 域（`GATE_DOMAIN_DEAD`）→ G5 UNKNOWN，`evaluateGates` 写 `gate_enrichment_task(queued)`，该公司不进 LLM 批量、job 停 `skipped` 并记 `last_error_code`，`company_done` 事件标 `stage=gate_blocked`；`result.gated` 与 `phase_completed` 载荷计数。
  - ICP `companyAttributes.allow_domainless=true` → G5 NOT_APPLICABLE，无域名公司照常判定。
  - `createRun2Activities` 新增可选 `domainStatusFor` 依赖：P2 域名解析流水线的存活校验接入缝（未注入 = 无存活证据、不视为 DEAD）。
  - `docs/backend/sanctions-operator-refresh.md` §7 增补补数队列的运营查询与消费者现状。
- 测试：`discovery.run2.activities.spec.ts` 新增四例——无域名 100% 进补数队列且模型批量输入不含该公司（mock 断言）、DEAD 域同理（注入 `domainStatusFor`）、allow_domainless 放行照判、同一 (company, icp, gate) 重跑不重复建任务；`gate-chain.spec.ts` 覆盖 G5 决策表与 allow_domainless。
- 未做：`gate_enrichment_task` 的消费者——P2 域名解析流水线尚未接线（仓库只有候选生成器 `registry/domain/domain-resolver.ts`，无队列消费者、无域名存活状态生产者）；本卡只负责生产任务 + 状态查询，消费者与补数后重评留待 P2 后续波次。深判路径的 G5 UNKNOWN 不拦截（设计 UNKNOWN 不短路），只在快扫前置。

## 2026-11-09 · P3 J12 — borderline 三模型判定面板（JUDGE_PANEL_MODE，默认 off） (#948)

- 起因：ch04 §4.3.3.6 L3 与 §4.3.9 J12。L2 深判在 borderline 带（加权分 3.5–7.0）只能给 UNKNOWN；设计要求对这批「模型不确定」的候选跑 3 个不同家族模型的面板，多数票（2/3）定音、不一致回 UNKNOWN，且逐模型写 `judgment_record`、逐模型记账。
- 改动：
  - 新增 `apps/api/src/discovery/judgment/panel.ts`：`JUDGE_PANEL_MODELS`（deepseek-v4-pro / gemini-4-argon-high / gpt-5.6-sol，全部经 `JUDGE_MODEL_ALLOWLIST` 校验，fail-closed）；`judgeFitPanel` 对同一输入依次调用三家（复用抽出的 `judgment/judge-run.ts` 单模型执行器：同一 prompt / judge-output/v2 / 证据校验 / 确定性聚合）；多数票 ≥2/3 定 verdict，无多数（含 1/1/1、UNKNOWN 混杂）→ UNKNOWN；拒答票记 UNKNOWN 且计入；非控制面调用失败记 UNKNOWN 票并继续，预算/控制面错误显性上抛。
  - 记录：每模型一行 `judgment_record`（judge_level=3、model_requested 为该模型、`model_resolved/model_reported` 如实、sampling.k=1、成本逐模型记 `cost_micros`），面板结论再写一行汇总（judge_level=3、`model_requested='panel'`、verdict=多数票、sampling.votes 记录票型、成本不重复记账）。replay key 不含 model 列，`attempt` 承载面板槽位语义：1..3 = 三模型槽位、4 = 汇总行，同一输入重放幂等命中同一槽位。
  - 接线：`judgeFitV2` 在聚合为 borderline UNKNOWN（scoreWeighted ∈ (3.5, 7.0) 且非证据门/注入/拒答）时按 `JUDGE_PANEL_MODE=off|shadow|enforce`（默认 off，非法值回落 off）触发——shadow 只写记录、不改 verdict/Lead；enforce 用面板多数票替代该情形的 v2 verdict。面板仅在 v2 路径（`JUDGE_CONTRACT_MODE=shadow/enforce`）内生效，contract=off 时任何面板取值都不触发；同 run+company 进程内单次护栏与 shadow v2 同款。`persistJudgmentRecordInTransaction` 扩展为按「主记录 → 逐模型槽位 → 汇总行」顺序写入，panel=shadow 的记录写入失败只记日志、不回滚 Lead。
  - 治理：`JUDGE_PANEL_MODE` 是运行期灰度、不分支 app environment，不产生 ENVIRONMENT_BRANCH finding，也不登记 configuration_allowlist；`judgment/judge-run.ts` 复用既有 `getTask('discovery.qualify_fit')` 契约锚点，无新增模型任务、无迁移。
- 测试：`panel.spec.ts`——多数票（2/3、3/3、1/1/1→UNKNOWN、拒答计票、双拒答→UNKNOWN）、逐模型记录行（level=3、model 列、cost_micros、占位 criteria 不伪造判定）、预算分账（基础判定 + 三个面板模型各一次、模型序列断言）、开关矩阵（off/off 与旧路径逐字一致；contract shadow 下面板不改 Lead；enforce+shadow 不改 Lead；borderline 之外/证据门/拒答不触发）、控制面错误上抛与 shadow 吞错语义、进程内护栏幂等、多条记录写入顺序与 tolerant 语义；`fit-judge-v2.spec.ts` 既有断言不回归。
- 未做：`JUDGE_PANEL_MODE=shadow/enforce` 的线上开启（默认 off，本 PR 不改变生产判定）；面板模型的金标校准与模型层评测（J13/J19）——当前白名单沿用 JUDGE_MODEL_ALLOWLIST；面板记录的 `run_id` 回填（与 v2 主记录一致当前留空）；面板并发化（当前依次调用，预算错误可尽早停止）。

## 2026-11-09 · Add threshold and freshness alert evaluation for gain metrics (ch01 PR-05) (#949)

- 起因：ch01 PR-05（看板告警）要求对度量结果做阈值与新鲜度告警；看板/渠道接线是后续切片，本 PR 交付纯引擎评估与规则文件。
- 改动：
  - 新增 `docs/metrics/alerts/rules.v1.json`（`measurement-alerts/v1`，4 条首发规则：T1-008 public_web 7 日均接受率 <50% 为 CRITICAL、T2-001 全员邮箱覆盖率 7 日均 <10% 为 WARNING、T0-001 观测新鲜度 36h、T2-001 周桶新鲜度 192h）与 `docs/metrics/alerts.md`（字段、评估语义、CLI、退出码、首发阈值依据）。
  - 新增纯评估器 `apps/api/src/measurement/alerts.ts`：阈值规则（below/above 严格比较、latest/mean 聚合、lookback 按已观测桶、minSample、stratumEquals、每桶取最高 metric_version）与新鲜度规则（observation window_end / rollup 桶结束时刻），输出 OK/FIRING/NO_DATA/INSUFFICIENT_DATA 与退出码汇总；缺失数据不会被折叠成绿色。
  - 新增 `apps/api/scripts/measurement-alerts.mts`：owner 连接只读 SELECT，`--json/--as-of/--rules`，退出码 0/10/20/1，不发通知不落库。
  - `scripts/metrics/metrics-lint.mjs` 接入规则校验（schema、id 唯一、指标存在性、kind 专属字段词表），规则文件与字典同门禁；`alerts.spec.ts` 覆盖评估语义并断言 checked-in 规则引用的指标都在字典。
- 测试：`node --test scripts/metrics/metrics-lint.test.mjs`（14 例）、`vitest run src/measurement`（34 例）本地全过；`measurement-alerts.mts --json` 对 dev 库只读试跑输出 NO_DATA（尚无 rollup 数据）。
- 未做：告警持久化、通知渠道（邮件/IM/站内信）、看板 UI 与 SaaS BFF 代理（后续切片/运维接线）；未发车、未部署。

## 2026-11-09 · Add the offline domain review queue contract — task classification, business-day SLA, state machine and SLA metrics (ch03 T3-15 subset) (#950)

- 起因：ch03 §3.12.5 要求域名判定的人工复核队列（入队条件、3 工作日 SLA、吞吐与推翻率等质量指标），而 `company_domain_resolution`/`domain_review_task` 落库与运营台属执行面；本波先交付可离线测试的纯契约，供执行面/在线 PR 直接接线。
- 改动：`apps/api/src/registry/domain/domain-review.ts`：
  - `buildReviewTasksFromVerification`：AMBIGUOUS 按信号分类（多注册号→`multi_candidates`(70)、同名冲突→`name_collision`(80)、其余→`low_confidence`(50)），VERIFIED 按可注入抽样率（默认 5%）进 `audit_sample`(30)；REJECTED 不入队；SLA `dueAt` = 3 个工作日（`addBusinessDays` 只跳周末，报告需注明口径）。
  - 状态机：OPEN → APPROVED / REJECTED / NOT_FOUND（证据不足）/ EXPIRED；终态重复裁决抛 `REVIEW_TASK_NOT_OPEN`；`expireOverdueTasks` 超期只置 EXPIRED 并留 `SLA_TIMEOUT`，**不自动改判**（§3.8.2）。
  - `summarizeReviewSla`：积压、SLA 达成率（EXPIRED 视为未达成）、平均裁决耗时、按 reason 的开/决分布、最久等待；`decisionToResolutionUpdate` 映射 `company_domain_resolution` 行草案（批准即 VERIFIED+selected）。
- 测试：`domain-review.spec` 覆盖工作日算术（周五+3→周三、周六+1→周一）、信号分类与优先级、可注入抽样（确定性）、非法抽样率、状态机守卫、SLA 超期不改判、SLA 统计（1/3 达成、平均 72h、最久积压 24h）、裁决→行草案映射；domain 组 41/41、registry 全组 154 项全绿；build/lint 通过。
- 未做：`domain_review_task`/`company_domain_resolution` 表与落库、运营台页面与 BFF 联调（执行面/在线 T3-15 完整版）、节假日日历与 assignee 负载均衡；不碰 Copy 文件、无迁移、未发车。

## 2026-11-09 · Contact eligibility endpoint for the SaaS sending gate (engine side) (#951)

- 起因：P1-16——gain-saas 发送门只查同意/法域/DNC，不知道引擎侧 `contact_point` 是 VALID 还是 RISKY；人工把 RISKY 邮箱填进草稿即可绕过。发送开关关闭期间风险为零，开启前必须修掉。SaaS 侧接线（DNC 之前插入检查、引擎不可达 fail closed）由 gain-saas 实现，本 PR 只交付引擎侧事实源。
- 改动：
  - `POST /api/v1/outreach/contact-eligibility`（服务令牌，x-service-token，复用 DNC 的令牌机制与恒定时间比较；错误码换成 eligibility 语境）：`{workspaceId, emails≤50}` → `{results:[{emailHash, found, state, score, allowedActions, catchAllPolicy}]}`。
  - 匹配口径与写入器一致：规范化 → 确定性 `encryptPii` → 密文等值（原始 SELECT，PII 扩展的 `where.value` 加密只覆盖字符串标量、不覆盖 `in` 数组；RLS 强制租户隔离）；同一邮箱多条点取最强状态（VALID > CATCH_ALL_RISKY > UNKNOWN > INVALID）；未找到 `found=false, state=UNKNOWN`（调用方 fail closed）。
  - `catchAllPolicy`：灰度策略表（P1-13）未落地 → 恒 `mode=OFF, allowed=false`（策略不存在 = 一律拒发），随附 score 档位。
  - 令牌守卫重构：`OutreachDncServiceTokenGuard` 的四个错误码/文案字段改为可覆盖，新增 `ContactEligibilityServiceTokenGuard` 子类；OpenAPI 契约重导出（新增 operation，summary/description 齐备）并加契约钉测试。
- 测试：服务口径 7 条（VALID/最强状态/CATCH_ALL_RISKY 策略/未找到/规范化去重/400 词表）；守卫 3 条（503/403/放行）；OpenAPI 契约钉 3 条；DNC 既有守卫用例保持全绿。
- 未做：SaaS 侧 `eligibility()` 接线与 G8 六条负向/正向集成测试（gain-saas lane）；`catch_all_send_policy` 表与 SHADOW/LIMITED 模式（P1-13）；发送批次记录 `contactStateAtSend`（SaaS 侧）。

## 2026-11-09 · P3 J22 — 判定灰度矩阵、回滚计划与演练脚本 (#952)

- 起因：ch04 §4.3.9 J22 —— 两个运行开关（contract/panel）组合起来有 9 种状态，值班时「Lead 现在由谁决定」必须一眼可答；回滚要求 <5 分钟，需要预演而不是临场拼。
- 改动：
  - `apps/api/src/discovery/judgment/grayscale.ts`：纯函数 `describeJudgmentModes(env)`（9 组合的 Lead 路径/记录行为矩阵 + 非法值与「panel 在 contract=off 下不生效」告警）与 `rollbackPlan()`（env 复位→重启 api+worker→确认→留证，合计 <5 分钟）；四阶段灰度清单常量。
  - `apps/api/scripts/judgment/mode-drill.mts`：只读演练 CLI（打印矩阵/警告/回滚计划；非法 env 退出 1）。
  - `docs/backend/judgment-grayscale-runbook.md`：阶段门槛（含 J13 kappa 未达标前 enforce 仅限 dev）、每阶段值班指标、演练命令、回滚步骤与已知边界（shadow 不一致是观察信号、v2 非 durable、run_id 暂空）。
- 测试：`grayscale.spec.ts` 6 例（基线/shadow/enforce 矩阵、非法值告警、回滚计划 <5 分钟与步骤覆盖、阶段清单）。
- 未做：线上首轮真实灰度与演练记录（待发车后按手册执行并把 drill 输出归档）。

## 2026-11-09 · P3 J15（第一批）— conformal 弃权数学模块与已知分布单测 (#953)

- 起因：ch04 §4.3.7 —— 「自动 FIT 错误率 ≤5%」必须是统计承诺而不是口号：阈值 τ 由 calib 金标拟合，使接受集 {s ≤ τ} 的 NOT_FIT 比例在 95% 单侧置信下的 Clopper–Pearson 上界 ≤ α=0.05，取满足条件的最大 τ。
- 改动：新增 `apps/api/src/discovery/judgment/conformal.ts`（纯函数、零依赖）——`conformalScore`（k 次自洽采样 FIT 票占比 → s=1−p̄）、`clopperPearsonUpper`（正则不完全 Beta 反演，Lanczos lgamma + Lentz 连分式；E=0 走闭式 1−δ^{1/n}）、`fitConformalThreshold`（从小到大取安全最大 τ，无安全阈值 → null=全弃权）、`conformalAbstain`（无阈值恒弃权 fail-safe）。
- 测试：`conformal.spec.ts` 8 例——分数枚举、n=59 首次 ≤5% 的设计论断、E=1/n=100≈0.0466 的已知值、单调性、300 全 FIT → τ=0（上界约 1%）、1 错+99 对 → τ=1/3、小样本全弃权、弃权判定。
- 未做：阈值工件落库（`conformal_threshold` 表已建，拟合 CLI 与 L4 运行时接线属 J15 后续批次，依赖 J13 真实标注集与 J14 校准报告）。

## 2026-11-09 · P3 J14（第一批）— 校准数学、报告 CLI 与可复算 fixture 证据 (#954)

- 起因：ch04 §4.3.6 —— 判定质量必须用带 CI 的数字说话：混淆矩阵、TPR/TNR/PPV/NPV/FNR（Wilson 95%）、Cohen's κ（bootstrap CI）与 Rogan–Gladen 校正（观测 pass rate → 真实匹配率），且报告必须可复算。
- 改动：
  - `apps/api/src/discovery/judgment/calibration.ts`（纯函数）：混淆矩阵（UNKNOWN 计未自动通过）、Wilson 区间、κ、确定性 bootstrap（mulberry32 固定种子）、Rogan–Gladen（TPR+TNR≤1 或概率越界 → null，作为「校准集与生产分布不一致」的信号）、`evaluateCalibration` 汇总。
  - `apps/api/scripts/judgment/judge-calibration.mts`：报告 CLI（`--fixture` 合成样例 / `--input` 真实标签对 / `--out` Markdown），输出混淆矩阵 + 全指标 CI + κ bootstrap CI + Rogan–Gladen；同输入同报告。
  - `docs/evidence/2026-11-09-judge-calibration-fixture.md`：合成 fixture 的可复算样例（显著标注 SYNTHETIC，不作真实结论）。
- 测试：`calibration.spec.ts` 7 例——含设计 §4.3.6.3 两个演算例子（0.375/0.844 与 0.286/0.643 逐位对上）、Wilson 73/100、κ 经典 0.4、bootstrap 同种子复算。
- 未做：真实标注集上的校准结论（J13 标注与双标 kappa 达标后运行同一 CLI）；`eval_receipt.metrics` 落库与发布门读取（J19/J20）。

## 2026-11-09 · Add offline annotation worksheet and import pre-check tooling for the golden set (ch01 PR-08 tooling) (#955)

- 起因：ch01 PR-08 的人工标注（J13）需要一个不依赖引擎的前置工具：从金标候选生成双人工作表，导入时做结构与 Cohen's κ 预检。
- 改动：
  - 新增 `scripts/metrics/annotation-worksheet.mjs`：读 `golden-sampling.mjs` 的样本 CSV（`ref,layer,stratum`，ref 为盲化键，无 PII），按 `seed+dataset+annotator` 确定性打乱，为 A/B 各生成一份 CSV/JSON 工作表（字段与词表来自 `rubric-v1.md`），并写 worksheet manifest（样本哈希 + 各自行序哈希）；已存在文件默认拒绝覆盖。
  - 新增 `scripts/metrics/annotation-import.mjs`：导入两份已填工作表，校验列结构/未知列/重复或不成对 ref/词表外取值，逐字段计算 raw agreement 与 Cohen's κ（复用 `golden-run.mjs` 实现），输出分歧裁决队列 CSV；退出码 0 通过 / 1 结构错误 / 2 κ<0.6 或双标不足 100。
  - 新增 `evals/golden-discovery/annotation-workflow.md`（工作流、词表、退出码、与 golden-label/v1 的关系）并更新 README §2 第 4 步；`scripts/metrics/annotation-tools.test.mjs`（9 例，含两个 CLI 真实子进程冒烟）接入 governance-contracts。
- 测试：`node --test scripts/metrics/annotation-tools.test.mjs` 全过；generator 重跑拒绝覆盖已填表。
- 未做：工具不产出 `golden-label/v1`（裁决是人的决定，落盘与评测由 J11/golden-run 线负责）；不接数据库、不调用模型；未发车、未部署。

## 2026-11-09 · P3 J19（第一批）— 模型评测回执契约与 dry 跑批脚本 (#956)

- 起因：ch04 §4.3.10.2 —— 发布门要读的不是「跑了一下觉得还行」，而是一份带身份与门限判定的回执：哪个模型、哪份金标、什么 rubric/prompt、指标（带 n 与 CI）、过没过。
- 改动：
  - `apps/api/src/discovery/judgment/eval-receipt.ts`：eval-receipt/v1 结构与 fail-closed 校验（五身份字段、指标 [0,1]+n+CI、cases 一致、gate.passed 布尔）；`buildEvalReceipt` 内置保守门限（κ≥0.6、TPR/TNR≥0.75、零失败用例），可覆盖。
  - `apps/api/scripts/judgment/run-judgment-model-evals.mts`：dry 跑批——不调用模型，跑完金标清单的确定性链路（schema→证据→聚合），用 J14 的校准数学算 κ/TPR/TNR（bootstrap 固定种子）并产出回执；`GAINOS_JUDGE_EVAL_LIVE=1` 显式拒绝（真实模型跑批需预算授权，属用户决策项）。
  - `docs/evidence/2026-11-09-judge-eval-receipt-dry.json`：dry 回执样例（gate.passed=true，model_resolved=dry-fixture-no-model-call）。
- 测试：`eval-receipt.spec.ts` 4 例（门限/阻断/覆盖/校验矩阵）；与 J14 校准单测合计 11/11。
- 未做：真实模型跑批与 `eval_receipt` 落表（schema 迁移 + 预算授权）；发布流程读取回执（J20）。

## 2026-11-09 · Add the offline search router contract and the wikidata_p856 candidate route; A decision brief (#957)

- 起因：ch03 §3.14.3 的搜索 provider 抽象（T3-11）与 §3.12.2 的 wikidata_p856 候选路（T3-12 余）是域名解析链路的离线可推进部分；同时把 A（local_query 血缘）收紧成一页决策简报供用户拍板（并入本 PR，不单开 docs PR）。
- 改动：
  - `apps/api/src/registry/domain/search-router.ts`：`SearchRouter.searchAll`（多路并行、单路失败隔离、URL 去重并集、`degradedFrom`、每路延迟预算）与 `searchPreferred`（成本顺序回退、全不可用显式 `allUnavailable`）；`UsageLedgerDraft`（purpose=DISCOVERY_DOMAIN_RESOLVE）成本账本草案；`ProviderHealthTracker` 按 §3.14.3 阈值（连续 20 失败/超 4 天无成功 → warn；7 天 30 失败 → disabled 自动跳过）。真实 HTTP/密钥属在线部分。
  - `domain-resolver.ts`：新增 `wikidata_p856` 路（rank 2）与 `WikidataP856Provider` 契约——按名称找实体、标签相似 ≥0.85 才取 P856（最多查 3 个），与其他路并集排序、失败隔离；`NOT_FOUND` 的 `NO_PROVIDERS` 判定包含 wikidata。
  - 文档：`docs/superpowers/plans/2026-11-09-registry-frame-local-lineage-decision-brief.md`（一页简报：A vs 现状 vs B、影响面/工作量/回滚/风险、推荐与不做的后果）。
- 测试：`search-router.spec`（并行失败隔离与去重并集、延迟预算、串行回退链、全不可用、健康阈值 warn/disabled/healthy、构造校验）；`domain-resolver.spec` 增 wikidata 用例（同域合并进 search 旁证、标签不符/无官网丢弃、provider 失败隔离、`NO_HITS` 口径）；domain 组 4 文件 51 项全绿；build/lint 通过。
- 未做：Brave/Serper/Mojeek 真实适配器与 ToolBroker 注册（在线，需密钥）；搜索重叠估计进记分卡（依赖真实 receipt）；不碰 Copy 文件、无迁移、未发车。

## 2026-11-09 · SMTP transport bounce and complaint writeback (engine side of the catch-all loop) (#958)

- 起因：P1-13 的数据回路——发送侧的硬退/软退/投诉必须回写引擎四态与抑制，否则灰度与发送门拿不到真实投递结果；策略表与发送门在 gain-saas lane 协调，本 PR 只交付引擎侧回写端点。
- 改动：
  - `POST /api/v1/contact-points/:pointId/bounce-events`（x-service-token，服务令牌守卫沿用 DNC 机制、错误码 bounce 语境）：`{workspaceId, event: hard_bounce|soft_bounce|complaint, messageId, smtpCode?, receivedAt?}`。
  - 语义（§2.3.6.6）：`hard_bounce` → INVALID（清 catch-all）+ suppression(email, bounce, PREFERENCE)；`soft_bounce` 同一地址累计第 3 次 → UNKNOWN + `next_reverify_at=+24h`（按计划显式降级，覆盖状态机的 VALID 保留语义，confidence −10）；`complaint` → 状态不变、confidence 归 0、证据 allowedActions 去 outreach、suppression(email, complaint, LEGAL)。
  - 每次回写落一行验证事件账（provider=smtp_transport、method=import、verdict invalid/unknown/blocked）与 `email.delivery` 证据（只有事件/响应码/messageId/时间，无 PII、dataClass=green）；`messageId` 幂等（唯一键命中返回 duplicate 且无副作用）。
  - 写入全部经唯一写入器（新增 `setEmailPointConfidence` 受控出口）；非 email 点 409；点不存在/跨租户 404（RLS）。
- 测试：服务口径 6 条（hard 的 INVALID+抑制+无 PII 证据、soft 未达阈值只记账、soft×3 降级+24h、complaint 的 confidence/LEGAL/动作收敛、duplicate 无副作用、404/409/400 词表）；守卫 3 条；OpenAPI 重导出（135 paths）；controller 拓扑已登记。
- 未做：SaaS SMTP transport 的调用接线与 S0–S4 灰度统计（gain-saas lane）；`suppression` 的派生投影对账（reconcileCanonicalSuppression）未在本事务触发，如需行/公司级联动由后续卡补。

## 2026-11-09 · Add the offline frame snapshot adapter port, fixture adapter and reusable contract suite (ch01 PR-11 offline part) (#959)

- 起因：ch01 PR-11（frame 适配器）依赖 registry A 方案定形，先交付离线部分：端口、fixture 实现与可复用契约测试套件，不接注册表数据、不落表。
- 改动：
  - 新增 `apps/api/src/measurement/frames/frame-adapter.ts`：`FrameAdapter` 端口（fetchSnapshot/parse/validate）、快照元数据类型（sourceUrl/fetchedAt/rawObjectUri/rowCount/contentHash/parserVersion）、实体与排除口径（entities + exclusions.total = rowCount）、血缘类型，以及状态机驱动 `runFrameAdapter`（FETCHING→PARSING→VALIDATING→READY|QUARANTINED|FAILED；结构校验与 FETCH_FAILED/PARSE_FAILED/PARSE_ROW_COUNT_MISMATCH/VALIDATION_ERROR 封装）。
  - 新增 `apps/api/src/measurement/frames/fixture-frame-adapter.ts` 与合成 fixture：内存记录、稳定序列化哈希、状态排除（status_not_active）、行数对账与校验清单，作为后继真实适配器的参考实现。
  - 新增 `apps/api/src/measurement/frames/frame-adapter.contract.ts`：`defineFrameAdapterContract(...)` 可复用套件，覆盖状态机全序、同 asOf 可复现、实体+排除=行数、实体键唯一、ISO-2 国家、frame.adapter 血缘、FETCH_FAILED 与 QUARANTINED 语义；`frame-adapter.spec.ts` 14 例含驱动失败路径。
  - A 方案预留位：`LocalQueryFrameLineageReceipt`（producer=registry.query）仅类型占位，`receipt` 保持不透明，不实现、不 import `apps/api/src/discovery/` 的血缘文件（P2 在飞面）。
  - `apps/api/src/measurement/frames/README.md` 说明端口语义、契约套件用法与未实现范围。
- 测试：`vitest run src/measurement/frames` 14 例全过；`pnpm --filter @global/api build` 通过。
- 未做：真实数据源适配器、`frame_registry`/`frame_snapshot` 落表（PR-12，需 schema 窗口）、local_query 接线（等 P2 血缘契约）、抽样核验；未发车、未部署。

## 2026-11-09 · Hunter, Findymail and Prospeo finder adapters with registry gates (#960)

- 起因：P1-07——富集瀑布（P1-08）要先有付费 finder 适配器；计划 §2.3.3 定序 Hunter（pattern/accept_all 结构化信号）→ Findymail（pay-on-valid 主力）→ Prospeo（90 天免费重取）。
- 改动：
  - `enrichment/finders/email-enrichment-provider.ts`：统一接口（`findEmail → hit/miss/error`、`requestHash = sha256(contactId|provider|inputVersion)`、注入 fetch）与共享纯函数（输入版本哈希、返回值边界校验 `normalizeEnrichedEmail`——语法 + 域名一致，防供应商串号；人名归一 `personNameParts/namesMatch` 大小写/变音符/标点无关）。
  - `hunter.provider.ts`：`/v2/domain-search` 客户端，按 first/last name 归一匹配取 confidence 最高；`data.pattern`/`data.accept_all` 作为结构化信号透传（accept-all 地址由验证层裁决，不当 VALID）；miss 不计费（$0.0170/命中）。
  - `findymail.provider.ts`：`POST /api/search`（Bearer），容忍顶层/嵌套 `contact.email` 两种形状；显式无结果 0 成本（pay-on-valid，$0.0198/命中）。
  - `prospeo.provider.ts`：`POST /email-finder`（X-KEY），`NO_MATCH`/`INVALID_DATAPOINTS`=合法 miss（0 成本），`RATE_LIMITED`/`INTERNAL_ERROR` 可重试、`INSUFFICIENT_CREDITS`/坏 key 不可重试（供编排层熔断）；$0.0198/命中。
  - `finder-pool.ts`：只收凭据已配置的 finder，顺序即瀑布顺序；Apollo/PDL 属 P1-09 可选尾，未入池。
  - 登记面：`data_provider.hunter/findymail/prospeo` seed（**一律 DISABLED** = kill switch）+ `source_policy.api.hunter.io/api.findymail.com/api.prospeo.io`（APPROVED、personalData、purpose=discovery/enrichment）+ SourceClass 清单与治理 registry 条目（providers=29）与生成文档。
- 测试：4 套假 HTTP 契约测试（命中/无结果不计费/429 可重试/401 不可重试/域不一致 invalid_payload/畸形体/缺凭据不发请求/pool 顺序与域名），零真实出网；governance-verify providers=29 通过；api build 通过。
- 未做：富集瀑布编排与 attempt 账（P1-08）、Apollo/PDL 适配器（P1-09）、HTTP 端点与 run 接线（P1-10）；真实 key 到位后按供应商实际响应校准映射并跑 scorecard（§2.3.3.1）后才允许翻 ENABLED。

## 2026-11-09 · Implement the approved local_query lineage variant — registry_frame receipts, governed registration and the registry.query domain-ack binding (#961)

- 起因：2026-11-09 用户经 P2 看板采纳 A 方案（决策简报 `docs/superpowers/plans/2026-11-09-registry-frame-local-lineage-decision-brief.md`）：`registry_frame` 是零出网本地枚举，没有物理调用可出 durable 回执，此前恒被 governed-lineage 闸门排除。获批后按设计 `2026-11-09-registry-frame-local-lineage.md` §2 落地契约本体。
- 改动：普通 7 个 provider 校验路径零放宽。
  - `company-discovery-lineage.ts`：`DiscoveryCompanyLineageProviderKey` ∪ `registry_frame`；`PROVIDER_RECEIPT_CONTRACT` 增 `registry_frame → {provider:'registry.query', resultSchema:'registry-query/v1'}`。
  - `registry/local-query-receipt.ts`（新）：确定性 local 回执构造——`operationKey=registry.query:<runId>:<queryDigest>`、operationId 由 (runId,queryDigest) 派生 UUID、resultDigest=归一候选集规范 JSON 的 sha256（**可从 registry_entity 重算**）、usage 恒 0/`not_incurred`；`buildRegistryQueryLineage` 单回执覆盖全部记录（空结果给合法空血缘）。
  - `discovery-query-governed-lineage.ts`：`PROVIDER_CONTRACT` 增 registry_frame（consumer `RegistryFrameDiscoveryProvider`，classes `company_registry`）；`durable-results/domain-ack-consumer-bindings.ts` 的 `DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 增 `registry.query` 绑定；`discovery.activities.ts` 的 `DISCOVERY_DOMAIN_ACK_PRODUCERS` 增 `registry.query`，并在执行上下文注入 `durableBudgetAuthority`（authorityId/accountId 来自 run 预算绑定）。
  - `provider-contract.ts`：`ExecutionContext` 增可选 `durableBudgetAuthority`（有物理调用的 provider 忽略）。
  - `registry-frame.provider.ts`：`REGISTRY_FRAME_PROVIDER=on` 才声明血缘并报送本地回执；缺预算绑定/非法 filters 均 fail-closed 为空集+空血缘；`provider.registry.ts` 读取该开关（默认 off = 原行为，关闭即回滚；data_provider 默认 DISABLED 为第二道开关）。
- 测试：新增 `local-query-receipt.spec`（规范 JSON/摘要敏感性与稳定性、确定性 UUID、回执过 `parseDurableExecutionReceipt` 严格校验、血缘过 `parseDiscoveryCompanyResultLineage`、空结果合法）；适配器 spec 增 lineage 模式五项（开关声明、确定性回执+回调一致、缺预算 fail-closed、非法 filters 空血缘、**governed plan 端到端接受**）；provider.registry spec 更新血缘不变量（registry_frame 在白名单但默认 off 不声明）。相关套件 18 文件 219 项 + activities/durable-results 37 文件 1106 项全绿；build/lint 通过。真库证据：一次性库导 FR 帧（3 实体）→ 适配器两次执行得到同一 operationId（baf33523…）与同一 resultDigest（9bd75428…），且 digest 由独立 DB 查询重算一致；库已删。
- 未做：`company_domain_resolution`/`domain_review_task` 两表落库、产物池导出、Temporal 工作流与 shadow→on 灰度（执行面后续 PR）；不碰 Copy 文件、无迁移、未发车。

## 2026-11-09 · WEB-1 tool_calls wire verification — offline dry-run harness and minimal paid-round-trip authorization (#962)

- 起因：`generateChatWithTools`（WEB-1）已合入，但「真实上游在一轮里发起 tool_calls、第二轮接受 tool 消息回放」只有付费往返能证明；先把离线半边与授权口径做成可执行材料，授权后一条命令即可验证。
- 改动：
  - `apps/api/src/model-gateway/chat-tools-dryrun.ts`：web_search/web_fetch 的 tool_calls 请求/响应夹具与用量声明、输入校验（名字/上限/id 唯一与有主/`inputSchema` 可编译）、脚本化 wire（记录请求体、零网络）、按目录价与 reserve 口径的费用估算、三方编排（tool_calls 解析、回放与最终回答、身份门负例）。
  - `apps/api/scripts/web-tool-calls-dryrun.mts`：一键入口。默认离线 dry-run；`--live` 直连网关发起 2 次付费 chat-completions（需 `WEB_TOOL_CALLS_LIVE_ACK=YES` 与 `WEB_TOOL_CALLS_{BASE_URL,API_KEY,MODEL}`），打印真实 usage 与结论。
  - `docs/backend/web-tool-calls-wire-verification.md`：最小授权请求（2 次调用、预留上限 40¢、token 估算与验证项清单）与执行/回填步骤。
- 测试：`chat-tools-dryrun.spec.ts` 以真实 provider + 脚本化 wire 跑通两轮与身份负例，并覆盖输入校验与费用估算的边界值。
- 未做：真实付费往返（等产品负责人费用授权）；不部署。

## 2026-11-09 · Add the paired VRIC series endpoint (T0-001 STRICT + T0-002 PLUS) to the metrics API (PR-04 follow-up) (#963)

- 起因：PR-04 只读度量 API 只做了 catalog/observations/rollups；看板需要 VRIC 北极星趋势，且字典要求 STRICT/PLUS 并列展示、缺数据不得以 0 冒充。
- 改动：
  - `GET /api/v1/metrics/vric`（`MeasurementService.vric`）：读 `metric_rollup_daily|weekly` 中 T0-001/T0-002 的本 workspace 行（RLS 与 rollups 相同），按 bucket + stratum_key 成对成行，每侧取最高 metric_version；桶升序、返回最近 `limit` 个桶（默认 30，最大 180），显式 from/to 时以最后 limit 个桶为准并用 `page.has_more` 标记截断；某侧缺行为 `null`。
  - 控制器/操作描述/openapi 同步：新增 `GET /api/v1/metrics/vric` 到 `operation-descriptions.ts` 并重导出 `packages/contracts/openapi/openapi.json`（+106 行纯加法）。
  - `docs/metrics/metrics-api.md` v1.1：端点表补 vric、明确升序/有界窗口/缺侧 null 语义与 PR-04 余量（scorecards 需先定 ops 读路径；T0-002 通道拆分属 PR-03 rollup 余量，端点不伪造通道值）。
- 测试：`vitest run src/measurement src/docs/operation-descriptions.spec.ts` 54 例全过（vric 成对/最高版本/最近 limit 桶/周表选择/非法参数）。
- 未做：scorecards/evals/frames/recapture/benchmarks 端点、T0-002 通道拆分、BFF/看板；未发车、未部署。

## 2026-11-09 · P6 CI gates — migration integrity (G2) and RLS catalog (G5) (#964)

- 起因：ch08 §3.4 的防欠债门（G1–G14）。G1 已随 #903 落地；本 PR 补齐纯 CI/脚本可交付的 G2 迁移完整性与 G5 RLS/租户目录（G9 体量/复杂度预算另开 PR）。
- 改动：
  - G2（`packages/db/scripts/migration-integrity-gate.mjs`）：迁移目录命名、14 位时间戳撞车（历史 6 组进基线，新增即红；只增基线、不改任何既有迁移文件）、历史文件不可变性（文件必须与「加入仓库的提交」逐字节一致；13 个 gate 上线前被修改过的存量文件冻结当前 sha256 进基线）、对一次性库 `migrate deploy` 后逐行校验 `_prisma_migrations.checksum` = 文件 sha256，失败/回滚行即红。
  - G5（`packages/db/scripts/rls-catalog-gate.mjs`）：带 `workspace_id` 的表必须 ENABLE+FORCE RLS 且有策略；其余表现状登记进目录基线（platform_table / owner_only / rls_enforced，棘轮豁免使门先可过）；`app_user` 默认表权限必须恰好只读。
  - 门登记簿 [docs/backend/ci-gates.md](../backend/ci-gates.md)：门名、owner、本地复现、基线更新与例外流程。共享运行时 `packages/db/scripts/lib/gate-runtime.mjs`。
- 测试：G2 反向演示（篡改历史迁移/再改冻结文件 → 红）、G5 反向演示（scratch 库新建未登记表 → 红）均已本地执行并还原；`gctl check` 全绿。
- 未做：G3/G4/G6/G7/G8/G9/G10–G14 在后续 Wave；G5 的「manual RLS 套件迁入 nightly」经实测暂不可自动化（7 个候选套件分别依赖集群级角色预置或存在夹具腐化，详见 ci-gates.md），需先修夹具与补 provisioning 再接入。

## 2026-11-09 · Emit the VRIC PLUS channel split (email_only/phone_only/both) from the T0-002 rollup query (PR-03 remainder) (#965)

- 起因：指标字典 §1.3.1 要求 VRIC_PLUS 必须同时报告 email_only / phone_only / both 通道拆分，而 PR-03 的 T0-002 查询只出总数行——口径已登记、实现未跟上。
- 改动：`metric-queries.ts` 的 T0-002 查询按人（dedupe_key）聚合 has_email/has_phone 标记，除原有总数行外，再为每个 workspace 与平台 ALL 各输出三行 `channel` 分层（email_only / phone_only / both，分母仍为 match 账户数）；总数口径与人级去重逻辑保持不变。
- 文档：`docs/metrics/rollup-workflow.md` 指标表注明通道拆分；`docs/metrics/metrics-api.md` §5 更新（/metrics/vric 会以 strict=null + plus.value 的同桶附加项呈现通道行，不合并不推断）。
- 测试：`run.spec.ts` 新增 T0-002 通道 stratum 映射用例（4 行 → 4 个观测、stratumKey 含 channel）；`vitest run src/measurement` 全过。
- 未做：STRICT（T0-001）无通道概念、不改；历史观测不重写（append-only，重跑该日即得新行）；未发车、未部署。

## 2026-11-09 · Enrichment waterfall with attempt ledger, circuit breaker and budget port (#966)

- 起因：P1-08——finder 适配器（P1-07）只解决「怎么调一家」，富集瀑布要解决「按什么顺序买、什么时候停、不重复买、怎么熔断与计费」。
- 改动：
  - 迁移 `20261109180000_contact_enrichment_attempt` + `ContactEnrichmentAttempt` 模型：每次 finder 调用一行（hit/miss/error/skipped_* 都记、成本 micro-USD 照记）；唯一键 `(workspace, provider, request_hash)` 是幂等键；RLS 租户隔离（app_user SELECT/INSERT/UPDATE，email_state 回填用）。
  - `waterfall/enrichment-attempt.ts`：幂等写入（P2002 → SAVEPOINT 回滚 + 回读）与三层复用口径——同输入版本 hit 90 天 / miss-error 24h；同联系人同 provider 的最近 hit 90 天（「90 天内不重复购买」）。
  - `waterfall/circuit-breaker.ts`：15 分钟窗口错误率 >20%（≥5 样本）或连续 5 次失败 → OPEN 15 分钟；到期放 1 个探针（成功 CLOSED、失败重开）；状态存 `data_provider.config.circuit`，存储故障不阻断主链。
  - `waterfall/enrichment-budget.ts`：reserve/settle 端口 + CapBudget（默认 $0.15/联系人）+ CompositeBudget（run 与单联系人取最紧）；P1-10 以 ExecutionBudget Grant 注入同一端口。
  - `waterfall/enrich-contact-email.ts`：编排器——合规前置（contactMayUseExternalProcessing）→ 逐家 finder（data_provider/source_policy 门 + 熔断 + 本地复用 + 预算）→ 命中先验证（双正瀑布；抑制与 lawful-basis 验证门）→ 同事务写入（`upsertProviderEmailPoint` 新写入器 + 每步事件账 + 状态机回写 + attempt.emailState）。停止规则：每联系人 finder ≤3 家、验证 INVALID 继续下一家、UNKNOWN 落库即停并进 24h 重验队列；全部 miss → not_found。
  - `enrichment/provider-gates.ts`：data_provider + source_policy 前置门从再验证 sweep 抽出共用（finder 与验证器同口径）。
- 测试：39 条新单测（attempt 账 TTL/幂等、熔断开合与探针、预算 reserve/settle、编排器 13 个场景：命中双正、INVALID 续买、UNKNOWN 即停、≤3 家上限、预算/熔断/门禁/复用/抑制/无验证器）；enrichment 全套 180 用例绿；漂移门（一次性库重放）零未登记差异；build/docs:verify/governance-verify 通过。
- 未做：HTTP 端点与 run activity 接线（P1-10，含 execution-budget purpose `contact.enrich`）；Apollo/PDL（P1-09）；真实 key 与 scorecard 后翻 ENABLED 是用户决策。

## 2026-11-09 · 域名解析候选与人工复核队列两表（ch03 执行面 3a） (#967)

- 起因：ch03 §3.9.4 的域名解析证据表与复核工单表是执行面（解析 workflow / 池导出）的落库基座；此前只有内存契约（T3-13/T3-15），没有租户级表、权限清单与 RLS 行为证据。
- 改动：
  - 迁移 `20261109185000_company_domain_resolution`：`company_domain_resolution`（业务唯一键 workspace+company+候选域名+route；`selected=true` 仅允许 `status='VERIFIED'`；复合外键随公司级联删除）与 `domain_review_task`（非 OPEN 必须有 decided_at；reason/status 封闭词表），两表 ENABLE+FORCE RLS + `current_workspace_id()` 租户策略，app_user 授予 SELECT/INSERT/UPDATE/DELETE 并同步 `docs/governance/app-user-table-privileges.json`；同公司至多一行 selected 由部分唯一索引兜底（datamodel 不可表达、漂移 diff 忽略部分索引），写入路径另用 company 级 advisory lock 串行化「先清旧选中再选新行」。迁移只入代码，未部署。
  - `apps/api/src/registry/domain/domain-resolution-store.ts` / `domain-review-store.ts`：存储契约（幂等 upsert、仅 VERIFIED 可选中、`clearSelected` 清选中后才可改判终态、工单 OPEN 幂等入队、裁决终态守卫、SLA 超期转 EXPIRED）。
  - `domain-stores.prisma.ts`：Prisma 实现——upsert 用单条 `INSERT … ON CONFLICT DO UPDATE … RETURNING (xmax = 0)`（捕获 P2002 会中止所在事务，不能用）；`selectVerified` 事务内先 `pg_advisory_xact_lock` 再清旧选新。
  - CI「Raw SQL parameter types on PostgreSQL」步骤接入新 postgres 规格（迁移后 `prisma migrate deploy` 真库）。
- 测试：内存契约单测 11 例（校验/幂等/单选中/清选中/终态/超期排序）；迁移静态契约 6 例（词表与 TS 常量对账、FORCE RLS 语句、GRANT 与清单一致、datamodel 关系映射）；真库规格 5 例（app_user+set_config 正向读写、不设 workspace 静默空集、无上下文写入 42501、跨 workspace 不可见/不可写、复合外键 23503、CHECK 23514、部分唯一索引 23505、公司删除级联）；漂移门在一次性库上零未登记差异。
- 未做：解析/复核 Temporal workflow 与池导出（批次 3b）；selected 行回写 `canonical_company.domain`；迁移落库与发车（按授权另行执行）。

## 2026-11-09 · Apollo and PDL finder adapters as an A-tier-only waterfall tail (#968)

- 起因：P1-09——计划 §2.3.3 的瀑布可选尾：Apollo（兜底 + 搜索面）与 PDL（高价值账户身份/字段补充）单价最高，只对 A 档公司（评分 ≥80）开启，不对全量路由。
- 改动：
  - `apollo.provider.ts`：`POST /api/v1/people/match`（x-api-key）；`email_status`（verified/guessed/unavailable/bounced）折算 providerConfidence 透传；`person` 缺失 = 合法 miss（不扣配额）；单名输入不花配额（本地直接 miss）；≈$0.025/命中（25000 微美元，credit 单价未公开待核）。
  - `pdl.provider.ts`：`GET /v5/person/enrich`（X-Api-Key），`required=emails` 计费口径——404 无记录与「有记录但无邮箱」都不扣；邮箱优先 `current_professional`；≈$0.28/record（280000 微美元）。官方域 `api.peopledatalabs.com`（计划里 `api.peerdatalab.com` 为笔误）。
  - `finder-pool.ts`：新增 `resolveConfiguredTailFinderProviders`（Apollo → PDL，只收已配置凭据者）；**尾部不进主池**——调用方只对 A 档公司把尾池拼到主池之后（P1-10 接线）。
  - 登记面：`data_provider.apollo/pdl` seed（DISABLED）+ `source_policy.api.apollo.io / api.peopledatalabs.com`（APPROVED、personalData、purpose=discovery/enrichment）+ SourceClass 清单与治理 registry 条目（providers=31）与生成文档。
- 测试：两套假 HTTP 契约测试（email_status 折算、无记录/无邮箱不计费、单名不花配额、required=emails 查询参数、429/401/域不一致/缺凭据）+ 尾池顺序与「尾部不进主池」断言；finder 全套 45 用例绿；governance-verify providers=31 通过。
- 未做：A 档路由的调用方接线（P1-10）。真实 key 与 scorecard 后翻 ENABLED 是用户决策。

## 2026-11-09 · Enrich-contacts HTTP endpoint with contact.enrich budget purpose (P1-10a) (#969)

- 起因：P1-10（拆 a/b）——富集瀑布（P1-08）与 A 档尾池（P1-09）已就位，需要一个受 ExecutionBudget Grant 管控的 HTTP 入口，把「公司 → 缺邮箱联系人 → 付费 finder 瀑布 → 验证 → 落库」串起来。
- 改动：
  - **执行预算 purpose `contact.enrich`**（subject=company）：TS 面（purpose 联合、binding/verifier 白名单、request scope 新 operation `POST /canonical-companies/:id/enrich-contacts` 与 canonical 请求哈希、quote 的 purpose 枚举/参数变体）+ DB 面两个迁移（enum 加值 `20261109190000`；authority CHECK 与 `consume_workspace_execution_authority` 逐字复制自 `20261108163100` 并追加 contact.enrich 分支，`20261109190100`）。
  - **报价 envelope**：新 operation 进 `WORKSPACE_EXECUTION_QUOTE_OPERATIONS`（12 项）；envelope 只给执行形状（finderCallsPerCompany=10、verificationCallsPerAddress=6、contactsPerRequest=10、providerConcurrency=2、softDeadlineMs=10min）、cap 为表示最小值——付费 finder/验证 API 尚未经 ToolBroker 计价（与第三方验证器同现状），Grant 的 capMicrousd 由端点侧 CapBudget 忠实执行，把供应商单价纳入报价策略表需 gain-saas lane 协调（后续卡）。
  - **端点** `POST /api/v1/canonical-companies/:id/enrich-contacts`（scopes acquisition:write + contact-discovery:read + compliance:manage；Grant 一次性消费；lawfulBasis 必填——缺失在消耗 Grant 前以 `CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED` 拒绝）：body `{lawfulBasis, lawfulBasisRef?, lawfulBasisNote?, contactIds?≤10, maxProviders?≤3, maxProbe?≤6, attemptId?}`。
  - **共享核心** `enrichment/waterfall/enrich-company-contacts.ts`（HTTP 与 run activity 共用）：只取「完全缺 email 点」的具名联系人；每公司 finder 调用 ≤10（跨联系人共享）、软截止 10 分钟、A 档（任一 lead.totalScore ≥80）才追加 Apollo/PDL 尾池；预算 = Grant 授权 cap 与单联系人 $0.15 取最紧；逐联系人调用 P1-08 编排器；PII 访问审计（purpose=contact_discovery）与请求同留痕。
  - `discovery/execution-envelope.ts` 新增 P1-10 执行形状常量（MAX_ENRICH_*、ENRICH_COMPANY_CONCURRENCY、ENRICH_SOFT_DEADLINE_MS、MAX_RUN_ENRICH_COMPANIES，run 接线在 P1-10b 使用）。
- 测试：公司级核心 8 场景（无域/无联系人跳过、B 档不路由尾池、A 档路由尾池、每公司调用上限、软截止、预算为 0 的 skipped_budget）；request scope 两个新哈希钉；envelope 目录 12 项 + enrich 形状断言；quote OpenAPI 变体数 11；execution-budget 全套 531 通过；authz-openapi/operation-descriptions 通过；OpenAPI 重导出（137 paths）；漂移门（一次性库全链重放 + 两个新迁移）零未登记差异。
- 未做：run 内 activity 与 workflow 接线（P1-10b）；供应商真实调用与报价计价（用户/gain-saas lane 决策）。

## 2026-11-09 · P6 CI gate G9 — file size and function complexity budgets (ratchet) (#970)

- 起因：ch08 §3.4 G9：单文件体量与函数复杂度不设预算，长文件持续膨胀（现最大 4,413 行）；需要一道只对新增长生效的棘轮门。
- 改动：`scripts/check-file-budgets.mjs` + CI `build-test` 步骤 + 基线 `docs/governance/ci-baselines/g9-size-budget.json`。规则：>800 行 warn、>1200 行且未登记阻断；函数圈复杂度 >20 warn、>40 且未登记阻断；已登记条目棘轮只降不升，文件/函数降到线下后基线条目必须删除（否则红）。现有超标文件与高复杂度函数全部按现状登记豁免（门先可过，随后逐步收紧）；site-builder 相关条目随 SUB-02/03 退役后删除。
- 测试：本地正反向演示（新建 1,300 行文件 → 红；删除后 → 绿；对基线内文件增量增长 → 红）；`docs/backend/ci-gates.md` 增加 G9 行。
- 未做：复杂度仅解析级近似（不做类型流分析）；前端（gain-saas web）预算在 G10–G12 另行接入。

## 2026-11-09 · Run-pipeline enrichment activity with versioned workflow gate (P1-10b) (#971)

- 起因：P1-10（拆 a/b）——b 把富集接进 run2 深挖流水线：contacts 阶段之后，仅对 fit=match 公司补邮箱（计划 §2.3.4.7）。
- 改动：
  - `discovery.run2.pipeline.activities.ts` 新 activity `enrichContactsForCompany`（withClassifiedFailure 包装）：数据面守卫——无已配置凭据 / data_provider 全 DISABLED / 无 lawful basis 配置（decision_maker.config，与联系人发现同一配置面）时直接跳过，kill switch 期间**不触碰联系人、不写 attempt 账**；通过守卫后预算 = min(run 预算剩余, $0.50/公司)，软截止 10 分钟，runId/run 账户透传公司级核心（P1-10a）。
  - `discovery.run2.pipeline.workflow.ts`：contacts 之后新增版本化步骤 `patched('company-contact-enrichment-v1')` + `fit.verdict === 'match'` + `enrichmentSlot < MAX_RUN_ENRICH_COMPANIES(25)`；富集失败 `.catch` 吞掉——可选增强不把已完成的联系人发现打成 failed（失败仍留在活动历史与 Temporal UI）。
  - `discovery.workflow.ts`：父工作流把深挖批次序号（cursor index）作为 `enrichmentSlot` 传给子工作流（旧历史无此字段，patched() 闸挡住）。
  - `discovery/execution-envelope.ts`：新增 `ENRICH_COMPANY_BUDGET_CAP_MICROUSD=500_000`（调用计数上限之外的第二道钱闸）。
- 测试：activity 4 场景（无凭据/全 DISABLED/无 lawful basis 三跳过 + 通过守卫时 run 账户/basis/软截止/预算 min(剩余,$0.50) 断言，核心以 mock 切面）；子工作流 4 场景（match 触发、mismatch 不触发、slot≥25 与 patched=false 不触发、富集吞错仍 done）；temporal 全套 1440 通过（含 workflow replay 套件）。
- 未做：供应商真实 key / scorecard（用户决策）；报价策略表计价（gain-saas lane 协调）。

## 2026-11-09 · Contact weekly report script, snapshot table and paused Schedule (P1-17) (#972)

- 起因：P1-17（G10 观测）——§2.3.12 的周报 + 三条告警需要可复算的口径与每周落库的快照；「连续 2 周下降」只有留痕才能判定。
- 改动：
  - `enrichment/metrics/contact-metrics.ts`：周报计算层（只读 SQL，可注入 runner）——email_state_coverage、valid_email_company_coverage、enrichment_hit_rate（按 provider）、verification_valid_rate（按 provider）、verification_disagreement_rate、verification_error_rate、catch_all_share、cost_per_valid_email、reverify_flip_rate；发送侧三条（hard_bounce/complaint/send_gate_block_rate）分母在 gain-saas，如实输出绝对计数并标记 unavailable，绝不臆造发送量。分母为 0 一律 `null`（「没有样本」≠「0%」）。
  - 三条告警（`evaluateContactWeeklyAlerts`，纯函数）：VALID 公司覆盖率连续 2 周下降 >3pp（需 3 周序列，缺则 INSUFFICIENT_DATA）、验证错误率 >20%、每 VALID 成本 >$0.09（1.5×$0.06）；Markdown 周报渲染同文件。
  - 迁移 `20261109200000_contact_metrics_snapshot` + `ContactMetricsSnapshot` 模型：平台级运营表（RLS 按 workspace_id 兜底、app_user 按平台默认只读、权限清单登记 ["SELECT"]），每周一行窗口+指标+告警 JSON。
  - `scripts/contact-weekly-report.mts`：CLI（`--since/--until/--workspace/--out/--json/--no-persist`，有 FIRING 退出码 10），与 Schedule 共用计算层。
  - `CONTACT_WEEKLY_REPORT` Schedule 骨架：workflow/activity + ensure-schedules 注册（**paused**，默认 168h）+ worker/两个 workflow barrel/code-intelligence runtime-evidence 与契约图（schedules=14）。
- 测试：指标映射（BigInt→number、分母 0→null、租户参数进 SQL）、三条告警的 OK/FIRING/INSUFFICIENT_DATA、Markdown 渲染、CLI 参数与执行接线（默认窗口/--no-persist/非法窗口）、ensure-schedules（14 个 schedule、新条目 paused、168h 间隔）；temporal+enrichment 全套 1639 通过；code-intelligence 59 通过；漂移门全链重放零未登记差异；G5 RLS 目录门通过（172 表）。
- 未做：告警通知渠道接线（当前进周报正文与快照；看板/渠道由后续切片接）；发送侧三条指标的 SaaS 报告接口；真实数据上的周报需要运营连接跑一轮核对口径后再启用 Schedule（用户决定）。

## 2026-11-08 · Add the SKILL.md package spec v0 with validator and builtin catalog (#833)

- 起因：M1 步 7（S0 Skill Runtime v0）需要让 AI 技能有正式包规范与登记来源；设计见 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`（已批准）。
- 改动：
  - 新增 SKILL.md 严格子集解析器与 manifest 校验：标准字段（AAIF / agentskills.io）+ `metadata.platform.*` 扩展；`task-contract-digest` 钉住执行语义（不含 model，模型属部署策略）。
  - 新增三个存量技能的 SKILL.md（`company.understanding.extract` / `company.understanding.extract_offerings` / `discovery.qualify_fit`）与生成目录 `apps/api/src/skills/generated/builtin-skill-catalog.ts`。
  - 新增 `pnpm skills:generate` / `pnpm skills:validate` 脚本（严格子集解析，无新依赖、未动锁文件）。
- 测试：`apps/api/src/skills` 单测 30 例（解析/校验负向、生成物新鲜度、契约摘要）；全量零容器单测本地通过（两处已知负载假红单跑全绿）。
- 未做：注册表/解析器/adapter 接线（S0-2）与 ops 启停（S0-3）。

## 2026-11-08 · Add the skill registry tables, DB resolver, pass-through adapter and startup seeding (#835)

- 起因：S0 Skill Runtime v0 第 2 步——让三个存量技能真正经注册表解析并写入不可变解析快照，行为保持不变（设计 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`，已批准）。
- 改动：
  - 迁移 `20261108010000_skill_runtime_v0`：新增 `skill_package` / `skill_version` / `skill_enablement` / `skill_resolution_snapshot` 四表（FORCE RLS；平台目录行跨空间可读；版本与快照 append-only；目录仅状态列可被 app_user 更新），并同步 `docs/governance/app-user-table-privileges.json`。
  - 运行时：`StaticSkillResolver`（内置目录，测试/未接线缺省）与 `createDbSkillResolver`（平台状态 + workspace 覆盖 + 契约漂移校验，fail-closed；30s 缓存；内容寻址快照 `ON CONFLICT DO NOTHING`）。
  - 直通 adapter `executeSkillWithRuntime`：解析 + 绑定校验后把输入原样交给既有结构化任务桥；understanding 的 claims/offerings 与 discovery 的 fit 判定改经它执行，prompt/schema/模型/预算/收据逐字节不变。
  - 启动期 seed（worker + relay，owner 连接）：同版本摘要漂移会大声失败（要求 SKILL.md 版本号 +1）。
  - 停用/未登记/契约漂移：understanding 转 Temporal nonRetryable；fit 判定整轮显性失败，不再静默返回空判。
- 测试：单测 55+ 例（resolver 失败码与缓存、adapter 逐字段转发、迁移静态契约、调用点与 worker 接线源级守卫）；真库 RLS service 组 5 例（一次性库实测）；`app-user-table-privileges.postgres.spec.ts` 与 `raw-sql-parameter-types.postgres.spec.ts` 在本机 `global_test` 实测通过；`gctl check --fast` 全绿。
- 未做：ops 启停 API 与文档收尾（S0-3）；租户自定义技能（S3）。

## 2026-11-08 · Add the ops surface for skill enablement and finish S0 documentation (#838)

- 起因：S0 Skill Runtime v0 第 3 步——运营需要能看技能目录并一键启停；收尾模块文档与状态页回写（设计 `docs/superpowers/plans/2026-11-08-skill-runtime-s0.md`，已批准）。
- 改动：
  - 新增引擎 ops API：`GET /api/v1/skills`、`GET /api/v1/skills/:skillKey`、`PATCH /api/v1/skills/:skillKey/status`（平台 kill switch）、`GET|PUT|DELETE /api/v1/skills/:skillKey/workspaces/:workspaceId`（workspace 覆盖）。仅 `ops:read`/`ops:write`，租户 token 403。
  - 重新导出 `packages/contracts/openapi/openapi.json`（新增 5 个端点）。
  - 新增模块文档 `docs/modules/ai-foundation/{product,technical}.md`；`docs/status/current.md` 增加 S0 落地与「尚未发车」说明。
- 测试：controller 授权拓扑（guards/每 handler 的 ops scope 元数据）与参数校验单测、service 生效语义与 404 单测（共 15 例）；`gctl check --fast` 与 `docs:verify` 全绿。
- 未做：gain-saas 运营台页面与租户自助启停（S1+）；实际发车部署（需产品负责人单独授权）。

## 2026-11-08 · Record discovery workflow tuning constants in start input for replay safety (#839)

- 起因：审计 L01（P1）——discovery 工作流的池搜索兜底阈值（20）、深挖并发（16）、查询批大小（2）是模块级常量且参与分支/循环；改常量会让在飞历史重放成不同命令序列（NDE），本周只能靠关 env 开关绕行，调参手段实际被冻结。
- 改动：
  - 新增 `discovery.workflow-knobs.ts`：三个旋钮的冻结默认值、合法区间与输入收敛（纯函数）；`DiscoveryRunInput` 增加 `run2PoolSearchFallbackThreshold` / `deepCompanyConcurrency` / `discoveryQueryBatchSize` 可选字段。
  - outbox relay 启动 discovery 工作流时把三个旋钮**显式**写进启动输入（env `DISCOVERY_POOL_SEARCH_FALLBACK_THRESHOLD` / `DISCOVERY_DEEP_COMPANY_CONCURRENCY` / `DISCOVERY_QUERY_BATCH_SIZE` 可覆盖，非法值回落冻结默认并告警）；旧历史没有字段时按冻结默认重放不变。
  - `raw-retention` sweep 的三个循环上界（`maxBatchesPerWorkspace` / `maxBudgetReconcileBatches` / `maxPagesPerRun`）同样输入化，`continueAsNew` 随输入传递。
  - 新增治理检查 `scripts/governance-workflow-constants.mjs`（并入 `pnpm governance:verify`）：workflow 文件里的模块级数值常量必须带白名单理由，白名单条目过期即失败。
- 测试：新增 `discovery.workflow-knobs.spec.ts`（三旋钮参与控制流 + 非物理输入回落默认）；新增 `discovery-workflow-knobs.replay.spec.ts`（旧历史按冻结默认重放、三个旋钮各自的录制值被重放尊重；忽略输入时 3/4 用例转红）；扩展 relay 路由测试（默认注入、env 覆盖、非整数回落、越界在注入点夹取）；治理检查含仓库自检与**冻结值逐值 pin**（改冻结默认值会直接红）。`pnpm --filter @global/api test`、`pnpm governance:verify` 全绿。
- 未做：deep 阶段的告警阈值（30 分钟 / 失败率 30%）仍为工作流内字面量——它们只影响 stats.alerts，不改变命令序列，未纳入本次；external-intent / kb-recovery / personal-artifact-cleanup / refurbish 的常量已进白名单并登记在 `docs/superpowers/plans/2026-11-08-workflow-constant-input-ization.md`（待输入化清单与验收口径）。治理检查覆盖模块级常量（字面量与 `+ - * /` 常量表达式，如 `15 * 60 * 1000`）；行内字面量、函数调用初始化的常量、对象/enum 内数字仍需人审，规则本身照旧适用。`asset-cleanup.workflow.ts` 的两个计时常量（决定 sleep 命令是否调度）按「代码所有、客户端不可缩短」冻结并进白名单。
- 部署：一旦用 env 覆盖过三个旋钮，**回退到本改动之前的镜像前必须先排空在飞 run**（旧镜像不读这些字段，会用常量重放新历史 → NDE）；未设覆盖值时新旧镜像行为一致，回退安全。

## 2026-11-08 · Raise interactive-transaction budget for governed discovery query commits (#840)

- 起因：run `1541ffd9` 实机故障——`executeQuery` 的 Q-TX（domain-ack 回执 + 百级 raw 记录 upsert + run stats 合并）在共享主机负载下超过 Prisma 交互事务默认 5s 上限（实测 7–8s），活动连续重试失败，目录源整轮记录无法入库（run 卡在 RUNNING、查询收据全零、探针无法取样）。
- 改动：`discovery-query-governed-execution.ts` 导出 `DISCOVERY_RAW_INGEST_TX_OPTIONS`（maxWait 10s / timeout 30s），治理路径与 legacy 路径（`discovery.activities.ts`）的查询入库事务显式使用；无行为/契约变化，只放宽事务时限。
- 测试：`pnpm --filter @global/api build` + discovery 相关单测；样本 run 复跑在发车后验证（收据非零、探针行出现）。
- 未做：canonicalize/materialization 等其它批量事务仍用默认超时（观察项，复现另立）；worker 并发与容量（B12）不在本 PR。

## 2026-11-08 · Onboarding-derived claim drafts to unblock NO_APPROVED_CLAIMS (#843)

- 起因：新用户/新空间的注册引导只落 CompanyProfile + Offering，不产生 Claim；无官网或理解失败时永远没有可审批事实，ICP 生成被 `NO_APPROVED_CLAIMS` 卡死（P5 断点）。
- 改动：
  - `POST /companies` 建档同事务新增档案事实草稿：主营产品 → `capability`、行业 → `company_fact`、目标市场 → `market`，状态 `NEEDS_REVIEW`，证据记「注册引导填写」；不带 `originKey/factKey`，可直接走既有审批（不需要 Site bridge）。
  - 新端点 `POST /api/v1/companies/{companyId}/claim-drafts`（`acquisition:review`，不消费 Grant）：为存量空间/理解失败空间补齐草稿；按归一化语句幂等去重，`REVOKED` 不复活；company 行 `FOR UPDATE` 串行化。
  - 设计文档 `docs/superpowers/plans/2026-11-08-p5-user-loop.md`（P5 三项，本 PR 只含引擎侧 Claim 草稿）。
- 测试：新增 `profile-claim-drafts.spec.ts`（映射/去重/REVOKED/知识来源/空规格）与 `claim.synthesize-drafts.spec.ts`（404/生成/幂等）；`company.service.spec.ts` 增建档派生断言。
- 未做：SaaS 侧通知派生与错误文案表在 gain-saas 仓单独 PR；不从卖家资料库文档抽事实（Phase 3 冻结）；不改 ICP 硬门（产品负责人 2026-11-08 按推荐批准）。

## 2026-11-08 · Add the D-MA-7 memory layer v0 (episodic and semantic tables) (#844)

- 起因：M2.1 规划器要求「先有记忆与归因」；D-MA-7（2026-11-08 批准）要求在 M1.5/M2 之间先落最小记忆层，设计见 `docs/superpowers/plans/2026-11-08-memory-layer-v0.md`（APPROVED）。
- 改动：
  - 新增 additive 迁移：`mem_run_episode`（append-only，run 完成/结果回填两时点）与 `mem_knowledge_stat`（Beta-Binomial 统计，只追加版本，写权只给 `memory_semantic_writer`），含 RLS、`app_user` 权限与 `outbox_event(event_type, occurred_at)` 索引。
  - 新增 `MemoryModule`：outbox 消费者（默认关闭，`MEMORY_LAYER_V0_ENABLED`）把 `DiscoveryRunCompleted` / `LeadsScored` 幂等写成 episode；`MemoryQueryService` 提供 SQL 检索与 ≤2k token、带出处的 memory brief。
  - 未改 discovery activities/workflows、ai-trace、预算账本、gain-saas 与 skill runtime 文件。
- 测试：契约/消费者/检索单测；真库 RLS 与 `app_user` 权限负向测试（含 semantic 写入被拒）；事件重放幂等测试；`docs:verify` 与 `gctl check --fast`。
- 未做：自动调策略、探索流量、Thompson 采样、semantic 生产写入、公共 HTTP API、历史 run 回填（均留 M2.2 或后续）。

## 2026-11-08 · Add the PR-B fetch caches (ETag/304 page cache + content-hash LLM extraction cache) (#845)

- 起因：主计划 §0.2 步 5 / §3.5b PR-B——重复页面重复抓、重复花 LLM 抽取钱。设计见 `docs/superpowers/plans/2026-11-04-http-cache-pr-b.md`（产品负责人 2026-11-08 批准 D-a~D-f）。
- 改动：
  - 新表 `url_content_cache`（FORCE RLS 租户表）：HTTP-first 路径带 `If-None-Match`/`If-Modified-Since`；304 直接复用缓存 markdown（不读 body、不重做抽取），200 写回 ETag/Last-Modified；24h TTL。
  - 新表 `llm_extraction_cache`（FORCE RLS 租户表）：结构化任务结果缓存，键=workspace + task + 契约/prompt 版本 + 注册模型 + 输入全文 digest + schema digest + reasoning；命中跳过网关调用（不计费、不落 ai_trace）；`ACQ_LLM_CACHE=off` 全关断。
  - 缓存只对任务契约声明 `cacheable: true` 的 8 个抽取/判定任务生效；缓存读写失败一律退化为原行为。
  - 过期清理：写入路径按 workspace 清 + `purge_expired_*_v1`（SECURITY DEFINER，只删过期行）+ worker 启动/每 6h 调度；DSR `eraseSubject` 按 workspace 擦除两表。
  - `crawl4ai.fetch` provenance 新增 `cache: miss | conditional-304`（未启用缓存时不出现）；`URL_CONTENT_CACHE=off` 回退无条件请求。
- 测试：http-first 三态与降级、LLM 缓存命中/键隔离/脏数据/env 关断、维护批量与失败降级单测；app_user 权限矩阵新增两表与跨 workspace/purge 真库用例。
- 未做：平台渠道抓取（workspaceId='platform'）不启用缓存（另立项）；PR-C trafilatura sidecar 按设计降级为观察项。

## 2026-11-08 · Governed company lineage for structured discovery sources (lineage v3) (#846)

- 起因：M0 步2 逐源启用（wikidata / openstreetmap / ted / openfda）被 2026-10-11 的血缘闸门结构性挡住——四个源都没有 `companyResultLineage`，`data_provider` 翻 ENABLED 也不进 planner、不路由（`SOURCE_LINEAGE_UNAVAILABLE`）。证据见 `docs/evidence/2026-11-08-m0-step2-source-enablement.md`；设计（产品负责人 2026-11-08 批准）见 `docs/superpowers/plans/2026-11-08-structured-source-lineage-contract.md`。
- 改动：
  - `company-discovery-lineage.ts`：`DiscoveryCompanyLineageProviderKey` 与回执合同新增四键，producerId 即 ToolBroker 工具 id（`wikidata.sparql`/`osm.overpass`/`ted.search`/`openfda.search`），resultSchema 与工具投影一致。
  - `discovery-query-governed-lineage.ts`：运行时 `PROVIDER_CONTRACT` 与 `LINEAGE_DESCRIPTOR.providerContracts` 同步新增四键；v2 合同哈希随描述变为 `7b29dc8f…`（v1 委托哈希 `eb5f6f09…` 与 raw-relation 哈希不变）。
  - 新迁移 `20261108120000_discovery_query_lineage_contract_v3`：`CREATE OR REPLACE` append/attest v2 与 `admit_discovery_company_materialization_v1`（新哈希）；两张表的合同 CHECK 同时接受新旧哈希（outcome/admission 行不可改写，历史行保留旧哈希）。
  - `domain-ack-consumer-bindings.ts`：`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 新增四条（`RawSourceRecord` 聚合，consumer/resultSchema 与 PROVIDER_CONTRACT 一致）。
  - `discovery.activities.ts`：`DISCOVERY_DOMAIN_ACK_PRODUCERS` 补 `ted.search`（其余三个工具 id 原已在集合内）。
  - 四个 provider：声明 `companyResultLineage`，接线 `createDiscoveryCompanyReceiptCollector`（回执转发给活动层回调），成功路径以「单次结算回执覆盖全部记录索引」构造血缘；投影拒绝（`ToolDurableResultProjectionError`，已结算无回执）记 `failed` 观察使空血缘仍有效，其余未知失败保持血缘作废（fail-closed）。
- 测试：新增 `structured-lineage.provider.spec.ts`（四源回执覆盖、回执转发、投影拒绝空血缘、未知失败血缘作废）；更新 `provider.registry.spec.ts`（血缘声明与路由列表）、`discovery.activities.spec.ts`（结构化源进入受治理路由；未注册 source_hint 的 replay 跳过原因）、`discovery-query-lineage-execution-outcome.migration.spec.ts`（v3 迁移断言）与各夹具合同哈希。
- 未做：`openfda-search/v1` 投影 `maxItems: 12` 与 provider 取数口径（≥50 条）冲突是独立缺陷，openFDA 的第③④步启用需先修投影上界；OSM 上游 Overpass 三端点 2026-11-08 不可用，第②步需换窗口重测。两者见证据文档 §5。
- 部署：带迁移的切换走无 run 硬窗口（既有纪律）。上线后四个源仍需 ops 把 `data_provider.status` 翻 ENABLED 并做 dev mini-run 验收（本 PR 不改数据行）。

## 2026-11-08 · Add pack schemas, the first content catalog and the golden-set harness (#847)

- 起因：S1 Pack v1 第 1 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准）——先落不依赖部署的纯模块：四类 Pack Schema、内容目录、冲突裁决与评测骨架。
- 改动：
  - 四类 Pack JSON Schema（Compliance / Data Source / Growth Motion / Industry，共同信封 + 类型化规则）+ 平台语义校验（key/目录/许可 notice/规则 id 唯一）与确定性冲突裁决（优先级排序、forbid 吸收、同层更严格胜出，拒绝项显式记录）。
  - 首批内容目录 7 个：合规（双用途复核）、数据源边界、DACH 分销商动作、金属加工行业，以及 C 档 3 个去营销化内容包（competitive-intelligence / customer-research / pricing，均带 SPDX 与来源 notice）。
  - Golden Set 骨架：评测清单闭集断言词汇（11 种）与零模型执行器；`pnpm packs:generate/validate`、`pnpm skills:evals:validate` 脚本；第三方技能目录一致性 CI（schema + 快照 SHA-256 + 首批 10 个）。
  - `nest-cli.json` 增加 Pack schema 资源复制；根 `package.json` 增 3 个 script（Copy 绑定重签，HASH_ONLY）。
- 测试：新增 30 例（schema 正/负、冲突裁决、内容目录与生成物一致、评测清单与执行器、第三方目录一致性）；`src/skills` 合计 100 例通过；`gctl check --fast`、`docs:verify` 全绿。
- 未做：Pack 表/解析器/策略快照（S1-2，等 S0 发车验收）、Pack Studio（S1-3）、两个新技能与导入 A 档（S1-4）。

## 2026-11-08 · Upgrade the self-hosted Crawl4AI image from 0.9.1 to the 0.9.5 security release (#848)

- 起因：主计划 §3.5b 安全升级（产品负责人 2026-11-08 批 D-f）。0.9.5（2026-10-14）修复 6 个协调披露通告，全部命中自托管 Docker API 的暴露面：CVE-2026-119119（渲染延迟参数无上限的 DoS）、JS 注入（css_selector/wait_for 绕过 js_code 拦截）、盲 SSRF（CacheValidator 绕过 egress proxy）、调用方指定 HuggingFace 模型（pickle RCE）、调用方正则 ReDoS、默认关闭 TLS 校验。设计见 `docs/superpowers/plans/2026-11-08-crawl4ai-095-upgrade.md`。
- 改动：
  - `infra/crawl4ai/Dockerfile`：基础镜像钉到 `unclecode/crawl4ai@sha256:0b056668…`（0.9.5）；构建期断言 `/app/config.yml` 仍含 `wall_clock_s: 300` 与 `max_pages_before_recycle: 200`（浏览器池每 200 页回收、单次抓取 300s 截止）。
  - 既有 egress 补丁（fake-IP DoH 窄回退 + 上游 global-IP 守卫/pinning proxy）、redis 持久化关闭、playwright 浏览器安装全部保留，构建期锚点检查通过。
- 测试：镜像构建 + 容器冒烟（/health、经 pinning proxy 真实抓取、内网地址拒绝）；适配器契约单测由 CI 全量覆盖。
- 回滚：`global-crawl4ai:rollback-0.9.1-20261108` 保留旧镜像；`docker tag … :local` + 重建容器即可回退（无迁移）。
- 未做：不重建/不重启正在运行的 `global-crawl4ai` 容器（发车由产品负责人流程执行）；生产侧 Crawl4AI 运维姿态不并入本仓 wrapper。

## 2026-11-08 · Keep directory records when detail_url fails the stable-URL contract (#849)

- 起因：run `bdb70e30` 的 69 条探针样本全部倒在 `normalize` 阶段——11467.com 名录详情链接含长数字 ID（≥7 位连续数字），被共享的 `CONTACT_LIKE_PHONE` 判为电话样文本，`isStableSafeHttpsUrl` 失败导致**整条公司记录**被拒（该轮 51 条拒绝属此类）。
- 改动：`directory.provider` 新增 `sanitizeDetailUrl`——剥离查询串/锚点后按 `isStableSafeHttpsUrl` 复检，仍不合规则丢弃 `detail_url` 字段而保留记录（该字段为可选富化项）。
- 测试：新增「映射 → 完整载荷契约校验」回流测试（长数字路径/查询串/干净 URL 三例），provider 与 schema 套件 16 例全绿。
- 未做：未放宽共享 `CONTACT_LIKE_PHONE` 正则（保持其它字段的防 PII 严格性）；历史已拒记录不回填，下一轮 run 自然重采。

## 2026-11-08 · Raise the openFDA durable projection bound to the discovery fetch floor (#850)

- 起因：M0 步2 真测发现 `openfda-search/v1` 投影对 `establishments`/`clearances` 设 `maxItems: 12`，而发现 provider 每次至少取 `max(query.limit, 50) = 50` 条——真实 API 响应必被结算投影拒绝（`TOOL_DURABLE_RESULT_PROJECTION_REJECTED`），openFDA discovery 恒零产出；既有单测夹具 ≤12 条掩盖了真实形状。证据见 `docs/evidence/2026-11-08-m0-step2-source-enablement.md` §2/§4.4。
- 改动：`durable-results/source-result-projections.ts` 的 `openfda-search/v1` 两处 `arraySchema(12, …)` 提到 50（与唯一生产调用方 discovery provider 的取数下限一致）；结构性上限仍精确（51 条被拒），120 KiB 应用层字节门不变，作为真正的信封上界。
- 测试：边界锁定测试更新为 50；新增回归——50 条真机形状可投影并逐字节还原且 <120 KiB，51 条被结构性拒绝；真实 API 复测 openfda discovery 恢复非零供给（见新证据文档）。
- 未做：工具侧截断（不需要——50 已覆盖唯一生产调用口径；若未来有调用方传 limit>50，需同步抬升该上界）。

## 2026-11-08 · Renew the production dependency audit baseline to 2027-01-15 (#854)

- 起因：生产漏洞基线 `docs/security/production-dependency-audit-baseline.json` 于 2026-11-14 到期；到期后依赖输入变更的 PR 与 main 的 freshness canary 都会失败，卡住 M0/M1/M2 在飞列车。
- 改动：按 `docs/backend/dependency-refresh.md` §4 的到期续期路径，把 `governance.valid_until` 延到 `2027-01-15T00:00:00.000Z`，并把 `source.base_commit` / `bootstrap.base_commit` 重绑到当前 main（`bf0a7f8d`）、`captured_at` 更新为本次审计时间；锁文件未变（digest 与 2026-11-04 绑定一致）。同步更新 `scripts/supply-chain-gates.spec.mjs` 的基线提交与验证时钟，并冻结旧/新绑定的 freshness 回执到 `docs/evidence/security/20261108-baseline-renewal.json`。
- 测试：`pnpm audit --prod --registry=https://registry.npmjs.org` 零 advisory；`node scripts/supply-chain-audit.mjs verify` = `PASS_CLEAR`；`baseline-freshness` 旧/新绑定均 `FRESH`；`pnpm governance:verify`、`node --test scripts/supply-chain-gates.spec.mjs`、`pnpm docs:verify` 通过。
- 未做：未升级任何依赖、未改 `pnpm-lock.yaml`；下次月度依赖刷新仍会在新窗口内重新审计并续期。

## 2026-11-08 · Classify deterministic ledger failures as non-retryable and mark unknown results (#855)

- 起因：审计 F5/F4（P1）——同一 operation_key 二次 reserve 必撞同一行（REPLAY），但该错误在活动边界仍可重试，Temporal 反复重试把整段活动从头再跑（2026-11-07 run 7662d391 空转约 95 分钟）；同时 settle 双败后行停在裸 RESERVED，一次 DB 抖动即可永久锁死 operation key。
- 改动：
  - 新增 `deterministic-ledger-failure.ts`（纯分类器）与活动边界拦截器：**`BudgetOperationReplayError` 仅 remnant 来源**判确定性（`origin='live'` 保持可重试，重试吸收 remnant/读回已结清结果是 #642 的恢复路径）；BudgetExceededError / BudgetAccountUnavailableError / BudgetUnsettledOperationsError / 投影拒绝错误 / ExecutionBudgetGrantError（除 VERIFICATION_UNAVAILABLE 外整类确定性）/ ExecutionControlError 的确定性码 → nonRetryable（保留 type/code，`isExecutionControlError` 语义不变）；`ExecutionControlError` 的 `*_UNAVAILABLE` 保持可重试。拦截器挂在 customer / platform / dev fast lane 三个 worker 上，挂载由源文本断言钉住。
  - model 网关与 tool-broker 的 settle 双败路径：先尽力 `markResultUnknown`（兜底失败不掩盖主错误），再抛确定性 replay 错误；网关失败路径的 settle 补一次 ACK 丢失重试并记 ERROR trace（`budgetDisposition=RESERVED_SETTLE_FAILED`）。
  - 新增 `docs/backend/execution-budget-ledger-states.md`：RESERVED / RESULT_UNKNOWN / SETTLED（含无结果投影）/ RELEASED 四态的安全动作、清收者与可观测入口。
- 测试：分类矩阵（12 类确定性错误 → nonRetryable；6 类瞬时/普通错误不变）、cause 链包装、控制错误语义保持；拦截器 6 例；网关 settle 双败 3 例；broker settle 双败 2 例。四态矩阵沿用既有 store 测试（replay 重建、RELEASED 再预留、RESULT_UNKNOWN 读回）并在文档中逐态指到用例。
- 未做：B4 的独立清收器（孤儿 RESERVED 的阈值释放/保守结清，并把 RESULT_UNKNOWN 纳入清收）与 B3 的 stale-run 看门狗按 Phase 1 顺序另开 PR；本 PR 不含迁移与 schema 变更。已知窗口：B2 之后、B4 之前，settle 双败留下的 RESULT_UNKNOWN 行会保持占用而不被现有（只清 RESERVED 的）清收器释放，处置见 `docs/backend/execution-budget-ledger-states.md`「已知窗口」。

## 2026-11-08 · Add pack registry tables, strategy resolution snapshots and service-kind skills (#856)

- 起因：S1 Pack v1 第 2 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准；S0 已于 2026-11-07 发车）——把 S1-1 的 Pack 规范落成注册表与运行时解析，并为服务型技能扩出 skill-kind。
- 改动：
  - 迁移 `20261108130000_pack_v1`：七张新表（pack_package / pack_draft / pack_version / pack_activation / pack_enablement / eval_receipt / strategy_resolution_snapshot），FORCE RLS；发布版本/激活/回执/策略快照 append-only，目录仅状态与激活列可 app_user 更新；`docs/governance/app-user-table-privileges.json` 同步。
  - 迁移 `20261108130100_skill_service_kind`：`skill_version` 的 task contract 列可空、新增 `service_handler`，CHECK 保证每行恰好一种绑定。
  - 运行时：Pack registry store（raw SQL）+ `createDbStrategyResolver`（选择器选包、复用确定性冲突裁决、≤2000 字策略简报、内容寻址策略快照、`PACK_VERSION_DRIFT` fail-closed、30s 缓存）；worker/relay 启动期 owner seed 7 个内置内容包（幂等；版本漂移大声失败；只补缺省平台激活）。
  - SKILL.md v1.1：`platform.skill-kind`（model_task | service）、`platform.tenant-default`、`platform.service-handler`（闭集：sanctions.screen.v1 / quoting.incoterms.v1）；service 技能不得绑定 task contract 或声明工具；`tenant-default: disabled` 需显式 workspace 启用（新错误码 `SKILL_TENANT_NOT_ENABLED`）。三个存量技能升到 1.1.0（行为不变）。
- 测试：单测 122 例（pack 选择/冲突/漂移/快照幂等、策略简报确定性、迁移静态契约、service-kind 正负、tenant-default 语义）；真库一次性库实测：RLS service 组 5 例、双 seed 幂等、策略解析与停用过滤、技能 1.1.0 解析、ACL 19 例与 raw-SQL 2 例；`gctl check --fast` 与 `docs:verify` 全绿。
- 未做：Pack Studio ops API 与评测回执写入（S1-3）；两个新技能与导入 A 档（S1-4）；策略简报接入现有检索链路（S1-4 新技能消费）。

## 2026-11-08 · Add the Pack Studio ops API with deterministic evaluation receipts and a publish gate (#857)

- 起因：S1 Pack v1 第 3 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准）——让 Pack 的编辑、校验、试跑、评测、发布、激活/回滚与灰度有可运营的引擎 ops 面，并且发布必须过评测门。
- 改动：
  - 新增 `/api/v1/packs` ops API（ops:read/ops:write）：目录/详情、草稿创建与编辑（可从已发布版本派生）、validate（四类 Schema + 语义 + 单包冲突模拟）、dry-run（按行业/市场/动作选择器解析并给与当前版本的简报差异）、eval（运行 `evals/evals.json` 的确定性用例并写不可变 `eval_receipt`）、publish（要求摘要匹配且 30 天内有效的通过回执）、activate（platform 默认或 workspace 白名单灰度；回滚=激活旧版本）、workspace 启停覆盖。
  - 7 个内置内容包各新增 5 条确定性评测用例（选包/排除、规则摘要、简报上限、内容要点、去营销化），随生成目录进入运行时。
  - 迁移 `20261108140000_pack_version_publish_grant`：`pack_version` 对 app_user 开放 INSERT（Studio 发布），UPDATE/DELETE/TRUNCATE 仍禁止；`app-user-table-privileges.json` 同步。
  - 漂移判定修正：内置目录只钉住同版本的 seed 行；Studio 发布的新版本由不可变版本行与发布门自证（新增单测）。
  - OpenAPI 重新导出（11 个新路径 + Packs tag + 门户正文说明）；ai-foundation 模块文档补 Studio 一节。
- 测试：单测 139 例（Studio core 发布门矩阵/简报 diff、评测执行器 7 包全过与篡改用例失败、控制器授权与参数校验、迁移静态契约含新授权）；一次性真库端到端：草稿→校验→评测 5/5→发布 1.1.0→平台激活→解析器见 1.1.0→停用过滤→未评测草稿发布被拒；一次性容器（CI 口径）ACL 20 例、raw-SQL 2 例、pack RLS 5 例、skill RLS 5 例全过。
- 未做：gain-saas 运营台页面（P6 后置）；S1-4 两个新技能与导入 A 档；模型实测层回执（S1-4 起用于模型技能）。

## 2026-11-08 · Add the two deterministic service skills, imported A-tier skills and the Golden Set CI layer (#858)

- 起因：S1 Pack v1 第 4 步（设计 `docs/superpowers/plans/2026-11-08-s1-pack-v1.md`，S1-D1~D10 已批准；S0 已于 2026-11-07 发车）——落两个新技能（制裁筛查 / Incoterms 报价）、导入 A 档 2 个外部技能的引擎化衍生版，并把 Golden Set 的零模型层接进 CI。
- 改动：
  - 服务型技能接线：`executeServiceSkill` 闭集分派两个 handler——`sanctions.screen.v1`（复用 Qualify 第五门的制裁匹配引擎，只读；索引未启用/为空或名字无可比 token 时如实 `not_screened`；`threshold ∈ (0,1]`；命中 >50 条截断并置 `truncated`）与 `quoting.incoterms.v1`（Incoterms 2020 卖方成本矩阵，BigInt 分整数 + 十进制四舍五入，换算/加价全整数域；`marginPct` 为成本加价；汇率只覆盖单一外币，缺汇率/多外币/goods 缺失/金额越界直接拒绝；L1 只读：无 PI/CI/PL 字段、`humanGate=true`）。
  - 新增 SKILL.md 包：`compliance/sanctions-screen` 与 `growth_motion/incoterms-quote`（skill-kind=service，绑定 handler，不绑任务契约、不声明工具）。
  - 导入管线：`imported/<source-id>/<skill>/SKILL.md` 布局；加载器新增许可（仅 MIT/Apache-2.0）、NOTICE（Upstream/Commit/License/Modified）与安全扫描（禁止任何代码围栏、可执行 HTML/`javascript:`、非 NOTICE 外链、`scripts/` 目录）门，强制 `tenant-default: disabled`，**违规技能不产出目录记录**。首批衍生版 `research.account_research`、`triage.lead_triage`（源自 Anthropic knowledge-work-plugins，Apache-2.0），配新任务契约与 5 条评测用例。
  - Golden Set CI：所有技能（含 S0 三个存量技能新增清单）与内容包各 ≥5 条闭集断言用例；service 技能在 CI 真实执行——制裁筛查用真实匹配引擎（`buildSanctionsIndex`+`screenName`）搭内存索引做精确断言，报价断言精确金额；模型技能以固定选择器下的「策略简报 + SKILL.md 正文」渲染快照钉住摘要（改正文/包内容必须显式重钉）。
  - 生成器/校验脚本扫描 builtin+imported 两个根；技能目录 seed 注册 7 个技能（导入技能默认关闭，`SKILL_TENANT_NOT_ENABLED`，ops 覆盖后可用；静态 resolver 对默认关闭技能一律拒绝）。
- 测试：单测 198 例（报价十进制/整数域数学与拒绝矩阵、制裁 guard/截断/真实引擎评测、导入许可/NOTICE/扫描/scripts 负向与 loader 不产出违规记录、resolver 导入租户启用流与服务 handler 漂移、渲染快照）。脚本 `skills:validate` / `skills:evals:validate` 全绿。
- 未做：模型技能发布层评测回执执行器（S2）；策略简报与导入技能接入现有 run（M2.1）；S1 表/seed 的部署发车需产品负责人单独授权。

## 2026-11-08 · Add a stale-run watchdog and a total execution limit for discovery runs (#859)

- 起因：审计 F2/F12（P1）——discovery 默认路径没有 workflow 总时限、DB 侧没有 stale-run 收尾器：finalize 失败、取消竞态或 worker 排空后，run 会永久停在 RUNNING。活体证据：run `1541ffd9`（2026-11-07 19:12 UTC）在平台鉴权事件导致 worker 排空后取消请求永不生效，发车硬窗口被迫人工改库对账（归档 `_archive/backend-runtime-switch-99845741-xin-20261107/`）。
- 改动：
  - **总时限**：`DiscoveryRunRequested` 的启动参数显式带 `workflowExecutionTimeout=215m`（租约 180m + finalize 余量 10m + 缓冲，与 dev fast lane 对齐）；超时终止后 DB 行由看门狗收尸。
  - **看门狗**：新增 `staleRunSweepWorkflow`（客户侧 sweep 调度器，默认每 10 分钟）：经 SECURITY DEFINER 函数 `list_stale_discovery_runs_v1` 枚举「RUNNING 超过 215m」的 run，逐条 `finalizeStaleDiscoveryRun` 以写一次事务收尾为 FAILED（`stats.failure.stage='watchdog'`、`run_event` 留痕、`DiscoveryRunCompleted` 事件、fit 已判时照旧衔接 `QualifyRequested`）；单条失败不阻塞其余。
  - **finalize 加固（F12）**：看门狗复用 finalizeRun 的行锁+写一次语义——只允许 RUNNING→FAILED，重复/并发调用安全；原 workflow 之后若醒来尝试写其它终态会命中「已终结」冲突而非覆盖。
  - 迁移 `20261108130000_discovery_stale_run_watchdog`：新增 `list_stale_discovery_runs_v1`（app_user-only、参数范围校验、search_path 固定、只返回标识与时间）。
- 测试：workflow 4 例（逐条收尾/输入阈值/单条失败隔离/空集）；活动 3 例（函数映射、写一次事务的更新+事件+run_event、已终结 no-op）；relay 1 例（总时限参数）；调度器既有 spec 覆盖新条目。构建、lint、docs:verify、governance:verify 全绿。
- 未做：基于 Temporal describe 的提前收尸（closed execution 立即收，目前依赖 215m 阈值 + 执行时限保证）留作后续小步；僵尸 run 的 `DiscoveryRunCompleted.cost` 因预算账户键不可重建按 runId 兜底归属（通常为 0，真实花费仍在 usage_ledger），B10 三账对齐时统一。
- 部署：含迁移，需走硬窗口（`gctl switch-backend --with-migrations`）；看门狗调度由 sweep 调度器自动注册（`DISCOVERY_STALE_RUN_SWEEP_EVERY` 可调，默认 10m）。

## 2026-11-08 · Fix the SMTP probe sender identity and retry with a null envelope sender (#860)

- 起因：交接总纲 WP A2——`EMAIL_VERIFY_SENDER_DOMAIN` 缺省 `example.com`（保留域名），EHLO 同域，`MAIL FROM:<verify@example.com>` 被部分 MX 直接拒绝（105 次 `mail_from_rejected`），`email-guesser` 因此把整域短路成不可达，RCPT 裁决率被压低（56% 基线）。
- 改动：
  - 探测发送身份缺省改为自有域名 `gainos.easyiothings.com`（`EMAIL_VERIFY_SENDER_DOMAIN` 可覆盖）；EHLO 参数用真实 FQDN `EMAIL_VERIFY_HELO_HOST`（缺省=发送域）。
  - `smtpRcptProbe` 增加空信封退路：MAIL FROM 被 4xx/5xx 拒时重开一连接以 `MAIL FROM:<>` 重试；返回的 `mailFromCode` 语义 =「产出这些 RCPT 结果的会话」的响应码——工具输出、typed_projection（`smtp-probe-verdict/v1`）、消费者零改动。
  - `smtpRcptProbe` 增加可选 `port`（测试用）；`email-guesser` 的 `mail_from_rejected` 短路注释更新（现在只有两种发件人都被拒才出现）。
- 测试：新增传输层 spec 4 例（真实本地 SMTP 服务器脚本化对话：EHLO 参数与单会话码序、MAIL FROM 554→空信封回退成功、双拒保留被拒码、连接失败降级）；既有工具/provider/guesser spec 全绿（54 例）。
- 未做：Reacher/email-verifier 对照基准与真实德国域复测（RCPT 裁决率 56%→≥90%、`mail_from_rejected` 归零的验收）需部署后用真实出网端口 25 执行；探测 IP 与群发发信域的隔离属 A8（送达性模块建独立子域/IP 池），本 PR 只固定探测身份可配置。

## 2026-11-08 · Align understanding activity timeouts and propagate cancellation into model calls (#862)

- 起因：审计 PERF-02（P1/P2 混合）——understanding 模型活动时限（3 分钟）短于网关模型请求上限（300s），活动先超时、HTTP 请求仍在跑，重试会再发一次付费调用；模型/抓取活动无心跳；活动取消不传播到模型请求。
- 改动：模型活动 3m→**15m**（一次结构化回答可能串初答 + schema 修复两条 provider 调用，2×300s 上限 + 余量，与 discovery 的 15m 口径一致）、抓取活动 3m→5m，均加 `heartbeatTimeout=2m`；`crawlWebsite`/`crawlPages`/`extractClaims`/`extractOfferings`/`extractAndPersistProfile` **全部**包 30s 周期心跳（否则 heartbeatTimeout 会把无心跳活动的预算压到 2 分钟）；三处模型调用都传 `activityCancellationSignal()`（`GenerateStructuredInput.signal` 贯通到 HTTP fetch 的 AbortSignal.any）。重复付费的防线是「活动时限 ≥ 线上最坏路径 + 取消真正掐断请求」——注意重试会以 attempt 编号生成**新的**账本操作键，B2 的 remnant 快速失败只覆盖同一 attempt 内的重执行，不能当作跨 attempt 的护身符。
- 测试：新增源文本断言（超时/心跳常量、signal 传入、心跳包装），既有 understanding workflow/activities spec 全绿；全量零容器单测与治理门禁全绿。
- 未做：ToolBroker `ToolContext` 无 signal 字段，取消传播到**全部工具适配器**属后续小步（随 B12 PERF 群评估）；活动时限的全局审计未做（本 PR 修审计点名的 understanding 路径）。

## 2026-11-08 · Collect unresolved tool-budget operations in an independent sweep (#861)

- 起因：审计 F1——超时 RESERVED 清收挂在 raw-retention sweep 上，workspace 枚举只看 raw 记录是否到期，真实孤儿全部漏收；B2 起 settle 双败留下 RESULT_UNKNOWN，无人清收。
- 改动：
  - 新迁移 `20261108150000_tool_budget_unresolved_collector`：`tool_budget_operation` 增 `unresolved_since`（触发器在进入 RESERVED/RESULT_UNKNOWN 时刷新，D13 再预留因此重新计时）+ 部分索引；`list_workspaces_with_unresolved_tool_budget_v1`（游标分页、只收租户 UUID 作用域、app_user 守卫）；`reconcile_stale_tool_budget_operations_v2`（释放 RESERVED，按 unresolved_since、只碰 microusd 行、先账户 advisory 后行锁）；`settle_unknown_tool_budget_operations_v1`（RESULT_UNKNOWN 按预留额保守结清，账户 reserved→charged 同步）。
  - 新 sweep `toolBudgetReconciliationWorkflow`（每小时、30 分钟时限、游标翻页 ≤4 页）：两个 SINK 独立 try（释放失败不连带跳过结清）、回执严格校验、部分失败 console 告警、全部失败 nonRetryable。
  - raw-retention 用新 patch `budget-operation-reconcile-moved-v1` 停止调度预算清收（旧历史重放不变）；其 `maxBudgetReconcileBatches` 输入保留（旧历史重放需要）。
- 测试：一次性 PostgreSQL 实测（unresolved_since 触发、游标、microusd 过滤、SETTLED 金额、账户余额、守卫）；workflow 6 例 + 活动 5 例 + 迁移静态契约 6 例；既有 raw-retention 重放用例更新。
- 未做：cent 单位的遗留未结行与平台作用域（非租户 UUID）孤儿不在本清收路径内（迁移注释已登记，随 B10 三账对齐处理）。

## 2026-11-08 · Add the agent registry, decision trace table and ops kill switch (M2 step 9b-1) (#870)

- 起因：M2 步 9b 多 agent 编排 v0 第 1 步——先落注册表与决策轨迹地基，行为保持不变（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - 迁移 `20261108160000_agent_orchestration_v0`：新增 `agent_profile`（平台级 agent 注册表：角色提示词版本 + 技能子集 + 模型策略 + 记忆作用域 + loop 策略，FORCE RLS，app_user 仅列级 UPDATE 状态列）与 `agent_decision_trace`（append-only 决策轨迹，F2 字段组子集、无 PII，按 workspace FORCE RLS 隔离，app_user 仅 SELECT/INSERT，`(workspace, run, step_type, discriminator)` 唯一键幂等，随 run 级联删除）；同步 `docs/governance/app-user-table-privileges.json`。
  - `apps/api/src/agents/`：agent 目录（两角色 `discovery.source_scout` / `discovery.qualifier`，loop 恒单回合）、owner 幂等 seed（不覆盖 ops 启停）、DB 解析器（`AGENT_NOT_REGISTERED` / `AGENT_DISABLED` fail-closed，30s 缓存）、决策轨迹 append-only store（唯一写入口 `record`，ON CONFLICT DO NOTHING）。
  - ops 面：`GET /ops-agents`、`PATCH /ops-agents/:agentKey/status`（复用 S0 ops 鉴权 `ops:read` / `ops:write`，租户 token 403）。
  - 启动期 seed：worker（失败大声 `AGENT_CATALOG_SEED_UNAVAILABLE`）与 relay 同步执行。
- 零行为变化：本步不接线任何执行路径（角色化在 9b-2/9b-3），既有召回/评分/预算/重试语义不动。
- 测试：单测覆盖负向 1（未注册拒绝）/2（停用 fail-closed）/4（无 UPDATE/DELETE 路径，源码断言 + 方法面）/6（幂等键契约）；真库 postgres 套件（CI 多 spec job）实测 seed 幂等与不覆盖 kill switch、跨租户不可见、重放不翻行、append-only、随 run 级联删除。
- 未做：源侦察员/资格判定员角色化（9b-2/9b-3）、`GET /runs/:runId/trace` 与前端时间线（9b-4）。

## 2026-11-08 · Candidate batch events and read-only candidate view (QGO step 10-1) (#871)

- 起因：M2 步 10（QGO/SAO/Opportunity 与 Candidate≠Lead）需要引擎侧把「机器候选」从线索语义里剥离出来：候选批次要可追溯（哪个 qualify run、哪一批、判定分布），LeadQualified 要带候选批次引用与证据摘要供下游 QGO 记录「提升时看到的证据版本」。
- 改动：
  - `qualify.activities.ts`：每批（scoreCandidates 分页事务）发一条 `CandidateBatchCompleted`（run_ref/icp_id/batch_no/batch_ref/判定分布/候选 refs，无个人数据），并给每条 lead 的 `score_detail` 写入 `candidateBatchRef = qualify:<runRef>:<batchNo>`；`qualifyWorkflow` 以 `workflowInfo().runId` 注入 runRef（replay 安全；直接调用记为 `qualify:direct:<n>`）。
  - `LeadQualified` 快照升 v2：新增可选 `candidate_batch_ref` 与 `evidence_digest`（资格证据材料 SHA-256），v1 契约文件保留给历史事件；新增 `packages/contracts/events/payloads/lead-qualified.v2.schema.json` 与 `candidate-batch-completed.v1.schema.json`；`CandidateBatchCompleted` 登记进 `INTEGRATION_EVENTS`。
  - 新只读端点 `GET /api/v1/lead-candidates`（`?runId=` 按批次引用前缀 / `?icpId=`/`?queue=` 收窄，游标分页）——不复制表，候选行仍是 lead。
- 测试：`qualify.activities.spec`（每批事件载荷/批次引用写入）、`qualify.workflow.spec`（runRef 注入）、`lead-qualified-snapshot.spec`（v2 契约校验/摘要稳定性/旧载荷兼容）、新增 `lead-candidates.spec`（runId 过滤/投影/空引用/游标分页）。
- 未做：gain-saas 三表迁移与 QGO/SAO/Outcome 端点（10-2）、web 提升入口与 QGO 页（10-3）、E2E-M2.10 联调（10-4）。

## 2026-11-08 · Log PR-B page-cache state so hit rate is observable on real runs (#873)

- 起因：PR-B 设计 §4.5 承诺 `[http-cache] url=… state=…` 结构化日志；实现只带 provenance，而 artifact 绑定路径只持久化 artifact 引用、不保存 provenance，导致 304 命中率在真机 run 上不可聚合。主计划 §3.5b 的「归因看板抓取层页签：304 命中率」指标依赖此日志。
- 改动：`fetchPageHttpFirst` 在缓存 miss（写入路径）与 conditional-304（复用路径）各打一行 `[http-cache] state=<miss|conditional-304> url=<前 200 字符>`；未启用缓存时不打。
- 测试：`http-first-fetch.spec.ts` 断言两条日志行的确切内容。
- 未做：归因看板「抓取层」页签本身（Q33 PR-1 排期）；日志聚合器不在本 PR。

## 2026-11-08 · Widen the frozen v1 lineage provider allowlist for the lineage v3 sources (#874)

- 起因：lineage v3（#846）上线后首个真机 run（`f841d9f1`）在 append 阶段失败——`DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID`。v2 合同换哈希后仍把内容校验委托给 `append_discovery_query_lineage_v1`，而 v1 的**回执 providers 白名单**与**每条 attempt 的 producerId/consumer/resultSchema 三元组**硬编码了 public_web/directory/trade_fair 三个旧源；wikidata 等新源的回执一进 append 就被拒。
- 改动：新迁移 `20261108160000_discovery_query_lineage_provider_allowlist` 用 `CREATE OR REPLACE` 替换 `append_discovery_query_lineage_v1`，只扩两处白名单（四个新源及各自 source_class；producerId/consumer/resultSchema 与 `PROVIDER_CONTRACT`、`DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 一致），并按其创建时机要求以 `pg_temp` 收尾 search_path。v1 合同哈希（`eb5f6f09…`）、命令/回执字段与全部既有校验不变——历史 v1 回执里从不含新源，重放语义不变（纯 widen）。
- 测试：迁移内容断言进 `discovery-query-lineage.functions.migration.spec.ts`（CI 单元门）；一次性库全量迁移 + `app_user` 会话直接 append 一个 `providers=['wikidata']` 的零记录回执——修复前 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID`，修复后 `APPLIED`；同库 RLS 血缘规格 11/11 通过（public_web 不受影响）。
- 部署：本迁移需随下一次发车进入（当前运行镜像 `123e8d67` 的 readiness 要求库最新迁移 = 镜像 `migration_revision`，不能单独热更库）。发车前四源 `data_provider` 已回退 DISABLED，避免计划包含新源的 run 再撞同一失败；修复车后重做步2 的③④。
- 未做：不改引擎代码与合同（本缺陷纯在冻结 v1 的 SQL 白名单）；未新增跨源组合的 DB 级用例到 CI 的常驻 DB 规格（一次性库验证记录了 RED→GREEN，常驻 Guard 由迁移内容单测承担）。

## 2026-11-08 · Classify contact emails and add the company-level contact channel layer (#875)

- 起因：A4（Phase 2 首项）——核心交付是「可转化的分类联系方式」：contact_point 只有 type/value/status，没有邮箱类型（role/personal/sales/procurement…）、来源页、robots/ToS/legal_basis/验证方式/catch-all 记录；公司级只有 URL 层，Impressum 法定公开的 role 邮箱与总机电话没有落点。
- 改动：
  - 迁移 `20261108160000_contact_classification_v2`：contact_point 增 9 列（值域 CHECK、consent_record ≤8KB；personal 与 legal_basis 的组合纪律留在应用层——`allowPersonalWithoutBasis` 是已批准逃生门，DB 不强制）；新表 `company_contact_channel`（公司级联系方式层：email=amber 且 email_type 不得 personal，phone/form_url=green；来源/合规/验证列、幂等唯一键、RLS FORCE、app_user 最小授权并登记权限清单）。
  - 分类器 `discovery/contact-classifier.ts`：多语种（德/英/法/西/意）role/sales/procurement/management/finance/support/personal/other 映射；人名形态才判 personal（red），判不出不冒认。
  - 落库接线：contact-persist（email_type/source_type=provider/source_url/legal_basis/verification_method=provider_reported；sourcePage 不合 DB 形状时降级 NULL，坏 URL 不打挂整家公司事务）、email-guess-persist（personal/pattern_guess/catch_all 与 verification_method 由 verdict.detail 归类——未触网如实记 pattern_guess）；新写入器 `company-contact-channel.ts`（自动化只写 UNVERIFIED、重复观测只推进 last_seen、sourceUrl/长度校验与 DB CHECK 同源）。
  - 合规面：分类器与 cleanEmail 的 red/amber 裁决收敛（info.schmidt 等混合形态判 personal，防按 role 放行误触个人邮箱）；公司主体 DSR 擦除显式清 `company_contact_channel`；`status='VALID'` 强制 updated_by（人工确认留痕）。
- 测试：分类器多语种矩阵+人名/混合形态/判不出边界；写入器分级/拒绝具名人邮箱/幂等/与 DB CHECK 同源的校验；迁移静态契约（九列 CHECK/RLS/权限清单/复合 FK/VALID 标记）；真库契约 spec（`company-contact-channel.postgres.spec.ts`，进 CI PostgreSQL 组：CHECK/唯一键/RLS 读写隔离/级联删除/写入器幂等）；既有 contact/guess 落库与 contacts-stage spec 全绿；全量零容器与治理门禁全绿。
- 未做：A1 Impressum 挖掘器（下一 PR，消费本 schema 与写入器）；历史行回填（nullable 增量生效）；A6 发送合规门（消费 legal_basis/consent_record）。

## 2026-11-08 · Add the restricted campaign planner skill, workflow and campaign.plan budget purpose (#876)

- 起因：M2.1（计划 v1.5 步 9，设计 `docs/superpowers/plans/2026-11-08-campaign-planner-m2-1.md`，D-MA-3/D-M2.1-a~e 已获批）需要引擎侧的受限 Campaign 规划器：只读输入、只产计划、不执行任何动作（影子期结构上不执行），计划经回调交给 gain-saas 做唯一权威的 plan_hash 与审批。
- 改动：
  - 新增 AI Task `campaign.plan`（零工具、humanGate、推理档模型，输出 CampaignPlan v0 JSON，与 gain-saas M2.0 契约逐字段一致）与技能包 `apps/api/src/skills/builtin/growth_motion/campaign-plan/SKILL.md`（model_task，绑定契约摘要）。
  - 新增 `createCampaignPlanningActivities`（只读装配 ICP / 卖家已批准事实 / 公司池聚合计数 / 记忆 brief；经 S0 技能运行时调用；语义硬门 + 一次修复；回调 gain-saas 或失败回写 job）与 `campaignPlanningWorkflow`（装配 → 规划 → 交付，失败回写 `FAILED` + 闭集错误码；负向 4：技能停用 → `SKILL_PLATFORM_DISABLED` 且零模型调用）。
  - 新增引擎内部端点 `POST /api/v1/internal/campaign-plans/draft`（`x-service-token` fail-closed 服务身份 + 一次性 execution-budget Grant），独立 `CampaignPlanModule` 注册。
  - execution-budget 新增 purpose `campaign.plan` / subject `campaign` 与 quote 变体 `POST /campaigns/:campaignId/plan-drafts`（请求哈希绑定 jobId）；`durable-result-strategies.json` 与 `scripts/execution-authority-policy.mjs`、domain-ack 绑定同步登记 `campaign.plan`（`campaign-plan/v1` typed projection；载荷内 `schemaVersion` 仍是 gain-saas 契约的 `campaign-plan/v0`）。
- 测试：新增 workflow 编排单测（顺序、失败回写、非法输入）、活动单测（负向 4 零模型调用、语义越界 → `CAMPAIGN_PLAN_INVALID` + issues、回调 422/网络失败分类）、内部端点/守卫单测（503/401/请求闭合/Grant 失败不启动）、预算 purpose/subject 用例；投影注册表与 domain-ack 计数用例扩展。
- 未做：gain-saas 侧 job 表/三端点/回调幂等与审批 UI（M2.1-2/3）、端到端联调（M2.1-4）；部署需在 worker/API env 配置 `CAMPAIGN_CONTROL_PLANE_URL`、`CAMPAIGN_INTERNAL_SERVICE_TOKEN`、`CAMPAIGN_PLAN_INTERNAL_SERVICE_TOKEN`（与 gain-saas 对侧一致），并在 gain-saas 签发 `campaign.plan` Grant 后才可触发。
- 部署：新增 purpose 属加法；未配置新 env 时内部端点 fail-closed 503、回调活动 nonRetryable `CAMPAIGN_CONTROL_PLANE_NOT_CONFIGURED`，不影响既有链路。回滚：不触发即无行为；表/数据无引擎侧迁移。

## 2026-11-08 · Add the M2.2 golden campaign briefs and the campaign:golden batch runner (#877)

- 起因：M2.2 第 2 步（设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md`，D-M2.2-a~f 已批准）——规划器质量从「人工感觉」变成可回归的基线：golden brief 资产 + 一键跑批（通过率 + 逐条检查 + 叶子字段 diff）。
- 改动：
  - 新增 `evals/golden-campaign-briefs/`：6 条首样板（德吸塑包装 / 美国电子件 / 德国工业零部件各 2，D-M2.2-d），schema `campaign-golden-brief/v1`（brief + 结构化期望：必含/禁含字段、禁含语义、预算上限、决策策略、动作类型白名单）；只含行业/国家级描述，无租户 PII。
  - 新增断言层与跑批器：`apps/api/src/campaign-golden/{golden-brief,golden-evaluate,golden-diff}.ts` 与 `scripts/campaign-golden.mts`（`pnpm campaign:golden`）；支持零模型 replay（CI/变异测试）、live（POST 规划器端点，M2.1 接口就绪后接金丝雀租户）、`--baseline` 叶子 diff、`--out` 结果快照与 markdown 证据模板。
  - 变异测试：改坏产出（预算越界/缺必含字段/出现发送或单证语义/maxReplans 越界）与改坏期望都必须判红（设计 §7-3）。
- 测试：单测 26 例（资产 schema 负向、6 条资产装载、断言层全矩阵、叶子 diff、真实 CLI：replay 6/6 绿、预算变异判红退出码 1、baseline diff 生效、缺参数稳定报错）。
- 未做：live 实跑依赖 M2.1 的规划接口（未接线，届时用金丝雀租户跑首条基线并回填 `docs/evidence/`）；重规划循环与指标页签分别在 M2.2-1/M2.2-3。

## 2026-11-08 · Role-ify the source scout at the discovery fan-out with source.route traces (M2 step 9b-2) (#878)

- 起因：M2 步 9b 第 2 步——把 discovery `executeQuery` 的多源 fan-out 包成「源侦察员」agent 回合：选源决策落 `source.route` 轨迹（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - `executeQuery` 回合门：经 agent 注册表解析 `discovery.source_scout`，未注册/平台停用即 `AGENT_NOT_REGISTERED` / `AGENT_DISABLED` nonRetryable（fail-closed，run 按既有失败语义走）；未接线 `agentRuntime` 的环境保持旧行为。
  - 路由点写一条 `source.route` 轨迹：`chosen_option`=本次路由到的源（含 source_class）；`rejected_candidates`=已注册但未路由的同类源及原因（LEASE_STOP / SOURCE_LINEAGE_UNAVAILABLE / SOURCE_DISABLED / SOURCE_HINT_INVALID / SOURCE_HINT_EXCLUDED，可复活）；discriminator=既有 queryKey（旧回执形状用查询内容哈希兜底），重试不翻行。
  - worker 与 dev fast lane 注入 DB agent 解析器与决策轨迹 store（目录由 managed worker/relay 启动期 seed）。
- 零行为变化：轨迹写入发生在既有路由决策之后、fan-out 之前，召回/评分/预算/重试语义不动；轨迹写失败与既有回执同源的 at-least-once 语义一致。
- 测试：discovery activities 套件新增 5 例（chosen/rejected 内容、hint 排除、零路由 skip reason、AGENT_DISABLED/AGENT_NOT_REGISTERED fail-closed 且 provider 零调用）；worker 接线源级守卫；既有 314 例不回退。
- 未做：golden mini-run 与 E2E-9b 随 9b-2/3/4 全部合入并发车后按设计 §9 执行（需要产品负责人的发车指令）；资格判定员角色化在 9b-3。

## 2026-11-08 · Role-ify the qualifier at quickScan with fit.judge traces (M2 step 9b-3) (#879)

- 起因：M2 步 9b 第 3 步——把 Run 2.0 quickScan 的批量粗判包成「资格判定员」agent 回合：每批判定落 `fit.judge` 轨迹（含被否候选与理由码），技能子集经 S0 resolver 校验（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - `quickJudgeBatch` 回合门：经 agent 注册表解析 `discovery.qualifier`（未注册/停用 → nonRetryable `AGENT_NOT_REGISTERED` / `AGENT_DISABLED`），并按 agent 的技能子集逐个经 S0 resolver 校验；技能不可用（如平台停用）→ 轨迹落 `reason_code` 后原样上抛（fail-closed，不降级不吞判）。
  - 每个批次落一条 `fit.judge` 轨迹：`chosen_option`=批次规模/判定数/verdict 分布；`rejected_candidates`=被否（`VERDICT_MISMATCH`）、被外部处理闸门跳过（`EXTERNAL_PROCESSING_BLOCKED`）、判定失败（`QUICK_JUDGE_FAILED`）的公司引用 id；discriminator=批次 job id 的内容哈希（重放不翻行）。
  - 两个角色共用回合辅助 `agent-round.ts`（解析 + 技能子集校验）；源侦察员侧同步改用它，行为不变。
  - managed worker 把 agent runtime 注入 run2 activities（fast lane 不跑 run2）。
- 零行为变化：轨迹是批次判定后的旁路记录；召回、判定语义、降级路径（逐家/规则兜底）、预算与重试不动；未接线环境保持旧行为。
- 测试：run2 activities 套件新增 3 例（fit.judge 轨迹内容、AGENT_DISABLED fail-closed 零模型调用、技能停用落 SKILL_PLATFORM_DISABLED 后上抛——设计 §8 负向 3）；worker 接线源级守卫；既有用例不回退。
- 未做：golden mini-run 与 E2E-9b 随发车后在部署镜像上执行（需产品负责人的发车指令）；租户 trace 端点与前端时间线在 9b-4。

## 2026-11-08 · Serve the run decision trace to tenants and render the process timeline (M2 step 9b-4) (#880)

- 起因：M2 步 9b 第 4 步——把决策轨迹接到租户与前端：引擎新增 run 轨迹只读端点，gain-saas run 详情内嵌「过程」只读时间线（设计 `docs/superpowers/plans/2026-11-08-multi-agent-orchestration-v0.md`，已批准）。
- 改动：
  - 引擎：`GET /api/v1/runs/:runId/trace`（`acquisition:read`；键集分页 limit 默认 100/上限 200；跨租户 404；返回 step/agent/decision/chosen/rejected/evidence/cost/createdAt）；轨迹 store 增加租户只读列表路径（仍无 UPDATE/DELETE）；接口门户说明表同步。
  - gain-saas：run 详情新增「过程」只读时间线（选源/跳过原因、批量判定与被否候选），经独立租户模块调用引擎（不新增 BFF 注册表条目）。
- 零行为变化：只读端点与前端展示；不改任何执行路径。
- 测试：控制器鉴权拓扑 + cursor 编解码单测；真库（CI PostgreSQL job）跨租户 404 与分页；门户完整性 spec 通过；engine OpenAPI 重新导出。
- 未做：E2E-9b 全链（真实 mini-run → trace 可读 → ops 停用资格判定员 → run 以 AGENT_DISABLED 失败且无模型调用 → 恢复）在发车后的部署镜像上执行，需产品负责人的发车指令。

## 2026-11-08 · Add the S2 outreach skill packs (grounded sequence draft + reply classification) (#881)

- 起因：M2 步 13（设计 `docs/superpowers/plans/2026-11-08-outreach-skills-l2-m2-step13.md`，APPROVED）要求交付「写好这封信 + 看懂回信」的两个 S2 技能；本 PR 为 13-1（技能包与评测），不触碰发送通道/审批实现（步 11 在飞）。
- 改动：
  - 两个 AI task 契约：`outreach.sequence_draft`（subject/body/language/groundedOn/jurisdictionFooter，files-only，humanGate）与 `engage.reply_classify`（7 枚举意图 + 置信度，flash 档）。
  - 两个确定性守卫（`apps/api/src/skills/guardrails/`）：起草的接地/页脚/长度/语言/夸大与引用审批校验（`GROUNDING_REQUIRED` 短路，不接地不产稿；`steps[]` 预留字段必须与顶层稿面一致）；分类的闭集校验、自动回复文本上的 POSITIVE/UNSUBSCRIBE 冲突升级（`AUTO_REPLY_CONFLICT`，防止 OOO 套话触发自动退订）与低置信（<0.6）升级 NEEDS_HUMAN。
  - 两个 SKILL.md 技能包（tenant-default enabled）+ 生成目录；各 12 条 Golden Set（8 条模型层 + 4 条确定性层，含设计 §7 负向 1/2/4/5 具名用例；负向用例的 tier 被测试钉死）；零模型层进 CI，模型层由 `scripts/run-skill-model-evals.mts` ops 实跑并写 `eval_receipt`（成本上限 + 契约 maxTokens + 接地预检先于付费调用）。评测执行器位于 `apps/api/src/skills/eval/`（构建排除，不进 OCI 制品）；`tier` 进入评测清单词汇校验。
- 测试：守卫单测（正向 + 负向码表，含自动回复×UNSUBSCRIBE 对抗）；两技能确定性层逐条执行断言；模型层执行器零网络测试（假 callModel 验证守卫参与断言、接地预检不调用模型、成本上限、prompt 不泄露 guards 数据）；`skills:validate` / `skills:evals:validate` / 生成目录同步门。
- 未做：草稿存储/审批界面（13-2，gain-saas）、逐封发送 L2 门与审计包（13-3）、端到端联调（13-4）。技能未接入任何在飞 workflow。

## 2026-11-08 · Settle LLM cache hits as zero-cost durable receipts so discovery lineage stays valid (#882)

- 起因：P1（2026-11-08 二次 run 失败根因）。LLM 缓存命中在 structured-task-runtime-bridge 内短路返回、不产生 durable 收据；discovery lineage 的不变量把「invoked=true 且未失败且无收据」视为未知结果 → 整条 lineage 作废 → `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`。首轮全 miss 全绿、次轮命中即挂。
- 改动：
  - `RouterModelGateway.settleCachedStructured`（新增，`ModelGateway` 可选方法）：缓存命中按真实调用同构落账——reserve(0) → projection/receiptFacts → settle(0) → onDurableReceipt。回执事实用 `not_incurred`（callCount=0、charged/upper=0），即「本次由缓存供给、未发生物理调用」的机器可读标记；金额零重复结算；Temporal 重试经 reservation replay 幂等返回同一收据。
  - bridge：命中且有可落账网关时走该路径并携带 `durableReceipt`；上下文要求持久收据但网关不支持时按 miss 走真实调用（绝不返回无收据的成功结果）。
  - 回归测试：网关零成本结算/重试幂等、bridge 命中携带收据、lineage 对零调用收据成立（无收据对照仍作废）。
- 测试：网关零成本结算与回执形状（not_incurred/callCount=0/charged=0）、Temporal 重试经 replay 幂等不双结；bridge 命中携带 durableReceipt 且两条 fail-closed（要收据但网关不支持 / 无 durableResultSchema）回落真实调用；lineage 对零调用收据成立、无收据对照仍作废。本地 `nest build` 绿、model-gateway+model-runtime 全套 676 passed/1 skipped。
- 未做：lineage 契约不改（其对「无收据的 invoked 调用不可审计」的判断是正确的）；`ai_trace` 现在会为缓存命中记录一条 provider=llm-cache、cost=0 的 OK 行（此前完全不落）。

## 2026-11-08 · Add the outreach DNC compliance base (11-1) (#883)

- 起因：M2 步 11 受控邮件触达的合规底座（设计 `docs/superpowers/plans/2026-11-08-controlled-email-outreach-m2-step11.md`，APPROVED）：发送前必须同时检查租户禁联名单与跨租户全局抑制，任一命中 fail closed。
- 改动：
  - 新增平台级 `outreach_global_suppression`（只存规范化邮箱 SHA-256，无明文；`app_user` 仅 `SELECT/INSERT`，append-only）。
  - 新增 `OutreachModule`：`POST /api/v1/outreach/dnc/check`（≤50 个邮箱，`compliance:manage`）同时查询租户 `suppression_record`（RLS）与全局哈希表，返回命中来源，不回传明文；服务层提供 `suppressGlobal`（幂等）供 11-4 退订接线。
- 测试：`outreach-dnc.service.spec.ts` 覆盖规范化/哈希、租户与全局命中、幂等、去重、非法邮箱/超批；`app-user-table-privileges` 真库清单随表更新。
- 未做：11-2 邮箱/发送工具、11-3 审批流、11-4 回复/退订端点；本步不发送任何邮件。

## 2026-11-08 · Bound campaign-planning replans to two rounds with a cost cap and NEEDS_HUMAN (#884)

- 起因：M2.2 第 1 步（设计 `docs/superpowers/plans/2026-11-08-campaign-replan-m2-2.md`，D-M2.2-a/b 已批准）——规划器在受控边界内迭代：校验不通过时最多自动重规划 2 轮，人工拒绝后可带理由重生成；超界转人工而不是无限烧钱。
- 改动：
  - `campaign.plan` 契约（向后兼容扩展）：`decisionPolicy.maxReplans` 由恒 0 放宽为 `{0,1,2}`，语义为「提示给出的重规划预算原样回声」；SKILL.md 升 1.1.0 并重钉契约摘要与渲染快照；技能评测新增「重规划预算回声」用例。
  - `campaignPlanningWorkflow` 改为**有界循环**：首轮（或人工拒绝后的重生成，携带 `previousPlan` + 500 字内理由）+ 至多 `maxReplans` 轮校验反馈重规划；每轮独立模型调用与 usage 记账；轮次耗尽仍不合法 → job `NEEDS_HUMAN`（附 `issues` 与逐轮 `replanHistory`），交付成功时把 `replanHistory` 一并交给 gain-saas 落轨迹。
  - 内部端点 `POST /api/internal/campaign-plans/draft` 接受 `maxReplans`/`previousPlan`/`replanReason`（严格校验、64KB 上限）；job 级成本上限 = 轮数 × 单轮契约上限，轮数由 env `CAMPAIGN_PLAN_JOB_COST_CAP_CENTS`（默认单轮 ×3）压低下界。
  - 活动层校验失败不再自行终结 job（返回 issues 由工作流裁决）；控制面回调新增 `state: NEEDS_HUMAN` 与 `replanHistory` 字段（gain-saas 侧接受同名字段后生效）。
- 测试：单测 234 例相关全绿（循环：issues→重规划→交付带历史；轮次耗尽 NEEDS_HUMAN；人工拒绝 round 0 上下文；maxReplans 越界在活动前拒绝；语义硬门要求 maxReplans 等于提示预算）；投影界/执行权威清单复验通过。
- 未做：gain-saas 侧 `NEEDS_HUMAN` 状态、回调字段接受与拒绝触发的自动重生成（下一 PR）；真模型回归（golden `campaign:golden --live`，等 M2.1 金丝雀接线）。

## 2026-11-08 · Add the campaign.plan execution-budget purpose to the engine database contract (#885)

- 起因：M2.1-1 只扩展了 TypeScript 的 `ExecutionBudgetPurpose`；引擎库的 `execution_budget_purpose` 仍是 Postgres ENUM，且 `execution_budget_authority_kind_shape_check` 与 `consume_workspace_execution_authority` 各自维护 purpose/`subject_type` 白名单。发车后的 --live 联调在消费 Grant 时以 `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE` 失败（DB 侧拒收新 purpose），设计 §10「引擎无迁移」的判断与 as-built 不符。
- 改动：按 outreach.draft / platform.channel_crawl 的两段式先例补两条 forward-only 迁移：
  - `20261108163000_campaign_plan_purpose_enum`：`ALTER TYPE ... ADD VALUE IF NOT EXISTS 'campaign.plan' AFTER 'outreach.draft'`（单独事务，PostgreSQL 限制）；
  - `20261108163100_campaign_plan_purpose_use`：重建 kind-shape CHECK（逐字复制自 20261105001000，仅追加 `'campaign.plan'` 值与 `("purpose"='campaign.plan' AND "subject_type"='campaign')` 对）与 `consume_workspace_execution_authority`（逐字复制自 20261028183000，仅追加同一对）；无回填、不删表/列。
  另加文本级迁移 spec `campaign-plan-purpose.migration.spec.ts` 钉住两段式结构与关键不变式。
- 测试：在 5432 的临时库上按序重放全部 183 条基线迁移 + 本两条迁移，实调 `consume_workspace_execution_authority`：campaign.plan/campaign 成功入账；outreach.draft/lead 回归成功；campaign.plan/lead 被 `EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH` 拒绝。临时库已删除。
- 未做：不改 Prisma schema 的 `ExecutionBudgetPurpose` 枚举（先例：outreach.draft / platform.channel_crawl 也只在 DB 侧扩展，该表走原始 SQL 函数，不经 Prisma 枚举写入）。部署须随携带本迁移的镜像 `migrate deploy`（`MIGRATION_REVISION_MISMATCH` 门要求 DB 迁移集与镜像 revision 一致），单独手工灌迁移会让在跑镜像不就绪。

## 2026-11-08 · Mine Impressum and legal pages for classified company-level contacts (#888)

- 起因：A1（Phase 2 第二项，产品负责人最关心的「德国邮箱覆盖率 70–90%」核心）——现有 public_web 只按首页链接正则抓 contact/impressum 页、从 markdown 抽邮箱电话，JSON-LD/cfemail 等 HTML 面形态与固定路径探测都拿不到；抽出的联系方式只进联系人层，没有公司级 role 邮箱/总机落点。
- 改动：
  - 新模块 `discovery/impressum/`：cfemail XOR 解码、schema.org JSON-LD contactPoint 抽取（Person 子树整体跳过）、文本混淆解码（[at]/[dot] 等）、HTML 实体解码（`info&#64;…` 防爬形态）、电话归一（`+49 (0)89` → `+4989`；非 DE/AT/CH 不猜国别）、法律页发现（链接评分 + DE/AT/CH 固定路径探测）、公司级渠道装配器（本站域/同组织域邮箱；personal 不进公司层；每条带来源页/来源类型/robots 留痕）。
  - `public_web` provider：Impressum/联系页改用 `crawl4ai.render` 取渲染后 HTML（JSON-LD/cfemail 取数面；内置 robots 强制），失败回退 markdown；产出 `companyChannels`。
  - `contact-discovery-core`：adapter 契约扩展可选 `companyChannels`，在**同一事务**内经 suppression 复读过滤（email/domain 规范化比对）后调 A4 写入器落 `company_contact_channel`；`crawl4ai.render` 加入联系人发现的持久回执生产者名单。
- 测试：抽取原语 25 例（cfemail/JSON-LD/混淆/ät/实体/电话矩阵/回溯与越界鲁棒性）、法律页发现 7 例、装配器 11 例（同组织域/冒充域/实体/缩写/失败安全）、provider 接线 1 例（渲染页 → mailto/tel → 公司级渠道、personal 剔除）、core 落库 3 例（suppression 过滤、公司被抑制不写、无渠道不写表）；既有 public-web/contacts-stage 全绿。
- 未做：A6 发送合规门；SMTP 验证（A2 范围）；JSON-LD 的 Person 型条目（个人数据只走联系人层）；展会/协会源（A10）。
- 审查修订（独立审查，2026-11-08）：`crawl4ai.render` 加入 contact.find_decision_makers 白名单（缺它时 ToolPolicyDenied 会把整次联系人发现打成失败）；渠道值 fail-safe 清洗（网页可控值不 throw）；公司被抑制时不写渠道；混淆正则改有界量词（40k 串 38s→毫秒）；同组织域改词根完全相等并拒冒充域；单段缩写（ds@/mm@）不冒认公司渠道；技术预算信封补 render 计数（fetch 14/render 8）；页数预算 2→4 且固定路径给全变体。

- 证据：`docs/evidence/acquisition/impressum-miner-2026-11-08.{json,md}`（dev 库 20 家 DE 真实样本：可达 Impressum 19 家，邮箱+电话双命中 11/19 = 57.9%——**DoD ≥80% 未达**；差距归因、脚本参数与产品默认的差异、后续项见 md）。

## 2026-11-08 · Rename the outreach compliance migration after the already-applied campaign purpose migrations (#890)

- 起因：`20261108160000_outreach_compliance`（#883）合入晚于 `20261108163000/163100` 的两笔 campaign purpose 迁移，名字时间戳却更早；它在目标库尚未应用，一旦按顺序补上，运行时「按 finished_at 取最新已应用迁移」将与镜像「按名字取最新迁移」不一致，触发 `MIGRATION_REVISION_MISMATCH`（switch-backend 前提门实测拦截）。
- 改动：目录改名为 `20261108180000_outreach_compliance`（内容不变；该迁移从未在任何环境应用过，改名对已有回执零影响；代码/脚本无对该目录名的引用）。
- 测试：CI 迁移治理门与 db tests 覆盖；部署随下一班镜像以 `--with-migrations` 正常补上。
- 未做：不触碰任何已应用迁移的历史。

## 2026-11-08 · Stop artifact failures from leaking bare RESERVED budget operations (#891)

- 起因：run aae4a06a（400 家规模）以 `BudgetOperationReplayError / BUDGET_OPERATION_REPLAY_UNAVAILABLE` 终止。现场取证：`tool_budget_operation` 留三行 `RESERVED attempt=1`、无 artifact 行；worker 日志同秒三次 `[tool-broker] ERROR crawl4ai.render artifact settlement failed: GenericOperationArtifactError`，且**没有** `[artifact] … persist failed` 行——异常发生在 adapter 的 payload 契约校验（`crawl4ai-render/v1` 对空/非 HTML 渲染体 `invalid()`，run 当时多站反爬失败返回空 HTML），**先于** GenericOperationArtifactService.persist；broker 的 artifact catch 只抛 `BudgetOperationReplayError(origin='live')`，预留留成裸 RESERVED → 同 attempt-correlation 重放永远读到「已存在但无持久结果」→ Temporal 重试撞同一行 → 控制类错误把 run 打成 FAILED。（并发共享空对象 promote 竞态是同时期暴露的次要触发面，一并硬化。）
- 改动：
  - `ToolBroker` artifact catch：无论失败发生在管线哪一层（adapter payload 校验 / service 校验 / store 竞态），都先尽力 `markResultUnknownAfterSettleFailure(reservation)`（已有 SERVICE 快照标记时由其幂等吸收），日志补错误码/消息与标记结果。**artifact 管线失败不再产生裸 RESERVED。**
  - `GenericOperationArtifactService.persist`：`*_ACK_UNKNOWN` 仍由阶段内带快照标记；其余 `ArtifactStorageError`/`GenericOperationArtifactError` 兜底标 RESULT_UNKNOWN 后再抛原错误（broker 层为最终保证，service 层保留以尽量带上快照）。
  - `recoverPromote`：IfNoneMatch 输竞态且赢家对象尚不可见 → `PROMOTE_ACK_UNKNOWN`（自竞态），不再误报契约类 `INVALID`；顺带删除已无意义的 `preconditionFailed` 参数。
- 效果与边界（如实声明）：
  - 收益：预留不再以裸 RESERVED 长期占 cap、也不会在收集器释放后因 D13 再预留而**二次物理调用**；账本状态真实（RESULT_UNKNOWN 可被 B4 收集器按阈值结清）。
  - 不变：同键重放的结局与之前一致（`reserve_tool_budget` 对任何已存在行都返回 REPLAY → broker 报 remnant/unavailable）——本 PR 不是让失败调用「自动成功」；它消除的是**预留泄漏本身**（长期占 cap、收集器释放后经 D13 再预留的二次物理调用风险、账本状态失真）。首次失败仍是 `origin='live'`（可重试，符合 #642 设计）。
  - 已覆盖：artifact 结算事务内抛出的 `ExecutionControlError`（`DURABLE_EXECUTION_RECEIPT_FACTS_INVALID/REQUIRED`、`DOMAIN_ACK_RECEIPT_REQUIRED`）从 persist 冒出后同样被 broker 兜底按**无快照**标 RESULT_UNKNOWN（行不再裸 RESERVED；但这类行不可经 recoverUnknown 恢复，收集器按预留上限结算——B4 既有保守语义）。
  - trace 语义：双标记（service 已带快照后 broker 再标）会被 `mark_tool_budget_result_unknown_v2` 拒绝并吞掉，此时 trace 记为「fallback did not apply (already marked or ledger unavailable)」——不谎报状态。
- 测试：service spec 更新旧契约断言（pre-ack/校验拒绝同样必须标 RESULT_UNKNOWN）+ 兜底自身失败仍抛原错误；store spec 新增 `precondition_uncommitted` 注入（412 且赢家不可见 → ACK_UNKNOWN）；broker spec 断言 artifact 失败必 markResultUnknown（含兜底自身失败的边界）。受保护文件 tool-broker.ts 已重钉 sha256 并在 PR 记录审查。
- 未做：adapter payload 契约（如空 HTML render）本身应当更早失败/降级的问题（属 discovery 侧语义，另议）；共享对象 promote 的彻底串行化。

## 2026-11-08 · Widen the campaign-plan durable projection bound to maxReplans {0,1,2} (#892)

- 起因：M2.2 把 CampaignPlan v0 的 decisionPolicy.maxReplans 放宽到 {0,1,2}（gain-saas #84），但引擎 durable 投影（campaign-plan/v1）仍钉 min=max=0、enum [0]——maxReplans≥1 的计划被投影门整体拒绝为 ModelDurableResultProjectionError，decline→replan→NEEDS_HUMAN 联调因此 FAILED（2026-11-08 金丝雀实证：同分钟 maxReplans=0 的 6 条 golden 调用全 OK）。
- 改动：model-result-projections.ts 的 maxReplans 约束放宽为 numberSchema(0,2) + enum [0,1,2]；bounds spec 同步 maximum:2。
- 测试：durable-results 投影两套件 138 过（15 跳过）；真机验证随下一班镜像的 decline 联调重跑。
- 未做：不改投影其余字段与投影门语义；旧计划（maxReplans=0）向后兼容不受影响。

## 2026-11-08 · Expose platform-wide DNC suppression endpoint (#896)

- 起因：M2 步 11-4 需要把退订/投诉/退信事实写进平台级抑制表，跨租户阻止后续发送。
- 改动：新增 `POST /outreach/dnc/suppress`（`compliance:manage` + 控制面服务令牌 `OUTREACH_INTERNAL_SERVICE_TOKEN`），复用 `suppressGlobal`，只落邮箱 SHA-256、幂等；OpenAPI 重新导出。
- 测试：`src/outreach` 单测 9/9（含服务令牌 503/403/放行）；构建与 OpenAPI 导出通过。
- 未做：gain-saas 侧的调用接线在 gain-saas 11-4 PR；真实域名验收属 11-5。

## 2026-11-07 · Make name_country identity keys ASCII-safe for the materialization contract (#829)

- 起因：目录源记录首次批量入库（266 条，2026-11-06 run `8c8f6d65`）后，run 在 canonicalize 阶段以 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID` 失败。堆栈定位：物化快照契约的 `itemPlan` 用 `^[a-z][a-z0-9._:-]{0,255}$` 校验 `companyParse.dedupeKey`，而 `companyIdentity()` 的无域名 `name_country` 键是 `n:<normalizeCompanyName(name)>:<country>`——含空格或非 ASCII（"müller gmbh"、中文名）即整批拒绝。该生产者/校验器格式从未对齐过（存量 `canonical_company.dedupe_key` 零条 name_country 行，此前从未走到这条路径）。
- 改动：`name_country` 键按名称分派——纯 ASCII 单词名保持可读的 `n:<name>:<country>`（既有行为与测试不变）；名称含空格/非 ASCII 时改用 `n:h<sha256>` 形式（65 字符、ASCII、确定）。键只参与相等比较（无反向解析），跨 run/跨来源等值语义不变。
- 测试：`identity.spec` 新增中文名/含空格名 ASCII 合规、同名稳定、异名区分、纯 ASCII 保旧格式；identity + discovery-company-materialization 相关 208 用例全绿。
- 未做：不改物化契约的模式（协议 sha 不动）；不回溯存量（存量无 name_country 行）。

## 2026-11-07 · Add an opt-in probe that names the failing clause of a rejected raw payload (#830)

- 起因：目录源真实 run（`d51431d8`，镜像含 #828/#829）中 361 条入库、109 条仍 `PROVIDER_PAYLOAD_SCHEMA_INVALID`；用同一批 LLM 抽取产物本地重放 646/646 全过，静态无法定位生产拒绝形状，需要受控取样。
- 改动：`validateRawSourceProviderPayload` 在 `RAW_SOURCE_SCHEMA_PROBE=1` 时，对拒绝载荷输出一行 `[raw-source-schema-probe]` JSON——只含失败子句名（externalId/companyName/domain/country/attributes/bindings/identifier/provenance/license/…）与**无字段值**的结构摘要（字节数、词数、NFC 是否漂移、键集合、detail_url 的 scheme 类别）。探针开关默认关闭，关闭时行为与性能不变；日志写入用 try/catch 包裹，探针失败绝不改变校验结果。
- 测试：新增 `raw-source-provider-schema-probe.spec`——失败子句名正确、日志不含任何字段值（名称原文断言不出现）、开关关闭时零输出；boundary/ingestion 既有 142 用例全绿。
- 未做：未启用 env（随下一班车按需开启取样，取到形状后修复并关闭）；未改校验语义（纯重构为具名检查 + 探针）。

## 2026-11-06 · Admit platform channel-crawl fetches transiently and record crawl_run_id (#821)

- 起因：2026-11-06 发车后的 ProPak Asia preview 验收发现渠道抓取从未真正出网——ToolBroker 的 G3 主体绑定闸门拒绝 `crawl4ai.render`（渠道抓取没有也不应有公司/联系主体，此前每轮 failures=1 未被察觉）；同时 `source_channel_run.crawl_run_id` 从未写入，迁移为 finalize 准备的重试幂等唯一列一直为 NULL。
- 改动：
  - 新增关闭集合的瞬态结果作用域 `platform_channel_crawl`：工具声明（`crawl4ai.render`）+ 调用方声明 + ToolBroker 校验（必须 platform 工作空间、非 paid、已声明），放行时原始 HTML 解析后丢弃、不落 PERSONAL_DATA artifact，按普通成本路径结算；tenant/未声明工具/未知作用域一律 `TRANSIENT_RESULT_SCOPE_DENIED` 失败关闭，已结算的瞬态操作重放按 remnant 失败而不重发出网。
  - `finalizeChannelCrawl` 传递 `crawlRunId`；`recordChannelRunInTransaction` 按 `crawl_run_id` 唯一键幂等收敛（重试更新同一行、不重复推进 failureStreak），无 `crawlRunId` 的旧调用方路径不变。
  - ToolBroker 属受保护组合：已按治理要求审查 authority/budget/receipt/egress 绕过面并重钉 sha256（`docs/governance/durable-result-strategies.json`）。
- 测试：broker 瞬态作用域矩阵（放行/tenant 拒绝/未声明工具/未知作用域/replay remnant）、渠道抓取活动 context 与 finalize payload、记录器幂等收敛；目标套件 79/79、全量零容器单测通过（仅一个已知负载假红单独复跑通过）。
- 未做：`sanctions-download/v1` 的平台作用域 hold 维持现状（需单独立项）；无 schema 迁移；不改收据、Grant/R4 链与 egress fence。

## 2026-11-06 · Decode HTML entities in channel extraction and make the crawl page timeout env-tunable (#822)

- 起因：ProPak 渠道选择器调整后发现两个小缺陷——`html-select` 不解码 HTML 实体（公司名落库为 `A&amp;D`）；crawl4ai 的单页导航超时硬编码 45s，对 1MB+ 慢站（实测 25–45s）贴边，preview 的成败取决于站点时延。
- 改动：`html-select.nodeText` 统一解码命名与数字实体（整棵子树收集后只解码一遍；未知实体原样保留、非法码点不转换）；`crawlHtml` 的 `page_timeout` 改读 `CRAWLER_PAGE_TIMEOUT_MS`（默认 45000，钳制 5s–70s——上限低于 `/crawl` 的 75s 客户端中止与 discovery 租约计量基准，超过只会先在客户端超时并把慢页计成失败）。
- 测试：实体解码单测（命名/十进制/十六进制/未知/非法）、超时解析单测（默认/覆盖/钳制/非法）。
- 未做：条目内字段选择器（展位/国家/website）需要爬虫 v1，另行设计；不改渠道抓取的行为契约。

## 2026-11-06 · Keep a verified capability snapshot through blips and recover drained workers automatically (#823)

- 起因：2026-11-05 发车 #822 时，一次约 30 秒的 gain-saas 能力快照抖动让 platform-worker 按 fail-closed 立即排空；排空后的进程没有退出，容器存活但不再轮询约 1 小时（租约表：19:20:15 排空后 63 分钟无新实例注册），平台工作流停摆直到人工重启。
- 改动：
  - `platform-capability-cache.ts`：刷新失败不再清空最后一份已验证快照；`check()` 仍按签发方 `validUntil`（≤30s）截止。
  - `platform-capability-runtime.ts`：普通刷新失败不再丢弃缓存对象；失败后 2s 快速重试，成功后回到 10s 节奏（身份/pin/机器令牌失效仍立即清空）。
  - `worker-shutdown-policy.ts`（新）：`shutdownGraceTime` 30s / `shutdownForceTime` 60s / 关停清理 15s 强制退出兜底；两个 worker 的 `Worker.create` 与 finally 接入。
  - 客户 worker：启动门改为覆盖完整依赖检查（`requireReady:false`），与 platform-worker 一致——重启后在 STARTING 等待依赖恢复并自动重新准入，不再永久 hold。
  - `worker-dependency-admission.ts`：迁移修订不一致改为 `drainImmediately`（读失联仍走 3 连败容忍）；两个 worker 的稳态检查接入。
  - `worker-dependency-heartbeat.ts`：排空时输出一条结构化事件（role/taskQueue/code/连续失败数/时间）。
  - `gctl doctor`：新增「运行租约」检查（最新非 READY 或心跳 >120s 警告；24h 内 STOPPED/DRAINING 信息行）；RUNBOOK §14。
- 测试：capability cache/runtime、heartbeat、dependency-admission、shutdown-policy 单测；`gctl check`。
- 未做：传输层对 gain-saas 401/403（鉴权拒绝/绑定过期）的独立危险码分级（后续项）；发车后的 90s 受控演练（需发车授权）。

## 2026-11-06 · Settle discovery run cost into events and bind discovery-stage artifacts to the seller profile (#824)

- 起因：`$15/30 天`花费上限因 `cost_ledger` 恒 0 实际未生效（1b 花费维度补口，设计 2026-11-06-cost-dimension-settlement）；同批真实 ICP 对比跑还暴露 discovery 阶段抓取被 G3 主体绑定闸门拒绝（directory 的 10 条查询因全部抓取被拒而零产出）。
- 改动：
  - `ai-trace.sink` 为 `usage_ledger` 补成本基准：provider 上报优先，否则按 `LLM_CENTS_PER_MTOK` 的 token 上界折算（`meta.costSource` 标注；`centsFromTokens` 抽到共享模块，与预算 settle 同口径）；已结算（非 `RELEASED_*`）的失败调用同样落成本行（`meta.status='ERROR'`），失败花费不再对上隐形。
  - 网关所有 trace 记录点透传 `ctx.runId`，sink 写入 `usage_ledger.meta.runId`；discovery finalize 按 `meta.runId` 汇总本 run 成本进事件载荷（`cost` + `costBasis=usage_ledger-runid/v1`），替代初版时间窗聚合（并发 run 双计 / 事务 now() 漏计，均为自审确认缺陷）。
  - discovery 阶段 ExecutionContext 绑定卖家 `company_profile` 作为 `artifactSubject`（`ArtifactSubjectRef` 明确允许该主体），修复 directory 等发现源抓取被主体绑定闸门拒绝、结构化源零产出的问题。
- 测试：token 折算单测、sink 成本基准（provider 优先/折算/标注/失败调用/释放不记）、finalize 载荷按 runId 归属断言（含 SQL 过滤条件）、发现阶段主体透传断言；目标套件与全量零容器单测通过。
- 未做：gain-saas 消费端成本落账与 `cost_ledger (workspace_id, source_event_id)` 唯一约束随另一 PR 提交（D-b/D-c/D-d 的 SaaS 半）；精确价目表列为后续项。发现阶段主体绑定的合规姿态（company_profile 非 DSR 主体）见 PR 讨论。

## 2026-11-06 · Filter run-cost aggregation by the run's budget account key (#825)

- 起因：真实 ICP 验证 run（86cb6ab4，镜像含 #824）事件 cost=0。discovery 链路的 `ExecutionContext.runId` 是预算账户键 `binding.accountKey`（`discovery.run:discovery_run:request:<sha>:<sha>`，每 run 唯一），sink 写入 `usage_ledger.meta.runId` 的也是它；finalize 却按 run UUID 过滤，永远匹配不到（实查该 run 77 条成本行全部挂在账户键下）。
- 改动：finalize 从 `args.executionBudget` 解析 `accountKey` 作为过滤键（解析失败回退 run UUID，等价不计）。设计文档 D-a 记 v2.1。
- 测试：finalize 归属用例断言过滤参数为 `DISCOVERY_BINDING.accountKey`；`discovery.activities` 全量通过。
- 未做：不回溯已发出的 cost=0 事件（该 run 属验证跑，无需补账）；上线前的存量调用仍无归属键。

## 2026-11-06 · Directory discovery searches Chinese markets in Chinese (#826)

- 起因：真实 ICP（东莞盛源鑫/真空吸塑，中文市场）两轮对比 run 中 directory 结构化源 10 条查询零产出。复现确认：`buildDirectorySearches` 用无语言参数的 `searchableTerms` 把中文行业/关键词整段剥掉，检索串退化为 `manufacturing members directory 中国`；SearXNG 实测返回无关页面（含成人站点）。名录识别 `LISTING_HINT` 也不含中文名录/黄页词。
- 改动：`buildDirectorySearches` 按 `searchLanguageFor(query)` 选词与意图词族——zh 市场保留中文主题词与中文地区词（珠三角等），意图词改用中文名录词（企业名录/会员企业名单/参展商名单/供应商目录）；其它市场维持旧行为。`searxng.search` 的 `language` 从硬编码 `en` 改为目标市场语言。名录识别抽成可测的 `isDirectoryListingShaped`，正则补中文名录词（名录/黄页/企业库/企业大全/参展商/会员企业/供应商目录）。
- 测试：`directory.provider.spec` 新增中文市场检索串、纯中文关键词、中文名录识别三组用例；既有非中文市场的期望不变。
- 未做：未动 NOISE_DOMAINS（无关/垃圾站点仍由列表抽取 LLM 判 `is_directory` 丢弃）；directory 产地内条目字段（展位/国家/website）仍属爬虫 v1。

## 2026-11-06 · Accept directory records mined from www-hosted listing pages (#827)

- 起因：中文检索修复（#826）发车后真实 run（3875b96e）directory 成功抓到名录页并抽取 41 条公司记录，但全部 `PROVIDER_PAYLOAD_SCHEMA_INVALID` 被拒、run 以 `ExecutionControlError`（stage=query）失败。复现确认：`validProviderBindings` 对 directory 要求 `provenance.sourceUrl` 的 host 与 `attributes.source_directory` 全等，而后者由 `normalizeDomain` 生成（去 `www.`）；凡名录页托管在 www 主机（本轮 cmpe360.com）记录全灭。
- 改动：directory 绑定分支对 host 做同一规范化（小写、去 `www.`）再比较；跨站 sourceUrl 仍被拒绝（伪造来源不会放行）。
- 测试：`provider-raw-boundary.integration.spec` 新增两条——www 名录页记录 ACCEPTED、sourceUrl 指向他站仍 REJECTED。
- 未做：不改其它 provider 的 host 全等比较（wikidata/openstreetmap/ted/openfda 的 host 断言含 `www.` 字面量，行为不变）。

## 2026-11-06 · Give directory records ASCII-safe external ids for Chinese company names (#828)

- 起因：中文检索（#826）+ www 绑定（#827）发车后真实 run（bbe2d4f3）directory 抓到 1878 条记录仍全部 `PROVIDER_PAYLOAD_SCHEMA_INVALID`。定位：无 website 的记录 externalId 为 `directory:<源站>:<slug(公司名)>`，`slug` 保留汉字（`\p{L}`），而外部 ID 契约 `EXTERNAL_ID` 是纯 ASCII —— 中文名单条都无法通过载荷校验。
- 改动：`slug` 生成 ASCII 安全且确定的 id——ASCII 前缀 + 名称 sha256 前 16 位（同前缀中文名不碰撞、同一公司跨 run/跨页稳定）；纯拉丁名保持旧 slug 行为（≤60 字符截断）。映射时公司名做 NFKC+trim 归一——载荷契约要求 NFKC 恒等，中文名常用全角括号/全角字母（「ABB（中国）有限公司」），不归一会整条被拒。
- 测试：`directory.provider.spec` 中文名 externalId（ASCII/稳定/不碰撞/拉丁名不变）用例；`provider-raw-boundary.integration.spec` 中文名无 website 记录经 prepare 后 ACCEPTED。
- 未做：不放宽 `EXTERNAL_ID` 共享契约（其它 provider 与去重键不受影响）；存量被拒记录不回溯（验证 run 产物）。

## 2026-11-05 · Engine contract for the platform.channel_crawl execution-budget purpose (P4-P1) (#805)

- 起因：产品负责人 2026-11-04 批准的「平台抓取预算 purpose」决定（实现记录 `docs/implementation-records/platform-channel-crawl-budget-authority.md`，#785）进入分段实施；本 PR 为第一段（引擎契约）。渠道抓取与 M2 watches 刷新共用 `platform.channel_crawl`，必须走既有 quote → PLATFORM_GRANT → egress fence → ACK 全链，无 Grant 一律拒绝。
- 改动：两段式迁移——先 `ALTER TYPE execution_budget_purpose ADD VALUE 'platform.channel_crawl'`，再扩展形状：`execution_budget_authority` 新增 `crawl_run_id` 列，`kind_shape_check` 与 `platform_run_binding_check` 增加独立的 channel-crawl 分支（schedule 四行不变量逐字节保持），新建唯一索引 `platform_crawl_run_key`；新摄入函数 `ingest_and_admit_platform_channel_crawl_run_v1`（绑定 `request_sha256`（channelId+mode+pageCap 的 canonical 摘要）+ `crawl_run_id` + `technical_policy_revision`，账户键 `platform:<request>:<crawlRun>`，仅 `execution_budget_platform_writer` 可执行）。verifier/types/contracts 同步：闭合 claim 集合增 `request_sha256`/`crawl_run_id`，签名 claim schema 改为 if/then 双形状（schedule 形状必填四字段、crawl 形状禁 schedule 字段），`assertAuthorityPurposeShape` 增 crawl 分支且不放松 schedule 分支。
- 测试：`execution-budget-authority.types.spec`（crawl 接受/13 组负向/「schedule 带 crawl 字段」拒绝）、`execution-budget-grant.verifier.spec`（真实签名 crawl token 接受、10 组形状负向、4 组期望作用域不匹配）、`platform-authority-ingestion.service.spec`（双形状契约与跨形状混合拒绝）、新迁移静态契约 6 用例；一次性库实测：整链迁移 + 以 platform writer 调新函数成功开户、JTI 重放 replay=true、schedule 形状 token 走新函数被拒。
- 未做：策略矩阵新版工件（P4-P2，属安全方向变更，需独立 review 后另 PR）、gain-saas 签发端点（P4-P3）、抓取工作流与 409 切换（P4-P4）。`ingest_and_admit_platform_execution_budget_run_v2` 与 4 个平台 schedule 的摄入路径未改动。

## 2026-11-05 · Publish the reviewed-v3 platform-authority policy with a channel-crawl capability section (P4-P2) (#806)

- 起因：P4 第二段——`platform.channel_crawl` purpose 需要新版平台权威策略工件（实现记录 `docs/implementation-records/platform-channel-crawl-budget-authority.md` §3/§5-P2）。GrowthOS 已退役（2026-10-31 P8），新版工件按 backend-authored successor 发布：保留 reviewed-v2 的逐字节基线与 GrowthOS 溯源，新增独立评审记录（AGENTS §5 安全方向变更）。
- 改动：新增 `platform-authority-policy-matrix-v3.json`（reviewed-v3）与 `platform-authority-policy-provenance-v3.json`：**四个 schedule 行与 v2 逐字节相同**（provenance 钉住行集 sha256，spec 深比较兜底），仅新增 `channel_crawl` 小节（purpose / `platform-automation` / `DENIED` / 页数上限与 `CHANNEL_RUN_MAX_PAGES`、`CHANNEL_DAILY_PAGE_CAP` 机器绑定）；资产校验切到 v3（字节/sha/artifact_id/matrix_revision/前驱/评审块/channel_crawl 小节），`rows` 仍是四行 schedule 集合——readiness、能力签名（≤4）与技术报价的四行不变量全部未动；报价夹具在 v3 身份下确定性重算（policy_revision / quote_sha256 等派生值）。
- 测试：资产 spec（字节 15,996/sha、前驱行摘要、channel_crawl 与渠道常量绑定、四类漂移拒绝、provenance 深等、运行时不读 GrowthOS checkout）；platform-authority 全套 60 文件 / 1121 用例全绿；报价向量按 v3 重算后逐字节断言；独立 review 记录写入工件 `backend_review` 与 provenance `successor`。
- 未做：不动四个 schedule 信封与 readiness 四行不变量；gain-saas 签发端点（P4-P3）与抓取工作流接线/409 切换（P4-P4）随后；跨仓 GrowthOS 重物化校验仍只覆盖 v2 基线（`MANUAL_SPECS`，CI 不跑）。

## 2026-11-05 · Per-request egress fence for platform channel-crawl runs (P4-P4a) (#807)

- 起因：P4 最后一段的第一块——`platform.channel_crawl` 的 Grant 已能签发与摄入（P1/P3），但平台出网围栏（4D authorize→claimSend→ACK/UNKNOWN）全链只认 4 个 schedule（绑定校验器、Prisma 端口、SQL 函数与围栏表主键），渠道抓取无法物理发出任何请求。
- 改动：新增并行围栏面——能力围栏表 `platform_egress_capability_fence`（`channel-crawl` 行，默认 ACTIVE 但**未发布指纹时 fail-closed**）、专用尝试表 `platform_channel_crawl_egress_attempt`、owner-only 的 `install_platform_egress_capability_policy_v1`（发布 reviewed-v3 工件与 channel_crawl 小节指纹，代际切换会阻断旧代 AUTHORIZED 尝试）、两段 CAS `authorize/claim_platform_channel_crawl_egress_send_v1` 与 `lock_platform_channel_crawl_egress_budget_v1`（同一账户咨询锁 + 权威/撤销/过期/已预留预算复检 + 账户键 `platform:<requestSha>:<crawlRunId>`）、crawl 尝试的 ACK/UNKNOWN 函数；全部 SECURITY DEFINER、`search_path` 以 pg_temp 结尾、仅 `execution_budget_platform_writer` 可执行，schedule 围栏与函数一字节未动。TS 侧：`PlatformEgressBinding` 扩为 schedule/crawl 联合（crawl 走 `subjectKind:'source_channel'`，绑定 channelId+crawlRunId+requestSha）、`PlatformEgressFence` 按绑定分派 crawl 的 ACK 转换、`CurrentPlatformChannelCrawlPolicy` 投影（指纹=e22cfd85…，工具固定 `crawl4ai.render@1.0.0`，单次预留取该工具估价）、Prisma 端口 crawl 分支。
- 测试：迁移静态契约 5 用例；fence 绑定/投影单测 20 用例（crawl ACK 分派、非法绑定、缺 crawl 转换 fail-closed、crawl 投影负向）；`platform-authority` + `execution-budget` + `security-definer-search-path` 96 文件 / 1616 用例全绿。一次性库实测：安装/重放、crawl 摄入开账户、零价预留、authorize→claim→ACK、策略漂移拒绝、代际切换把旧 AUTHORIZED 置 BLOCKED、撤销后 fail-closed、schedule 围栏仍 4 行零变化。
- 未做：抓取工作流/活动与 `requestCrawl` 409 切换（P4-P4c）、API 进程的 platform-automation Temporal 客户端与 gain-saas 客户端权限（P4-P4b）；围栏指纹由运维经 gain-saas 安装流程发布（默认 DENIED/未发布即拒发）。

## 2026-11-05 · Platform-automation Temporal client identity for the engine API (P4-P4b) (#808)

- 起因：P4 抓取运行的编排在 platform-automation 命名空间，但 API 进程只有 default 命名空间的 Temporal 客户端；平台授权器虽已内置 schedule-writer 身份（RoleWriter + `platform-automation:write`），却没有任何签发方。
- 改动：机器 token 增加 `temporal-platform-client` 档案（gain-saas 同批 #65，permissions 与授权器身份逐字一致）；引擎侧 `machine-token-runtime` 为该档案要求独立的证书三件套与主体（`TEMPORAL_PLATFORM_CLIENT_{CA,CERT,KEY}_FILE`/`_SUBJECT`，**绝不回退**到 API 进程的 customer-client bootstrap 材料）；新增 `PlatformTemporalClient`（namespace `platform-automation`、task queue `understanding`，只暴露受约束的 `startWorkflow`，失败一律收敛为 `PLATFORM_TEMPORAL_UNAVAILABLE` 并在下次调用重连）。授权器无需改动（既有 ScheduleWriterSubject 直接生效），Temporal 镜像不变。
- 测试：`platform-temporal.client.spec`（工作流启动参数、非法标识、按需重连、失败收敛与连接丢弃）；`machine-token-runtime.spec`（平台客户端档案缺自有配置时 fail-closed）；机器 token 客户端/验证器列入新档案；相关面 5 文件 / 54 用例全绿。
- 未做：抓取工作流本体与 `requestCrawl` 的 409 切换（P4-P4c）；证书签发是部署动作（r4-pki，CN=`platform-temporal-schedule-writer`），RUNBOOK 已记步骤要点；本 PR 不改变任何现有连接的身份。

## 2026-11-05 · Execute platform channel crawls on the platform worker (P4-P4c) (#809)

- 起因：P4 最后一段——Grant 能签发（#64）、围栏能放行（P4-P4a）、API 能以 writer 身份发起（P4-P4b），但还没有工作流把一次抓取真正跑起来；`requestCrawl` 仍是占位 409。
- 改动：新增 `channelCrawlWorkflow`（platform-automation，`understanding` 队列）与三段活动：**admit**（平台 worker 内经 mTLS 取 Grant → 验签/`ingest_and_admit_platform_channel_crawl_run_v1` 开户 → 只读 attest）、**run**（未发布围栏指纹即拒；按 `CHANNEL_DAILY_PAGE_CAP` 减当日 `source_channel_run.pages_fetched` 的 UTC 日余量硬截断；逐页以 crawl 围栏绑定经 `crawl4ai.render` 出网）、**finalize**（`source_channel_run` 落账并推进 failure streak；取消/失败也先落账再结束，错误码有界）。`requestCrawl` 从 409 切到「启动 `channel-crawl-<crawlRunId>` 并返回已受理」，`PLATFORM_TEMPORAL_UNAVAILABLE` 时 503 fail-closed；`source_channel_run` 新增 `truncated` 列（前向迁移）并贯通视图。新增 mTLS 客户端 `PlatformCrawlGrantClient`（request 规范摘要与 gain-saas 共用向量 `87084437…`）。
- 测试：活动层 6 用例（准入装配/权威拒绝映射/日配额截断且逐页过围栏/配额耗尽零出网/未批准渠道拒绝/平台落账带截断标记）、工作流 3 用例（成功/失败有界码/取消先落账）、客户端配置与共享向量、`channel.service` 启动路径与 503 映射、truncated 迁移静态契约；共 5 文件 25 用例绿。
- 未做：抓取记录的物化（records 仅计数进 `source_channel_run`，物化到公司池沿用既有导入/深挖路径的后续决定）；M2 watches 刷新复用本 workfow 的接线；围栏指纹与开关仍由运营显式发布/开启（默认拒发）。

## 2026-11-05 · Harden the OCI build against Debian archive outages (#810)

- 起因：2026-11-04 起 snapshot.debian.org 全球故障（503/504、No healthy backends），而 OCI 构建要从固定日期的快照源下载约 206 MB 包：三个 PR 的构建作业在下载里挂死 3 小时以上，作业没有超时只能等 GitHub 默认 6 小时上限，并且每次构建都从零重下。
- 改动：
  - Dockerfile 的 Debian 快照源换成 Debian 官方运营的 Cloudflare 前端 `snapshot-cloudflare.debian.org`：归档字节、时间戳与 Release 签名完全相同，只是 CDN 路径不同；回退就是把主机名换回 `snapshot.debian.org`。
  - apt 的 update 与 install 都加 30 秒连接超时（保留 Retries=3）：源变慢时快速失败，不再无限挂起。
  - `build-test` 作业加 `timeout-minutes: 60`：外部依赖卡死时最多一小时就会被杀，不再拖到 6 小时。
  - OCI 构建改用 `docker buildx`，层缓存写入 Actions 缓存服务（`type=gha`, `mode=max`；fork PR 只读不写）：重复构建复用 runtime-base（Debian 包、chromium）与构建层，不再每次重下归档。
  - 治理测试 `scripts/runtime-artifact-contract.spec.mjs` 同步钉住新主机名与新的 apt 参数；其余供应链约束不变（https、固定时间戳、精确包版本、禁 trust-bypass）。
- 测试：governance 相关 specs 58 项全过；Dockerfile 与 ci.yml 的完整验证由本 PR 的 CI 执行（ci.yml 改动会跑全部重门）。
- 未做：不改本机网络代理或任何运行配置；新源随下一次镜像班车生效。

## 2026-11-05 · Move the OCI build layer cache to a GHCR registry manifest (#811)

- 起因：#810 引入的 `type=gha` 层缓存**静默失效**——2026-11-05 核实：Actions 缓存清单 121 条全部是 codeql/node/gitleaks，没有任何 buildx 条目；main 成功构建的日志里没有 cache 导入/导出段；#805 的重跑仍然完整下载了 772 秒的包。托管 runner 的 Actions 缓存服务（v2）与 runner 自带 buildx 的 gha 后端不兼容，`ignore-error=true` 把初始化失败一并吞掉了。
- 改动：OCI 构建的层缓存改为 `type=registry`，写入 `ghcr.io/mlhjyx/global-backend-buildcache:runtime-image`（`mode=max`）：不依赖 Actions 缓存服务，也没有 gha 的分支作用域问题（任何分支可读同一 manifest，可写受 fork 保护）；`build-test` 作业级增加 `packages: write`（workflow 级 permissions 块保持原样）；非 fork 的 run 登录 ghcr 读写缓存，fork PR 跳过（只读 token 读不到私有包）；构建后校验缓存 manifest 存在，缺失时发 `::warning::` 而不是红构建。
- 测试：governance 相关 specs 全过（含 workflow 级 `permissions: contents: read` 的钉扎断言——job 级权限不触碰它）；`ci.yml` YAML 解析验证。端到端验证由本 PR 的 CI 执行：它的构建导出第一份 registry 缓存 manifest，之后对同一分支的重跑应出现缓存命中（构建日志出现 `importing cache manifest`）。
- 未做：不动 Dockerfile（#810 的 Cloudflare 前端切换保持有效）；不改发布镜像工作流（它不参与层缓存）。

## 2026-11-05 · Fix the platform crawl client injection so requestCrawl is reachable (#812)

- 起因：P4-P4c（#809）的 `ChannelService` 用 `import type` 引入 `PlatformTemporalClient`，编译产物 `design:paramtypes` 退化为 `[PrismaService, Function]`，Nest 的 `@Optional()` 因此永远注入 `undefined`——真实进程里 `requestCrawl` 恒返回 503 `PLATFORM_TEMPORAL_UNAVAILABLE`（"未接线"）。单测直接 `new ChannelService(prisma, fake)` 注入假对象，覆盖不到装饰器元数据；CI 全绿但真实链路不可达（2026-11-05 上线验收时用真实 saas-ops token 打 preview 暴露）。
- 改动：把该导入改为值导入（其余 `import type` 用法为类型参数/字段，不参与 DI，不动）；新增回归守卫 `channel-service-di.spec.ts`——断言**编译产物**的 `design:paramtypes[1]` 等于 `PlatformTemporalClient` 而不是 `Function`（vitest 的 esbuild 不产装饰器元数据，源码级断言无意义；CI 在 vitest 之前已 `nest build`）。
- 测试：新 spec 红→绿（红态证据：旧镜像内 dist 实测 `[PrismaService, Function]`）；channels 相关套件全过；`gctl check --fast` 通过。
- 未做：不改运行时协议、不动 API 形状；随下一班镜像生效。

## 2026-11-05 · Share the GHCR layer cache with the runtime image publication build (#813)

- 起因：2026-11-05 热修发车时 `publish-runtime-image` 的构建在 apt 层被 snapshot 源的 503 卡死——发布工作流从未接过层缓存，每次发布都是冷构建，把「能否发车」继续押在 Debian 快照源的运气上（同一天 ci.yml 已由 #811 接入 registry 缓存并验证生效）。
- 改动：发布构建改为 `docker buildx build --load`，与 ci.yml 共用同一个 GHCR 缓存 manifest（`ghcr.io/mlhjyx/global-backend-buildcache:runtime-image`，`mode=max`，`ignore-error=true`）；构建步骤先 `docker login ghcr.io`（token 仍为 `secrets.GITHUB_TOKEN`）；`--provenance=false`/`--sbom=false` 与后续 `docker save`／config 摘要校验契约全部保留。
- 测试：`runtime-deployment-contract.spec.mjs`（GHCR 发布契约：单清单、publish-once、digest 回读、最小权限）全过；YAML 解析验证。端到端验证由下一次发布执行——缓存命中时构建日志应出现 `importing cache manifest` 且 apt 层跳过下载。
- 未做：不改发布协议与推送路径（仍走 `docker push` + resolve 回读 digest）；不改权限块。

## 2026-11-05 · Use a lazy Temporal connection so the writer identity can start workflows (#814)

- 起因：P4-P4c 的 `PlatformTemporalClient.connect` 用 `Connection.connect`，SDK 会先调 `GetSystemInfo` 做连通性预检；schedule-writer 身份在平台授权器只被允许 `StartWorkflowExecution`，预检被拒（`PLATFORM_TEMPORAL_READER_AUTH_DENIED`），`requestCrawl` 在真机里恒 503。现有单测直接覆盖私有 `connect`，碰不到真实 SDK 工厂选择（与 #812 同型：假对象单测掩盖真实路径；本次由真机验收链条抓出）。
- 改动：改用 `Connection.lazy`（无预检；失败由既有收敛与下次重连逻辑处理），并在代码旁注释钉住原因；新增 mock SDK 的回归守卫 `platform-temporal-lazy-connect.spec.ts`（断言走 `lazy`、绝不用 `connect`）。
- 测试：新 spec 红→绿；`gctl check --fast` 通过。真机验证随下一班镜像：writer token 连上平台 → `startWorkflow` 成功 → `source_channel_run` 落库。
- 未做：不改平台授权器（writer 的最小权限面保持 `StartWorkflowExecution`）；不升级 `@temporalio/client`。

## 2026-11-05 · Verify the writer fixed-identity token shape on the engine side (#815)

- 起因：平台授权器（`infra/temporal-platform/server/readerpolicy/machine_policy.go`）把 `platform-temporal-schedule-writer` 定义为「无 profile 的固定身份」：`typ` 必须恰为 `JWT` 且禁止 `profile` 声明。gain-saas（#66）已按该形状签发，但引擎侧 `machine-token-verifier` 仍要求旧的 `temporal-runtime+jwt` + `profile` 形状，把平台接受的令牌拒掉（`PLATFORM_MACHINE_TOKEN_UNAVAILABLE`），writer 身份仍不可用——引擎与签发方两侧契约必须同时对齐（真机验收发现的第三处阻塞点的引擎半边）。
- 改动：`temporal-platform-client` 档案的验证改为固定身份形状：`typ` 必须为 `JWT`、payload 允许字段不含 `profile`（携带即拒）、`permissions` 仍须精确等于 `["platform-automation:write"]`；其余档案（capability/worker/reader）的验证逐字节不变。
- 测试：新用例覆盖「固定身份接受 / 旧档案形状拒绝 / 带 profile 的 JWT 拒绝」三态，红→绿；`machine-token-verifier` 相关套件全过。
- 未做：不改平台授权器；不改 gain-saas（已合并 #66）；随下一班镜像生效。

## 2026-11-05 · Land the writer fixed-identity verifier change that #815 missed (#816)

- 起因：#815 声称「引擎侧验证 writer 固定身份令牌」，但实际合并的只有 changelog 片段——两次源码编辑误落在根 checkout 的绝对路径上（worktree 流程失误），代码从未进入分支，镜像中的验证器仍是旧形状；平台令牌因此继续在引擎侧被拒（`PLATFORM_MACHINE_TOKEN_UNAVAILABLE`），真机验收当场发现。
- 改动：与本应随 #815 合并的内容一致——`machine-token-verifier` 对 `temporal-platform-client` 档案接受固定身份形状（`typ` 必须 `JWT`、禁止 `profile` 声明、`permissions` 精确等于 `["platform-automation:write"]`），其余档案逐字节不变；`machine-token-verifier.spec.ts` 增加三态用例（固定身份接受 / 旧形状拒绝 / 带 profile 拒绝）。
- 测试：新用例红→绿（旧代码下必失败）；`machine-token-verifier` 套件全过；`gctl check --fast` 通过。教训：worktree 施工时必须写 worktree 内路径，代码改动与片段必须同分支自检（`git status` 应同时出现源码与片段）。
- 未做：#815 的片段保持原样（历史记录不改）；不改平台授权器与 gain-saas（#66 已合）。

## 2026-11-05 · Materialize channel crawl records (companies + contacts) into a platform record pool (#817)

- 起因：P4-P4c 交付时抓取记录只在内存里计数（`recordsFound`），活动返回即丢弃——没有物化就没有可投影/可使用的源，运营台也看不到抓到的公司。
- 改动：新增平台级 `source_channel_record`（无 RLS）：公司级字段（name/website/country/industry/products/keywords）+ 联系人字段（contactName/contactTitle/email/phone），按 `(channel_id, dedupe_key)` 跨轮 upsert（`companyIdentity` 的 `d:`/`n:` 键）、`first_seen_at`/`last_seen_at`/`content_hash` 记录观测与变更。物化在 run 活动内部完成（记录不进 Temporal 历史），物化失败抛 nonRetryable `CHANNEL_MATERIALIZATION_FAILED`（不重试、不计入页面失败率）；`recordsMaterialized` 从恒 0 变真实计数并贯通 finalize→`source_channel_run`。`source_channel_run` 新增 `crawl_run_id` 唯一列（finalize 幂等）。爬虫字段白名单扩展联系人四字段，**仅详情页模式可配**（`detail.enabled` + `list.itemUrlSelector`，否则 400）——堵住列表页回退时字段选择器整页匹配、同一值复制给整页条目的缺陷。新增 `GET /source-channels/:id/records`（ops:read）供选择器校验与联系使用。
- 合规：联系人字段按 **OWNER-DECISION-2026-11-05** 明文存储，列级加密、Q25 访问审计、保留期与 Art.17 擦除面延后到后续任务（防线保留：字段不进日志/事件历史、仅 ops 可见、白名单封闭）。迁移注释与 schema 均标注 `PII_PENDING_ENCRYPTION`。
- 测试：见 PR（配置防线、爬虫详情页/列表页双守卫、记录键与折叠、活动物化成功/失败、权限契约、迁移静态契约、disposable 库 upsert 幂等）。
- 未做：租户投影（公司池/Lead 物化与抑制/制裁门）；联系人字段的加密/审计/保留期/擦除（延后任务）；页面正文持久化（沿用 crawl4ai durable artifact 24h TTL）。

## 2026-11-05 · Prefer structured sources when trimming the discovery query plan (cheap-first PR-1) (#818)

- 起因：Q33② 要求数据源路由「结构化源优先、public_web 兜底」。现状 planner 由模型自由选择源，超查询帽时的裁剪按 query priority 排序，public_web 副本与结构化源同权，且规划提示里 public_web 排第一行。
- 改动：
  - planner 指南加路由优先级与配额说明（结构化源优先、public_web 仅作兜底；结构化源每轮各约 ≤100 家公司、公司池补到 500；新源前 10 次运行限量试跑），并把可用源列表按源优先级排序（结构化源在前）。
  - `routePlannerQueries` 的 `PLAN_QUERY_CAP` 裁剪加入源优先级 tiebreak：超帽时先保留结构化源副本、先丢 public_web 副本；扇出语义不变。
  - 新增 `DISCOVERY_CHEAP_FIRST` 开关（off | shadow | enforce，默认 shadow）：shadow 保持旧行为，只把「按 cheap-first 将替换多少副本」写进计划 review 注记。
- 测试：新增单测覆盖开关解析（默认 shadow、未知值回落 shadow）、enforce 裁剪顺序、shadow 报告与 off 回退、prompt 优先级与配额文案；`gctl check` 通过。
- 未做：不含执行层配额（每 run 每结构化源公司帽、新源试跑限额）与归因「查询数」列——随 PR-2。

## 2026-11-05 · Enforce per-source query budgets for cheap-first discovery routing (cheap-first PR-2) (#819)

- 起因：Q33② 的规划层（PR-1）只做了 shadow 观测；真正把「结构化源每轮各 ≤100 家、新源前 10 次试跑限额」落到执行路径还缺一步。物化发生在查询阶段之后、收据又是严格键契约，因此按设计 §4.3 的实现对齐点，以「每源每轮查询预算」等价落地：每查询每源记录上限 25 条 × 预算条数。
- 改动：
  - `plan-query-sources`：新增 `SOURCE_QUERY_BUDGET` 裁剪原因；`routePlannerQueries` 支持 `sourceBudgets`（结构化源默认 4 条、试跑源 1 条、public_web 豁免），enforce 时裁掉超额副本、shadow 只统计并在计划注记「将按预算移出 N 条」；新增 `sourceQueryBudgetConfig`（`DISCOVERY_STRUCTURED_SOURCE_RUN_CAP`/`DISCOVERY_TRIAL_MAX_COMPANIES`/`DISCOVERY_TRIAL_MAX_RUNS`，带默认与钳制）与 `sourceQueryBudgets`。
  - `source-trial`：按工作空间统计 `raw_source_record` 的 distinct run 数判定试跑期；零记录的新源（SQL 不产出行）按 0 次运行进入试跑期；失败降级为空集，不阻塞规划。
  - `icp.service`：规划时计算每源预算并传入路由；shadow/enforce 语义沿用 `DISCOVERY_CHEAP_FIRST`。
  - 设计文档追加 §11「实现裁定」，说明等价关系与未动的契约面。
  - 合入前自审修复：零运行新源进试跑期；结构化预算按 §11 精确公式（公司帽 <25 → 0 条，`max(1,…)` 只用于试跑源）；shadow 替换计数改在预算后副本上计算（与 enforce 同口径）；env 参数拒绝畸形数字串（`1e3`/`100abc` 不再被 parseInt 截断）。
- 测试：新增 `sourceQueryBudgets`/预算裁剪/enforce 弃取/shadow 统计/配置解析/试跑计数映射单测；`source-trial` 增补零行源与失败降级用例；`icp.service` 补 `$queryRaw` 注入，钉住「试跑预算 → 路由 → 落库注记」的 shadow/enforce 双语义接线。
- 未做：不改查询收据与工作流/活动接口；public_web 的 run 总池 500 硬闸门与 `data_provider.config` 试跑覆盖本轮未实现（§11 已更正，另行排期 / PR-3 候选）；gain-saas 归因「查询数」列与租户投影另行排期。

## 2026-11-05 · Enforce a per-run discovery company pool cap (#820)

- 起因：Q33② 的「总池 500」兜底配额（`DISCOVERY_RUN_POOL_CAP`）从未实现；既有 `QUICK_SCAN_POOL_LIMIT` 只是 quick-scan 消费侧上限，不约束发现阶段的物化（cheap-first 计划 §11 自审核正）。
- 改动：
  - governed 物化批内按 run 统计已入池公司（outcome 表 distinct `canonical_company_id`），达 cap 后跳过会新增公司的物化，该行落 `NOT_CANONICALIZABLE` + `RUN_POOL_CAP_REACHED`；已在池的公司与终态行（suppressed/restricted/expired/隔离）不受影响。
  - 达界时 `canonicalizeRun` 返回 `poolCap{cap,skipped}`，run stats 记 `poolCap`，`run_event` 同事务写一条 `pool_cap_reached`（幂等）。
  - 新迁移只放宽 outcome 的原因码 CHECK（加 `RUN_POOL_CAP_REACHED`）；`DISCOVERY_RUN_POOL_CAP` 默认 500，`off` 关闭，非法值回退 500。
- 测试：`run-pool-cap` 纯逻辑单测、governed 物化批接线单测（达界/入池放行/终态优先/env off）、真库 postgres spec（恰好 500 边界、跨查询累计、public_web+wikidata 混合、off 回退）。
- 未做：达界不改 run 状态（不是 PARTIAL/FAILED）；契约前历史 run（LEGACY）不设闸以保持重放确定性；gain-saas 归因无改动。

## 2026-11-04 · Wire the full DB test suite into CI and enforce docs freshness (#768)

- 起因：`packages/db/test` 的 28 个数据库/RLS 测试里 CI 只点名跑了 2 个，最强的租户隔离保障大部分靠手工；权威文档的「最后核验」没有机械门（治理索引停在 2026-08-07）。
- 改动：
  - 新增 `packages/db/test/ci-manifest.json`（service / isolated / manual / static 四组）与 `scripts/run-db-tests.mjs`（清单完整性校验、service 组每文件独立新库串行、isolated 组轮转分片）；未登记文件或失效登记直接失败。首批进 CI：3 个 service（独立新库）、5 个自起 pgvector 容器（2 分片、预拉镜像、两个显式 opt-in gate）、1 个纯静态；19 个登记为 manual 并注明原因（需要外部预置容器，或期望特定迁移子集下的函数状态；首轮验证暴露的既有测试腐化另开修复）。
  - `ci.yml` 增加 `db-tests-service`（CI PostgreSQL service）与 `db-tests-isolated`（2 分片、自起 pgvector）两个 job，按路径 scope 触发，纯文档 PR 跳过。
  - 新增 `scripts/docs-freshness.mjs` 并接入 `verify-docs`：权威页「最后核验」超过 90 天按 `freshness.mode` 报 `DOC_STALE` / `DOC_VERIFICATION_MISSING`（当前 `warn`，观察期后转 `error`）。
  - 两个新 spec 由 `db-tests-service` job 以 `node --test` 直接执行；根 `governance:test` 保持不变（Copy 固定源约束）。
- 测试：`node --test scripts/run-db-tests.spec.mjs scripts/docs-freshness.spec.mjs` 9/9；`node scripts/verify-docs.mjs` PASS（0 errors；16 条 warning 为权威页缺「最后核验」，观察期预期）。
- 未做：不改写历史证据与 16 个缺日期权威页的正文；DB 测试所需角色与迁移沿用现有 CI service 约定，首轮 CI 若暴露既有失败，登记豁免并另开修复。

## 2026-11-04 · Add append-only personal-data access audit with 180-day retention (#771)

- 起因：产品负责人 2026-11-04 决定取消租户数据处理声明（完整设计 §7.4 / Q23–Q25），平台级 lawful basis 接管联系人操作；作为补偿控制，每一次个人数据访问/物化都要留访问审计（谁/何时/公司/字段类/用途），保留 180 天。
- 改动：
  - 新表 `personal_data_access_audit`（引擎迁移 `20261104100000`）：租户 RLS、append-only（app_user 只有 SELECT/INSERT）、内容最小化（只记字段类别与主体计数，不存字段值）。
  - 新模块 `apps/api/src/compliance/personal-data-access-audit.ts`：统一写入口与字段类推导。
  - 接线四处：`discover-contacts` / `guess-emails` / `contact-point/:id/verify` 三个 HTTP 路径，以及 run 内联系人物化与邮箱补全（与落库同事务，物化了却没有审计的情况不出现）。
  - `expire_personal_data_access_audit_v1` 保留期清理函数，由 raw-retention sweep 在 `personal-data-access-audit-retention-v1` patch 下按 workspace 分批调用（旧历史重放不产生新命令）。
- 测试：新增审计模块单测、迁移静态契约与 raw-retention 编排单测；全量 `APP_DATABASE_URL= pnpm --filter @global/api test` 通过（两次已知负载假红单跑均通过）。
- 未做：gain-saas 侧取消声明（另 PR）；审计的运维查询界面。

## 2026-11-04 · Move the default worktree convention from .codex/worktrees to .claude/worktrees (#772)

- 起因：Codex 已不再作为开发代理，`worktree:new` 仍默认在 `.codex/worktrees` 建 `codex/<topic>`，命名与实际开发主体不符。
- 改动：
  - `pnpm worktree:new` 改为在 `.claude/worktrees/<topic>` 创建 `claude/<topic>`，脚本更名 `scripts/create-worktree.mjs`；
  - `.gitignore` 新增 `/.claude/worktrees/`、`/.claude/audits/`，`.codex` 两项保留给迁移前现场；
  - 策略标记 `.codex/README.md` 移至 `.claude/README.md`；
  - AGENTS.md、README.md、CONTRIBUTING.md、导航指南、worktree runbook 与相关操作文档同步新默认；
  - code-intelligence 扫描排除新增 `.claude`。
- 测试：`node --test scripts/governance-main-worktree-sync*.spec.mjs`；`pnpm worktree:new <topic> --dry-run`；`gctl check`。
- 未做：迁移前已在 `.codex/worktrees/` 的在飞 worktree 不搬动，按清理门逐个退役；`docs/CODEX-NAVIGATION-GUIDE.md` 文件名与历史计划/记录/归档中的旧路径不改写。

## 2026-11-04 · Add the Run 2.0 domain model (company jobs, run events, channel sightings, pool freshness) (#773)

- 起因：完整设计（2026-11-04）把寻源 run 重构为「任务 → 快扫 → 公司级深挖流水线」，需要先落 expand-only 的域模型（M0①），后续 PR 才写入。
- 改动：
  - 新表 `discovery_company_job`（每家 × 每 run 的状态机，stage 有 CHECK）、`run_event`（append-only 进度事件，seq 唯一）、`company_channel_sighting`（渠道来源证据；channel_id 暂不设外键，M1 接 source_channel）。
  - `discovery_run` 增 `task_ref`/`phases`/`mode`；`canonical_company` 增 `last_seen_at`/`last_checked_at`/`profile_hash`；`lead` 增 `fit_input_hash`。全部可空或带默认，旧行与旧读取路径不受影响。
  - 三张新表租户 RLS；`run_event` 与 `company_channel_sighting` 仅 SELECT/INSERT（append-only）。
- 测试：新增迁移静态契约单测（表/列/CHECK/RLS/权限清单）；`prisma validate` 通过；全量单测随 CI。
- 未做：写入路径与编排（M0②–⑥）；`run_event` 90 天保留期清理；source_channel 外键（M1）。

## 2026-11-04 · Accept an optional Run 2.0 taskRef when executing a discovery query plan (#774)

- 起因：Run 2.0 把「挖掘任务（AcquisitionTask/TaskRun，gain-saas）」前移为 run 的发起方，引擎需要在执行记录上携带任务归因（完整设计 §6.1/§7、M0②）。
- 改动：`POST /query-plans/:planId/execute` 接受可选 `{taskRef: {taskId, taskRunId}}`，写入 `discovery_run.task_ref` 并随 `DiscoveryRunRequested` 命令负载传递；不传时请求/数据形状与之前完全一致；形状不合法在任何预算 Grant 消耗前返回 400 `TASK_REF_INVALID`。OpenAPI 已重新生成（纯新增 requestBody）。
- 测试：新增 executePlan taskRef 单测（存储/省略/拒绝三条），既有 controller 与 authority 原子性套件通过；contracts spectral lint 无 error。
- 未做：gain-saas 侧 Task/TaskRun 与 `taskRef` 发送（另一 PR）；webhook 事件中的任务归因。

## 2026-11-04 · Skip code gates on docs-only pull requests (#776)

- 起因：纯文档 PR 仍无条件跑 prisma generate、lint、build、零容器单测与 PostgreSQL 重门，`build · typecheck · test` 固定约 7 分钟；只有 `docs:verify` 是文档 PR 真正需要的门。
- 改动：
  - `renderer-visual-scope` 增加 `run_code` 输出：仅当**所有**改动都落在 `docs/*`、根 Markdown 文档（README/AGENTS/CLAUDE/CONTRIBUTING）与代理元数据目录（`.claude/.agents/.codex/.superpowers`）时为 false；`.github/`、`scripts/`、锁文件与任何代码路径一律为 true；diff 失败、定时与手动触发 fail-closed 为 true。
  - `build · typecheck · test` 的 18 个代码步骤与 `contracts` job 以 `needs.renderer-visual-scope.outputs.run_code != 'false'` 短路——默认运行，只有分类器**显式**判定纯文档才跳过；`docs:verify`、Copy 影响评估、tree-cleanliness 始终运行。
  - 机器合同 `governance-ci-topology.spec.mjs` 的 scope 用例表加入 run_code 期望（含 `.github/workflows/security.yml` 算代码这条自掩蔽防护），并锁定「默认运行」的 `!= 'false'` 语义。
- 测试：`node --test scripts/governance-ci-topology.spec.mjs` 12/12；`node scripts/verify-docs.mjs` PASS；`ci.yml` YAML 解析通过。
- 未做：不引入 affected 依赖图 / 远程缓存与 merge queue（当前规模不值）；不拆分渲染器视觉回归 job（总墙钟不变）。

## 2026-11-04 · Add the Run 2.0 quick-scan stage (pool-first prefilter, batched quick judgment, provisional leads) (#777)

- 起因：完整设计（2026-11-04）把寻源 run 拆成快扫/深挖两档；快扫要用公司池先出名单（≤8 分钟），只有池子不够才搜索兜底（R3/R4）。
- 改动：
  - 新活动 `prefilterPool`（规则预筛，写 `discovery_company_job`）、`quickJudgeBatch`（8 家/次 flash 粗判，解析失败逐家降级，模型不可用规则兜底出 weak，Q20）、`materializeProvisionalLeads`（幂等 upsert，queue=needs_review，fitReasons.source=quick_scan）；进度写 `run_event`（seq 单调、并发撞号重试）。
  - `discoveryWorkflow` 增加 `discovery-run2-quick-scan-v1` patch + 启动参数 `run2QuickScan`：候选 ≥20 家时跳过整轮搜索，否则跑一次有界搜索再预筛；结束直接 finalize（空池 PARTIAL、全部失败 FAILED）。
  - relay 按部署开关 `DISCOVERY_RUN2_QUICK_SCAN`（默认关）写入启动参数；旧历史无该字段 → 原编排不变。
- 测试：预筛/批量解析/降级/兜底/幂等物化单测，seq 并发重试单测，工作流编排单测（快路径/搜索兜底/开关关闭/全失败）；全量 API 单测通过。
- 未做：真默认开启（等 M0④ 深挖与 M0⑥ 影子两轮召回不降）；与 taskRef 的联动只在 M0② 的输入字段上。

## 2026-11-04 · Restore customer-side periodic sweeps with an API-side scheduler (R7-A) (#778)

- 起因：平台迁移（2026-10-31）后客户侧周期任务全部停摆——`ensurePlatformSchedules` 在 src 无调用方，机器身份也没有 ScheduleService 权限（设计 §6.4 实查）。
- 改动：新增 `SweepSchedulerService`（API 进程内）：每 `SWEEP_SCHEDULER_TICK`（默认 1m）为 6 个客户侧 sweep（backlog / external-intent / raw 保留期清理 / site-release 维护 / KB 恢复 / 建站费用对账）按周期桶启动工作流——workflowId=`<schedule>-<period>` + REJECT_DUPLICATE 去重防叠跑，启动时先补跑一次；`SWEEP_SCHEDULER_ENABLED=off` 可关闭。只使用机器身份被允许的 StartWorkflowExecution；4 个平台 schedule 保持 paused（产品负责人单独决定）。
- 测试：周期桶 id/跨周期换桶/已启动忽略/单条失败不影响其余/开关关闭/绝不调度平台 schedule 共 7 条单测；API build 通过。
- 未做：R7-B（扩展平台 Temporal 机器策略并重发镜像）。

## 2026-11-04 · Add the Run 2.0 deep-dive pipeline (per-company child workflows, stop-deep via RequestCancel) (#779)

- 起因：快扫产出的候选要在可停止、可续的前提下逐家深挖（设计 §6.3/§12：并发 16、上限 500、停止 60 秒内生效、已完成结果保留）。
- 改动：
  - 新子工作流 `companyPipelineWorkflow`：每家公司 profiling → fitting（mismatch 提前收工）→ signals → contacts → done，每步写 `discovery_company_job.stage` 与 `run_event`；单家失败只标 failed，不拖垮整轮。
  - 新单公司活动（不依赖本 run 的 raw lineage，直接以 canonical 公司为对象）：`profileCompanyOnce`（官网画像/Impressum，复用 durable receipt 与治理门）、`fitCompanyOnce`（四门精判）、`signalsCompanyOnce`（7 天 TTL、SUSPENDED 跳过）、`contactsCompanyOnce`（决策人 + 可选邮箱补全，带 Q25 访问审计）。
  - 父工作流深挖阶段：子工作流滚动窗口并发 16、目标上限 500；`POST /discovery-runs/:id/cancel` 用 RequestCancel（机器身份许可范围内）停止深挖——未完成公司标 skipped(DEEP_STOPPED)，run 以 CANCELLED 收尾，下一次 run 重新排队（可续）。
  - `finalizeRun`/`attestRunFinalization` 接受 CANCELLED；OpenAPI 新增 cancel 端点。
- 测试：子工作流编排单测（阶段顺序/mismatch 提前收工/单家失败隔离/取消传播）、父工作流深挖与取消单测、cancelRun 端点单测、全量 API 单测；spectral lint 通过。
- 未做：影子模式与默认切换（M0⑥）；深挖阶段独立子预算（沿用 run 账户）。

## 2026-11-04 · Expose incremental run progress (events by seq, per-company job queue, run taskRef) (#780)

- 起因：Run 2.0 的深挖是逐家推进的长过程，界面要能按 seq 增量看到进度、逐家状态与失败码（设计 §6.3/§12：3 秒轮询、事件可重放）。
- 改动：
  - `GET /discovery-runs/:runId/events?after=<seq>`：append-only 进度事件增量拉取（返回 nextAfter，断点续拉/重放）。
  - `GET /discovery-runs/:runId/jobs`：公司级队列（stage/粗判/精判/失败码/耗时，含公司名与域名，游标分页）。
  - `GET /discovery-runs/:runId` 增 `taskRef`/`phases`/`mode`；接口门户补两条操作说明。
- 测试：事件增量/空闲轮询/未知 run/队列分页四条单测；OpenAPI 重生成（87 paths）；docs:verify、governance:verify。
- 未做：事件 90 天保留期清理（M0⑥）；首页角度聚合事件（按 seq 全量可重放已满足）。

## 2026-11-04 · Run 2.0 finalize V2, shadow comparison and run alerts (#781)

- 起因：切默认前要能对比新旧两套判定的召回与一致率（影子模式，连续两轮召回不降才切），并把运行健康（预算/失败率/时长）变成可见告警。
- 改动：
  - 阶段时间写入 `discovery_run.phases`（quick_started/quick_done/deep_started/deep_done，活动记录、回放安全）。
  - 新表 `run_shadow_diff`（聚合计数、租户 RLS、append-only）：影子 run 里老路径照常产出，新快扫判定不物化名单，只对比召回与逐家一致率。
  - run 收尾统计新增 `stats.alerts`：预算耗尽、失败率 >30%、超过 30 分钟未完成；部署开关 `DISCOVERY_RUN2_SHADOW`（默认关）。
  - 快扫/深挖的 verdict 汇总进 `stats.quickScan`/`stats.deep`。
- 测试：阶段合并/耗时/影子对比（含占位判定剔除）三条活动单测、影子工作流单测、迁移静态契约；全量 API 单测与 docs/governance 校验。
- 未做：自动切换默认（连续两轮影子达标后由产品负责人点头；告警的外部推送通道随 M1/运维面板）。

## 2026-11-04 · Add the channel data-source platform (registry, tenant enablement, CSV import, config-driven crawler v0) (#782)

- 起因：完整设计 §4/§11 M1——新增渠道不改代码：管理后台配 API/爬取/导入三形态，渠道养池、run 消费池；Q27 把展会渠道改成行业驱动的动态发现、导入验收用系统生成的 10 行示例 CSV。
- 改动：
  - 新表 `source_channel`（平台注册表，治理字段 + 失败率连 3 轮 >30% 自动停用）、`source_channel_enablement`（租户只能启用已批准渠道）、`source_channel_run`（每次运行的抓取量/产出/失败）、`imported_buyer`（租户私有导入原始行与去重键）；`company_channel_sighting.channel_id` 接上外键。
  - 导入通道端到端：CSV 解析（RFC4180/分号/BOM/5000 行上限）+ 列映射 + 预览（去重/抑制命中，不写库）+ 提交（按域名/名称+国家去重、过抑制门、物化 canonical + sighting + 批次明细）；示例 CSV（10 行）。
  - 通用爬虫 v0（配置驱动）：零依赖 HTML 选择器子集、列表/详情抽取、https-only、页数上限与单域限速；抓取执行经 ToolBroker（robots 强制）——其平台抓取预算权威获批前，preview/run 端点 fail-closed 409（不绕过闸门）。
  - 启用硬闸门：license+tosUrl+robots 结论齐全，robots=C 永不启用、crawl 仅允许 A。
- 测试：CSV/映射/示例、选择器、爬虫（详情/页数截断/失败计数/配置拒绝）、治理闸门、启用、导入端到端与预览、运行统计与自动停用、迁移静态契约；全量 API 单测与 docs/governance。
- 未做：抓取通道的真实执行（等平台抓取预算权威决策）；行业驱动展会发现端点（依赖抓取出网）；管理后台页面（gain-saas 侧 PR）。

## 2026-11-04 · Close the ICP feedback loop (decision aggregation, query-family EMA weights, suggestion cards) (#784)

- 起因：设计 §7.1——判断结果（接受/拒绝 + mismatch 理由）目前只落库不回喂；本轮把「判断 → 聚合 → 查询权重与 ICP 建议」闭起来，且坚持建议卡人工采纳才改 ICP。
- 改动：
  - 新表 `icp_feedback`（来源/渠道/行业/国家的接受率与拒绝理由分布）与 `icp_query_performance`（来源类目的 EMA 质量分，Alpha=0.3）；租户 RLS。
  - `IcpFeedbackService`：幂等重算（Lead + LeadDecision + 渠道 sighting + raw 来源血缘）、建议卡（零接受行业/渠道/国家、强势细分）、规划提示词加权备注。
  - 接受/拒绝接口在决定成功后 best-effort 触发重算；`GET /icps/:id/feedback` 与 `POST .../feedback/recompute` 两个端点。
- 测试：聚合/理由计数/EMA 混合/建议卡阈值/规划备注 4 条单测、迁移静态契约；全量 API 单测与 docs/governance。
- 未做：查询族按「查询文本」精确聚合（v1 按来源类目）；回复/退订结果回流（随触达阶段）；watches 刷新 run 调度（下一 PR）。

## 2026-11-04 · Stop treating generic company words as social-profile company evidence (#786)

- 起因：r14 镜像验收（[r14 证据](../evidence/2026-11-04-contact-run-acceptance-r14.md) §3）发现社媒层残留类——公司名本身是业务通用词（`technical.de` 的公司名就叫「Technical」）时，headline 只要含该词就满足公司佐证，把别家公司员工（标题含「at Redline Technical…」/「at Treefrog Cinegraphix」）收进联系人。
- 改动：社媒 L3 守卫把泛词（technical/industries/solutions/consulting/engineering/services…，含德语对应词）与有区分度的公司名 token 分开：泛词**单独命中不再构成公司佐证**；此时必须见到完整域名（边界匹配，拒绝 `technical.design` 这类同前缀 TLD）或多词公司名的完整短语才放行。丢弃计入新诊断 `social_generic_name_dropped`。
- 测试：`social-presence.provider.spec.ts` 新增 6 例（含 global_dev 两条存量残留行的 headline 回放，姓名/档案 URL 已虚构化）；`APP_DATABASE_URL= pnpm --filter @global/api test` 与 `gctl check --fast` 全绿。
- 未做：库中已收录的两条脏行不在本 PR 删除（存量数据，清理走 `cleanup-contact-false-positives.mts` 显式 id 流程，等产品负责人确认）。

## 2026-11-04 · Serialize run-event seq allocation with a per-run advisory lock (#788)

- 起因：2026-11-04 快扫+深挖真实验收（run 11923f12）在 16 并发深挖下暴露：`appendRunEvent` 在调用方事务内对唯一冲突（P2002）重试取号，但 PostgreSQL 把唯一冲突后的整个事务标为 aborted，事务内重试只会得到 25P02，且同事务里的 company job 阶段更新全部回滚——一家公司卡死在 profiling，finalize 计 `remaining=1`，run 收敛为 PARTIAL。当日 worker 日志共 49 次 25P02。
- 改动：
  - `appendRunEvent` 改为先取 per-run 事务级 advisory lock（`pg_advisory_xact_lock(hashtextextended('run-event:<runId>'))`）再取号，从源头消除并发冲突；删除事务内 P2002 重试（冲突无法在已中毒事务内恢复，任何数据库错误直接上抛，由外层事务重试）。
  - 同步更新函数注释与单测：新增「锁先于取号」「唯一冲突不在事务内重试」两个用例；`discovery.run2.activities.spec` 的 fake tx 补 `$queryRaw` 桩。
- 测试：`pnpm --filter @global/api test run-events`（4 用例）+ 相关 run2 活动/工作流单测；发布侧需在下一班镜像中复测深挖并发（本轮验收在 deepseek-flash 临时档上观测到该缺陷）。
- 未做：不改 run_event 表结构与读路径；不引入按 run 的独立 sequence。

## 2026-11-04 · Add zh search localization and fail loudly on unbuildable searches (#789)

- 起因：产品负责人用中文 ICP（珠三角电子制造/吸塑包装）跑 discovery 得到 4 秒 PARTIAL、0 结果。根因：搜索本地化只支持 de/en/fr/it/es/nl/pl，中国回落 en；`searchableTerms` 剔除全部 CJK 词 → `buildSearchQueries` 返回空 → 一次检索都没发、10 条查询收据全 0、静默收场。
- 改动：
  - `SearchLanguage` 增加 `zh`；COUNTRIES 增加 CN（中国/china/cn/chn）；地区映射增加珠三角/长三角/京津冀/粤港澳/环渤海等中文区域；`ROLE_TERMS` 增加 zh（distributor 经销商/分销商/批发商/进口商，manufacturer 制造商/厂家/工厂）。
  - `searchableTerms` 接受语言参数：`zh` 保留 CJK、其余语言维持剔除（既有德语/英语检索串行为不变）；`buildSearchQueries` 先定语言再取词。
  - `discoverCompanies` 在无法构造任何检索串时抛 non-retryable `DISCOVERY_MARKET_UNSUPPORTED`（附可操作中文提示），不再静默返回 0 结果 PARTIAL。
- 测试：`search-localization.spec`（zh 解析、角色词、CJK 保留/剔除分流与既有 DACH 用例）、`public-web-search-first.spec`（中文经销商串、珠三角区域串、空检索显式失败、既有德语回归）；全量 `@global/api` 单测。
- 未做：马来语（ms）与「ICP 目标市场以卖方档案为权威」属独立任务；run 页「搜索企业」阶段 UI 映射与错误码前端文案在 gain-saas 侧另 PR；搜索本地化仍未覆盖韩/日。

## 2026-11-04 · Bootstrap new worktrees and scope pre-push gates by change type (#790)

- 起因：新 worktree 未装依赖时 pre-push 会静默跳过 `gctl check`，PR-1/2/3 的推送只跑了密钥扫描；`--fast` 又不含单测，本地验证实际覆盖率取决于人是否记得装依赖。
- 改动：
  - `scripts/create-worktree.mjs`：创建后自动 `gctl link-env` 并在后台执行 `pnpm install --frozen-lockfile --prefer-offline`（`WORKTREE_SKIP_INSTALL=1` 可跳过），装完前推送会被 pre-push 明确拦截。
  - 开发过程新增 §2B-2「本地验证阶梯」：纯文档 → verify-docs；代码 → `gctl check --fast` + affected 单测；DB/迁移 → 一次性库 service 组；联调 → 源码热重载；重型制品门留给 CI/发布。
  - 工作区 pre-push 钩子（`local-config/bin/git-hooks/pre-push`）按改动范围选门：纯文档只跑 verify-docs；代码缺依赖时 fail-closed；代码跑 `gctl check --fast` + `vitest related`（≤30 个改动源文件）；`GLOBAL_PREPUSH_FULL=1` 仍可升全量。
- 测试：`node --check scripts/create-worktree.mjs`；`node scripts/verify-docs.mjs`；钩子 `bash -n`。
- 未做：本地不构建运行镜像（build-once + 构建证明只在发布工作流）；affected 单测的阈值待真实 PR 观察后再调。

## 2026-11-04 · Bind an optional attempt id into workspace execution-budget request scopes (#791)

- 起因：一次失败的 ICP 生成/查询计划生成/执行在预算 Grant 层面会永久砖化——请求作用域只有 `operation + subject`，同一 ICP 的第二次生成、同一计划的第二次执行必然 `EXECUTION_BUDGET_GRANT_REUSED`（断点 B2/B3/B13/B14，「重试」无路可走的根）。
- 改动：`POST /companies/:companyId/icps`、`POST /icps/:icpId/query-plans`、`POST /query-plans/:planId/execute` 三处请求作用域与 quote 请求解析接受可选 `body.attemptId`（UUID），进入 `requestSha256`；**缺省时哈希与旧版逐字节一致**（旧 Grant、in-flight run 语义不变）；同一 attempt 重放仍被拒（幂等），新 attempt 放行并各自独立预算账户。控制器新增可选 DTO（Swagger `ApiBody`），非法 attemptId 由 ValidationPipe / quote 解析拒绝。
- 测试：`execution-budget-request-scope.spec` 表驱动新增三个带 attempt 的哈希向量（旧向量原样保留）；`workspace-technical-budget-quote.controller.spec` 新增 attempt 绑定、同 attempt 幂等、非法 attempt 拒绝用例；全量 `@global/api` 单测。
- 未做：`POST /query-plans/:planId/rerun` 端点与前端「重试」按钮（下一 PR）；gain-saas signer/路由透传（同批另一 PR，发布需同批）；TaskRun `attempt`/`rerunOf` 列（gain-saas 域）。

## 2026-11-04 · Grant app_user UPDATE on run_shadow_diff for shadow upserts (#792)

- 起因：M0⑥ 影子对比由 `runShadowDiff.upsert` 写入，但 `20261104130000_run_shadow_diff` 只授了 `SELECT, INSERT`（照抄 `run_event` 的 append-only 模式）；首个真实影子 run 即以 `42501 permission denied for table run_shadow_diff` 失败（2026-11-04 影子两轮验收发现）。
- 改动：
  - 新迁移 `20261104190000_run_shadow_diff_app_user_grants`：`GRANT UPDATE`（无删除路径，`DELETE` 保持不授）。
  - `docs/governance/app-user-table-privileges.json`：`run_shadow_diff` → `INSERT, SELECT, UPDATE`。
  - 权限矩阵行为测试新增用例：以 `app_user` 在租户上下文中真实执行 create → update upsert（事务回滚）。
- 测试：本地 `global_test` 上 RED（42501，与生产一致）→ GREEN（15/15）；CI 必需检查验证。
- 未做：无。

## 2026-11-04 · Keep a busy event loop from draining the worker on live dependencies (#794)

- 起因：2026-11-04 影子验收 run `768638fc` 的抽取负载把 worker 事件循环压住，依赖心跳的模型网关探测（2 秒硬超时）连续 3 轮假阳性超时，worker 以 `MODEL_GATEWAY_UNAVAILABLE` 立即排空（lease `WORKER STOPPED`）；工作流下一个 workflow task 在 `understanding` 队列无人取，run 保持 RUNNING 无任何推进，直到人工重启容器。
- 改动：
  - `worker-dependency-heartbeat.ts`：探测前采样事件循环滞后，滞后 ≥1s 时跳过该轮（不计失败、不探测）；采样器可注入。
  - `managed-dependency-readiness.ts`：模型网关探测超时 2s→10s。
  - 测试：滞后跳轮与探测超时两个新用例；相关套件 140 passed。
- 测试：`vitest run` 两个 spec 45/45；`vitest related` 140 passed / 8 skipped；`nest build` 通过。
- 部署：需随下一班车发布新运行时镜像；现网已人工重启 worker 恢复。
- 未做：依赖真失联时的自动恢复（排空仍为 fail-closed，需重启容器）不变，另开工单讨论。

## 2026-11-04 · Rerun EXECUTED query plans with a fresh attemptId and carry taskRef on DiscoveryRunCompleted (#795)

- 起因：一次失败的执行会永久砖化计划——plan 收尾后变 EXECUTED，再 execute 恒 409 INVALID_STATE；#791 已让请求作用域接受 attemptId，但状态门仍挡着重跑（断点 B3/B13，产品负责人亲历「4 秒 PARTIAL 后无任何重试路径」）。经 P1 设计评审裁定：不新增独立 rerun 端点，放宽既有 execute 的状态门（改写 `docs/modules/discovery-qualification/technical.md` §6）。
- 改动：
  - `DiscoveryService.executePlan` 状态门改为 READY | EXECUTED；EXECUTED 且未带 attemptId → 409 `RERUN_REQUIRES_ATTEMPT`（DRAFT 等其余状态维持 INVALID_STATE）。凭新 attemptId 时 scope/事务结构不变：新请求哈希 → 新 Grant → 新预算账户 → 新 run/outbox。
  - `DiscoveryRunCompleted` payload additive 追加 `taskRef`：SaaS 在「引擎已建 run、BFF 丢响应」窗口据此回填 engineRunId（schemaVersion 2 不变，消费端容忍缺省）。
  - 控制器/操作描述/DTO 文档与引擎工作流过期注释同步；契约快照重导出（仅描述与 409 码变化，无 schema/枚举变更）。
- 测试：新增 `discovery.execute-rerun.spec.ts`（READY 旧行为不变；EXECUTED+attemptId 建 run 且 outbox v2；EXECUTED 缺 attemptId → 409 且不建 run/outbox；DRAFT+attemptId → INVALID_STATE）；`discovery.activities.spec` 增加 taskRef payload 用例（300/300）；request-scope 黄金向量不动；全量 `@global/api` 单测。
- 未做：独立 rerun 端点、引擎侧 attempt/rerunOf 落库（attempt 权威在 SaaS TaskRun，见 P1-G1）、`Idempotency-Key` 头与同 plan 并发 run 的 advisory lock（后续改造）；attemptId 缺省时引擎行为逐字节不变。

## 2026-11-04 · Make the seller profile's target markets and industry authoritative for ICP generation (#796)

- 起因：P1 断点 B1——`icp.service.generateFromCompany` 的提示词只喂了名称/官网/已审批 Claim/产品，**没读档案的 `targetMarkets`（ISO）与 `industry`**——ICP 的目标市场由模型自行猜测。实证：workspace c3584cf9 的档案 `target_markets={MY}`，生成的 ICP 全是「珠三角电子元件/线路板制造企业」，后续查询计划的语言/国家跟着错。
- 改动：
  - 提示词注入卖方档案权威输入：目标市场按 `ISO（中文名）` 列出，附「档案为准、ICP 只细化；输出 target_markets 必须覆盖以上市场，可追加但不得替换」的指令；industry 一并注入。档案无市场/行业时提示词与行为与旧版一致。
  - 确定性后校验（不靠模型自觉）：落库前用 `completeTargetMarkets` 把模型输出的自由文本市场与档案 ISO 归一比对（复用 `targetCountryCodes` 的中文/地区词解析 + 中文国名兜底），缺哪个补哪个、已覆盖的不重复追加。
  - `vocab.ts` 新增 `COUNTRY_NAME_BY_ISO`（ISO→中文国名，未收录回退代码本身；纯新增、无既有调用方语义变化）。
- 测试：`icp.service.spec` 新增 4 用例（提示词注入含 MY（马来西亚）/行业/权威措辞且落库为模型值；模型漏掉档案市场时补齐；模型以中文名写出的档案市场不重复追加；档案无市场/行业时提示词与落库行为不变）；`icp` 相关 14 文件 76 用例全绿。
- 未做：ICP 详情页/run 页的「目标市场（来自档案）+ 模型补充」展示与不一致提示（前端，随 P1-G2/P6）；档案市场修改后的「重新生成」入口（依赖 P1-G1/G2 的 attempt 链路）；`COUNTRY_ISO` 词表扩展维持 P2 语言层范围。

## 2026-11-04 · HTTP-first page fetching with readability extraction and env-tunable crawl settings (#797)

- 起因：抓取层三处浪费（主计划 §3.5b / Q34）——每个页面无条件走 Crawl4AI 浏览器 `/md` 渲染（超时 75s）、渲染请求硬编码 `delay_before_return_html: 3.0`（每页固定等 3 秒）+ `cache_mode: BYPASS`（从不用缓存）、抓取限速与并发写死无 env；独立基准显示无浏览器抽取质量更高（F1 0.955 vs 0.790）且快 24–35 倍。
- 改动：
  - 新增 `adapters/http-first-fetch.ts`：受治理的普通 HTTP 抓取（复用 requestPublicHttp 逐跳 IP 钉扎与 physical-wire 观测）→ readability + linkedom 抽正文 → turndown 转 Markdown；薄页/非 HTML/失败返回 null 触发回落。
  - `crawl4ai.fetch` 工具：先走 HTTP-first（env `HTTP_FIRST_FETCH` 默认 on，仅显式 off 才回纯渲染），40 行渲染路径保留为 fail-safe 兜底；渲染 429 单次重试（`CRAWLER_429_RETRY_DELAY_MS`）。
  - 渲染参数 env 化：`CRAWLER_RENDER_DELAY_MS`（默认 500ms，原硬编码 3000）与 `CRAWLER_CACHE_MODE`（默认 ENABLED，原 BYPASS）。
  - 限速/并发 env 化：`CRAWL4AI_FETCH_RPS`（默认 4）、`CRAWL4AI_FETCH_CONCURRENCY`（默认 6）、`CRAWL4AI_FETCH_DOMAIN_DELAY_MS`（默认 2000）。
  - 新增依赖 `@mozilla/readability`、`linkedom`、`turndown`；Copy 回执重签与漏洞基线重绑随本 PR。
- 测试：新增 http-first/工具分级/参数 env 三组用例（30 用例）；`vitest related` 491 passed；`nest build` 通过。真实效果以 golden mini-run 验收（静态页 p50 ≤0.5s、渲染占比 <30%、同集合召回不降）。
- 未做：ETag/304 与 LLM 抽取缓存（PR-B）；trafilatura sidecar 与自适应域延迟（PR-C）；Crawl4AI 0.9.5 安全升级（独立 PR）。

## 2026-11-04 · Extend search localization to ms/id/vi/th/ja/ko/pt/tr and report stripped terms (#798)

- 起因：P2（方案 §2.3）——语言层此前只有 de/en/fr/it/es/nl/pl/zh。产品负责人的马来西亚档案（target_markets={MY}）即使 ICP 目标市场正确，检索仍会回落到 en 并把马来语关键词当外语处理；被剥离的关键词也无留痕，规划器语言错误无从发现。
- 改动：
  - `SearchLanguage` 扩为 16 种：新增 ms/id/vi/th/ja/ko/pt/tr；COUNTRIES 增 MY/ID/VN/TH/JP/KR/PT/TR（各带中文/英文/ISO 别名与本地语言名）；两类角色词补全八语言（如 ms: pemborong/peniaga/pengedar、ja: 販売代理店/卸売業者/ディーラー、tr: distribütör/toptancı/bayi）；planner 语言名表同步。
  - 按语言的检索词脚本规则（P2 §2.3）：zh 保留含汉字的词并剥离纯拉丁词；ja 保留汉字/假名词；ko 保留谚文词；其余语言维持剔除 CJK。新增 `partitionSearchTerms` 返回「可用词 + 被剥离词」，`searchableTerms` 保持旧签名。
  - 执行侧：`public_web` 发现时把被剥离的词记一行日志（截断 5 个），作为规划器关键词语言错误的直接证据。
- 测试：`search-localization.spec` 新增八语言解析 / 角色词 / 脚本过滤与剥离报告用例（zh 语义按方案收紧）；`public-web-search-first.spec` 新增马来西亚马来语经销商串与日本日语串；既有德语/中文回归不变；全量 `@global/api` 单测。
- 未做：规划器关键词语言校验与一次自动重写（P2 第二步，随后单独 PR）；马来西亚/中文市场的端到端验收由发版后按方案 §2.6-2/6 执行。

## 2026-11-04 · Cast the run-event advisory lock result so Prisma can deserialize it (#799)

- 起因：#788 的 run 事件 seq 分配用 `$queryRaw` 读取 `pg_advisory_xact_lock(...)`（返回 void），首次随第十八班镜像上生产即被 Prisma 拒绝（`Failed to deserialize column of type 'void'`），所有新 discovery run 在 quickScan 阶段 10 秒内 FAILED；单测用注入的 fake tx 因此未覆盖真库路径。
- 改动：`run-events.ts` 锁查询加 `::text AS locked` 转型（与 suppression-policy-lock 既有做法一致）；新增 `run-events.postgres.spec.ts` 真库回归用例（含夹具链与清理）。
- 测试：真库用例修复前 RED（复现生产同款错误）→ 修复后 GREEN；既有 run-events 单测保持绿。
- 未做：CI 步骤接线（另开小 PR，避免本次热修触发 ci.yml 全量重门）；后续同类 `$queryRaw` void 语句按同一模式排查。

## 2026-11-04 · Validate planner keyword language against the market and rewrite once before failing (#800)

- 起因：P2 第一步把语言层扩到 16 种，但规划器（LLM）仍可能把中文关键词写进马来语/德语查询——这类计划执行时检索必然全空，用户只看到「没结果」，看不出是语言问题。
- 改动：`generateQueryPlan` 落库前做确定性关键词语言校验：逐条查询按 `filters.country`（回落 ICP 目标市场）确定语言，关键词存在却**全部**不能用于该语言检索时触发**一次**自动重写（提示词明确要求全部 keywords 用目标市场语言书写、不得出现中文）；重写后仍不符则抛 409 `DISCOVERY_KEYWORDS_LANGUAGE_MISMATCH`，提示调整目标市场或关键词后重试。命中合规的计划只调用一次规划器（零额外成本）。
- 测试：`icp.service.spec` 新增 3 用例——语言不符触发一次重写并以重写结果落库（重写提示词含「马来语」）、重写仍不符显性失败且不落库、关键词本已合规时只调用一次规划器；全量 `@global/api` 单测。
- 未做：不做逐条关键词的自动翻译（重写交给规划器）；中文/马来端到端验收随发版按方案 §2.6-2/6 执行。

## 2026-11-04 · Sweep stale RESERVED tool-budget operations in the raw-retention workflow (#801)

- 起因：巡检（2026-11-04）发现 `tool_budget_operation` 累计 298 条 RESERVED（最早 2026-10-09），没有对账/清收任务。超时未结算的预留是孤儿（活动崩溃/重启后再无人 settle/release）：既占住账户可用额度，又让同一 operation_key 的重试活动撞 `BudgetOperationReplayError`（近 7 天 6 个 run 因此失败，见 `discovery_run.stats.failure`）。
- 改动：
  - 新迁移 `20261104220000_tool_budget_operation_reconcile`：SECURITY DEFINER 函数 `reconcile_stale_tool_budget_operations_v1(workspace, olderThanHours, limit)`，按工作区把超时 RESERVED 释放（observed/charged=0、settled_at=now、账户 reserved_microusd 回补），与 `release_tool_budget_microusd_v1` 对 RESERVED 的释放语义一致；安全形状沿用 retention 模式（app_user + workspace 守卫 + 账户 advisory 锁 + FOR UPDATE SKIP LOCKED + pg_temp 末位 search_path）。
  - 该清理并入现有 raw-retention sweep（每工作区每轮最多 5 批 × 200 条），用 `budget-operation-reconcile-v1` patch 守卫——patch 前的旧历史重放不调度新活动。
- 测试：迁移静态契约 4 用例（事务边界/守卫/释放语义/仅 app_user 可执行）；raw-retention 工作流新增 2 用例（按工作区清收到无更多、patch 前不调度）；一次性库实测（模拟 app_user 会话：释放 1 条 200µUSD、账户 500→300、fresh RESERVED 与 SETTLED 不受影响、superuser 直调被 `TOOL_BUDGET_RECONCILE_DENIED` 拒绝）；`security-definer-search-path` 通过；全量 `@global/api` 单测。
- 未做：不处理「仍在生命周期内」的 RESERVED（阈值默认 24h，活动超时上限远小于它）；不做对账报表与告警（被清收的数量进 workflow 日志）；`BudgetOperationReplayError` 的调用侧语义维持 fail-closed 不变。

## 2026-11-04 · Label deep-stage discovery failures with their own stage (#802)

- 起因：巡检实测（run f8f494e8，取消落在深挖段）发现 `stats.failure.stage` 记的是 `quickScan`——工作流的 stage 变量在进入深挖后没有更新，失败/取消记录因此指向错误的阶段（前端阶段卡与排障都受影响）。
- 改动：`DiscoveryRunStage` 增加 `'deep'`；进入深挖（`markRunPhase(deep_started)`）后把 stage 置为 `'deep'`，用 `discovery-deep-stage-label-v1` patch 守卫——patch 前的旧历史重放仍按原值记录，命令序列不变。前端（runs 页 FAILURE_STAGE/TECH_FAILURE_STAGE）在 P1-G3 已支持 `deep` 的映射，无需改动。
- 测试：`discovery.run2.workflow.spec` 新增用例——深挖子工作流以 Temporal 失败中止时，最终 `finalizeRun(FAILED)` 的 `stats.failure.stage === 'deep'`；run2 工作流套件 8/8。
- 未做：不改变任何取消/失败语义（仅修正记录值）；不新增事件类型。

## 2026-11-04 · Judge shadow recall on the compared companies and wire the run-event lock test into CI (#803)

- 起因：影子验收第二轮实况（老路径判 66 家/正面 27，快扫判 27 家/正面 6）——`recallNotLower` 按两侧总数比较，在池子天然不等时把「覆盖差异」误报成「召回下降」；另 run-events 真库用例（#799 热修附带）尚未接入 CI，同类 void 列问题可能再次裸奔上线。
- 改动：`recordRunShadowDiff` 的召回判定改为 **compared 集内比较**（summary 聚合数保留两侧覆盖口径）；新增「不等池子」单测（聚合 4<7 但同集合 4≥3 → 不降）；CI 增加 `run-events.postgres.spec.ts` 步骤（global_test 已迁移环境下执行真实锁语句）。
- 测试：activities spec 9/9；CI 全门（本 PR 含 ci.yml，全量重门跑一遍）。
- 未做：无。

## 2026-11-04 · Move platform channel governance to an ops-only scope (data-source ownership P3) (#804)

- 起因：巡检 B7 实证：平台渠道注册/治理（`source_channel` 为全局表、无 workspace 维度）的写端点与租户共用 `acquisition:write`，任何租户管理员都能新建/改写平台级渠道；运营台 `/ops` 没有渠道页，租户设置页反而承担了平台治理职责。
- 改动：新增引擎授权 scope `ops:write`（`AUTHORIZATION_SCOPES` 第 12 个，运营身份 `saas-ops` 专用，租户角色不得携带）；渠道端点重划权限——`GET /source-channels`→`ops:read`，`POST /source-channels`、`PATCH /source-channels/{id}`、`preview`、`run`→`ops:write`，租户保留 `available`（`acquisition:read`）、enable/disable（`acquisition:write`）与私有导入；导入契约提示：`import-template` 返回 `columns` 与建议 `mapping`，`mapping` 缺失/错配时错误信息列出可用列并给示例；OpenAPI 补 `Channels` tag 描述并重新导出（顺带修复该 tag 缺失的既有漂移）。gain-saas 同批 PR：运营台新增渠道数据源页（`saas-ops` 引擎角色 + 操作审计落 `AuditLog`），租户设置页收缩为「启用渠道 + 导入名单」。
- 测试：`scopes.spec` 十二 scope 闭合契约；新增 `channels-authz.http.spec`（租户身份调用平台端点 403 且零服务调用、`ops` 身份调用租户端点 403、匿名 401、OpenAPI `x-required-scopes` 契约、导入模板 `mapping`）；`channel-import.spec` 增加建议映射与错误提示用例；`authz-openapi`/`controller-authz`/`operation-descriptions` 门全绿。
- 未做：抓取执行仍 fail-closed 409（`platform.channel_crawl` purpose 按 implementation-record 分段实施）；引擎侧不新增审计表——运营动作的 actor 审计落在 gain-saas `AuditLog`（引擎记录本身即渠道表时间戳与运行记录）。

## 2026-11-03 · Persist onboarding seller facts on CompanyProfile and let companies be created without a website (#743)

- 起因：Phase 1（D16/D17）要求注册引导的公司/产品/目标市场/业务邮箱成为卖家事实 SoR；此前 `POST /companies` 必须带官网，products/targetMarkets/businessEmail 只留在 site-builder intake 的 JSON 里，ICP 与理解都消费不到。
- 改动：
  - `company_profile` 新增 `target_markets TEXT[]`、`business_email TEXT`（迁移 `20261102170000_phase1_seller_sourcing_fields`）；`offering` 新增 `source`（onboarding | understanding | manual）。
  - `POST /companies`：`website` 变可选（`website` 与 `name` 至少一个，否则 400）；新增可选 `industry/targetMarkets/products/businessEmail`；`products` 落 `Offering(source=onboarding, skipDuplicates)`；有官网才消费 Grant 并发 `CompanyProfileCreated`，无官网返回 `understanding=not_started`（不发事件、不消费 Grant）。
  - 技术报价 op `POST /companies` 请求变体与 request scope 同步扩展（exactKeys 白名单、ISO 码/数量上限校验）。
  - `CompanyDto` 增补 `targetMarkets`、`businessEmail`、`understanding`（后两者可选，避免响应侧破坏性变更）。
- 测试：company.service 新增「无官网建档不发事件不消费 Grant」「有官网照常」「产品落 Offering」「双缺 400」四例；`workspace-authority-atomicity` 回放断言同步 `understanding`；OpenAPI 已重导出。
- 未做：理解工作流本体不改为双源（资料库 Phase 2/3 接入）；`business_email` 的 PII 分类与加密方案待法务确认（PRD SD11 备注）。

## 2026-11-03 · Drop same-name namesakes and organisation-shaped person names in contact discovery (#744)

- 起因：M5 Golden Set 首轮（`docs/evidence/2026-11-03-contact-golden-set-m5.md`）误报 19.6%，集中在两类可定位机制：①社媒层把「公司名恰为姓氏」的异国同名个人当成员工（3 人）；②LinkedIn 机构页整条被当成个人入库（1 条「公司当人」）。
- 改动：
  - **同姓守卫**（`social-presence` 的 L3 标题筛选）：解析出人名后，标题去掉人名必须仍有独立的公司佐证（公司名 token 或域名词根）；公司 token 只与人名重合时丢弃。
  - **机构名守卫** `cleanPersonName` / `looksLikeOrganizationName`（`contact-extraction`，覆盖 `contact.find_decision_makers` 全部抽取消费方 + 社媒标题）：先剥离括号注记（模型常写 `Max Mustermann (Geschäftsführer)`，剥离后是真人名则保留），剩余部分带法律形式/机构词才丢弃；词表含 group/holding/company/sa/bv 等，`Co`（真实姓氏）与 `ag` 不误伤——只有全大写 `AG` 与带点 `Co.` 按公司形式处理。社媒丢弃原因计入 run diagnostics（`social_namesake_dropped` / `social_organisation_dropped`），不再是静默损失。
- 测试：社媒 provider spec 新增「同姓保留/拒绝」与机构名识别用例；相关 provider、回执消费者与联系人 stage 全组通过；全量单测见 PR。
- 部署：无迁移；随下一班车上线。
- 未做：同名异国公司（如德国泵店与美/英同名工程公司）靠字符串佐证无法区分，本轮该类 6 个误报仍在；需公司级消歧（国家/行业/雇主字段证据），记为后续。同姓守卫的代价：以家族姓氏命名的公司（如 `Pumpen Schmid GmbH`）里，若员工 LinkedIn 标题只写人名不带公司段，该候选会在 L3 被丢弃（此前会靠姓氏子串误放行、再靠档案页确证）——属「宁缺勿错」取舍，丢弃已计入 diagnostics。已入库的机构名旧行（M5 那轮的 BTS 条目）不在本 PR 清理范围内。

## 2026-11-03 · Add a client attemptId to on-demand contact discovery (#745)

- 起因：`POST /canonical-companies/:id/discover-contacts` 的预算请求作用域此前只绑定 `companyId`，同一公司第二次点击「发现联系人」会命中已消费的一次性 Grant，返回 `EXECUTION_BUDGET_GRANT_REUSED`；理解重试（#730）已用客户端 `attemptId` 隔离每次尝试，联系人发现缺少同样机制。
- 改动：
  - `DiscoverContactsDto` 增加可选 `attemptId`（UUID，1–8 版），由客户端每次点击生成。
  - `workspaceExecutionBudgetRequestScope` 仅在请求携带 `attemptId` 时才把它并入规范化材料；缺省时 requestSha256 与旧版完全一致，存量 Grant 不受影响。
  - `discoverContactsExecutionBudgetRequestScope` 作为 HTTP 适配器与 Grant 签发共用的规范边界；`DiscoveryService.discoverContacts` 用它消费 workspace Grant。
  - 技术报价控制器接受可选 `body: { attemptId }` 并校验 UUID；OpenAPI 合同（`workspace-technical-quote` oneOf 与 `DiscoverContactsDto`）同步。
- 测试：`execution-budget-request-scope.spec.ts` 新增「带 attemptId 的新哈希」用例与「缺省保持旧哈希」断言；`workspace-technical-budget-quote.controller.spec.ts` 新增带 attemptId 的报价与非法 UUID 拒绝用例。已用现有 pnpm store 运行这两个 spec：2 个文件 / 24 个用例全过；全量单测交由 PR CI。
- 未做：SaaS BFF 默认仍关闭该字段（`ENGINE_DISCOVER_ATTEMPT_ID_ENABLED=false`，会在旧引擎下从 quote 与转发体剥离），待本镜像发布后再开启；不改变 `lawfulBasis` 校验、发现结果语义或一次性 Grant 的其它约束；不发布镜像。

## 2026-11-03 · Record the Phase 1 onboarding landing and the first DONE discovery run in current status (#746)

- 起因：Phase 1（卖家事实字段、注册引导向导、BFF 门禁）已随第十二班上线并验收；状态页仍把它写成「下一步」，且「没有一次 COMPLETED run」的说法在 2026-11-03 02:07 首次 `DONE` run（`5e7401f6`）之后已过时。
- 改动：`docs/status/current.md` 刷新到 2026-11-03 基线（36 次 run：13 PARTIAL/22 FAILED/1 DONE；lead 5 689；company_profile 6/13/28/30；gain-saas 7 users/10 workspace/5 membership；运行镜像 `36412147`（build `5a526747`））；新增 Phase 1 上线与端到端验收记录；§4 在途归零；§5 改为 Phase 2/2b 进行中；G3/G5/G6 的措辞按首个 `DONE` run 更新。`docs/status/implementation-matrix.md` 的 01/02 模块行同步。
- 测试：`node scripts/verify-docs.mjs`（本地）。
- 未做：不改产品代码与运行时；`DONE` run 的输入/质量评估留给 Phase 2b 的 golden set。

## 2026-11-03 · Add the seller document library schema with RLS, hybrid-search indexes and least-privilege grants (#747)

- 起因：模块 02 卖家资料库（Phase 2）此前只有设计与 site-builder KB 的复用面；原始资料需要空间隔离的表、活跃内容去重、检索索引与 RLS 授权。
- 改动：
  - 新迁移 `20261103120000_seller_documents`：`seller_document`（状态机/租约/软删/内容 hash）与 `seller_document_chunk`（BGE-M3 `vector(1024)`、生成列 `text_tsv` + GIN、halfvec HNSW、复合 FK 防跨空间挂接）；活跃内容部分唯一索引（`WHERE deleted_at IS NULL`）；两表 FORCE RLS，`app_user` 仅 SELECT/INSERT/UPDATE（物理删除只走 owner 的 DSR 路径）。
  - Prisma 模型 `SellerDocument`/`SellerDocumentChunk` 与 `CompanyProfile.sellerDocuments` 关系；chunk 的向量列用 `Unsupported`，检索将走 raw SQL。
  - `docs/governance/app-user-table-privileges.json` 登记两表；新增静态迁移契约测试。
- 测试：`apps/api/src/seller-knowledge/seller-document.migration.spec.ts`（迁移顺序/事务边界/列集/部分唯一索引/生成列与索引/RLS 与授权/Prisma 同步）；真库 `app_user` 授权由 CI PostgreSQL job 的 app-user 规格覆盖。
- 未做：本 PR 不含 API/pipeline/bucket（后续 PR）；`CompanyProfile.understandingSources/deletedAt` 与 `KnowledgeSource.sellerDocumentId` 等扩展列入后续。

## 2026-11-03 · Recover people-page links from raw HTML when the crawler markdown drops them (#748)

- 起因：M5 评估里 5 家零产出公司的排查——真实 Impressum 都在首页**原始 HTML 的锚点**里（导航/JS 菜单），但 crawl4ai 的 markdown 输出没有带出这些链接；固定路径只覆盖 `/impressum` 等少数标准形态，非标准路径（`/ando-technik/impressum/`、`common/info/impressum.html`）从未被选中。另有一类裸域→www 站点，固定路径落在站点的坏跳转上（`www.x.deimpressum/`）。
- 改动：`decision-maker` 选页在 markdown 人物页链接不足 3 条时，改用 `http.get` 抓首页**原始 HTML** 补抽同站锚点（www 容忍、去 query/hash、相对链接解析、仅同站），并用响应 `finalUrl` 的主机重拼固定路径（裸域→www 场景）。
  - 审查补强：`contact.find_decision_makers` 白名单补回 `http.get`（11-01 被 social.fetch 替换后，回退会被 ToolBroker 拒绝并当 control 抛出——比修复前更糟，已实测）；锚点解析改为线性扫描并截断 1MB（回溯正则在 3MB 恶意/未闭合页面上是 O(n²)，实测 384KB≈66s）；`finalUrl` 主机加可注册域校验（过期/停放域名的跨站跳转不跟）；跨 markdown/finalUrl 的同一页按 www 不敏感去重，不占预抓名额。
- 测试：锚点抽取单测（相对链接、www、mailto/js、外站、去重、无引号 href、3MB 恶意串限时）与 provider 级回退用例（markdown 无链接 → `http.get` 补抽 → **非标准路径** `common/info/impressum.html` 被预抓且排在固定路径之前、固定路径使用重定向主机）；`contact.find_decision_makers` 允许工具集含 `http.get` 由 task-registry 规格锁定。
- 部署：无迁移；随下一班车上线。
- 未做：未接 sitemap 索引/压缩链路（本轮实测部分站点 sitemap 不含 Impressum 或为空索引，收益不足）；已入库的旧结果不回溯重算。

## 2026-11-03 · Add the seller document library API with presigned upload, commit validation and quota (#749)

- 起因：资料库表已就位（#747），但没有上传/管理入口；Phase 2 需要 presign/commit/列表/下载/重试/软删，并保证 bucket 先于代码上线。
- 改动：
  - 新增 \`SellerKnowledgeModule\`（模块 02）与 7 个端点：\`POST /companies/:id/seller-documents/presign\`、\`POST …/:documentId/commit\`、\`GET /companies/:id/seller-documents\`、\`GET /seller-documents/:id\`、\`GET /seller-documents/:id/download-url\`、\`POST /seller-documents/:id/retry\`、\`DELETE /seller-documents/:id\`。scope：写 = \`acquisition:write\`，读 = \`acquisition:read\`，删除 = \`acquisition:review\`。
  - 独立 bucket 客户端 \`SellerDocumentsStorage\`（\`SELLER_DOCUMENTS_S3_BUCKET\`，默认 \`global-seller-documents\`）：presigned PUT 带 1 天过期的 staging 生命周期 tag；canonical 换空 tag 永不自动过期。
  - commit：CAS 认领（attempt + 租约）→ HEAD/流式 sha256/魔数（复用 site-builder 嗅探）→ canonical 转存 → queued 并入队 ingest；同公司活跃内容重复撞部分唯一索引返回 409 并清理副本；未上传完成回到 pending_upload。
  - 配额：每空间 500 份/2 GiB、每公司 200 份（env 可调），presign 时 409。
  - 部署：\`docker-compose\` 与 \`infra/minio/bootstrap.sh\` 增加资料库 bucket 与生命周期断言；\`runtime-deployment-contract\` 规格同步。
- 测试：service 规格 8 例（类型/配额/成功/魔数/重复/未完成/软删）；OpenAPI 由 code-first 导出。
- 未做：ingest 工作流（2b，本块的 launcher 为占位，文档停在 queued）；混合检索端点（2b）；commit 暂不要求 Execution Budget Grant——docling/embeddings 为自托管零成本，Phase 3 的 \`extract_facts\` 模型调用再按其自身 op 引入 Grant。

## 2026-11-03 · Ingest seller documents through Docling, chunking and BGE-M3 embeddings; add hybrid search (#751)

- 起因：资料库 API（#749）提交后文档停在 queued；需要把「上传→解析→可检索」闭环，替换占位 launcher。
- 改动：
  - 新 Temporal 工作流 `sellerDocumentIngestWorkflow` + `createSellerDocumentActivities`：fenced 租约认领 → 有界下载 → Docling 解析（文本类直读）→ `chunkMarkdown` 结构感知分块（上限 512 块）→ BGE-M3 批量嵌入（32/批）→ 事务写 `seller_document_chunk`（含 `::vector` 字面量与生成列 tsv）→ 置 `ready`；失败按 attempt 指数退避（60s→1h，最多 8 次）回 `queued`，超过即 `failed_terminal`；finalize 以 lease 令牌围栏，不覆盖新持有者。
  - `TemporalSellerDocumentsIngestLauncher` 替换占位实现，workflowId 绑定 documentId；worker 注册新 activities 与工作流导出（`customer-workflows.ts`）。
  - 混合检索 `GET /companies/:companyId/seller-documents/search`：查询词本机嵌入后 `0.7×cosine + 0.3×ts_rank_cd`，限定公司/ready/未删，limit ≤50；附带接口门户说明。
- 测试：activities 规格 6 例（成功/下载失败/空内容/嵌入失败/not_due/gone/丢租约）；workflow 编排规格 2 例；service 规格补混合检索 2 例。
- 未做：软删对象的物理清理（canonical 对象与 chunk 行）留受控清理管线（Phase 6 DSR）；extract_facts 事实抽取（Phase 3）将按其模型 op 引入 Grant。

## 2026-11-03 · Grant seller_document_chunk DELETE to app_user so ingest replay can clear prior chunks (#755)

- 起因：Phase 2 资料摄入在首次线上验收即失败——活动内的幂等重放先 `deleteMany` 旧分块，而 `20261103120000_seller_documents` 只授了 SELECT/INSERT/UPDATE，触发 `42501 permission denied for table seller_document_chunk`（dev 实测，文档回落 queued）。
- 改动：新迁移 `20261103130000_seller_document_chunk_delete_grant` 仅对 `seller_document_chunk` 追加 `GRANT DELETE ... TO app_user`（RLS 仍按 workspace 隔离）；`seller_document` 本身维持软删（UPDATE），物理删除仍归 owner/DSR。同步 `docs/governance/app-user-table-privileges.json` 与迁移规格断言。
- 测试：迁移规格的授权断言更新；`app-user-table-privileges.postgres.spec.ts` 在 CI 的 PostgreSQL job 按治理清单核对真库授权。
- 未做：不新增周期扫描重新拉起 `retry_at` 回退的文档（当前靠 `POST /seller-documents/:id/retry`），留 Phase 2 后续。

## 2026-11-03 · Verify the Google Patents Public Data licence wording and draft the enablement LIA (#756)

- 起因：`google_patents` 的注册表标注 `CC-BY-4.0_UNCONFIRMED`，要求启用前重新核实数据集条款；产品负责人 2026-11-03 决定先保持禁用，并同意先做核实与 LIA 草稿。
- 改动：按 Google Cloud 官方公告原文核实为 CC BY 4.0（署名：`"Google Patents Public Data" by IFI CLAIMS Patent Services and Google, CC BY 4.0`），注册表分类改为 `CC-BY-4.0_CONFIRMED` 并重生成 `docs/backend/provider-registry.md`；新增 `docs/superpowers/plans/2026-11-03-google-patents-enablement-lia.md`（DRAFT）：许可核实结论、LIA 草稿与启用清单。
- 测试：`governance:verify` 校验注册表与生成文档一致（CI 执行）。
- 未做：未改任何运行时状态——`data_provider.google_patents` 仍 DISABLED、`PATENT_SOURCE_MODE=off`、`patents-cache-refresh` 仍暂停；LIA 待产品负责人签署，平台执行契约变更与启用另走 PR 与发布。

## 2026-11-03 · Let sellers edit DRAFT company profiles, soft-delete them, and find official websites via search (#757)

- 起因：卖家建档后无法补官网、无法删除测试档案，无官网的公司永远停在「待理解」；产品负责人 2026-11-03 拍板「编辑与自动找官网一起做」。
- 改动：引擎新增 `PATCH /companies/:companyId`（DRAFT 内可改名称/官网/行业/目标市场/业务邮箱，官网仍过 SSRF 守卫）、`DELETE /companies/:companyId`（软删 `company_profile.deleted_at`，列表/详情/完整度/产品视图过滤）、`POST /companies/:companyId/website-candidates`（SearXNG 两个有界查询 + 目录/社交/搜索引擎过滤 + 标题匹配排序，最多 5 条候选，人工确认后采用）；`retryUnderstanding` 放宽为「DRAFT + 有官网」可启动首次理解，并用 10 分钟排队事件防止重复启动（失败重试语义不变）。gain-saas BFF 增加三条透传路由，公司档案页新增编辑弹窗（含「自动找官网」候选列表）、删除与会话式启动理解；vben RequestClient 补 `patch` 方法。
- 测试：引擎 28 例新/改用例（编辑、软删、retry 放宽与排队防护、候选排序/过滤/去重/语言选择/搜索失败容错）；BFF 路由表规格覆盖三条新路由；全量 API 单测 10676 通过；gain-saas server 182 测试通过、web 构建通过（vue-tsc 仅余主干既有 2 条 vxe-pc-ui 声明缺失）。
- 未做：products/Offering 的编辑对账不在本期；软删档案的物理清除归 owner/DSR；「自动找官网」不自动采信（避免理解到错误公司），且对无意义名称（如「111111」）返回空由用户手填。

## 2026-11-03 · Record FAILED discovery runs even when the workflow stopped before folding stored query receipts (#759)

- 起因：2026-11-03 的真实寻源 run（fdb7778d）在查询批量里一个查询 429 失败、另一个已成功并落收据；工作流按计划顺序先处理失败查询并停止，已成功查询的收据没被折叠进 FAILED 收尾统计，收尾的一致性核对报 `DISCOVERY_QUERY_RECEIPT_FINALIZE_DRIFT` 三次后工作流失败，run 行永远停在 RUNNING。
- 改动：① 批量循环先折叠全部成功查询、再处理失败（失败仍停止 run，命令序列不变）；② `finalizeRun` 对 `status='FAILED'` 以库内已落盘收据为准补齐派生统计，不再因工作流侧不完整而拒绝写入——成功/部分成功路径的严格漂移校验保持不变；③ 相应收紧/更新 BI-25 的单测语义（未见的收据现在随 FAILED 记录，阶段错误照常上报）。
- 测试：新增工作流级用例（批量中一个失败、一个成功 → FAILED 统计含已落盘收据）与收尾级回归用例（FAILED + 空 perQuery 仍记录派生收据）；`discovery.activities`（300 例）、`workspace-authority.workflow`（90 例）通过；全量单测 10672 通过，余下 browser-readiness-probe/platform-revocation-http/git-reviewed-evidence 的单文件复跑均通过（xin 负载假红，CLAUDE.md §6）。
- 未做：不改变成功路径的收据一致性语义；未给失败的 run 增加自动重跑；`DISCOVERY_QUERY_RECEIPT_STORE_INVALID` 等存储损坏仍按原样拒绝。

## 2026-11-03 · Fix three contact-discovery blind spots behind the zero-yield companies (#760)

- 起因：M5 第三轮复测后仍有 4 家零产出公司。逐家重放引擎取页路径（镜像 `fe0c7d71`，含 #748）后定位到三类引擎盲区与一类输入数据问题：
  - `avag-pumpen.de`：裸域的 `robots.txt` 被 Apache 301 到不存在的伪主机（`https://www.avag-pumpen.derobots.txt`——主机与文件名直接拼接、缺 `/`），SSRF 护栏拒绝解析后被 fail-closed 成「全站禁抓」；但首页本身 301 到 www origin，其 robots 明确放行。
  - `ava-berlin.de`：crawl4ai 的 markdown 恰好带 3 条人物页链接（不含 Impressum），#748 的「不足 3 条才补原始 HTML」门槛没有触发；真实 Impressum（`common/info/impressum.html`）只在原始 HTML 锚点里，固定路径 `/impressum` 落在站点 404 上。
  - `michalowski-gmbh.de`：选页本身正确（Impressum + 三个团队页），但链接规范化剥掉了尾斜杠；该站对无斜杠形态返回 39 字节反爬空壳，crawl4ai 对四个页面全部 500，带斜杠形态才是含具名 Geschäftsführer 的真页面。
  - `jaeckel-ohg.de`：Impressum 确无具名人，但首页团队区块列了两位 geschäftsführender Gesellschafter 与销售/商务人员并附邮箱——引擎只用首页做链接发现、从不抽取首页自身；社媒层 6 条候选确为无关同名者，守卫丢弃正确。
- 改动：
  - `decision-maker` 选页：存储域名 robots 被拒时改判同注册域的**另一主机形态**（裸域 ⇄ www，站点常只在其一上配好 robots），以其自身 robots 为准，两个形态都拒绝才放弃，抓取起点同步改用放行的那一个；原始 HTML 锚点补抽不再以「markdown 不足 3 条」为前提（每个公司多一次轻量 `http.get`，仍受同一契约与主体绑定）；锚点与 markdown 链接保留站点给出的原始形态（尾斜杠），两种写法都出现时优先带斜杠形态，只用归一化键去重。
  - 抽取兜底：选定的人物页一个人都没抽到时，抽取已抓到的首页文本（小站把团队/决策人直接铺在首页）。
- 测试：锚点/链接抽取保留尾斜杠并按归一化键去重的单测（含站点两种形态内容不同的回归）；「markdown 已有 3 条人物页链接仍补抽原始 HTML」的 provider 用例；裸域 robots 被坏跳转误伤时改从 www 抓取、两个 origin 都拒才放弃的用例；首页兜底抽取（含机构名过滤）与「选定页已有人则不抽取首页」的成本闸门用例。
- 部署：无迁移；随下一班车上线。已入库的旧结果不回溯重算。
- 未做：不修 `jaeckel-ohg` 的公司名数据质量（DB 里是域名 slug，社媒 dork 引号搜 slug 只得到无关同名者）——属公司补全/命名归一的输入问题，另行排期。

## 2026-11-03 · Strip German academic titles before contact dedupe and require role evidence on social profiles (#761)

- 起因：M5 第三轮 Golden Set（`../../evidence/2026-11-03-contact-golden-set-m5.md` §9）确认三类质量问题：德语学位串 `Dipl.-Wirt.-Ing.` 让同一人两条记录各占一行；社媒索引候选只要 headline 含公司名就放行，只有公司名、没有职位词的垃圾档案漏网；第一轮遗留的 9 条存量误报只增不减。
- 改动：
  - `person-name`：身份归一的学位串白名单补齐德语多段学位（`Dipl.-Wirt.-Ing.`、`Dipl.-Kfm.` 等），带点的单 token `Ing.` 仅在名前位置剥离；`normalizePersonName` / `personNameKeyVariants` / `foldedPersonNameKey` 与 resolver 的 Tier 2 随之收敛，真实姓名 token（`Erik Ing`、`Anna Wirt`）不误伤。
  - `contact-extraction.cleanPersonName`：抽取边界复用同一剥离函数，落库姓名为净化后的形（顺带消除被称号污染的邮箱猜测本地部分）。
  - `social-presence`：`parseSocialResults` 在 #744 的公司佐证之外新增「专业佐证」门——headline 去掉人名与公司 token 后必须仍有职位/职能词，否则丢弃并记 `social_uninformative_dropped`；德语复合职位词（`Einkaufsleiterin`）按词内子串识别。
  - `apps/api/scripts/cleanup-contact-false-positives.mts`：一次性按显式 contact id 删除存量误报/重复行，默认 dry-run，`--apply` 才执行，禁止删除带 VALID 联系方式的行（除非显式放行）。
- 测试：`person-name` / `person-identity` / `contact-extraction` / `social-presence` 新增用例覆盖称号合并两方向与垃圾档案计数；单测与 `gctl check` 见 PR。
- 未做：同名异公司的公司级消歧（#744 已记为后续）；存量清理的 `--apply` 属产线动作，等用户确认后执行。

## 2026-11-03 · Relay seller document uploads through the engine so browsers can upload without reaching object storage (#762)

- 起因：Phase 2c 前端上传时发现 presign 返回的上传地址是引擎侧 `127.0.0.1:9000`（对象存储只监听宿主回环），用户在浏览器里根本连不上；直传方案对远程用户不成立。
- 改动：新增 `PUT /companies/:companyId/seller-documents/:documentId/content`：请求体按原始字节读取（独立的 51MB 上限，413 早退），校验 `pending_upload` 状态、Content-Type 与 presign 申报一致、字节数等于申报大小，再由引擎按同一 staging key 写入对象存储（`SellerDocumentsStorage.putObject`，签名与生命周期标签同 presign）。写入后照常 `commit` 校验并入队。接口说明已登记并重导出 openapi。
- 测试：服务级 6 例（成功/非 pending/类型不符/大小不符/404/存储失败）；全量 API 单测通过；`operation-descriptions` 与 seller-documents 相关规格通过。
- 未做：保留原 presign 直传路径给能访问对象存储的调用方；未加断点续传；大文件分片不在本期。

## 2026-11-02 · Keep published tags single-manifest by disabling embedded build provenance (#725)

- 起因：第七班连续失败在 digest 读回——`ghcr-runtime-publication.mjs resolve` 只接受单清单媒体类型（spec 刻意拒绝 OCI index，防 attest 未检验的平台），而 containerd 镜像存储下 buildx 默认给构建产物附带 provenance/SBOM attestation 清单，推送出的 SHA 标签指向 OCI index，HEAD 请求按 Accept 返回 404（标签实际存在、可拉取）。今天之前 classic 存储产物是单清单，所以一直没暴露。
- 改动：发布 workflow 的 `docker build` 增加 `--provenance=false --sbom=false`——发布证明由 workflow 里 `actions/attest` 的独立 attestation 承担，内嵌构建证明本就冗余；resolve 契约与脚本不变。发布契约测试同步新增两条断言锁定该 flag。
- 测试：`runtime-deployment-contract.spec.mjs` + `ghcr-runtime-publication.spec.mjs` 共 23 项全绿；下一次真实发布 run 验证。
- 未做：不改镜像内容、不改变 attestation 语义与发布产物格式；历史已推送的 index 标签保持原样。

## 2026-11-02 · Scope understanding model budget operations per workflow run and attempt (#726)

- 起因：2026-11-01 live 实测「理解失败后重试」时发现，同一公司的第 2 次真实尝试必失败：模型付费操作键（paidOperationKey 含 context.correlationId）在理解活动里没有运行/尝试维度，第一次失败后预算行以 RELEASED 保留，后续 Temporal attempt（乃至新 workflow run 的重试）在 reserve 时被判为「已有操作且无 durable result」的 remnant，抛出 `BudgetOperationReplayError`（origin=remnant）。
- 改动：`understanding.activities` 把 `workflowRunId:activityId:a<attempt>` 作为模型调用（extractClaims / extractOfferings / extractAndPersistProfile）与 crawl broker 的 correlationId；同一 attempt 内保持幂等，跨 attempt/跨重试各用独立预算操作行。
- 测试：新增 `modelOperationCorrelationId` 单测；understanding 活动/工作流既有 29 用例全绿；`gctl check` 全绿。
- 未做：其它域的模型活动（discovery / icp / outreach）有同类风险，需逐域评估后再改（不在本 PR 扩大范围）。

## 2026-11-02 · Keep contact discovery alive across attendant replay remnants and activity retries (#728)

- 起因：第七班验收 run 2dcece84 在联系人阶段以 `BudgetOperationReplayError`（origin=remnant）两连败——Temporal 重试的 attempt 2 复用了 attempt 1 留下的「已预留、未结算」账本行（模型付费操作键缺 attempt 维度），与 #726 在理解活动修掉的是同一类问题；同 attempt 内的瞬时重试撞上残影也会直接打挂活动。
- 改动：
  - `discoverRunContacts` 把 Temporal attempt 并入模型 correlationId（`<companyId>:aN`），重试不再继承上一次尝试的未结算操作键；
  - `contact-discovery-core` 与联系人阶段的邮箱补全对 `BudgetOperationReplayError(origin=remnant)` 做**残留吸收**（#684 纪律）：该适配器/该公司本轮跳过并留告警，绝不让一行残影打挂整家公司或整个 run；`origin=live` 仍是活故障，照旧上抛。
- 测试：`execution-receipt-consumers.spec.ts` 新增「remnant 吸收 + 其余适配器继续 + live 仍失败」用例；联系人相关套件 314 项全绿；全量门待 CI。
- 部署：无迁移；随下一班车（含 #726）上线后重跑联系人验收。
- 未做：工具类操作键（如 SMTP 探测）本身仍未带 attempt 维度——靠残留吸收兜底；若要根治需把 attempt 透传到 ToolContext 的操作键派生（另行评估）。
- 2026-11-02 #734 更正：本条「attempt 并入模型 correlationId」的做法已撤销（重试改为重放已结算操作，避免 APPLIED/REPLAYED 混合回执）；remnant 吸收保留。

## 2026-11-02 · Guard malformed tel links and name internal failures in the exception filter (#728)

- 起因：M4 会话在 ftc-de.com 的按需联系人发现中发现两处问题——`public_web` 适配器抛 `URIError: URI malformed`（页面含非法百分号序列的 `tel:` 链接，`decodeURIComponent` 未防护，导致整页抽取失败），以及全局异常过滤器对 500 只输出固定诊断、无法区分错误类别。
- 改动：`contact-extractor` 对 `tel:` 的解码加 try/catch（非法序列按原文处理，不再中断整页抽取）；全局异常过滤器在固定诊断上补充**受控的错误类名**（正则白名单，绝不输出 message/stack/凭据）。
- 测试：新增「坏 tel 链接不中断抽取」与过滤器 errorName 断言；相关 35 项与全量单测通过（仅已知负载假红，单跑复核绿）。
- 未做：不改变 500 响应的对外契约（仍是固定文案）；M4 报告的 500 是否同源待下次真实调用用 errorName 核实。

## 2026-11-02 · Add named decision makers to the weekly report CSV (#729)

- 起因：联系人挖掘 M4 的验收要求周报 CSV 含「联系人与状态」；BI-22 周报原先只导出公司级联系路径，从不读取 `canonical_contact`/`contact_point`。
- 改动：
  - `WEEKLY_REPORT_COLUMNS` 在「联系路径」后新增「决策人（联系人 / 联系方式 / 状态）」列；每人输出姓名（职务 · 部门）与邮箱/电话/LinkedIn 的原始验证状态（VALID/RISKY/INVALID/UNVERIFIED），每行最多 5 人、每人 3 个联系方式、整格 2000 字符封顶。
  - 周报读取公司具名决策人（`canonical_contact` + `contact_point`）与联系方式状态；导出前按 workspace 的 email/domain 禁联过滤，且只在 DataRights EXPORT 允许的行上写入。
  - 反馈 CSV 解析按表头取列，新列不影响回传。
- 测试：row spec（单元格格式与状态照实）、service spec（导出决策人、过滤禁联邮箱）；全量零容器单测。
- 未做：不在 CSV 中输出证据 URL/时间或 `allowedActions`；不改周报的 DataRights 规则与 withheld 口径；不读 `field_evidence` 的明文值（只读联系人/联系方式表）。

## 2026-11-02 · Give each understanding retry its own attempt-scoped grant account (#730)

- 起因：live 实测发现同一公司的第二次「理解重试」必失败：工作空间 Grant 消费会把预算账户绑定到首个 authority（`purpose:subject:requestSha`），而重试操作的请求作用域对同一公司是恒定的，于是第二次重试在账户层被判 `EXECUTION_BUDGET_GRANT_REUSED`（`consume_workspace_execution_authority` 正常、随后开账户被拒；`understanding.run` 也不在 `RETRYABLE_WORKSPACE_PURPOSES` 的安全重试账户集合里，且该集合要求旧账户从未真正派发付费调用，不适用于理解重试）。
- 改动：重试操作的作用域加入 `body.attemptId`（客户端每次点击生成的新 UUID）——每次重试获得独立的 requestSha256、独立预算账户与独立 authority；同一 attemptId 的重复提交仍被 Grant 一次性语义挡住（幂等）。quote 端点同步校验 `attemptId`（uuid、exact keys），OpenAPI 请求体 schema 更新。
- 测试：request-scope/quote/envelope/service 规格更新；与 gain-saas 侧（BFF 传 attemptId、前端每次点击生成）配套。
- 未做：不把 `understanding.run` 加进 `RETRYABLE_WORKSPACE_PURPOSES`（那会放宽"旧账户未派发付费调用"的安全前提，与本修复无必要重叠）。

## 2026-11-02 · Return the documented 403 when contact discovery has no lawful basis (#731)

- 起因：M4 UAT 实测 `POST /canonical-companies/:id/discover-contacts` 在缺 body 或 `{}` 时返回 400 `VALIDATION_ERROR`（`lawfulBasis` 必填先触发 DTO 校验），与 OpenAPI/`@ApiExecutionBudgetGrant` 承诺的 403 `CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED` 不一致。
- 改动：`DiscoverContactsDto.lawfulBasis` 改为可选（保留 `LAWFUL_BASIS_KINDS` 枚举校验）；缺失时交给服务层在消耗预算前以 403 拒绝；非法值仍是 400。重导出 OpenAPI 契约（请求体 `required` 去掉该字段）。
- 测试：新增 DTO 校验单测（空 body 通过校验、未知取值仍报错）；既有 service 403 用例继续覆盖拒绝路径。
- 未做：不改服务层 403 的语义与预算消费顺序；不改 `guess-emails`/`verify` 的可选 body 语义。

## 2026-11-02 · Cover every matched company in the contact stage within a $2 budget (#733)

- 起因：D5 原口径「8 家 / $0.50」在真实运行下过紧——实测单家 ≈$0.09（官网 4 页 + 社媒 + 邮箱探测），8 家份额（$0.0625/家）在第一家后就撞 D7 子账户上限（验收 run cf3dba2d 因此 PARTIAL）。产品负责人 2026-11-02 拍板：联系人阶段覆盖**全部** fit=match 公司。
- 改动：联系人活动默认覆盖全部匹配公司（安全上限 25 家），活动内改为**并发 2** 的工位池（串行会越过 30 分钟活动窗口），并加 **18 分钟软时限**——到点只停新公司开工、在飞的两家收尾；另加**准入租约门**（剩余租约放不下一家 10 分钟单位时计 `skippedForLease` 并停手，与其它阶段同口径）；一个工位抛出控制错误或预算截断时另一工位不再认领新公司。D7 子账户口径重校为「每家 20¢、整轮封顶 $2 = min(公司数×20¢, $2)」。
- 窗口/失败语义：30 分钟 startToClose 超时与租约过期都会让预算 attest 失败并被判 control stop、整个 run FAILED（fail-closed），所以宁可提前软时限截断（PARTIAL）：18 分钟 + 在飞两家最坏各 10 分钟 < 30；超过 ~22 家时先撞 $2 上限截断。每次 attempt 仍各有一份 $2 基线（#734 起重试改为重放已结算操作、通常不新增花费），run 账户剩余额仍是硬上界。
- 测试：全量 API 单测通过（2 个已知负载假红文件 `workspace-authority.replay` / `platform-revocation-http.service` 单独复跑全绿）；contacts-stage 13 例覆盖新口径（整轮封顶、差值计量、截断只停新公司、软时限、租约门、run 账户耗尽）；设计稿 D5 已记录重校。
- 部署：无迁移；随下一班车上线后重跑联系人验收。
- 未做：软时限 18 分钟与并发 2 是依据 30 分钟窗口的保守值（留 12 分钟给在飞公司与收尾）；若以后单家耗时变化再评估。

## 2026-11-02 · Survive anti-bot statuses and retry replays in the contact stage (#734)

- 起因：第九班验收 run `4fe3e874` 在联系人阶段 FAILED（stage=contacts, control），第八班上 GainOS run `3649e39a` 同源。两层缺陷叠加：
  - ① `social.fetch` 抓 LinkedIn 时上游返回 **HTTP 999**（本机同 UA 实测稳定复现），而 `social-fetch/v1` 投影契约的 status 上界是 ≤599 → 投影拒绝 → ToolBroker 把已付费操作留在 RESERVED 并抛 `BudgetOperationReplayError(origin='live')` → 被当 control 错误，整条 `discoverRunContacts` 失败，重试后同样再犯。
  - ② 重试 attempt 2 时，#728 的 attempt 隔离键让 model 操作产生新回执（APPLIED），而工具操作按同 key 重放旧回执（REPLAYED），同一公司持久化批次混合 → `DOMAIN_ACK_MIXED_REPLAY_STATE`（control）→ run FAILED。
- 改动：
  - `social-fetch/v1` 的 status 上界放宽到 999（状态码只是事实记录；LinkedIn 999 是已知的非标准反爬码）。
  - ToolBroker 投影拒绝路径改为**按实付结算、无 durable result**，并抛非控制错误 `TOOL_DURABLE_RESULT_PROJECTION_REJECTED`（适配器按源跳过；后续同 key 重放读回已结算的无结果行，按 remnant 吸收）——任何投影契约外的上游行为不再以 fail-closed 形式打死整条活动。
  - 撤销联系人阶段 model 操作的 attempt 隔离键（保留 #728 的 remnant 吸收）：重试一律**重放**已结算操作，不重跑、不重复计费。
  - 联系人持久化改为**按适配器分批确认回执**（对齐 signals 阶段的 ack-split 先例）：部分重试时「已确认的适配器（REPLAYED）」与「首次成功的适配器（APPLIED）」不再进同一批次，`DOMAIN_ACK_MIXED_REPLAY_STATE` 不再由跨适配器混合触发。同一适配器在一次重试里多出全新回执的极端混合仍按失败关闭处理（与 signals 阶段现状一致，记为后续）。
  - 查询阶段把 `TOOL_DURABLE_RESULT_PROJECTION_REJECTED` 与「不可重放操作」同等吸收：该 provider 以零回执收口（governed/legacy 两种模式都计入），不再以 lineage 回执不匹配的 control 错误打死整条 run。
  - 防同类再犯：`social.fetch` 的页面文本按 durable 契约整形（去 NUL、孤立代理项→U+FFFD、NFC、按码点边界截断）——原始 HTML 的 NUL/NFD/代理对切口此前同样会让投影拒绝；ToolBroker 在任何出网与预留之前拒绝**未注册的 typed projection schema**（部署缺陷 fail-closed，不再「付了钱但结果永远投影不了」）。
- 测试：`social.fetch` 999 投影、ToolBroker 结算+拒绝路径、旧「no-second-wire」用例改为新契约；联系人 stage、回执消费者与工具全组单测见 PR。
- 部署：无迁移；随下一班车上线后重跑联系人验收。
- 说明：撤销 attempt 隔离键后，重试改为重放已结算操作、通常不再新增花费；每次 attempt 仍各有一份基线，run 账户剩余额与两次基线的和仍构成绝对上界（#733 片段已同步更正）。工具侧投影契约外的上游结果在联系人、查询与富集阶段都以「按源跳过/零回执」收口；**model 侧**投影拒绝（router-model-gateway 的 projection catch）仍是 fail-closed，未在本次范围内（记为后续）。代价是重试可能吸收残留而少跑某个适配器的结果（best-effort，与 #728 的吸收纪律一致）。
- 未做：没有回填第八班 GainOS run `3649e39a` 的失败统计（其 stats.failure 已由 Docker 会话取证）；撤销 attempt 隔离键后重试可能吸收残留而少跑某个适配器的结果，属已知取舍；model 侧投影拒绝（router-model-gateway）的同类 fail-closed 路径未改——且撤销 attempt 键后，重试会把该次 model 调用按 remnant 永久跳过。

## 2026-11-02 · Keep model refusals in qualify-fit out of the rejected queue (#736)

- 起因：run `3212f6f3`（生命科学域 ICP）的 4 次 `discovery.qualify_fit` 调用中 3 次被上游模型拒答——HTTP 200、各门填「本服务不支持……生命科学研究……」「不支持以中文提出的请求」等拒绝文案，`verdict` 却填成合法枚举 `mismatch`，schema 校验看不出问题；fit-judge 只校验枚举，3 家候选因此被自动进 `rejected`。同 ICP 上午在 `gemini-4-argon-high` 下判定正常（4 match / 10 weak / 7 mismatch）。
- 改动：`judgeFitCompany` 增加拒答签名检测（`looksLikeModelRefusal`）。命中时按 fail-safe 归一为 `weak` 并写合成的四门说明与原文摘录（「疑似上游内容策略拒答，转人工复核，不自动拒绝」），绝不 `mismatch`；durable receipt 照常透传。不在函数内自动重试：同一请求材料的 durable 预算操作键相同，重放只会拿回同一份拒答或撞 `BudgetOperationReplayError`，真正解法是换不拒答的模型路由。
- 测试：`fit-judge.spec.ts` 新增 3 例——事故原文（拒答）降级为 weak 且保留 receipt/摘录、真实证据型 mismatch 不受影响、合法的 unclear 门不被误判为拒答；原 15 例照旧通过。
- 未做：不改 `discovery.qualify_fit` 的模型路由（共享 runtime，由产品负责人决定）；不改 durable 结果投影（receipt 保留原始拒答，人工可按摘录溯源）；不改 backlog 路径的判定语义（复用同一函数，行为自动一致）。

## 2026-11-02 · Stop the planner from writing trade_fair queries no registered fair can serve (#739)

- 起因：`trade_fair` provider 只能跑注册表（`TRADE_FAIRS`）里已登记的展会——目前只有 EuroBLECH 2026（钣金/金属加工），`selectFairs()` 用 ICP 行业词/关键词匹配模板 topics，无命中就静默返回零记录。生命科学类 ICP 的 trade_fair 查询因此必然空跑：run `3212f6f3` 的 8 条此类查询全部零结果、无报错、无成本（`3ad22469` 的方案里也有 3 条）。
- 改动：`plan-query-sources.ts` 新增 `icpMatchesRegisteredFairs()`（与 provider 同一 `selectFairs()` 判定）与 `plannerVisibleSources()`；`generateQueryPlan` 用它们从「可用数据源」提示词中剔除无展会可跑的 trade_fair（`hasPlannableSource` 与 `plannerSourcePrompt` 改用 planner 可见列表）。路由校验仍用完整 `enabledSources`：模型若仍写 trade_fair 查询，不会按 SOURCE_DISABLED 移出（它会照常执行、只是空跑），也不改变已有计划的语义。
- 测试：`plan-query-sources.spec.ts` 新增 4 例（命中/不命中/可见性过滤/单独 trade_fair 不可规划）；`icp.service.spec.ts` 新增 3 例（金属 ICP 提示词含 trade_fair、生命科学 ICP 不含、trade_fair 为唯一启用源且无展会时 409 不花钱）。两文件 120 例全绿。
- 未做：不扩展会注册表（内容+ToS 工作量另议）；不改 provider 的空结果口径；不改 backlog/评分路径。

## 2026-11-02 · Close the two recorded fail-closed residuals of the contact projection fix (#740)

- 起因：#734 修复工具侧投影拒绝后，审查记录的两个 fail-closed 残留：①model 侧投影拒绝仍留 RESERVED + control 错误（重试后该次调用按 remnant 永久跳过）；②联系人同一适配器在同次重试里新增回执（如进程级熔断在两次 attempt 间清零后补抓）仍抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`。
- 改动：
  - **model 侧**（`router-model-gateway`，受保护文件已重钉 sha256）：与工具侧同款——有效 provider 输出但无法表示进 durable 契约时，按 provider 上报成本结算（无 durable result），并抛类型化非控制错误 `MODEL_DURABLE_RESULT_PROJECTION_REJECTED`（自身字段只含 code/name/message，分类器可机器判定为非 control）；调用方按普通失败处理（fit 计 unjudged、抽取跳源），同 key 重放读回已结算无结果行并按 remnant 吸收。
  - **联系人回执**：批量确认助手新增可选参数 `onMixed: 'reject' | 'apply'`（默认仍 reject，signals 等调用方行为不变）；联系人持久化传入 `'apply'`——persist 按身份 upsert/合并、可安全重放，混合态按 APPLIED 执行一次，不再把整条 run 打成失败。
  - 审查补强：`settledModelFailureReason` / `settledModelUpstreamFailureReason` 识别该错误——发现侧 provider 以零回执跳过该域（不再以 lineage 回执不匹配的 control 错误打死查询），ICP/query-plan/draft 的 HTTP 面给出 502 `MODEL_UPSTREAM_UNUSABLE` 合约；taxonomy 归一失败仍计入 `taxonomyFallback` 统计；修正 `@Injectable()` 误挂到错误类上的修饰器位置。
- 测试：model 网关投影拒绝的结算与非控制分类断言、两个失败分类器的新用例、domain-ack 混合 apply 用例、联系人 stage 与回执消费者全组；全量单测见 PR。
- 部署：无迁移；随下一班车上线。
- 未做：混合 apply 会为已持久化的联系人重复写 `field_evidence`（罕见路径，后续可加去重）；domain-ack 的分区变体未加 `onMixed`（当前无调用方需要）。

## 2026-11-02 · Refresh current status to the 2026-11-02 baseline and move the release plan to docs/status (#741)

- 起因：`docs/status/current.md` 停在 2026-10-30，与 10-31 之后的 R4 权威迁移、GrowthOS 退役、十班车、联系人线 M1–M4、Phase 1a 安全热修不符（run/lead/个人数据表计数、身份分工、模型路由均是旧值）；ADR registry 与冲突登记多处仍写「R4 撤销链未打通」「Grant 由 GrowthOS 签发」「L4-G23 未做」；文档规则要求的 `docs/status/release-plan.md` 承接一直没有执行。
- 改动：
  - `docs/status/current.md` 刷新到 2026-11-02 基线（35 次 run：13 PARTIAL/22 FAILED/0 COMPLETED；lead 5 221；个人数据三表 80/61/268；outbox 468 全 ACKED；运行镜像 `a428afab`（build `2fa46564`）；身份与 R4 权威在 gain-saas；模型路由 `qualify_fit→gemini-3.8-flash`）。
  - `docs/roadmap/release-plan.md` 迁到 `docs/status/release-plan.md`，全部现行引用与机器规则（`docs-verification-policy.json`、三个治理脚本）同步；`docs/archive/` 历史文档不改。
  - ADR registry `PRD4-D2` 行、冲突登记 `PRD4-D2/D6/D9/D13/D16/D18`、§1.1 核验基线、capability-register 基线：按 2026-11-01/11-02 的 live 事实与拍板结果刷新或标注历史。
  - `docs/README.md` 增加「历史与冻结文档的定位」：research/platform-top-level-design-v1 为 SUPERSEDED、frontend/ 为目标规范非 as-built、site-builder 为冻结线。
- 测试：`node scripts/verify-docs.mjs` PASS（0 errors / 1 既有历史告警）；`node --test scripts/model-candidate-baseline.spec.mjs` 7/7。
- 未做：不改 `docs/archive/` 与历史研究正文；gain-saas 仓的 PRD 提评审在 gain-saas 另开 PR；文档正文不写入任何未核验的运行断言。

## 2026-11-02 · Trigger company understanding from intake with an execution grant, and bound JWKS fetches

- 起因：intake 创建 CompanyProfile 后从不发 `CompanyProfileCreated`，事件也不带 workspace 执行授权，经注册引导入驻的公司永远没有理解与 Claim/Offering；JWKS 验签的远端拉取无超时与大小上限。
- 改动：intake 接受可选 `X-Execution-Budget-Grant`（新增请求作用域 `POST /site-builder/intake`）；同事务消费并写 `CompanyProfileCreated` v2；缺授权时返回 `understanding=not_started`；新增报价 envelope 与 OpenAPI；JWKS 拉取加 2 秒超时与 64 KiB 上限。
- 测试：intake service/controller、JWKS bounded fetch、预算 envelope 共 49 个用例通过；OpenAPI 已重导出。
- 未做：不改理解工作流主体与预算语义；不在引擎内重试模型拒答（另见 fit-refusal-guard PR #736）；onboarding 的 grant 签发在前端 Phase 1 接入。

## 2026-11-01 · Enrich social profiles from Wayback archives and live public pages (#709)

- 起因：M2a 的 social_presence 只读搜索索引标题；产品负责人 2026-10-31 拍板允许直爬无需登录的公开个人页（D1），并要求优先取档案副本，降低对目标站的依赖与共享出口 IP 的风险。另查明 M2a 在现网从未产出：`searxng.search` 按 personalData:false 把个人主页 URL 全部过滤，适配器拿不到任何候选。
- 改动：
  - 新工具 `social.search`（personalData:true、独立 `social-search/v1` typed projection、PERSONAL_DATA）：只返回公开个人主页（LinkedIn `/in|/pub`、Xing `/profile`）的 URL+标题，供联系人发现使用；`searxng.search` 的隐私契约保持不变。治理清单 18→19 个工具。
  - social_presence 适配器增加 L1 档案副本层（Wayback availability → http.get 读 web.archive.org 快照；只认 3 年内、200 快照，http 归一 https）与 L2 公开页直抓层（http.get 读 LinkedIn 公开页，HTML 清洗后经 contact.find_decision_makers 抽取职务/部门/邮箱），抽到的人必须同时命中候选姓名与公司名；Xing 访客页是 SPA 壳，只走档案层。
  - 每注册域 ≤1 req/3s 节拍器 + 连续 3 次目标站拒绝（403/429/999/登录墙）熔断 30 分钟；本地闸门/超时/网络错误不计熔断；熔断只门控直抓层，档案层不受影响。登录墙识别只收墙页独有短语（未登录页面的 "Join now"/"Anmelden" 导航不再误判）。计数经 stats.contacts.diagnostics 进 run 统计。
  - 修复联系人发现的两个静默空结果缺陷：core 未传 artifactSubject，crawl4ai.fetch/http.get（subject-bound）会被 Broker 持有；回执生产者名单缺 social.search/http.get，adapter 的 onDurableReceipt 会抛 DOMAIN_ACK_CONSUMER_BINDING_MISSING 并被吞。
  - 抽取管线（contact.find_decision_makers 的 prompt/durable schema）抽成 contact-extraction.ts，decision_maker 与 social_presence 共用；姓名/邮箱/电话在适配器内先本地校验（乱码邮箱只丢邮箱、不丢整条联系人）。
  - source_policy 种子新增 linkedin.com / de.linkedin.com / xing.com（REVIEWED_RESTRICTED，负责人接受的 robots 例外域）与 archive.org / web.archive.org；`decision-maker-multi-source-spec.md` 合规红线按 D1 改写；设计稿 D1–D8 全部拍板并入库 `docs/superpowers/plans/2026-10-31-contact-discovery.md`（APPROVED）。
- 测试：social-presence 18 用例（快照新鲜度/登录墙误报/HTML 实体/同名跨转写/档案与直抓流程/熔断归因/节拍/无抽取器跳过）+ 新工具 social.search 3 用例；全量 API 单测通过（1 个 revocation 时间边界用例首跑负载假红，单跑通过）；execution-authority-policy 19 工具/41 callsites PASS。
- 部署：无迁移。上线后 worker 启动 seed 会把 social_presence 置 ENABLED（现网尚无该行）；联系人阶段需要 `decision_maker` provider config 的 lawful basis（2026-11-01 已按全局 interim 写入）。**上线前实证**：验证 run 7b887405（现网镜像，仅含 M1）联系人阶段 8/8 公司失败，worker 日志全部为 `tool crawl4ai.fetch denied: GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD`——本 PR 的 artifactSubject 修复正是为此；部署后须重跑验收。
- 未做：L1 的 Common Crawl 索引来源；跨进程（API+worker）共享的 Redis 节流/熔断（当前为进程级，最坏 2×3s 节拍）；D5「每家 ≤6 页」的跨适配器强制（decision_maker 4+首页、社媒 4，最坏 9）；D2 的 trade_fair 开关翻转（数据库 ops，另行执行）；google_patents 启用（等 patent cache 验证与刷新计划恢复）；D7 联系人独立预算账户；D8 OSS sidecar（theHarvester/social-analyzer）。

## 2026-11-01 · Add an audited, receipt-paired reopen path for the platform egress fence (#711)

- 起因：签名撤销会把平台 schedule 的出网围栏置为 `DISABLED`，但产品没有设计好的重开路径——`install_platform_egress_policy_v2` 与两个发送阶段都要求 `ACTIVE`。2026-10-31 撤销 fence 实测后只能由库属主手工 `UPDATE` 恢复 dev（见 `docs/evidence/2026-11-01-platform-admission-v2-and-revocation-fence.md`）。
- 改动：
  - 新增迁移 `20261101010000_platform_egress_fence_reopen`：`reopen_platform_egress_fence_v1`（SECURITY DEFINER、owner-only、generation CAS、与 `platform_revocation_receipt` 的 `(schedule_id, fence_sequence, generation)` 精确配对、advisory lock + fence 行锁）与不可变审计表 `platform_egress_fence_reopen_receipt`（FORCE RLS、无任何运行角色表权限、UPDATE/DELETE/TRUNCATE 触发器拒绝）。
  - 重开只把围栏改回 `ACTIVE` 并推进 generation，`fence_sequence` 不变；不安装策略、不撤回已 `SENDING` 的物理调用、不改变撤销/ACK 语义，也不 unpause 任何 schedule。
  - 迁移内 DO 自检（函数 ACL/`search_path`/属主 RLS 能力、审计表 RLS 与触发器、四行围栏）与 `docs/governance/app-user-table-privileges.json` 同步。
  - 设计 `docs/superpowers/plans/2026-11-01-egress-fence-reopen.md`，运维说明 `docs/backend/platform-egress-fence-reopen.md`。
- 测试：`node --test scripts/platform-egress-fence-migration.spec.mjs`（9 项迁移契约）；`PLATFORM_EGRESS_FENCE_REOPEN_DISPOSABLE_TEST=1 node --test packages/db/test/platform-egress-fence-reopen.disposable.spec.mjs`（8 项，一次性 pgvector:pg16，无网络）覆盖成功重开、重放/篡改、无回执与二次关闭、策略缺失、并发、回滚、owner-only 与不可变审计。
- 未做：四个平台 schedule 仍 paused；运行镜像的发布与切换、在 dev managed runtime 上演示 `/health/ready` 恢复需要单独部署授权。gain-saas 运营台/CLI 的调用接线未做。

## 2026-11-01 · Renew the production dependency audit baseline before it expires on 2026-11-10 (#713)

- 起因：生产依赖漏洞基线 2026-11-10T05:13:39Z 到期。到期后改了依赖输入的 PR 的 `production dependency delta · canary` 和 main 的 freshness canary 都会失败（依赖输入未变的 PR 不读基线，照常通过），所以要在到期前续期。
- 改动：
  - 锁文件自 10-28 qs 重绑（#693）以来没有变动，按 [依赖刷新 runbook](../backend/dependency-refresh.md) §4「到期续期」只换绑定、延有效期：基线改绑到当时的 main 提交 `9fa20859`，`valid_until` 由 2026-11-10T05:13:39Z 延至 2026-11-14T18:27:04Z，不升级任何依赖。
  - `scripts/supply-chain-gates.spec.mjs` 同步钉住的基线提交与 `REPOSITORY_BASELINE_NOW`。
  - 新增[冻结证据](../evidence/security/20261101-baseline-renewal.json)，[安全门](../security/README.md) 与证据索引各加一条记录。
- 测试：官方 registry 生产审计零 advisory（830 个依赖），`supply-chain-audit.mjs verify` 为 `PASS_CLEAR`，新旧绑定下的 `baseline-freshness` 都是 `FRESH`；直接调用 `evaluateProductionAuditBaselineFreshness` 投影：旧基线在 2026-11-10T05:13:38.999Z 还是 `FRESH`、05:13:39.000Z 起 `BASELINE_EXPIRED`，新基线到 2026-11-14T18:27:04Z 前保持 `FRESH`。含开发依赖的全量审计有 6 条 advisory（`@vitest/mocker` 两条、`glob`、`minimatch`、`deepmerge`、faker 5.5.3），全部在生产依赖图之外，没有生产侧新增；`supply-chain-gates.spec.mjs` 28/28 通过；`gctl check`（docs · governance、prisma generate、contracts build、lint、build · typecheck、零容器单测）通过，其中全量单测首轮唯一失败为已登记的 `git-reviewed-evidence-acceptance` 负载假红，单跑 19/19 通过后全量复跑通过。
- 未做：不升级任何依赖；含开发依赖的全量审计的 6 条 advisory 均在生产依赖图之外，留待单独的开发依赖 PR；11 月月度批量刷新另行立项，须在 2026-11-14 前合入或再续期一次。

## 2026-11-01 · Give contact discovery its own budget account and enable run-time email completion (M3) (#714)

- 起因：产品负责人 2026-10-31 / 2026-11-01 拍板 D7 与 D3/D5——联系人是高成本步骤，必须有自己的额度、撞顶即停，不挤占 run 的查询/画像/评分预算；`email_guess`（SMTP 只握手、绝不投递）在 M3 启用，自动路径沿用全局 interim 合法性基础。
- 改动：
  - 新增 `execution-budget/contact-discovery-budget.ts`：按 run 派生 `contact.discovery:<runId>` 子账户；上限 = 每家公司 $0.0625（D5：≤6 页 × $0.01/页）× 本轮目标公司数（默认 8 家 ⇒ $0.50/run），用 run 账本剩余额的**单调高水位**差值计量（阶段开始前持有、阶段中才释放的预留不会把已观察到的花费抹掉），撞顶后不再启动任何 adapter 或下一家公司。
  - `discoverContactsCore` 接受可选子预算守卫：adapter 循环在子账户耗尽时停止并回报 `budgetTruncated`；HTTP `discover-contacts` 路径不传守卫，响应形状不变。控制错误（`ExecutionControlError`）在活动里按本仓惯例重新抛出，不再吞成 `failed` 计数。
  - `discoverRunContacts` 派生子账户并每家公司观察账本剩余额；`contacts.budgetTruncated`（沿用原口径，run 状态照旧降为 PARTIAL）之外新增 `contacts.contactBudget{accountKey,capMicrousd,spentMicrousd,exhausted}` 写入 run stats。
  - 新增 `discovery/contact-stage-email-guess.ts`：run 联系人阶段对缺邮箱的具名联系人做 SMTP 补全。双闸 = `data_provider.email_guess` ENABLED + `decision_maker` config 的部署级 lawful basis（全局 interim）；验证器**只认** `smtp_self`（`public_web` 只剩 MX，不能服务自动路径）；自动路径绝不传 `allowPersonalWithoutBasis`；每公司 ≤6 次探测（跨该公司全部联系人共享，`MAX_RUN_EMAIL_PROBES_PER_COMPANY`；单次调用仍受既有 `MAX_EMAIL_PROBE_CANDIDATES`=8 约束）；company/contact/email 三层禁联在每次探测前复核；结果只落 RISKY 或（SMTP RCPT 接受且 catch-all 已证伪时）VALID，未证实绝不升 VALID；SMTP 回执按既有 domain-ack 纪律入账（原始键名避开 PII 提示词，否则 `validateDomainAckRawIdentity` 直接拒绝）；单个联系人失败只计数并继续，已完成的猜测与其回执照常落库。
  - 探测是零账本成本的（`smtp.rcpt_probe` 计价 0），因此美元子预算耗尽不阻断邮箱补全；只在 run 账户本身耗尽后停止。
  - run stats 新增 `contacts.emailGuess{emaillessContacts,attempted,probes,persisted,verified,risky,blocked,failed}`，落库的猜测邮箱计入 `contacts.emails`。
- 测试：新增 3 个 spec 共 29 个用例（预算纯件 8、邮箱补全 10、run 联系人阶段 11），覆盖动态上限、单调高水位、撞顶即停、run 账户耗尽沿用口径、双闸与验证器白名单、每公司 6 次探测、RISKY 不升 VALID、单联系人失败隔离、禁联与回执生产者/键名校验纪律；每条修复都用反向变异（还原成旧行为）验证过会红。`gctl check` 全绿（docs·governance、prisma generate、contracts build、lint、build·typecheck、全量零容器单测）。
- 未做：真正的第二本账——workspace grant 的 authority 只允许开一本 `tool_budget_account`，且 `execution_budget_*` 是平台表；D7 目前是同一 run 账本内的派生记账键 + 硬性窗口计量，要账本级隔离需 gain-saas 以新 purpose（contact.discovery）签发 Grant，仓外另行推进。Temporal 重试会重新取子账户基线（每 attempt 一份上限；已结算操作经账本幂等重放不重复计费）。run 路径的补全编排与手动 `guess-emails` 路径仍有两份实现，宜抽共享例程。D5「每家 ≤6 页抓取」的跨适配器强制仍是 M2b 遗留。`email_guess` 的 `data_provider` 开关翻转、真实 SMTP 探测验证与部署不在本 PR。`contact_point` 没有 PROBABLE 状态，未证实猜测一律 RISKY。

## 2026-11-01 · Fetch social-layer pages through a dedicated typed-projection tool (#717)

- 起因：第六班验收 run `1c233bb6` 在联系人阶段以 `GENERIC_OPERATION_ARTIFACT_INVALID` → `BudgetOperationReplayError` 失败——社媒适配器用 `http.get` 抓 Wayback availability（带 `?url=` 查询串）与快照页（14 位时间戳、大小写混合路径），而这两类工具是 subject-bound artifact，其持久化 URL 契约（无 query、纯小写、数字 <9 位）由 `artifact-expected-facts.ts` 强制，社媒目标 URL 天生违反。单测 mock 了 broker，无法暴露。
- 改动：
  - 新工具 `social.fetch`（typed projection `social-fetch/v1`，PERSONAL_DATA，`{url,status,text≤36k 字符}`，目标主机白名单 = Wayback + LinkedIn/Xing 个人页）：社媒层三条抓取（availability JSON、档案快照、直抓）改走它，不经工件层；`perDomainCrawlDelayMs=3000` 由 broker 的 Redis limiter 执行，因此移除适配器内的进程级节拍器（熔断保留，仍为进程级）。
  - 治理同步：工具清单 19→20、callsite 清单 social-presence 的 3 条 `http.get` 改为 `social.fetch`（总数 41 不变）；`contact.find_decision_makers` 的 allowedTools 以 `social.fetch` 替换 `http.get`；回执生产者、domain-ack 绑定、durable-result-strategies、catalog projection（含边界夹具与顺序锁定）、policy 常量与 spec 全部更新。
- 测试：新工具 4 用例（主机白名单/文本界限/egress 拦截/投影往返）；social-presence 用例改 mock 为 `social.fetch`；全量 API 单测通过；execution-authority-policy 20 工具/41 callsites PASS。
- 部署：无迁移。上线后需重跑联系人验收（上一轮 5 名具名联系人已落库——2 家公司 Geschäftsführer/技术销售带邮箱+电话——失败只发生在有社媒候选的公司）。
- 未做：旧验收 run 中已产生的 `BudgetOperationReplayError` remnant 会按 #684 的残留吸收逻辑在后续请求中自然消化；跨进程熔断仍为进程级（记录在案）。

## 2026-11-01 · Add a narrow contact-discovery read scope for named-contact surfaces (#718)

- 起因：联系人挖掘 M4 需要 SaaS 工作空间管理员读取并操作具名联系人（canonical 公司详情、发现、猜测、验证）。这些端点原先要求 `personal-data:read`，而该 scope 只授予事件消费机器身份；若为了 M4 把它整体授给用户角色，会同时打开事件流、线索详情与建站档案等其它个人数据面，超出本功能所需。
- 改动：
  - 新增闭合 scope `contact-discovery:read`，只覆盖具名联系人数据面。
  - `GET /api/v1/canonical-companies/{id}`、`POST /api/v1/canonical-companies/{id}/discover-contacts`、`POST /api/v1/canonical-companies/{id}/guess-emails`、`POST /api/v1/contact-points/{pointId}/verify` 从 `personal-data:read` 切换为 `contact-discovery:read`；三个写端点仍同时要求 `acquisition:write` 与 `compliance:manage`。
  - 同步操作描述、authz OpenAPI 断言与 scope 词表测试；OpenAPI 契约按装饰器重导出。
- 测试：`pnpm --filter @global/api test`（scopes 词表、OpenAPI `x-required-scopes` 断言）；contracts 重导出后 drift 检查。
- 未做：不改变 `personal-data:read` 的既有语义与授予对象；不在本 PR 修改 SaaS 角色映射或部署配置（`contact-discovery:read` 需由 gain-saas 仅授予 `saas-admin`，并在引擎发布该 scope 后一起上线）；`discover-contacts` 的 workspace 报价仍 fail-closed（联系人阶段预算账户/报价是另一个缺口）。

## 2026-11-01 · Make the runtime image publication checks independent of the Docker storage driver (#719)

- 起因：第七班发布 run 41311045932 两次在同一步失败——镜像构建成功，但推送前本地校验静默退出 1。根因：GitHub runner 切换到了 containerd 镜像存储，`docker image inspect .Id` 从 config 摘要变为 manifest 摘要，而 workflow 的断言假设二者相等（6 小时前同流程在 classic 存储上成功）。
- 改动：发布 workflow 改为存储驱动无关的身份校验——构建步骤额外产出 config 摘要并在 `.Id` 与 config 摘要不等时用 `docker save` 归档内 `manifest.json` 的 Config 条目自校验；发布步骤把「拉回镜像 `.Id` 等于本地 Id」替换为「拉回镜像存档的 config 字节哈希等于构建时被 attest 的 config 摘要」，其余标签/用户/entrypoint/verifier 校验不变。
- 测试：workflow 由下一次真实发布 run 验证（本 PR 的 CI 走治理与构建门）。
- 未做：不改变镜像内容、attestation 语义与发布产物；classic 存储路径保持向后兼容（分支式断言）。

## 2026-11-01 · Quote on-demand contact discovery from per-company adapter ceilings (#720)

- 起因：M4（gain-saas 决策人卡片）需要工作空间管理员按需对单家公司触发联系人发现；G2（#570）起 workspace 技术报价对该操作 fail-closed（`EXECUTION_BUDGET_QUOTE_UNAVAILABLE`），SaaS 无法铸造一次性 Grant，发现入口不可用。产品负责人 2026-11-01 决定补 workspace 报价。
- 改动：
  - 为 `POST /api/v1/canonical-companies/{id}/discover-contacts` 新增 per-company 报价包络：按 6 个联系人适配器（decision_maker / public_web / companies_house / inpi_rne / social_presence / bigquery_patents）各自的物理上界枚举模型与工具配额；reservation cap = 260 cents（8 次抽人模型 × 2 wire × 15 cents + 8 页 `crawl4ai.fetch` + 12 次 `social.fetch`）。
  - 抽出共享上界常量（public_web 链接页 2、社媒 dork 4、每个候选社媒页抓取 3、Companies House 2 次调用），适配器与包络共用；非法边界仍 fail-closed。
  - 更新包络与报价 controller 的断言；重导出 OpenAPI 契约（无 drift）。
- 测试：包络 spec（精确模型/工具配额与 cap）、报价 controller spec（subject=company、purpose=discovery.run、cap `2600000`）；全量零容器单测。
- 未做：不改变 D5 的实际花费口径与 run 内 `contact.discovery` 子账户；不新增账本行/迁移；联系人仍不进公司级 reachability；discover 的 lawfulBasis、禁联与预算 Grant 一次性消费等既有 Gate 不变。

## 2026-11-01 · Fix the publication recovery path for the containerd image store (#721)

- 起因：第七班重发 run 41315984975 构建成功、推送成功，但 GHCR 标签可见性延迟超过 30 秒等待窗，resolve 返回 NOT_FOUND；同时发现「已发布镜像的恢复路径」里还有一处与 #719 同源的 `.Id == config 摘要` 断言，在 containerd 存储下同样会失败（恢复模式一旦触发即挂）。
- 改动：恢复路径改用与构建步骤相同的存储无关自校验（`.Id` 与 config 摘要不等时用 `docker save` 归档内 `manifest.json` 的 Config 条目比对）；发布步骤的 resolve 等待窗 30s→120s 以吸收 GHCR 标签可见性延迟。
- 测试：发布契约测试 `runtime-deployment-contract.spec.mjs` 全绿；下一次真实发布/恢复 run 验证。
- 未做：不改镜像内容、attestation 语义与发布产物；已推送的 ea9bbbbe…d1969948 标签保持原样，恢复模式会复用并补齐 attestation。

## 2026-11-01 · Surface failed website understanding and let it be retried (#722)

- 起因：2026-11-01 一个真实租户的官网理解因模型网关 429 突发失败后，档案停在 `DRAFT`，接口与 GainOS 界面都无法区分「排队中」和「已失败」，也没有重试入口；原创建工作流的 3 次快速重试在约 3 秒内耗尽。
- 改动：
  - `GET /companies`（列表/详情）返回 `understandingFailedAt` / `understandingLastError`，失败可见；
  - 新增 `POST /companies/:companyId/understanding/retry`：只允许对「最近一次理解失败、仍为 DRAFT」的档案重试，必须带**新的** workspace Execution Budget Grant（quote operation `POST /companies/:companyId/understanding/retry`，purpose `understanding.run`、subject 为 company），成功后重新入队 `understandingWorkflow`；
  - understanding 工作流的模型活动重试改为 5 次、5s 起指数退避（最长 60s），对 429 突发提供约 75 秒覆盖。
- 测试：company 服务重试守卫与事件载荷单测；quote/scope/envelope 三处契约用例补 retry operation；`gctl check` 全绿。
- 未做：跨模型/渠道 fallback（仍需单独立项）；GainOS 侧重试入口在 gain-saas 仓单独 PR。

## 2026-11-01 · Retry the GHCR digest read-back within its bounded wait (#723)

- 起因：第七班 run 41317912037 构建与推送都成功，但 `ghcr-runtime-publication.mjs resolve` 的 `--wait-ms` 有 60 秒硬上限，工作流把等待窗调到 120 秒后直接被判 `GHCR_INPUT_INVALID`；而 GHCR 标签可见性延迟实测超过 30 秒。
- 改动：改用「脚本内 60s 等待 + 工作流层有限重试」——最多 4 轮 resolve（每轮 60s 等待 + 15s 间隔），全失败才让步骤失败；不修改脚本本身的输入契约。
- 测试：发布契约测试 18/18 绿；下一次真实发布 run 验证。
- 未做：不改镜像内容、attestation 语义与发布产物。

## 2026-11-01 · Retry the GHCR digest read-back by status, not by exit code (#724)

- 起因：`ghcr-runtime-publication.mjs resolve` 对 FOUND/NOT_FOUND 都返回退出码 0（NOT_FOUND 只打印 `{"status":"NOT_FOUND"}` 并写 `exists=false`），上一版的 `if resolve; then` 重试因此只跑一轮就放行，随后空的 `image_reference` 让断言失败。GHCR 标签可见性延迟实测可超过 60 秒。
- 改动：重试循环改为解析 resolve 的 stdout 状态字段——最多 4 轮（每轮 60s 等待 + 15s 间隔），看到 `"status":"FOUND"` 才放行。
- 测试：发布契约测试 18/18 绿；下一次真实发布 run 验证。
- 未做：不改 resolve 脚本的输入/退出契约，不改镜像内容与 attestation 语义。

## 2026-10-31 · Update the API portal intro to the gain-saas identity source (#702)

- 起因：接口门户的接入说明写的是 GrowthOS 签发 JWT、token 声明名为 `workspace_id`，与 2026-10-29 起的 gain-saas 身份源（`https://127.0.0.1:18446`，claim 为 `workspace`）不符；配套的 `api-token` 工具仍走已退役的 GrowthOS 登录页，对接方拿不到可用于调试的 token。
- 改动：
  - `apps/api/src/docs/portal-intro.ts`：认证说明改为 gain-saas 签发、claim 名 `workspace`；机器通道（ExecutionBudget / PlatformAuthority）改称 gain-saas；地址表补充门户自身地址 `http://100.68.31.20:3000/api/portal`。
  - `packages/contracts/INTEGRATION.md`：新增「模块与接口覆盖」一节（模块→分域→接口；无独立接口的模块说明数据从哪来；对接三个常见坑）。
  - 工作区工具 `/global/local-config/bin/api-token` 改为经 gain-saas `EngineTokenSigner` 现铸 300 秒 token（不入本仓）。
- 测试：用新 token 实测 `GET /api/v1/leads` 200；`nest build` 通过（CI `contracts · drift · lint · breaking`）。
- 未做：门户文本随镜像构建生效，需下一次后端发版才会出现在运行中的门户。

## 2026-10-31 · Discover named contacts inside a discovery run (#703)

- 起因：获客主链能判站、画像、评分，但发现 run 的五个阶段从不调用联系人发现——`canonical_contact` 与 `contact_point` 一直是 0 行，客户只能看到公司级询盘表单，拿不到具体的人和联系方式（2026-10-31 设计稿 §一）。
- 改动：
  - `discovery.service.ts` 把「加载公司 → 多适配器 fan-out → 落库与证据」抽成共享核心 `discovery/contact-discovery-core.ts`；HTTP 端点（消费 Grant + 调用方 lawful basis）与新的 run 活动复用同一核心，落库语义与去重（`resolvePersonIdentity`）完全一致。
  - 新活动 `discoverRunContacts`：信号阶段之后，对本 run `fit=match` 的公司按分数取 Top 8（上限 25），依次跑已启用的联系人适配器（官网 `decision_maker`、Companies House、INPI RNE 等）；**无部署级 lawful basis 时 fail-closed 返回 skipped**（读 `decision_maker` provider 的 `config.lawfulBasis`，沿用既有 interim 口径）；单家失败不阻断其余，预算耗尽即停。
  - `discovery.workflow.ts` 新 patch `discovery-run-contacts-v1` 守卫该阶段（旧历史重放走原命令序列）；stats 新增 `contacts:{companies,people,emails,phones,skipped,reason?,failed?,budgetTruncated}`，预算截断计入 `budgetTruncated` → run 至少 PARTIAL。
- 测试：`discovery.activities.spec.ts` 新增无 lawful basis 时 fail-closed；`workspace-authority.workflow.spec.ts` 新增「信号后调用并记录 stats」「无 patch 的旧历史不调用且不写 stats」「预算耗尽 → PARTIAL」三例；相关三套 387+ 例全绿。
- 未做：前端入口（gain-saas 的发现/验证按钮）、社媒适配器（设计稿 M2）、邮箱猜测开关（M3，默认仍 DISABLED）；`decision_maker` 的 lawful basis 需在部署配置里写入后才生效。

## 2026-10-31 · Open the workspace-scoped suppression list to tenant admins (#705)

- 起因：G5（gain-saas 验收 2026-10-30 交回 backend）发现租户 admin 能 `POST /suppressions`（只要求 `compliance:manage`）却列不出名单（`GET` 额外要求 `personal-data:read`），形成「能写不能读」的盲写黑洞：加错删不掉、也看不到自己加了什么。禁联记录本身是 workspace 隔离的租户合规登记（数据主体反对/退订/投诉），不是引擎采集的招揽联系人。产品负责人 2026-10-31 拍板 D2-B，见 [G5 决策方案](../superpowers/plans/2026-10-31-g5-tenant-detail-contract.md)。
- 改动：`GET /api/v1/suppressions` 的 scope 从 `compliance:manage` + `personal-data:read` 放宽为仅 `compliance:manage`；`personal-data:read` 仍不授予任何 SaaS 用户角色，联系人/事件流等个人数据面不受影响。同步更新操作描述、authz OpenAPI 断言与契约导出。
- 测试：`authz-openapi.spec` 断言该端点 scope 仅 `compliance:manage`；重导出 OpenAPI 无其他漂移；零容器单测通过。
- 未做：D1-A 的 gain-saas 侧 BFF 路由清理（移除 `GET leads/:leadId`、`GET canonical-companies/:id`）由 gain-saas 仓另行执行；未发布镜像。

## 2026-10-31 · Admit platform schedule runs through signed v2 Grants issued by gain-saas (#706)

- 起因：平台运行准入仍指向执行权已被收回的 `admit_platform_execution_budget_run_v1`，四个平台工作流起步即 `permission denied`；v2 链路（验签器 + ingestion 服务 + SQL）早已写齐但没有调用方，权威方也没有持久的平台 Grant 签发。
- 改动：
  - 平台 worker 的 `admitPlatformSchedule` 改为 quote → 经 mTLS 向 gain-saas 取平台 Grant → `ingestAndAdmit`（v2），workflowId 只从 Temporal 读取；`PLATFORM_GRANT_ENDPOINT` 进编排。
  - 删除 `BudgetStore.admitPlatformRun`（v1）及其替身与测试。
  - 新增迁移 `20261031140000_platform_writer_business_grants`：平台写入者补齐 10 张业务表的精确权限（先全收再授予 + 迁移内 DO 自检 fail closed），清单 `docs/governance/platform-writer-table-privileges.json` 与零容器一致性测试。
  - 设计文档 `docs/superpowers/plans/2026-10-31-platform-run-admission-gainsaas.md` 转 `APPROVED` 并补施工注记（部署绑定 actionSha ≠ policy request sha，权威改持自己的策略副本）。
- 测试：`APP_DATABASE_URL= vitest run` 全量 10496 passed / 199 skipped；`contracts build + nest build` 通过。
- 未做：四个 schedule 仍 paused；启用与否由产品负责人单独决定。Cross-window 端到端（手动单次 run + 撤销 fence）在发版后验证。

## 2026-10-31 · Discover decision makers from indexed social profiles (#707)

- 起因：官网/注册处/展会之外还需要社媒与渠道。设计稿 §5.3b 的三层降级里，第一层是「搜索引擎已索引的公开片段」——零登录、零目标站抓取、零出口 IP 风险，先把它做成适配器（M2a）。
- 改动：
  - 新适配器 `social_presence`（`providers/social-presence.provider.ts`）：用 `searxng.search` 发定向 dork（`site:linkedin.com/in`、`site:xing.com/profile`，带公司名/域名与 ICP 目标角色），从结果标题解析「姓名 – 职务 – 公司 | 平台」；公司名不匹配的结果一律丢弃（防张冠李戴）；只保留个人主页路径（公司页排除）；同一 URL 去重。
  - 联系人记录标 `personalData: true`、`license: 'public-index'`、`sourcePage` 为索引里的公开 URL；邮箱/电话留待 M2b（档案副本/公开页直抓）补。
  - 注册表：适配器注册进 `contacts`（座席上限 5 → 6），`data_provider` seed 行 `social_presence` 默认 ENABLED（kill-switch 走本表 status）。
- 测试：新 spec 5 例——dork 构造（角色词/域名锚定/空名）、标题解析（LinkedIn/Xing/单词名拒绝）、结果过滤（公司页/陌生人/非社媒/去重）、broker 调用与单查询失败容错、无 broker fail-closed。
- 未做：档案副本（Wayback/Common Crawl）与公开页直抓（M2b）；theHarvester/social-analyzer/JobSpy 的 OSS 工具化；联系人阶段独立预算账户与 per-tenant LIA（设计稿 §5.3c/§5.3d，已拍板，M3）。

## 2026-10-30 · Make the SSRF guard's DoH endpoints configurable with ordered fallback (#696)

- 起因：出网护栏在系统 DNS 全部是 mihomo fake-IP 时走 DoH 反查真实地址，端点硬编码为 Cloudflare。2026-10-29 本机 `cloudflare-dns.com` 一度不可达（`dns.google` 与 `1.1.1.1` 同时被掐、而 `doh.pub` 正常），`POST /companies` 因此全部报 `INVALID_URL`，演示工作空间的验收入口直接停摆；一个 DoH 端点的可达性不该决定整台机器的出网解析。
- 改动：
  - `apps/api/src/adapters/net-guard.ts` 新增 `NET_GUARD_DOH_ENDPOINTS`（逗号分隔、仅接受 https 绝对 URL、按序去重）；缺省仍为 Cloudflare 再 Google，配置项全部非法时回落缺省，避免一处配错误伤全部解析。
  - `dohLookup` 按配置顺序逐端点尝试（A 与 AAAA 并发），第一个给出非空答案的端点胜出；全部失败仍 fail-closed 返回 `dns_lookup_failed`，私网/fake+private 混合的拒绝逻辑不变。
  - 导出 `parseDohEndpoints` 与 `DEFAULT_DOH_ENDPOINTS` 供测试与运维核对。
- 测试：`net-guard.spec.ts` 15 例全绿——新增 4 例覆盖端点解析（缺省/空串/非法项/去重/全非法回落）、首个端点失败换下一个（断言两个端点都被请求）、全部失败仍 fail-closed、未配置时的缺省顺序。
- 未做：没有改动 fake-IP 判定、私网拒绝与连接 pin 语义；也没有把 doh.pub 写进缺省列表（属部署侧决定，用 `NET_GUARD_DOH_ENDPOINTS` 配即可）。

## 2026-10-30 · Let each acquisition task pick its own model (#697)

- 起因：2026-10-30 产品负责人要求获客不要一个模型打天下，按各模型特点分配。#695 只给了两个档位（抽取档、推理档），像 fit 判定、开发信草稿、词表归一这类需求差异明显的任务只能挤在同一档里。
- 改动：
  - `apps/api/src/ai-tasks/task-registry.ts` 新增 `MODEL_ACQUISITION_TASK_MODELS`（JSON 对象，taskId → 模型名）。列出的任务用各自的模型，其余仍走 `MODEL_ACQUISITION_MODEL` / `MODEL_ACQUISITION_REASONING_MODEL` 两档默认；未知 taskId 与非字符串值忽略；整段 JSON 解析失败时整体忽略，一个笔误不会让进程起不来或静默清空未列出的任务。
  - 导出 `parseTaskModelOverrides` 供测试与运维核对。
- 测试：`task-registry.spec.ts` 10 例全绿——新增 3 例覆盖解析（丢非字符串、非法 JSON、空值）、覆盖只作用于列出的任务（其余保持档位默认）、非法映射整体回落档位默认。
- 未做：默认不放任何覆盖（不配 env 时行为与 #695 完全一致）；模型清单与身份门未改，仍要求上游回显请求的模型名或已登记的 `MODEL_IDENTITY_SUBSTITUTES`。

## 2026-10-30 · Read the latest outreach draft and consume a workspace grant only after the request's own checks (#699)

- 起因：GainOS 验收发现两个引擎侧缺口——(1) 没有读取已有开发信草稿的接口，刷新/换设备后看不到历史草稿；(2) 受控端点先消费一次性 Grant 再做业务前置校验，同一请求被 422/404 拒绝后重新取 Grant 也会撞 `EXECUTION_BUDGET_GRANT_REUSED`，失败即无法重试。
- 改动：
  - 新增 `GET /leads/{leadId}/outreach-drafts`（`acquisition:read`），返回该线索最新一版草稿（无草稿时 `data=null`，契约按 nullable 标注）。
  - 受控端点改为「先验证 Grant → 跑业务前置校验 → 才消费」：`ExecutionBudgetAuthorityService` 新增 `consumeVerifiedWorkspaceGrant`，ICP 设计、查询计划与开发信草稿三处接入；被拒绝的请求不再烧掉一次性 Grant。
  - 开发信草稿生成默认幂等：该线索已有草稿时直接返回最新版、不再调用模型也不消耗 Grant（覆盖浏览器超时/关页后的重试）；读取已有草稿请用新增的 GET。
- 测试：outreach 草稿服务新增「返回旧草稿不消费」「regenerate 生成新版本」「先校验后消费」用例；ICP 设计/查询计划相应断言更新；迁移无。
- 未做：「重新生成/新版本」未提供——同一线索的预算账户键固定，第二次 Grant 在开户时必然 `409 EXECUTION_BUDGET_GRANT_REUSED`（账户与主体的绑定语义要另行设计）；G5（租户侧线索/公司详情去 `personal-data:read`）是产品口径决定，未包含。

## 2026-10-29 · Stop re-acking crawl receipts in understanding offerings persistence (#694)

- 起因：公司理解的模型抽取全部成功、`persistClaims` 已落库，但工作流在 `persistOfferings` 抛 `ExecutionControlError`，公司状态回到 DRAFT。根因是 `persistClaims` 已用 `crawl4ai.fetch` + domainAckKey `...:crawl` 确认每页爬取回执，`persistOfferings` 又用同一回执、同一 key 再确认一次：第二次得到 `REPLAYED`，而 offering 抽取回执是 `APPLIED`，`applyDomainAckConsumerTransactions` 检测到混合状态并抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`。
- 改动：`persistOfferings` 不再重复确认爬取回执；爬取回执只在 `persistClaims` 确认一次，offering 自己的抽取回执仍按 `...:offerings` 确认。没有改动 workflow 命令序列、预算账本或 schema。
- 测试：本地引擎镜像构建成功，镜像 `org.opencontainers.image.revision` 与源提交一致；本地镜像部署被引擎 runtime-image verifier 和 GrowthOS platform authority 拒绝（未登记镜像），不是代码失败。正式镜像发布后需用一条全新公司档案重跑理解，确认状态到 REVIEW。
- 未做：未在本机完成运行态验证；未迁移 GrowthOS 的平台 Grant/platform-worker trust root。
- 部署：合并后由 `.github/workflows/publish-runtime-image.yml` 发布镜像，再用 `gctl switch-backend <digest>` 切换并完成 GrowthOS 侧登记。

## 2026-10-29 · Make provider-billing settlement readback opt-in and acquisition model names configurable (#695)

- 起因：获客网关换成新的 new-api 中转站后，产品负责人决定**不再读取中转站的账单结算**（原来 Site Builder 的按请求结算回读是 API/Worker 的硬就绪门，缺凭据就整体不就绪）；同时获客任务把模型名写死在代码里，换模型要改代码发镜像。
- 改动：
  - 结算回读改为**部署级可选能力**：`MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL` 缺失即视为未启用——`runtime-admission` 的网关检查、`checkSiteBuildSettlementReadbackReadiness`、worker 与快车道 worker 的 catalog / readback 就绪保持全部跳过；凭据存在而 keyring/catalog 缺失时仍 fail-closed。未启用时付费 Site Builder 的**模型调用**在调用点拒绝（`PERSISTENT_LEDGER_UNAVAILABLE`），不会静默不结算；付费**工具调用**仍走本地 provider-wire 账本预留（建站自 9-23 冻结，这是已知限制，重新启用结算回读后恢复对账）。worker 的 provider-wire 数据库是本地账本、与账单回读无关，仍是 worker 的启动前提，就绪检查保持无条件要求。
  - 获客模型改为环境变量：`MODEL_ACQUISITION_MODEL`（抽取/分类档，默认 `deepseek-flash`）、`MODEL_ACQUISITION_REASONING_MODEL`（ICP 设计、fit 判定、查询计划、开发信草稿，默认同样 `deepseek-flash`）；身份闸门语义不变，上游必须回报所请求的模型或命中的已批准替换。
- 测试：`src/runtime` 与 `task-registry` 套件 308 项通过；新增「未配置即跳过」「部分配置仍失败」两类用例；`pnpm --filter @global/api build` 零类型错误。
- 未做：未删除 Site Builder 结算模块本身（未启用的能力仍可后续重新配置启用）；本次不改迁移与数据库。

## 2026-10-28 · Drain the worker only after three consecutive dependency failures (#683)

- 起因：2026-10-27 17:06Z 一次结算回读探针的 2 秒超时（负载下的瞬时抖动，事后同一探针稳定返回 200/10ms）让 worker 永久停止 Temporal 轮询——`startWorkerDependencyHeartbeat` 对**任何一次**非 ok 都立即 drain。恢复只能重启容器，而重启杀掉在飞活动后，重试撞上「已预留、已消费、无持久结果」的预算操作键（`BudgetOperationReplayError`，控制错误），把验收 run `659f2320` 整条判 FAILED。
- 改动：心跳改为**连续 3 次（约 30 秒）失败才 drain**，任一次恢复即清零；启动阶段同样最多试 3 次（间隔 1 秒），全失败才拒绝 admission，瞬时抖动不再拒绝启动。结算回读探针的 `maximumProbeDurationMs` 2 秒 → 5 秒（仍在 10 秒心跳间隔内）。未在探针内部再加一次重试：心跳本身就是带间隔的重试，内部重试只会把最坏耗时翻倍。
- 安全不变量保留：`RuntimeComponentStatus` 的失败可带 `drainImmediately: true`，心跳见到它**当次即 drain**、不走三次容错。平台授权能力检查（`checkPlatformAuthorityReady`）标记为立即 drain——签发能力消失时不能再用旧授权多轮询 30 秒。`platform-authority-capability-regression` 的既有用例（能力消失即刻 drain）保持不变并通过。
- 测试：`worker-dependency-heartbeat.spec.ts` 重写为 5 个用例——单次抖动不 drain、连续三次才 drain、恢复后计数清零、启动期瞬时失败仍准入、启动期连续三次失败才拒绝准入、抛异常按失败计数；`managed-dependency-readiness.spec.ts` 36 例与两个 worker 装配 spec 全绿。
- 未做：预算操作的重放语义（D13，PR #597 挂起中）本次不涉及；drain 后自动恢复（不重启容器）不在本改动范围。

## 2026-10-28 · Absorb an unreplayable operation left by an earlier attempt instead of failing the run (#684)

- 起因：验收 run `659f2320`（2026-10-27）在上游连续流错误后失败——16:04–17:07 之间 19 次模型调用被上游中断、已扣费且没有 durable result（$0.42）；活动重试时相邻两家公司都撞上这些不可重放的旧操作，触发 best-effort 阶段的「连续两次不可重放即判 run 失败」规则。该规则把**更早尝试留下的残留**误读成「当前上游整体故障」：画像阶段逐家顺序执行，所谓“连续两家”必然来自两次不同时间的孤立故障（fit 阶段一直按单公司跳过）。
- 改动：`BudgetOperationReplayError` 区分 `origin`——在预留处命中的旧操作是 `remnant`（更早尝试的残留），本次尝试自己已出网、结果没能落库/投影/结算的是 `live`（存储或账本故障的现场证据，默认值，漏标则维持旧行为）。查询、官网画像、信号富集、网站监控四个阶段：`remnant` 一律按单查询/单公司跳过计数（`unreplayableSkips`），`live` 保留原来的「同阶段连续两次即失败」。fit 维持原有语义（所有不可重放都记未判定）。线上的 `previousQueryUnreplayable` / `previousUnreplayable` 交接字段保留，旧 workflow 历史重放不受影响；workflow 代码零改动。
- 测试：四个阶段各新增「活故障连续两次仍停」与「残留/活故障相邻时只计残留」用例；原有“连续两次即停”用例改标为残留并断言逐条吸收；rehearsal 与 workflow 场景改为 PARTIAL + 计数（查询 2/2、信号 12 家上限）。
- 未做：不改变 D13（已扣费无结果、同一 run 内永不重放）；不处理上游 new-api 渠道的健康度（另一条线）。

## 2026-10-28 · Skip a company this run already accepted before calling the model again (#686)

- 起因：一次 run 的计划里有 10–21 条查询，同一批站点会在多条查询里反复出现（run 7d70d81d 的 87 条记录里有 28 条、32% 是同一 URL 的重复，其中内容漂移的部分被隔离为 `PROCESSING_KEY_DRIFT`）。重复的不只是抓取：`public_web` 的发现阶段按域名逐家调用模型判站，重复域名等于重复花模型调用，产出的记录随后还被摄取层丢弃。
- 改动：`executeQuery` 在 fan-out 前读出本 run 已 ACCEPTED 的 `external_id`（按路由到的 provider 过滤、去重），作为 `knownExternalIds` 随 `DiscoveryOptions` 传给适配器；`public_web` 在搜索之后、调用模型之前跳过这些域名。其他适配器忽略该选项（注册类源是廉价查询，无需跳过）。`DiscoveryOptions` 新增字段是加法，适配器签名不变。
- 测试：`public-web-search-first.spec.ts` 新增用例——已知域名不触发模型调用、结果只含新域名；`raw-source-activities.spec.ts` 的 executeQuery 持久化用例断言适配器收到 `knownExternalIds`（含 run 里已接受的域名），并确认摄取计数不受影响。
- 未做：跨 run 的去重不做（不同 run 换了操作键、也允许重新判站）；同一 run 内「同域名不同 URL」仍按域名去重、不细分路径。

## 2026-10-28 · Profile two companies at once, overlapping only the network work (#687)

- 起因：官网画像是 run 里第二耗时的阶段（每家两次抓取 + 一次渲染 + 一次模型调用，全部逐家串行）。#43 的 run 判了 36 家、画像只覆盖 26 家，7 条 match 里 5 条因为没抓到联系页而卡在 0.4575 分——覆盖不足直接压低 recommended。
- 改动：画像循环改为按批（2 家）处理——租约与时间盒检查、新鲜度/冷却/存储前检、计数器、ACK 与提交仍全部串行且按公司顺序；只有 `provider.profile` 的网络部分并发。批次内的租约检查按「已准入家数」预留时间（`allows(unit × (已入批+1))`）；上游等待放不下租约时，该家不计入并不再启动新批，同批已跑完的结果照常提交；时间盒与续做索引语义不变。
- 测试：`discovery.activities.spec.ts` 296 例全绿——新增「两家同时在飞」用例（第一家阻塞时第二家必须已启动）；既有租约/时间盒/续做/重放用例全部原样通过；「上游故障停止本 pass」用例改为断言批内两家都被调用、之后不再启动、无提交。
- 未做：并发度写死为 2（先观察宿主与上游承压）；enrich（GLEIF）阶段未动。

## 2026-10-28 · Keep the evidence source URL and let a refetch extend a field's freshness (#688)

- 起因：交付闭环设计 §8（L1 余项）——富集写入时 `provenance.sourceUrl` 已在手却被丢掉，物化证据也丢掉了 `raw_source_record` 的来源 URL；有效期按「每分级最早抓取」计算，重抓不会延长，与「证据是最新的」相矛盾。
- 改动：迁移 `20261028120000_field_evidence_source_url` 给 `field_evidence` 加可空 `source_url`（https、≤2048 的 CHECK，不回填）；富集提交把 provenance URL 与原始抓取时间写到每条证据行；物化证据联 `raw_source_record` 补 URL 并把 `fetched_at` 改用原始记录的抓取时间；读模型（`LeadPackage`/`LeadQualified` 证据链接）优先用行上的 `source_url`，历史行回退 raw 联表；`valid_until` 改为**每个字段取最新抓取、字段之间取最早失效**（decide / package / 周报三处同口径）。
- 测试：迁移静态契约、`fieldEvidenceProvenance` 单元（https/长度/空值）、富集提交写 URL 与拒收非 https、包读模型 URL 优先级与每字段有效期、decide 快照的「同字段重抓延长 / 不同字段取最早」、周报 `_max` 聚合；全量零容器单测与 `gctl check --fast`。
- 未做：历史证据行不回填（设计如此，读时回退 raw 联表）；线索级成本分摊与开发信草稿（L5）另行安排。

## 2026-10-28 · Restore the self-hosted Scalar portal and turn it into documentation a person can actually read (#689)

- 起因：`/api/portal`（自托管 Scalar 文档门户，`321d90e5`，2026-07-06 加入）自 `a648706a`
  （2026-08-24，CodeQL 高危修复，给所有响应加上 helmet 的 CSP）起在浏览器里白屏。页面把
  整个 UI 内联成一段 `<script type="module">`，而全局 `script-src 'self'` 拒绝执行内联脚本；
  Chromium 实测控制台报 `Executing inline script violates the following Content Security
  Policy directive 'script-src 'self''`，`#app` 挂载点保持为空。同一批接口的 Swagger UI
  （`/api/docs`）走的是同源外链脚本，不受影响，所以这个问题两个月没有被发现。
- 改动：
  - **CSP**：`apps/api/src/main.ts` 在挂载 `/api/portal` 之前多挂一层路径级 helmet，只把这条
    文档路由的 `script-src` 放宽成 `'self' 'unsafe-inline' https://cdn.jsdelivr.net`，其余指令
    沿用 helmet 默认；`/api/docs` 和 `/api/v1/*` 的 CSP 一字未改。没有用 `unsafe-eval`：Scalar
    的打包产物里没有 `eval(` 或 `new Function(`。
  - **页面由两段脚本组成**（实测发现，原注释只说了「自托管」）：一段是页面内联的配置（整份
    OpenAPI 都嵌在里面，数据不出本机），另一段是浏览器从 `cdn.jsdelivr.net` 加载的 Scalar
    运行时库。只放行 `'unsafe-inline'` 时页面依旧白屏，控制台报的是 jsdelivr 那条被拦；两处
    都放行后才渲染出来（容器内无头 Chromium：0 条 CSP 违规、DOM 1.16 MB、左侧分组与首页
    说明齐全）。
  - **给人看的说明**：门户首页改为一段完整的接入说明（`apps/api/src/docs/portal-intro.ts`）——
    认证与 token 取法、scope↔角色映射、统一信封与游标分页、错误模型、幂等与乐观锁、哪些动作
    是异步、获客主链路的调用顺序、按域速览。文字只写代码里成立的事实，不写业务承诺。
  - **端点正文**：`apps/api/src/docs/operation-descriptions.ts` 集中维护 74 个端点的正文
    （其余 8 个原本就在控制器上有 `description`，保持不变），在 `buildOpenApi` 里只补空缺、
    不覆盖控制器上的值。
  - **分组**：12 个 tag 全部补上说明，并用 `x-tagGroups` 按接入顺序分组（获客主链路 / 运营与
    合规 / 建站 / 平台间通道 / 系统），不再按字母序排。
  - **契约落盘**：`packages/contracts/openapi/openapi.json` 用 `--export-openapi` 重新生成。
- 测试：
  - 新增 `apps/api/src/docs/operation-descriptions.spec.ts`（4 例）作为完整性闸门：每个操作必须
    有 summary 与正文、每个声明过的 tag 必须有说明、说明不能是占位符（<12 字）、描述表不能指向
    已不存在的操作。以后新增端点漏写说明会在 CI 里直接红，而不是等有人打开门户才发现。
  - CSP 用打补丁的源码在本地起 API（`:3113`）逐路由抓响应头核对：`/api/portal` 为
    `script-src 'self' 'unsafe-inline'`，`/api/docs` 与 `/api/v1/health` 仍是 `script-src 'self'`。
  - 全量单测在本机跑有 11 例失败，全部落在 `platform-revocation-*` 与 `temporal/*replay*` 两组，
    本机 `umask 0002`（CLAUDE.md 记录的该组 503 已知环境问题），与本改动无关；CI 为准。
- 未做：没有给 `/api/docs` 做同样的放宽（它是同源外链脚本，本来就能跑）；没有把这两条文档路由
  移出全局 helmet，那会连 `X-Frame-Options` 等头一起丢掉；没有给请求/响应 DTO 逐字段补
  `description`（那是下一层，字段说明目前只有部分 DTO 有）。
- 已知限制：门户的运行时库仍从公共 CDN 取，浏览器不能出网（纯内网/离线）时页面打不开；
  接口定义与数据本身始终在本地。彻底自托管要把 `@scalar/api-reference` 的 bundle 内置进镜像
  并改掉页面里的 import 地址，是另一件独立的事。

## 2026-10-28 · Run a plan's queries two at a time (#690)

- 起因：查询阶段是 run 里最耗时的一段（#43 的 10 条查询约 45 分钟、#41 的 21 条 55 分钟仍未跑完），workflow 里严格逐条 `await`，而每条查询是「SearXNG fan-out + 逐域名模型调用」，大部分时间在等网络。
- 改动：`discovery.workflow.ts` 的查询循环按批 2 条并发（`Promise.allSettled`），并用新 patch `DISCOVERY_QUERY_BATCH_PATCH` 守卫——旧历史重放仍走原逐条路径。计数与顺序不变：结果按计划顺序折叠进 totals；一条查询普通错误在 `DISCOVERY_QUERY_FAILURE_STOP_PATCH` 下仍停止 run（同批另一条已在飞，可能已花掉）；不可重放的交接语义改为「上一批全部丢源」才告诉下一批。
- 测试：`workspace-authority.workflow.spec.ts` + `discovery.rehearsal.spec.ts` 共 99 例全绿——新增「批内两条同时在飞」用例（第一条阻塞时第二条必须已发出）；四处不可重放交接用例按批语义更新（同批无交接、整批丢源才传递、批内混合不传递、控制错误时同批两家可能都已调用）。
- 未做：并发度写死 2；`executeQuery` 内部的模型/出网并发不变（已是 5 路抽取），峰值约 10 路模型调用，先观察上游错误率再评估 3。

## 2026-10-28 · Store a model-written first-contact draft on accepted leads and fill the weekly-report column (#692)

- 起因：交付闭环设计（2026-10-10 已批准）L5——周报的「开发信草稿」列一直是空的，运营拿到线索后还要自己从零写首次联系邮件。
- 改动：
  - 新增模型任务 `outreach.first_contact_draft`：输入只用公司级事实（卖方 Claim/产品、买方贸易角色/在售品牌、Fit 结论与信号），不传任何人名或联系方式；输出目标国语言的 subject/body、中文译文与被引用的事实键。
  - 新表 `lead_outreach_draft`（只追加、按线索版本号递增、FORCE RLS、`app_user` 只有 SELECT/INSERT），随 lead 级联删除；生成入口 `POST /leads/:leadId/outreach-drafts`（`acquisition:review`，走 Workspace Grant，新增预算 purpose `outreach.draft` 与技术报价操作）。
  - 草稿末尾由代码（非模型）追加卖方自己的回复入口：官网、邮箱、`wa.me` 一键聊天链接（仅 E.164）。
  - `used_facts` 校验：引用未提供的事实键或为空即丢弃草稿（422 `OUTREACH_DRAFT_UNGROUNDED`），不落库；只有最新裁决为 accept 的线索可生成（否则 422）。
  - 周报「开发信草稿」列取每线索最新一版（主题 + 正文 + 中文译文 + 「草稿，需人工审阅；平台未发送」）。
  - 平台不发送草稿，也不提供发送按钮。
- 测试：零容器单测覆盖事实表/尾注/接地校验/版本追加/重放读回/并发版本重试与周报列；`scripts/execution-authority-policy.spec.mjs` 与 durable-result 投影注册表同步扩一项并全绿。
- 未做：GrowthOS 侧尚未签发 `outreach.draft` 授权与展示草稿（前端不在本次范围）；迁移 `20261028180000_lead_outreach_draft` 仅新增文件，随下一班镜像窗口执行。

## 2026-10-28 · Pin qs to the patched 6.16.1 release and rebind the production audit baseline (#693)

- 起因：10-27 基线重绑之后，GitHub 又发布了 GHSA-6pq8-jhm2-2vcw（`qs.stringify` 对带不可调用 `toString` 的数组元素抛未捕获 TypeError，moderate，影响 `>=6.7.0 <=6.16.0`）。锁文件仍带着 express 与 webpack `url` 垫片引入的 `qs@6.16.0`，main 的 `production advisory baseline freshness · canary` 因此变 `BASELINE_STALE`（run 40675525935，subject `a30ac929`）。
- 改动：
  - 根 `pnpm.overrides` 新增 `qs@>=6.7.0 <6.16.1 → 6.16.1`，锁文件里 qs 收敛为单一版本 6.16.1（同时带入 pnpm 对平台包 `libc` 元数据的规范化）。
  - `SECURITY_FLOORS` 的 qs 下限升到 6.16.1，`qs@6.16.0` 登记为漏洞前任。
  - 基线重绑到修复提交 `6510fb5f`（锁文件摘要随之更新），`valid_until` 维持 2026-11-10；`scripts/supply-chain-gates.spec.mjs` 的钉值同步；新增冻结回执 `docs/evidence/security/20261028-qs-advisory-remediation.json`（修复前 CI 上的 `BASELINE_STALE`/1 条 → 修复后 `FRESH`/0 条）。
- 测试：`node scripts/supply-chain-audit.mjs verify` 为 `PASS_CLEAR`（零 advisory）；`baseline-freshness` 在旧绑定下 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定下 `FRESH`；`scripts/supply-chain-gates.spec.mjs` 28/28、`scripts/dependency-security-remediation.spec.mjs` 9/9；`supply-chain-source-policy validate-sources` 为 `DEPENDENCY_SOURCES_TRUSTED`。
- 未做：未升级全量依赖（月度批量刷新仍按 11 月节奏）；开发依赖侧既有的 4 条 advisory（faker、vitest mocker ×2、deepmerge）不在生产基线口径内，本次未动。

## 2026-10-27 · Pin the revocation TLS fixture CA file mode (#677)

- 起因：新开发机 xin 的进程 umask 为 002，测试夹具用 `openssl` 现场生成的 CA 证书因此是 0664（组可写）；平台撤销信任运行时对信任锚文件做严格的属主/权限/不可变校验（拒绝组或其他可写文件），快照构造失败后 `platform-revocation-http*` 的 7 个 real-HTTPS 用例全部以 `PLATFORM_REVOCATION_UNAVAILABLE` 失败。CI（umask 022 → 0644）与当年以 root 运行的旧会话掩盖了这个环境依赖。
- 改动：`apps/api/src/platform-authority/platform-revocation-http.test-fixture.ts` 在生成证书后显式 `chmodSync(certificate, 0o644)`，不再继承环境 umask；产品代码与运行时的信任锚校验均不变。
- 测试：本机（umask 002）该组 4 个文件 33 个用例全部通过（修复前 7 个失败）；CI `build · typecheck · test` 通过。
- 未做：另两处 openssl 测试夹具（`machine-token-client`、`platform-capability-https`）在同一 umask 下本已通过，本次未改动。

## 2026-10-27 · Stop the signals stage on the lease and count a lost source in stats (#678)

- 起因：租约软截止（#672）只覆盖查询、画像、fit、富集与监控；信号富集是唯一未接租约的慢阶段，租约见底后仍会逐家读完，run 只能在更晚的收口里被动失败或 PARTIAL。另 #674 已把站点断连造成的单源损失计为 `transportFailed`，但编排层还没把它计入 stats 与状态。
- 改动：
  - `enrichSignalsRun` 在每家公司的 SUSPENDED 检查之后看租约余量，不够一个 `enrich` 单位就停下，余下仍需读取（TTL 新鲜或已完整读过的公司不计）记入 `skippedForLease`。
  - 工作流把 `skippedForLease` 按阶段累计进 `stats.skippedForLease.signals`（run 至少 PARTIAL），并把 `transportFailed` 以 `stats.transportFailed.signals` 呈现（仅在 >0 时出现）；`resolveRunStatus` 增加 `transportFailedSkips` 输入（BI-25），断连损失不再可能读成 DONE。被拒主体与无法重放的公司不重复计入。
- 测试：`discovery.activities.spec.ts` 新增 signals 租约 3 个用例与 `resolveRunStatus` 2 个用例；activities、signals-retry、rehearsal 三个测试文件 311 个用例全部通过。
- 未做：`profileWebsitesForRun` 的首页+Impressum 读取与模型调用仍作为一批 ACK（MIXED 风险），留待单独 PR。

## 2026-10-27 · Clear 13 newly published production advisories and rebind the audit baseline (#679)

- 起因：2026-10-19 的基线捕获为零 advisory，之后 GitHub 又发布了 13 条 production advisory（body-parser、multer、fast-uri、undici 7/8、zod），而锁文件本身没动——main 的 `production advisory baseline freshness · canary` 变成 `BASELINE_STALE`，并且 11-02 到期后所有改依赖的 PR 都会被拦。
- 改动：
  - root overrides 钉住四条线的修复版本：multer 2.5.0、fast-uri 3.1.9、undici 7.30.1 / 8.12.2、zod 4.6.7；body-parser 2.4.0 由 express 的 `^2.2.1` 自然解析，没有 override，由 `SECURITY_FLOORS` 兜底（将来若被解析回 2.3.x，是 floor 测试报警而不是 override 拦住）。
  - `packages/contracts` 由 zod `^3.25.76` 升到 `^4.6.6`（全仓唯一声明 zod 的包；代码零改动，10,327 个单测通过）。
  - `SECURITY_FLOORS` 上调到修复版本，7 个被替换的版本登记进 `VULNERABLE_PREDECESSORS`。
  - 解析时 pnpm 曾把 `@opentelemetry/propagator-jaeger@2.12.0` 的弃用说明（带 `https://` 链接）写进工作区的锁文件；供应链策略禁止锁文件出现任何 URL，已删除这行纯元数据（main 的锁文件本就没有它，所以 diff 里看不到这条删除）。下次非 frozen 的重新解析可能再带回，届时同样删掉即可。
  - 基线重绑到 `c33861aa` 及其锁文件摘要，`valid_until` 延到 2026-11-10T05:13:39Z；`supply-chain-gates.spec.mjs` 钉值同步；新增冻结回执 `docs/evidence/security/20261027-production-advisory-remediation.json`（修复前 CI 上的 `BASELINE_STALE`/13 条 → 修复后 `FRESH`/0 条）。
  - Copy fixed-source 回执重签（`HASH_ONLY`）。
- 测试：`pnpm --filter @global/api build` 绿；`pnpm --filter @global/api test` 10,327 passed（本机缺 Chrome 的 2 个用例在装上 Chrome 后单独验证 52/52）；`pnpm governance:verify` 绿；`supply-chain-audit verify` 为 `PASS_CLEAR`；`validate-sources` 为 `DEPENDENCY_SOURCES_TRUSTED`。
- 未做：本轮只升级受 advisory 影响的五条依赖线，没有做每月一次的 `pnpm update -r` 全量 minor/patch 批量升级（留给 11 月的月度刷新），也未动 NestJS、astro 等大版本。

## 2026-10-27 · Judge duplicate advisories by GHSA, package and affected range (#680)

- 起因：`2026-10-27` 的依赖刷新 PR #679 上，非必需的 `production dependency delta · canary` 报 `AUDIT_SNAPSHOT_INCONCLUSIVE` / `[AUDIT_COMPARISON_INVALID] trusted PR base audit is incomplete or malformed`，但候选审计为 0 条。根因是受信 base 的锁文件里 `GHSA-xjj6-f33q-929c`、`GHSA-4qv8-2p9j-2685`、`GHSA-f72v-6w45-q472` 各自同时覆盖 undici 7.x 与 8.x 两条版本线，pnpm audit 因此输出两条同 GHSA 同包的记录，而校验器的 `advisoryIdentity` 只取 `ghsa_id|package`，把这两条合法记录判成 `AUDIT_ADVISORY_DUPLICATE`，使 base 审计被判“畸形”。任何改依赖输入的 PR 在 base 带这类多版本线 advisory 时都无法通过该检查。
- 改动：新增 `advisoryLineIdentity`（`GHSA + 包 + vulnerable_versions`），**只用于审计侧的重复判定**（`normalizePnpmAudit` 的 `AUDIT_ADVISORY_DUPLICATE`）；与 baseline 的 ratchet 匹配、finding exposure 归属、以及 baseline 自身的重复判定仍沿用不带区间的 `advisoryIdentity`，语义身份不变。`docs/security/README.md` 的 ratchet 说明补了这条口径。
- 测试：`scripts/supply-chain-gates.spec.mjs` 新增用例覆盖三件事——同一 GHSA 覆盖 undici 7/8 两条线时不再判重复、同一 GHSA 同区间的真重复仍会报 `AUDIT_ADVISORY_DUPLICATE`、以及受信 base 带双线 advisory 时 delta 从 `AUDIT_SNAPSHOT_INCONCLUSIVE` 回到 `COMPARABLE_AUDIT_PASS`。该 spec 28/28 通过，`pnpm governance:verify` 全绿。
- 未做：没有改动 `advisoryIdentity` 本身，baseline 匹配（`baselineByIdentity`）、delta 的 `comparisonByIdentity`、exposure 归属与 `expectedBootstrapBase` 精确集校验仍按 GHSA + 包 折叠。因此 baseline 侧继续拒绝“同一 GHSA 两条版本线”的写入（这类记录在匹配层只会保留一条，永远无法与自身审计对上），本次把这条限制写进了 README 与测试。

## 2026-10-27 · Implement the lead delivery loop reason codes, outcomes and LeadPackage (#681)

- 起因：交付闭环设计（2026-10-10 批准）的 L1–L6 一直未实现，周报里的原因码 / 注册地址 / 建议联系路径列全空，客户也无法回写线索结果。
- 改动：
  - BI-20 原因码：拒绝与正向结果枚举、Fit 原因码的确定性推导，`lead_decision.reason_code`（reject 必填，缺省返回 422）。
  - BI-23 反馈：新表 `lead_outcome`（只追加、FORCE RLS、app_user 仅 SELECT/INSERT）与 `POST /leads/{id}/outcomes`、`POST /reports/weekly/feedback`（客户填好的周报 CSV 原样上传，逐行校验）。
  - BI-19/21：`LeadPackage` 读模型与 `GET /leads/{id}/package`；`LeadQualified` v1 新增可选交付字段（公司画像、标识、联系路径与建议路径、信号、证据 URL、Fit 原因码），旧载荷仍通过。
  - BI-15：建议联系路径的确定性规则与固定合规备注；周报填充「为什么现在 / 原因码 / 注册地址 / 建议联系路径」列。
  - L6：从 Impressum 抽公司注册地址（独资商号不存），接入 `website_profile` 与属性白名单。
  - E7：有域名的公司同时按「名称+国家」键匹配平台信号。
  - 新增迁移 `20261027120000_lead_delivery_loop`，只加表/列/索引与权限，不回填。
- 测试：零容器单测覆盖原因码推导、LeadPackage 组装、反馈 CSV 解析与写库、迁移静态契约、注册地址解析与属性白名单；`gctl check --fast`。
- 未做：`field_evidence.source_url` 列与写入点补写、有效期按字段最新取值、线索级成本分摊、开发信草稿模型任务与 `lead_outreach_draft`、周报开发信列；迁移执行与镜像上线留待验收 run 结束后的窗口。

## 2026-10-21 · Let an artifact bind shared object bytes under its own media type, so empty HEAD probe results settle (#673)

- 起因：RL1 验收 run `c6b09756`（xin，2026-10-20）在信号阶段失败。根因复核发现：产物对象按内容寻址（主键是 sha256 + 隐私类），同样的字节共用一行；但产物表引用对象行的外键包含 `media_type`，`append_generic_operation_artifact_internal_v1` 也逐项比较对象行的 media type。线上唯一的空对象 10-12 由一个 crawl4ai-fetch/v1 结果先写成 `text/markdown`，此后每一次 http-get/v1 的 HEAD 探测（空 body，`text/plain`）都被拒为 `GENERIC_OPERATION_ARTIFACT_INVALID`，变成无法重放的操作。库里 19 份 http-get/v1 产物没有一份是空的，也就是从来没有一次 HEAD 探测落库成功。信号富集因此连续丢公司，直到阶段失败。#644 只修了存储层与服务层的相等判定，数据库这一层没动。
- 改动：
  - 新迁移 `20261021032000_generic_operation_artifact_object_media_type_reuse`：
    - 对象表加唯一键 `generic_operation_artifact_object_content_key (sha256, object_key, size_bytes, privacy_class)`；
    - 产物表的外键改为 `generic_operation_artifact_object_content_fkey`，引用这四列；
    - 整条迁移在一个事务里，先设 `lock_timeout = '5s'`，再按追加函数的加锁顺序（产物表、对象表）一次取两张表的排他锁，避免与正在结算的事务成环，被占住时 5 秒内失败而不是无限排队；
    - 先加新约束再删旧的 `…_metadata_fkey`、`…_metadata_key`，中间每一步都有约束兜着；
    - 用「取函数定义、精确替换、校验恰好一处」的改写，只删掉追加函数里对象行 media type 的比较（带漂移校验）。
  - 不变的部分：sha256、对象键、大小、隐私类仍须一致；已存在的同一产物仍须 media type 完全相同；产物行保留自己的 media type。
  - `schema.prisma` 同步新的外键与唯一键，Copy 回执已重签。
  - 设计文档 `execution-budget-authority-artifact-replay-design.md` §6.1 改为「media type 属于每份 manifest，不属于对象固有元数据」，并更正对象主键为 `sha256 + privacyClass`。
- 测试：
  - `generic-operation-artifact-object-version.postgres.spec.ts` 新增 2 例：
    - 同一份空字节先以 `text/markdown`、再以 `text/plain` 结算，两份产物各带自己的 media type，对象行仍是 `text/markdown`（先 RED：`GENERIC_OPERATION_ARTIFACT_INVALID`，只改函数后又被外键拒，两处都改后 GREEN）；
    - 大小不同的同一对象仍被拒绝。
  - 新增静态迁移 spec `generic-operation-artifact-object-media-type-migration.spec.ts`，4 例：事务外壳与加锁顺序、约束先加后删、函数改写只删 media type 那一条且带漂移校验、Prisma schema 与迁移一致。
  - 在本地一次性 pgvector（同 CI digest）上跑 CI「Raw SQL parameter types on PostgreSQL」一步的 7 个 PG spec，36 例全绿；`generic-operation-artifact-subject.rls.spec.mjs` 10 例全绿。
  - 把 `global_dev` 的副本恢复进同一实例、只应用这条迁移：284 份产物不变，新约束全部 validated，函数里不再有对象 media type 比较。
  - 迁移后的测试库与 `schema.prisma` 做 `prisma migrate diff`：没有任何关于产物表的差异。
- 部署：这班车带迁移，换镜像要用 `gctl switch-backend <digest> --with-migrations <镜像源提交的 checkout>`，先 dry-run。
- 未做：
  - 信号阶段另外两处缺陷（单站 TLS 重置被当控制错误让整个活动失败；重试时同一家公司的确认批次混入新旧回执，`DOMAIN_ACK_MIXED_REPLAY_STATE`）另开 PR。
  - 卖方入驻理解工作流 `persistOfferings` 的同类混合确认另开 PR。
  - 不清理已因此留下的 RESERVED 操作。

## 2026-10-21 · Let one site's dropped connection cost only that company's enricher, and acknowledge signal receipts so a retry never mixes old and new (#674)

- 起因：RL1 验收 run `c6b09756`（xin，2026-10-20）在信号阶段失败，根因复核找到三个缺陷，其中媒体类型那个由 #673 修，这里修另外两个。
  - 缺陷 A：第 1 次尝试中，price-pumpen.de 在 TLS 握手时重置连接。http.get 把 Node 的原始错误原样抛出，它带 host/port 等字段，分类器按失败关闭的规则判为控制错误。于是一家公司的一个站点让整个活动失败。
  - 缺陷 B：第 2 次尝试中，biergans 第 1 次的 4 条回执已经确认过；这次 robots 预检通过，多读了一页，多出 1 条新回执。同一家公司的确认批次变成「4 条重放 + 1 条新增」，抛出 `DOMAIN_ACK_MIXED_REPLAY_STATE`，run 判 FAILED。同一操作在一家公司里被读到两次（careers 页就是首页、两个 sitemap 列出同一子图）时，第 1 次尝试就会撞上同样的错误。
- 改动：
  - `guarded-http.ts`：Node 在已 pin 的 socket、TLS 会话或 HTTP 解析器上抛出的错误，按对象身份登记进一个 WeakSet，导出 `isPublicHttpTransportFailure`。错误对象本身不变，墙钟超时、各道闸门、出网拦截、体积超限都不登记，所以没有主动询问的调用方行为完全不变（分类器也没改）。
  - `enrichSignalsRun`：
    - 富集源抛出被登记的传输失败时，只跳过这家公司的这一个源，其余源照常运行，并计入新的返回字段 `transportFailed`（只在大于 0 时出现）。那次读取留在 RESERVED：下一个 run 换了操作键会再试；同一 run 若第 1 次尝试另因别的原因失败，第 2 次尝试会把这家记为不可重放（见「未做」）。仿冒同形字段的错误照旧失败关闭。
    - 回执按产生它的富集源分组，同一操作只记一次。有命中的源，用它自己的回执做一个批次，apply 只写它自己的命名空间，ACK 键带上命名空间名（`…:signal-enrichment:<源>`）；其余回执逐条单独确认，apply 为空操作，键格式不变。这样重试时，旧回执不会和新回执进同一个批次；一个源先前以未命中确认过的回执，命中后也能正常落库。
    - 命中先问一遍治理：`company-enrichment-commit.ts` 把逐条命中的治理抽成纯函数（`enrichmentHitSurvivesGovernance`，提交函数照用它，行为不变）。字段全被治理滤掉的命中按未命中处理，否则它的回执会以命中键确认、却不写 `_ts`，重试时这个源再跑一遍、多读一页就又是混合批次（复审发现，测试先红后绿）。
    - 公司查询加 `orderBy: { id: 'asc' }`，重试按同样顺序、同样的上限截断遇到同一批公司。
    - 更正 enrichSignalsRun 的注释：它不发 heartbeat（此前注释写「每家 heartbeat」）。
  - 没有改 workflow 和 run 状态判定：`transportFailed` 接进 stats 与 PARTIAL，以及信号阶段的逐家租约检查，由 #672 的作者在本 PR 合入后补上。
- 测试：
  - `guarded-http.spec.ts` 新增 5 例，全部在真实回环上跑：TLS 握手被重置、响应 socket 被挂断都被登记，且分类器对它的判定不变；墙钟超时不登记；四类闸门错误都不登记；仿冒的同形错误不登记。
  - 新增 `discovery.signals-retry.spec.ts`，9 例。它用真实的 ACK 绑定辅助函数，只把 Postgres 行存储换成内存实现，事务抛错时连同 ACK 行一起回滚。三例按 run `c6b09756` 的顺序复现缺陷 B，改前都抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`：
    - 第 2 次多读一页的未命中公司；
    - 先前以未命中确认、这次命中的源；
    - 同一操作被读两次。
    另一例复现复审发现的「命中但字段全被滤掉、重试多读一页」，改前同样抛 MIXED。其余几例覆盖：公司顺序；单站断连只记一个源；仿冒错误仍失败关闭；没有断连时结果里没有 `transportFailed`。
  - `company-enrichment-commit.spec.ts` 新增 1 例：纯函数对可存、被扣下、未知字段三种命中的判断。
  - `discovery.activities.spec.ts` 里「无命中回执走批量确认」那条只保留 `enrichRun`；信号阶段的这条行为改由新 spec 用真实绑定覆盖。
- 未做：
  - 卖方入驻理解工作流 `persistOfferings` 的同类混合确认（claims 与 offerings 共用同一个 crawl ACK 键）另开 PR。
  - `profileWebsitesForRun` 把首页、Impressum 读取和模型调用放在一个批次里确认，部分重试时有同样的风险，另开 PR。
  - 同时运行两个执行的 MIXED 仍按失败关闭处理，没有放宽。
  - 「连续两家不可重放即停」规则在同一 run 的重试里可能误触发：被吸收的断连会把那次读取留在 RESERVED，第 2 次尝试里这家公司是不可重放的；两家这样的公司在已尝试的公司里相邻，就会让第 2 次尝试失败。前提是第 1 次尝试另因别的原因失败（改前每次断连都会让第 1 次尝试失败，所以这是收窄而不是新增）。根治要让 broker 的不可重放错误带上原因，并让规则只数本次尝试新出现的失败；fit、画像、信号共用这条规则，另开 PR。

## 2026-10-21 · Judge fit three companies at a time, so a run's fit stage takes about half as long (#675)

- 起因：fit 一家接一家地判，约占一次发现 run 一半的时间。f92ea357 的 78 次判定每家 p50 46 秒，fit 从 05:25 跑到 06:38，撞上了租约。产品负责人 10-19 定了「fit 并发 3」；同一网关上的公司抽取本来就是 5 路并发。
- 改动：只改 `apps/api/src/temporal/discovery.activities.ts` 的 `qualifyFitForRun`，工作流不动，不需要 patch。
  - 最多 `FIT_CONCURRENCY = 3` 家同时判，任何一家落定就补下一家。
  - 每家判完立刻写入判定。所以别的公司失败也丢不了它，重试只列未判的公司，不会再判一次（满足同伴会话提的约束）。
  - 结果按公司 id 顺序合并：前面的公司都落定后才合并后面的，计数、「连续两家截断」规则和续跑游标都与一家一家判时一致。
  - 停下的原因按 id 顺序取第一个：确定失败、预算耗尽或租约不够。正在判的都落定后才返回或抛错，所以重试不会撞上还在跑的调用。
  - 开始下一家前发现租约不够时，也按 id 顺序生效：先等已开始的公司都合并，其中有预算耗尽或失败的，以它为准。复审前是立即记为租约不够，那几家的预算耗尽或 401 之类的失败会被算成租约跳过。停下之后才落定的失败，一次写一条日志，列出错误类名。
  - 一家已落定的失败排在仍在判的公司后面、还没合并时，先不再开始新的公司（它可能就是停下的原因）。否则上游快速失败时，池子会在一家慢判定期间反复补位（复审复现过一次开始 60 家）。合并后若只是第一次截断、被吸收，就照常继续。
  - 重试遇到的无法重放的公司只记未判定，不算进「连续两次」，停下之后落定的也照样计入：一次尝试失败或 worker 丢失后，重试会一起遇到当时在途的最多 3 家这样的公司，它们说明不了上游有故障。同一次尝试里连续两家流被截断仍会让这次尝试失败。
  - 这样做的代价（复审定为 LOW，保留）：上游持续出 504/524 超时或流截断时，重试先把前面尝试留下的公司记为未判定，只有还有没调用过的公司时才会再失败。所以活动余下约 6–9 家以内时（小 run 或最后一个续跑活动），fit 一家没判出也正常结束，run 判 `PARTIAL`（`unreplayableSkips.fit` 计这些公司），不判 `FAILED`；这种故障里一个 run 最多约 12 次调用按预留计费，一家一家判时是 2 次。两种结果都要重新生成计划才能再跑，`PARTIAL` 还让后面的阶段照常处理已判出的公司。
  - `FIT_PASS_TIME_BOX_MS` 由 8 分钟改为 4 分钟：在途的判定最长 10 分钟（两次网关请求），4 + 10 分钟留在 fit 活动 15 分钟的超时之内。之前是 8 + 10 分钟，理论上可能超时。
  - 预算耗尽时的日志不再写「backlog sweep 兜底」：fit 的补判任务目前停用。
  - `packages/contracts/INTEGRATION.md` 写明 fit 对无法重放公司的口径。
- 测试：先 RED 后 GREEN，新增 23 例，另改 4 例旧用例的并发前提、加强 1 例。在一家一家判的实现上，相关的 12 例确认为 RED；第一轮复审后补的 5 例在复审前的 head 上确认为 RED；第二轮复审后补的 10 例里，租约顺序 2 例和日志 1 例在修改前为 RED，其余用变异确认能抓到复审列出的存活变异（停下后又被后来的失败覆盖、不等在途就抛错、停下后继续开始、不计入不允许外部处理或答案不可用的公司、写入判定不等待）以及两种租约顺序变异。
  - `discovery.activities.spec.ts` 新增 7 例：
    - 最多 3 家在途、任何一家落定就补位；
    - 别的公司失败前已判的公司已写入，且等在途的都落定才抛错；
    - 按 id 顺序合并：后到的截断照样判为「连续两家」；
    - 时间盒用完时游标取最后开始的那家；
    - 时间盒加一次判定不超过活动超时；
    - 无法重放的公司不进「连续两次」，2 例；
    - 复审后补：一家慢判定后面有失败等着合并时不再补位（上游不可用、预算耗尽、流截断各 1 例）、被吸收后恢复补位、预算停下后的无法重放公司计为未判定，共 5 例。
    - 第二轮复审后补 7 例：预算耗尽合并后不再开始；第二家截断合并后不再开始；先到的停下不被后面的失败覆盖，并记日志；预算停下前落定的各类公司都计数；判定写不进去时活动失败；租约不够时由已开始公司的预算耗尽或 401 决定停下，2 例。另在「等在途都落定才抛错」一例里加断言：停下已合并、仍有一家在判时不抛错。
  - 改了前提的旧用例：两家截断时 3 家已同时在途；预算耗尽时其余调用同样被拒；租约中途用完时先开始的 3 家照常判完；上游等待装不下时按不变量断言。
  - `discovery.rehearsal.spec.ts`：fit 模型改为按模拟结束时刻先后落定的事件队列（后开始、先结束的先落定），故障编号取调用开始时的序号；新增 100 家的用例：同时在途的峰值恰为 3，fit 墙钟少于一家一家判总耗时的 45%（按 xin 实测耗时回放是 0.37–0.38）。
  - `discovery.rehearsal.spec.ts` 再补 3 例：上游对每次 fit 调用都断开时，3 家、6 家的 run 判 `PARTIAL`（一家未判、全部计入 `unreplayableSkips.fit`），9 家判 `FAILED`；每家只调用一次。
  - temporal、discovery 下全部通过。
- 未做：
  - 「查询阶段给 fit 预留时间」：产品负责人 10-21 定先不加，等 fit 并发上线后用真实 run 的数据再看。
  - 「一次 DENIED 之后核验报 EXHAUSTED，预算截断走不到 PARTIAL」另起 PR。
  - 信号阶段的租约检查和 `transportFailed` 统计，等同伴会话的信号修复合入后一起做。
  - fit 的操作键只由提示词派生、不含公司 id：两家提示词完全相同的公司同时在途时，后一家会遇到前一家仍在预留中的操作，记为无法重放（一家一家判时会重放前一家的结论）。xin 库里没有这样的两家，暂不改键。
  - 3 路同时预留让预算尾部需要的余量变成 3 × 40 美分，且一次 DENIED 就把账户永久标为耗尽；当前额度等于技术信封，碰不到。

## 2026-10-20 · Write a discovery run's outcome once, and record FAILED at finalize when its authority already ended (#670)

- 起因：`finalizeRun` 有两处缺陷。
  - 授权已结束（准入租约到期、被撤销或预算耗尽）时收尾 `DONE` 或 `PARTIAL`：attest 直接抛错，什么都没写入，工作流因收尾错误失败，run 一直停在 `RUNNING`。准入租约的落地设计（`docs/superpowers/plans/2026-10-09-discovery-run-admission-lease.md` §5）写的是「超出租约记 FAILED」，实际却从来没有记上。
  - 收尾结果已提交、但回执丢失后重试：会再更新一遍、计划版本再加 1，并再发一次 `DiscoveryRunCompleted` 和 `QualifyRequested`。
- 改动：只改 `apps/api/src/temporal/discovery.activities.ts` 里的活动，工作流不动，也不需要 patch。
  - 终态只写一次：
    - 库里已经是同一个终态时直接返回。这一步只读不写（短暂行锁），放在 attest 之前，所以授权到期后的重试也能成功。只对 v2 信封做，旧信封照旧由 `ensureRunBudget` 挂起。
    - 另一次尝试在本次预读之后、写锁之前提交了同一个终态时，同样算成功，即使授权恰在其间结束。
    - 请求 `DONE` / `PARTIAL` 而库里已是另一个终态时，抛不可重试的 `DISCOVERY_RUN_ALREADY_FINALIZED`。
    - `FAILED` 仍然只关闭 `RUNNING` 的 run。
  - 授权已结束时收尾 `DONE` / `PARTIAL`：
    - 在同一个写事务里改记 `FAILED`，`stats.failure = { stage: 'finalize', errorType, control: true }`。`errorType` 记结束原因的代码（到期、撤销、耗尽三者的处置不同）。
    - 其余 stats 保留，回执比对照旧；fit 判过公司时照常请求评分。
    - 之后以不可重试的原错误失败：工作流照样失败，但库里与它一致。回落的 `FAILED` 写入本身被拒时（例如回执不一致），抛出的仍是授权错误，回执错误放在 `cause` 里。
    - 只有这三种「已结束」会改记 `FAILED`；其余 attest 失败（范围不符、授权无效、核验不可用）照原样抛出，什么都不写。
  - `DiscoveryRunStage` 新增 `'finalize'`，并加入「已到 fit」的阶段集合。
  - `packages/contracts/INTEGRATION.md` 写明这种收尾结果。
- 测试：`discovery.activities.spec.ts` 先 RED 后 GREEN。
  - 授权已结束时把 `DONE` / `PARTIAL` 改记 `FAILED(stage=finalize)`：3 例，覆盖到期、撤销、耗尽。这条替换了原来锁定「什么都不写」的用例。
  - 已提交的重试：不 attest、不再写、不发事件，2 例。
  - 已是别的终态时拒绝：3 例。
  - 复审后补的 7 例：与另一次尝试重叠提交，授权有效、已结束各 1 例；其余 attest 失败照原样抛出，3 例；回落写入被拒时仍抛授权错误，1 例；旧信封即使库里已是同一终态也照旧挂起，1 例。其中修正行为对应的 6 例在修正前的实现上先确认为 RED。
  - temporal、discovery 下共 2306 例通过。
- 未做：
  - 没有加「卡在 `RUNNING` 的 run」的兜底清理器（通过 terminate 或执行超时停下的 run）。
  - 也没有改「授权结束后不花钱的收尾能否仍记 `DONE` / `PARTIAL`」这条口径；需要的话由产品负责人决定。
  - 租约感知的软截止另起 PR：让 run 在租约到期之前就以 `PARTIAL` 收尾，这样多半不会走到这里。

## 2026-10-20 · Stop discovery stages before the admission lease ends, so a long run finishes PARTIAL instead of FAILED (#672)

- 起因：发现 run 的准入租约是准入后 3 小时，过期后每次核验、每次预留都被拒，run 只能判 `FAILED`，计划也就白跑了。xin 上 14 条查询的计划约 139 分钟，24 条约 257 分钟；28 条查询的 run f92ea357 在 fit 阶段撞上租约，06:38 判 `FAILED`。产品负责人已定：不限计划大小、不延长租约，改为快到期时提前收工判 `PARTIAL`。
- 改动：
  - 新增 `apps/api/src/temporal/discovery-run-lease.ts`：
    - 活动在核验之后读一次剩余租约，口径与 `attest_authorized_tool_budget_v1` 相同：`COALESCE(admission_lease_expires_at, expires_at)`，按数据库时钟计，不含 60 秒容差。读法是只读 SELECT，app_user 在 RLS 下只看得到本工作区的授权。
    - 读不到恰好一行有限值时，按控制错误拒绝。
    - 不加迁移，不改 SQL 函数、binding 信封和 `BudgetStore`。
  - 查询、官网画像、fit、富集、监控注册五个阶段，每开始一条查询或一家公司前，先看剩余租约够不够在收尾预留（10 分钟）之前做完这一单位。单位按阶段取：查询 15 分钟、fit 10 分钟、画像 15 分钟、富集 2 分钟、监控 5 分钟。不够就停下，余下的计入结果的 `skippedForLease`（只在发生时出现），不交续跑游标。
  - 查询因租约停下时不路由、不做词表归一、不调 provider，照常落零回执，结果带 `skippedForLease: true`，不带 `skipReason`。重放的零回执若已过查询截止点，同样按租约跳过计；这时读租约失败，这次尝试按原错误失败、活动重试，与新执行的查询一样，不去猜标签（已启用的源按 BI-30 规则会被说成 `SOURCE_DISABLED`）；三次都失败时 run 在 query 阶段记 `FAILED`。
  - #666 的上游等待：新增 `upstreamUnavailableRetryDelayMs`（读 retryPolicy、封顶 3 次的逻辑不变）。租约装不下「等待 + 再做一个单位」时：
    - fit 和官网画像就地按租约停下，不再抛错；
    - 查询把下一次尝试推迟到刚过查询截止点，那次尝试以租约零回执结束。
    - 这修的是设计复审指出的阻塞问题：原方案在这种情况下会不等就重试，几秒内用完 3 次尝试，run 判 `FAILED`。
  - 工作流：
    - 各阶段的 `skippedForLease` 汇总成 `stats.skippedForLease`（按阶段，只列有跳过的阶段）；
    - `resolveRunStatus` 新增 `leaseSkips`，大于 0 时至少 `PARTIAL`，不单独判 `FAILED`；
    - 查询阶段因租约提前停下、且一条记录都没收到时判 `FAILED`（这次 run 什么都没找到；同一计划照旧不能再执行）；
    - 各阶段的跳过数在阶段之外累计，所以之后某个阶段失败、按 BI-25 记 `FAILED` 时，stats 仍带上失败之前各阶段的跳过数。
    - 富集只计还有数据源没读过的公司，已全部读过的不再算作被租约跳过（否则本应 DONE 的 run 会判 `PARTIAL`）。
    - 只读活动结果里新增的可选字段，旧历史没有这些字段，重放不变，不需要 `patched()`。
  - `worker.ts` 和 `dev-fast-lane-worker.ts` 接入 `runLease: prismaDiscoveryRunLeaseReader(prisma)`。没接时行为与以前一样。
  - `packages/contracts/INTEGRATION.md` 和 `docs/backend/discovery-sources.md` 写明口径。
- 测试：先 RED 后 GREEN，共新增 57 例，另加 1 例真库用例。
  - `web-crawler.spec.ts` 新增 2 例：两处读页请求都按 `CRAWL4AI_REQUEST_TIMEOUT_MS` 中止。
  - `discovery-run-lease.spec.ts` 16 例：租约计算；各阶段单位（含监控注册）与代理超时、网关上限、读页超时（`CRAWL4AI_REQUEST_TIMEOUT_MS`，本 PR 从 `web-crawler.ts` 导出）、HTTP 超时上限的防漂移；收尾预留覆盖不检查租约的三个活动；读取的 SQL 形状与失败即拒；等待装不装得下；查询下一次尝试的推迟量。
  - `upstream-unavailable-retry.spec.ts` 新增 3 例；原有用例（含防漂移）一行未改。
  - `discovery.activities.spec.ts` 新增 27 例，覆盖五个阶段：没余量就停、中途用完、等待装不下时就地停、有余量时结果形状不变；BI-30 跳过原因与重放的区分（含恰好够一条查询的边界）；重放时读租约失败改为重试；没有回执身份的旧历史不按租约停；词表归一遇上游不可用；富集不把已读完的公司计入、但计入还有数据源没读的公司。其中 13 例先确认为 RED（11 例在 main 上，2 例在复审前的 head 上），其余是「行为不变」或杀变异的守卫。
  - `workspace-authority.workflow.spec.ts` 新增 9 例：按阶段汇总、跨轮次累加、「没收到记录才判 `FAILED`」的边界（BI-30 跳过与有记录的丢失）、BI-25 失败收尾保留各阶段的租约计数、没跳过时保持 `DONE` 和原 stats 形状。其中 8 例先确认为 RED（5 例在 main 上，3 例在复审前的 head 上）。
  - 三轮复审指出的非等价存活变异现在都被杀死（第一轮 5 个，第二轮 2 个，第三轮 2 个；第二轮另一个出在警告日志上，那条日志已删掉），各轮新规则的变异也都被杀死。
  - `worker-dev-fast-lane.source.spec.ts` 断言 managed worker 接了 `runLease`（两处一致由既有断言保证）。
  - `discovery-run-admission-lease.postgres.spec.ts` 新增 1 例真库用例：以 app_user 读剩余租约约为 3 小时、随行老化同步减少、没有租约的行回退到授权窗口、别的工作区读不到。本机没有 `*_test` 库，由 CI 跑。
  - temporal、discovery 下全部通过。
- 未做：
  - 信号阶段（`enrichSignalsRun`）暂未接入：同伴会话正在修这个阶段，等它合入后再补那几行。在那之前，它开始时剩余租约通常约 20 分钟，最少只剩 10 分钟收尾预留；按 xin 实测每家约 30 秒，12 家约 6–12 分钟，所以剩余偏少时仍可能越过租约，那时 run 记 `FAILED`。
  - 画像比 fit 先停，fit 可能判几家没有画像证据的公司；联系路径补读打开时会在 fit 之前用掉租约（开关目前停用）。两者都写进了 INTEGRATION.md。
  - fit 并发 3 另起 PR，同时处理并发下的「已落定前缀」游标、时间盒和重放丢失的计数。
  - 查询阶段没有给 fit 预留时间：计划很大时，查询可能用到截止点，fit 一家都判不了，run 以零判定的 `PARTIAL` 收尾。要不要给 fit 预留时间，由产品负责人定。
  - 被跳过的公司不会补判：`qualifyFitBacklog` 目前停用（`authorityHold`），`stats.skippedForBudget` 的公司同样如此。
  - 「一次 DENIED 之后核验报 EXHAUSTED，预算截断走不到 PARTIAL」（#669 片段里提到的问题）不在本 PR 范围内，另起 PR。

## 2026-10-19 · Renew the production dependency audit baseline before it expires on 2026-10-24 (#664)

- 起因：生产依赖漏洞基线 2026-10-24T13:59:34Z 到期。到期后改了依赖输入的 PR 的 `production dependency delta · canary` 和 main 的 freshness canary 都会失败（依赖输入未变的 PR 不读基线，照常通过），所以要在到期前续期。
- 改动：
  - 锁文件自 10-10 月度刷新（#624）以来没有变动，按 [依赖刷新 runbook](../backend/dependency-refresh.md) §4 只做到期续期：基线改绑到当时的 main 提交 `6f95c44e`，`valid_until` 延至 2026-11-02T11:27:18Z。
  - `scripts/supply-chain-gates.spec.mjs` 同步钉住的基线提交与 `REPOSITORY_BASELINE_NOW`。
  - 新增 [冻结证据](../evidence/security/20261019-baseline-renewal.json)，[安全门](../security/README.md) 与证据索引各加一条记录。
  - [依赖刷新 runbook](../backend/dependency-refresh.md) 改正两处：§2 原写「过期后所有 PR 都失败，包括续期 PR 自身」，实际上依赖输入未变的 PR 判为 `IDENTICAL_TO_TRUSTED_BASE`、不读基线；§4 到期续期的先例原写 #542，它其实是锁文件变动后的重新绑定、没有延长有效期，改为 #624 与本次。
- 测试：官方 registry 生产审计零 advisory（831 个依赖），`supply-chain-audit.mjs verify` 为 `PASS_CLEAR`，新旧绑定下的 `baseline-freshness` 都是 `FRESH`；直接调用 `evaluateProductionAuditBaselineFreshness` 投影，旧基线在 10-24T13:59:33.999Z 还是 `FRESH`、13:59:34.000Z 起 `BASELINE_EXPIRED`，新基线到 11-02T11:27:18Z 前保持 `FRESH`；含开发依赖的全量审计只有 main 上已开的两条开发告警（Dependabot #80、#118），没有新增；`supply-chain-gates.spec.mjs` 27/27 通过。
- 未做：不升级任何依赖，11 月的月度批量刷新另行立项，须在 11-02 前合入或再续期一次。`baseline-freshness` 命令行的 `--observed-at` 只写进回执、不参与有效期判断，这次没有改。

## 2026-10-19 · Hold a lead whose stored sanctions hit is not cleared, as accept and export already do (#665)

- 起因：qualify 的 sanctions_hold 只看这次的 live 筛查，accept 与周报导出却同时按库里的命中硬拦（复审 #1 的跨进程兜底）。一家公司的命中消失后（名单移除了实体、匹配规则修正了误报，或索引未生效），lead 停在推荐队列，却永远 accept 不了、也导出不了，原因在队列里看不出来。
- 改动：
  - 新增共用的 `storedScreeningBlocks`（库里的 potential_match 未被人工清白就拦），accept（`decide`）、周报导出与 qualify 三处都用它，不再各算各的。
  - qualify 先对整批公司算完筛查，再用一次查询读出其中「这次没有命中」的公司在库里的命中；未清白（open 或 confirmed_true_hit）的，lead 进 sanctions_hold。open 的由人在复核端点清白，confirmed_true_hit 不能经端点清白、一直隔离。这次有命中的公司走原来的 reconcile 与 upsert，不变。
  - qualify 不新建、不改写任何筛查记录：命中只由人关闭。第一版改成「live 无命中就把旧命中改写为 clear」，对抗复审证实两条误放路径：单独停用一个名单源时，「索引生效」只代表至少一个源有数据，只命中那个源的 open 命中会被清掉；复核人确认真命中与改写并发时，确认会落在一条已是 clear 的记录上。因此改为现在的 fail-closed 做法。
  - 设计决策⑤（种子 DISABLED、未启用时门不拦）有一处收紧：库里已有的未清白命中照样让 lead 进 sanctions_hold，与 accept 早已在做的一致。[制裁筛查设计](sanctions-screening-design.md) 顶部加了 as-built 注记，[运维刷新手册](../backend/sanctions-operator-refresh.md) 的 kill switch 一节写明关掉只停止新的筛查。
- 测试：新增共用真值表 `sanctions-gate.test-fixture.ts`（这次 live 命中已清实体 / 命中新实体 / clear / not_screened × 库里无 / open / 已清白 / 已确认，共 16 格），qualify、accept（`decide`）、导出（`sanctionsDelivery`）三处的 spec 都跑这张表，三处给出同一个答案；qualify 另加混批用例（每家用自己的名称与国家筛查）。复审指出 accept 硬门此前没有任何测试（把 priorBlocking 或 liveBlocking 改成 false 照样全绿），现在这两个变异分别有 4 例、3 例失败，混批的两个变异（全批用第一家的筛查、丢掉国家）也各有用例失败。`storedScreeningBlocks` 4 例；`qualify.activities.spec.ts` 新增 9 例（open/confirmed × clear/not_screened 均 hold 且不写记录、已清白不 hold、无库存命中不 hold、未接筛查服务也按库存 hold、一批多家只 hold 有命中的那家、有命中照旧 upsert）；新增 `lead.service.sanctions-review.spec.ts` 2 例（清白回落 needs_review、确认的真命中不可清白）。先 RED（10 例失败）后 GREEN。真实数据：xin 上 8 条记录都是人工清白的误报，用本分支的匹配器对真实名单（12268 个实体）重筛仍全部命中且已清白，所以这次部署不改变任何现有 lead 的队列。
- 未做：命中消失后的**自动关闭**（无人复核就放行）没有做。真要做，需要产品负责人拍板，并且至少要有三样东西：名单覆盖与版本单调的守卫、复核端点的条件写，以及带旧命中的审计事件。

## 2026-10-19 · Wait minutes, not seconds, before retrying a discovery stage the model upstream could not answer, and never report DONE after a cut-short website profile (#666)

- 起因：RL1 验收 run `097593b7`（xin，2026-10-19 11:33–12:03 UTC）跑完 14 条查询中的 9 条、已接受 45 条原始记录；12:03 openox 先回 521、再回 523，约 28 分钟后恢复。public_web 挖一个域名时模型调用失败，executeQuery 的 3 次尝试按默认退避（1 秒、2 秒）全部挤在 6 秒内（12:03:19 → :21 → :25），run 按 #653 判 `FAILED` 停在 query，物化没跑，45 条记录产出 0 家公司、0 条线索。同日 `f3439b0f` 跑完 24 条中的 16 条、92 条通过后，13:47 openox 回 503，3 次尝试 24 秒内用完，结局相同。预算账本早已按 D13 退回每次失败的预留，等待本来不花钱，只是没人等。
- 改动：
  - 新增 `apps/api/src/temporal/upstream-unavailable-retry.ts`：对 `definiteModelFailureCode` 判定的确定失败，活动抛出带 `nextRetryDelay` 的可重试 `ApplicationFailure`；其余错误原样抛出（504/524 超时、4xx、截断流、控制错误、无法重放的操作），行为不变。等待按活动自己的重试策略算：最后一次重试前等 25 分钟，更早的等 5 分钟；次数取重试策略的 `maximumAttempts`，并以账本上限 3 封顶（策略没报上来时也按 3）。所以 3 次尝试的查询与 fit 等 5 + 25 分钟，2 次尝试的官网画像等 25 分钟，都远在发现 run 3 小时准入租约之内。
  - `discovery.activities.ts` 的四处重抛改用它：executeQuery 的数据源控制错误、executeQuery 词表归一没被吸收的错误（5xx 照旧降级为内置词表；429 与网关拒绝连接原来 3 秒内用完 3 次尝试）、qualifyFitForRun 停止 fit 的错误、profileWebsitesForRun 的控制错误。workflow 的重试策略与尝试次数都没改。
  - 官网画像阶段因非控制错误提前结束（workflow 吞掉失败、fit 照常判定余下公司）时，run 不再报 `DONE`：`resolveRunStatus` 新增 `profileStageFailed`，至少判 `PARTIAL`，`stats.websiteProfile.stageFailed = true`（只在发生时出现）。原来画像被腰斩时 run 照样报 DONE；fit 现在会等上游恢复，这种情况更容易出现，所以一起修。`workspace-authority.workflow.spec.ts` 里锁住旧行为（后一批画像失败仍 DONE）的用例相应改为 PARTIAL。
  - 开发快速通道的发现 run 执行超时 185 → 215 分钟（3 小时租约 + 最长 30 分钟等待 + 5 分钟收尾），免得 run 在等待中被整个 workflow 超时、停在 RUNNING 不收尾。环境一致性指纹不受影响（`environment-parity-policy.mjs` 通过）。
  - 文档：`packages/contracts/INTEGRATION.md` 的 run 状态补上 `FAILED`；写明模型上游不可用会让整条查询失败（不是只跳过那个域名），等待间隔，画像阶段提前结束判 PARTIAL；更正「计划保持 READY 可以重跑」：同一计划再执行会得到 409 `EXECUTION_BUDGET_GRANT_REUSED`（xin 2026-10-19 实测）。`docs/backend/dev-fast-lane.md` 同步新超时。
- 测试：
  - 先 RED 后 GREEN。新增 `upstream-unavailable-retry.spec.ts`，共 28 例：
    - 7 种确定失败转成带等待的可重试失败，8 种其他错误原样返回；
    - 按重试策略读 attempt 与 maximumAttempts，6 种组合，含封顶与没有策略；
    - 入参不被修改；
    - 仓库失败转换器序列化后保留 `nextRetryDelay`（300 秒），其余字段与不加等待时相同；
    - 用尽尝试后 `describeDiscoveryRunFailure` 仍是 `{stage:'query', errorType:'ProviderHttpError', control:false}`；
    - 防漂移：查询与 fit 的尝试次数等于 `durable-result-strategies.json` 的 `maxReservationAttempts`，画像不超过它，等待合计 30 / 25 分钟。
  - `discovery.activities.spec.ts` 新增 8 例：
    - executeQuery 遇 521 抛带等待的失败；词表归一遇 429 同样等待、不调 provider；
    - 网关拒绝连接（Node 系统错误形状）同样等待；
    - 504 仍原样立即失败；
    - fit 遇 523 等待、遇 401 立即失败；
    - 画像遇 521 在第一家就停下并等待；
    - `resolveRunStatus` 遇 `profileStageFailed` 判 PARTIAL。
  - `discovery.rehearsal.spec.ts` 新增 1 例：一次上游故障覆盖画像的两次尝试、fit 时已恢复，run 判 PARTIAL 并带 `stageFailed`。
  - `temporal/` 下 66 个文件 1012 例全绿；`dev-fast-lane` 两个 spec 21 例全绿。
  - 合并前在 dev Temporal Server 1.31.2（与原生 platform 同版本）实测：活动第 1 次抛带 `nextRetryDelay: '5 minutes'` 的失败后，服务端把第 2 次尝试排在正好 300 秒后，没有被默认 `maximumInterval`（100 秒）截断。
- 未做：
  - 不扛超过约半小时的上游故障：13:47 那次 openox 故障持续约 2 小时 15 分钟，修复后照样会以 FAILED 停下。要扛就得接备用上游（PRD4-D14），产品负责人 10-19 决定暂不接。
  - 连到网关超时（undici `UND_ERR_CONNECT_TIMEOUT`）在 public_web 和 fit 里仍按单个域名、单家公司的失败跳过，不会走到等待：这两处只把控制错误往上抛，没改。在 xin 上网关是 `127.0.0.1:3001`，它挂掉时是连接被拒绝，会走到等待。
  - 一次尝试里已经发出、却没留下持久结果的调用（截断流等），重试时仍无法重放，这条查询仍按 #643 以零回执结束、计为失败：等待帮不了这种情况。
  - 等待不看准入租约还剩多少：租约快到期时又遇上故障，等过之后下一次尝试以 `EXECUTION_BUDGET_GRANT_EXPIRED`（控制错误）失败，不等则以 `ProviderHttpError` 失败，两者都是 FAILED，只是失败分类与耗时不同。让等待感知租约要让活动拿到 `admission_lease_expires_at`，与 reserve() 把租约到期映射成授权错误、收尾窗口一起另开任务。另：24 条查询的计划不靠任何等待也可能跑不完 3 小时租约，这是计划规模的既有问题。运维对活动执行 unpause、update-options 或 reset 时，服务端按退避重算调度，会忽略 `nextRetryDelay`。
  - 没有改成「一条查询失败时 run 判 PARTIAL、物化已成功查询的记录」：这要动物化准入「每条计划查询一份回执」的完整性不变量（#653 的理由），需要产品负责人拍板。

## 2026-10-19 · Close the open documentation findings left by the reviews of #651, #658 and #659 (#667)

- 起因：#651（2026-10 决定回写）、#658（changelog 片段）、#659（擦除全部对象版本）的独立复审留下一条 MEDIUM 和若干 LOW / NIT 文档问题，合入时没有修。逐条在 main `73f7749a` 上核对后，19 处仍然成立。
- 改动：
  - ADR registry「PRD 4.0 决定」表的「落地」列只留 PR 号，运行事实（schedule 暂停、开关状态、上线日期、行数、PR 是否已合并）只在 [当前状态](../status/current.md) 写一处；BI14 行原写 #649「在途、未合并」，它已于 10-15 合并。
  - 冲突登记 §11.1 的状态口径照抄 §1 原文；`PRD4-D16` 改为 `RESOLVED_WITH_REMEDIATION`（PRD 4.0 L0/L2 的红线还待同步）。
  - 发布计划：评分是确定性计算、不调用模型（模型调用在 ICP 资格门的 fit 判定）；X 减负线注明各项待定的决定。
  - 当前状态：备份时间戳改为 08:33 UTC（xin 本地时区 CDT）；补上 #650、#652 的去向；注明 xin 上 `trade_fair` 实际为 DISABLED；`D-029` 的编号来源。
  - AGENTS §6 的出网例外补全为五类（robots.txt、DNS、模型网关、outbox webhook，以及制裁名单运营刷新）。
  - 擦除存储文档第 5 节：运行时 principal 的列出授权也改了条件，旧镜像影响与回退的说法改正；片段 README 写明改名片段时必须手填 `pr:`。
- 测试：`pnpm docs:verify` 通过（0 错误，1 条原有警告）。每处改动起草时都核对了代码或只读查询，另由一个独立核查逐条复核，其中 3 处按核查意见改写。
- 未做：#659 复审里的两条测试代码 NIT（MinIO spec 的 `denied()` 接受任何 403；部署合同没有禁止其他无限定条件运算符）不属于文档，另行处理。当前状态页里其他已过时的段落（在途表各行的 OPEN 状态等）留给下一次整页核验。

## 2026-10-19 · Whitelist the condition operators a MinIO policy may put on s3:prefix (#668)

- 起因：#659 把两条 `s3:ListBucketVersions` 授权改成 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`，因为 MinIO 对重复的 prefix 参数，只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出。部署合同 spec 只用正则禁止了普通 `"StringLike"`，复审 NIT-3 指出 `StringEquals`、`StringNotLike`、`ForAnyValue:*` 同样只看任一值，却没有被禁。
- 改动：`scripts/runtime-deployment-contract.spec.mjs` 不再解析 bootstrap.sh 的文本，而是在沙箱里真实执行它，用一个假 mc 截获 MinIO 实际会收到的调用和策略。
  - 尽量贴近 minio-bootstrap 容器：
    - 环境变量用 compose 默认值，并补上 `HOSTNAME`、`HOME`；
    - PATH 里只放钉版 mc 镜像实际自带的工具（cat、tr、id、mktemp、paste）；
    - stdin 关闭；
    - dash 和以 sh 名义调用的 bash 各跑一遍（镜像的 /bin/sh 是 bash）；
    - 首次部署和重复部署（桶已存在）也各跑一遍；
    - `/config`、`/tmp` 按完整路径词改写到沙箱。
  - 假 mc 只应答一次正常 provisioning 会发出的调用，其余一律记为「被拒」并以 97 退出，所以 `mc … || true` 也藏不住一条新命令。
  - 断言：
    - 没有被拒的调用，stderr 为空；
    - 完整、未经过滤的 mc 调用序列逐条等于预期；
    - 四种跑法得到的策略完全相同；
    - 每个策略名收到的都是一份 JSON，顶层键恰好是 `Version` 和 `Statement`（MinIO 解析键名不分大小写，`statement` 能盖掉 `Statement`）；
    - 三份策略都过白名单：「列出授权」按 MinIO 允许带 `s3:prefix` 的动作（`s3:ListBucket`、`s3:ListBucketVersions`）用 `*` / `?` 通配判定；语句只能是 Allow + Action（+ Resource、Condition）；`s3:prefix` 只能出现在 `ForAllValues:StringLike` 或 `Null`（值为 `"false"`）下；
    - runtime 与 cleanup 的列出授权按名称逐字比对，personal-read 没有列出授权。
  - 威胁模型：只防误改，以及看起来像正常改动的改动，不防蓄意绕过。用绝对路径 `/usr/bin/mc` 调用、或按只在镜像里存在的东西分支，仍然测不出来；要彻底拦住，需要在钉版 mc 镜像里跑截获。
- 测试：当前 bootstrap.sh 下 18/18 通过，四种跑法都真实跑到 `OBJECT_STORAGE_PROVISIONED`。三轮独立复审找到的 42 种写法逐一回放，41 种被拦下：
  - 第一、二轮的 31 种：通配动作、NotAction、shell 展开与转义、换写法或重复写入、`statement` 大小写变体、缩进 / 续行 / `command mc` / 双空格、if 块里的文件路径、对调 create 参数、heredoc 之后改写、附加策略、`mc anonymous set`、EOF 注入、注释诱饵；
  - 第三轮的 11 种：`mc --quiet … || true`、`mc --json … || true`、只在重复部署时走的分支、`[[ … ]]` 与 `$BASH_VERSION`、`$HOSTNAME`、compose 默认值、镜像里没有 jq、删掉 stdin 重定向（不再挂死）、`[ -d /config ]`；
  - 剩下的 1 种是用绝对路径调用 `/usr/bin/mc`，按威胁模型如实保留。
- 未做：没有在钉版 mc 镜像里跑截获（那样能把绝对路径调用一起拦住）；同文件里的旧测试往宿主机固定的 /tmp 路径写文件、并发时会互相干扰，这也没修（复审 LOW-3，早就存在）。没有用 MinIO 自己的解析器做差分（复审用 minio/pkg 的 Go 探针核过通配匹配与 PREFIX_ACTIONS，0 处不一致）。#659 复审的 NIT-2（真 MinIO spec 的 `denied()` 只要 403 就算被拒）和「把真 MinIO spec 放进 CI」一起做，这样收紧后的断言每次都在真 MinIO 上验证。

## 2026-10-19 · Map an authority refusal raised inside reserve to the same contract error as attest (#669)

- 起因：准入之后，租约、撤销和作用域只在 `attest_authorized_tool_budget_v1` 里检查。它有两个入口：直接调用（`attestAuthorized`，已映射），以及在 `reserve_tool_budget` 内部调用（未映射）。第二个入口的标记以原始 `PrismaClientKnownRequestError` 冒出 `PostgresBudgetStore.reserve`，造成三个后果：
  - 工作流把它记成 `{ errorType: 'PrismaClientKnownRequestError', control: false }`，看起来像数据库故障；
  - 工作流层的尽力而为阶段（画像、signals）会把它吞掉，失败被记到下一个阶段（所有阶段开头都会 attest，所以 run 照样 FAILED，只是阶段记错）；
  - HTTP 返回 500，而不是契约声明的 402 / 403。另外，ICP 查询计划的 TED / FDA 注入用的本地分类器认不出这个错误，会把撤销吞掉、照样落库并返回 201。
  xin 上还没有出现过（13 个 FAILED run 里没有这种 errorType），#666 的重试等待让最后一次尝试跨过租约的可能变大。
- 改动：
  - `execution-budget-authority.repository.ts` 新增 `trustedExecutionBudgetGrantError`。它只认精确的可信标记（P2010、SQLSTATE P0001、消息恰为 `ERROR: <code>`），其余返回 undefined；`mapExecutionBudgetPersistenceError` 改用它，行为不变。
  - `PostgresBudgetStore.reserve` 的 catch 按这个顺序判断：LIFECYCLE 映射照旧；可信授权标记映射成 `ExecutionBudgetGrantError`；ACCOUNT_UNAVAILABLE 照旧；其余数据库错误原样抛出。经 reserve 实际可达的只有 INVALID、EXPIRED、REVOKED、SCOPE_MISMATCH 四个：attest 不抛 REUSED；账户耗尽时，reserve 在 attest 之前就返回 DENIED（`BudgetExceededError`）。SCOPE_MISMATCH 与 `attestAuthorized` 保持一致，同样映射成 403；它只来自主体配置错误或数据完整性错误，在受管运行时里走不到。settle、release、status、close 不在这次范围内。
  - ICP 本地分类器不用改：它按 `EXECUTION_BUDGET_` 前缀判断，映射后的错误能被识别。
- 测试：
  - `budget-store.spec.ts`：6 个标记映射，先 RED 后 GREEN；7 种不得映射的错误必须原样抛出（死锁、INVARIANT 标记、带后缀的标记、别的 SQLSTATE 下的同样文字、其他 Prisma 码、事务超时、普通 Error 带标记文字）；LIFECYCLE 与 ACCOUNT_UNAVAILABLE 照旧。
  - 新增 `reserve-authority-failure.spec.ts`：把 reserve 抛出的错误经 `ensureApplicationFailure`、仓库的失败转换器和工作流解码，`describeDiscoveryRunFailure` 得到 `{ errorType: 'ExecutionBudgetGrantError', control: true }`；换回 main 的 store 会得到 `control: false`。
  - CI 真库 spec：两处原来断言「reserve 抛原始标记」的地方，改为断言映射后的错误；补上撤销后 reserve 得 REVOKED 的用例；账户耗尽之后再 reserve 一次，断言仍是 `BudgetExceededError`，把「reserve 先查耗尽、再 attest」这一 SQL 时序锁住，否则 fit 的 skippedForBudget 会悄悄失效。
- 未做：
  - 同一原因在 errorType 上会有两种写法：10-09 批量收口的 733fbf03 写的是 `EXECUTION_BUDGET_GRANT_EXPIRED`，之后的新失败是 `ExecutionBudgetGrantError`。按 errorType 分组的看板要两个都认。
  - 平台 scope 的 sweep（intent、acquisition）以前会按单个源吞掉这类失败，现在会让整次 sweep 停下。4 个平台 schedule 都暂停着，暂无影响。
  - 收尾窗口与租约感知的软截止另起 PR。
  - provider 层还有几处裸 catch，会在活动内部吞掉控制错误（复审 LOW，既有问题），另起 PR 处理。
  - 既有问题（复审 INFO）：一次 DENIED 之后，后续每个活动开头的 attest 都会报 EXHAUSTED，所以对带授权的 run 来说，「预算截断 → PARTIAL」实际走不到，最终以 FAILED 收尾。这一点和租约感知软截止一起处理。

## 2026-10-15 · Say why stream failures still settle after the new-api first-byte fix went live

- 起因：#652 收窄时，把「流在首个输出之前失败不释放预留」写成了暂缓措施，理由是现役 new-api 会对它回 HTTP 200 并按估算输入 token 计费，要等 mlhjyx/new-api#3 上线后再加回。W12 已于 2026-10-15 上线（new-api 6ea085c6，镜像由 #661 钉住）：首字节之前的失败现在由 new-api 回可重试的 HTTP 502、不计费，backend 的分类器本来就把 502 当作确定失败释放。
- 改动：只改文字，代码行为不变。
  - 流式失败仍然不释放，`execution-authority-policy.mjs` 的反向检查也保留。理由改为：以流式失败到达 backend 的，都发生在首字节之后，可能已计费；即使 new-api 回退到旧镜像，照旧结算也不会少记。
  - 同步修改的地方：`definite-model-failure.ts`、`settled-model-failure.ts` 的说明，两个 spec 的注释，策略报错文字，AGENTS §8，执行预算设计文档。
- 测试：execution-authority-policy PASS；治理 spec 29 项、网关 / 处置合同 / discovery 单测 1351 项通过；Copy 回执 UNCHANGED；受保护文件没有改动。
- 未做：首字节之前失败的对账日志 `NEWAPI_FIRST_BYTE_UNBILLED` 还没有真实触发的记录（openox 仍在返回 503，那是 HTTP 错误，不是断流），恢复后由运行时会话核对。

## 2026-10-15 · Pin the new-api rc.44 fork release (first-byte failures retried and unbilled)

- 起因：xin 的 new-api 停在上游 rc.21 与 rc.22 之间（`bde9b2f4` + 结算回读 `d14d3e1c`），流式请求在首字节前失败时回 200 并按估算输入 token 计费（10 月 6 次、约 0.28 美元），也不会换渠道重试。mlhjyx/new-api#4（W12，评审会话实施、独立复审 MERGE）同步上游 `v1.0.0-rc.44` 并移植首字节前失败的处理：回可重试 502、不计费、记 `NEWAPI_FIRST_BYTE_UNBILLED` 供与 openox 对账。
- 改动：`docker-compose.yml` 的 new-api 镜像改钉 `ghcr.io/mlhjyx/new-api@sha256:79850cd2…`。来源：new-api#4 以 merge commit 合入 `production-parity/settlement-readback-v1` 得 `6ea085c6`，发布 run `38768715010`（`growthos-new-api-release.yml`：准入、gitleaks、许可证核验、源码 release、构建、cosign、SBOM 与构建来源证明 `56345581`、`56345639`）；本地拉取核对 revision 标签 = `6ea085c6`、运行用户 65532。许可证（node-forge 选 BSD-3-Clause）由产品负责人确认。
- 上线（运行时会话，按 new-api#4 的上线步骤）：先停 new-api 再成对备份 `one-api.db` 与 `pepper.keyring`（新版启用 SQLite WAL）→ 重建 new-api → 重建 worker（RUNBOOK §10）→ 核对 RetryTimes、可重试状态码、`GODEBUG=http2client=0`、结算回读 capability。回退：换回旧 digest `b72f2290…`，重建 new-api 与 worker；旧版能直接打开迁移后的库。
- 未做：#652 执行授权策略里「判定模块不得引用流式失败」的反向检查仍然成立——上线后首字节前失败以 HTTP 502 到达 backend，已按确定失败释放；还能以流式失败形式到达的只剩首字节后断流，上游已计费、不该释放——评审会话随第二班车只改其说明文字。Site Builder 的两个脚本用旧 admin access token，新版首启 30 天后停用，需改用作用域令牌。

## 2026-10-15 · Stop a sanctions hit whose only shared word is a leading Russian legal form (a company named "FSE" matched every "FSE …" entity)

- 起因：第一班车上线后，对 3 个 ACTIVE ICP 重评，每个 ICP 都有 8 家公司进 `sanctions_hold`，共 19 条命中，全部是误报（运行时会话核对，样本只含公开的机构信息）。其中 6 条来自德国公司「FSE」：EU/OFAC 名单里一串以「FSE」开头的实体，例如 `FSE Kamensky Zavod`、强别名 `FSE AHK`。这里的 FSE 是俄式法律形式 Federal State Enterprise（联邦国有企业），和 GmbH、LLC 一样不是身份，但 `normForMatch` 不认识它，于是它成了两边唯一相同的词。
- 改动（`sanctions-matcher.ts`）：
  - `prepareName` 只用于名单实体一侧。它现在额外给出 `coreTokens`，也就是剥掉名字**开头**的俄式和独联体法律形式之后的词：FSE、FSUE、FGUP、GUP、OOO、OAO、ZAO、PAO、AO、JSC、OJSC、PJSC、CJSC，只收两份名单里实际以开头形式出现过的。名字全由法律形式组成时（如 `FSE AO`），核心取完整词集，命中与 main 相同。
  - `screenName` 判主名、强别名、弱别名时，先要求查询和该名字的 `coreTokens` 至少共享 1 个词，**分数照旧按完整 token 算**。效果是只去掉「唯一重合是法律形式」的命中；其余命中的分数和改动前逐字相同，也不新增候选。
  - 被替换的初版（同一 PR 的首个提交）直接剥掉了实体一侧计分用的 token。独立复审指出这会造成召回回退：`Kalashnikov JSC` 对 `JSC KALASHNIKOV CONCERN`、`OJSC Belavia`、`OOO Volga` 这类两边都带法律形式的真命中会漏掉，按公开名单模拟，OFAC 有 748 个场景由命中变成漏掉。同时，剥完只剩一个词的实体会凭空多出候选。现在的门槛做法这两个问题都没有。
  - 查询一侧（我方公司名）不剥。末尾的「… Company (FSE)」这类缩写不在开头，不受影响，照旧交人审。
- 测试：
  - 单测 12 项，覆盖：FSE 主名和强别名不再命中；多个法律形式连在一起；复审给出的 4 组两侧都带法律形式的真命中保留且分数不变；不新增候选；末尾缩写仍是候选；只有法律形式时核心至少留 1 个词；查询侧不剥。在 main 的实现上，其中 4 项红。sanctions、lead、report、qualify 的单测全部通过。
  - 用公开名单回放（OFAC SDN 全量 + EU FSF 截断版，共 11,530 个实体）：对以法律形式开头的名字生成「法律形式 + 核心首词」等 8,780 个查询，原来命中的 8,140 个全部保留，新增 0 个。消失的 9 个场景，查询本身全是法律形式（如 `ao`、`jsc`），正是要去掉的那一类。公司「FSE」的命中从 6 条降到 1 条。
- 未做：其余 14 条只有一个词重合的弱匹配（WAVE、LK、OPUS、Hermes、Homa、AURUM、Sunny Trade，以及末尾带 (FSE) 缩写的那条）照旧是候选。产品负责人 2026-10-15 选定不改匹配规则、保持「召回优先」，8 家公司的命中由产品负责人判为误报，交运行时会话通过 `POST /leads/:id/sanctions-review` 标为 `cleared_false_positive`。之后重新筛查时，只要没有冒出新的实体，已解除的状态会保留。「单词重合且双方国家都已知、但不相同就不卡」这条规则经评估没有采用。

## 2026-10-15 · Repair the stale artifact-subject RLS spec and run it in CI

- 起因：`packages/db/test/generic-operation-artifact-subject.rls.spec.mjs`（PERSONAL_DATA 产物按主体建索引、DSR tombstone 阻止再物化、app_user 不能直读或改写索引，共 10 项）不在任何 CI 步骤里，没人发现它早已跑不起来：在只含 main 迁移的库上，before 钩子以 `GENERIC_OPERATION_ARTIFACT_INVALID` 失败，10 项全部取消（#654 的实施工作流在一次性库上发现）。
- 根因是夹具落后于两次迁移，不是被测的 SQL 有缺陷：
  - `20260901060000_generic_operation_artifact_privacy_prefix` 起，最终对象键带隐私类前缀（`…/v1/final/<privacy>/sha256/…`），`assert_generic_operation_artifact_manifest_v2` 拒绝其他形式；夹具还在拼旧键。
  - `generic_operation_artifact_personal_version_guard`（延迟约束触发器）要求 PERSONAL_DATA 对象在事务提交前钉上对象版本；夹具用不带版本的 `settle_…_v2`，并直接 `append_…_v3` 写个人数据，提交时报 `GENERIC_OPERATION_ARTIFACT_OBJECT_VERSION_REQUIRED`。
- 改动（只动测试与 CI）：
  - 对象键按 `contentAddressedObjectKey` 的规则带隐私类前缀；
  - 个人数据一律走运行时实际使用的 `settle_tool_budget_artifact_manifest_with_receipt_v4`，带对象版本；非个人数据仍用 `append_…_v3`。专门验证「旧函数被拒」的用例保持原样。
  - CI 新增步骤「Generic operation artifact subject RLS on PostgreSQL」：在同一个 Postgres 服务里另建 `global_artifact_subject_test` 库（用例写固定 id、保留数据行，不能与其他步骤共库），用例自己部署全部迁移后运行。
- 测试：
  - 修复前 0/10（before 钩子失败、10 项取消），修复后 10/10。
  - 所有拒绝断言都钉具体错误标记（`permission denied`、`…_SUBJECT_TOMBSTONED`、`…_SUBJECT_INVALID`），新的版本守卫不会让它们误过。
  - 变异检验：禁用 `generic_operation_artifact_personal_subject_guard` 后，「v2 append 绕过」与「ACK_UNKNOWN 恢复冻结主体」两项变红，失败原因是「没有被拒」（日志里 0 次 `OBJECT_VERSION_REQUIRED`）。
  - 独立复审 LOW：这两项的裸 append 原本会被两个延迟触发器（主体守卫、版本守卫）同时拒绝，命中 `SUBJECT_INVALID` 只是因为 PostgreSQL 按触发器名字顺序执行。现在先经运行时结算写入同字节的承载产物、钉住对象版本，再做裸 append，只剩主体守卫能拒绝，不再依赖触发器命名。
  - 按 CI 步骤的命令在一次性 pgvector/pg16 上模拟：主库已迁移、另建库、运行用例，退出码 0。
- 未做：`packages/db/test` 里其余不在 CI 的用例没有逐个核查；#654 合入后可在本用例补 `company_profile` 主体的 tombstone 覆盖。

## 2026-10-15 · Accept a direct changelog edit only from a branch cut before the fragment rule (#663)

- 起因：#658 的过渡放行写成了「直接改 `changelog.md` 也算满足」，并且对任何 PR 都放行、没有终点，只能等仓外指令改掉。修复增量复审回放了 main 最近 40 个合入：36 个只改 `changelog.md`，规则实际上只剩一条 warning。复审建议按分支切出的位置放行：不看时钟，不写死 SHA，结果可复现，过渡会自然结束。第一版只看合并基点，二轮复审发现旧分支一旦 merge 进 main，合并基点就变成带 README 的 main，放行随之丢失，报错还说它是规则合入后切出的；唯一在途的旧分支（草稿，与 main 冲突）合入前必须先并入 main，正好会踩到。
- 改动：
  - `scripts/governance-changelog-fragments.mjs`：新增 `branchPredatesFragmentRule`。它用 `rev-list --boundary base..head` 找出分支离开 base 的所有分叉点，只要有一个分叉点里没有片段 README，就算规则合入前切出的分支。merge 进 main 后原来的分叉点还在（不论 merge 时谁是第一个父提交），放行保留；rebase 会把分叉点挪到新 main，之后只能写片段。分叉点找不到（无关或浅历史）或目录树读不出时失败，不放行；读树改用 `ls-tree`，路径缺失与读取出错不再混为一谈。`fragmentRequirement` 新增 `changelogEditAccepted` 参数，默认不放行。`require` 只对旧分支放行直接改 `changelog.md`（附 warning）；之后切出或 rebase 过的分支这样做会失败，报错提示把条目挪进片段。
  - 片段 README 与 `CONTRIBUTING.md` 的「过渡」改为按分叉点，写明旧分支并入 main 要用 merge、不要 rebase；补一条：检查只管代码 PR 有没有片段，不禁止改 `changelog.md`。README 还补半句：`apps/`、`packages/` 下的 Markdown 也算代码路径（复审 N4）。
  - `docs/governance/docs-verification.md`：§2 的检查说明、§4 的例外行改为新的放行条件；关闭条件改成可执行的检查：`gh pr list --state open` 的每个 PR 运行 `require` 都不再打印 cut-before warning。
  - `docs/backend/ci-merge-automation.md`：汇编步骤加第 5 步，给出上述检查的命令；「冲突」改为旧 PR 用 merge 解冲突、不要 rebase；「回退」不再说片段检查本来就接受直接改 `changelog.md`（复审 N1）。
  - `.github/workflows/governance.yml`：`require` 一步的注释不再说改 changelog 总能满足。
- 测试：`node --test scripts/governance-changelog-fragments.spec.mjs` 40 项通过。先红后绿：
  - 旧分支 merge 进 main（分支在前、main 在前两种父提交顺序），`require` 退出码 0 且带 cut-before warning，修复前退出码 1；
  - 旧分支 rebase 到新 main 后，`require` 退出码 1，报错写明 rebase；
  - 分叉点找不到、基点不存在、分叉点目录树被删时 `branchPredatesFragmentRule` 抛错，修复前目录树读不出被当成旧分支放行；
  - `CONTRIBUTING.md` 与片段 README 的「过渡」、workflow 注释、§4 关闭条件的文字与实现一致；
  - 单测：同样的改动，放行模式通过，不放行模式与默认参数都失败。
  另在本仓真实历史上复现：唯一在途旧分支的 head 与 main 用 `merge-tree` 加 `commit-tree` 合成合并提交（不建引用），修复前 `require` 退出码 1，修复后 0。本 PR 自己在规则合入后切出，按新规则写了这个片段。
- 未做：
  - 叠在旧分支上切出的新分支同样有早于规则的分叉点，照样放行；它带着旧分支的 `changelog.md` 改动一起合入，按提交逐个归属改动得不偿失，登记为 §4 的风险。
  - 复审 N2（片段改名后 PR 号记到改名的 PR）、N3（新增根目录文件在 push 到 main 时的分类用例）只是 NIT，没有改。
  - 仓外 `/global/CLAUDE.md` §7 把新规则说成「直接改 changelog 会被拦下」，实际只拦没有片段的代码 PR；不在本仓，没有改。

## 2026-10-14 · Release the reservation of a definite failure before any output, and let the same key reserve again (D13, operational fix) (#652)

- 起因：非付费路径（获客全部走这里）把「确定的失败」和「结果未知」一样当作不可重放，每一次都是 run 的终点。
  - 网关 `router-model-gateway.ts` 的 catch 只在 `ExternalActionDeniedError`、`callCount === 0` 且没有 usage 时释放预留，其余一律「已结算、无结果」：HTTP 503（卖方 #26 的词表归一，10-13 11:36，`ProviderHttpError`）、首个输出之前的上游错误事件（卖方 #25、#27，10-13 08:36 与 12:27 的 6 次 `CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR`，ai_trace 里输入、输出 token 都为空，new-api 记 `reason=eof`、0 个输出 token）。
  - 账本 `reserve_tool_budget_microusd_v1` 对已存在的 key 一律 `REPLAY`，`release` 只允许 RESERVED → RELEASED：释放过的操作也永远不能再跑，重试都撞上 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`。共用操作键时还跨查询传染（卖方 #26）：#645 已按查询分键并在丢失时回退内置词表，但失败的归一调用仍按预留上界结算（#645「未做」第 1 条），本 PR 让 503 这类确定失败释放、同一查询的重试可以重新预留。
  - broker 在 `execute()` 开始后的任何失败都保留 RESERVED，连请求根本没发出（DNS 失败、SSRF 拦截、平台出网合同不可用）也一样。
  - xin 只读核对（`global_dev`）：10 月「SETTLED、无结果」31 行、RESERVED 19 行（10-09 至 10-13，全部是 1¢/0¢ 的工具预留）、RELEASED 28 行。
- 改动：
  - **网关**：新模块 `model-gateway/definite-model-failure.ts` 判定「确定失败、网关没有计费」，两类：HTTP 429 与除 504/524 外的 5xx（`MODEL_PROVIDER_HTTP_UNAVAILABLE`，与 new-api 自身的重试状态码 429,500-503,520-523,525-599 对齐）、连接从未建立（`fetch failed` 的 cause 为 ECONNREFUSED/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/ENETUNREACH/UND_ERR_CONNECT_TIMEOUT，双栈时每个地址都是，`MODEL_PROVIDER_CONNECTION_NOT_ESTABLISHED`）。非付费、非平台出网路径上这两类释放预留；超时、中止、HTTP 504/524、任何流式失败（含首个输出之前的）、内容过滤、不可读的流、HTTP 4xx、修复调用（首调已出输出）和其他错误照旧结算、无结果。
  - **运行时会话核对后的收窄**（PR 评论 issuecomment-6182377079）：初版还释放「流在第一个输出之前结束」（`CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR`/`_TRUNCATED`/`_EMPTY`，`MODEL_PROVIDER_STREAM_FAILED_BEFORE_OUTPUT`）。运行时会话只读查了 new-api 的计费日志：10-13 12:27 那批 `reason=eof`（log 5734–5738）各有一行 consume，completion 为 0，按本地估算的输入 token 计费，每次约 2.3 万 quota；10 月全月有 6 行 0 输出计费，约 0.28 美元。现役 fork 对这种流回 HTTP 200 并扣费，释放会少记，所以拿掉这一类，等 mlhjyx/new-api#3（首字节之前的失败改为回错误、不计费）随 W12 上线后再单独加回。HTTP 504/524 是超时，请求已到达上游、可能已生成并计费，也排除。HTTP 429/5xx 在 new-api 侧没有任何计费行，可以释放。每个 key 最多 3 次是账本层的计数：new-api `RetryTimes=1`，最多对应 6 次物理请求。
  - **流解析器**（`openai-compatible.provider.ts`，判定暂不使用，留给 new-api#3 上线后的那次改动）：记录是否收到过输出——content、任何名字的 reasoning、tool_calls 增量，或 usage 里的输出 token；只有 role 的开头块和空字符串不算。三种流失败带上 `outputStarted`；其余失败不带（视为未知）。
  - **ai_trace**：失败的非付费调用在 `meta` 里写 `budgetOperationId` 与 `budgetDisposition`（`RELEASED_CONTROL_DENIAL` / `RELEASED_DEFINITE_FAILURE` / `SETTLED_NO_RESULT`），每次失败都能追到账本行；`ProviderHttpError` 的 `errorMessage` 带上状态码（`ProviderHttpError:HTTP_503`）。
  - **broker**：能证明一个物理请求都没发出时释放预留——平台工具的调度器从未进入；或工作区工具声明了 `physicalWireObservation: "before_each_wire"`（每个物理请求前都调用 `ctx.beforePhysicalWire`）而 broker 注入的观察钩子从未被调用。声明的工具：`http.get`、`crawl4ai.render`、`tradefair.algolia`、`mapyourshow.fetch`、`sanctions.download`。没有声明的工具与付费路径不变。
  - **账本**：迁移 `20261015045032_tool_budget_released_rereserve` 给 `tool_budget_operation` 加 `attempt`（1..3）；`reserve` 遇到同 key 的 RELEASED 行且 `attempt < 3` 时重新打开同一行（`attempt + 1`、回到 RESERVED、按新额度做与新插入相同的额度检查与 DENIED/exhausted 处理），id 不变，`(account_id, generation, operation_key)` 仍唯一；RESERVED、RESULT_UNKNOWN、SETTLED（有无结果都一样）以及第 3 次的 RELEASED 照旧 `REPLAY`。
  - **治理声明**：`durable-result-strategies.json` 的 `resultDisposition` 升到 `execution-result-disposition/v2`，新增 `definite_failure`，`automaticPhysicalRetryAllowed` 从 `false` 改为 `"DEFINITE_FAILURE_BEFORE_OUTPUT_ONLY"`，并声明 `definiteFailureStatus: RELEASED`、`maxReservationAttempts: 3`；`execution-authority-policy.mjs` 按新口径逐值校验，并要求迁移里有 3 次上限与「只有 RELEASED 可再预留」、分类器排除 504/524，并且在 new-api#3 上线前不得引用 `ProviderTransportError`/`ProviderOutputError`（即不得释放任何流式或输出失败）。`domain-ack-contract.ts` 的处置合同同步到 v2：只有 `definite_failure` 可以 `automaticPhysicalRetryAllowed: true`。AGENTS.md §8 与执行预算设计文档同步口径。
  - 受保护文件 `router-model-gateway.ts`、`tool-broker.ts` 重钉指纹，复核追加到 `docs/evidence/execution-authority-fence-review-20261001.md`。`schema.prisma` 变更后 Copy 回执重签（HASH_ONLY）。CI 的 PostgreSQL 步骤加跑新的账本真库用例。
- 测试：
  - 先写失败测试，确认红后再实现，改动后全部通过：
    - 网关 24 项新用例，改动前 22 项红（10 类释放、11 类照旧结算、预算余额回到原值）；「修复调用遇 503 照旧结算」「平台出网照旧结算」两项改动前就成立，锁住边界。收窄时三种流式用例移到「照旧结算」，另加 HTTP 504、524 两项「照旧结算」，收窄前这 5 项红；处置合同把流式码加进拒收列表，收窄前红。
    - 流解析器 12 项，改动前 11 项红（不可读行的输出状态保持未知，改动前就成立）。
    - broker 8 项，改动前 3 项红（另外 5 项锁住不变的行为：未声明工具、调用方钩子、上下文不变、平台已发出、调度器失败）。
    - 处置合同新增 6 项，改动前 4 项红；4 个旧用例随 v1 → v2 改名。治理脚本 1 项红。工具声明清单 1 项红。
    - 账本真库 6 项全部红：RELEASED 后同 key 重开为第 2 次并正常结算；在途、结果未知、已结算无结果都照旧 REPLAY；第 4 次 REPLAY；额度不足时 DENIED 且行仍为 RELEASED；两个并发重开只有一个成功；网关在 503 后的重试真正跑完而不是撞上 REPLAY。
    - ai_trace 写入 `meta` 的 1 项与实现同时写。
  - 一次性 PostgreSQL（pgvector/pg16）上 `prisma migrate deploy` 全部迁移后跑真库用例，以 app_user 运行；`security-definer-search-path.postgres.spec.ts` 与 `discovery-run-admission-lease.postgres.spec.ts` 在同一库上照旧通过。
- 未做：
  - 在途 RESERVED 的有界等待（重试遇到「仍在进行」时按 2 秒轮询、最多 310 秒）与超龄 RESERVED → RESULT_UNKNOWN 的 SQL 函数（任务里的 PR-2）。10 月的 19 行 RESERVED 多是 `crawl4ai.fetch` 发出请求之后的失败（爬虫 5xx、超时）或进程中断，本 PR 不释放它们。
  - `crawl4ai.fetch` 没有把 `beforePhysicalWire` 传给 robots 与爬虫，所以不声明；本地 crawl4ai 服务回 5xx（请求已发出）是否也算「确定失败」需要单独决定。
  - 付费路径（Site Builder R4-B 账本）不变。
  - 重新打开的行保留首次的 `created_at`；如果 PR-2 按年龄判定超龄，需要另记每次预留的时间。
  - 流在第一个输出之前失败暂不释放，等 mlhjyx/new-api#3 上线后单独加回（同时改 `execution-authority-policy.mjs` 的反向检查）。
  - 迁移原名 `20261014095011`，排在 #654 的 `20261014120000` 之前；为避免分班上线时 `migration_revision` 与最新执行的迁移不一致，改名为 `20261015045032`，SQL 不变。

## 2026-10-14 · Keep a reused artifact object alive until its latest manifest expires, and record every object version for erasure (#647)

- 起因：运行时会话 10-14 用库与 MinIO 证实，产物对象按 `sha256 + 隐私类` 寻址复用，但桶生命周期按**对象年龄**过期（PERSONAL_DATA 1 天，MinIO 的实际删除点是 `LastModified + 2 天` 向下取整到 UTC 午夜）。后来的清单复用同一对象不刷新年龄，第一个写入者的到期一到对象就没了，库里更晚的行还在有效期内：空页面摘要 `e3b0c442…` 有 23 行（10-12 17:34 → 10-13 16:36 写入，最晚到 10-14 16:36），对象 10-14 00:00 已被删除；重放时 `readVerified` 报 `GENERIC_OPERATION_ARTIFACT_INVALID`，「同一操作重放不再出网」的保证被破坏。
  - 顺带发现两处同根缺陷：`settle…v3` 拒绝任何与对象表钉住的版本不同的版本号，生命周期删除后同样字节的再次写入会以 `…_INVALID` 结算失败（xin 173 个对象里 126 个钉在已不存在的版本上）；个人数据擦除只删钉住的那一个版本，而按版本号删除当前版本会让上一个版本重新成为当前版本（MinIO 实测）。
- 改动（方案 A，复用时刷新；理由与未采用的方案 B 见 [docs/backend/generic-operation-artifact-storage.md](../backend/generic-operation-artifact-storage.md)）：
  - **存储**（`generic-operation-artifact.store.ts`）：`promote` 接收 `retainUntil`（服务传入本次清单的 `expiresAt`）。复用分支校验字节后，若当前版本在 `x-amz-expiration` 里公布的到期早于 `retainUntil` 或没有公布，则 `CopyObject` 到自身（`REPLACE`，元数据、`ContentType` 与标签都取自现有对象，即首写者的合同；SSE-S3），再 HEAD 要求与现有对象合同全等（`sameObjectContract`），返回复制响应里的版本号；到期已覆盖则原样复用。复制失败不让操作失败：返回已校验的现有版本并记固定告警码 `GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED`。`store.read` 的 NotFound 改报 `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`。
  - **服务**：`persist` 之后的 inspect 只核对 key、字节与隐私类（#644 后的 `sameStoredArtifact`）、不再要求版本号相等（并发复用可能已再刷新一次），结算记录 `promote` 自己校验或创建的版本；`readVerified` 对「清单有效、对象不在」报 `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING` 而不是 `…_INVALID`。
  - **重放路径**（`generic-operation-artifact.execution.ts`）：`replay` 失败时记 `[artifact] <schema> replay failed for operation <id>: <类名:有界码>` 后原样抛出；ToolBroker（受保护文件，未改）照旧转成 `BudgetOperationReplayError`，发现 run 按无法重放跳过并计数，不二调。
  - **迁移** `20261014050000_generic_operation_artifact_object_version_ledger`：新表 `generic_operation_artifact_object_version` 记录每个被结算记录过的版本（从现有钉子回填）；`settle…v4` 取代 v3，版本号改为「移动钉子 + 写入账本」；`enqueue_workspace_personal_artifact_cleanup_v1` 同签名重建，为账本里的每个版本各建一条精确版本清理命令。擦除端口与 MinIO 策略、桶生命周期、readiness 期望都不变；在 bootstrap 策略下实测运行时 principal 的复制到自身被允许、无标签或错标签的复制被拒。
  - `PostgresBudgetStore.settleArtifactManifest` 改调 v4；Prisma 新增模型；`app-user-table-privileges.json` 登记新表（无权限）；CI 的 PostgreSQL 作业加跑新 postgres spec。
- 测试：
  - 先红后绿：存储 9 项（按到期刷新、已覆盖不刷新、无到期头刷新、不传 `retainUntil` 不复制、复制失败 fail-open 只记一条码、复制响应无版本号时取当前版本、刷新后合同漂移拒绝、`retainUntil` 非规范拒绝、`read` 的 `OBJECT_MISSING`）、服务 3 项、重放路径 1 项，改动前 11 项失败（服务/重放 3 项在 origin/main 代码上复跑确认），改动后三个文件 98 项通过。内存 S3 桩补了 `CopyObject`、LastModified 与 MinIO 公式的 `x-amz-expiration`。
  - 迁移静态 spec 5 项；真库 spec（`generic-operation-artifact-object-version.postgres.spec.ts`，一次性 pgvector:pg16，以 app_user 跑）4 项：v4 移动钉子并逐版本记账、v3 仍拒绝不同版本（被取代的行为）、账本写入函数对 app_user 拒绝、擦除为每个版本各建命令并逐条 claim/complete。
  - 真 MinIO（一次性容器 + `infra/minio/bootstrap.sh` 原样建桶与三个 principal）：`generic-operation-artifact.minio.spec.ts` 新增「复用对象在运行时策略下复制到自身」用例，与既有用例、`personal-artifact-cleanup.minio.spec.ts` 一起通过。
- 未做：
  - 刷新复制在结算之前就生成新的当前版本，结算没落库时这个版本不在账本里，擦除删不到它，只靠生命周期按年龄清（PERSONAL_DATA 最长约 2 天，期间仍可读）。会留下它的路径：进程在两步之间死掉；结算被擦除围栏以 `SUBJECT_TOMBSTONED` 拒绝而回滚；复制 ACK 丢失被 fail-open 当作失败；复制后的 HEAD 报 `STORAGE_UNAVAILABLE` 或漂移。改动前复用分支从不写对象，没有这个缺口。可选收口（复制前查清理命令/墓碑，或复制前写意向账本）见存储文档第 3 节。
  - readiness 金丝雀没有加「复制到自身」探针；策略若漂移，只会在复用时以告警码暴露。
- 与 #644（字节级复用判定，先于本 PR 合入 main）的交互，合入 main 后按复审修了三处：
  - 刷新复制原先用本次清单（后来者）的元数据、`ContentType` 与标签，会把首写者合同改写成后来者的，库里首写者的 `media_type` 与桶从此不一致；改为取现有对象的合同。
  - 复制后的核对原用 `sameArtifact`，#644 后它不再比较 mediaType/resultSchema，漂移检测失效；改用新增的 `sameObjectContract`，要求与现有对象五项全等。
  - `persist` 里传给 `sameStoredArtifact` 的对象字面量多带了 mediaType/resultSchema，#644 收窄形参后触发 TS2353，`nest build` 失败；删掉这两项（它们本来就不再参与比较）。
  - 测试（先红后绿）：store spec 新增「后来者以另一合同复用并触发刷新时保留首写者的元数据、ContentType 与标签」、「复制后 ContentType / 结果 schema 偏离现有对象合同时拒绝」（2 项，原「偏离 staged」用例改写）、「复制落地为后来者合同时拒绝」，改动前 4 项红、改动后通过；service spec 新增「刷新复用保留首写者合同、并发再刷新后仍记录 promote 创建的版本」（运行时改动前后都成立，钉住接口；编译错误由 build 暴露）；真 MinIO spec 新增「另一结果 schema 的复用刷新后 HEAD 的 ContentType、元数据、标签仍是首写者的」，在改动前的 store 上红、改动后与其余 7 项一起通过（一次性 MinIO + `infra/minio/bootstrap.sh`）。

## 2026-10-14 · Key term normalization per query, skip its model when no routed source reads it, and fall back to the built-in vocabulary when the call is lost (#645)

- 起因：卖方 #26 的验收 run（`3e78eb4e`，xin，2026-10-13 11:36 UTC）15 秒内失败：`stats.failure = { stage: query, errorType: BudgetOperationReplayError }`，16 条查询只记 1 条失败。
  - 第 1 条查询的词表归一（`taxonomy.normalize`，deepseek-v4-pro）被上游以 503 拒绝（`ai_trace` 一行 `ProviderHttpError`，5.9 秒），网关把这次预算操作按预留上界结算（`tool_budget_operation`：SETTLED、无结果、100000 microusd）。
  - 模型操作键 = run、任务、模型、`correlationId`、提示词、system、schema（`router-model-gateway.ts` 的 `paidOperationKey`），而 `TaxonomyResolver` 传给网关的上下文只有 workspace、run 与结果 schema（`taxonomy-resolver.ts` 的 `executeBudgetedTask`）。同一个词在同一 run 里的提示词完全相同，于是 16 条查询共用一个已死的操作：第 1 条的重试与第 2 条的首次尝试都撞上 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，按 #643「连续两条即停」run 失败。#643 的「未做」已登记这条传染。
  - 另外两处与设计不符：`docs/backend/vocab-taxonomy.md` 写明 LLM 归一「不碰发现热路径」，而 `executeQuery` 对每条查询都调；`public_web`（今天唯一有受治理血缘、真正被路由的发现源）根本不读归一结果（`_industryQids` / `_osmTags` / `_countryQid` 只有 wikidata 与 openstreetmap 消费），这些调用既花钱又没有用处。
- 改动：
  - **操作按查询归键**：`TaxonomyResolveOptions` 新增 `correlationId`，四条归一路径都把它放进网关上下文；`executeQuery` 传 `${queryKey}:${queryOrdinal}`。同一 run 两条查询共用一个词时各自预留操作；成功归一仍由 `term_alias` 沉淀，后续查询走确定性路径不再调模型，所以只有失败会各撞一次。只有 authority 时代、没有计划身份的旧形态查询不带 `correlationId`（保持原键）。
  - **只为会读归一结果的源调用模型**：`CompanyDiscoveryAdapter` 新增 `consumesResolvedTaxonomy`，wikidata 与 openstreetmap 声明；一条查询路由到的源都不声明时，`executeQuery` 传 `allowLlm: false`，只查已沉淀的别名，未命中由 provider 回退内置 `vocab.ts`。按今天的路由（只有 `public_web` 有血缘），发现热路径不再调 `taxonomy.normalize`。
  - **调用丢失时回退内置词表**：词表归一遇到 `BudgetOperationReplayError` 或 `ProviderHttpError` 5xx 时，这条查询不再「不调任何源、以零回执结束并标记 `unreplayable`」（#643 的设计，在此被替换：归一只是查询的精修，不是查询本身的工作，丢了它不该丢整条查询），而是保留已归一的词、其余回退各源内置词表，照常派发所有源，查询不算失败、`previousQueryUnreplayable` 不受影响。`ProviderHttpError` 在别处仍是控制错误（`execution-control-error.ts` 按形状判定），只在词表归一这一处吸收；4xx 与其他控制错误照旧 fail closed。
  - **统计**：活动结果新增 `taxonomyFallback` / `taxonomyModelSkipped`（只在为真时出现）；工作流计入 `stats.taxonomyFallback`（回退的查询数）与 `stats.taxonomyModelSkipped`（有词可归一却没有调模型的查询数），只在大于 0 时出现，不改 run 状态。对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）与 `docs/backend/vocab-taxonomy.md` 同步到 as-built。
- 测试：
  - 先写失败测试，改动前 7 项失败、改动后 5 个文件 339 项全部通过：
    - resolver 1 项：`correlationId` 进入网关上下文、不传时不带；
    - 活动 5 项（另 2 项改动前就成立）：同一 run 两条查询共用词时两次归一的 `correlationId` 各为 `queryKey:ordinal` 且不同；只路由 `public_web` 时 `allowLlm: false` 并计 `taxonomyModelSkipped`；路由到 wikidata 时允许模型；503 回退并照常派发、无 `unreplayable`；`BudgetOperationReplayError` 紧跟在丢失的查询之后同样回退；国家归一失败时保留已归一的行业；401 与其他控制错误照旧失败；
    - 工作流 1 项：两种计数进统计且状态仍 DONE；另 1 项核对没有发生时统计形状不变。
  - 网关 1 项钉住本修复依赖的契约：同一提示词、不同 `correlationId` 预留不同操作键，相同的则相同（改动前后都成立）。
  - #643 的两个用例「词表归一丢失时不调用任何源」「紧跟在上一条之后时失败」按新行为删除，由上述回退用例取代。
  - `gctl check`：docs/governance、prisma generate、contracts、lint、build 全绿；全量单测 9665 项通过、1 项 `browser-readiness-probe` 的 1000 进程 soak 在本机负载下超时，单独重跑该文件 24 项全绿（`/global/CLAUDE.md` §6 登记的假红）。
- 未做：
  - 失败的归一调用仍按预留上界结算（本例 0.10 美元）。操作按查询归键后，上游持续 5xx 时每条查询最多各撞一次（每条最多 6 个词），总额仍受 run 预算封顶；没有加「本 run 已见 5xx 就跳过后续归一」的交接。
  - 429 等 4xx 仍按控制错误让查询失败，没有放进回退范围。
  - 旧形态（无计划身份）的查询不带 `correlationId`，仍按 run 共用操作键。
  - `taxonomyFallback` 不进 `resolveRunStatus`：回退的查询照常跑完所有源，不算漏活；若产品负责人希望它把 run 判 PARTIAL，是一行改动。

## 2026-10-14 · Request scoring after a FAILED discovery run that already judged fit, and tell preset queues from scored ones (#648)

- 起因：xin 上 179 条 lead 的六维分全是 NULL，队列只是 fit 阶段按 verdict 预置的值（`discovery/fit-judge.ts` `upsertLeadFit`：mismatch→rejected、其余→needs_review）。
  - `finalizeRun` 只在 run 状态非 FAILED 时写 `QualifyRequested`，而 11 次验收 run 全部 FAILED（10-14 只读核对 `global_dev`：`discovery_run` 11 行全 FAILED、stats 都没有 `fit` 键（全部走的失败收尾路径）；`outbox_event` 里 `QualifyRequested` 与 `LeadsScored` 各 0 条）。
  - 结果是评分、制裁第五门（`temporal/qualify.activities.ts`）、`LeadsScored` 事件从未在真实数据上跑过；API 又把预置队列和评分队列显示成一样。
- 改动：
  - **FAILED 的 run 也请求评分**：只要本 run 的 fit 阶段已经给过判定，`finalizeRun` 照样写 `QualifyRequested`（`reason: discovery_run_failed_after_fit`），让已物化的公司得到评分；分数是幂等 upsert，之后的 run 再刷新。
    - 判据只看本 run（`fitStageJudged`）：stats 带 `fit` 时只按它的计数（全 0 就不写，不再回退查 lead 表）；失败路径的 stats 不带 `fit`，先要求 `failure.stage` 已到 fit（fit / enrich / signals / watches / patentEnqueue），再查本 run 解析出的公司（本 run 已接受的 raw → company identity link）在该 ICP 下有没有 `fit_verdict`。停在 query 等 fit 之前阶段的 run、或别的 run 留下的判定都不触发。
    - 评分是确定性的、不调 provider、不花预算，所以 run 授权已结束（过期 / 撤销 / 用尽）时也写；`attestRunFinalization` 对 FAILED 的容忍逻辑不变。
    - plan 仍留 READY；`DiscoveryRunCompleted` 照旧带 `status: FAILED`。
  - **API 区分预置与已评分**：`GET /leads` 与 `GET /leads/:id` 每行加 `scored`（`total_score` 非空）与 `queueBasis`（`fit_gate_preset | score | human_accept | human_reject`）；`GET /icps/:id/lead-queues` 加 `scored`（每条都有分）与 `queueBasis`（四种依据的计数），并把一直返回却不在契约里的 `sanctions_hold` 补进契约。
    - 多加了 `human_reject`：评分阶段自己也写 `status=REJECTED`，只凭状态分不出人工拒绝与评分拒绝，所以用一条 reject 裁决作证（列表每行只探 1 条；汇总用关系过滤聚合）。
    - 新列 `lead.scored_at`（迁移 `20261014051926_lead_scored_at`，可空、不回填），评分阶段每次写分盖上。
    - `POST /leads/:id/accept` 与 `/reject` 用同一个 `LEAD_SCHEMA`，响应同样带 `scored` 与 `queueBasis`（含两处幂等早返回）。
  - **人工拒绝成为终态**：`scoreCandidates` 的 `humanFinal` 原先不含 REJECTED（注释说含），人工拒绝会被重评分改回 REVIEW；FAILED 收尾也请求评分后这条路径每次都会走到。现在 REJECTED 且有 reject 裁决的 lead 重评分只刷新分数、不改状态与队列，判据与 `human_reject` 相同。
    - 人工 reject 一条评分写的 REJECTED（还没有 reject 裁决）时，`decide` 照样记下裁决，不再当成重试直接返回——否则人工的拒绝没有留痕，也挡不住重评分。已有 reject 裁决的重复 reject 仍是幂等早返回。
  - **`LeadQualified` 快照 v1 加可选字段** `scored_at`、`queue_basis`（设计 E1：`snapshot_version` 仍 1，旧载荷照样通过）。
  - OpenAPI 重导出；`packages/contracts/INTEGRATION.md` 阶段 3 与 `docs/architecture/current.md` 的快照字段表同步。
- 测试：
  - 先写失败测试，改动前 19 项失败（另一个文件因模块不存在整体失败）、改动后全部通过：
    - `finalizeRun` 18 项：stats 有 fit 判定 / 失败停在 fit 及之后 5 个阶段且本 run 的公司有判定（断言按 run → raw → identity link → lead 查询）/ 停在 fit 之前 4 个阶段即使 ICP 有判定也不写 / stats 既无 fit 也无 failure 不写 / 本 run 的公司无判定不写 / 本 run 无已接受 raw 不查 lead / 本 run fit 计数全 0 不回退查 lead / 授权已结束仍写（3 种码）/ DONE 的 reason 不变且不查 lead 表；
    - 队列依据纯函数 11 项；`LeadService.list` / `queueSummary` 4 项；快照 7 项（含 schema 正反例、旧载荷通过、decide 接线）；评分 `scored_at` 2 项、人工拒绝终态 2 项；`decide` 响应 5 项（accept / 重复 accept / reject / 重复 reject / reject 评分写的 REJECTED，逐项对照 openapi.json 的 required）。
  - 真库 `lead-queue-basis.postgres.spec.ts`（app_user + RLS，一次性 Postgres，5 项）：迁移后的列可写、`groupBy` 的 `_count.totalScore`、关系过滤聚合、列表排序与行形状、跨 workspace / 跨 ICP 不计入、`decide(reject)` 对评分写的 REJECTED 记下裁决且重试不再加。已登记到 CI 的 PostgreSQL 步骤。
  - `gctl check` 通过；oasdiff 对 origin/main 无破坏性变更。
- 未做：
  - 已有的 179 条 lead 不会自动评分：下一次 run 收尾时触发，或手动 `POST /icps/:id/qualify`。本 PR 不在 xin 上发起评分。
    - 这 179 条分属 3 个 ICP（84 / 51 / 44 条，10-14 只读核对），手动 qualify 一个 ICP 只给这一个 ICP 的 lead 评分。
    - `scoreCandidates` 遍历的是整个 workspace 的 canonical 公司，不只是该 ICP 判过的（既有行为，本 PR 未改）：xin 上 workspace 有 150 家公司，qualify 一个 ICP 后它的 lead 会变成 150 条，多出来的 66 / 99 / 106 条没有 `fit_verdict`，按评分直接进队列。所以 qualify 之后该 ICP 的 `lead-queues` 会是 `scored: true`、总数 150，而不是「179 条变 scored」。要不要只给本 ICP 判过 fit 的公司评分是另一个决定。
  - 任务描述里「FAILED 收尾不发 `DiscoveryRunCompleted`」与代码不符：FAILED 一直发、带 `status: FAILED`，本 PR 保持。

## 2026-10-14 · Score reachability from company-level contact paths, retire the idle Role weight, and record mirrored exclusions instead of rejecting on them (scoring rules v3) (#649)

- 起因：xin 上 `recommended` 队列结构性为 0（2026-10-14 只读核实：lead 62 needs_review / 117 rejected / 0 recommended；150/150 家公司 industry 与 employee_count 为 NULL；`company_contact_point` 0 行，开关 `company_contact` DISABLED）。三道门叠在一起：
  - 可达性只读人级 `contact_point`（`scoring.ts` 旧 161–168 行；`qualify.activities.ts` 只 include `contacts.contactPoints`），而自动链路里没有联系人发现（LIA 之后才走），#630 建好的公司级 `company_contact_point` 评分读不到。
  - 0.55 门槛够不着：可达性置 1.0 后 ICP ce100faa 的 12 条 match 最高 0.5225。根因是 DataQuality 的 industry / employee_count 对 150/150 家都是 NULL（public_web 原始记录从不带这两个字段），封顶 0.5；Role 维在 RL1 恒 0，15% 权重闲置；关键词代理用 `JSON.stringify` 全文扫描，2 字母 token「ce」误命中 JSON 键名 `certifications`。
  - ICP 生成的镜像 EXCLUSION：ICP 22202d3c 有 6 条 EXCLUSION 是 MUST_HAVE 的镜像（`keywords not_contains "泵" / "库存" / "售后"`、`region not_contains "DACH"`、`business_model not_in […]`）。规则引擎对 not_contains 的语义是「属性存在且不含该词 → pass」，任一 EXCLUSION pass → exclude，评分把 exclude 放在权威 Fit 之前；公司 keywords 是受控英文词表、永远不含中文，于是带 keywords 的公司一律 rejected（离线复算 5 条 match 里 2 条被吞）。
  - 产品负责人按方案 A 授权：RL1 没有具名联系人，Role 并入 Fit / Reachability，门槛不变。
- 改动（`qualification_rule_version` 升为 `additive-6dim-v3`，写进 LeadQualified 快照；六维键与值域不变，`snapshot_version` 仍 1）：
  - **可达性 = max(公司级, 个人旧口径)**：`CompanyForScoring` 新增 `companyContactPoints[]`；任一 kind ∈ contact_page / impressum_page / contact_form / supplier_page 且 status ∈ VALID / UNVERIFIED 记 1.0（社交页不计，INVALID 不计）；个人口径不变（VALID 1 / UNVERIFIED、RISKY 0.5 / external_id 不计）。`scoreCandidates` include 该表（只取 VALID / UNVERIFIED），每批读一次禁联事实，**读时过滤**（公司被禁联 → 无点；被禁联域名覆盖的点剔除；`reachableCompanyContactPoints`）。`score_detail.reasonCodes[]` 新增：零可达且进 needs_review 写 `MISSING_CONTACT_POINT`；提示文案「先做联系人发现」改为「先补公司级联系路径」。
  - **权重 v3**：fit .45 / role 0 / intent .15 / dataQuality .15 / reachability .20 / engagement .05（v2：.35 / .15 / .15 / .15 / .15 / .05），门槛 0.55 不变；Role 仍计算、仍上报。复算：资格门 match + 联系页 + DataQuality 0.5 = 0.85×.45 + .20 + .15×.5 = **0.6575**，进推荐。
  - **关键词代理**：只扫属性**值**（不扫键名、不扫数字和布尔）；Latin token ≥3 字符（CJK ≥2 字，「扩产」仍有效）；排除 `intent`（原有）、`extraction_*` 与 `website_profile.evidence`。
  - **镜像 EXCLUSION**：`qualify()` 新增 `negativeExclusionsAdvisory`——权威 Fit 存在时，否定操作符（neq / not_in / not_contains）的 EXCLUSION 只评估、记进 `ruleEvaluations`（`advisory: true`）不改队列；正向 EXCLUSION 维持最高优先；无权威 Fit 时行为不变。ICP 生成（`icp.design` 输出落库）丢弃与 MUST_HAVE 同 field 同 value 的镜像 EXCLUSION（`mirrorExclusionRuleIndexes`，field / value 归一化后比较）；`IcpDto` 新增 `ruleLint[]`（读取 / 激活时由规则推导，不落库），指出存量 ICP 里的镜像规则。OpenAPI 已重导出。
  - **为现有公司补联系路径**：`profileWebsitesForRun` 在开关 `company_contact` 打开、本 run 的公司没用完 50 家画像配额时，用余量按 created_at 读工作区里还没按当前规则读过联系路径的公司（`contactPathBackfillCandidates`），计入 `backfilled`；配额、时间盒、续接下标对合并列表一体生效（本 run 已读过的公司留在列表里由循环跳过，下标稳定）。打开开关后不必等新 run 再找到这 150 家。
  - 文档：`docs/product-scope.md` 的可达性定义；`lead-qualified.v1.schema.json` 的 `qualification_rule_version` 示例与说明；`docs/architecture/current.md` 的六维注记。
- 被替换的设计与原因：
  - BI-14 设计 §5.1「仅表单 0.6」已被 2026-10-10 §10 改为联系路径任一存在即 1.0，本 PR 按 §10。
  - v2 权重（LED-006）给 Role 15% 的前提是有具名联系人，RL1 不成立。
  - 关键词代理的 `JSON.stringify` 全文扫描（#4）把键名与抽取账本当作公司事实。
  - 「EXCLUSION 永远优先于权威 Fit」在镜像规则下把资格门判 match 的公司硬拒；改为只对正向 EXCLUSION 维持最高优先。
- 测试：
  - 先写失败测试：`rule-engine.spec` 7 项、`scoring.spec` 新增 20 项并改 4 项旧断言、`qualify.activities.spec`（新文件）5 项、`icp.service.spec` 1 项、`icp.dto.spec`（新文件）2 项、`discovery.activities.spec` 5 项（其中 2 项护栏在改动前已通过）、`lead-qualified-snapshot.spec` 1 项；改动前 35 项失败，改动后全部通过。
  - 邻近用例（候选评估、qualify / 发现 workflow、预演、删除编排、website-profile、快照契约 ajv）全绿；`gctl check` 通过。
- 未做：
  - 没有改 DataQuality：industry / employee_count 仍靠富集，public_web 不带这两个字段是数据源问题。
  - 没有新开「只补联系路径」的独立端点或工作流：补读复用 run 的画像配额与预算，每个 run 最多补 (50 − 本 run 公司数) 家，150 家存量要 3–4 个 run；更快需要带预算授权的独立活动（新 scope、OpenAPI、GrowthOS 报价），另开。
  - 画像返回空（robots 拒绝、空页）的公司没有标记，会留在补读候选里（与本 run 列表的既有行为一致）。
  - 存量 ICP 的镜像规则没有自动删除：`ruleLint` 只提示，由人用 `DELETE /rules/:ruleId` 处理；评分侧已不受其影响。
  - 存量 lead 要重新评分才生效：对每个 ACTIVE ICP 调一次 `POST /icps/:icpId/qualify`；打开 `company_contact` 与是否再跑 run 补读由产品负责人决定（D9）。
  - 读模型 `GET /canonical-companies/:id` 带出联系点、BI-21 交付包字段不在本 PR。

## 2026-10-14 · Let one development workspace run its acquisition workflows on a source-built worker while the attested API keeps serving

- 起因：改获客的 worker 侧代码后，每次都要发布并切换后端镜像才能在本机验证。目标是只在 development、只对一个测试 workspace，让入驻理解、发现 run 与资格判定跑在源码 customer worker 上，管理态受证 API 继续承担全部 HTTP、readiness 与 relay，管理态受证 worker 继续服务其余 workspace；pilot/production 不受影响且 fail closed。设计与复核调整见[落地设计](../superpowers/plans/2026-10-14-dev-fast-lane.md)，运维步骤见[开发快速通道](../backend/dev-fast-lane.md)。
- 改动：
  - **开关**（`runtime/dev-fast-lane.ts`）：`RUNTIME_DEV_FAST_LANE_WORKSPACE_ID`（一个小写 UUID，既是开关又是唯一 workspace）、`RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS`（只接受 loopback）、`RUNTIME_DEV_FAST_LANE_SCHEMA_DIGEST`（车道 worker 用）。唯一解析器在 test/pilot/production 下见到任何一个就抛 `DEV_FAST_LANE_FORBIDDEN_OUTSIDE_DEVELOPMENT`；API 与 worker 都在启动最早处解析。compose 只把前两个转发给 `api` 服务，默认空。
  - **路由**（`outbox-relay.service.ts`、新 `temporal/dev-fast-lane-temporal.client.ts`）：只有车道 workspace 的 `CompanyProfileCreated`、`DiscoveryRunRequested`、`QualifyRequested` 改投开发用 Temporal 的 `understanding-dev-fast-lane-<id>` 队列，带执行超时（发现 185 分钟，其余 30 分钟），workflowId、reuse policy 与参数不变；车道命令单独成批，由 relay 主循环之外的车道 pass 投递，主循环与 `OUTBOX_RELAY` 心跳不等它。每次连接、每次启动最多 5 秒；连不上就关闭连接、冷却 30 秒，冷却期间不查询也不投递车道命令。所以开发用 Temporal 不可达时，车道命令既占不满主批次，也拖不慢心跳、readiness 和其他 workspace 的投递。开关为空时主查询与投递逐字不变。原生 Temporal 的机器授权器把 customer 队列钉死为 `understanding`，所以车道不用它。
  - **readiness**：开关开时 `/health/ready` 多一个可选的 `capabilities.dev_fast_lane`（恒为 `not_proven` / `DEV_FAST_LANE_UNATTESTED_ROUTING`），不参与整体状态与客户写入准入；OpenAPI 重导出（只增可选属性）。
  - **身份**（`runtime-release-identity.ts`）：开关开且缺构建回执时失败码改为 `DEV_FAST_LANE_UNATTESTED`；有效回执照常 attested，无效回执照常 `BUILD_ATTESTATION_INVALID`。API 不把开关交给身份加载，永远是受证镜像。`runtime-admission.ts` 未改。
  - **worker**（`temporal/worker.ts` 一个分叉点 + 新 `temporal/dev-fast-lane-worker.ts`）：只在「开关开 + 缺回执 + 唯一失败的准入项是 build」时，于遥测、数据库、租约之前分叉进车道 worker；其余进程走原路径（看到开关的受证进程只打一行 warning）。车道 worker 明文连开发用 Temporal、只 poll 车道队列、只注册 understanding/discovery/qualify 三组活动；不写租约、不建 owner 连接、不跑平台 seed、不取机器令牌、不需要建站依赖；迁移名与 schema 摘要用构建回执同一组函数从源码树求得（`build-attestation.ts` 导出 `latestMigrationRevision`、新增 `computeSchemaDigest`，`runtime-process-lease.ts` 拆出 `assertMigrationRevision`），schema 摘要必须等于镜像的，否则 `SCHEMA_DIGEST_MISMATCH` 不 poll。网关、broker、分类器、制裁与三组活动的构造与 `worker.ts` 逐字相同，由源码守卫 spec 比较。
  - **治理**：`environment-parity-policy.json` 新增一条 `trust` allowance `development-fast-lane-unattested-worker-trust`（verify 恰好 1 条新 finding、0 条 STALE），`runtime-admission-test-process-only` 的 reason 补一句；RuntimeEvidence 验证器拒绝非 development 的 `dev-fast-lane-` 证据（`EVIDENCE_FAST_LANE_ENVIRONMENT_INVALID`），traceability 拒绝把车道 kind 写进 `required_evidence_kinds`（`TRACE_FAST_LANE_EVIDENCE_KIND_FORBIDDEN`）。
  - 文档：architecture/current、status/current §4.5、ADR-024 补记、AGENTS §4、evidence README §2 同步写明这条例外与边界。运维页的排空检查在 RLS 下先 `set_config` workspace 再计数，并加上开发用 Temporal 车道队列的在途 workflow 计数；写明车道 env 文件只能交给 dotenv 读，不能让 shell source。
- 测试（先红后绿，AAA）：解析/路由/车道判定/schema 核对 14 项；迁移枚举与 schema 摘要 3 项（名字合格的普通文件按复核修正为报 `must be a directory`）；`assertMigrationRevision` 2 项；身份加载 4 项（含 main.ts 不把开关交给身份的源码断言）；`DEV_FAST_LANE` provider 2 项；车道 Temporal 客户端 6 项（连接失败关闭通道、30 秒冷却、启动 deadline、abort 中止等待）；relay 7 项（含 25 条车道行在第一次连不上时结束本轮、冷却期不查询；用真实客户端模拟每次连接等满 5 秒，READY 心跳与其他 workspace 的投递仍每 2 秒一轮，关闭时排空立即完成；开关关时单一查询逐字不变）；readiness 3 项与 OpenAPI 1 项；源码守卫：车道来源 3 项、`worker.ts` 分叉与车道 worker 6 项；compose 1 项；治理 1 项。`worker.ts` 现有的源码守卫 spec 全部原样通过。编译后的 worker 用合成环境（数据库与 Temporal 指向 `127.0.0.1:1`）冒烟：pilot 带车道变量退出码 1；只给 workspace 报地址无效；缺/错 schema 摘要分别停在 `DEV_FAST_LANE_SCHEMA_DIGEST_REQUIRED` / `SCHEMA_DIGEST_MISMATCH`；摘要正确时走到数据库准入。
- 未做 / 边界：
  - 尚未在 xin 上运行；首次落地要发布并切换一次含本改动的镜像（主线已含 #647、#648 的迁移，按带迁移的流程），镜像发布与打开开关是另外的授权事项。
  - 车道只覆盖三个 workflow 的 workflow 体与活动体；workflow 输入、outbox payload、事件注册表与 API 内的同步获客操作仍是镜像代码。两个车道 worker 之间不在代码层互斥。车道观察永远不是 RuntimeEvidence PASS，R4 撤销投递链仍未打通。

## 2026-10-14 · Record the rule version each lead was scored with, rest failing backfill companies for a week, keep non-mirror negative exclusions, count backfill apart, and match trigger words on word boundaries (scoring rules v3 follow-ups, W5-f) (#655)

- 起因：#649（评分规则 v3）的独立复审判 MERGE，同时登记了跟进项 W5-f（3 条 MEDIUM、3 条 LOW），要求与 #649 同一班车上线：
  - MEDIUM-1：`LeadQualified` 快照的 `qualification_rule_version` 取决策时的代码常量（`lead-qualified-snapshot.ts` 旧 264 行），`score_detail` 也不存规则版本。合并后没有重评的存量 lead 会被标成 v3。
  - MEDIUM-2：补读候选（`contactPathBackfillCandidates`）按 created_at 取，没有尝试水位。画像返回空（robots 拒绝、空页、死站、超时）或主体被拒的公司拿不到 `_contact_parser`，会一直排在候选最前面，新公司饿死。xin 的 150 家里有 60 家没有 website_profile。
  - MEDIUM-3：`negativeExclusionsAdvisory` 在有权威 Fit 时把所有否定型 EXCLUSION（neq / not_in / not_contains）都降为只记录，范围过宽：用户手加的 `country not_in [DE, AT, CH]` 会被静默失效。
  - LOW：stats 不输出 `backfilled`，profiled / matched 混入了补读公司；补读 SQL 没有真库测试（删掉 `_ts >= since` 子句测试仍过）；关键词代理仍扫 `_` 前缀的记账值，且按子串匹配（「new」命中「news」，「dach」命中「Bedachung」）。
- 改动：
  - **规则版本随 lead 存**：`scoreCandidates` 把计分用的版本写进 `score_detail.ruleVersion`（create 与 update 两路）。快照改读 `leadQualificationRuleVersion(score_detail)`：有版本取版本；`score_detail` 存在但没有版本 → `additive-6dim-v2`；从未计分 → `null`。`lead-qualified.v1.schema.json` 的 `qualification_rule_version` 改为 `string | null`，说明写明语义；`INTEGRATION.md` 同步。
  - **尝试水位与 7 天冷却**：开关 `company_contact` 打开时，每次联系路径尝试都在 `website_profile` 记 `_contact_attempt_at`，不论结果（读到、空页、robots 拒绝、死站、超时、无法重放、主体被拒）。写入走 `recordContactPathAttempt`：持禁联策略锁、经禁联安全写入口，被禁联的公司不写；画像提交改写命名空间之后才写，所以和画像事实在同一事务里并存。
    - 补读候选排序：从未尝试的优先，其次上次尝试最早的，再按 created_at。run 创建前 7 天内尝试过的不入选（`CONTACT_PATH_RETRY_COOLDOWN_MS`）。
    - 续接下标稳定：本 run 尝试过的公司留在列表里，按它在本 run 之前的那次尝试（`_contact_attempt_prev`）排序，位置不变；冷却截止按 run 创建时刻算，不随各活动的时钟移动。
    - 并发去重：补读每家前重读一次存储；两个 run 选到同一批时，后到的那个看到对方刚记的尝试（冷却期内）就跳过。本 run 自己的公司也重读一次，别处刚读完的跳过。
    - 只有尝试标记、没有画像事实的命名空间不当作画像：fit 判定的提示词不再带出空的 `website_profile`；画像提交重放时的回读改为看 `_ts`（画像事实一定带它），不把只有尝试标记的命名空间算成 matched。
  - **否定型排除收窄**：`qualify()` 的选项改名为 `mirrorExclusionsAdvisory`，只把 `mirrorExclusionRuleIndexes` 认出的镜像规则降为只记录；非镜像的否定型 EXCLUSION 照旧排除。`lintQualificationRules` / `IcpDto.ruleLint` 对非镜像否定型 EXCLUSION 也给一条提示（资格门已判 Fit 时仍然排除，请确认取值写法与公司属性一致）。OpenAPI 描述已重导出。
  - **stats**：活动返回的 `profiled` / `matched` / `unclassified` 只计本 run 的公司，补读公司计入 `backfilled`。工作流的 `WebsiteProfileTotals` 与 `addWebsiteProfilePass` 累加 `backfilled`，`stats.websiteProfile.backfilled` 输出（旧结果没有这个键时按 0）。只改 stats 对象，不新增命令，重放不受影响。
  - **关键词代理**：跳过任意层级 `_` 前缀的键；Latin token 按词边界匹配（前后不是 Unicode 字母或数字），CJK 仍按子串。
- 测试：
  - 先写失败测试，改动前 33 项失败：`company-contact-points.spec` 6 项（新）；`discovery.activities.spec` 6 项新增、3 项改计数；`workspace-authority.workflow.spec` 1 项新增、3 项改期望；`scoring.spec` 4 项新增；`rule-engine.spec` 4 项（advisory 段按新语义重写）；`lead-qualified-snapshot.spec` 3 项新增；`qualify.activities.spec`、`icp.dto.spec`、`fit-judge.spec` 各 1 项新增。改动后全部通过。
  - 真库：新增 `contact-path-backfill.postgres.spec.ts`（5 项），以 app_user 真跑补读 SQL 和尝试写入：排序（从未尝试优先、尝试早者优先）、冷却与各排除条件、RLS、run 内打标后列表不变（下标稳定）、下一个 run 与冷却期满后的列表。三处变异各有用例变红：删掉 run-since 子句、排序不用 `_contact_attempt_prev`、删掉冷却条件。没有加进 ci.yml（W9 会把真库 spec 移出 ci.yml），手动运行命令写在 PR 正文。`raw-sql-parameter-types.postgres.spec` 与 `company-contact-point.postgres.spec` 在同一个一次性库上通过。
  - 邻近：icp、lead、候选评估、删除编排、发现预演、qualify 合成、发现工作流与两条重放用例全绿。
- 被替换的旧设计：
  - #649 的「权威 Fit 存在时所有否定型 EXCLUSION 只记录」（`negativeExclusionsAdvisory`）。
  - 快照写决策时的代码常量。
  - 补读按 created_at 排序、靠 `_ts >= since` 保持下标；画像返回空的公司不留任何标记。
- 未做：
  - 补读公司的主体被拒 / 无法重放仍计入本 run 的 `skippedSubjects` / `unreplayableSkips`，会把 run 判 PARTIAL（与 #649 相同，未改）。
  - 冷却只管补读候选：本 run 自己的公司画像失败后，下一个找到它的 run 照旧会重试。
  - 词边界匹配不做词干化，复数与复合词少命中：「pump」不再命中「pumps」，「großhandel」不命中「Pumpengroßhandel」。
  - 与并发 run 交错时，一家公司可能在 run 中途进入补读列表（例如另一个 run 把它当作自己的公司重新画像、记下尝试），让后面的下标错一位；后果只是本轮漏掉一家，或重读后跳过，不会重复抓取。彻底固定列表需要把每个 run 的补读名单落库，没有做。
  - 存量 lead：#649 之前计分的 lead 没有 `ruleVersion`，快照会如实标 `additive-6dim-v2`。要按 v3 交付，先对每个 ACTIVE ICP 调一次 `POST /icps/:icpId/qualify`。

## 2026-10-14 · Weekly lead report CSV with per-row DataRights EXPORT (BI-22, L4-lite) (#650)

- 起因：线索交付闭环设计（`docs/superpowers/plans/2026-10-10-lead-delivery-loop-design.md` §5、§11 的 L4）要给客户一份每周的线索 CSV，这次改为先于 L1–L3 实施的 L4-lite。改动前仓内没有任何导出或报表代码，OpenAPI 没有 `/reports` 路径，DataRights 的 `EXPORT` 动作定义了（`compliance/data-rights.types.ts:9`）却没有调用点，只有 accept 判 `STORE`（`lead/lead.service.ts`）。
- 改动：
  - **接口** `GET /api/v1/reports/weekly?icpId=&week=YYYY-Www`（`ReportController_weekly_v1`，`week` 缺省为本周，UTC、周一起）：返回 UTF-8 带 BOM 的 CSV，中文表头；行 = 该 ICP 下最新一条裁决是该周 accept（`lead_decision.action=accept`，复审后收紧，见下一节）、当前仍为 `QUALIFIED`/`CONTACTED`/`CONVERTED` 的线索；一周超过 1000 条返回 422 `WEEKLY_REPORT_TOO_LARGE`，不截断。
  - **列**（设计 §5）：公司名、域名、国家；贸易角色与置信度、自有制造、在售品牌（中国 / 非中国含产地）、登记号、税号（`attributes.website_profile`）；六维分、总分、Fit 结论；证据链接（`website_profile.source_url` 与联系路径 URL）；联系路径（`company_contact_point`，按设计 §7 优先级列 kind + url，不含 `INVALID`）；制裁状态；有效期至（`computeValidUntil`，与 accept 快照同一函数，只用公司级证据）；本条成本（列名写明「所属发现 run 合计，后端账本口径，未按线索分摊」）与所属发现 run ID；线索 ID；客户填写 5 列。「为什么现在」「原因码」「注册地址」「开发信草稿」先留空列。
  - **逐行判权与留痕**：历史合成来源的行隔离不出；制裁命中未经人工清除（库里的结果或实时筛查，规则与 accept 的第五门相同）的行不出；其余每行判 DataRights `EXPORT`（公司 `SUPPRESSED`、命中 domain/company_name 禁联记录、或没有任何证据 → `DENY`），每条判定都写 `policy_decision_log`（`subject_type=lead`、`actor_id`、`correlation_id` = 响应头 `X-Report-Id`；复审后被拦的行也写、日志改为独立事务，见下一节）。各类未导出计数见 `X-Report-Withheld-Rights` / `-Sanctions` / `-Quarantined`。
  - **CSV 防公式注入**：以 `=`、`+`、`-`、`@`（含前导空白与全角形式）以及 Tab、CR 开头的单元格加 `'` 前缀。编码器手写，不新增依赖。
  - **新 scope `acquisition:export`**：接口需要 `acquisition:read` + `acquisition:export`，`authz-openapi.spec.ts` 锁定 OpenAPI 的 `x-required-scopes`。
  - `DataRightsService` 新增批量 `logDecisions`；`data-rights.context.ts` 新增 `exportRightsContextForLead`（dataClass 恒 green：周报不读 `canonical_contact` / `contact_point`）。对接说明（`packages/contracts/INTEGRATION.md` 阶段 3 第 5 步）同步。
- 测试：
  - 先写失败测试，改动前 37 项失败（报表模块 5 个文件 32 项因模块不存在、DataRights 上下文 2 项、scope 词表 1 项、OpenAPI scope 锁 1 项、守卫拓扑 1 项），改动后全部通过；另补 `logDecisions` 1 项、未知标签不读原型 1 项。
  - 真库用例 `weekly-report.postgres.spec.ts` 3 项：一次性 PostgreSQL 跑完全部迁移，报表经生产 `PrismaService` 以 app_user 运行。本周 accept 的 3 条只导出允许的 1 条，禁联与无证据各写一条 `EXPORT DENY`、允许的写 `EXPORT ALLOW`；上周、accept 后被 reject、其他 ICP 的线索不进入；跨 workspace 的 ICP 返回 404、日志互不可见；app_user 改写 `policy_decision_log` 被拒。去掉留痕调用后真库用例与 3 项服务单测失败（变异检验）。
  - OpenAPI 重新导出无漂移；本地 `oasdiff breaking` 无 error（1 条 warning：`GET /whoami` 的 `scopes` 枚举新增 `acquisition:export`）。这个结论用的不是 CI 钉的 oasdiff 版本，CI 判为 error，修正见下一节。
- 未做：
  - 运行时的角色映射在环境变量 `AUTH_ROLE_SCOPE_MAP_JSON`（不在 `auth/scopes.ts`），本 PR 没有改：旧镜像不认识新 scope，提前写进去会让 API readiness 失败。新镜像上线后再给 `TENANT_OWNER`、`ADMIN` 加 `acquisition:export`。
  - 线索级分摊成本（设计 E4）、`LeadPackage` 读模型（L3）、反馈 CSV 上传（BI-23）、「为什么现在」等空列（L1、L2、L5、L6）。
  - 真库用例没有接进 CI（改 `ci.yml` 会触发全部重门）；本 PR 在 xin 的一次性 PostgreSQL 上跑过。
  - API 的 CORS 只暴露 `Location`、`X-Request-Id`、`ETag`，浏览器跨源读不到 `X-Report-*` 响应头。

## 2026-10-14 · Weekly report review fixes: an open whoami scope set, run cost bounded by the accept and by open reservations, the latest decision decides the week, and withheld rows are logged (#650)

- 起因：#650 的 CI 与独立复审。
  - 必需检查「contracts · drift · lint · breaking」红：CI 的 oasdiff（action v0.1.17 钉的 `tufin/oasdiff:v1.32.1`）把 `GET /whoami` 的 `scopes` 响应枚举新增 `acquisition:export` 判为 ERR（`response-property-enum-value-added`）。原 PR 本地跑的是另一版 oasdiff，只报 warning。
  - 复审另提 2 条 MEDIUM：成本列的 run 取「物化过这家公司的最新 run」，没限定在 accept 之前，同一周报不同时间导出结果不同、run 与成本归错；成本只加 `charged_microusd`，漏了 `reserved_microusd`（RESULT_UNKNOWN 或仍 RESERVED 的操作），会低报。以及 4 条 LOW：被拒后再 accept 的线索在两周重复出现；制裁 / 合成来源被拦的行不留痕；`csv.ts` 里的 BOM 是不可见字符；实时制裁筛查在长事务里占事件循环。
- 改动：
  - **whoami 的 `scopes` 不再以封闭枚举对外承诺**：`items.enum` 改为 `items["x-extensible-enum"]`（仍列出 `AUTHORIZATION_SCOPES` 的全部取值），字段说明写明集合会增长、客户端须容忍未列出的值。
    - 仓内没有 oasdiff 的 err-ignore 文件；唯一豁免机制是 PR 打 `breaking-change-approved` label，按 `packages/contracts/README.md` 要升主版本并写迁移说明。加 scope 不是真破坏，打 label 以后每加一个 scope 都要再打一次，所以改契约。这也是 oasdiff 报错信息里给的做法。
    - 对 GrowthOS：`frontend/growthos-work` 的源码里检索不到 `/whoami` 或 scope 字符串，GrowthOS 不消费这个字段。若有客户端按旧契约生成了封闭联合类型，重新生成后变成 `string`。
  - **成本列只认 accept 之前的 run**：所属发现 run = 该 ICP 下物化过这家公司、`created_at` 不晚于该线索 accept 时间的最新 run。之后的 run 不再改变已导出的周报；都在 accept 之后时，run 与成本都留空。
  - **预留未结不报成本**：run 的任一预算账户 `reserved_microusd > 0` 时成本留空，与「任一账户缺失则留空」同一口径。
  - **按最新裁决入周**：只选最新一条 `lead_decision` 是 accept 且落在本周的线索。查询加「本周之后没有裁决」的预过滤，再按选出的最新一条裁决精确判定。被拒后再 accept 的线索只出现在最后一次 accept 的那一周。
  - **被拦的行也留痕**：历史合成来源、制裁命中未清的行各写一条 `EXPORT DENY`（reason `synthetic_quarantined` / `sanctions_hold`，`rule_id` 为空、`rule_version` 为空串，与引擎的 `suppressed` / `no_evidence` 同形），`correlation_id` 同为报表 id。`policy_decision_log` 对 `reason` 没有约束，真库验证可写。
  - **实时制裁筛查挪出事务**：读放在一个短事务里；筛查（内存索引上的 CPU 工作）和逐行判定在事务外做，同一报表内按 (name, country) 去重；所有判定随后在独立事务里一次写入，提交后才返回 CSV。
  - `csv.ts` 的 BOM 改写成转义 `﻿`。
  - 对接说明（`packages/contracts/INTEGRATION.md` 阶段 3 第 5 步）同步。
- 测试：
  - 先写失败测试，改动前 10 项失败、改动后全部通过：
    - whoami 契约 1 项（`authz-openapi.spec.ts`：`scopes.items` 无 `enum`、`x-extensible-enum` 等于 scope 词表）；BOM 转义 1 项；
    - 服务 8 项：查询带预过滤和最新裁决的 select；最新裁决不是本周 accept 的不入；合成来源写 DENY 且不去筛查；制裁命中写 DENY；筛查在事务外、按名称 + 国家去重，日志写在事务内；accept 之后的 run 不计；run 都在 accept 之后时留空；有预留时留空。
  - 真库用例补上 outcome → run → receipt → account 链，治理血缘上游（admission、batch、Q item、governed subject / relation）用 `session_replication_role = replica` 跳过外键与行触发器（与 materialization activation 用例同法），CHECK 照常生效。共 4 项：
    - 导出行的成本是 accept 前那个 run 的 2.840000，accept 后的 run（9.000000）不计，账户经 RLS 以 app_user 读到；
    - 预留未结的 run 成本留空、run ID 照出；
    - 合成来源写 `synthetic_quarantined`；
    - W40 accept、拒、W41 再 accept 的线索只在 W41 出现，W40 报表 0 行、0 条日志。
    - 用 PR 原来的服务代码跑这份用例 3 项失败，新代码 4 项通过（xin 一次性 `pgvector/pgvector:pg16`，全部迁移，app_user）。用例不进 CI，手动运行命令写在用例文件头。
  - oasdiff：用与 CI 同版的 `tufin/oasdiff:v1.32.1` 对 origin/main 的契约跑 `breaking --fail-on ERR` 通过；在新契约上再加一个 scope 也不报（以后加 scope 不再触发）。
  - `src/report`、`src/compliance`、`src/auth`、`src/whoami` 31 个文件 284 项通过。
- 未做与被替换的旧设计：
  - 被替换：「run = 物化过这家公司的最新 run」→ 限定在 accept 之前；「金额 = `charged_microusd` 之和」→ 有预留时留空；「accept 落在本周即入」→ 看最新一条裁决；「被拦的行不写 `policy_decision_log`」→ 写 DENY；「读、判定、日志在同一个最长 30 秒的事务里」→ 短读事务 + 事务外判定 + 日志事务（CSV 仍只在日志提交后返回）。
  - 422 的 1000 条上限按候选计数（本周有 accept、且本周之后没有裁决），不是按最终行数。
  - 真库用例仍不接 CI（不改 `ci.yml`）。

## 2026-10-14 · Bring status, roadmap, ADR and governance records up to the 2026-10 decisions (#651)

- 起因：2026-10-13 未完成任务评审稿 §3.2 核实 12 份权威文档过时——`docs/status/current.md` 停在 2026-09-20、仍写「推进 R4 到最终 hosted」（与 PRD4-D2 相反）；`release-plan.md` 仍以 Pilot 3-A 的「zero model / paid / send」「named-person collection disabled」为约束；ADR 与冲突登记没有任何 2026-10-10 起的决定；7 个计划生命周期头过期；AGENTS §7 的晋级门已成死锁却无记录。
- 改动（纯文档，不改代码、脚本、迁移与机器合同）：
  - `docs/status/current.md` 重写为一页 RL1 当前状态，按「做了什么（四态）/ 证据 / 谁验收 / 怎么回退」组织：11 次验收 run 全 FAILED 及逐次倒下阶段与修复 PR、评分与制裁门从未在验收数据上执行、可达性结构上为 0、GrowthOS 自 09-01 起从未 ACK、卖方入驻官网抓取自 08-24 被 HOLD、生效决定与在途 PR。G0–G7 表与 platform-writer 历史费用段保留。2026-09-20 旧正文原文移入 [`docs/archive/status/current-20260920.md`](../archive/status/current-20260920.md)（successor 指针：status 的「历史（2026-09-20 核验）」一节）。
  - `release-plan.md` 头部加覆盖横幅与 RL1–RL6 结构（只列退出指标名称）；稳定路线的结构契约测试不允许新增标题，所以放在横幅里。
  - ADR registry：ADR-001…024 行首补状态字，说明 Site 线 D9/D13 与 PRD 4.0 同号异义并改用 `PRD4-` 前缀，新增「PRD 4.0 决定」一节（PRD4-D2、D3、D9、D14、D16 与 PRD4-BI14 可达性改为公司级联系路径）。
  - 冲突登记 §11.1 登记 PRD4-D1…D19 的状态与拍板日期。
  - 计划生命周期：10-09 三份与 10-10 平台 schedule 设计改 `CLOSED`（#619/#621、#618/#623、#617、#629），09-13 两份与 09-19 一份 R4 计划改 `SUPERSEDED`（PRD4-D2）。
  - AGENTS §6 登记制裁运营刷新例外；§7 登记 PILOT/GA 晋级门死锁（approval/readback 回读器已由 #566 移除，`scripts/governance-delivery-contracts.mjs` 恒阻断），指向待拍板的 PRD4-D12，不改脚本。
  - CONTRIBUTING（DEC-AIDEV-004、5 项必需检查、合入即删 worktree、去掉 Codex 自动审查）、`packages/contracts/INTEGRATION.md`（删 dev base64 token 与 sandbox 段，交付对象改为 GrowthOS + 周报 CSV，事件按注册表分集成事件与内部命令）、导航指南模块地图、architecture/current（头部 20 条 Site / Copy 历史横幅原文移入 [`docs/archive/architecture/current-site-builder-banners-20260809.md`](../archive/architecture/current-site-builder-banners-20260809.md)；§6 事件以 `event-registry.ts` 为准，6 个内部命令 / 10 个集成事件）。
- 验证：`pnpm docs:verify` 通过；`governance-document-drift`、`governance-contracts`、`environment-parity-policy`、`model-candidate-baseline` 四个 spec 共 336 项通过；`gctl check` 通过（见 PR）。
- 未做：
  - PRD 4.0 本体仍在私有目录（PRD4-D10 未拍板），本条只回写仓内文档；L0 宪章里与 D16、D13、D7 相矛盾的段落要在 PRD 4.0 里同步。
  - `docs/product-scope.md` 的可达性定义随 #649 修改；RL1 计划 §15 第 6 行「snapshot_version 2」与已批准设计 E1「仍为 1」的矛盾在私有计划里，未改。
  - 晋级门死锁、`docs/site-builder/01-prd.md` 仍标 CURRENT 等，分别等 PRD4-D12、PRD4-D1 拍板。

## 2026-10-14 · Erase every stored version of a personal-data object, not only the versions the ledger recorded (W11-f) (#659)

- 起因：#647 复审的 MEDIUM。复用刷新在数据库结算**之前**就把对象复制到自身、生成新的当前版本；结算没落库时（进程在两步之间死掉、擦除围栏以 `SUBJECT_TOMBSTONED` 回滚、复制 ACK 丢失被 fail-open 当作失败、复制后 HEAD 报错或漂移），这个版本不进版本账本。擦除只删「账本 ∪ 钉子」里的版本，删不到它，被擦除主体的 PERSONAL_DATA 最长约 2 天仍可读（直到生命周期按年龄清掉）。#647 之前复用分支从不写对象，没有这个缺口。
- 改动（详见 [docs/backend/generic-operation-artifact-storage.md](../backend/generic-operation-artifact-storage.md) 3.1 节）：
  - **擦除端口**（`personal-artifact-cleanup.store.ts`）：`deleteFinalVersion` 改为 `eraseFinalObject`。每执行一条清理命令，都对该摘要派生的 PERSONAL_DATA 最终键做 `ListObjectVersions`（前缀为精确键、`MaxKeys` 1000 分页、只取 `Key` 全等的条目、上限 1 万条），删掉这个键的全部版本与删除标记：先确认每个对象版本都带唯一的 `artifact-privacy=PERSONAL_DATA` 标签（任一不符整键拒绝、一个不删），再按「非当前版本 → 当前版本 → 删除标记」的顺序删，保证任何时刻都没有旧版本复活为当前版本；删完再列，并发复制又落地就再扫，3 轮仍不空则本次失败、交给命令的持久重试。回执是命令所记版本的状态：擦除时在桶里为 `DELETED`，已不在为 `ABSENT`。账本与命令表只作审计与回执。
  - **端口合同**（`personal-artifact-cleanup.contract.ts`）：接口注释改为「按键删全部版本、不依赖账本完整」，服务流程（claim → 擦除 → complete / retry）不变，数据库函数与 schema 都没有改。
  - **MinIO 策略**（`infra/minio/bootstrap.sh`）：清理 principal 新增 `s3:ListBucketVersions`，条件 `s3:prefix` = `generic-operation-results/v1/final/personal-data/*`；整桶、其它隐私类前缀与 staging 的列出仍被拒绝。`scripts/runtime-deployment-contract.spec.mjs` 钉住这条授权且只此一条、没有 `s3:ListBucket`。
  - **readiness**（`personal-artifact-cleanup.runtime.ts`）：`GetBucketLocation` 之后再列一个不存在的 PERSONAL_DATA 键（全零摘要）的版本；没有列出授权时 Worker 以 `PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE` 不就绪，而不是让擦除在后台无限重试。
- 测试：
  - 先红后绿，真 MinIO（一次性容器 + 仓库 `bootstrap.sh` 原样建桶与三个 principal）：`personal-artifact-cleanup.minio.spec.ts` 重写为 9 项，改动前 8 项红——复制出的未入账版本在擦除后仍在、只命令当前版本时旧版本复活、删除标记下的版本残留、别人写入的版本残留、清理 principal 列出被拒、readiness 不查列出授权、只查命令版本的标签、共享对象的另一份清单仍能读到字节；改为新策略后在**同一个已部署实例**上重跑 `bootstrap.sh`（幂等，返回 `OBJECT_STORAGE_PROVISIONED`），9 项全绿。其中「共享对象被一个主体擦除后，另一行清单的 `readVerified` 得到 `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`」钉住重放按结果未知处理的前提。
  - 先红后绿，真库（`generic-operation-artifact-object-version.postgres.spec.ts`，一次性 pgvector:pg16，以 app_user 跑，CI 已在跑这个文件）：新增 1 项，用真实的命令仓储与服务、擦除端口接新的内存版本桶夹具：账本两版本 + 一个未入账的当前版本，三次 `cleanup` 依次得到 `DELETED`、`ABSENT`、重放 `COMPLETED`，桶里该键一个版本也不剩、过程中当前版本从未回到旧版本，命令表两条 `COMPLETED` 回执与账本内容如实。改动前红（第二条命令回 `DELETED`、桶里留着未入账版本），改动后 5 项全绿。
  - 单元（零容器）：`personal-artifact-cleanup.store.spec.ts` 按新接口重写为 26 项（删除顺序、分页续接、只碰精确键、并发复制再扫、轮数上限、标签整键拒绝、读标签时版本已消失、桶不存在 / 列出被拒不当作 ABSENT、删除回执版本不符拒绝、列出结构异常拒绝、readiness 探针）；新增内存版本桶夹具 `personal-artifact-cleanup.versioned-bucket.test-fixture.ts`（按 MinIO 语义：删当前版本让下一个版本成为当前）；runtime spec 新增「无列出授权时不就绪」；contract spec 随端口改名。
- 被替换的旧设计：#647 的「擦除为账本 ∪ 钉子里的每个版本各删那一个精确版本、擦除端口与其权限不变」。清理命令仍按账本版本逐条建、逐条回执，但删什么由桶的列出决定。
- 未做：
  - 命令表不记录被扫掉的未入账版本（数量或版本号），回执只针对命令所记的版本。
  - 清理命令全部完成之后，另一主体再次抓到同样字节会走全新写入，它的结算被围栏永久拒绝（#647 之前就有的行为）；这个对象不属于已完成的擦除请求、不会再被扫到，按年龄过期（PERSONAL_DATA 最长约 2 天）。
  - 真 MinIO spec 不在 CI 跑（CI 没有 MinIO），手动运行方式见 PR 正文。
  - xin 上的清理策略要由运行时会话重跑 `minio-bootstrap` 才更新，必须在换到含此改动的镜像之前做（见存储文档第 5 节）。

## 2026-10-14 · Erasure review fixes: the cleanup credential lists one full key only, an unacknowledged delete is read back, and an attempt stops at a time budget and resumes after a timeout (#659)

- 起因：#659 的独立复审（1 条 MEDIUM、3 条 LOW）。
  - MEDIUM：清理 principal 新加的 `s3:ListBucketVersions` 条件是 `personal-data/*`，它能列出全部 PERSONAL_DATA 键；它本来就有 `s3:GetObjectVersion`，单凭这一个凭据就能批量读出所有个人数据对象。复审在一次性 MinIO 上实测可列可读。
  - LOW：删一个已经不在的版本时 MinIO 回 204、不带 VersionId，适配器当作 `STORE_UNAVAILABLE`，多等一轮至少 30 秒的重试（夹具回显 VersionId，单测碰不到）；真 MinIO 用例「不让旧版本复活」只看最终为空，删除顺序反过来也通过；请求数随版本数 × 轮数增长，而活动只跑一次、2 分钟超时，超时的 rootCause 不是 `STORE_UNAVAILABLE`，工作流直接失败，命令停在 CLAIMED。
- 改动：
  - **列出授权只匹配完整键**（`infra/minio/bootstrap.sh`）：条件改为 `generic-operation-results/v1/final/personal-data/sha256/??/` 后接 64 个 `?`，清理凭据只能列出调用方已经从数据库拿到摘要的那一个键。readiness 探针（全零摘要的键）照常匹配。`scripts/runtime-deployment-contract.spec.mjs` 钉住这个精确值，且整份策略只有一个 `s3:prefix`。
  - **未确认的删除先读回**（`personal-artifact-cleanup.store.ts`）：删除回执没有 VersionId 时，按版本号读那个版本的标签：确认不在（`NoSuchVersion`）就继续，还在或读不准就本次失败。不能直接当成功：下一个要删的可能是当前版本，万一旧版本其实还在就会复活。
  - **每次尝试 60 秒时间预算**（`ERASE_TIME_BUDGET_MS`）：超时后不再发新请求，本次失败、命令走 RETRY（attempt 加一、写 `last_error_code`），工作流退避重放，下一次重新列出、接着删。适配器新增可选的 `now` 时钟供测试注入。
  - **工作流把活动的 `START_TO_CLOSE` 超时当作可恢复**（`personal-artifact-cleanup.workflow.ts`）：与 `STORE_UNAVAILABLE` 同走退避 + `continueAsNew`。典型场景是 Worker 在擦除中途死掉；claim 会重新领取 CLAIMED 的命令，擦除幂等。其它失败（非重试的应用错误、其它类型的超时）照旧让工作流失败。
  - 夹具按 MinIO 实测改为「删不存在的版本回 `{}`」，并加 `removeElsewhere` 模拟别的请求或生命周期删掉版本。
  - 存储文档 3.1 节补上这三条与完整键授权的理由；第 5 节写明漏跑 `minio-bootstrap` 直接换镜像时，清理 readiness 是 understanding Worker 的硬检查，整个 Worker 不 poll，不只是擦除停。
- 测试：
  - 先红后绿，真 MinIO（一次性 `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`，按 digest，只绑 127.0.0.1，`mc` 跑仓库 `bootstrap.sh`）：`personal-artifact-cleanup.minio.spec.ts` 10 项。
    - 用 PR 原 `bootstrap.sh` 与原适配器：2 项红。清理凭据列 `personal-data/`、`personal-data/sha256/`、两位分片目录、少一个字符的键前缀都没被拒绝；另一请求抢先删掉已列出的版本后，擦除报 `STORE_UNAVAILABLE`，且 MinIO 对这次删除的回执确实不带 VersionId。
    - 在同一实例上重跑新 `bootstrap.sh`、换新适配器后 10 项全绿（readiness 探针在新条件下仍就绪）。
    - 「不让旧版本复活」改为每次删除后用 root 读一次当前版本，断言依次是 `[刷新出的版本, null]`；把删除顺序临时改成先删当前版本，该项变红（读到了旧版本），复原后绿。
  - 单元（零容器）：store spec 新增 3 项（抢先删除后继续且先读回再删下一个；未确认且版本仍在时停在当前版本之前、一个不删；慢存储用尽 60 秒预算后不再发请求、当前版本未动，下一次尝试接着删完回 `ABSENT`），改动前 2 项红；workflow spec 新增 5 项（`START_TO_CLOSE` 超时直接与经 wire 往返两种都退避重放；非重试错误、`SCHEDULE_TO_CLOSE` 超时仍失败；活动超时 2 分钟不小于预算的两倍），改动前 3 项红。两份 spec 共 39 项通过。
  - `node --test scripts/runtime-deployment-contract.spec.mjs` 16 项通过（改条件前红）。
  - 真库 spec（`generic-operation-artifact-object-version.postgres.spec.ts`）走的删除都针对存在的版本、第二条命令列出为空直接回 `ABSENT`，不经过本次改动的分支，本地未重跑，由 CI 的 PostgreSQL 作业覆盖。
- 被替换的旧设计：本 PR 前一条记录里的 `s3:prefix` = `generic-operation-results/v1/final/personal-data/*` → 完整键模式；「删除回执不带 VersionId 一律失败」→ 读回确认；「一次尝试不限时，超时即工作流失败」→ 60 秒预算 + 超时退避重放。
- 未做：
  - 版本多到 60 秒内连标签都读不完的键（按单请求上限 2.5 秒约 23 个版本，正常延迟下远多于此）每次都在删除前用完预算、不会有进展，会按退避一直重试（命令表 attempt 递增、可见）。为保住「先确认全部标签再删」的整键拒绝语义，没有改成边读边删。
  - `docs/implementation-records/generic-operation-artifact-replay.md` 第 106 行仍写清理 principal 没有列出权限；它是历史实施记录，不改。

- 第二轮复审（修复增量）：
  - MEDIUM：上一条「只匹配完整键」用的是普通 `StringLike`。同一请求可以重复 `prefix` 参数，MinIO 只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出，所以「短前缀 + 完整键」仍能列出全部个人数据键（复审在一次性 MinIO 上实测）。
  - 改动：清理 principal 的列出授权改为 `ForAllValues:StringLike`，并加 `"Null": {"s3:prefix": "false"}`（`ForAllValues` 对空集合按真处理，不加 `Null` 时不带 `prefix` 的请求可能被放行）。运行时 principal 列 `readiness/*` 的授权在 main 上原本也是这种写法，同一文件里一并改掉，避免重跑两次 bootstrap。复审测过「保留 Allow、再加一条 `ForAnyValue:StringNotLike` 的 Deny」，无效，所以没有用。
  - 测试：`runtime-deployment-contract.spec.mjs` 钉住两条授权都是 `ForAllValues` 加 `Null`，并且两段策略里都不再有普通 `StringLike` 前缀条件；先红后绿，16 项通过。真 MinIO spec 新增「重复 `prefix`（短前缀加完整键、空前缀加完整键）必须被拒」两项：一次性 MinIO（同一 digest，开发用 KMS 密钥现场随机生成）上用原策略跑红 1 项，换新策略后 10 项全绿。
  - 上线顺序不变：先由运行时会话重跑 `minio-bootstrap`，核对清理凭据「列精确键允许、列 `personal-data/` 拒绝、重复 `prefix` 拒绝」，再换镜像。如果 xin 已经按本 PR 早先的策略跑过 bootstrap，要用最终版本再跑一次。

## 2026-10-14 · Replace the single-file changelog with one fragment per PR, assembled later (#658)

- 起因：每个 PR 都在 `changelog.md` 的同一处插入小节（最早是顶部，后来是当天小节末尾），任何一个合入都会让其余在途 PR 文本冲突。
  - #596–#643 合入的 47 个 PR 里 45 个改了 `changelog.md`；47 个里有 24 个带着并入 main 的合并提交（共 32 个），每次并入都要再跑一轮完整 CI。派活方统计其中 22 次是这类冲突逼出来的，26 轮 merge-head CI 共 509 分钟（这两个数没有逐一复核）。
  - ruleset 的 strict 在 2026-09-21 已关闭，这些并入不是 GitHub 要求的，只是为了解冲突。2026-10-14 起草时有 8 个在途 PR（#597、#646–#652）改 `changelog.md`；2026-10-15 开这个 PR 时还剩 2 个（#597、#651）。
  - 被替换的设计：「单文件 changelog，每个 PR 直接插入小节」（Codex 时期沿用至今）。冲突是这个设计的结构性结果，与 PR 内容无关，在途 PR 越多越严重，所以整体替换，不再靠「插到当天末尾」之类的约定减轻。
- 改动：
  - **片段目录** `docs/roadmap/changelog.d/`：每个 PR 放一个 `<YYYY-MM-DD>-<slug>.md`，frontmatter 写 `date` / `pr` / `title`，正文依次写起因 / 改动 / 测试 / 未做。目录 README 写明格式、何时必需、slug 取分支 topic 以免撞名、汇编方法。`pr` 可以留空：汇编时从加入片段的 squash 提交标题里的 `(#N)` 取，不必为补 PR 号再推一次（本条目就留空）。
  - **校验** `scripts/governance-changelog-fragments.mjs`：文件名、frontmatter（只允许三个键、日期须为真实日期且与文件名一致、PR 号为正整数或空、标题不带 `#` 与 `(#N)`）、正文四项的顺序与内容、正文不得有一二级标题、目录里只能有 README 与片段。`pnpm docs:verify` 调用它（`scripts/verify-docs.mjs`），片段改由 frontmatter 承担元数据，免去 `docs/roadmap/` 的「生命周期」行要求。报错直接给出应写成的样子：键名大写、冒号后缺空格、缩进、BOM 各有自己的提示，正文错误给文件里的行号，缺顶层条目时说明顶层条目的写法。
  - **必需检查**：同一脚本的 `require` 子命令按 `git diff --name-status --no-renames <base>...<head>` 判断：改了 `apps/`、`packages/`、`scripts/`、`infra/` 任一路径或根目录的构建与运行时文件（`CODE_ROOT_FILES`，见下文复审一轮）时，必须新增或修改一个片段；只删片段、只改 README 不算。`governance.yml` 的 checkout 改为 `fetch-depth: 0`，新增只在 `pull_request` 上运行的一步（push 到 main 时跳过），传 `base.sha` 与 PR 的 `head.sha`，并用 `!cancelled()` 让它与 `governance:verify` 在同一轮里各自报错；算不出 diff 时失败而不是放行。
  - **过渡**：直接改 `changelog.md` 的 PR，`require` 照样放行，只在日志里出一条 `::warning::` 指向片段格式，在途 PR 不会因此变红、也不必返工。放行不看 PR 何时开，关闭条件见下文复审一轮。
  - **汇编** `scripts/changelog-assemble.mjs`（`--dry-run` 只列不写）：按日期倒序插入，同一天的条目接在当天已有小节之后、按 PR 号升序；片段里按片段目录写的相对链接改写成从 `changelog.md` 出发的路径；写入后删除片段。任何片段不合格时什么都不写。每班发版列车的 PR 合完后，由当班负责合并的开发代理运行一次，单独作为 `docs(changelog)` PR 提交，不由 bot 直接提交 main。
  - 规则同步：`AGENTS.md` §9、`CONTRIBUTING.md` 新增「Changelog 片段」一节、PR 模板加一项勾选、`changelog.md` 开头加写法变更说明；`docs/backend/ci-merge-automation.md` 新增「Changelog 片段的汇编」一节（谁、何时、四步、冲突处理、回退），原来那句「changelog 冲突」指向它。本条目是第一个片段。
- 测试：
  - 先写 `scripts/governance-changelog-fragments.spec.mjs` 的 22 项用例，实现前因模块不存在整体失败；工作流与 `verify-docs` 接线的 2 项在改这两个文件之前单独失败过。复审时再加 4 项、并在 2 项里加断言（可读报错 3 项、汇编步骤写进合并流程文档 1 项；过渡期 warning、单个片段的单数措辞），先跑出 6 项失败，修好后 26 项全部通过：
    - 解析：完整片段、`pr` 留空或缺省、带引号与含冒号的标题；22 种畸形输入各报自己的错误码；额外顶层条目、ASCII 冒号与代码块里的 `##` 不误报；键名大写、冒号后缺空格、无法解析的行、BOM、正文二级标题的行号、`* 起因：` 与非法文件名各自给出可照做的提示；
    - 必需判定：四个前缀各自触发；新增或修改片段、改 `changelog.md` 都算满足；只删片段、只改 README、纯文档与 `.github/` 改动的各自结论；
    - 汇编：跨日倒序、同日接在已有条目之后并按 PR 号升序、无 PR 号排最后；没有片段时输出与输入逐字节相同；早于所有条目的片段落在无日期的旧尾部之前；相对链接改写；
    - 临时 git 仓库里的两个命令：`require` 在 main 于分叉后前进时只看 PR 自己的改动，加片段前失败、加片段后通过，只改 `changelog.md` 的旧式 PR 通过并带 warning，base 不存在时失败；汇编命令 `--dry-run` 不写文件，从 squash 提交补上 PR 号，取不到时不带号并提示，片段不合格时不动任何文件、修好后正常写入；
    - 本仓的片段合格；`governance.yml` 的步骤形状、`verify-docs` 的接线、合并流程文档里的汇编一节。
  - 该 spec 由 `scripts/governance-contracts.spec.mjs` 引入，随 `governance:verify` 在 CI 的 governance 工作流与 `docs:verify` 中运行。
  - 过渡期回放：对 2026-10-15 的 2 个在途 PR（#597、#651）跑 `require`，都因改了 `changelog.md` 通过；对 main 最近 60 个 squash 提交逐个回放，56 个通过、2 个纯文档不需要（#625、#626），2 个只改测试且当时没写 changelog 的（#634、#637）在新规则下需要补片段。
  - 对本仓真实 `changelog.md` 预演汇编（在副本上运行）：本片段落在 2026-10-14 最后一节（#655）之后、2026-10-13 之前，其余内容逐字节不变。
  - 本分支对 `origin/main` 跑 `require`：识别出本片段，通过。
- 未做：
  - 没有改 ruleset，strict 维持关闭。
  - 没有自动汇编：不加 bot、不加定时任务，片段会在目录里累积到下一班发版列车后有人运行汇编为止。
  - 不校验片段里的 `pr` 是否等于当前 PR 号。
  - `.github/` 与根目录的文档、编辑器和密钥扫描配置不在必需范围里：只改这些的 PR 不强制写片段。
  - fork 来的 PR 可以连同检查脚本一起改，这一步和其他 `pull_request` 检查一样只防遗漏、不防恶意。
  - 仓外的 `/global/CLAUDE.md` §7 与派活脚本里「在 changelog.md 当天小节末尾新增小节」的写法，要在本 PR 合入后改成写片段，不在本 PR 内。
- 复审一轮（#658 独立复审 1 条 MEDIUM、5 条 LOW）：
  - 起因：复审指出片段的生命周期豁免硬编码在 `verify-docs.mjs`、没进机器政策也没登记例外，治理页 `docs/governance/docs-verification.md` 不知道新检查的存在（M1）；汇编按最早一次加入提交取 PR 号，片段名在汇编后被重用会拿到旧 PR 号（L1）；没有用例钉住三点 diff（L2）；过渡放行的 warning 暗示有开 PR 日期判断、实际没有，也没有关闭条件（L3）；`Dockerfile`、`runtime-entrypoint.mjs` 等根目录运行时文件不在必需范围（L4），#661 就是只改根目录 `docker-compose.yml` 的 PR；尖括号目标、单引号标题与引用式定义的相对链接汇编时不改写（L5）。
  - 改动：
    - M1：豁免移进 `docs-verification-policy.json` 的 `lifecycleRequired.frontmatterFragmentDirectories`，`verify-docs.mjs` 改用 `lifecycleExemptFragment(policy, path)`，删掉该项片段就重新要求生命周期行；政策列了 `changelog.d` 以外的目录时报 `CHANGELOG_FRAGMENT_POLICY`。治理页 §1 写明 governance 工作流在 `pull_request` 上多跑 `require` 一步，§2 新增「Changelog 片段格式」「代码 PR 的 changelog 片段」两行，§3 写明政策豁免，§4 登记两条例外（片段免生命周期行、过渡放行），各带风险、Owner、关闭条件与 successor。
    - L1：`prFromHistory` 改取最近一次加入该文件的提交；片段 README 改正「同日同 slug 必然冲突」的说法（前一个片段已汇编时不冲突）。
    - L3：warning 改为「只在过渡期接受」，不再说「规则生效前开的 PR」；放行处加注释，关闭条件写进治理页 §4、片段 README 与 `CONTRIBUTING.md`：仓外 `/global/CLAUDE.md` §7 与派活脚本改为写片段后，删除 `|| changelogEdited`。
    - L4：新增 `CODE_ROOT_FILES`（`.dockerignore`、`Dockerfile`、`docker-compose.yml`、`eslint.config.mjs`、`nx.json`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`runtime-entrypoint.mjs`、`tsconfig.base.json`），只认根目录同名文件；`AGENTS.md` §9、`CONTRIBUTING.md`、PR 模板、片段 README 与工作流注释同步。根目录 `package.json` 与 `pnpm-lock.yaml` 原先在「未做」里被排除，这次一并纳入：它们进运行时镜像，改它们的 PR 本来就要有人补 Copy 重签。
    - L5：链接改写支持 `[t](<目标>)` 与单引号标题；引用式定义与脚注定义在片段里直接拒绝（`CHANGELOG_FRAGMENT_LINK`），因为 `docs:verify` 不检查它们、汇编也不改写。
  - 测试：先写 9 项新用例并改 2 项既有用例（过渡 warning、`verify-docs` 接线），在只导出空桩的实现上跑出 10 项失败（除三点 diff 用例外的 8 项新用例与改过的 2 项），补实现后 35 项全部通过：根目录运行时文件触发必需判定且只认根目录；仓库根目录每个被跟踪文件都已归类（新增根文件不归类即失败）；尖括号与单引号链接改写；引用式与脚注定义被拒并给出行号、代码块与行内代码里不误报；过渡 warning 不再声称有开 PR 日期判断；汇编后重用片段名取 #705 而非 #700；政策豁免与政策漂移各自的判定；`verify-docs` 接线与政策内容；治理页 §1/§2/§3/§4 的记录。三点 diff 用例（main 在分叉后合入 `apps/` 改动、PR 只改文档）在现实现上本来就通过，把 `...` 临时改成 `..` 后它失败，确认能抓住这个变异。`pnpm docs:verify` 0 错误。
  - 未做：没有给过渡放行加开 PR 日期判断或截止日期，派活指令改掉之前加门会让照旧写法的新 PR 变红；仓外指令的修改不在本 PR 内。

## 2026-10-13 · Let best-effort stages skip a company whose operation cannot be replayed, time-box enrichment, and rehearse a full-size run

- 起因：卖方 #23 的验收 run（`c3878e54`，xin，2026-10-12 22:47–10-13 01:23 UTC）跑完查询、官网画像、fit（#640 的时间盒生效，分约 10 批判完 84 家）和富集后，在信号富集阶段失败。
  - 一次 `http.get` 的结果没能存成产物（`ArtifactStorageError`，日志里没有错误码）。
  - broker 按设计把它改成 `BudgetOperationReplayError`（控制错误）：这次请求已经发出、却没有持久结果，绝不能再发一次。
  - Temporal 重试时撞上同一个操作，整个 run 失败。信号富集本是尽力而为的阶段，却因为一家公司失败了。
  - 产品负责人 2026-10-13 选定「系统性修复后再跑」：尽力而为的阶段按公司跳过并计数，日志补错误码，富集加时间盒，再写一个按真实耗时与故障率预演整个 run 的测试。D13（让重试本身安全）放到验收通过之后。
- 改动：
  - **尽力而为的阶段跳过无法重放的公司**：官网画像、信号富集、网站监控遇到 `BudgetOperationReplayError` 时，跳过这一家并计数，不再让 run 失败。
    - 跳过的公司不写任何属性；已产生的回执照常确认，与被拒主体的处理方式一致。
    - 连续两家都无法重放，就视为存储或上游故障，阶段照旧失败，run 判 FAILED。官网画像的这条规则用 `previousUnreplayable` 跨活动传递。
    - 只有一家公司参与时，它失败只记跳过，不判失败。
    - run 统计新增 `unreplayableSkips`（按阶段计数，只在有跳过时出现），有跳过时至少 PARTIAL（`resolveRunStatus`）。
    - 核心阶段（查询、fit、富集）不变，仍然 fail closed。
  - **富集的时间盒**：`enrichRun` 也按时间盒交接（`ENRICH_PASS_TIME_BOX_MS` 60 秒，跑在 2 分钟的代理上）。候选列表改为按 id 全序、上限 50 家，用 `startIndex` 续接。工作流循环调用并合并计数与源名；某一批报告 run 预算用完后不再续接。
    - #23 实测 GLEIF 每次读取平均 0.66 秒、最长 1.67 秒，一家至多 4 次读取。
  - **产物存储失败的日志**：`GenericOperationArtifactExecution.persist` 失败时记录 schema、操作 id 和有界的存储错误码（`GENERIC_OPERATION_ARTIFACT_*`），不记原始错误信息（可能带端点或对象键）。broker 是受保护文件，没有改。
  - **预演测试** `discovery.rehearsal.spec.ts`：
    - 真实的 `discoveryWorkflow` 驱动官网画像、fit、富集、信号、监控的真实活动代码，跑一个 100 家公司的内存工作区；
    - 模型调用、抓页和登记读取按 xin 实测的耗时（含最慢的尾部）推进模拟时钟，每次活动调用按它所走代理的 startToCloseTimeout 计时；
    - 三个场景：
      - 实测耗时加上互相隔开的单点故障（一次流截断、一家画像、一次信号无法重放），每个活动都在时限内，run 判 PARTIAL；
      - 每次调用都慢一倍，仍在时限内，run 判 DONE；
      - 信号阶段全部无法重放，run 照旧判 FAILED。
    - 不依赖 Temporal、数据库与网络，几秒跑完。
    - 代理时限从工作流源码读取，与 `discovery.workflow.timeouts.spec.ts` 共用 `testing/discovery-activity-timeouts.ts`。
  - 对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）补了 `stats.unreplayableSkips`。
- 测试：
  - 先写失败测试：
    - 活动侧：信号 3 项、监控 2 项、官网画像 5 项、富集时间盒 6 项；
    - 工作流侧 5 项；
    - `resolveRunStatus` 2 项；
    - 产物日志 2 项。
    - 改动前 24 项失败，改动后全部通过。三处固定返回结构的旧用例补上了新字段。
  - 预演测试的变异检验：
    - 关掉 fit 的时间盒（#22 的缺陷），三个场景全部失败；
    - 关掉信号的跳过（#23 的缺陷），单点故障场景失败。
    - 说明它能在上线前发现这两类问题。
- 未做：
  - D13：让活动重试本身安全（等「还在进行」的调用结算；把「已结算、无结果」和确定的失败当作这一家失败）。这要改受保护的模型网关与 broker，按产品负责人决定放在验收通过之后。
  - 爬虫已回 500、出口被拦（请求根本没发出）这类确定的失败，broker 仍保留预留、不结算，与 D13 一起处理。
  - 开发快速通道（xin 上用本地代码起的 worker 处理测试租户的 run，不经发布与换镜像），按产品负责人决定放在验收通过之后，单独 PR。
  - 预演测试不模拟 Temporal 的重试与预算账本，所以测不出「重试撞上旧尝试还在进行的调用」这类问题，那属于 D13。

## 2026-10-13 · Let a retry recover a query or a fit company whose operation cannot be replayed (stage-level D13)

- 起因：卖方 #25 的验收 run（`57529327`，xin，2026-10-13 08:22–08:37 UTC）在第 6 条查询失败。
  - 一次公司抽取的流里带了上游错误事件（`ProviderTransportError: CHAT_COMPLETIONS_STREAM_UPSTREAM_ERROR`），这类传输错误按 #639 的设计照旧 fail closed，活动失败；
  - 重试撞上同一个操作，报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，整个 run 失败。
  - new-api 的日志显示，这是 openox.tech 在第 33 秒提前结束了流（`reason=eof`，0 个输出 token）。10-11 以来 867 次流式调用里断了 3 次：两次 `scanner_error`（`unexpected EOF`、`tls: bad record MAC`），一次 `eof`。new-api 自己的时限（流空闲 300 秒、整体不限）远大于我们最长的 134 秒调用，断流不是 new-api 造成的。
  - 按错误类型逐个放行是打地鼠。产品负责人 2026-10-13 选定「现在做阶段级 D13」：不改受保护的模型网关与 broker，让重试本身成为恢复手段。
- 改动：
  - **查询**：一条查询的重试遇到无法重放的操作时（活动失败类型为 `BudgetOperationReplayError`），这条查询记为失败，计划继续，run 至少 PARTIAL。连续两条查询都这样时视为故障，照旧让 run 失败。其他控制错误（授权过期、撤销、预算用尽等）照旧立即停止。
  - **fit**：某家公司的判定在重试时遇到无法重放的操作，这家记为未判定，接着判下一家。它与单次流截断共用「连续两次就停」的规则，并随时间盒交接跨活动传递。活动返回新增 `unreplayable`（包含在 `unjudged` 里）。
  - `stats.unreplayableSkips` 增加 `queries` 与 `fit` 两个阶段。对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）已同步。
- 测试：
  - 先写失败测试，改动前 8 项失败、改动后全部通过：
    - 工作流 4 项：单条查询记为失败并继续、连续两条仍判失败、中间隔一条成功时都吸收、fit 的计数进统计；
    - fit 活动 2 项：无法重放时记未判定并继续；紧跟在流截断后面时停下。
  - 五个以「查询的控制错误让 run 停下」为例的旧用例，改用 `ExecutionBudgetGrantError` 作例子：语义没变，只是 `BudgetOperationReplayError` 不再是「立即停下」的例子。#641 的一个用例补上了新的两个阶段字段。
  - **预演测试现在模拟 Temporal 重试**：每个活动按它所走代理的 `maximumAttempts` 重试，代理配置从工作流源码读取。新增三个场景：
    - fit 的流以不被吸收的方式断开，重试把这家记为未判定，run 判 PARTIAL，其余 99 家都有判定；
    - 一条查询第一次断流、重试遇到无法重放的操作，这条查询记为失败，run 判 PARTIAL；
    - 连续两条查询都这样，run 判 FAILED。
  - 变异检验：分别关掉查询的吸收和 fit 的吸收，对应的预演场景都会失败。
- 未做：
  - 完整的 D13（重试等待「还在进行」的调用结算；broker 对确定的失败不再保留预留）仍按产品负责人决定放在验收之后。
  - 查询因无法重放而失败时，这条查询里已经抽到的其他公司一并丢失（这一条查询整体记为失败）。按公司粒度的恢复要改受治理的血缘收集器，放到完整 D13。
  - run 统计只计每个活动最后一次尝试的计数：fit 重试前那次尝试判过的公司，判定已存库，但不计入 `stats.fit`（旧问题，状态判定不受影响）。

## 2026-10-13 · End a query that lost a provider to an unreplayable operation with a zero receipt, so materialization still admits the run

- 起因：卖方 #27 的验收 run（`5abe5584`，xin，2026-10-13 12:25–12:53 UTC）第一次让 #642 的查询恢复生效——第 1 条查询的 5 次并发抽取在同一秒被 openox.tech 的上游错误事件打断，重试撞上无法重放的操作，这条查询记为失败，其余 9 条照常跑完（59 条原始记录、51 条通过）——却在 canonicalize 阶段报 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD`。
  - 物化准入 `admit_discovery_company_materialization_v1`（2026-08-30 的 Q v2「完整」语义）要求回执数、执行结果数都等于计划查询数，且每个 ordinal 都有回执。#642 让失败的查询不落回执就继续，正好打破了这条不变式。
  - 预演测试把 canonicalize 整个 mock 掉，所以没有发现。
- 改动：
  - **活动**（`executeQuery`）：某个数据源在重试时遇到无法重放的操作，不再让活动失败，而是把这个源替换成「已路由、0 条记录、0 费用」的结果（声明血缘的源带一份空血缘），其余源的记录照常落库，查询以零回执结束并返回 `unreplayable: true`。词表归一遇到这种操作时，不再调用任何源（每个源都会再撞上同一个操作），整条查询同样以零回执结束。此前那次尝试已经发出的调用仍在预算账本上。
  - **工作流**：改为读返回值计数（`failures`、`unreplayableSkips.queries`），并把 `previousQueryUnreplayable` 交给下一条查询的活动；活动在它为真时直接把无法重放的错误抛出，所以「连续两条即停」的规则没变，只是停在活动里。查询活动因无法重放而失败的情况不再被吸收：那说明查询没能落回执，继续跑只会在物化时被扣住。
  - 对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）同步。
- 测试：
  - 先写失败测试，改动前 11 项失败、改动后 5 个文件 263 项全部通过：
    - 活动 8 项：零回执列出该源且无跳过原因；其余源的记录保留；全部应答时不标记；前一条已丢失时直接失败；词表归一丢失时不调用任何源；词表归一紧跟在上一条之后时失败；交接标志不是布尔值时拒绝；其他控制错误照旧失败。原「generic replay 拒绝活动」用例改为新行为。
    - 工作流 4 项：记失败并把标志交给下一条、第二条由活动报错时 run 失败、中间隔一条成功时不交接、活动因无法重放而失败时不再吸收。
  - **预演测试补上物化准入**：canonicalize 的 mock 按 `admit_discovery_company_materialization_v1` 的规则，缺任何一条查询的回执就扣住 run；查询 mock 按活动的新行为应答。新增场景「一条查询每次尝试都因普通错误失败 → 没有回执 → 物化扣住、run 判 FAILED」。这个场景在改动前就成立，记录的是下面「未做」里的既有缺口。
- 未做：
  - 查询活动因**普通**错误用尽重试时仍然没有回执，run 会在物化时被扣住（#642 之前就如此；只是普通错误很少见，多数错误都归为控制错误）。
  - 共用操作键的失败仍会跨查询传染：词表归一的操作键由 run、任务、提示词决定，一次 503 让后面每条查询第一次尝试就撞上，连续两条即停（卖方 #26，10-13 11:36）。根治在网关或词表归一回退，按产品负责人决定放在验收之后。
  - REPLAYED 的查询结果（同一活动在上一次尝试已提交回执）不带 `unreplayable` 标记，不计入统计。

## 2026-10-13 · Let byte-identical artifacts of different result schemas share one stored object

- 起因：卖方 #28 的验收 run（`3afe9c46`，xin，2026-10-13 15:43–17:11 UTC）12 条查询全部完成、44 家公司进入物化、fit 判完，却在信号阶段失败；#23（10-13 01:23）倒在同一处。#641 补的错误码这次把根因露了出来：连续两家公司的 `http-get/v1` 产物持久化报 `ArtifactStorageError:GENERIC_OPERATION_ARTIFACT_INVALID`，broker 按设计改抛不可重放错误，#641 的「连续两家即停」生效。
  - 产物对象按 sha256 + 隐私类寻址（`artifact-key.ts`），但 `store.promote` 对已存在的对象还要求 result-schema 与 media-type 完全一致（`object-contract.ts` 的 `sameArtifact`），读回时 `service.ts` 的 `sameStoredArtifact` 同样要求。
  - 信号阶段对每家公司做 careers 路径的 HEAD 探测，产物是空字节；而 `crawl4ai-fetch/v1`（text/markdown）早在 10-12 17:34 就把 23 份空结果存进了同一个对象。于是每家公司都在同一步被判 INVALID——不是上游、不是 MinIO，是我们自己的相等判定。
- 改动：相等判定收紧到字节本身——sha256、大小、隐私类；对象自身的 media-type 与 result-schema 只记录首个写入者的合同，每份产物清单带自己的合同，materializer 一直读的就是清单。`promote` 复用已存在的对象时不改写它。
- 测试：先红后绿（3 项新用例改动前失败，改动后产物模块 25 个文件 348 项通过）：存储层「同字节、另一 schema/媒体类型的对象被复用且不重写」；服务层「读回这样的产物」「持久化到这样的对象上时清单仍是自己的合同」；原「result schema mismatch 即拒绝」的用例按新规则删除，大小、摘要、隐私类不一致仍拒绝。
- 未做：
  - 内容寻址去重与 MinIO 按对象年龄过期（personal-data 1 天）相冲：复用对象不刷新年龄，首个写入者的 TTL 一到对象就没了，而库里仍有未过期的产物行指向它（10-13 验证：空对象已 NotFound，库里最晚的引用到 10-14 16:36）。另行处理。
  - 每次 HEAD 探测都落一份空产物，是浪费但无害。

## 2026-10-13 · Carry the seller profile as the artifact subject of understanding crawls, and record a failed understanding on the company row

- 起因：卖方入驻的理解工作流（`POST /companies` → outbox relay → `understandingWorkflow`）自 2026-08-24 起一次都没跑通。b8dd5eb0 把 `crawl4ai-fetch/v1`、`http-get/v1` 列进主体绑定的 PERSONAL_DATA 产物；#565（G3 5.1）改成按调用准入——broker 的 `artifactPrecheck` 只放行带 `ctx.artifactSubject` 的调用，发现侧 website-profile 接了，理解侧从没接：`crawlViaBroker`（d404a70d）不带主体，首页抓取被 `GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD` 拒 3 次，工作流失败，`company_profile` 停在 ENRICHING，什么也没记（xin 只读核验 2026-10-13：10-01..10-13 ENRICHING 28 行、DRAFT 9 行、ACTIVE 从未有过；验收 e2e 能过只因它手工 POST claims）。
- 改动：
  - 理解的首页与子页抓取带上 `artifactSubject: { subjectType: 'company_profile', subjectId: company_profile.id }`——与发现侧 website-profile 同一个 G3 模板，主体种类是卖方画像自己的（见下）；工作流把 `companyId` 交给 `crawlWebsite` / `crawlPages`。
  - broker 的策略拒绝在活动边界转成带类型的 `ApplicationFailure`（类型=封闭 token 的拒绝原因，带域名或任务 id 的原因只留类名；原错误作 cause，分类结果不变；不重试——策略判定不会因重试而变）。worker 的诊断转换器只保留 ApplicationFailure 的 type，不这样做，回写只能记到 `Error`。
  - 工作流任一阶段失败（只认 Temporal 上报的失败；`understanding-failure-record-v1` patch 守卫）先调新活动 `recordUnderstandingFailure`：`company_profile` 回 DRAFT，记 `understanding_failed_at` 与 `understanding_last_error`（`阶段:错误类型`，无消息、无抓取内容），再抛原错误；新一轮 ENRICHING 清空两列；收尾 REVIEW 本身失败不补写。迁移 `20261014120000_company_profile_understanding_failure` 加两列与 CHECK（只收 `token:token`、两列同空同非空）；API 经 `CompanyDto` 映射，OpenAPI 不变。
  - `describeRunFailure` 从 `discovery.run-failure` 抽出，发现与理解共用一个无内容的失败描述。
- 卖方主体种类 `company_profile`（方案 A，产品负责人 2026-10-14 选定）。原先契约只认 `contact` / `company`，理解抓取挂不上任何主体。没有复用 `company`（方案 B）：`company` 指 `canonical_company`（发现到的买方），`company_profile` 是租户自己的卖方档案、另一张表；复用会让同一主体种类指向两张表，DSR tombstone、按主体查产物、合规报表都得带注记。
  - 合同（TS）：`GENERIC_OPERATION_ARTIFACT_SUBJECT_TYPES = contact | company | company_profile`（`generic-operation-artifact-subject.repository.ts`），主体解析器与 broker 端口的 `ArtifactSubjectRef` 类型随之放宽（broker 文件本身未改）；`resolveExistingSubject` 多一个 `company_profile` 分支，按种类、同工作区精确匹配——画像 id 不会按 `company` 解析，买方公司 id 也不会按 `company_profile` 解析。
  - 公开删除 API 不收新种类：`DELETION_SUBJECT_TYPES` 仍是 `contact | company`，OpenAPI 与 DeletionCompleted 事件契约不变——卖方画像不是 DSR 主体。删除工作流的 `freezeSubject` 现在在任何写入之前拒掉非 DSR 种类（`DELETION_SUBJECT_TYPE_INVALID`，不重试）：DB 的 tombstone 已认 `company_profile`，不再替它拦。
  - 数据库（并入本 PR 尚未合入的迁移 `20261014120000`）：4 个主体种类 CHECK 按原名删后重加；11 个 SQL 函数各按最新定义 `CREATE OR REPLACE`，只放宽种类列表——assert / bind / find_by_subject / tombstone、execution-hold 读取器、`enforce_tool_budget_expected_artifact_subject_v1`、`mark_…_v4`、`load_…_v4`、`append_…_v3`、`settle_…_v4`、`settle_…_with_receipt_v2`（现行的 v4 结算经 v3 调它）。另有两处语义改动：assert 加同工作区 `company_profile` 存在性查找（带 `FOR KEY SHARE`）；execution-hold 的停用判定 CASE 只认 `company` / `contact`，卖方画像没有停用态，只看 tombstone。属主、SECURITY DEFINER、search_path、授权逐一不变（真库迁移前后目录对比一致）。
  - 删除语义：现在没有任何路径删卖方画像或工作区，工作区已被主体表的 RESTRICT 外键挡住。主体行对画像没有外键，所以新增 `company_profile` 的 AFTER DELETE 守卫：仍有产物绑定、而该主体没有 tombstone 时拒删（`GENERIC_OPERATION_ARTIFACT_SUBJECT_NOT_TOMBSTONED`）。日后的租户删除必须先用一条指名该画像的 `deletion_request` 调 `tombstone_…_v1`：tombstone 挡住新抓取（execution hold 与结算都报 `…_TOMBSTONED`），`enqueue_workspace_personal_artifact_cleanup_v1` 把对象交给个人产物清理；之后画像才删得掉，绑定行留作审计。在此之前产物照旧按 1 天 TTL 过期。绑定与删画像并发时，`FOR KEY SHARE` 加 AFTER 守卫保证两种先后都不会留下指向已删画像的绑定。
  - CI：新 `generic-operation-artifact-seller-subject.postgres.spec` 接进 `ci.yml` 的「Raw SQL parameter types on PostgreSQL」步骤（与 #647 的 object-version 用例同库同步骤）。
- 测试：先红后绿。`understanding.activities.spec`：用真实 `ToolBroker` 复现无主体即 HOLD（admit / execute 都没跑、预留已释放）；带主体 → admit 收到 `{ crawl4ai-fetch/v1, company_profile 主体 }`、wire 跑一次、persist 挂同一主体；子页逐个带同一主体；主体被拒 → `ApplicationFailure{ type: GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_INVALID, nonRetryable }` 且仍是控制错误；带域名的拒绝原因只以类名过边界；回写 DRAFT+失败、ENRICHING 清空、非封闭 token 拒写。`understanding.workflow.spec`（新，proxyActivities-mock harness）：抓取带 companyId；首页被拒 / 抽取失败各记对应阶段并以原错误失败；工作流代码缺陷、无 patch 标记的旧历史、回写失败、收尾失败四种都不补写。`understanding.run-failure.spec`：标签与拒收。改动前 10 项失败 + 1 个模块缺失，改动后 5 个文件 43 项全过。
  - 方案 A 单测（零容器）：改动前 5 个文件 63 项里 13 项失败——主体解析器不收 `company_profile`、解析 SQL 没有画像分支、绑定合同不认卖方画像、删除工作流照收非 DSR 种类，以及 `understanding.activities.spec` 新增的「生产准入」用例：真实 `ToolBroker` 前面接真实 `GenericOperationArtifactExecution.admit` → `ArtifactSubjectBindingContract` → 主体仓库（只有 SQL 行是假的），改动前正是 xin 上的 `SUBJECT_BINDING_INVALID`；改动后全过：admit 收到 `company_profile` 主体、wire 一次、persist 挂同一主体，依次发生；画像 id 按 `company` 种类仍被拒，tombstone 后报 `SUBJECT_TOMBSTONED`，都在 wire 之前。
  - 方案 A 真库（一次性 `pgvector:pg16` 容器，全部迁移，查询以 app_user 在工作区事务里跑）：新 spec 7 项，在未含本迁移的库上 5 项失败，迁移后全过——目录：4 个 CHECK 与 11 个函数都收 `company_profile`，属主 / definer / search_path / 授权不变，再无函数把种类关在 `contact, company`；同工作区画像可解析、可结算绑定，别的工作区的画像、不存在的 id、买方公司 id、按 `company` 种类的画像 id 都以 `…_SUBJECT_INVALID` 拒；删画像在 tombstone 前被守卫拒（owner 与 app_user 都拒），工作区也删不掉；tombstone 要求 `deletion_request` 种类一致，之后 execution hold 为 `TOMBSTONED`、新结算 `…_TOMBSTONED`、清理入队 1 条命令，画像随后可删；两个并发用例（删画像等在途绑定、绑定等在途删除）在去掉 `FOR KEY SHARE` 后都会失败。同库重跑 CI 同步骤的 raw-sql-parameter-types、security-definer-search-path、object-version、company-contact-point、site-build-budget-lock，以及 app-user-table-privileges，全过。
- 真机：按任务硬规则只做只读核验，没有新建卖方公司、没有触发理解工作流。本 PR 部署后，新建卖方公司的理解抓取会被准入并真实出网抓取卖方官网（产物 PERSONAL_DATA、1 天 TTL）；xin 上既有 28 行 ENRICHING 不回填。

## 2026-10-13 · Answer ICP design and plan generation whose model answer settled unusable with 502 MODEL_UPSTREAM_UNUSABLE instead of a bare 500

- 起因：卖方 #24 的 ICP `971c9242`（xin，2026-10-13 07:55–08:02 UTC）`POST /icps/:icpId/query-plans` 跑了 284 秒后，网关把这次调用结算为 `CHAT_COMPLETIONS_CONTENT_FILTERED`（`ProviderOutputError`，已按真实用量结算），API 却只回 500 `INTERNAL`，没有错误码；同一 ICP 再试一次得到 409 `EXECUTION_BUDGET_GRANT_REUSED`，因为 GrowthOS 对同一操作与主体会签发同一份授权，而后端按 jti 消耗授权（`consume_workspace_execution_authority`）。调用方从这两个响应里看不出模型答案不可用、也看不出该怎么重试。
- 改动：
  - **新的 HTTP 边界** `apps/api/src/model-gateway/model-upstream-http-boundary.ts`：`asModelUpstreamHttpBoundary` 把网关**已结算、没有可用答案**的模型失败映射成 502 `{ error: { code: "MODEL_UPSTREAM_UNUSABLE", message, details: { reasonCode } } }`。
    - 识别的失败：可恢复的 `ProviderOutputError`（非 JSON、不过 schema、任务门拒绝，含 `TaskOutputValidationError`），以及**原型精确**的 `ProviderIdentityError`、`ProviderTransportError`（流被截断、上游错误事件、不可读、非 JSON 响应体、finish reason 无效、Responses 状态失败），且 cause 链里没有控制错误。
    - 网关在未付费 wire 上直接回 400–599（实际是 429、5xx）时抛的 `ProviderHttpError`（原型精确、状态码为整数）：原因码为 `GATEWAY_HTTP_<状态码>`。授权（jti）在模型调用之前就已消耗，所以重试同样需要新授权；这次调用的预留是否计费由路由按失败类别决定（现在按预留额度保守结算）。子类与范围外状态码不识别（复审 MEDIUM：此前这类失败仍是裸 500）。
    - 不识别、原样放行：授权错误（402/403/409/503 仍由 `asExecutionBudgetHttpBoundary` 映射）、控制错误、`ProviderOutputUnresolvedError`、`ProviderSettlementError`、合规拒绝、在途 wire、业务 409、普通错误。
    - 响应正文只有固定 message 与经 `^[A-Z][A-Z0-9_]{2,63}$` 校验的 `reasonCode`，不带模型文本；日志同样只记原因码。
  - **ICP 控制器**：`POST /companies/:companyId/icps` 与 `POST /icps/:icpId/query-plans` 在授权边界之内套上这道边界，并以 `@ApiModelUpstreamUnusable()` 把 502 注册进 code-first OpenAPI（`packages/contracts/openapi/openapi.json` 重导出，两个操作各多一个 502，spectral 0 错误，无破坏性变更）。
  - **授权语义（这次生成失败后授权怎么算）**：授权在模型调用之前就在自己的事务里被消耗（`consumeWorkspaceAndOpen`：消耗 jti + 开账户），网关再把这次调用的真实用量结算到这份授权的账户上；失败后服务不写任何 ICP 或计划。所以授权**已消耗、已计费**，不能回滚：消耗与调用不在同一个事务里，而且就算在，结算行也必须保留，否则同一份授权可以付两次。调用方的重试方式是先向 SaaS 取一份新的授权；用同一份会得到 409 `EXECUTION_BUDGET_GRANT_REUSED`。
  - 对接说明（`packages/contracts/INTEGRATION.md` 阶段 2 第 1 步）与错误模型表（`packages/contracts/README.md`）补上 502。
- 测试：
  - 先写失败测试：边界 1 个文件（识别 15 例、不识别 13 例、响应体 4 项、边界包装 8 项）在模块不存在时整体失败；控制器 14 项中 9 项失败（502 映射 6 项、OpenAPI 元数据 2 项、1 项是夹具缺 `createdAt`）；OpenAPI 文档 1 项失败。改动与重导出后 4 个文件 132 项全部通过。
  - 服务侧新增 3 项刻画授权语义：模型失败时 `consumeWorkspaceGrant` 恰好调用一次且早于模型调用，不写计划/ICP，错误原样抛出；改动前就成立（服务没改）。
- 未做：
  - **用同一份授权重试仍是 409**。要让失败后的重试不必换授权，只能由 GrowthOS 在收到 502 `MODEL_UPSTREAM_UNUSABLE` 后换一个 jti 签发（例如把尝试序号纳入签发键），本仓不改 GrowthOS。风险：在那之前，调用方必须先取新授权再重试；若 SaaS 侧仍返回同一份，这个 ICP 在授权过期前都无法重新生成。
  - 「不消耗授权」的方案评估过并放弃（见上「授权语义」）：会让同一份授权付两次。
  - 查询计划执行（`POST /query-plans/:planId/execute`）是异步的，模型失败发生在 run 里，不走这道边界。

## 2026-10-13 · Stop a discovery run at the query stage when a query activity fails on an ordinary error, instead of holding it at materialization

- 起因：#643「未做」里记录的既有缺口。查询活动因**普通**错误（分类器判为非控制错误，例如数据库或网关的普通失败）用尽重试时，`discovery_query_receipt` 和 `discovery_query_execution_outcome` 都没有这条查询的记录，工作流却只把 `failures` 加一、继续跑完其余查询，直到 canonicalize 阶段才被物化准入 `admit_discovery_company_materialization_v1`（回执数、执行结果数都等于计划查询数，且每个 ordinal 都有回执）以 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD` 扣住：其余查询的时间与模型费用白花，run 记的还是 canonicalize 阶段的控制错误，看不出真正起因。预演场景「一条查询每次尝试都因普通错误失败」记录的就是这个。
- 取舍：在两个方案里选了「诚实的最小改动」——在查询阶段就停，而不是从工作流侧补一条零回执。
  - 补零回执要新增一个活动（计划、预算绑定、查询键都得由工作流交下去），并为一条根本没执行完的查询写一份执行结果，物化准入见到的「完整」就是假的。#643 的零回执是活动自己在重试时写的，它知道哪个源已路由、哪个没有；工作流不知道。
  - 普通错误连续三次用尽重试多半是基础设施故障，不是这一条查询的问题，后面的查询大概率同样失败。停下来、记清阶段与错误类型、计划保持 `READY` 可重跑，比跑完再被扣住便宜，也诚实。
- 改动：
  - **工作流**（`discoveryWorkflow`）：查询活动因普通错误失败时不再吸收，直接抛出，由既有的失败收尾（BI-25）把 run 记为 `FAILED`，`stats.failure = { stage: 'query', errorType: <活动最后一次尝试的错误类型>, control: false }`；后面的查询不再执行，canonicalize 不再调用。控制错误照旧直接上抛，行为不变。
  - `stats.failures` 的语义收紧为「以零回执结束的查询数」（#643 的无法重放情形）：让 run 停下的那次失败记在 `stats.failure` 里，不计数，与 fit 等阶段一致。此前已经拿到的回执照常留在 FAILED 记录的 `perQuery` / `perSource` 里，`finalizeRun` 的回执核对照常通过。
  - patch 守卫 `discovery-query-failure-stop-v1`：改动前记录的历史没有这个标记，重放时照旧计失败、继续跑后面的查询，命令序列不变；回执之前的旧历史不问这个 patch。没有新活动，超时声明不变。
  - 对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）同步。
- 测试（先写失败测试：改动前 5 项失败——工作流 3、预演 1、重放 1；首版写成 4 项，独立复审对照 main 实测更正——改动后 4 个文件 87 项全部通过）：
  - 工作流 4 项新用例：普通错误在查询阶段停住、后面的查询不跑、canonicalize 不调用、`failures: 0` 且 `failure.stage = 'query'`；此前以零回执结束的查询照常计入 `failures`；没有 patch 标记的旧历史照旧继续跑并判 `PARTIAL`；回执之前的旧历史不问这个 patch。正常 run 不问这个 patch（既有用例加一条断言）。原「普通查询失败仍走正常状态路径」用例删除，「后一条查询失败时保留前面同类回执」用例改为断言这些回执留在 FAILED 记录里。
  - 重放 2 项（真实 Temporal 历史）：改动前记录的「查询失败 → 下一条查询 → canonicalize 扣住 → FAILED 收尾」历史重放不变；改动后记录的「查询失败 → FAILED 收尾（stage `query`）」历史重放通过。
  - 预演场景改写：「一条查询每次尝试都因普通错误失败」现在断言 run 停在查询阶段（`executeQuery` 只跑 4 次尝试 [1, 1, 2, 3]，后两条查询不跑，canonicalize 不调用，`failure.stage = 'query'`），不再是物化扣住。
- 未做：
  - 没有补零回执的活动（方案 B），理由见上。若将来要「一条查询普通失败、其余照跑」，应在活动侧让普通错误也以零回执结束，而不是从工作流侧补。
  - #643「未做」里的另外两条（共用操作键的失败跨查询传染、REPLAYED 结果不带标记）不变。

## 2026-10-12 · Keep a governed discovery query going when one model extraction answers unusably

- 起因：卖方 #20 的验收 run（`322866ef`，xin，2026-10-11 19:02–19:21 UTC）在第 8 条查询失败，报 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`。
  - 这次 run 共 112 次公司抽取，其中 1 次被网关以 `STRUCTURED_OUTPUT_EMPTY_TRUNCATED` 拒收（pro 跑了 139 秒，输出为空）。网关已结算这次预算操作，没有持久结果。
  - public_web 把它当作「跳过这个域名」，但收据收集器仍记为「已调用、没有收据」。`buildDiscoveryCompanyResultLineage` 因此整份血缘都不给，受治理的执行计划判为 MISMATCH。
  - Temporal 重试时，同一个预算操作「已存在但没有持久结果」，报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，run 失败。
  - 这个缺陷从受治理的查询路径（2026-08-30 的 G2/G3）起就潜伏着：查询走受治理路径还是 legacy 路径，看每个适配器是否声明血缘，与 C-TX Release B（#631）的激活无关。
- 改动：
  - `company-discovery-lineage.ts`：收集器新增 `markInvocationFailed()`，观察记录新增 `failed`。
    - 只能在「已调用、还没有收据」时标记，标记后不能再收收据，也不能覆盖记录；
    - 收据已经到了再标记，不改变任何东西，收据照常保留；
    - 构建血缘时，标记为失败的调用不出现在血缘里；没标记又没有收据的调用，仍然让整份血缘作废（fail closed 不变）。
  - `public-web.provider.ts`、`directory.provider.ts`：只有 `isRecoverableModelFailure` 成立时才标记失败，也就是网关已经结算的不可用答案（`ProviderOutputError`、`TaskOutputValidationError`）。
    - 结果未知的失败（`ProviderOutputUnresolvedError`、`ProviderSettlementError`、`PaidOperationUnknownError` 等）按控制错误照旧抛出；
    - 其他普通错误照旧让血缘作废。
  - trade_fair 不变：它的失败来自 broker 工具调用，不是模型调用。原有「结算前失败即 fail closed」的测试保留。
- 测试：
  - 先红后绿：新增 11 项行为测试（收集器 3 项、观察记录格式 5 项、public_web 2 项、directory 1 项），改动前 6 项失败，改动后全部通过。已有的两条畸形观察用例补上 `failed: false`，仍然测原来的规则。
  - 另加 4 项，钉住这次修复依赖的已有约定：
    - public_web 遇到 `ProviderTransportError`、`ProviderOutputUnresolvedError`、`ProviderSettlementError` 都照旧抛出，不标记失败；
    - 网关对不可用的答案只结算、不带结果投影，也不发持久收据（`router-model-gateway.spec.ts`）。
  - `vitest run src/discovery/ src/temporal/discovery src/model-gateway/router-model-gateway.spec.ts`：86 个文件 1435 项通过，4 个 PostgreSQL 文件跳过。
  - 独立对抗审查结论：可合并。四条低优先级意见里，这一句的归因与测试数已改，网关约定已补测试；另两条列入下面的「未做」。
- 未做：
  - 同一活动因为别的原因被 Temporal 重试时，已结算但没有持久结果的模型调用仍会报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，让查询失败。这属于 D13「失败后重试」，要改受围栏保护的 router，另行处理。
  - 被跳过的失败调用不计入查询收据和 run 统计，只在 `ai_trace` 里可查。如果某条查询的调用全部失败，它会以 0 条记录提交，而不是报错。按原因码计数或加「全部失败」信号，另行处理。
  - 随下一个运行镜像上线，再用新卖方重跑验收。

## 2026-10-12 · Count the model extractions a discovery run skips, and let a lone cut stream cost one company instead of the run

- 起因：
  - #638 之后，被网关拒收的公司抽取只跳过一个域名，但跳过只记在 `ai_trace` 里，查询收据和 run 统计都看不到；如果上游把每次答案都截断，查询会以 0 条记录提交，run 照样结束（#638 复审 LOW-3）。
  - 卖方 #21 的验收 run（`5740150c`，xin，2026-10-12 10:55–11:30 UTC）跑完 11 条查询后失败。原因：159 次公司抽取里有 1 次 SSE 流被截断，报 `ProviderTransportError: CHAT_COMPLETIONS_STREAM_TRUNCATED`。
    - 传输错误按设计属于控制错误，活动因此失败；
    - Temporal 重试时，这次调用已结算、但没有持久结果，于是报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，三次尝试全部失败。
  - 传输错误 fail closed 是有意的：网关整体故障时每次调用都会失败，调用方各自吞掉就会悄悄得到空结果。但网关对流截断的处理和不可用答案完全一样（只结算一次，不带结果投影，也不发持久收据）；而两次 run 里截断都是单独出现的（112 次里 1 次、159 次里 1 次）。
- 改动：
  - **判断「网关已结算、没有结果」**：`discovery/settled-model-failure.ts` 的 `settledModelFailureReason` 只认两类：
    - 可恢复的 `ProviderOutputError`（#638，含 `TaskOutputValidationError`）；
    - 精确类型的 `ProviderTransportError`，原因码必须是 `CHAT_COMPLETIONS_STREAM_TRUNCATED`，且 cause 链里没有控制错误。
    - 其余传输错误照旧 fail closed：超时或读不出的响应、非 JSON、上游错误事件、`insufficient_system_resource` 这类无效 finish reason、Responses 失败状态。结果未知的 `ProviderOutputUnresolvedError`、`ProviderSettlementError` 也照旧抛出。
  - **公司抽取**（public_web、directory）：遇到上述两类就跳过这个域名或名录页，标记失败，保留血缘。
  - **统计**：新的纯函数模块 `discovery-model-extractions.ts`，不依赖其他模块，工作流直接引用。
    - 按查询统计抽取调用数，以及按原因码统计跳过数；原因码只接受网关的安全格式，其他一律记为 `MODEL_CALL_FAILED`；汇总时严格校验，旧历史和格式不对的数据不计入。
    - `DiscoveryResult.modelExtractions` → executeQuery 按查询汇总 → 工作流写入 `stats.modelExtractions`，含 `invoked`、`failed`、`failedByReason`、`queriesAllFailed`，只在有跳过时出现。阶段失败时补写的 FAILED 统计里也带上它。
  - **run 状态**：有跳过就至少 `PARTIAL`（`resolveRunStatus`，与 fit 未判定同理）。整个 run 的抽取全部失败、且没有任何记录通过时判 `FAILED`：这是上游故障，不是市场冷清；FAILED 让计划保持 READY，可以重跑（BI-25），而 PARTIAL 会把计划用掉（#639 复审 HIGH-1）。旧历史没有这个字段，重放时状态不变。
  - **fit 判定**（`qualifyFitForRun`）：原设计「传输失败通常打到每一家，所以让活动失败」保持不变，只吸收单独一次、网关已结算的流截断，这家记为未判定。
    - 两次截断之间没有出现可用判定（包括中间只隔了不可用答案），就视为上游故障，照旧让活动失败；
    - 其他传输失败也照旧让活动失败；`judgeFitCompany` 本身不变。
    - 按约 0.6% 的截断率估算，30 家的 run 原本约有 17% 的概率死在这一步。
  - **官网画像**（`website-profile.provider.ts` 的分类调用）：单次流截断和不可用答案一样，保留规则得出的确定性事实；其他传输失败照旧让 run 停下。官网画像在 fit 之前跑，截断如果是整体性的，会在 fit 阶段因「连续两次」停下。
  - 对接说明（`packages/contracts/INTEGRATION.md` 第 3 步）补了这个字段。
- 测试：
  - 先写失败测试，覆盖：
    - 纯函数模块：计数、原因码过滤与防原型污染、求和、run 累加不可变、格式不对的输入；
    - public_web、directory 的计数；executeQuery 汇总；
    - 工作流：PARTIAL、`queriesAllFailed`、DONE 时不出现该字段、BI-25 失败收尾也带统计、全部失败且无记录时判 FAILED；
    - `resolveRunStatus`。
  - `settledModelFailureReason`：白名单内外各种传输错误、子类、带控制错误或普通 cause、结果未知的错误、普通错误、非错误值。
  - 流截断：#638 曾钉住「`ProviderTransportError` 原样抛出」，现改为跳过并计数（public_web、directory）；其他传输错误、结果未知的错误仍钉住「原样抛出」。
  - fit：单次截断记未判定；被可用判定隔开的两次截断都吸收；连续两次、或中间只隔不可用答案的两次，都让活动失败；带控制错误 cause 的照旧失败。原测试「一次截断就让活动失败」改为「记为未判定」。
  - 官网画像：单次截断被吸收，`CHAT_COMPLETIONS_BODY_NOT_JSON` 照旧抛出。
  - 独立对抗审查：
    - 第一轮在 `7feaf707` 上没有完成；
    - 第二轮结论「修完再合」，HIGH-1、MEDIUM-1、MEDIUM-2 与 LOW 的测试和文档问题都在本 PR 修复；
    - 修复验证结论「可合并」。按验证意见撤回了 taxonomy 的吸收（见「未做」）。
  - `vitest run src/discovery/ src/temporal/ src/icp/ src/model-gateway/`：162 个文件 2536 项通过，7 个 PostgreSQL 文件跳过。
- 未做：
  - 活动重试时，已结算但没有持久结果的调用仍会报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`。这次改动让首次尝试不再因为单次失败而失败，很少走到重试；彻底解决属于 D13。
  - 网关修复调用里的传输错误会被包成 `ProviderOutputUnresolvedError`（结果未知），这里不吸收。
  - 走「已有收据直接回放」路径的查询不带统计：一次尝试已提交、但完成信号丢了的话，它的跳过不会计入，run 可能以 DONE 结束。
  - `invoked` 统计的是抽取调用次数，不是物理请求次数：一次带修复的抽取是两次请求。
  - taxonomy 归一遇到单次截断，仍让这条查询失败。taxonomy 调用不带 `correlationId`，同一个词的预算操作键只取决于 run 账户和提示词；如果在这里吸收，下一条查询归一同一个词时会重放这次「已结算、无结果」的操作，报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`。这只是把失败挪到别处，而 taxonomy 按设计也不把重放丢失当作未命中。每次 run 只调 2–3 次。
  - 官网画像吸收一次截断后，会保存一份未分类的画像并刷新时间戳，TTL 内不再分类。截断如果是整体性的，而后面的 fit 又调用不足两次（例如重跑已判定过的公司），run 可能以 DONE 结束；只能从 `stats.websiteProfile.unclassified` 看出来。
  - 被吸收的抽取，预算操作键由 run 账户和提示词决定。两条查询如果过滤条件和关键词完全相同、又碰到同一个域名，第二次会重放这次失败，报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，run 失败（旧问题，真实计划里关键词通常不同）。

## 2026-10-12 · Hand the companies a fit or website-profile activity did not reach to the next activity

- 起因：卖方 #22 的验收 run（`6f2d0871`，xin，2026-10-12 17:21–18:11 UTC）6 条查询全部完成：原始 65 条、通过 51 条、51 家公司，84 次抽取没有跳过。但 run 在 fit 阶段失败。
  - fit 在一个活动里逐家判定全部 51 家，每家一次 pro 调用（平均 26 秒，最长 55 秒），共需约 22 分钟，超过 `modelActs` 的 15 分钟时限。
  - 第一次尝试超时后，第二次尝试跳过已判定的公司（判定逐家落库），从下一家开始。但这家的调用还在第一次尝试里进行：预算操作仍是 RESERVED，没有持久结果，于是报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`。第三次同样失败，run 失败。
  - 超时的第一次尝试并没有停下：活动不发心跳，也不检查取消。工作流失败后它又跑了 7 分钟，判完全部 51 家（18:18:58），这部分调用白花了。
  - 官网画像也是一个活动处理全部公司（上限 50 家），这次用了 25.5 分钟，离 `signalActs` 的 30 分钟时限只差 4.5 分钟。
  - 根因：逐家处理的阶段，活动耗时随 run 的公司数线性增长，时限却是固定的。`MAX_DISCOVERY_FIT_COMPANIES` 是 11,550；按平均 26 秒算，15 分钟只够约 34 家。
- 改动：
  - **时间盒**：`qualifyFitForRun`、`profileWebsitesForRun` 各设一个时间盒（`FIT_PASS_TIME_BOX_MS` 8 分钟、`PROFILE_PASS_TIME_BOX_MS` 15 分钟）。
    - 过了时间盒就不再开始新公司，把余下的交给下一个活动；
    - 每个活动至少处理一家，run 总能往前走；
    - 时间盒到点时正在处理的那一家照常做完，两个阶段都为它在各自时限内留了余量：fit 最多再跑一次模型调用（上限 300 秒）；官网画像最多再跑两次抓页、一次渲染和一次模型调用。
  - **fit 续接**：按公司 id 顺序处理，用 `afterCompanyId` 续接，候选公司照旧排除本 ICP 已判定的。「连续两次流截断就停」的规则用 `previousCallCut` 跨活动传递。
  - **官网画像续接**：候选列表改为全序（`createdAt`、`id`），用 `startIndex` 续接；某一批报告 run 预算用完后不再续接。
  - **工作流**：循环调用，直到活动不再返回续接位置，再把各次计数相加。统计字段和 run 状态的规则都不变。后一批官网画像失败时，保留前面各批的计数，失败本身仍和原来一样按尽力而为处理。
  - **参数校验**：续接参数在活动入口校验，格式不对时报不可重试的 `DISCOVERY_STAGE_CONTINUATION_INVALID`。
  - **重放兼容**：不需要 patch。是否续接取决于活动结果，改动前记录的历史里没有续接字段，重放时不会排出新命令。
- 测试：
  - 先写失败测试，覆盖：
    - fit 活动 7 项：时间盒交接、按游标与 id 顺序续跑、截断标记跨活动传递（两项）、预算用完、两项参数校验；
    - 官网画像活动 6 项：时间盒交接、按位置续跑与全序、四种非法位置；
    - 工作流 4 项：fit 与官网画像多次续接后相加、预算用完即停、后一批失败保留前面的计数。
  - 改动前 16 项失败（工作流里两项是新循环的回归保护，改动前也能通过）；改动后全部通过。官网画像「源未开启时什么也不做」的用例，返回值多了 `nextIndex: null`。
- 未做：
  - 超时的尝试仍会在后台跑完，因为活动不发心跳、也不检查取消。这次改动让活动不再因为公司多而超时；但如果单次调用异常慢、一批仍然超时，重试会撞上旧尝试里还没完成的调用，报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`（D13）。
  - 富集（GLEIF）在 2 分钟的活动里处理全部 match 公司（上限 50 家，每家至多 4 次请求）。#22 只有 12 家 match，没有风险；match 公司多时同样可能超时，改法相同。
  - 信号富集、监控注册各自上限 12 家，在 30 分钟时限内余量充足，不改。

## 2026-10-11 · Activate governed Discovery company materialization (C-TX Release B)

- 起因：C-TX 只发了 Release A（#431：迁移 `20260830130300`/`20260830130400`，激活单例表为空），Release B 一直没做。API 自 Release A 起给每个新发现 run 写 v1 标记，而 `admit_discovery_company_materialization_v1` 对「v1 标记 + 无激活行」一律抛不可重试的 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE`：任何走完查询阶段的 run 都会在 canonicalize 失败。xin 上激活表为 0 行，至今没有 run 走到 canonicalize。
- 改动：
  - 新迁移 `20261011100000_discovery_company_materialization_activation`：在事务内设置 Release A 插入守卫要求的事务级设置，写入唯一的激活行（1、`discovery-company-materialization/v1`、合同 SHA-256）。不回填、不改写任何 run、admission 或回执。行级触发器拒绝对激活行的 UPDATE 与 DELETE，但表属主仍能 TRUNCATE 掉它（TRUNCATE 不触发行级触发器），所以这道守卫不是回退手段，回退见下方「部署」。
  - 新的真库测试暴露了 canonicalize 自身的两处缺陷，不修则激活后仍走不通，一并修复：
    - 两处事务级咨询锁用 `$queryRaw` 读 `pg_advisory_xact_lock` 的 void 结果，Prisma 无法反序列化 void（P2010）：受治理路径的公司身份锁（`discovery-company-materialization.ts`）与 legacy 路径的 Raw 身份锁（`discovery.activities.ts` 的 `lockCompanyRawIdentity`）。改为与 `suppression-policy-lock.ts` 相同的写法，只把结果转为 text，锁键不变。修复前，run 只要有一条可物化的 ACCEPTED 记录，两条路径都会抛出可重试的数据库错误。
    - `finalize_discovery_company_materialization_run_v1` 的 companies/suppressed 是 BIGINT，Prisma 交给 TypeScript 的是 bigint，而解析用的 `count()` 只收 number：每个受治理 run（包括 0 家公司的）都会在 finalize-run 以不可重试的 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID` 失败。新增只用于这两列的 `bigintCount()`；单测里 finalize-run 的模拟行改为 bigint，并新增「普通 number 视为畸形」用例。
  - 静态清单：`discovery-company-materialization.inventory.spec.ts` 扫描全部迁移，只有 Release B 可以插入激活行，只有 Release A/B 可以出现激活设置名；Release B 的语句序列必须恰好是 BEGIN、两条超时、激活设置、那一条 INSERT、COMMIT；Release A 仍不得激活。附变异证明。
  - canonicalize 事务的选项：受治理路径的批次事务（最多 128 条）与 legacy 路径的整 run 事务此前用 Prisma 默认的 maxWait 2 秒、timeout 5 秒，负载下易超时，而 P2028 超时会被当作普通错误反复重试。两处改用导出常量 `DISCOVERY_CANONICALIZE_TRANSACTION_OPTIONS`（maxWait 10 秒、timeout 90 秒）：两者之和小于 canonicalizeRun 的 2 分钟 startToCloseTimeout，卡住的事务会在 Temporal 开始下一次尝试前回滚。admission、inspect 与两次 finalize 仍用客户端默认值。
  - CI：build-test 作业在「Sanctions operator refresh on PostgreSQL」步骤之后新增「Discovery company materialization activation on PostgreSQL」，用同一钉住镜像在 `127.0.0.1:5433` 起一个独立空库，步骤结束即删除。
- 测试：
  - 新 `discovery-company-materialization-activation.postgres.spec.ts`（6 项，真库，经生产 activity `canonicalizeRun` 以 app_user 运行；只替换 Temporal heartbeat，以及 legacy 路径对 Grant 的校验）：先用 `prisma migrate deploy` 迁到「除激活迁移外的全部迁移」，写入一个查询阶段完整的 v1 run（ACCEPTED public_web Raw 由真实 Raw 写入路径落库）和一个无标记的 pre-C run。(a) v1 run 被拒，码为 UNAVAILABLE，不留 admission；随后用真实 migrations 目录再跑 `prisma migrate deploy`，恰好应用激活迁移、激活行恰为一行。(b) 同一 run 被准入为 `GOVERNED_C_TX`，物化出 1 家 canonical company（outcome `CANONICALIZED`/`CREATED`、identity_link、run 回执 1/0），重放不新增行。(c) 激活行连超级用户也改不了、删不了，也插不进第二行；新 run 必须带标记。(d) pre-C run 走 `LEGACY`（`PRE_C_NULL_MARKER`），由 legacy canonicalizer 物化，不产生 C-TX outcome 或回执。
  - 红灯：没有激活迁移时 1 过 4 败（激活、准入为 UNAVAILABLE、不可变、legacy 撞 void）；加上迁移后，受治理路径先撞 void 锁，修复后又撞 finalize-run 的 bigint；两处修复后 5 项全过。随后加的第 6 项：129 条记录的 run 分成满 128 条与 1 条两个批次事务，物化出 129 家公司、两张批次回执。
  - 事务选项：单测记录每次 `withWorkspace` 的选项与其中执行的 SQL，断言只有批次事务（与 legacy 整 run 事务）带 `DISCOVERY_CANONICALIZE_TRANSACTION_OPTIONS`，其余仍为默认；去掉两处调用的选项时这 2 项失败，恢复后通过。选项经 `withWorkspace` 原样交给 `$transaction` 已由 `pii-crypto.lifecycle.spec.ts` 覆盖。
- 部署：与下一版运行镜像同一维护窗口：先停运行时、备份数据库、确认没有发现 run 在途，再 `prisma migrate deploy`。当前镜像（`163ab0fa`）虽已写 v1 标记，但不含上述修复，激活后仍会在 canonicalize 失败；运行时启动时又会核对最后完成的迁移名，迁移后旧镜像以 `MIGRATION_REVISION_MISMATCH` 拒绝启动，所以激活迁移必须与携带它的镜像一起上线。回退是恢复迁移前的数据库备份并切回旧镜像，不是「不部署」或删激活行。
- 未做：canonicalize 之后的环节（qualify 等）不在本项范围；部署与 xin 上的真实 run 验收另行授权并记录。后续两项：
  - 从真实查询阶段（`append_discovery_query_lineage_v2`）一路走到 canonicalize 的端到端真库测试：本项的 Q 血缘按 disposable spec 的做法由 owner 直接写入。
  - `apps/api/scripts/verify-openfda-discovery.mts` 与 `verify-ted-discovery.mts` 用 owner 连接创建不带 v1 标记的 run，激活后会被插入守卫以 `MARKER_REQUIRED` 拒绝；这两个是人工核验脚本，不在产品路径上。

## 2026-10-11 · Stop the dependency-delta canary from failing on a pipe race

- 起因：非必需检查「production dependency delta · canary」在 #628 上报 `dependency-delta protocol bootstrap changed an untrusted path: apps/api/src/ai-tasks/task-registry.ts`，而 PR 的基线早已带新协议标记。`.github/workflows/supply-chain.yml` 在 `set -euo pipefail` 下把 `git show "$PR_BASE_SHA:scripts/supply-chain-audit.mjs"` 直接管道给 `grep -Fq`：grep 读到第一处匹配就退出，`git show` 还在写，于是被 SIGPIPE 杀掉（退出码 141）。pipefail 把整条管道判为失败，可信基线被误送进「协议自举」分支，任何改了白名单外文件的 PR 都会被拒。基线 verifier 越大，越容易撞上。
- 改动：
  - 探测不再经过管道，分三步：
    1. 用 `git cat-file -e` 判断基线里有没有 verifier；
    2. 有就把 `git show` 写进 `$TRUSTED_VERIFIER`，没有就写一个空文件；
    3. 再对这个文件做 `grep -Fq`。
  - 只有两种情况会走自举：基线没有该文件，或文件里没有协议标记。写副本失败时 `set -e` 直接中止；读副本失败（grep 退出码大于 1）时报错退出，不会误走自举。
  - `scripts/supply-chain-gates.spec.mjs`：
    - 原断言逐字钉住了有问题的管道写法，现改为钉新写法。
    - 新增一项行为测试：从工作流里取出探测片段，在临时 git 仓库中用 `set -euo pipefail` 实跑。测试里的 git 提交关掉全局钩子，免得本机的提交前扫描拖慢测试。逐项结果：
      - 1 MiB、首行带标记的基线：连续 3 次判为可信，写出的副本与基线逐字节相同。
      - 没有标记的基线、没有该文件的基线：都判为自举，后者的副本为空。
      - 副本路径不可写：作业非零退出，既不判可信也不走自举。
    - 新增静态规则：去掉注释行后，工作流里不得出现管道接「会提前停止读取」的命令，即 `grep` 带 `-q`、`-m`、`-l`、`--quiet`、`--max-count`，或 `head`。`||` 不算管道。全仓工作流只有原来那一处。
- 测试：
  - 先红后绿：改工作流前，新旧测试都失败；改后 `node --test scripts/supply-chain-gates.spec.mjs` 27/27 通过（约 1.3 秒）。
  - 本机对照：同一个 8 MiB 基线，旧的管道写法 20 次里 20 次误判为自举，新写法 0 次。
  - 静态规则对照：7 种有风险的写法全部识别；`||`、`| awk`、`grep -v`、`grep -c` 等 5 种正常写法不误报。
  - 独立复审结论：可合并。三条低优先级建议都已采纳：区分「没有文件」与「写失败」、测试提交不走全局钩子、静态规则更准。
- 未做：`ci.yml` 的 openapi 漂移检查里还有一处 `git diff … | head -100`。它只在已经要 `exit 1` 的报错分支里打印差异，不影响结论，没有改动。

## 2026-10-11 · Let a deployment accept DeepSeek V4 Flash for pro acquisition calls, labelled as Flash

- 起因：获客唯一的模型上游（new-api 渠道 24 → OpenOx）在 DeepSeek V4 pro 与 Flash 之间不定向切换：请求 `deepseek-v4-pro` 有时由 Flash 应答并报告为 `deepseek-ai/DeepSeek-V4-Flash-0731`，反方向也出现过。身份门照规定判为 `MODEL_IDENTITY_MISMATCH`，验收 run 因此中断。产品负责人 2026-10-11 拍板（D14）：在接入真正的 pro 第二上游之前，获客链路接受 Flash 运行，结果如实标注。
- 改动：
  - 新部署设置 `MODEL_IDENTITY_SUBSTITUTES`（`model-gateway/model-identity-substitutes.ts`）：逗号分隔的「请求>接受」对，默认不设置即关闭。只能开启代码里审查过的组合，目前只有 `deepseek-v4-pro>deepseek-v4-flash`；格式错误、未知模型、自替代、重复或未审查的组合在 Router 构造时抛错，API 与 Worker 启动即失败。
  - 任务合同新增 `acceptsModelSubstitute`，只标在 11 个获客任务上；`site_builder.brand_profile` 与注册表外的任务保持精确身份。获客任务照旧请求 `deepseek-v4-pro`。
  - `model-identity.ts` 新增审查过的别名 `deepseek-v4-flash` ← `deepseek-ai/DeepSeek-V4-Flash-0731`（仅 chat-completions），并注明观察日期。这个别名本身只证明 Flash 身份，不让 Flash 冒充 pro 请求。
  - Router（受围栏保护，复核见 `docs/evidence/execution-authority-fence-review-20261001.md`）：只在非付费路径、只对文本与结构化调用、只在任务标了 `acceptsModelSubstitute` 且部署设置给出该请求模型的替代时，把允许的替代身份经 `AiContext.modelIdentitySubstitutes` 交给 provider；调用方自己带这个字段（自有或继承）会在预留与任何物理请求之前被拒（`MODEL_IDENTITY_SUBSTITUTES_CALLER_SUPPLIED`），付费路径从不替代。
  - provider：上游报告的每个名字都必须解析为请求模型或允许的替代，否则照旧 `MODEL_IDENTITY_MISMATCH`。响应里任何一处名字解析为替代（包括内容块未署名、只有收尾块署名的情形），结果就记为替代模型；同一响应出现两个不同替代则失败；流在解析中途断掉时，已出现的 Flash 名同样让这次失败记为 Flash。provider 另外只认代码审查过的组合，付费上下文一律忽略替代。结果的 `model` 是 `deepseek-v4-flash`，`reportedModel` 是上游原名。
  - 记账：只要一次调用里有任何一次物理请求由替代应答（包括结构化输出首调为 Flash、修复为 pro 的情形），`ai_trace.meta` 与 `usage_ledger.meta` 就写 `requestedModel`、`modelSubstituted: true` 与 `substituteModels`；`model` 列记产出返回答案（或失败答案）的模型，答案来自 Flash 时就是 Flash。开关生效的调用若上游对答案完全没有署名，`model` 只能按请求记 pro，此时 meta 另写 `modelIdentityUnproven: true`。定价与其他调用完全相同（provider 报价、模型无关的 token 混合价或按次上限，没有 pro 专属价格），观测额原样交给预算账本：账本按 `LEAST(观测, 预留)` 扣费，超出预留照常记 `cap_variance` 并耗尽该账户，替代不放宽这道闸。
  - Flash 在现有输出上限与超时下没有问题；网关 provider 只读 `prompt_tokens`、`completion_tokens`、正文与 `finish_reason`，不依赖 pro 才有的推理字段。
- 测试：
  - 先写失败测试：新 `router-model-identity-substitution.spec.ts`、`model-identity-substitutes.spec.ts`，以及身份别名、trace 落库、注册表标记，共 13 项失败、配置模块因不存在而整文件失败；实现后全绿。「默认关闭、空设置、任务未标记、调用方自带替代、其他模型族、未审查的 Flash 名、反方向」这些仍须 `MODEL_IDENTITY_MISMATCH` 的用例在改动前后都通过。
  - 集成测试用真实 provider 与模拟上游，覆盖流式与非流式、文本与结构化、Responses 传输、混合署名、未署名内容、截断与流解析失败、首调与修复分属不同模型、定价与 pro 相同、持久回执扣费不超过预留、持久重放结果记 Flash、启动失败，以及付费上下文、继承来的替代字段、未审查组合都被拒。
  - 独立只读复审第一轮指出：封顶观测额会让替代调用绕过账本的 `cap_variance` 与账户耗尽（HIGH），首调 Flash、修复 pro 的调用不被标记（MEDIUM），另有继承字段、默认关闭说明不准、流解析失败记名、配置可被 `Map.prototype.set` 改写等 LOW。全部修正：对应新用例在修正前的源码上 13 项失败，修正后全绿。第二轮没有 CRITICAL、HIGH、MEDIUM；按其 LOW 建议，调用方自带替代字段改为直接拒绝（原先的剥离会连带丢掉继承来的其他字段），无署名答案加 `modelIdentityUnproven` 标记，新用例在修正前 6 项失败。第三轮复核见围栏复核记录。
- 部署：默认关闭。不开开关时唯一的行为差异来自新别名：请求 `deepseek-v4-flash` 的调用（例如未指定模型、走 `MODEL_DEFAULT_MODEL` 的调用）现在承认审查过的 Flash 构建名，这是同一模型的身份事实，不是替代；请求 pro 的调用照旧只认 pro。要开启，在运行时环境加 `MODEL_IDENTITY_SUBSTITUTES=deepseek-v4-pro>deepseek-v4-flash` 并重启 API 与 Worker；关闭即删除该行再重启。开启期间的跑测报告必须单独统计被替代的调用（`ai_trace.meta->>'modelSubstituted' = 'true'`）与身份未证实的调用（`meta->>'modelIdentityUnproven' = 'true'`），统计 pro 的结果与用量时把这两类排除：首调 Flash、修复 pro 的调用整行记在 `model = deepseek-v4-pro` 下，但带替代标记。
- 未做：真正 pro 的第二上游另行接入；本次没有在 xin 上开启或跑测。开关开启时，失败且上游没有署名的答案仍按 pro 记在 ERROR 行、不带标记（ERROR 行不写 `usage_ledger`），按 `ai_trace` 汇总 pro 的 token 时要排除开启期间的 ERROR 行。

## 2026-10-11 · Normalize Austria, Switzerland, the Netherlands, Poland and Spain, and expand a DACH market to its three countries

- 起因：发现侧的国家词表（`apps/api/src/discovery/vocab.ts`）只认 8 个国家（DE US CN JP IT FR GB IN），没有 AT/CH/NL/PL/ES；ICP 目标市场写成「DACH区域」这类地区词时，没有任何一处把它展开成国家：规划器提示词定不出关键词语言；TED、openFDA 冷路径与定时意向扫描把它当作一个国家词交给 taxonomy，未命中别名时由模型在码表里挑**一个**国家，并把这条别名沉淀下来。
- 改动：
  - `vocab.ts`：`COUNTRY_ISO` 与 `COUNTRY_QIDS` 各补 AT/CH/NL/PL/ES，写法与已有国家相同（中文名、英文名、本国语名，另收常见的无变音拼写与瑞士的法、意语名）；QID 与 `seed-taxonomy.mjs` 的 `ALPHA2_TO_QID` 一致。新数据表 `MARKET_REGION_COUNTRIES`（「DACH」及其常见写法 → DE、AT、CH）与 `lookupMarketRegion`、`expandMarketRegions`。地区词不进单国表：单个公司的所在国不会是「DACH」，public_web 对它照旧不填国家。
  - `icp-to-cpv.ts` 的 `boundedTargetCountries`（TED、openFDA 冷路径与定时意向扫描共用）：地区词先展开为成员国 alpha-2 码再交给 taxonomy；这三个码由 seed 别名确定性归一，不再调用模型。
  - `search-localization.ts` 的 `targetCountries`（规划器关键词语言、public_web 搜索语言与 ccTLD 过滤、名录查询的国家名、网站画像按 ICP 市场回退的本国）：country / iso_country / buyer_country 里的「DACH」，以及只有 region 时的「DACH」，都展开为三国，效果与直接写「德国、奥地利、瑞士」相同。
  - `vocab.ts` 的查表只认表自己的键（`Object.hasOwn`）：地区查找每个计划、每条查询都要走，模型给出「constructor」「__proto__」这类词时原本会取到对象原型上的属性，`targetCountries` 因此抛 TypeError；旧的行业、国家、OSM 查找在同样输入下会把函数当成码返回。
  - 已有国家的映射与行为不变：单测逐条钉住原有 18 个国家词及国家码集合只新增五个。
- 测试：
  - 新增与改写的单测分布在 `vocab.spec.ts`、`search-localization.spec.ts`、`icp-to-cpv.spec.ts`、`icp.service.spec.ts`（规划器级：目标市场「DACH区域」→ 提示词要求德语关键词，TED 与 openFDA 冷路径收到 DE、AT、CH）与 `public-web-raw-governance.spec.ts`（「Österreich」→ AT、「ch」→ CH，原先「Österreich」被当作未知国家）。
  - 红灯：实现前这 5 个文件 40 项失败；实现后 177 项全过。查表加固另加 5 项（原型属性名），加固前其中 3 项失败（一项是 `targetCountries` 抛 TypeError），加固后 5 个文件 182 项全过。
- 未做（留给国家包）：
  - `search-localization.ts` 的 10 国表与 `vocab.ts` 的两张国家表仍各自维护。
  - 执行查询时的 taxonomy 归一（`queryTaxonomyTerms` → 单值 `_countryQid`）、`wikidata.provider` 的 `mapCountry` 与 OSM 的 `REGION_OSM_AREA` 都只取一个国家，「DACH」在那里仍只落到一国；多国需要改这些源的查询形态。若 `term_alias` 里已有模型沉淀的地区词别名，本项不清理：列表路径先展开、不再查它，单值路径仍会命中它。
  - 未在 xin 上重新生成查询计划（需要模型调用并写开发库），留到部署后的验收。

## 2026-10-11 · Never plan or route a discovery source without governed lineage (lineage gate)

- 起因：#631 激活受治理公司物化后，带 v1 标记的 run 要求每条计划查询都有受治理回执，否则在归一阶段以 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD` 停下（BI-30 条目的「未做」已记）。公司发现源里只有 `public_web`、`directory`、`trade_fair` 声明了受治理公司血缘（`companyResultLineage`），`wikidata`、`openstreetmap`、`ted`、`openfda` 没有。xin 上这四个源都是 DISABLED，但只要其中一个被改成 ENABLED，规划器就会为它出查询（TED/openFDA 还会经冷路径注入），执行时它走 legacy 路径、不写受治理回执，整个 run 卡在物化。
- 改动（血缘闸门，只读既有的那一份声明）：
  - `company-discovery-lineage.ts` 新增 `declaresDiscoveryCompanyLineage(adapter)`（`companyResultLineage === v1`），作为唯一判断：受治理执行计划（`buildGovernedDiscoveryQueryExecutionPlan`）、registry 路由与规划器都用它。两份血缘合同里手写的键判断改为读各自的合同对象（回执合同 `isDiscoveryCompanyLineageProviderKey`、查询血缘合同 `isDiscoveryQueryLineageProviderKey`）；合同对象本身仍各有一份（查询血缘合同的描述进合同哈希、钉在迁移里），补新源时要一起改。registry 用例逐源核对：声明了血缘 ⇔ 两份合同都收。
  - registry：`companyDiscoverySources()` 的每个源带 `hasCompanyLineage`；`routeCompanyDiscovery` 只返回 ENABLED 且声明了血缘的适配器。
  - 规划（`plan-query-sources.ts`）：源要 ENABLED 且有血缘才算可执行。没有血缘的源不进提示里的可用数据源清单；没写 hint 的查询不再拆出这些源的副本；只开了这些源时 `hasPlannableSource` 为 false（照旧 409 `NO_ENABLED_DISCOVERY_SOURCE`，不调模型；码不变，message 改为说明要有受治理血缘）；TED/openFDA 冷路径只在源可执行时解析、注入（`isSourceEnabled` 改名 `isSourceRunnable`），已启用却因没有血缘而没注入的冷路径源各按一条 `SOURCE_LINEAGE_UNAVAILABLE` 记进移出说明（`countLineageGatedColdPaths`）。模型写给这些源的查询移出计划，按新原因 `SOURCE_LINEAGE_UNAVAILABLE` 计数，记在 `[source_filter]` 说明里；模型自己写的 TED/openFDA 查询仍记 `SOURCE_SYSTEM_PLANNED`。
  - 执行（`executeQuery`）：路由不到适配器的查询照旧跳过并写一条零回执，不调词表归一与 provider。跳过原因由 `planQuerySkipReason` 判：查询指向的已登记源都没有血缘时为 `SOURCE_LINEAGE_UNAVAILABLE`（开没开都一样），有血缘的源只是停用时仍为 `SOURCE_DISABLED`；重试重放 providers 为空的受治理回执时同样报告。没写 hint 的旧计划查询只跑同类里有血缘的源。
  - 工作流把 `SOURCE_LINEAGE_UNAVAILABLE` 计入 `stats.skippedQueries`，run 至少 PARTIAL，不失败。没有新增 Temporal 命令，工作流只引用无依赖的跳过原因清单，重放不受影响。
- 测试：
  - 先红：新增与改写的用例在实现前 20 项失败（规划规则 6、registry 4、`executeQuery` 6、工作流 1、ICP 规划 3）。
  - `executeQuery` 用真实 registry（全部公司发现源 ENABLED）逐个跑 `wikidata`、`openstreetmap`、`ted`、`openfda` 的查询：provider 与词表归一都不调用，写零回执，跳过原因为 `SOURCE_LINEAGE_UNAVAILABLE`；`public_intelligence` 类无 hint 的查询只调用 `public_web`。
  - registry：有血缘的源恰为 `public_web`、`directory`、`trade_fair`，且与回执合同覆盖的键逐一一致（声明了血缘而合同不收的源会让受治理查询失败）。
  - BI-30 既有用例里把 Wikidata/OSM 当作「停用源」举例的，改用 `directory`/`trade_fair`；冷路径用例显式声明 TED/openFDA 有血缘，验证补上血缘后行为不变。
  - 复审修正（冷路径计入移出说明、409 文案）先红 6 项后通过；与 #635 合并后，它的 DACH 冷路径用例同样显式声明 TED/openFDA 有血缘。
  - 受影响的 12 个用例文件（含 #635 的 vocab、search-localization、icp-to-cpv）439 项通过。
- 契约：OpenAPI 无改动（409 码与说明不变）；`packages/contracts/INTEGRATION.md` 阶段 2 补上新跳过原因，`docs/backend/discovery-sources.md` 集成点 1、2 同步。
- 未做：给 `wikidata`、`openstreetmap`、`ted`、`openfda` 补受治理血缘（lineage 合同升级，含迁移）不在本项；补上之后这些源自动通过闸门，不用改本项代码。已保存的 READY 计划不回写，其中指向这些源的查询执行时按 `SOURCE_LINEAGE_UNAVAILABLE` 跳过。

## 2026-10-10 · Refresh the official sanctions lists through an owner-run operator command

- 起因：产品负责人 2026-10-10 按平台 schedule 准入设计（PR #625）拍板：冻结 R4，4 个平台 schedule 继续暂停，制裁名单走方案 B0（不经平台 schedule 的运营刷新），打开制裁门另行批准（D9）。当时 `sanctions_source` 里 `ofac_sdn` 为 DISABLED、9,810 个实体（07-13 名单，07-14 刷新），`ofac_consolidated` 与 `eu_fsf` 为 DISABLED 且从未入库；平台 `sanctionsRefreshWorkflow` 跑不了，ToolBroker 对平台调用扣住 `sanctions-download/v1`。
- 改动：
  - 新运营命令 `apps/api/scripts/refresh-sanctions-lists.mts`（`--source=all` 或逗号列表、`--dry-run`、`--timeout-seconds`），逻辑在 `sanctions/sanctions-operator-refresh.ts` 与 `sanctions/sanctions-operator-download.ts`：
    - 只用 `DATABASE_URL`（库属主）。连接角色是 `app_user`，或既非超级用户、又不拥有两张制裁表，就在读源和下载之前拒绝。
    - 每个选中源的 `url`、`format` 必须与种子里的官方端点逐字一致（美国财政部 OFAC、欧盟 FSF），否则整次运行在下载前拒绝。source_policy 用 ToolBroker 自己的 `checkSourcePolicy` 判定，未登记、SUSPENDED、用途不符都拒绝。
    - 下载经 guarded HTTP：只连公网地址，每一跳重新解析并钉住，最多 3 跳，32 MiB 上限，单跳截止默认 600 秒；最后一跳须为 https，媒体类型须为 XML，严格 UTF-8，再过 artifact 路径同一道 XML 安全检查。连接中断、超时、DNS 失败、HTTP 429/5xx 最多试 4 次（间隔 5、15、45 秒），其余失败不重试。
    - 写入交给 `SanctionsRefreshService` 的无回执分支。新增 `refreshSourcesByKey`：不论状态刷新指定的源，逐源 fail-safe 与 `refreshAll` 相同。归一、内容摘要、撤下、版本与元数据更新全部复用，不写 `status`。
    - `--dry-run` 下载、解析，用服务同一套纯函数算出将新增 / 更新 / 不变 / 撤下与收缩保护判定，打印每个源保留的实体数与按类型剔除的条数，不写库。
  - `SanctionsRefreshService` 的无回执分支改为单个属主事务（`maxWait` 10 秒、`timeout` 10 分钟）。此前逐条直写，中途失败会留下半新半旧的名单。另导出 `sanctionsParserFor`、`sanctionsListVersion`、`sanctionsShrinkGuardTripped` 给 dry run 复用。
  - 两个解析器多返回 `subjectTypes`：按 sdnType / subjectType 计数，只有数字，不含名字。OFAC Consolidated 与 SDN 同一 XML 结构，直接用 OFAC 解析器。
  - `requestPublicHttp` 新增 `operatorTimeoutMs`：只有运营下载能把单跳截止设到 30 秒以上（上限 30 分钟）。工具与活动仍限 30 秒，有测试锁住。
  - 导出 `SANCTIONS_SOURCE_SEEDS` 与物化器的 `validateSanctionsXml`；`source-tools.ts` 的「不经 Broker 的出网」例外清单加一行。
  - 新 runbook `docs/backend/sanctions-operator-refresh.md`：运行命令、失败与重跑、单独的打开语句（SQL）与回退、新名单何时生效。
- 新名单何时生效（没有加新机制）：只有 ENABLED 且有活跃实体的源进入筛查索引，刷新 DISABLED 的源对筛查没有影响。customer worker 每次 qualify 开始时重建索引；API 每 `SANCTIONS_INDEX_REBUILD_MS`（默认 1 小时）重建，要立即生效须重启 API。
- 测试：
  - 先写失败测试：解析器计数、HTTP 截止上限、服务事务与 `refreshSourcesByKey` 共 13 项失败，两个新模块的测试文件因模块不存在而失败；实现后全绿。之后加的重试 7 项同样先红后绿。
  - 单测用合成 XML（名字全为虚构，含个人、船舶、飞机条目）：官方端点逐字比对与 10 种拒绝情形、属主守卫、参数解析、dry run 不写、计数、下载校验与重试、服务事务、不写 `status`。
  - 真库测试 `sanctions-operator-refresh.postgres.spec.ts` 9 项，接进 CI 新步骤「Sanctions operator refresh on PostgreSQL」：拒绝 `app_user`；dry run 不写一行；只入实体、元数据更新、`status` 不变；同一名单重跑零增改撤；新版本的增改撤；写入末尾注入失败时整体回滚（去掉事务后此项与其后一项失败）；SUSPENDED 拒绝下载；失败后重跑恢复 DONE；runbook 的打开语句让 `app_user` 的筛查索引生效。
  - 真实官方名单，写入一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据在 tmpfs，用完即删）：
    - OFAC SDN 29,167,737 字节，发布日 2026-10-09，19,416 条，保留实体 10,018，剔除个人 7,497、船舶 1,559、飞机 342；
    - OFAC Consolidated 1,062,957 字节，发布日 2026-09-14，481 条，保留 363，剔除个人 118；
    - EU FSF 25,791,425 字节，生成日 2026-09-22，6,241 条，保留 1,776，剔除个人 4,465。
    - 首次写入三源 DONE，`status` 仍为 DISABLED；每个源再跑一次都是零新增、零更新、零撤下。逐个核对 ID：库里没有一条个人、船舶或飞机条目。
    - 把 xin 上 07-13 版的 SDN 行只读复制到一次性库后 dry run：将新增 319、更新 19、不变 9,680、撤下 111，收缩保护通过。随后写入，结果与 dry run 逐项相同（活跃 10,018 行，撤下的 111 行保留 07-13 版本号），再跑一次零变化。
- 未做：没有在 xin 的 `global_dev` 上运行；运行与打开制裁门都待产品负责人批准。SDN 已到 32 MiB 上限的约 87%。本机经代理下载时 DNS 解析与连接偶尔失败（实测中出现过 `dns_lookup_failed` 与 `ECONNRESET`），已由重试与单源重跑覆盖。

## 2026-10-10 · Admit customer writes on their own dependencies, not platform worker availability

- 起因：#545 把独立的 platform Worker 租约加进了整体 readiness 的硬组件，而全局写入守卫 `RuntimeWorkAdmissionGuard` 只认整体 readiness。所以 platform Worker 一不就绪（单独重启、换镜像后尚未重新就绪、R4 部署绑定到期、出网围栏重装），除平台控制面豁免外的全部客户侧写入都返回 503 `RUNTIME_ADMISSION_CLOSED`，包括 GrowthOS 签 Grant 前调用的 workspace 技术报价，以及删除请求、禁联这类保护性写入。而 platform Worker 只服务 `platform-automation` 命名空间（4 个 schedule 均 paused）；客户路径用的 `default` 命名空间、customer Worker、Outbox Relay 与 API 的 Temporal 客户端都不依赖它。产品负责人 2026-10-10 批准 D3 设计的推荐方案。
- 改动：
  - 新增纯函数 `customerWriteAdmission(report)`（`apps/api/src/runtime/customer-write-admission.ts`）：整体 ready 照旧放行；not_ready 时硬组件仍须全部 ok，唯一容忍 platform Worker 恰为 `failed` / `PLATFORM_WORKER_NOT_READY`（没有 READY 租约：租约不在、已停止，或同一发布仍在 STARTING/DRAINING）。容忍表以 `satisfies` 覆盖全部硬组件，新增组件不分类就无法编译；表外组件失败、缺组件、组件值或状态不合法、失败却没有字符串码、「not_ready 却没有失败项」的快照一律关闭。换镜像时新旧发布的租约并存期间仍是混版本，客户写入照旧关闭；只有旧租约消失后、新 platform Worker 尚未就绪的那段不再关闭。
  - `RuntimeWorkAdmissionGuard` 改为 `admission.current().admitted && customerWriteAdmission(readiness.current()).open`；两类平台控制面豁免与 503 响应体都不变。
  - `SiteBuildRuntimeGuard` 用同一函数（D3 决定 3）；`failedComponents` 照旧列出全部失败组件（含被容忍的那个），付费构建仍要求结算读回。
  - 不变：`/health/ready` 的口径、响应格式与 503 码，「platform Worker 租约缺失时整体仍为 not_ready」的既有用例原样保留；platform Worker 自检与 fail-closed；静态发布准入；platform Worker 混版本（`PLATFORM_WORKER_MIXED_RELEASE_IDENTITY`）、Temporal 身份不符（`WORKER_TEMPORAL_IDENTITY_INVALID`）、租约查询失败（`RUNTIME_PROCESS_LEASE_UNAVAILABLE`）照旧关闭客户写入。没有迁移、OpenAPI、环境开关或 parity 指纹文件的变化。
  - 文档：AGENTS §4 第 5 条补一句「『API 不接新工作』按该工作自身的依赖集合判定」（产品负责人批准）；架构页 readiness 一段补上 platform Worker 租约与「整体就绪不等于客户写入准入」；状态页新增 §4.4；R4 已批准规格 §4 加注。
- 测试：
  - 新 `customer-write-admission.spec.ts`（45 项，零容器）：只有 platform Worker NOT_READY 时放行；platform Worker 的其他码（混版本、身份不符、租约不可用、发布身份不可用、大小写或空格漂移）与 not_proven 都关闭并返回该码；其余每个硬组件逐一失败（failed 或 not_proven，单独或与 platform Worker NOT_READY 同时）都关闭；其余每个硬组件以 `failed` 但码为 null、undefined 或非字符串出现时都关闭；未分类组件失败、缺组件、不可枚举的组件、组件为 null、状态非法、not_ready 却无失败项、初始快照都关闭；就绪服务实际报告的组件键与容忍表逐一相同，且容忍项恰为一项；以真实 `RuntimeProcessLeaseService` 证明租约缺失、STARTING、DRAINING、STOPPED 产生的正是被容忍的码，换版本、错命名空间、错集群产生的码不被容忍。
  - 守卫与建站门各加 3 项：platform Worker 只是 NOT_READY 时放行；platform Worker 完整性失败或客户 Worker 未就绪时仍是原样的 503；静态准入关闭、付费构建缺结算读回时仍关闭。
  - 新组合测试 `customer-write-admission.composition.spec.ts`：真实就绪服务、真实租约检查、全局守卫与 HealthController 经 HTTP 串起来。platform Worker 缺席或 STARTING 时 `/health/ready` 为 503 且写明 `PLATFORM_WORKER_NOT_READY`，客户 POST 得到 201；platform Worker 换版本或客户 Worker 缺席时 POST 为 503；两者都 READY 时为 200 与 201。
  - 红灯：改代码前，新纯函数测试因模块不存在而失败，守卫、建站门与组合测试里「只有 platform Worker NOT_READY」的 4 项失败，其余新增用例（仍应关闭的情形）通过；再以沿用整体 readiness 的过渡实现跑纯函数测试，只有 2 个放行用例失败、27 项通过。独立复审指出容忍表的 null（必须 ok）会与 `code: null` 的失败相等、不可枚举的组件会被跳过：补的 16 项先全部失败（函数放行），修正后通过；这两种输入目前没有任何生产者会产生。
- 部署：只改 API 进程里的一个判定，没有迁移、数据、配置或契约变化。发布镜像、xin 切换与切换后的本机验收（停 platform Worker 时 `/health/ready` 为 503 而客户写入不被准入守卫拦下；停客户 Worker 时仍为 503）另行授权并记录。回退为 revert 后发布，或切回上一版镜像。
- 未做：
  - platform Worker 频繁单独重启的根因另立任务。
  - 平台故障不再经由客户写入 503 暴露；本机 `gctl doctor` 的「platform_worker 持续不就绪」告警属工作区工具，另行修改。
  - 按端点细分依赖（例如获客写入不再要求建站专属组件）不在本项范围。

## 2026-10-10 · Design the lead delivery loop: package fields, weekly report, feedback and contact drafts

- 设计 `docs/superpowers/plans/2026-10-10-lead-delivery-loop-design.md`（APPROVED），对应 BI-15、BI-19–BI-23。产品负责人当天拍板 E1–E9：
  - `LeadQualified` 仍为 v1，只加可选字段；
  - 周报为本周 accepted 线索的 CSV；
  - 线索级成本分摊估算并注明口径；
  - 拒绝原因码必填；
  - 开发信草稿给目标国语言加中文译文，末尾附卖方自己的 WhatsApp 一键聊天链接，由买家先开口；
  - 联系路径加入公司自己的领英公司页、X 账号链接；
  - 修复信号挂不上有域名公司的缺陷。
- 客户跟进前台只用 GrowthOS，不接其他 CRM。
- 本条只有文档；按设计 §11 拆 6 个 PR 施工。

## 2026-10-10 · Record why paused platform schedules cannot be admitted, and the decision to freeze R4

- 起因：为补平台写入者的表授权（2026-10-09 设计的 P4）做只读核对时发现，4 个暂停的平台 schedule 现在恢复，第一步就会失败。
  - 四个工作流的第一步 `admitPlatformSchedule` 调用 `admit_platform_execution_budget_run_v1`；`20260905193000` 已收回平台写入者对它的执行权。
  - 替代的 v2 要 GrowthOS 为每次运行签发平台授权。GrowthOS 只有签名器，没有持久签发与投递；Backend 的 v2 服务没有调用方。
  - 另有 10 张表平台写入者没有授权。
- 设计 `docs/superpowers/plans/2026-10-10-platform-schedule-admission-and-writer-grants.md`（APPROVED），产品负责人当天拍板：
  - 冻结 R4（D2），不在 R4 准入上继续投入；
  - RL1 期间平台 schedule 继续暂停；
  - 制裁名单走不经平台 schedule 的运营刷新，之后打开制裁门（D9）；
  - 平台工作流迁进 customer worker 的设计另出。
- 本条只有文档，没有代码与迁移。

## 2026-10-10 · Extend the admission lease to ICP design and ICP query planning

- 起因（2026-10-10 xin 实测）：一次 ICP 查询计划（`POST /icps/:icpId/query-plans`）返回 HTTP 402 `EXECUTION_BUDGET_GRANT_EXPIRED`。Grant 10:12:04 签发、10:17:04 到期，10:12:10 准入（authority 为 `icp.query_plan` + `icp`）。请求先做一次约 130 秒的规划调用，再做 9 次串行的 `taxonomy.normalize`（10:14:21 至 10:18:13）；10:18:04（到期加 60 秒容差）之后的下一次预留被拒。ICP 设计（`POST /companies/:companyId/icps`）是一次模型调用（10-10 为 130 至 150 秒，账本里最长 3 分 04 秒）；按现有代码它在准入后只核验与预留一次，修复调用也在同一个预留里，不会因模型耗时在准入后过期，给它租约是防御性的。产品负责人 2026-10-10 决定：准入租约扩展到这两个操作，时长 30 分钟；发现 run 仍是 3 小时，不包含其他用途。设计见 `docs/superpowers/plans/2026-10-09-discovery-run-admission-lease.md` §8。
- 追踪结论：两个端点都是同步 HTTP，不经 outbox 或 Temporal。准入后唯一的时间检查是 `attest_authorized_tool_budget_v1`（模型调用前的直接核验、每次 reserve 都经过它），它自 #618 起已按 `COALESCE(admission_lease_expires_at, expires_at)` 判断；binding 不含时间，准入后没有 TS 代码比较 Grant 的 `exp`。所以只需在准入时写入租约，attest 与 TS 都不改。
- 改动：
  - 新迁移 `20261010110000_icp_admission_lease`（单个事务，`lock_timeout 5s`）：
    - 准入 `WORKSPACE_GRANT` 的 `icp.design` + `company`、`icp.query_plan` + `icp` 时写入准入时刻加 30 分钟。`consume_workspace_execution_authority` 从 #618 的定义逐字复制，只在租约 CASE 里加两条 WHEN；仍是 SECURITY DEFINER，search_path 为 `pg_catalog, public, pg_temp`，属主与 EXECUTE 授权不变。
    - 替换 `execution_budget_authority_admission_lease_check`：仍要求 `WORKSPACE_GRANT`、`consumed_at` 非空、租约晚于 `expires_at`；三组 purpose 与 subject_type 各有上限，发现 run 3 小时，两个 ICP 操作 30 分钟。列注释同步。
    - 不回填：迁移前准入的 ICP 行租约为 NULL，照旧按 Grant 窗口判断。撤销、范围、cap、耗尽和单持有者检查不变；其余用途仍为 NULL。
  - `schema.prisma` 只改该字段的文档注释，Copy 已重签（只变指纹）。
  - 文档：落地设计加「2026-10-10 扩展」；架构设计与 ADR-024 写明两个 ICP 操作的租约。
- 测试：
  - 新静态合同 `icp-admission-lease.migration.spec.ts` 7 项（零容器）：单事务、带锁超时、不回填、只去掉并重加这一个 CHECK；CHECK 原文；函数写入的时长与 CHECK 每组的上限一致；只重定义 consume；consume 与 #618 的定义逐字比对，只差两条 WHEN；中间没有别的重定义；Prisma 字段注释。加迁移前 7 项全部失败。部署顺序无法静态检查，见下面「部署」。
  - 真库合同扩写进 `discovery-run-admission-lease.postgres.spec.ts`，新增 7 项，原有 10 项保留（ICP 两种从「无租约」列表移到新用例）。同一开关、同一 CI 步骤，所以 ci.yml 不用改。新增用例：两个 ICP 操作的租约恰为准入加 30 分钟，重放不改租约；准入 10 分钟后仍能核验、预留（0 微美元）和释放；租约到期有 60 秒容差，过后报 `GRANT_EXPIRED` 且 TS 映射为同名错误；租约内撤销、额度耗尽、换工作区、账户关闭照旧拦住；准入与 open 仍受 Grant 窗口约束；CHECK 拒绝超过 30 分钟（含 1 小时）与不晚于 `expires_at` 的 ICP 租约，发现 run 仍以 3 小时为上限，其他用途连 10 分钟的租约也拒绝；租约为 NULL 的 ICP 行按旧口径判断。
  - 一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据放 tmpfs，用完即删）：只部署 main 的迁移时新增 7 项中 6 项失败（无租约一项本来成立），核心是准入 10 分钟后报 `GRANT_EXPIRED`；在同一个库上部署新迁移，红灯阶段留下的发现 run 3 小时租约行通过新 CHECK 校验，17 项全过。#616 的 search_path 静态与真库护栏、原生 SQL 参数类型、治理表只读的真库用例都通过。
  - xin 数据副本（`global_dev` 的 `pg_dump -Fc` 加不含密码的角色，恢复到一次性容器，没有写 xin 的库，转储用完即删）：`prisma migrate deploy` 只应用本迁移；49 行存量全部通过新 CHECK；consume 与 attest 的属主、ACL、SECURITY DEFINER、易变性与 search_path 前后一致，attest 定义未变；10-10 失败的那个 authority 仍报 `GRANT_EXPIRED`；在副本上准入一次 ICP 设计和一次查询计划（回滚），租约都恰为 30 分钟。
- 部署：迁移与带它的镜像在同一窗口上线，按名称顺序排在 #621（`20261010090000`）与 #622（`20261010100000`）之后。运行时要求库里最后完成的迁移与镜像的 `migration_revision` 一致；切换时不能有发现 run 或 ICP 请求在跑。#621、#622 须先合，或三者合入后同一窗口部署：若本迁移先单独上线，之后再部署名字更早的迁移会让运行时拒绝启动。
- 未做：
  - 客户端超时或断开后，服务端会在租约内把请求跑完（最多花到 cap），此前约 6 分钟后被拒。GrowthOS 仍不能撤销 workspace grant。
  - #597（草稿）按「之前的 Grant 已过 60 秒容差」判断能否为 ICP 请求重试，合入本扩展后要在变基时改为按租约判断；它换户前会关闭旧账户，不会重复花钱。
  - `understanding.run` 与联系人端点仍是 5 分钟，出现同类失败时再按本机制各加一个条件。

## 2026-10-10 · Lock the site-build budget for publication through an owner routine

- 起因（2026-10-10 审计 app_user 表权限时发现，一次性库复现）：带质量环的建站翻新（Temporal patch `site-builder-m1f-quality-loop-v1`，新 run 都走这条路）在发布前要带行锁读本次构建的预算（`site-builder.activities.ts` 的 `finalizeRefurbish`），防止结算在检查和发布之间改动预算的状态或原因。这一步以 `app_user` 执行，而 `20260816220000_production_parity_budget_runtime` 起 `app_user` 对 `site_build_budget` 只有 SELECT。任何行锁（FOR UPDATE / SHARE 等）都要 UPDATE 权限，所以这句一律报 `permission denied for table site_build_budget`，不论有没有匹配的行：质量环的翻新一个也走不完。单测把 `$queryRaw` 整个替身掉，原生 SQL 真库测试只做 PREPARE、不检查权限，所以没有暴露。
- 改动：
  - 新迁移 `20261010100000_site_build_budget_publication_lock`：新增 SECURITY DEFINER 函数 `lock_site_build_budget_for_publication(workspace, build_run)`。它和现有的预算结算函数一样，先核对调用方事务的工作区，再以属主身份对预算行加 `FOR UPDATE` 锁，返回发布检查要读的两个字段。行锁持续到调用方事务结束，所以发布与结算按设计串行。search_path 以 `pg_temp` 结尾；只授 `app_user` 执行。`app_user` 的表权限不变。
  - `finalizeRefurbish` 改为调用这个函数读预算。
- 测试：
  - 新的真库测试 `site-build-budget-publication-lock.postgres.spec.ts`，接进 CI「Raw SQL parameter types on PostgreSQL」一步。只跑 main 的迁移时除第一项外全部失败（函数不存在），加上迁移后 7 项全过：
    - `app_user` 自己加行锁被拒（42501）；
    - 函数返回本工作区构建的预算字段；
    - 第一个调用方的锁持续到其事务结束，另一个调用方在 200 毫秒锁超时内报 55P03，前者提交后可取得；
    - 锁住期间，结算函数 `disable_site_build_paid_calls` 同样报 55P03，改不了这一行；
    - 其他工作区的调用被拒；
    - 没有预算的构建返回空；
    - PUBLIC 不能执行，`app_user` 可以（属主与 `app_user` 的成员角色本来就能）。
  - 单测：质量环的发布经由这个函数读预算，SQL 里不再有任何行锁子句，参数是工作区与构建 ID。
  - CI 那一步的三个真库测试在一次性库上全过；建站相关 132 个测试文件 3,253 项通过。
- 部署：迁移与带它的镜像在同一窗口上线，按名称顺序；它排在 #621（`20261010090000`）之后，两者都随下一个窗口发布。
- 未做：
  - 收尾先调 `terminalCostSummary`，其中 `disable_site_build_paid_calls(…,'run_succeeded')` 会无条件改写 `disabled_reason`，且不取进度锁；所以已记下的取消、`settlement_exceeded_reservation` 等原因可能在加锁之前被覆盖，取消请求也可能在发布之前被收尾抢先。这是原有的缺口（这条路径此前根本走不通），另行处理：保留已有原因，或在进度锁下关闭预算。
  - 原生 SQL 真库测试只以属主 PREPARE，PREPARE 不检查权限。系统性的补法是对收集到的语句再以 `app_user` 执行 EXPLAIN（会检查权限），其他身份执行的语句单列白名单；另行评估。

## 2026-10-10 · Monthly dependency refresh and audit baseline renewal

- 按[依赖刷新 runbook](../backend/dependency-refresh.md) §3 做 10 月批量（接手原定的月度刷新会话，基线原定 10-14 到期）：`pnpm update -r '!sharp'` 在声明范围内更新，`package.json` 的范围下限随之改写为实际版本。实际变化的直接依赖：`ai` 7.0.124→7.0.137（及 Anthropic/OpenAI provider）、AWS S3 SDK 3.1144→3.1149、astro 7.3.5→7.3.8、OpenTelemetry core/sdk-trace-base 2.11→2.12、Langfuse 5.11→5.13、`@scalar/nestjs-api-reference` 1.2.25→1.2.28、`@redocly/cli` 2.57→2.62、`@stoplight/spectral-cli` 6.16→6.17、nx 23.2.1→23.3.0、eslint 10.11→10.12、prettier 3.9.9→3.9.10 等；传递依赖含 `@grpc/grpc-js` 1.14.6、vite 8.3.4、Sentry 10.76、puppeteer-core 25.13。Temporal SDK 在 1.24.0 之后没有新版；sharp 保持确定性图片管线的 0.35.5；OpenTelemetry 整族锁步：`sdk-node`、`exporter-trace-otlp-http` 是 0.x 版本，`^0.222.0` 不跨次版本，而 0.222.0 精确依赖 2.11.0 的稳定包，范围内更新后锁文件里 2.11.0 与 2.12.0 并存，Langfuse 运行时遥测会把 0.222.0 的 NodeSDK 与基于 2.12.0 的 span 处理器、exporter 混用；两者改为 `^0.223.0`（与 2.12.0 配套的实验版，唯一破坏性变更在浏览器端 web-common），稳定包统一为 2.12.0，遥测用例照常通过；`packages/db/package.json` 丢弃纯表面的 prisma 范围改写（解析不变），漂移集合不越出已审范围。各精确钉版同族包在锁文件里都只有一个版本。
- override：postcss 8.5.26→8.5.29（含 `</style>` 转义改进）、nanoid 3.x 3.3.18→3.3.20（含超大 ID 使进程退出的修复）、deepmerge-ts 8.0.1→8.0.2、smol-toml 1.9.0→1.9.1，安全下限不变。nx 23.3.0 不再依赖 axios，axios 整个离开依赖图：撤掉 `axios@<1.20.0` override、安全下限与前任登记（runbook：下限包离开依赖图时测试报 `version: null`）。undici 8.x、fast-uri 两条保留（astro 7.3.8 用的 unifont 0.7.5 仍要求 `undici ^8.0.0`，ajv 8.20.0 仍要求 `fast-uri ^3.0.1`）。nx 23.3.0 另外精确钉了 undici 7.29.0，全量（含开发依赖）审计因此多出 10 条 advisory（2 条高危，修于 7.29.1）；沿用 10-01 处理 nx 钉版 axios 的做法，加以漏洞区间为选择器的 `undici@>=7.0.0 <7.29.1` → 7.30.0。pnpm 按声明范围与区间是否相交来套用 override，生产路径上 `@ai-sdk/provider-utils` 的 `^7.29.0` 也与之相交，所以它同样被钉在 7.30.0（原本就解析到 7.30.0，锁文件只留一个 7.x），此后 `pnpm update` 不再移动这份 undici；只钉 nx 的 `nx>undici@<7.29.1` 写法不被来源策略接受（override 键只允许包名或包名@区间）。撤除条件：nx 不再钉低于 7.29.1 的 undici，且 provider-utils 声明的下限不低于 7.29.1。安全下限新增 7 线 undici ≥7.29.1、登记前任 7.29.0（对上一版锁文件失败、对当前通过）。全量审计回到 main 上已有的两条开发告警：Prism mock 链的 faker 与上游尚无修复版本的 braces（≤3.0.3，经开发工具链）。trace_engine 仍是已审的 0.0.65，dist-tag 守卫不变。
- Actions：`actions/setup-node` v7（82076278）→v7.1.0（949feb24，版本校验、清单拉取重试；我们只传 `node-version: 22`）；`github/codeql-action` v4.38.2→v4.38.3（只用于非必需 canary，默认 bundle 2.27.2）。`oasdiff-action` v0.1.18 暂不升：它带来的 oasdiff 1.33.0 把 schema diff 改成按图计算、改写子 schema 匹配，影响必需门 `breaking` 的判定，按上次先例需另行离线重放最近的 `openapi.json` 变更再升（本仓 44 个 schema 无循环引用，它主打的递归修复对我们无影响）。
- 新发布版本核对：pnpm 9 没有最短发布时长，164 个新锁定版本里过半发布不足 4 天（最新的 strnum 2.5.1 只有数小时）。2026-10-06T00:00Z（UTC）以后发布的、首次没查到发布时间的，加上四条 override 升级，共 126 个逐个核对 npm provenance 与发布账号：99 个带 provenance，26 个不带 provenance 但由与先前版本相同的账号发布（aws-sdk-bot、sentry-bot、DefinitelyTyped 等），1 个换了发布账号；唯一带安装脚本的 nx 23.3.0 带 provenance。chromium-bidi 由 17.0.2（带 provenance）换成 Chromium 发布账号的 157.0.8090-0（无 provenance）：带 provenance 的 puppeteer-core 25.13.0 精确钉了该版本，chromium-bidi 源码已迁入 Chromium、版本改随 Chrome，予以接受。未回退任何版本。
- 官方 registry 生产审计零 advisory（831 个依赖）；基线重新绑定到刷新提交，失效时间 2026-10-14T21:28:22Z → 2026-10-24T13:59:34Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261010-monthly-dependency-refresh-baseline-renewal.json)）。Copy fixed-source 回执只重签指纹（`HASH_ONLY`）。下一次月度刷新与续期须在 10-24 前合入。

## 2026-10-10 · Plan discovery queries only for ENABLED data sources

- 起因（BI-30，产品负责人 2026-10-10 批准）：xin 的 `data_provider` 里，公司发现源只有 `public_web` 是 ENABLED，`ted`、`openstreetmap`、`wikidata`、`directory`、`trade_fair`、`openfda` 都是 DISABLED（意图源 `samgov` 同样停用）。规划器的任务描述却写死了 TED、Wikidata、OSM 等子源，模型照样为它们出查询（只读核对 xin 的计划）：两份 14 条的计划各有 10 条落在停用的源上；21 条的那份有 7 条落在停用的源上，另有 3 条用的是 `trade_data`、`b2b_company_person` 这类根本没有 provider 的 source_class；计划里还有确定性注入的 TED/CPV 查询，而 TED 是停用的。执行时这些查询路由不到任何适配器，却先照常做词表归一（`taxonomy.normalize` 模型调用），再写一条 providers 为空的零回执：跑空，还花钱。
- 路由规则（规划与执行共用新模块 `discovery/plan-query-sources.ts`）：查询按 `source_class` 加 `filters.source_hint` 路由到该类下 ENABLED 的公司发现 provider；hint 是源键本身，或旧计划里的部分写法（`wiki` → wikidata），仍按包含匹配，单测保证没有一个源键包含另一个，精确的源键只指向一个源。hint 现在去首尾空白、不分大小写，也可以是字符串列表；数字、对象这类没法用的 hint 不再让活动抛 TypeError（此前会算作查询失败，受治理物化随后因缺回执中止 run），而是路由不到任何源。
- 规划（`POST /icps/:icpId/query-plans`）：
  - 读 ICP 的同一事务里读一次 `data_provider` 开关快照（新增 `DiscoveryProviderRegistry.companyDiscoverySources` / `enabledCompanyDiscoverySources`），提示、过滤和冷路径注入都按这份快照。`IcpModule` 为此引入 `DiscoveryModule` 导出的 registry。
  - 没有可规划的已启用数据源时，调用模型之前返回 409 `NO_ENABLED_DISCOVERY_SOURCE`：授权已消费但不花钱，与 `INVALID_STATE` 同一时机、同一状态码。`ted`、`openfda` 只承载冷路径确定性生成的查询，只启用它们不算。
  - 提示新增「可用数据源」清单，只列已启用、模型可以写的源：源键、可用的 source_class、一句用法；`ted`/`openfda` 启用时只说明它们的查询由系统生成。任务描述和输出 schema 里的说明文字去掉了写死的子源名单，要求每条查询都写 `filters.source_hint`；schema 结构（字段、类型、枚举、必填项）与 `icp-query-plan/v1` 都不变。
  - 模型返回后，路由不到已启用源的查询移出计划，按原因计数：`SOURCE_DISABLED`（源已登记但停用）、`SOURCE_UNKNOWN`（没有 provider，如 `trade_data`）、`SOURCE_SYSTEM_PLANNED`（模型自己写的 TED/openFDA 查询，它们的码只能由冷路径给）、`PLAN_QUERY_CAP`。留下的每条查询，`filters.source_hint` 都改写成它执行的那个源键。没写 hint、而该类有多个已启用源的查询，拆成每个源一条，保持原来的 fan-out；拆出的条数超过规划上限 64 条时按优先级保留，计划仍在运行报价覆盖的 66 条以内。移出的条数与原因记在首条规划查询的 rationale 里（`[source_filter] …`，与冷路径 warning 同处），人工确认时可见；规划查询一条不剩、只剩冷路径查询时记在计划首条。
  - TED/CPV、openFDA 的冷路径解析与注入只在对应源已启用时进行，停用时不再为它们花词表归一的模型调用；贸易角色只写进留下的查询。冷路径解析的行业词仍从模型给出的全部查询采集，与此前一致。
  - 计划里一条可执行的查询都没有（模型给出的全落在不可用的源上，冷路径也没注入）时返回 409 `NO_RUNNABLE_QUERIES`，不保存计划；此前会保存一份空计划。
  - `estimatedVolume` 只计会执行的查询：模型的估算覆盖它写的全部查询，按留下的模型查询占比折算；一条都没留下、只剩冷路径查询时为 null。
- 执行（`executeQuery`）：
  - 改为先路由、再做词表归一。路由不到 ENABLED 适配器的查询（数据源在规划之后被停用，或旧计划里的未知 source_class）跳过：不调词表归一模型、不调 provider，照常写一条零回执（受治理物化的准入要求每条计划查询都有回执），活动结果带 `skipReason`（`SOURCE_DISABLED` / `SOURCE_UNKNOWN`）。重试时重放出 providers 为空的受治理回执，同样报告跳过：受治理回执列出路由到的全部 provider，列表为空就是跳过；legacy 回执不列失败的 provider，所以 legacy 路径按路由结果判断。
  - 工作流把跳过按原因计入 `stats.skippedQueries`，只有计数、不记查询内容；没有跳过时不出现这个键，原有 stats 形状不变。跳过不算失败：有跳过时 run 至少 PARTIAL（确认过的查询没跑），全部跳过也只是 PARTIAL。BI-25 的 FAILED 收尾同样带上计数。没有新增 Temporal 命令，不需要 patch，重放只比对活动类型与顺序；打包重放测试照常通过。
  - `discovery-governed-lineage.activities.spec.ts` 里锁定的执行顺序相应改为「授权核验 → 路由 → 词表归一」；血缘核验先于预算、路由、词表归一和 provider 的约束不变。
- 报价：确认前展示的计划规模（查询列表与 `estimatedVolume`）只计会执行的查询。发现 run 的技术报价（`POST /query-plans/:planId/execute`）仍是每个 run 的执行上限（66 条查询乘全部适配器），它是不读库的纯投影，不随计划内容变化，本次不改。
- 契约：OpenAPI 只改说明文字（该操作的 description，409 列出 `INVALID_STATE`、`NO_ENABLED_DISCOVERY_SOURCE`、`NO_RUNNABLE_QUERIES`；`ApiExecutionBudgetGrant` 加可选的 `additionalConflictCodes`，其他操作的 409 不变），没有结构变更；`packages/contracts/INTEGRATION.md` 阶段 2 同步。
- 测试：
  - 先红：新增与改写的用例在实现前 25 项失败（另有新模块的用例文件因模块不存在而无法加载），包括：规划器在没有已启用源时仍调用模型、提示里没有可用源清单、停用源的查询留在计划里、TED/openFDA 停用时仍解析注入、空计划照存；执行器对停用源的查询仍调用词表归一、结果不带跳过原因、hint 为数字或列表时抛 TypeError；工作流不计跳过、全部跳过时判 DONE；registry 没有源清单方法；OpenAPI 409 只列授权复用。
  - 新增 `plan-query-sources.spec.ts`（hint 解析、路由、跳过原因、规划过滤与拆分、上限、提示内容、规模折算、移出说明、每个已登记源都有用法说明且源键互不包含）；`icp.service.spec.ts` 加 8 项、`discovery.activities.spec.ts` 加 9 项（含受治理回执重放与运行状态）、工作流加 4 项、registry 加 2 项、OpenAPI 加 1 项；既有用例里依赖空计划或 TED/openFDA 默认启用的，改为写一条可执行的查询或显式启用这些源。
- 未做：
  - 已保存的 READY 计划不回写；执行时其中停用源的查询按跳过计数，run 判 PARTIAL。
  - 发现 run 的技术报价不按计划内容收窄（见上）；要按计划算，报价服务得读库，属另一项设计。
  - 代码阅读发现（未在真库验证）：`wikidata`、`openstreetmap`、`ted`、`openfda` 的 provider 没有受治理血缘（`companyResultLineage`），路由到它们的查询走 legacy 路径，不写受治理回执表；新 run 的物化准入要求每条计划查询都有这张表的回执，所以启用这些源后，含它们查询的 run 会在归一阶段以 `DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD` 停下。重新启用这些源之前，要先给它们补受治理血缘，或另定处理。

## 2026-10-10 · Store links to each company's own contact paths (BI-14 PR-1, switch off by default)

- 起因：BI-14 设计（产品负责人批准，2026-10-10 修订）改为只存公司自己的联系路径链接，不抽邮箱和电话。当天又批准两项范围补充：供应商页（`supplier_page`），以及首页链接里的公司 LinkedIn 页与 X 账号（决定 E9）。本 PR 只做数据通路，不改评分、原因码、运营端点与 OpenAPI（PR-2）。
- 新表 `company_contact_point`（迁移 `20261011090000_company_contact_point`，单事务、只新增、零回填）：
  - kind 只有六种：`contact_page`、`impressum_page`、`contact_form`、`supplier_page`、`linkedin_company_page`、`x_company_account`；value 是不带 query、fragment、`@`、`%40` 与空白的 https 链接；LinkedIn 只收 `https://www.linkedin.com/company|showcase/<slug>`，X 只收 `https://x.com/<handle>`；四种站内 kind 不能指向 LinkedIn、X 或 Twitter；`data_class` 只能是 green。表里没有邮箱、电话、人名字段，以上全部由 CHECK 约束。
  - 自动来源（`company_contact`）只写 UNVERIFIED；VALID 与 OPERATOR_REJECTED 必须有 `updated_by`（人）。状态 CHECK 每个分支先判 `status_reason IS NOT NULL`：一次性库实测，没有这一判断时 INVALID 且无原因的行会因 CHECK 结果为 NULL 而写进去。
  - 复合外键到 `canonical_company(workspace_id, id)`，随公司级联删除；唯一键 (workspace, company, kind, value)；ENABLE + FORCE RLS，租户策略同发现表；`app_user` 显式授予 SELECT、INSERT、UPDATE、DELETE，`app-user-table-privileges.json` 同步。`schema.prisma` 加模型，Copy 已重签（只变指纹）。
- 找链接（`discovery/website-profile/contact-paths.ts`，纯函数）：只读官网画像已经抓到的首页里的链接。
  - 站内链接只收公司域名本身或 `www.` 主机（其他子域名标签是站方写的任意文字，不收），且路径每一段都是已知词或短数字、整条路径最多 6 个数字，所以存下的链接带不出页面上的任意文字（比如人名或拆开的电话号码）。
  - 按路径或链接文字判定联系页、Impressum、供应商页（德英文：Lieferant werden、Lieferantenportal、Partner werden、Händler werden、Hersteller werden、Become a supplier、Supplier portal、Partner program 等），每种至多 1 个，规范成 https、去掉 query 与 fragment；只靠链接文字命中且带 query 的链接不收。
  - LinkedIn 只收 company / showcase 页：优先 slug 含公司域名名称的那个，否则只有在首页只链了一个公司页时才收（避免把合作方、客户的页面当成本公司）；数字 ID 最多 6 位，7 位以上按疑似电话号码丢弃。X 只收账号页，且账号名里必须含公司域名名称（无法确认账号属于公司时不存，避免把个人账号当成公司数据）。
  - 首页文本达到抓取上限（40,000 字符）时，链接类种类不算「看过」，不会因页面被截断而把点标成已移除。
- 联系表单：开关打开且首页链到联系页时，经 ToolBroker 以同一公司主体对联系页做 1 次 `crawl4ai.render`（robots 与 source_policy 在工具内照常执行），看是否有表单：提交控件、同意文本、必填标记三类至少两类，排除搜索、登录、购物车和不带留言框的订阅表单。只读 HTML，不填写、不提交。渲染失败或被 robots 拦时，表单记为「未知」，不当作「没有」。渲染工具的持久结果把联系页 HTML 作为 PERSONAL_DATA 产物保留 24 小时（与 Impressum 抓取同一模式，DSR 擦除覆盖）；表里只存链接。
- 写入：在官网画像的同一事务里，先拿工作区禁联锁，再 FOR SHARE 复读公司状态，再读禁联事实；公司缺失、已 SUPPRESSED、命中域名或公司名禁联时一条不写，链接主机命中域名禁联时丢掉该点。
  - 重画像时，本次看过的种类里不再出现的自动来源点改为 INVALID / `REMOVED_FROM_SITE`，再次出现时恢复为 UNVERIFIED；运营来源或被人改过的点从不自动修改。
  - `last_seen_at` 只前进不后退：观测时间取这家页面读完的时刻；刷新只在 `last_seen_at <= 观测时间` 时生效，标记移除只作用于观测时间之前见过的点。两个 run 共享同一家公司、旧观测后提交时不改任何东西（复审发现，一次性库复现了旧版本的 `company_contact_point_seen_check` 违约）。
  - 联系页渲染的回执单独成一批 ACK，避免重放与新回执混在同一批。
- 开关 `data_provider.company_contact` 以 DISABLED 种入（`update: {}` 不覆盖运维改动）。关闭时不渲染、不写点，画像照常只抓首页和 Impressum；但每次画像会多存 `website_profile.source_url` 和对应的一条 field_evidence（见下）。打开后，30 天内画像过、但还没用当前规则读过联系路径的公司会重画像一次（`website_profile._contact_parser` 标记，不写 field_evidence）。
- 其他：
  - `website_profile.source_url` 记录画像事实所在的页（Impressum，否则首页），经现有安全 https 校验；贸易角色、登记号、税号因此有来源 URL（A4）。
  - `discovery.classify_trade_role` 的 allowedTools 加 `crawl4ai.render`；发现 run 预算包络按每家画像公司至多 1 次 render 加上限（`crawl4ai.render` 24 → 74 次，技术报价上限多 0.50 美元，5,597.48 → 5,597.98 美元）。新调用点登记进执行授权清单（37 个）。
  - 公司主体 DSR 擦除时删掉该公司的点，计数并入 `contact_points_erased`，DeletionCompleted 契约不加字段。
- 测试：找链接 20 项（含运行时拼出的负向输入：mailto、tel、编码或拼写的 at 符号、拆开的数字、自由子域名、数字 LinkedIn slug）、画像提供方 7 项（含开关关闭时恰好 2 次抓取、首页被截断）、经真实 ToolBroker 验证渲染以公司 subjectRef 准入 2 项、写入 8 项、活动 4 项、命名空间标记 2 项、擦除 2 项、迁移静态合同 6 项、属性清洗 1 项、种子 1 项；真库用例 `company-contact-point.postgres.spec.ts` 6 项以 app_user 运行（带 superuser 与 BYPASSRLS 守卫，含旧观测后提交的用例），接入 CI「Raw SQL parameter types on PostgreSQL」步骤，`app-user-table-privileges.postgres.spec.ts` 新增一项正向用例。一次性库：只部署 main 的迁移时新用例与权限清单用例失败（表不存在），部署新迁移后全部通过。
- 未做（PR-2）：可达性公式与评分、原因码、运营端点、读模型与 OpenAPI。真栈有界样本要等 D9 开关与预算拍板。

## 2026-10-09 · Give discovery runs a 3-hour admission lease

- 起因（2026-10-09 xin 实测，run `733fbf03`）：发现 run 的授权（Grant）最长 5 分钟。准入后每个活动开头、每次模型或工具预留都要再核验授权是否过期，所以 run 开始约 6 分钟（5 分钟加 60 秒容差）后的第一次核验就报 `EXECUTION_BUDGET_GRANT_EXPIRED`。733fbf03 在准入后 6 分钟因此失败，而一个发现 run 预计要跑 1–1.5 小时。产品负责人 2026-10-09 选定「准入后给 run 一段租约」，并确认 3 小时、只给发现 run。设计见 `docs/superpowers/plans/2026-10-09-discovery-run-admission-lease.md`（已改为 APPROVED）。
- 改动：
  - 新迁移 `20261009170000_discovery_run_admission_lease`：
    - `execution_budget_authority` 加可空列 `admission_lease_expires_at`。准入发现 run（`WORKSPACE_GRANT` + `discovery.run` + `discovery_run`）时写入准入时刻加 3 小时，其余准入写 NULL。准入时刻只取一次，`consumed_at` 和租约用同一个值，租约恰好等于 `consumed_at` 加 3 小时。
    - 新 CHECK：租约只能出现在发现 run 行上，必须晚于 `expires_at`，且不超过 `consumed_at` 加 3 小时。app_user 对该表只有 SELECT，不能设置或延长租约。
    - `consume_workspace_execution_authority` 和 `attest_authorized_tool_budget_v1` 用 CREATE OR REPLACE 重定义，函数体逐字复制，只改租约相关的几行。attest 判断过期改用 `COALESCE(admission_lease_expires_at, expires_at)`，60 秒容差和错误码都不变。两个函数仍是 SECURITY DEFINER，attest 仍是 STABLE，属主和 EXECUTE 授权不变。search_path 写成 `pg_catalog, public, pg_temp`，与 #616 对所有 SECURITY DEFINER 函数的要求一致；迁移名排在 #616 的 `20261009160000` 之后。
    - Grant 本身不变：验签、`consume`、`open` 仍按 5 分钟窗口判断，撤销、范围、cap、耗尽和单持有者检查一字不动。迁移不回填：迁移前准入的行租约为 NULL，照旧按 5 分钟判断，xin 上卡住的 run 不会复活。
  - Prisma 模型加 `admissionLeaseExpiresAt`。schema.prisma 是 Copy 绑定文件，已重签（只变指纹）。
  - relay 启动发现工作流时加 `workflowIdReusePolicy: REJECT_DUPLICATE`。租约内 binding 一直能花钱，而默认策略允许同 ID 的上一次执行结束后再启动，同一条 `DiscoveryRunRequested` 被再次投递时会用同一个 binding 重跑。现在 Temporal 对已结束的同 ID 报 `WorkflowExecutionAlreadyStartedError`，relay 照旧记为合并、标为已投递。qualify、understanding、删除等其他启动不变。
  - 文档：架构设计写明 300 秒只约束出示与准入、reserve 的有效期取租约或 Grant 窗口；ADR-024 加 2026-10-09 补充；落地设计记下产品负责人的答复；更正 #614 条目里「授权只有 5 分钟」的说法。
- 测试：
  - 静态迁移合同 8 项（零容器）：单事务、带锁超时、不回填；新列可空、无默认值；CHECK 原文；两个函数与原定义逐字比对，只差预期的几行；只重定义这两个函数，原定义与本迁移之间没有别的重定义；Prisma 模型有该列；本迁移排在 #616 的 `20261009160000` 之后，且分支里必须已有它。最后一项挡住「先合本 PR、后合 #616」：那样 #616 的迁移会更晚部署，库里最后完成的迁移与镜像的 `migration_revision` 对不上，运行时拒绝启动；#616 合入并合进本分支之前，这一项按设计失败。`workspace-authority-lifecycle.spec.ts` 改为读取 attest 的最新定义，并检查租约口径。加迁移前，其余 7 项与 lifecycle 这一项都失败，加迁移后通过。
  - relay 2 项：只有发现工作流带 `REJECT_DUPLICATE`；用真实 SDK 客户端接一个桩 gRPC 服务，服务对已结束的同 ID 回 `ALREADY_EXISTS`，SDK 报 `WorkflowExecutionAlreadyStartedError`，relay 记为合并、事件标为已投递。改动前 2 项都失败。另在一次性 Temporal 开发服务器上实测（CLI 1.8.0 / Server 1.31.2，与 xin 相同）：同 ID 终止后，`REJECT_DUPLICATE` 报 `WorkflowExecutionAlreadyStartedError`，默认策略则另起一次执行。
  - 真库合同 `discovery-run-admission-lease.postgres.spec.ts` 10 项，接进 CI 里 `migrate deploy` 之后跑真库用例的那一步（需 `EXECUTION_BUDGET_ADMISSION_LEASE_DATABASE_TEST=1`，两个库名都必须以 `_test` 结尾）。走真实的准入服务和 `PostgresBudgetStore`，业务连接是受 RLS 约束的 app_user；用 owner 把 authority 的全部时间列整体前移来模拟时间流逝：
    - 发现 run 的租约恰为准入加 3 小时，重放同一 Grant 不改租约；其余 6 种准入为 NULL；
    - 准入 10 分钟后，发现 run 仍能核验、预留（0 微美元）和释放；其余 6 种照旧报 `GRANT_EXPIRED`；
    - 租约到期也有 60 秒容差，过后核验报 `GRANT_EXPIRED`，TS 映射为同名错误；
    - 租约内撤销、额度耗尽、换工作区、账户关闭照旧拦住；
    - 准入仍受 Grant 窗口约束：过期 Grant 不能准入，过窗后不能再 open；
    - CHECK 拒绝其他 authority 上的租约、超过 3 小时的租约、不晚于 `expires_at` 的租约，允许置 NULL；
    - 租约为 NULL 的发现 run 按旧口径判断；
    - 两个函数的 SECURITY DEFINER、易变性、属主、EXECUTE 授权（app_user、平台 writer、PUBLIC）和 search_path；
    - app_user 用同名临时表伪造 authority 行时，attest 仍读 public 的真表。
  - 一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据放 tmpfs，用完即删）：只部署 main 的迁移时，真库合同 9 项失败，核心是准入 10 分钟后报 `GRANT_EXPIRED`，临时表一项在 main 上读到了伪造行；其余准入保持 5 分钟那 1 项本来就成立。部署新迁移后 10 项全过。main 的迁移、#616 的迁移（`1a1c0112`）与本迁移一起部署时，本合同 10 项和 #616 的真库护栏都通过，#616 的静态护栏对本迁移也通过。手动测试 `packages/db/test/execution-budget-authority.rls.spec.mjs` 用 #616 的版本（9 个授权函数的 search_path 都期望带 pg_temp，本 PR 不改该文件）在这样部署的新库上 29 项全过，含 20 个客户端同一 jti 并发准入。
- 未做：
  - RUNBOOK（工作区文件，不在本仓）还没补「租约内停止发现 run」：等 cap 耗尽；`temporal workflow terminate --workflow-id discovery-<runId>`；或以 app_user 设置 `app.current_workspace_id` 后向 `execution_budget_authority_revocation` 插一行，下一次核验即报 `REVOKED`，#614 之后 run 记为 FAILED。GrowthOS 仍不能撤销 workspace grant。
  - 工作流被 terminate 或 cancel 后，正在执行的活动尝试要到 startToClose 超时（15 或 30 分钟）才停，这期间它的预留仍会通过；运维 reset 工作流也会复用同一个 binding。
  - run 收尾时关闭账户、让租约提前失效，留待与 #614 的重试语义一起设计。平台 Schedule 恢复后会遇到同样的约 6 分钟失败，另行决定。understanding.run 和联系人端点仍是 5 分钟。
  - 同一计划的 run 失败后不能用新 Grant 重跑（账户键由计划决定，仍绑定旧 authority），另行跟踪。
  - 部署：#616 须先于本 PR 合入。迁移和带它的新镜像必须在同一个维护窗口上线，`migrate deploy` 会依次应用 #616 的 `20261009160000` 和本迁移。运行时要求库里最新迁移名与镜像的 `migration_revision` 完全一致，两步之间 API 与 Worker 不就绪；切换时不能有发现 run 在跑。

## 2026-10-09 · Shape public-web company records to the Raw source governance

- 起因（2026-10-09 xin 实测）：卖方 #16 的发现 run `733fbf03` 是 #611 之后第一次真正跑通公开网页搜索的 run。模型判出 21 家公司官网，21 条 raw 记录却全部 `REJECTED`（`PROVIDER_PAYLOAD_SCHEMA_INVALID`），各查询回执是接受 0、拒绝 9 / 8 / 4，所以 run 即使不提前停也建不出公司。`mapPublicWebCompanyToRecord` 交出的记录有三处不合 Raw 治理，任何一处都会拒掉整条：
  - `country` 是模型原文（`Germany`），Raw 只收两位大写字母的国家代码；
  - `products` / `keywords` 里只要有一个词不在受控业务词表（36 个英文词，属数据最小化控制）里，整条拒绝；德国官网的产品词（`Kreiselpumpen`、`submersible`……）几乎都不在；
  - Raw 要求来源页的主机名与 `domain` 完全相同，`domain` 却去掉了开头的 `www.`；G3 搜索优先以后，来源页是第一条搜索命中，通常是 `https://www.<domain>/...`。
- 改动（只改公开网页 provider；Raw 治理、词表、数据库都不动）：
  - 国家用现有词表 `lookupCountryIso` 映射（德国 / Germany / Deutschland → DE）；模型直接答了词表里的代码（`DE`、`de`）也保留；`DACH`、`Österreich`、未知的不填，不猜。
  - 产品词、关键词只留受控词表里的词，其余丢掉，不扩词表；词之间统一成一个空格（`centrifugal-pumps` → `centrifugal pumps`），大小写不同的重复只留第一个，最多 20 个（Raw 与数据库的上限，模型契约允许 32 个）。
  - 来源页取第一条主机名恰好等于 `domain` 的搜索命中，没有就用首页 `https://<domain>/`；`www.` 命中、其他子域、http 命中都退回首页。没有改成「验证器比较前去掉 `www.`」：数据库写入函数 `write_raw_source_record_v2` 对 ACCEPTED 的 public_web 行同样要求主机名等于 `domain`，只放宽 TS 验证器会让写入抛错、整条查询的事务回滚，两边一起改就要加 migration。
  - 数据库对来源 URL 的检查比 TS 严，而且对带来源 URL 的 QUARANTINED 行一样检查、一样抛错：除 `%20` 外不收任何百分号转义（`/über-uns` 会编码成 `%C3%BC…`）；联系方式规则把 `_` 当词界，`/Kreiselpumpe_SK-40_160` 里它认出 TS 认不出的 `sk-` 密钥记号。所以含 `%` 或 `_` 的命中也退回首页；没有这两个字符的 URL 是纯 ASCII，两边的规则读法一致。
  - 公司名做确定性的规范化：NFKC；弯撇号、各种破折号和搜索标题里的分隔符（`|`、`·`）换成 ASCII 的撇号或连字符；去掉双引号、包住词的单引号、®、™ 和不可见格式字符；`_` 换成空格（数据库把它当词界，`Pumpen_Secret` 两边都拒，而不是只在写入时抛错）；合并空白。带电话、邮箱或网址的名字不修，照旧由边界拒绝（回执不含原值）。规范化后只剩空串的名字按「没有名字」跳过，模型回执照常记为尝试。
  - `domain` 用联系人禁联的同一套规范化（小写、去 `www.`、国际化域名转 ASCII）；员工数只收非负整数。
  - `wikidata.org` 加进噪声域名：Raw 会把它匹配到种子里的 `www.wikidata.org` policy，数据库却不认这条 policy 覆盖裸域名，写入会抛错。
- 测试：
  - 新增 `public-web-raw-governance.spec.ts` 34 项。用例是按真实形状手写的模型输出，没有回放 run 733fbf03 的 21 条原始回答：德语产品词与受控词混杂；国家 `Germany`、`Deutschland`、`德国`、`DACH`、`Österreich`、未知、`de`；置信度缺省、null、0.9；命中 `https://www.<domain>/x`、`https://<domain>/`、`http://www.<domain>/`、子域、变音路径、带查询串、`_SK-`、`forgot_password`、非默认端口；13 种要规范化的名字；国际化域名。逐条断言丢掉的词、国家代码和实际选用的来源页。测试里另有一份数据库来源 URL 检查的 ASCII 移植（`raw_source_safe_https_url_v2` 及其联系方式规则），每个选中的来源页都要过它；12 个刁钻的同主机路径选出的 URL 两边都收。另测 20 个上限、员工数，以及带电话或 `_Secret` 的名字仍被拒（附干净名字的对照）。
  - `provider-raw-boundary.integration.spec.ts` 加 run 733fbf03 形状的记录：有覆盖公司域名的 source policy 时 ACCEPTED，没有时 QUARANTINED 且来源 URL 是数据库能存的首页。`public-web-search-first.spec.ts` 加两项（从 `www.` 命中和德语回答走完 `discoverCompanies`；Wikidata 页面不送判站），`company-lineage.provider.spec.ts` 加一项（只剩引号与商标符号的名字）。
  - 先红：换回 main 的 provider，并按 main 的 `mineDomain` 把首条命中当来源页传入，映射表 34 项中 30 项失败；没失败的 4 项是不变的行为（员工数 120、0、null，带电话的名字被拒）。走真实 `mineDomain` 的 3 项也都失败。
  - 变异：逐一撤掉 25 处改动，每次都有用例失败。
  - `src/discovery` 及相关 temporal、durable-results、searxng 用例全部通过，`governance:verify` 通过，`nest build` 与 eslint 通过。独立只读复审提出的 1 项 MEDIUM（`_SK-` 路径）与其余 LOW 已在第二个提交处理或写入下面。
- 未做：
  - Raw 按来源页主机名找 `source_policy`，而代码与种子都没有为公司官网登记 policy（本次未查库核实）。记录不再因这三处被拒，但会以 `SOURCE_POLICY_MISSING` 进 QUARANTINED，建档只读 ACCEPTED，所以公开网页发现多半仍建不出公司。怎样给公司官网放行（逐域登记还是按 provider 统一处理）要 owner 决定。若逐域登记，要登记裸域名：TS 的 `policyFor` 比较前两边都去掉 `www.`，数据库不去，`www.<domain>` 的 policy 会在 TS 匹配上、在写入时抛错。
  - TS 的 `isStableSafeHttpsUrl` 比数据库宽（百分号转义、`_` 词界），其他 provider 的来源 URL 也可能让写入抛错、整条查询回滚；本次只在 public_web 的映射里避开。更稳的做法是让 TS 的检查与数据库一致。
  - 仍会被拒的名字：只有半边引号的、带 `;`、`!`、`[]` 等边界不收的字符的。国家词表只有 8 国，`AT`、`Austria`、`Schweiz`、`United Kingdom`、`U.S.` 都映射不了；`search-localization.ts` 有一张更全的表，两张表可以合并。

## 2026-10-09 · One generic source policy for public-web company sites

- 起因：#615 之后公开网页发现判出的公司记录能过 Raw 的格式检查，但 Raw 入库要按来源页主机找 `source_policy`，公司官网都没有逐域策略，记录全部以 `SOURCE_POLICY_MISSING` 隔离；建档只读 ACCEPTED，所以公开网页发现仍建不出公司。产品负责人 2026-10-09 决定加一条通用的「公司自有官网」策略，设计见 `docs/superpowers/plans/2026-10-09-public-web-company-site-source-policy.md`（`APPROVED`：保留 365 天、`personal_data=true`、用途只在 Raw 入库强制）。
- 改动：
  - `source_policy` 加一行保留键 `public_web:company_site`。它不是主机名，Broker 的按域名查找和各处 SUSPENDED 黑名单都碰不到它。由 `DiscoveryProviderRegistry.seed` 写入，`update: {}`：APPROVED、用途 `discovery` / `enrichment`、保留 365 天、`personal_data=true`，robots 与站点条款无法逐站审，如实写 `UNREVIEWED`。运维改成 SUSPENDED 后，启动 seed 不会改回。
  - Raw 入库按同一规则选策略：先取覆盖来源主机的最具体逐域策略，SUSPENDED、缺用途的也算；没有逐域策略，且 provider 是 `public_web`、来源主机就是记录自己的域名，才用通用行。「最具体」按去掉 `www.` 后的长度算（原来按原始拼写，`www.foo.com` 会压过更具体的 `eu.foo.com`）；同一域名的几种拼写并存时 SUSPENDED 的优先；大小写只折叠 ASCII。SUSPENDED 判定挪到用途判定之前，封禁行的处置码因此是 `SOURCE_POLICY_SUSPENDED`。
  - 迁移 `20261009180000_public_web_company_site_source_policy`：新函数 `raw_source_policy_binding_v3` 在写入时按同一规则复核命令里的策略 id。`write_raw_source_record_v2_legacy` 只把策略块（`20260826130000` L911-947）换成对它的调用，其余逐字不变，`search_path` 末尾是 `pg_temp`（与 #616 一致）。新函数不是 SECURITY DEFINER，对 PUBLIC 和 app_user 收回执行权。同时修了两处 TS 与数据库的不一致，它们会让整条查询回滚：数据库比较前不去 `www.`，SUSPENDED 的 `www.<站点>` 行会让写入抛错；用途与 APPROVED 原来对隔离行也要求，缺用途的 SUSPENDED 行同样会让写入抛错，现在只对 ACCEPTED 要求。另外，通用行只在没有逐域策略覆盖该主机时可用；逐域策略必须是最具体的，ACCEPTED 时同样具体的几行都得是 APPROVED，app_user 拿父域的 APPROVED 行绕不过子域的 SUSPENDED 行。快照形状不变，迁移前写入的行重放得到同样的快照。不改表、不改 `schema.prisma`、不动授权、不碰受保护的 Broker 文件。
  - CI 加一步「Raw source company-site policy on PostgreSQL」，放在 Site Builder 评测边界之后，用前面 Raw SQL 步骤已迁移好的库。
  - provider registry 的 public_web 说明与测试锚点更新，重新生成 `docs/backend/provider-registry.md`。
- 测试：
  - 单测 21 项。`raw-source-ingestion.spec.ts` 18 项：只有通用行时 ACCEPTED；精确域名、父域、`www.` 拼写、大写拼写、缺用途这五种 SUSPENDED 都隔离，不落到通用行；逐域 APPROVED 优先于通用行；通用行 SUSPENDED、缺用途、只有 enrichment、不存在；registry 与 trade_fair 在自己的主机上也不用通用行（附逐域策略的对照）；SUSPENDED 先于用途；`www.` 父域不压过更具体的子域；并列时 SUSPENDED 优先、与读出顺序无关。另有 seed 2 项、`public-web-raw-governance.spec.ts` 1 项。改实现前其中 13 项失败，另 8 项是行为不变的回归护栏。
  - 迁移静态合同 `raw-source-company-site-policy.migration.spec.ts` 5 项：单事务与超时；只建一个函数、替换一个函数，两条 REVOKE，没有表、数据或授权语句；legacy 正文与 `20260826130000` L707-1010 逐字相同，只有 L911-947 换成调用；新函数不是 definer、不是 STABLE、表名全限定、`search_path` 末尾是 `pg_temp`；SQL 里的保留键等于 TS 常量。
  - 真库 `raw-source-company-site-policy.postgres.spec.ts` 22 项：TS 用 app_user 读到的全部策略准备记录，经真实写入器以 app_user 写入（每次都回滚），读回的状态、处置码、保留期、快照与 TS 完全一致（14 项）；数据库独有的拒绝 7 项（通用行配非 public_web、有逐域策略时用通用行、ACCEPTED 配 SUSPENDED 或缺用途、保留期不等、存在更具体的逐域行时用父域行、ACCEPTED 时并列行有 SUSPENDED、逐域行不覆盖该主机）；函数属性 1 项。一次性容器（CI 钉的 pgvector 镜像，tmpfs，用完删除）上先只部署 main 的迁移：9 项失败（6 项一致性用例在写入时抛错；拒绝用例里 1 项没有拒绝，1 项在对照步骤就因旧写入器不认 `www.` 拼写而抛错；1 项函数不存在）；加上新迁移后 22 项全部通过。
  - 变异：把迁移里通用行的 provider 检查、逐域行的覆盖检查各删掉一次，都只有对应的那 1 项失败。
- 部署：迁移与镜像在同一窗口上线，换的时候不能有 run 在跑；迁移按名称顺序部署，#616 的 `20261009160000_…` 与 admission lease 的 `20261009170000_…` 在本迁移之前。新镜像启动、relay 完成 seed 之前，public_web 记录仍按缺策略隔离（fail-closed）。
- 未做：下游抓取（官网画像、信号富集、网站监控）不读通用行，仍按 Broker 的 advisory 规则放行（产品负责人答复：不约束下游）；public_web 写 field_evidence 的许可是 `licensed`、与 registry 的 `SOURCE_SPECIFIC` 不一致，另开小改；`source_policy.domain` 的格式 CHECK 以后再做；app_user 对 `source_policy` 与 `data_provider` 的写权限由另一个 PR 收回。部署后用同一个 ICP 跑有界样本，需要单独授权。

## 2026-10-09 · Leave an in-flight repair wire to its owner

- 起因（#610 第三轮独立复审，改动前就有）：建站付费路径上，结构化输出的修复调用拿到 `ProviderWireInFlightError`（修复用的物理调用已不是 `ALLOCATED`，归别人处理）时，Router 的修复 `catch` 把它包成 `ProviderOutputUnresolvedError`。付费路径专门处理「调用进行中」的分支（不结算、保留预留）因此认不出，Router 转而按两次调用去结算这次支出。
- 改动：修复 `catch` 把 `ProviderWireInFlightError` 与 `ExternalActionDeniedError` 一样原样抛出。付费路径于是记 `MODEL_WIRE_IN_FLIGHT` trace，抛 `PaidOperationUnknownError(MODEL_WIRE_IN_FLIGHT)`，不结算、不停用付费调用，与首次调用遇到「调用进行中」时一致；AiTask 把它当终态，不换模型。
- 首次物理调用的结算不受影响：修复调用能分配之前，首次调用的精确回执已由 provider 写入并终结，数据库的分配函数也要求首次调用已结算。支出保持 `RESERVED`，两次调用的预留原样占着，由终结修复调用的一方（目前是 provider-spend 恢复任务）按持久回执结算，首次调用的费用不会丢。改动前 Router 会以 `FAILED`、`call_count` 2 去结算：真库守卫会拒绝（实际物理调用只有 1 次），随后以 `MODEL_SETTLEMENT_DATABASE_ACK_UNKNOWN` 停用整个 BuildRun 的付费调用，`MODEL_WIRE_IN_FLIGHT` trace 也丢了。
- 可达性：按现有 SQL，只有恢复任务把分配后满 24 小时仍未发出的修复调用收为 `NOT_DISPATCHED`、又还没结算支出时才会出现，属于防御性修复。
- Router 是受保护文件：复核追加到 `docs/evidence/execution-authority-fence-review-20261001.md`，指纹 `c9fc50b3…` → `bf31b8ee…`。独立复审（只读代理）没有 CRITICAL、HIGH 或 MEDIUM。LOW 五项中，复核记录里改动前后果的细节与代码注释的措辞已改正；相邻的修复准备路径、恢复任务少数情况下停在未结算这两项都不比改动前差，记在复核记录里。
- 测试：新增 3 项，改动前都失败（拿到包装后的 `ProviderOutputUnresolvedError`）。settlement-v1 照真实 provider 的 `READBACK_ONLY` 走一遍：首次调用的回执与终结各写一次，修复调用不终结，不结算支出、不停用付费调用；付费门夹具下同样不结算，trace 为 `MODEL_WIRE_IN_FLIGHT`；非付费路径上调用方拿到的就是原来那个实例。模型网关、执行预算、AiTask 与付费门相关测试 767 项通过，执行授权策略检查 16 项通过。

## 2026-10-09 · Public-web search results fit their durable contract

- 起因（2026-10-09 xin 实测）：
  - 卖方 #15 的发现 run 启动 18 秒即失败。第一条公开网页查询的第一次 SearXNG 搜索就报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，重试也一样，预算操作停在 RESERVED。
  - 原因是 ToolBroker 要把搜索结果投影成持久结果 `searxng-search/v1`：每条只允许 `url`、`title`，最多 20 条，而且是封闭记录，多余字段直接拒绝。8 月 21 日的治理加固定下这份契约，并有测试明确拒绝摘要。但 `searxng.search` 工具一直原样返回 SearXNG 的结果：每页 35–45 条，每条带 `content`、`engines`、`score` 等 20 多个字段。投影因此每次都失败，broker 按设计报错，也不允许再发第二次物理请求。
  - 8 月下旬 broker 开始执行这份契约以来，凡是在 run 预算内调用这个工具都会失败：公开网页发现一次都跑不通，名录源（xin 上未启用）也一样。建站品牌调研走付费账本路径，只持久化来源站点、不做投影，不受影响。之前没有发现，是因为 xin 上第一次真实发现 run 在 10-08，那次的两条查询都走公司注册源，不调用搜索。
- 改动：
  - `searxng.search` 的输出直接按持久契约整理：
    - 每条只保留 `url` 与 `title`，最多 20 条。
    - `url` 缺失、超过 2,048 字符，或不是投影接受的文本（非 NFC、含 NUL 或孤立代理项）时，整条丢掉，不改写网址。
    - `title` 转成投影接受的文本：去掉 NUL，孤立代理项换成 U+FFFD，再做 NFC 规范化；超过 2,000 字符时截断，不拆开代理对。以前只要一个标题不合规，整页搜索就会投影失败。
    - 领英个人主页（`linkedin.com/in/`、`/pub/`）和 XING 个人主页（`xing.com/profile/`）整条丢掉：它们的网址和标题写出具体的人。工具声明不含个人数据（`personalData: false`），而这些结果会被持久保存，且不能按数据主体请求删除。公司主页（如 `linkedin.com/company/`）保留。
  - 摘要和引擎元数据不再离开工具。在通用预算路径上，现场结果与重放恢复的结果完全一致。
  - 工具输出类型改为只含 `url` 与可选 `title` 的 `SearxngSearchResult`。公开网页与名录源按这个类型读取结果，名录源对缺失的标题补空串。
  - 公开网页判站的证据从「标题 + 摘要 + URL」变为「标题 + URL」：去掉每条命中里恒为空的「摘要」行，提示词和 `discovery.extract_company` 任务说明同步改为「标题与 URL」。
- 测试：
  - `builtin-tools.searxng.spec.ts` 共 5 项：
    - 43 条真实形状结果只剩 `url`/`title`、共 20 条、不含摘要里的人名与邮箱，且能通过投影；
    - 缺失或超长的 `url` 被丢掉，超长 `title` 被截断；
    - 恰好处在上限的 `url`（2,048）和 `title`（2,000）原样保留；
    - NFD、OHM SIGN、NUL、孤立代理项、跨截断点的表情符号都被整理成可投影的标题，网址不合规的整条丢掉；
    - 个人主页在取前 20 条之前被丢掉，公司主页保留。
  - 公开网页判站的提示断言不再出现「摘要」。上面的 Unicode、个人主页两项和这条提示断言，在改动前都失败。
  - 另用 xin 本机的真实 SearXNG 核对：卖方 #15 计划里的搜索串，改动前 15 次全部投影失败，改动后每次 20 条、全部通过。独立复审经真实 ToolBroker 与重放路径跑了 3 条查询，现场与重放结果一致。
- 未做：要不要把截短、去除人名后的摘要也纳入持久契约，以提高判站质量。这需要改 8 月定下的数据最小化规则，留给 owner 决定。

## 2026-10-09 · Keep source_policy and data_provider read-only for app_user

- 起因（2026-10-09 xin 只读核查，owner 当天决定「收回，只留读」）：
  - `global_dev` 上 app_user 对 `source_policy`、`data_provider` 有 SELECT、INSERT、UPDATE、DELETE。两张表的建表迁移本意只给 SELECT（`20260706164026` 第 35 行、`20260706160025` 第 253 行），但更早的 `20260706033625_rls_and_app_role` 设了默认权限：owner 以后建的每张表都自动给 app_user 增删改查。全新库（CI）也是这样。
  - 两张表都没有 RLS。`source_policy` 是 Raw 摄取与 ToolBroker 的逐域放行/封禁名单，`data_provider.status` 是数据源开关（新数据源以 DISABLED 播种，真测后才改 ENABLED）。能以 app_user 执行 SQL 的会话（例如 SQL 注入）可以放行任意域名、打开 DISABLED 的数据源。site-build provider-wire 登录是 app_user 的成员，也继承了这些写权限。
- 改动前先核对写入路径：两张表只经 owner 连接（`DATABASE_URL`）写入。运行时是 outbox relay 与 worker 启动时的播种（`provider.registry.ts` 的 `seed()`、`sanctions-seed.ts` 的 `seedSanctions()`），此外只有 Copy Sonnet 评测种子脚本（专用 owner 连接，拒绝 app_user）和 `apps/api/scripts/verify-*.mts` 运维脚本。应用代码没有以 app_user 写这两张表，也没有对它们加行锁（行锁要 UPDATE 权限）。截至 main，数据库里引用它们的函数只有 `write_raw_source_record_v2_legacy`，它是 owner 为 `global` 的 SECURITY DEFINER。`packages/db/test` 里写这两张表的夹具都以 `global` 执行。四个运行时角色、platform writer 和它们的登录（含 provider-wire 登录）在 `global_dev` 上都没有直接授予的表级或列级权限，也不能 SET ROLE 到 owner 或超级用户。
- 改动：
  - 新迁移 `20261009190000_governance_tables_app_user_read_only`：单事务，`lock_timeout` 5 秒、`statement_timeout` 30 秒。对两张表从 PUBLIC、app_user、四个运行时角色和 `execution_budget_platform_writer` 收回 INSERT、UPDATE、DELETE、TRUNCATE、REFERENCES、TRIGGER（表级收回同时去掉同类的列级权限），app_user 保留 SELECT。最后检查这些角色和它们的全部成员（运行时登录、platform writer 登录、provider-wire 登录）：不论直接授予、经 PUBLIC、经成员继承、只授在某一列上，还是能 SET ROLE（或给自己授予它管理的角色）到有写权限的角色、owner 或超级用户，都算还能写，这时报 `GOVERNANCE_TABLE_WRITE_PRIVILEGE_REMAINS` 并列出角色，整个迁移回滚。不改数据、表结构和默认权限。
  - 新增真库用例 `governance-table-privileges.postgres.spec.ts` 和 CI 步骤「Governance tables read-only for app_user on PostgreSQL」，放在 Site Builder 评测边界之后。用例检查四件事：app_user 只有 SELECT（列级权限也算）；除表 owner、超级用户和 PostgreSQL 内置的 `pg_*` 角色外，没有任何角色能直接或经 SET ROLE 写这两张表；没有视图或规则引用这两张表（默认权限也会给 app_user 新视图的写权限，视图以视图 owner 的身份写底表）；以 app_user 连接真去执行 INSERT、UPDATE（改的就是 `review_status` / `status` 这两个开关列）、DELETE、TRUNCATE 都报 permission denied，读照常。两个连接地址只给一个时用例报错，不会静默跳过。
- 部署：
  - 迁移与镜像在同一窗口上线，迁移按名称顺序执行。运行时拿最后执行完的迁移与镜像里名称最新的迁移比对，所以已有库（xin）上不能先单独执行本迁移、再执行名称更早的 `20261009160000_security_definer_search_path_pg_temp`（#616）、`20261009170000_discovery_run_admission_lease`（分支 `claude/discovery-run-admission-lease`）、`20261009180000_public_web_company_site_source_policy`（分支 `claude/public-web-company-site-policy`）：那样会以 `MIGRATION_REVISION_MISMATCH` 拒绝启动。要么等它们先上线，要么在同一次 `migrate deploy` 里一起执行。这条规则没有门禁强制。
  - 如果本迁移先合并、而且先上线了，那三个迁移就必须改名，排到 `20261009190000` 之后再上线；#616 改名还要同步改它静态检查里的 `HARDENING_MIGRATION` 和 140 的计数。最省事的是让本 PR 最后合并，或者与它们在同一个窗口一起上线。
  - 自检失败时 Prisma 会把本迁移记为失败，之后的部署都会停住（P3009）：先收回报出的权限，再 `prisma migrate resolve --rolled-back 20261009190000_governance_tables_app_user_read_only`，然后重新部署。`global_dev` 按上面的核对不会触发。
- 测试（一次性容器，与 CI 同一 pgvector 镜像，tmpfs，只绑 127.0.0.1）：
  - 只跑 main 的迁移时，新用例的权限检查与写入尝试全部失败。app_user 实际能把 DISABLED 的数据源改成 ENABLED、把全部 policy 改成 APPROVED、登记新域名、删光 `source_policy`。
  - 同一个库加跑新迁移后，4 项全部通过，上面这些写法都报 permission denied。owner 播种（registry 与 sanctions）照常，先删掉一行再播种也能补回；同样的播种改用 app_user 会被拒绝。
  - 从零迁移、按 CI 顺序开通运行时角色后，新 CI 步骤原样通过；runtime lease、provider-wire、platform writer 三个权限验证脚本照常通过；不带环境变量时用例跳过。
  - 迁移自检：预先给运行时登录直接授予 INSERT、只在 `status` 列上授予 UPDATE，让运行时登录能 SET ROLE（不继承）到一个有 INSERT 的角色，或者只持有该角色的 ADMIN 选项（它可以先给自己授权再切换过去），四种情况迁移都报错，权限保持原样。app_user 自己的列级 UPDATE 会被表级收回一并去掉。迁移重复执行没有副作用；另一个会话对两张表持有 ACCESS EXCLUSIVE 锁时，迁移照样在 240 毫秒内完成。
  - 用例自检：迁移之后再给 app_user 列级 UPDATE、建一个 `source_policy` 上的视图、或让运行时登录能 SET ROLE 到写入角色，用例都会失败。
- 未做：
  - `_prisma_migrations` 应优先处理：全新库上 app_user 也能写它，而运行时就绪门与 provider-wire 的就绪检查都信任这张表里的迁移记录。
  - xin 的 `global_dev` 另有 17 张表的 app_user 权限比迁移的结果宽，例如 `jurisdiction_policy`、`policy_decision_log`、`deletion_receipt`、`brand_profile*`、`site_*` 快照表。按各迁移的执行时间推断，7 月 22 日之后、8 月 31 日之前有人对全部表重新授过权。只有 xin 这样，全新库是对的。怎么修复要 owner 决定。
  - 全新库上 app_user 对另外 14 张没有 RLS 的表也有增删改，其中 `sanctions_source`（制裁名单源开关）、`sanctions_entity`（名单本身）、`canonical_taxonomy`、`term_alias` 与这次的问题同类。这次没有动，需要 owner 逐张决定。
  - 默认权限没改：owner 以后新建的表和视图仍默认给 app_user 增删改，只读的平台表要在建表迁移里显式收回；新用例只盯这两张表。

## 2026-10-09 · Record the real source page and drop mangled or off-domain public emails

- 起因（2026-10-08 独立复审，#609 待续里列的三项）：手动联系人发现 `discoverContacts` 抓公司首页和最多两个联系、Impressum、关于、法律页，用 `extractPublicContacts` 抽邮箱，再由 `buildPublicContacts` 建联系人。复审发现三处缺陷：抽邮箱的正则只认 ASCII，又会从词中间开始匹配，`müller@acme.de` 被抽成 `ller@acme.de`，`Jörg.Schmidt@` 被抽成 `rg.schmidt@`，错地址作为个人联系人挂到公司名下；个人邮箱的 `sourcePage` 一律记首页，而抽取结果本来就带着邮箱所在的页（多半是 Impressum），GDPR Art.14 要说明的来源因此不准；页面上其他域名的邮箱（建站公司、外部数据保护官、gmail）也被当成这家公司的联系人。
- 改动：
  - 抽取正则不再从词中间开始：前一个字符是拉丁字母（含变音字母）、组合附加符、数字或本地部分符号时，不从这里开始匹配，中间隔着软连字符、零宽空格这类隐形格式字符也一样；前面是「字母 + 撇号」时也不开始，撇号认 `'`、`’`、`´`、`ʼ` 等常见写法（`o'brien@`、`O´Brien@` 不再变成 `brien@`）。本地部分含拉丁变音字母的地址因此整条丢弃，不保留原样：`cleanEmail`、禁联规范化与邮箱验证都只认 ASCII，原样地址在持久化时会被判无效，也加不进禁联名单。百分号编码的本地部分（`mailto:m%C3%BCller@…`）和以 `.` 开头的本地部分同样丢弃。中文、俄文等非拉丁文字紧贴地址时按文字边界处理，`邮箱sales@…` 照常抽取；代价是非拉丁字母与 ASCII 混在同一个本地部分时（真实地址里极少见）会从边界处切开，切出以 `.` 开头的片段时丢弃。复审建议的 `(?<![\p{L}\p{N}._%+-])` 挡不住分解写法的变音（u + U+0308）和 `o'brien@`，还会漏掉紧贴中文的地址，所以没有照搬。
  - `buildPublicContacts` 只留公司域名或其子域上的邮箱。两边都先用联系人持久化判域名禁联的同一套规范化（小写、去 `www.`、国际化域名转 ASCII）再比较，`notacme.de`、`acme.de.evil.com` 都不算。其他域名的地址直接丢弃、不存；先筛再取前 5 个，丢弃的地址不占名额，电话给第一个真正留下的联系点。
  - 个人邮箱的 `sourcePage` 改为该邮箱实际被抓到的页（同一地址出现在多页时取先抓到的页，首页在前），并按公司来源的同一规则（`provenanceUrl`）去掉账号口令、查询串与片段。这条规则也会把路径里像邮箱或长串数字的片段打码，这样的来源页 URL 打不开。说不出来源页的个人邮箱不存；抓到的页都是 http(s) 地址，实际不会发生。抽取结果本来就带 `sourceUrl`，`PublicContact` 与联系人记录的结构都不变。
- 影响范围：联系人发现只有手动接口 `discoverContacts` 走这里，它要求显式的合法依据；发现 run 不受影响。卖方企业理解（`persistPublicContacts`）用同一个抽取器，只受第一项影响：卖方官网上的 `müller@` 不再被存成 `ller@`。已核对 xin 的 `global_dev`：`canonical_contact` 为 0 行，卖方公司档案里存的公开联系方式也为空，不需要处理存量。
- 测试：新增 12 项。抽取器 5 项：`müller@`、`Jörg.Schmidt@` 整条不抽，ASCII 地址不变；分解写法的变音、`o'brien@`、百分号编码都不截成半个地址；紧贴中文、俄文的地址照常抽取，混写切出的 `.petrov@` 丢弃；软连字符、零宽空格与各种撇号写法不让匹配从词中间开始；同一地址取先抓到的页。联系人构造 6 项：来源页是邮箱实际所在的页；来源页不带账号口令、查询串与片段；其他域名的地址被丢弃且不占名额；国际化域名规范化后再比较；说不出来源页的个人邮箱不存且不占名额；公司域名无法规范化时一个都不留。另有 1 项接线测试：模拟抓首页和 Impressum，个人邮箱记 Impressum 为来源，变音地址和其他域名的地址都不出现。把两个源文件换回 main 的实现跑这 12 项，11 项失败；「同一地址取先抓到的页」记录的是原有行为，前后都通过。
- 未做：
  - 官网域名和邮件域名不同的公司（官网 `acme-pumpen.com`、邮箱 `@acme.de`，或集团统一域名），邮箱现在不再收录，这多半是最常见的损失。丢弃是静默的，目前不记数量。
  - 小公司用 gmail、t-online 这类免费邮箱作对外联系方式的，这类地址现在不再收录。
  - 公司档案的域名本身是子域（如 `de.acme.com`）时，上级域名 `acme.com` 的邮箱也会被丢弃。
  - 卖方企业理解没有加域名过滤，卖方官网上建站公司的邮箱仍会进公司档案的公开联系方式。
  - 电话没有域名可比，仍把抓到的第一个电话（首页优先）给首个联系点。

## 2026-10-09 · Record a discovery run as FAILED when a stage stops it

- 起因（BI-25；2026-10-09 xin 核查）：发现工作流只在正常路径调用 `finalizeRun`。某个阶段重试用尽后失败（例如 Fit 阶段遇到被切断的模型流，或 DeepSeek 的 `insufficient_system_resource`），或者查询循环、尽力而为的阶段遇到控制错误时，工作流直接失败，`discovery_run` 停在默认的 RUNNING，也没有统计。xin 上现有 3 个这样的 run，分别在存下 0、2、1 条查询回执后中止。最近一个的 worker 日志显示，原因是查询执行报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`（控制错误）；另外两个的日志已随容器重建丢失。
- 改动：
  - 工作流把从载入计划到专利预热的各阶段放进一个 try。任一阶段抛出没被吸收、由 Temporal 上报的失败（重试用尽的活动失败、控制错误、超时或取消）时，先调用 `finalizeRun` 记 FAILED，再抛出原错误，工作流照旧失败，控制错误照旧可见。stats 带查询阶段的计数（含查询回执，形状与正常收尾一致，`finalizeRun` 的回执核对照常通过）、`queries`、`failures`，以及 `failure: { stage, errorType, control }`。三项分别是：失败的阶段；活动最后一次尝试的失败类型（沿 cause 链取第一个应用类型或代码，没有时取最内层类名，只收标识符形状的值，否则记 `UNCLASSIFIED`）；共享分类器是否判为控制错误（它从严，超时和取消也算）。不记任何错误消息。Fit 阶段丢了一次模型调用时，这里通常记的是 `BudgetOperationReplayError`，因为重试会撞上失败那次已结算的预算操作；原始原因在 worker 日志和 ai_trace 里。
  - 状态一律记 FAILED，不记 PARTIAL。活动失败时工作流拿不到结果，无法证明这一阶段已经存下多少。FAILED 不改计划状态，也不写 QualifyRequested，控制错误不会触发后续工作。计划虽保持 READY，目前却不能用新授权再执行一次：预算账户按计划 ID 生成，仍绑定旧授权，`open_authorized_tool_budget_v1` 会报 `EXECUTION_BUDGET_GRANT_REUSED`，要重跑得新建计划，这一限制另行处理。
  - 补写放在不可取消的作用域里，取消的 run 也能收尾；补写本身失败时，抛出的仍是阶段错误。工作流代码自身的缺陷（例如活动返回了畸形结果）不在这里收尾：Temporal 让工作流任务失败并重试，修好的版本还能接着跑。正常收尾失败时不补写 FAILED，以免覆盖一次可能已经提交的结果。授权之前的旧历史跳过，它们的 `finalizeRun` 反正会被 parked。
  - 以 patch `discovery-failure-finalize-v1` 守卫，只在出错时检查，成功的 run 不多记标记；patch 之前录下的历史重放时命令序列不变。
  - `finalizeRun` 记 FAILED 时只关闭仍是 RUNNING 的 run：已有的结果（包括已记的 FAILED）一律不改，重试也不会再发第二条 `DiscoveryRunCompleted`。锁 run 行的查询为此多取 `status` 一列。
  - `finalizeRun` 记 FAILED 时，核验结果为授权已结束（`EXECUTION_BUDGET_GRANT_EXPIRED`、`EXECUTION_BUDGET_AUTHORITY_REVOKED`、`EXECUTION_BUDGET_AUTHORITY_EXHAUSTED`）也照常写入。FAILED 不花钱，也不启动任何后续工作。发现 run 的授权只有 5 分钟（另有 60 秒时钟容差；准入租约落地后改为准入后 3 小时，见同日「Give discovery runs a 3-hour admission lease」），撤销和额度耗尽也都以控制错误结束 run；不放行的话，这些 run 照样停在 RUNNING。数据库在作用域核对和授权查找之后才会报这三种代码，所以授权仍属于本工作区；撤销和过期时不再核对 run 的预算账户，写入仍按 run 与计划 ID 绑定，受工作区行级安全约束。DONE/PARTIAL、其他核验失败和没有 v2 信封的旧调用照旧拒绝。
- 测试：
  - 工作流（模拟活动）：Fit 重试用尽后记 FAILED，查询计数与正常路径逐项一致，之后的阶段不再执行，原错误照旧抛出。计划载入、归一、Fit、富集的普通失败，查询、归一、官网画像、Fit、富集的控制错误，以及三个尽力而为阶段的控制错误，都记 FAILED 并带对应阶段。第 2 条查询遇到控制错误时保留第 1 条的回执；Raw 治理回执之前的历史不带回执字段；取消时在不可取消的作用域里记 FAILED；补写失败时抛阶段错误；正常收尾失败时不补写；工作流代码缺陷不补写，也不检查新 patch；成功 run 的收尾参数逐项不变，且不检查新 patch；没有 patch 的历史和授权之前的历史都不补写。原有的「控制错误不收尾」用例改为「记 FAILED 后抛出，从不记 DONE/PARTIAL」。
  - 工作流接真实的 `finalizeRun`：工作流建的 FAILED stats 通过回执核对并写入；数据库里有工作流不知道的回执时报漂移，不写入，抛出的仍是阶段错误。
  - 打包重放（真实 Temporal 重放器）：patch 之前「Fit 最后一次尝试失败→工作流失败」的历史照旧重放；patch 之后「Fit 失败→标记→`finalizeRun`→工作流失败」的历史可以重放。去掉 patch 守卫时两项都报不确定性错误；main 上的代码只能重放前一项。
  - 活动：三种授权结束代码下 FAILED 照常写入，计划不改，不写 QualifyRequested；已结束的 run（DONE、授权过期后的 PARTIAL、已记的 FAILED）不被 FAILED 覆盖；DONE/PARTIAL 照旧拒绝；作用域不符、授权无效、核验不可用照旧拒绝；没有 v2 信封照旧 parked。
  - 失败描述（纯函数）8 项：不复制消息和细节；取活动自身的失败类型，而不是它包着的泛化 cause；控制标记与共享分类器一致；只读数据属性；有环或过深的 cause 链有界。
- 未做：
  - Fit 活动的重试退避不改。现在两次重试之间只等约 1 秒、2 秒，但加长没用：重试时同一家公司的模型调用用的是同一个预算操作键，失败那次已经结算、没有可重放的结果，后两次尝试都会立刻报 `BUDGET_OPERATION_REPLAY_UNAVAILABLE`，退避再长也只是推迟失败。要让暂时的上游故障能靠重试恢复，得先让预算账本把「已知失败」存成可重放的结果（见 10-07、10-08 条目）。改活动选项本身不影响重放：重放只比对活动类型和顺序，不比对超时与重试策略（已有的重放测试里，查询活动按 120 秒超时录制，代码里是 15 分钟，照样能重放）。
  - 也没把这类模型失败改成不可重试。那样 stats 能直接记 `ProviderTransportError`，也省掉两次无用的尝试，但改的是 Fit 活动的重试语义，另行评估。
  - 本条合入时，发现 run 的授权只有 5 分钟。每个活动开头、每次模型或工具预留都会核验授权是否过期，所以 run 开始约 6 分钟后的第一次核验就会以 `EXECUTION_BUDGET_GRANT_EXPIRED` 失败；本次让这样的 run 记为 FAILED。之后的「发现 run 准入租约」（同日「Give discovery runs a 3-hour admission lease」）让发现 run 准入后按 3 小时租约核验；超过租约仍报同一错误码，照样记为 FAILED。
  - 仍会停在 RUNNING 的情况：授权恰好在最后一个阶段和正常收尾之间过期（正常收尾被拒）；数据库里有工作流不知道的查询回执，例如某次尝试已经提交、之后的重试又失败（回执漂移，正常收尾也一样）；工作流输入的授权本身不合法；工作流代码自身的缺陷。
  - xin 上现有的 3 个 RUNNING run 不处理。它们的工作流已经结束，不会再收尾，要清理须单独决定。

## 2026-10-09 · List pg_temp last wherever a routine sets its search_path

- 起因（2026-10-09 设计发现准入租约时核实）：只要 search_path 里没写 pg_temp，PostgreSQL 就会**最先**在当前会话的临时 schema 里找表。xin 的 `global_dev` 上，PUBLIC 有建临时表的权限，`app_user` 和运行时各登录角色都由此获得这项权限。函数里引用的表又多半不带 schema，于是：
  - `public` 下 126 个 SECURITY DEFINER 函数的 search_path 是 `pg_catalog, public`，它们以属主权限运行。能以 `app_user` 执行 SQL 的会话，只要建一张同名临时表，就能让这些函数去读伪造的行。一次性库上实测：`tool_budget_status` 读到了会话伪造的预算账户，在下游报 `TOOL_BUDGET_HISTORICAL_TERMINAL`，而正常情况下它查不到这个账户、应该返回空。
  - 另有 83 个 SECURITY INVOKER 函数（其中 21 个是触发器函数）自带同样的设置。函数自带的设置会替换调用方的设置；在 SECURITY DEFINER 函数里被调用或由它触发时，它们以那个函数的属主身份运行，同样会先找临时表。独立复审发现了这一类。
  - 利用的前提是已能以 `app_user` 执行任意 SQL（例如 SQL 注入或应用被攻破），属于纵深防御缺口。另有 42 个函数本来就把 pg_temp 放在最后；22 个没有自带 search_path 的函数沿用调用方的设置，在加固后的 SECURITY DEFINER 函数里会继承以 pg_temp 结尾的路径。
- 改动：
  - 新迁移 `20261009160000_security_definer_search_path_pg_temp`：
    - 对每个 search_path 恰为 `pg_catalog, public` 的函数或过程（不论 DEFINER 还是 INVOKER）执行 `ALTER … SET search_path = pg_catalog, public, pg_temp`，按 PostgreSQL 手册的做法把 pg_temp 放在最后。
    - 只改这一项设置，函数体、属主、易变性、安全属性和授权都不变；扩展自带的函数跳过；不动数据。
    - 迁移结束前做两项核对：所有带 search_path 设置的函数都以 pg_temp 结尾；每个 SECURITY DEFINER 函数都设了 search_path。任何一项不满足，整个迁移回滚。
  - 静态护栏 `apps/api/src/prisma/security-definer-search-path.spec.ts`：零容器，随单测一起跑。
    - 解析迁移的顶层语句，跳过注释和函数体，并处理美元引号、带 `$` 的标识符和 `E''` 字符串。
    - 此后的迁移里，凡是设置 search_path 的 CREATE 或 ALTER，都必须以 pg_temp 结尾；`DEFAULT`、`FROM CURRENT`、`RESET search_path` / `RESET ALL`，以及把整串写进一个引号（会被当成一个 schema 名）都算违规。SECURITY DEFINER 函数必须设 search_path。
    - 冻结「加固迁移及其之前」的迁移个数（140）。名字排在它前面的新迁移会直接失败：这样的迁移在已有的库上会在加固之后执行，可能把加固撤回。
  - 真库护栏 `apps/api/src/prisma/security-definer-search-path.postgres.spec.ts`，接进 CI 已有的「Raw SQL parameter types on PostgreSQL」一步。迁移后的库要满足同样两项要求；并以 `app_user` 建同名临时表复现上面的攻击，`tool_budget_status` 仍只读 `public`。
  - 手动测试 `packages/db/test/execution-budget-authority.rls.spec.mjs` 会迁移到最新状态，再检查 9 个授权函数的 search_path，期望值改为带 pg_temp。其他只验证某个迁移时点的手动测试不改。
- 测试：
  - 静态护栏 6 项：
    - 22 个解析探针，覆盖上面每种写法与 INVOKER、触发器函数；
    - 转义字符串和引号内分号不会拆错语句；
    - 旧迁移里能找到 150 多个待加固的定义，证明护栏不是空跑；
    - 冻结个数；
    - 加固迁移之后没有违规；
    - 加固迁移本身是单事务、只改设置。
  - 一次性库（CI 钉住的同一 pgvector 镜像，只绑 127.0.0.1，数据放 tmpfs，用完即删）：只跑 main 的迁移时，真库护栏报 209 个函数（126 个 DEFINER、83 个 INVOKER），攻击复现成功；加上新迁移后两项都通过。按 CI 那一步的方式再跑原有的 raw SQL 测试，也全过。
  - 与 xin 的 `global_dev` 逐个比对全部 273 个函数（迁移集相同，只少本次迁移）：函数体摘要、属主、易变性、安全属性、strict、leakproof、cost、parallel、ACL 和其他设置完全一致，只有 209 个函数的 search_path 末尾多了 pg_temp。
- 未做：
  - 没有收回 PUBLIC 在库上的建临时表权限。补齐 search_path 已经堵住这条路，两道护栏防止回退；`packages/db/test` 里几个手动安全测试正是以 `app_user` 建临时对象来证明加固有效，收回权限会让它们失去意义。以后要再加一层，可以在库级执行 `REVOKE TEMPORARY … FROM PUBLIC`。
  - 函数体里用动态 SQL 新建的函数，静态护栏看不到，由真库护栏兜底。
  - 部署：迁移要和带它的镜像在同一窗口上线，因为运行时要求库里最新的迁移与镜像的 migration_revision 一致。计划和准入租约（`20261009170000`）、来源策略（`20261009180000`）一起按名称顺序发布。

## 2026-10-09 · Skip watch registration in a worker without the platform writer

- 起因（2026-10-09 审计 app_user 写入平台表时核实）：发现 run 的倒数第二个阶段 `registerWatchesForRun` 为 Fit 判为 match、有域名、未被抑制、允许外部处理的公司注册网站监控。注册前要经 `http.get` 读 sitemap；这些读取在 run 预算下一定建预留（零成本工具也一样），又挂在公司主体上走产物路径，只要有一次读取完成就带回持久回执（404 与被 SSRF 护栏拦下的结果也会落产物）。监控是平台行，带回执的写入只能在平台写入者的事务里确认（`intent-projection.service.ts` 的 DomainAck 分支），可客户 worker 从不持有平台写入者（`worker.ts` 给发现活动的依赖里没有它）。于是注册必报 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE`。这是控制错误，阶段的「尽力而为」兜不住，工作流照样上抛：这样的 run 会在线索已经写入之后失败，带 `discovery-failure-finalize-v1` 补丁的记为 FAILED（阶段 `watches`）。此前没有 run 走到这一步，所以没有暴露。
- 改动：`registerWatchesForRun` 先照常数出候选公司；进程没有平台写入者时，在任何出网之前返回「候选 N、注册 0、跳过 0」，并在 worker 日志里写明原因。有平台写入者的路径不变。不改工作流，不需要 patch：活动结果的形状没变，`finalizeRun` 不校验这一项。
- 测试：新增「没有平台写入者时不注册、不读任何 sitemap」：模拟的 `http.get` 返回真实形状的结果与 http-get 产物回执。去掉守卫时活动以 `DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE` 失败（复现了上面的故障），加上守卫后正常返回、`http.get` 一次也没调。原有的「主体被拒的公司跳过」改为带平台写入者，仍走到出网那一步，且不开平台事务。发现活动、工作流授权、抑制线性化与 intent 相关 10 个文件 259 项通过；独立复审无 CRITICAL / HIGH / MEDIUM。
- 未做：
  - 发现 run 现在不再自动注册网站监控（这条路在客户 worker 里本来就走不通）。要恢复，得把注册交给持有平台写入者的平台 worker，例如由 run 只记下候选、平台侧的 intent sweep 去读 sitemap 并写监控；另行设计。平台的 4 个 schedule 目前都暂停，已注册的监控本来也不会被巡检。
  - `IntentProjectionService.registerWatch` 自身仍会先出网、落产物，最后才因没有平台写入者而失败；唯一的生产调用点已在出网前拦住。在它内部提前检查要连带改动多处依赖「有 broker、无平台写入者」的用例，留给监控注册的重新设计一并处理。

## 2026-10-09 · Give app_user only the table privileges its code uses

- 起因（设计 `docs/superpowers/plans/2026-10-09-app-user-platform-table-privileges.md`，产品负责人 2026-10-09 确认 §5 全部按建议：一次收齐、新表默认只读、要清单与真库测试、平台写入者授权另起 PR、下一个窗口上线）：
  - 基座迁移 `20260706033625_rls_and_app_role` 把当时所有表的增删改查授给 app_user，又把同样的授权设成属主 `global` 以后新建表的默认权限。之后给无 RLS 平台表写「app_user 只读」的迁移多数只 `GRANT SELECT`、没有收回其余权限，所以全新库上 app_user 也能写 15 张没有 RLS 的平台表（#619 已收回 `source_policy`、`data_provider`）：迁移账本 `_prisma_migrations`（运行时就绪门和迁移兼容核对都信它）、制裁名单两张表、词表、专利缓存刷新审计，以及本应只增不改的 Art.17 墓碑等。能以 app_user 执行 SQL 的会话（例如 SQL 注入）可以伪造迁移记录、改写制裁名单、删掉墓碑。属于纵深防御，利用前提与 #616、#619 相同。
  - xin 的 `global_dev` 另有漂移（只读查目录核实）：17 张表上 app_user 比迁移给的多出 UPDATE、DELETE（`jurisdiction_policy` 还多 INSERT），多是证据、审计、删除回执这类加固时收成只追加的表（`evidence`、`policy_decision_log`、`deletion_receipt`、`brand_profile*`、`site_*` 快照等），授权者都是 `global`。其他角色、列级权限、默认权限都与全新库一致。
- 改动前逐张核对 app_user 的写入路径，结论与设计 §2 一致：6 张只由属主或平台写入者写；10 张有生产路径以 app_user 写，各只用到部分操作（Prisma 的 upsert 要 SELECT、INSERT、UPDATE，createMany skipDuplicates 只要 INSERT，带条件的 deleteMany / updateMany 还要 SELECT）。这些表上没有以 app_user 写入的函数或触发器，也没有行锁查询。17 张漂移表的生产写入也都在迁移定义的权限之内（`evidence` 的 upsert 更新部分为空，实测只发 SELECT 和 INSERT）。
- 改动：
  - 新迁移 `20261010090000_app_user_table_privileges`（单事务，lock_timeout 5 秒、statement_timeout 30 秒，不建函数，不改数据和表结构）：
    - 16 张平台表先 `REVOKE ALL … FROM PUBLIC, app_user`，再只授代码用到的操作：`_prisma_migrations`、`canonical_taxonomy`、`jurisdiction_policy`、`sanctions_source`、`sanctions_entity` 只读；`patent_cache_refresh_audit` 无权限；`monitored_source`、`source_fetch`、`source_entity`、`source_signal`、`signal_ingest`、`term_alias`、`patent_lookup_request` 读、增、改；`source_entity_change` 读、增、删（90 天清理）；`patent_inventor_cache` 读、删（Art.17 擦除）；`patent_inventor_tombstone` 读、增（墓碑只增不改）。
    - 另 16 张漂移表（`jurisdiction_policy` 已在上面）同样先全收，再恢复成迁移定义的权限。授权语句从迁移到 #619 的一次性库导出，不手写；全新库上不改变任何东西。
    - 默认权限：属主以后新建的表对 app_user 只给 SELECT，写权限要在建表迁移里显式授予；序列的默认权限（USAGE、SELECT）不变。
    - 结尾自检：public 下每张表上 app_user 的有效权限必须与迁移里的期望表（113 张，与清单一致）完全相同。算进来的有：直接授予、经 PUBLIC、只授在某一列上，以及 app_user 沿成员关系（直接或间接，不论 INHERIT、SET、ADMIN 选项）能到达的每个角色的权限：只持有 ADMIN 选项的角色，也能先授给自己、切换过去，再往下切。这些角色里有超级用户或表属主，就算全部权限。这些角色都不能持有 WITH GRANT OPTION；给它们或 PUBLIC 的默认权限必须恰好是上面两条。表多、表少或权限不符都报 `APP_USER_PRIVILEGE_MISMATCH` 并列出差异，整个迁移回滚。`REVOKE ALL` 以属主身份执行，只能收回属主授出的权限；别的授权者授出的权限会被自检拦下、整体回滚，不会悄悄留下。
  - 权限清单 `docs/governance/app-user-table-privileges.json`：public 下每张表 → app_user 的权限（只授在列上的权限另列在 `columns`，目前没有），加上属主的默认权限；从迁移后的一次性库生成，按字节序排列。
  - 真库用例 `apps/api/src/prisma/app-user-table-privileges.postgres.spec.ts`，CI 新增一步「app_user table privileges on PostgreSQL」，放在 #619 那一步之后。两个连接地址只给一个时报错；只接受回环地址上的 `global_test`，不许带任何连接参数（`?host=` 之类会把连接改指别处），两个地址必须指向同一个库；不给时整组跳过，但清单格式检查（键有序、权限名合法、无重复）随单测一起跑。用例检查：
    - 迁移后实际权限与清单逐表一致（口径同迁移自检，含沿成员关系能到达的角色）；这些角色都不持有 WITH GRANT OPTION；默认权限与清单一致；属主现建一张表和一个序列，app_user 分别只得到 SELECT 和 USAGE、SELECT（事务回滚）。
    - 正向：以 app_user 在必回滚的事务里执行 10 张写表实际用到的写法：网站监控注册与页集合并、采集抓取与快照 diff、90 天清理（直接调 `WebsiteWatchService.purgeStaleEvents`）、信号 upsert 与账本记账（含记错误的分支）、过期翻转（直接调 `SignalIngestService.expireStale`）、别名写回、专利查询入队与读缓存（直接调 `enqueuePatentLookup`、`readPatentCache`）、Art.17 墓碑与缓存擦除。另按 claim 桥的写法，对 `claim`、`evidence` 做空更新的 upsert（新建、重放各一次）：Prisma 现在把它拆成 SELECT 加 INSERT，只追加的 `evidence` 不需要 UPDATE；哪天升级后改成 `INSERT … ON CONFLICT DO UPDATE`，这条会先在 CI 里失败。
    - 负向：清单外的 SELECT、INSERT、UPDATE、DELETE、TRUNCATE 全部报 42501：113 张表共 324 次尝试，每条都要是「permission denied for table <该表>」。语句各自只需要那一项权限、不碰任何行。
  - 运维脚本：`apps/api/scripts/verify-intent-loop.mts` 的清场和「伪造上周基线」改走 owner 连接（app_user 已不能删 `source_entity`），注册、抓取、投影仍走 app_user。其余以 app_user 写这些表的脚本（`intent-watch.mts`、`verify-signal-first.mts`、`verify-patent-cache-codex-p93.mts`、删除编排两份等）用的都是生产同样的写法，不用改；`verify-data-rights.mts` D4、`verify-site-builder-r4-a1.mts` 等「app_user 改不了只追加表」的检查，在 xin 上从此会如期被拒。
- 部署：
  - 下一个维护窗口上线（产品负责人选定），与带本迁移的镜像同一窗口，按名称顺序排在 `20261009160000`（#616）、`20261009170000`（#618）、`20261009180000`（#617）、`20261009190000`（#619）之后。运行时拿最后执行完的迁移与镜像里最新的迁移比对。窗口内不能有在跑的发现 run、删除编排或平台 schedule。
  - 最好等那 4 个迁移先随上一个窗口上线：这样本迁移自检失败时什么也不改，库仍停在 `20261009190000`，旧镜像照常能用。Prisma 会把本迁移记为失败、之后的部署停住（P3009）：按报出的差异修正权限，`prisma migrate resolve --rolled-back 20261010090000_app_user_table_privileges`，再重新部署。若 5 个迁移挤在同一次 `migrate deploy` 里，前 4 个会先提交，自检一失败，新旧镜像都会以 `MIGRATION_REVISION_MISMATCH` 拒绝启动，直到修正后重新部署。
  - 窗口前用同一口径对 `global_dev` 做只读预检（app_user 连接、只读事务、只查目录）。2026-10-10 已做一次：表集合与清单完全相同；只有 #619 和本迁移改写的 34 张表权限不同（都是多出的写权限），其余 79 张一致；没有只授在列上的权限，没有 WITH GRANT OPTION，app_user 没有任何成员关系，默认权限只多了要收回的增删改。窗口前再跑一次，出现别的差异先处理。
  - 平台写入者的表授权（设计 §3.4 G1）不在本 PR，另起一个 PR；恢复平台 schedule 或启用 `google_patents` 之前必须先合。
  - 回退：只改授权，回退是一个把权限授回的新迁移；紧急时可由属主手工 `GRANT`，事后补迁移。数据不受影响。
- 测试（一次性容器，与 CI 同一 pgvector 镜像，tmpfs，只绑 127.0.0.1，用完即删）：
  - 只跑 main 的迁移时新用例 12 项里 4 项失败：清单比对列出上面 15 张表多出的写权限，默认权限仍授增删改，新建表 app_user 能增删改，负向尝试里 22 次本应被拒的 UPDATE、DELETE、SELECT 被允许、6 次 INSERT 被允许（只因非空约束失败）。同一个库加跑本迁移后 12 项全部通过。
  - 迁移自检：分别注入 15 种漂移后重跑迁移，都报 `APP_USER_PRIVILEGE_MISMATCH` 并点名那一项；表权限、默认权限、成员关系和事先多授的一项写权限都保持原样，证明整体回滚。15 种是：未涉及的表上多一项表级权限、只授在某一列、授给 PUBLIC、经继承的成员身份、能 SET ROLE 但不继承、只持有 ADMIN 选项、持有 ADMIN 选项的角色还能再 SET ROLE 到有写权限的角色、能 SET ROLE 过去的角色持有 WITH GRANT OPTION、默认权限授给 app_user 能到达的角色、能 SET ROLE 到属主（超级用户）、不限 schema 的默认权限、给 PUBLIC 的默认权限、少一项应有权限、app_user 自己持有 WITH GRANT OPTION、清单外的新表。清掉注入后迁移可重复执行。独立复审发现初版只看一跳的 SET 与 ADMIN，漏掉「ADMIN 之后再往下切」的链（复现：只持有某角色的 ADMIN 选项、该角色能 SET ROLE 到超级用户时，初版自检放行）；现已改成沿成员关系的全闭包，grant option 与默认权限的检查也扩到这些角色。
  - 用例自检：迁移后分别注入 9 种漂移（多一项表写权限、只授在某列、默认权限给写、经 SET ROLE 获得写、ADMIN 之后再往下切获得写、能 SET ROLE 过去的角色持有 grant option、默认权限给 app_user 能到达的角色、收回一项需要的写、app_user 持有 grant option），用例都会失败，清掉后恢复通过。连接地址带 `?host=` 或两个地址指向不同的库时，用例直接报错。
  - xin 预演：从全新库迁移到 xin 当前的 `20260925090000`，按只读查到的 xin 目录重放 17 张表的漂移授权和运行时登录角色的成员关系，与 xin 比对表权限（全部角色）、默认权限、成员关系都一致；然后一次 `migrate deploy` 跑完 5 个待上线迁移，全部通过；新用例 12 项、#619 的用例 4 项通过；最终权限与全新库逐表一致。
  - 按 CI 顺序在一次性库上重放 build-test 的全部 PostgreSQL 步骤（运行时登录、provider-wire、平台写入者的开通与核验，原有真库用例，#619 与本 PR 的新步骤）：全部通过。
- 未做：
  - 平台写入者的表授权（G1），见上。
  - 序列不在清单里：app_user 对 2 个序列只有基座迁移给的 USAGE、SELECT，代码不用 setval；需要时再纳入。
  - 新表默认只读会把「忘了授写」推到运行时：清单从迁移后的库生成，忘了授写时清单与库一致、CI 照样绿，要到代码运行才报 42501。今后新建 app_user 要写的表，在建表迁移里显式授权、同一 PR 更新清单，并在本用例里补一条以 app_user 执行的正向写入。
  - `term_alias` 由租户触发的模型结果写进跨租户共享的别名表（设计 §8），权限收窄后仍是数据投毒面，另议。
  - 采集与监控四张表在「无回执」分支以 app_user 写平台数据。网站监控注册没有回执时（没有 broker，或 sitemap 请求全部失败、退回只监控首页）以 app_user 建 `monitored_source`；#620 合入后客户 worker 不再注册，到时 app_user 是否还需要 INSERT，与 G1 一起再看。G1 之后是否统一由平台写入者写、app_user 只留 SELECT，另议。
  - 用同一份清单对 xin 做只读漂移比对、接进 `gctl doctor`（工作区工具，不在本仓库）。
  - #619 的迁移自检同样只看一跳的 SET 与 ADMIN，#616、#619 的真库用例同样不拒 `?host=` 连接参数；本 PR 未改。

## 2026-10-08 · Treat single-name mailboxes as personal contacts

- 起因（2026-10-08 BI-14 公司联系点设计调研）：手动联系人发现用的 `buildPublicContacts` 靠 `/^[a-z]+[._-][a-z]+$/i` 判断邮箱是否属于个人，只有 first.last 这种形状才算。`max@`、`mueller@`、`mm@` 这类单名或缩写邮箱因此被存成「公开联系点 (max@)」，不标个人数据，也不写 person.profile 证据。这违背 GDPR Art.4 和「只做公司级数据」的红线。仓库其他地方（采集清洗 `cleanEmail`、联系人持久化、邮箱验证合规门）早已改用白名单：只有职能邮箱算非个人。
- 改动：
  - 改用 `cleanEmail(...).kind` 判断。职能邮箱白名单里的地址算公司联系点，包括 `sales2@`、`info-eu@` 这类带数字或地区后缀的写法；其余一律按个人处理，标 `personalData` 与 `sourcePage`。
  - 只有 first.last 形状继续反推姓名。其他个人邮箱推不出「名 + 姓」，改用占位名「个人邮箱 (max@)」。独立复审发现：如果从 `mueller@` 推出 "Mueller"，邮箱格式学习会把这类单名当成 `first` 命名法的样本；`datenschutz@`、`technik@` 一多，就会压过真实的 `j.schmidt@`。占位名和旧的「公开联系点」一样解析不出姓名，不会进入学习。
  - 输出结构不变，仍然只有首个联系点带电话。
- 影响范围：只有手动联系人发现接口 `discoverContacts` 调用它，该接口要求显式的合法依据；发现 run 不经过这里。xin 的 `global_dev` 里没有已存的联系人，不需要处理存量。
- 测试：新增 5 项，分别覆盖：单名与缩写判为个人并给占位名（改动前失败）；白名单职能邮箱仍是公司联系点；单名个人邮箱不进入格式学习，`j.schmidt@` 仍学成 `first.last`；大小写、加号地址与白名单外的职能词；`max__x@` 给占位名。把实现改回「所有个人邮箱都反推姓名」时，后 4 项中的相关断言失败。
- 已知取舍：白名单外的职能邮箱（如 `datenschutz@`、`technik@`）也按个人处理，宁可多标、不能漏标；补充白名单会同时放宽邮箱验证合规门，留作单独评估。

## 2026-10-08 · Prepare every raw SQL statement against the real schema in CI

- 起因：xin 上第一次发现 run 因 `uuid = text` 失败（#605）。单测里 `$queryRaw` 都是模拟的，参数类型、列名、函数签名从来不在真库上检查，这类错误因此能在 main 上待一个多月。
- 新增真库测试 `apps/api/src/prisma/raw-sql-parameter-types.postgres.spec.ts`。它用 TypeScript 类型检查器收集 `apps/api/src` 里全部原生 SQL：`Prisma.sql`、`$queryRaw`、`$executeRaw`，连同嵌套片段、条件分支、`Prisma.join` 以及 `.map` 生成的片段。每个参数按 Prisma 实际绑定的类型声明（字符串 `text`、整数 `bigint`、日期 `timestamptz`、对象 `jsonb` 等），在已迁移的库上 `PREPARE` 后立即 `DEALLOCATE`，不执行、不写入。172 条语句、193 个变体全部检查，一条都不跳过。另一项测试在真库上实测 Prisma 的绑定类型，防止升级后检查器失准。CI 在「Suppression lock」之后新增一步运行它。
- 它一上线就查出 8 处此前没人发现的缺陷，本次一并修复：
  - 发现 run 建档时计算证据清单摘要的 SQL 少一个右括号。这是 c9723c8d 引入的，08-31 起每次执行都是语法错误，`canonicalizeRun` 必然失败。现在改成与数据库函数相同的表达式。
  - 预算账本「标记结果未知」与两版「带产物清单结算」，把 HTTP 状态当 `bigint` 传给 `smallint` 参数，只要状态不是 null 就找不到函数。加 `::smallint`。
  - 通用产物写入（工作区、平台）同样加 `::smallint`。
  - 个人产物清理的「完成」「重试」把尝试次数当 `bigint` 传给 `integer`，原始数据过期把条数上限也传错了。加 `::integer`。
  - 建站成本对账巡检的翻页条件含聚合 `MAX(...)`，却放在 WHERE 里，带游标翻到第二页必然报错。移到 GROUP BY 之后的 HAVING。
- 验证：撤掉 #605 的 `::uuid` 或撤回括号修复时，新测试分别报 `uuid = text` 和语法错误；相关模块单测 5,707 项通过。

## 2026-10-08 · Room for reasoning tokens in acquisition model tasks

- 起因（2026-10-08 xin 实测）：换到含 #602 的镜像后，卖方 #8、#9 的 ICP 设计连续两次失败，网关记 2,654 输入、4,096 输出，正好卡在任务上限，后端报 `ProviderOutputError`（输出被截断），每次仍按网关口径扣约 0.51 美元。10-07 卖方 #7 那次用了 3,510，已经贴近上限。deepseek-v4-pro 是推理模型，推理 token 与答案共用同一个 `max_tokens`。
- 改动：获客注册表里走 deepseek-v4-pro 的 11 个任务（企业理解 3 个、ICP 设计、查询规划、分类归一、资格判定、公司抽取、名录抽取、贸易角色、决策人抽取）输出上限统一为 8,192，原来 10 个是 4,096、贸易角色是 2,048。上限只约束单次调用，网关按实际生成的 token 计费，没截断的调用花费不变；报价按 `maxCostCents` 计，金额不变，只是策略摘要随之变化。
- 这对发现 run 同样重要：抽取、资格判定一旦截断就是模型失败，按现有规则会让整个 run 中止。
- 测试：注册表新增 1 项（11 个任务都在 deepseek-v4-pro 上且上限为 8,192）；ICP 预算包络与运行时桥接两项改为读到 8,192，越界反例改为 8,193。

## 2026-10-08 · Keep person data out of the trade-role model prompt

- 起因（2026-10-08 设计调研）：官网画像在规则判不出贸易角色时调用 `discovery.classify_trade_role`，提示里直接拼了首页前 12,000 字与 Impressum 前 4,000 字的原文。Impressum 按法律要写代表人、负责人和联系邮箱，所以总经理姓名、个人邮箱与电话会原样发给模型网关；当前模型经 OpenOx 调用 DeepSeek，属于第三国处理。存储侧早已脱敏（证据只留公司级片段），发给模型的这一侧没有。
- 改动：发给模型前先删人员行（沿用 `PERSON_MARKERS`，另加 Vertreten durch / vertretungsberechtigt / Verantwortlich / Prokurist / Datenschutzbeauftragter / Kontaktperson 等标签；标签单独成行时连下一行的值一起删），再用 `scrubPiiKeepingTaxIds` 给邮箱、电话打码，商业登记号与增值税号保留。规则分类与 Impressum 标识符解析仍在本机读原文，不受影响。
- 测试：新增一项（先红后绿）：含代表人、负责人、个人邮箱与电话的首页和 Impressum，发给模型的提示里不出现这些值，HRB 与 USt-IdNr. 仍在。

## 2026-10-08 · Planning tasks get the provider's 16,000-token output ceiling

- 起因（2026-10-08 xin 实测）：#604 把 pro 任务的输出上限放到 8,192 后，卖方 #10 的查询规划输出了 10,568 个 token 仍然成功，卖方 #11 的规划却在 8,192 处被截断（134 秒，`ProviderOutputError`，接口返回 500）。OpenOx 对 `max_tokens` 的执行前后不一致，规划类回答本身也可能超过 8,192。截断的代价不止一次调用：同一个 ICP 的规划请求共用一个预算账户，调用过模型后这个 ICP 就再也生成不了计划；ICP 设计同理，一家卖方只有一次设计机会。
- 改动：`icp.design` 与 `discovery.query_plan` 的输出上限改为 16,000，即网关 provider 允许的最大值；其余 9 个 pro 任务仍是 8,192。网关按实际生成的 token 计费，报价仍按 `maxCostCents` 计，金额不变，只是策略摘要随之变化。
- 运行时：按约每秒 72 个 token 估算，写满 16,000 个 token 约需 225 秒。注册表里这两个任务的 `timeoutMs`（180 秒）没有代码读取，实际生效的是进程级 `MODEL_TIMEOUT_MS`；xin 上是 240 秒，换到本镜像时提到代码允许的最大值 300 秒。
- 测试：注册表测试拆为两项（9 个任务 8,192，两个规划任务 16,000）；ICP 报价包络读到 16,000。

## 2026-10-08 · Pin legacy-javascript against dist-tag drift in the OCI build

- main 自 698b4518 起，CI 的「Build and inspect immutable OCI runtime」报 `runtime SBOM omits installed packages: legacy-javascript@0.0.3`（64614baf 时还是绿的），会构建镜像的 PR（改了代码的 PR）的 `build · typecheck · test` 也随之变红。原因：`@paulirish/trace_engine` 0.0.65（经 lighthouse）把 `legacy-javascript` 声明为 dist-tag `latest`，上游在 10-07 22:13Z 与 10-08 00:08Z 先后发布 0.0.2、0.0.3；镜像构建以全新元数据缓存执行 `pnpm deploy`，装进 0.0.3，而 SBOM 按锁文件记 0.0.1。同样以 `latest` 声明的 `third-party-web` 早已用精确 override 钉住（见 `dependency-security-remediation.spec.mjs` 的 deploy 回归测试）。
- 根 overrides 新增 `legacy-javascript` 0.0.1，即锁文件里已审过的版本，锁文件只改 overrides 段。本机用空缓存执行 `pnpm --filter @global/api deploy --prod --frozen-lockfile`：main 上装进 0.0.3，加 override 后为 0.0.1（`third-party-web` 两次都是 0.29.2）。新增防回归测试：trace_engine 以 dist-tag 声明的依赖必须都有精确 override，且等于锁文件中唯一的解析版本；去掉这条 override 时测试失败。
- 生产审计零 advisory（830 个依赖）；基线按锁文件变动重新绑定到钉版提交，`valid_until` 不变；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261008-legacy-javascript-dist-tag-pin.json)。Copy fixed-source 回执只重签指纹。
- 跟进（独立审查，#603）：锁文件不记录依赖的声明写法，所以防回归测试同时钉住 trace_engine 的已审版本 0.0.65。将来 lighthouse 带进别的 trace_engine 版本时，测试会失败，要求先复核它以 dist-tag 声明的依赖、同步名单与 override，再更新已审版本。这道守卫只覆盖 trace_engine；别的包新增 dist-tag 依赖，仍要等 OCI 构建的 SBOM 检查发现。本条目第一项的受影响范围已就地更正为「会构建镜像的 PR」（纯文档 PR 不跑 OCI 那一步）；同时修正了安全合同页的当前合同段、依赖刷新手册，以及 deploy 回归测试的注释。

## 2026-10-08 · Keep Chinese words out of discovery search strings

- 起因（2026-10-07 xin 实测，卖方 #7 的查询计划）：6 条查询里，公开网页查询的关键词约一半是中文，例如「工业泵 分销商 进口商」。规划器的提示把关键词写成「含本地语言变体」，又要求中文 rationale，ICP 本身也是中文，于是模型中德混写。公开网页源取前 3 个关键词，再拼上过滤条件里的产品与行业词（按设计可以是中文，供规范词表映射），所以德国市场的 3 条搜索里有 1 到 2 条是中文，抽取费基本白花。名录源也会把中文行业词和「德国」这样的地区词拼进检索串。
- 规划提示按 ICP 的目标市场写明关键词语言，例如「必须全部用德语书写……不得出现中文」；涉及多种语言时要求每条查询的关键词用该查询所在国家的语言；认不出市场时要求用当地语言、无法确定时用英语。任务描述同步改为关键词用目标市场语言、不要用中文；过滤条件里的行业、国家词仍可用中文。
- 搜索串构造：支持的 7 种搜索语言都不用中日韩文字，所以公开网页源与名录源都先剔除空词和含汉字、假名、谚文的词，再取前几个。全是中文时不发起检索，名录源也不再退回通用的 manufacturing。名录源的地区依次取可写的地区词、国家词、目标国的当地名称（例如 Deutschland）；给了地理范围却一个都写不出（例如「加拿大」不在国家表里）时不检索，免得搜成全球名录。顺带去掉名录主题词的重复（只有关键词、没有行业词时同一个词会拼两次）。
- 目标市场解析：能拆开用顿号、全角逗号、分号连写的市场（例如「德国、奥地利」）；去掉「（德语区优先）」这类括注的正则写成线性时间，避免超长输入卡住事件循环（独立审查实测旧写法 10 万字符要 10 秒以上）。
- 用 10-07 那份真实计划核对：会执行公开网页检索的 3 条查询，9 条搜索串全部是德语。
- 测试：搜索语言工具 14 项、公开网页源 2 项、名录源 4 项、ICP 服务 3 项，实现前均为红。

## 2026-10-08 · Reclaim superseded image variants before reserving a new set

- 起因是 sharp 修复（#599）独立审查时发现的问题。图片管线版本号是 recipe hash 的一部分，所以每次升级 sharp 或 libvips 都会生成一整套新变体。预留时有两道预算：每个资产最多 120 行、冻结清理计划最多 128 个对象，它们都把该资产所有版本的行算在内；而旧行只有在删除资产时才会清掉。结果是：大图产品图每版 30 个变体，保留 3 套旧版本后再处理，就会报 `asset cleanup object budget exceeded (151>128)`。预算也不能改成只数当前版本，因为它守的是删除合同：删除资产时，全部变体要冻结进一条不超过 128 个对象的清理命令。
- 构建选图（`controlled-build-assets.ts`）改为只从资产 `derivedKeys` 清单发布的变体里选。此前按 role、id 取第一条 ready 变体，新旧版本并存时，选中哪一版是随意的。没有清单或清单无法解析时，不提供 tenant 变体，页面回落到目录图；首次处理定稿失败、只留下部分 ready 行的资产就属于这种情况。
- 新增 `image-variant-reclaim.ts`。`processAsset` 在 reconcile 之后、预留之前回收已被取代的变体，连同它们的对象和 attempt key。被取代的定义是：状态为 ready 或 failed，且同时满足三条——不在清单里；没有未失败的 SiteVersion 的 spec 引用它；不在本次计划里。
  - 为什么要看 spec 引用：页面和区块级的局部构建会把当前版本的 assets 合并进新 spec，并按 variantId 逐条物化；成功的版本回滚后也会重新成为构建基础。失败的版本不会再被构建，不计入。没有可回收的候选时，不扫描 site_version。
  - 整个回收在一个事务里完成，持有资产行锁（与预留、提升、定稿、资产删除是同一把）。存储操作在事务开始后 20 秒截止；删除对象前若剩余时间不足 5 秒（例如等锁或查询太久），就跳过本轮。每批删除要全部落定后才报错，不会在锁释放后还有删除在进行。
  - 先删对象并确认已不存在，再删行，先删子行再删父行。顺序之所以如此，是因为 ready 行在数据库层不可改状态：删不掉的「行在、对象没了」只会在同一 recipe 再次被计划时按完整性错误失败关闭；反过来留下孤儿对象，资产删除时就无从清理。
  - 以下情况跳过回收，并记 warn 日志：站点有 `building` 的 SiteVersion、清单无法解析、剩余时间不足。之后的预留若失败，报错会附上跳过原因。回收成功时记一条 info 日志。
  - 超过 128 个对象、来源不符、对象删不掉时，失败关闭。
  - 回收没被跳过时，一个资产保留的是：清单那套、正在生成的那套，外加未失败的站点版本仍在引用的行。最后这一部分会随版本数和管线升级次数增长，目前远低于预算。预算、删除合同和清理活动都不变。
- `reconcileAttemptKeys` 的来源校验和 attempt key 提取改用同一组函数，报错文案不变。
- `verify-site-builder-m1c.mts` 的容量夹具改为租约有效的 processing 行，同时按 `asset_variant_state_payload_check` 去掉 hash、size 和 error 字段（已用库里实际部署的约束表达式对夹具值求值核对）。回收不碰这类行，所以「120 行时拒绝预留」的真栈断言保持原意。按用户确认的验收范围，本次没有在真栈上运行这个脚本。
- 新增用例：
  - 服务层「三套旧版本 + 第四版 30 个计划」：修复前报 151>128，修复后回收 60 行并预留成功。
  - 服务层另有：调用顺序；跳过时报错带原因；未跳过时报错原样抛出。
  - 回收模块 15 项：含锁条件与查询条件、版本引用保护（排除失败版本）、无候选时不扫描、存储窗口从事务开始计时、剩余时间不足时跳过。
  - 清单解析 13 项、构建选图 4 项。
- xin 的 `global_dev` 目前只有 1 个资产带变体：12 个变体，0.35.3，清单完整，构建结果不受影响。

## 2026-10-08 · Discovery runs can lock their own run row

- 起因（2026-10-08 xin 实测）：xin 上第一次执行发现 run（卖方 #10 的查询计划），工作流启动 5 秒即失败，worker 报 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE`。Postgres 日志里的真实原因是 `operator does not exist: uuid = text`：提交查询结果时用原生 SQL 按 run ID 锁 `discovery_run` 行，Prisma 把字符串参数按 text 绑定，而 `discovery_run.id` 是 uuid。这种写法自 90f005de（2026-08-30 接入受治理的查询血缘）起就在，此后任何查询走到提交这一步都会失败。`finalizeRun` 用的是同一个加锁函数，所以失败的 run 也没法标成 FAILED，一直停在 RUNNING。单测用模拟的 `$queryRaw`，不检查参数类型。
- 改动：两处锁 run 行的查询给参数加 `::uuid`（`discovery-query-governed-execution.ts`，以及 `discovery.activities.ts` 的 `lockDiscoveryRunReceiptState`）。同一次排查扫了全部原生 SQL：建站成本对账巡检的翻页条件 `s.workspace_id > ${cursor.workspaceId}` 有同样的问题（翻到第二页才触发），一并加 `::uuid`。其余把参数传给 uuid 列或 uuid 形参的地方都已带类型转换。
- 验证：在 xin 的 Postgres 上用 text 形参的预备语句复现，旧写法分别报 `uuid = text`、`uuid > text`，加转换后正常执行。三个现有测试新增断言：锁 run 行和翻页条件的 SQL 在参数后带 `::uuid`；去掉转换时这三项失败。
- 未做：在真库上跑发现链路的回归测试（CI 的 Postgres 步骤目前不覆盖这条链路），留作后续。

## 2026-10-08 · One unusable model answer no longer fails a discovery run

- 起因（2026-10-08 xin 实测）：
  - 卖方 #14 的发现 run 启动 12 秒即失败。查询执行时给分类词归一的 `taxonomy.normalize` 调用，模型只回了 11 个 token，不是 JSON。归一器本来会把模型失败当作「没归一上」继续，但 `isExecutionControlError` 把 `ProviderOutputError` 判成了控制错误。原因是这个类带 `usage`、`callCount` 等字段，判定函数遇到不认识的形状一律从严。错误于是一路抛出，Temporal 重试时又被预算账本挡住（同一次调用已结算、没有可重放的结果），整个 run 失败。
  - 同样的误判让公开网页抽取、Fit 判定、官网画像等处「单家失败不影响其余」的退路，在真实模型失败时一处都不生效。现有测试用的是普通 `Error`，所以没发现。
  - 卖方 #13 的 ICP 设计报 `ProviderOutputError`，trace 里只有类名。查 new-api 日志才知道是上游 TLS 连接在第 140 秒断开（`scanner_error: tls: bad record MAC`），new-api 仍补发本地估算的用量块并正常结束流，后端把半截 JSON 当成了「模型输出不是 JSON」。
- 改动：
  - `execution-control-error.ts` 新增按类显式登记的「可恢复的模型失败」。登记的只有 `ProviderOutputError` 与 `TaskOutputValidationError`，代表一次回答不能用：非 JSON、schema 不合格、超长截断、任务闸门拒收。有确定性退路的调用方可以吸收这类错误。
  - 判定只认实例的直接原型，所以子类不登记就仍是控制错误。已登记的实例自身 `code`/`type`/`name` 带控制标记时仍按控制错误处理。字段只按数据属性读取，`cause` 链照常追查。
  - 仍然失败即停：
    - 传输失败，即流不可读、被截断、格式错误、上游错误事件、响应体不是 JSON，改抛新的 `ProviderTransportError`；
    - 身份不符（`ProviderIdentityError`）、网关 HTTP 错误；
    - 修复被抑制或修复准备失败，改抛新的 `ProviderOutputUnresolvedError`，并带上原错误作为 `cause`。修复调用本身失败时，只有「修复又回了不能用的答案」才可恢复，网络或传输失败同样改抛 `ProviderOutputUnresolvedError`；
    - `finish_reason` 或 Responses `status` 表示上游整体出错时（如 DeepSeek 的 `insufficient_system_resource`、`failed`），报 `ProviderTransportError`；只有 `content_filter`、工具调用与 `incomplete` 算单次回答不可用，各有原因码；
    - 200 响应体带 `error` 或没有 `choices`，报 `ProviderTransportError`（`CHAT_COMPLETIONS_BODY_INVALID`），不再当成空回答；
    - 结算未知（`ProviderSettlementError`）、合规拦截。
    - 传输、身份、HTTP 这几类失败通常一次 run 里每个调用都会遇到，逐家吸收会让 run 跑完却一家都没判。
  - 流式响应自始至终没有 `finish_reason` 时，报 `CHAT_COMPLETIONS_STREAM_TRUNCATED`，用量照带，结算不变。上游忽略 `stream`、直接回完整 JSON 的情况不受影响。
  - `ProviderOutputError` 增加 `reasonCode`：显式给定（必须是大写代码），或取消息开头的大写代码，否则为 `PROVIDER_OUTPUT_UNCLASSIFIED`，从不含模型文本。几处描述性消息补了代码，结算错误用自身的 `errorCode`，合规拦截为 `EXTERNAL_ACTION_DENIED`。`ai_trace.error_message` 从类名改为 `类名:原因码`。
  - 被吸收的失败要体现在 run 状态里，绝不静默漏判假 DONE：`qualifyFitForRun` 统计没判出来的公司（`unjudged`），大于零时 run 至少 PARTIAL。它不单独判 FAILED，因为计数只覆盖活动的最后一次尝试，之前的尝试可能已存下结论，FAILED 会让这些结论不进评分。官网画像统计没判出贸易角色的数量（`unclassified`），只进 stats。旧历史重放时缺这两个字段，状态不变。
  - 登记入口拒绝 `Error`、内置错误类与宿主错误类（`DOMException`、WebAssembly 错误类），并有测试限定全仓只有两个文件提到该函数、只有两个类被登记。
  - 响应体或流事件里显式的 `"error": null` 不算错误。
  - Router 是受保护文件：两轮复核追加到 `docs/evidence/execution-authority-fence-review-20261001.md`，指纹 `0ad768f0…` → `c9fc50b3…`。
- 测试：
  - 判定函数：可恢复的三种形态（含普通 `Error` 包着可恢复错误）；从严的六类；`cause` 链里的控制错误；未登记的子类；自带控制代码的实例；访问器或原始值形式的 `cause`；原型陷阱抛错的 Proxy。
  - 流：截断（内容不完整、内容完整但缺 `finish_reason`、文本生成）都报 `ProviderTransportError`，各种流形状有各自的原因码；缺 `finish_reason` 的普通 JSON 响应照常接受。
  - router：trace 记原因码；修复后仍不合 schema 时不记 schema 细节；结算未定时抛 `ProviderOutputUnresolvedError`，判为控制错误，且只调用一次模型。
  - 退路：词表归一与官网画像遇非 JSON 回答走退路；官网画像遇传输失败照常上抛。
  - 第二、三轮：上游整体出错的 `finish_reason` 与 `failed` 报传输错误，`content_filter` 与 `incomplete` 可恢复；错误响应体报传输错误，`"error": null` 照常接受；修复又回坏答案仍可恢复，修复遇网络失败判为控制错误；Fit 判定吸收一次失败后 `unjudged` 为 1、遇传输失败照常上抛；run 状态在有未判公司时为 PARTIAL、不会把查询全失败抬成 PARTIAL、旧历史不变；登记入口拒绝内置与宿主错误类，全仓只有两个类被登记。
  - 模型网关、执行预算、发现、Temporal 活动与工作流（含打包重放）、模型运行时与建站付费相关测试 2,627 项通过；第三轮复审跑的全量 API 单测 8,970 项通过；执行授权策略检查 16 项通过。
- 未做：
  - 吸收失败后若同一活动因别的原因重试，重放那次已结算的调用仍会被预算账本拒绝。要彻底解决，需要把失败也存成可重放的结果。
  - 官网画像分类失败被吸收后，会写入一份没有贸易角色的画像，30 天内不会重新画像。这两项都不比改动前更差，因为改动前同样的失败会让整个 run 直接失败。留作后续。
  - 非付费路径上 `fetch` 本身失败（网关不通、请求头超时）抛的是普通 `TypeError`，各处退路会吸收它。这是改动前就有的行为；修复调用里的这类失败本次已改为控制错误。
  - 控制属性在活动边界上丢失：Temporal 只保留类名，工作流层面目前靠重试撞上预算重放错误才失败即停。这也是改动前就有的问题。
  - Fit 阶段遇传输失败时 run 仍停在 RUNNING（BI-25）：改动前所有模型失败都会这样，现在只剩传输类。要在工作流里兜底并收尾，另开任务。
  - 建站付费路径上，修复调用把 `ProviderWireInFlightError` 包起来，结算时认不出来（改动前就有），另开任务。

## 2026-10-07 · Reviewed DeepSeek v4 pro identities and pro routing for acquisition tasks

- 起因（2026-10-07 xin 实测）：获客分组唯一的网关渠道（OpenOx）对同一个 `deepseek-v4-pro` 会报三种名字：`deepseek-v4-pro`、流式块里常见的 `deepseek.deepseek-v4-pro`、非流式应答里常见的 `deepseek-v4-pro-ga-260813`。身份闸门只认精确名，ICP 设计等 pro 调用因此间歇以 `ProviderIdentityError` 失败，而网关侧调用其实已正常结束。该渠道还把 `deepseek-v4-flash` 映射到 pro、应答报 pro 名，所以 flash 任务 100% 被拒，发现 run 跑不出结果。
- `model-identity.ts` 为 `deepseek-v4-pro` 登记这两个已审别名，只在 `openai-chat-completions` 传输下成立；其他名字（含 `gpt-5.6-*`）照旧失败关闭，pro 的名字也不能冒充 flash 请求。别名表是全局的，结算路径上请求 `deepseek-v4-pro` 的 chat-completions 调用同样适用，包括建站默认关闭的回退路由；三个名字指同一模型，结算仍按请求名。
- 流式应答里出现的每个模型名都要过身份闸门，非字符串的名字同样拒收。此前重组只保留最后一块的模型名，内容块来自别的模型族、最后一块报已审别名时会被当作 pro 放行；这个缺口自 #593 起就在，本次加别名后一并补上。来源记录取产出内容那几块的模型名；只要有内容块没报模型名，就不声称上游身份，记为 `requested_fallback`。
- provider 的文本与结构化生成记录来源时，用与 `complete()` 相同的传输（收拢为 `transportFor`），别名调用如实记为 `upstream_response` 并保留上游名字；`resolutionProvenance` 的传输参数改为必填，漏传即编译失败。
- 8 个 flash 档获客任务（企业理解 3 项、`discovery.extract_company`、`discovery.classify_trade_role`、`discovery.extract_list`、`contact.find_decision_makers`、`taxonomy.normalize`）改为经 `ACQUISITION_FLASH_TIER_MODEL` 请求 `deepseek-v4-pro`。xin 网关的扣费日志显示 flash 请求与 pro 请求都按倍率 37.5 扣费、都由上游 pro 服务，所以真实成本与速度不变。`maxCostCents` 不变：后端按自身价目表结算，与网关计价相差很大，另行对齐。这是针对唯一部署的网关的固定选择，有第二个部署之前要改成按部署配置。核验脚本 `verify-broker-closure.mts` 改为从任务注册表取模型。
- 部署注意：无结算调用的预算操作键含请求模型名，工作区报价修订号含 `requestedAlias`。换镜像前须确认没有在途的获客工作流和待重试的授权，否则在途调用可能以新键再发一次。
- 测试：相对 main 为红的有别名解析 2 项、provider 3 项（前缀名流式、日期名非流式、文本生成记录上游名）、任务合同表 1 项（改为 pro，并补上 `discovery.classify_trade_role`）。「混合模型族的流被拒」「真实混合流记录内容块的别名」「非字符串模型名被拒」「内容块无名时不声称上游身份」在前一版实现上为红。另有 7 项负向守护（缺传输或错传输 3、其他模型族 1、pro 冒充 flash 2、整段别的模型族的流 1）修复前后都应为绿。
## 2026-10-07 · Give discovery query execution and the fit pass a 15-minute activity timeout

- 起因（2026-10-07 xin 实测与审查）：获客任务改用 deepseek-v4-pro 之后，发现工作流里的查询执行要串行跑抽取批次与分类归一，资格判定逐家调用一次模型，都会超过原来 2 分钟的活动超时。超时后活动重试，撞上没有结果的重放，整个 run 失败。
- 改动：这两个活动改走 15 分钟超时的代理，重试次数不变，仍为 3 次。其余活动仍为 2 分钟，信号富集等慢活动仍为 30 分钟。活动类型与输入不变，当前没有进行中的发现工作流。
- 撤回了本 PR 第一版的「单项模型失败只跳过」。审查发现它在受治理的血缘校验下照样中止，重放时只是把失败推迟一步，还会把额度耗尽这类系统性故障变成逐家扣费、没有结果也没有失败原因的空跑。共同根因是预算账本分不清「已知失败」和「结果丢失」，另行设计。
- 测试：新增按语法树核对每个活动所用超时的测试 2 项，修改前为红。

## 2026-10-07 · Production advisory remediation (sharp)

- GHSA-wq5f-xc86-pv6w（高危，`sharp <0.35.5`，10-06 13:43Z 发布）：sharp 预编译 libvips 自带的 librsvg 有释放后重用，解码 SVG 时在 glibc Linux 上可能导致远程代码执行。main 自 10-06 17:16Z（`49dfd9f1`）起每次 push 的 `production advisory baseline freshness · canary` 都报 `BASELINE_STALE`，到 `c248c59b` 共 5 次。
- `apps/api` 的精确钉版 0.35.4→0.35.5，即上游修复版（librsvg 2.62.91→2.63.2，libvips 8.18.6→8.18.7，`@img/sharp-libvips-*` 1.3.3→1.3.4）。`pnpm update -r sharp --lockfile-only` 让 astro 的可选依赖 `^0.35.4` 与 Temporal worker 打包链上 webpack 压缩插件的可选 peer 解析到同一个 0.35.5，锁文件里仍只有一份 sharp 和一份 libvips；没有加 override，锁文件也没有别的变化。sharp 与 26 个 `@img/*` 平台包的 integrity 与官方 registry 一致。
- 图片管线版本号随之变为 `sharp-0.35.5-vips-8.18.7-m1c.1`。它是 recipe hash 的一部分，所以 0.35.4 渲染的衍生图不会被复用，下次处理时按新版本重新渲染；钉版本的用例同步改为 0.35.5。管线与 media-foundation 的 3 个用例文件共 172 项通过。
- 修复前的暴露面：API 图片管线只把魔数为 JPEG/PNG/WebP 的字节交给 sharp，解码后再核对格式，而且只在强制 `VIPS_BLOCK_UNTRUSTED=1` 的子进程里解码，该设置下 libvips 拒绝 SVG 输入（0.35.4 与 0.35.5 均实测）；渲染器不用 `astro:assets`，Temporal 打包也不用 webpack 图片压缩。没有产品路径解码过 SVG，但有漏洞的二进制确实随运行镜像发布。
- 安全下限新增 `sharp` ≥0.35.5、登记前任 0.35.4：对上一版锁文件失败，对当前锁文件通过。生产审计回到零 advisory（830 个依赖）。基线重新绑定到修复提交，`valid_until` 不变（2026-10-14T21:28:22Z，月度刷新与续期仍须在此之前合入）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261007-sharp-advisory-remediation.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-07 · Retry an ICP request only when no earlier attempt reached a provider (#597)

- 起因：一次 ICP 设计或查询计划请求开过预算账户后，同一公司/ICP 再也无法重试——账户键由请求决定，第一次请求把它永久绑在第一把 Grant 上，之后每把新 Grant 都 409 `EXECUTION_BUDGET_GRANT_REUSED`。
- 改动：新增 `execution-budget-retry-account` 判定，只对 `icp.design` 与 `icp.query_plan` 生效：仅当之前每次尝试都在派发前释放（`RELEASED`）或从未开户、且对应 Grant 已过账本 60 秒容差时，才允许用派生键 `原键:retry:<authority id>` 开户重试；已结算或结果未知一律不换户。换户在账本锁内进行，且先强制关闭仍开着的旧账户，排队中的预留会失败而不是花钱。绑定校验只接受派生键（原键或追加自身 authority id），其余一律拒绝。CI 的 Postgres 步骤显式运行新的真库测试。无数据库迁移。
- 测试：重试判定单测 13 项；`src/execution-budget` 412 项全过；真库测试 5 项（一次性 Postgres 容器，以 app_user 在 RLS 下执行）连续 5 次通过；五项变异检查各自变红；全量单测通过（唯一失败为已登记负载假红，单独复跑通过）。并入 main 后由 CI 复跑真库步骤。
- 未做：未改 `changelog.md` 本体（按新规走本片段）；未部署，随下一次镜像班次生效。

## 2026-10-06 · Production advisory remediation (http-cache-semantics, smol-toml)

- 10-01 重绑之后，官方 npm 审计库新收录 2 条生产 advisory，都只在 site-renderer 的 astro 链上：GHSA-ch52-4w7c-c8xp（高危，`http-cache-semantics <=4.2.0`，未列修复版本：max-stale 处理可能把一个用户的缓存响应发给另一个用户），main 的定时 freshness canary 自 10-03（ac024fd5）起报 `BASELINE_STALE`；GHSA-r4xh-jqrq-34v2（中危，`smol-toml <=1.8.0`，1.9.0 修复：构造的 TOML 让 `parse()` 退化为二次方时间），10-05 23:41Z 才发布。
- `http-cache-semantics` 4.2.0→4.3.0：4.3.0 于 10-04 发布，就在 astro 自己声明的 `^4.2.0` 范围内，所以只用 `pnpm update -r http-cache-semantics` 定向重解析，不加 override，锁文件也没有别的变化。**这不是实质修复**：维护者以 RFC 9111 §7.3 允许该行为为由把上游报告（issue #56）判为不成立并关闭，4.3.0 里 `satisfiesWithoutRevalidation` 的 max-stale 分支一字未改；4.3.0 只是不在 advisory 现行范围内，另外收紧了 Vary 匹配（任意位置的 `*`、只认自身属性）。astro 只在 `assets/build/remote.js` 里用它在构建期判断远程图片缓存是否新鲜，本仓渲染器不用远程图片，也没有服务多个用户的共享缓存，报告描述的跨用户泄露不适用。若 advisory 日后把范围扩到 4.3.0，需另作安全决策。
- `smol-toml` 精确 override 1.7.1→1.9.0（依赖方的范围仍接受有漏洞的版本，override 保留）。1.9.0 重写了解析器，返回 null 原型对象，并拒绝少数畸形输入；消费者只有 astro 与 nx。
- 安全下限表把 smol-toml 上调到 1.9.0、新增 `http-cache-semantics` ≥4.3.0，登记前任 1.7.1、4.2.0：对上一版锁文件失败，对当前锁文件通过。生产审计回到零 advisory（830 个依赖），两个新包的 integrity 与官方 registry 一致；渲染器契约测试与 Astro fixture 构建矩阵通过（27+4、31/31），nx 照常运行。基线重新绑定到修复提交，`valid_until` 不变（2026-10-14T21:28:22Z，下一次刷新与续期仍须在此之前合入）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261006-production-advisory-remediation.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-06 · Domain ACK prelock readable by Prisma

- 自 2026-08-30 的 authority-first 预锁（`20aa1839`）起，`PostgresDomainAckRepository` 用 `$queryRaw` 执行 `SELECT public.lock_execution_domain_ack_authority_first_v1(…)`。该函数返回 `void`，Prisma 无法反序列化 `void` 列：锁已经拿到，随后在客户端抛出 `Failed to deserialize column of type 'void'`，事务回滚，HTTP 层只报 `INTERNAL`。因此每一个带回执的领域 ACK 都会失败：ICP 设计、查询计划、发现抽取、分类、Fit 的结果都写不进业务表，`execution_domain_ack` 在本机真库里从未有过一行。单测用的是假事务，所以没有发现。PostgreSQL 日志里也没有错误，因为 SQL 本身执行成功了。
- 改为 `SELECT 1 AS locked FROM public.lock_…(…)`：调用移到 FROM，语句返回普通整数；锁的语义与参数不变。新增回归测试：假事务按 Prisma 的真实行为，在 select 列表里出现 void 函数时抛错。修复前该测试为红。另以 app_user 对真库重放一次 ICP 落库事务（随后回滚）：修复前在 domain ack 这一步失败，修复后 ACK 为 `APPLIED`，ICP 与 13 条规则均写入成功。

## 2026-10-06 · Optional streaming for unsettled chat completions

- 网关 provider 新增可选开关 `MODEL_GATEWAY_STREAM_CHAT_COMPLETIONS=true`。打开后，未结算（无 `paidCost`）的 chat-completions 调用以 SSE 流式请求（`stream` + `stream_options.include_usage`），在本地拼回与非流式完全相同的结果（内容、finish_reason、上游模型、usage），后续的模型身份、用量对账和 finish_reason 校验都不变。结算调用（Site Builder 的 request-bound settlement）始终不走流式。默认关闭。
- 起因（2026-10-06 xin 实测）：上游中转 `openox.tech` 在 Cloudflare 后面，非流式长生成约 125 秒时被以 524 断开，直连和经 new-api 都一样，所以 ICP 设计、查询计划这类长输出任务会失败；同一请求改用流式（不经 VPN）146 秒正常完成。解析器严格校验，以下情况一律失败关闭：无法读取正文、data 行不是合法 JSON、流里带上游错误、流里没有任何补全块。上游忽略 `stream`、直接返回普通 JSON 时按普通响应处理。

## 2026-10-06 · Execution authority policy back in the gates

- `scripts/execution-authority-policy.spec.mjs` 自 #586 起登记在 `MANUAL_SPECS`：策略检查在 main 上报 25 个问题，10-06 的 main（`49dfd9f1`）仍是同样 25 项、没有新增。其中 24 项是检查脚本跟不上重构，不是代码违规：10 项是模型投影表在 #449 改成双引号，脚本只认单引号；11 项是五个平台 Tool 改经 `platformExecutionToolContract("<id>")` 声明 id、schema 与产物上限，脚本只认字面 `id: "<id>"`；1 项是专利计费上限改为指向平台合同常量的别名；2 项是 #578 新增的 `discovery.classify_trade_role` 未登记，且它以常量调用 `getTask(WEBSITE_PROFILE_TASK)`，源码清单扫描漏掉了它。脚本现按平台合同解析这些间接引用（含 `as const`、跨行与别名常量），以引号无关的方式匹配映射，把同文件字符串常量的 `getTask` 计入清单，无法解析的大写常量参数报 `EXECUTION_AUTHORITY_MODEL_TASK_UNRESOLVED`。
- 剩下 1 项是受保护的 `router-model-gateway.ts` 指纹，自 d5e4bc42（8-26）起不再匹配。[围栏复核](../evidence/execution-authority-fence-review-20261001.md)逐提交核对了 `b8dd5eb0` 以来改动四个受保护文件的全部提交：要么语义不变，要么新增 fail-closed 控制，唯一的放宽是已批准的 G3 5.1 按调用主体绑定（#565，当时已顺带更新了 ToolBroker 两个文件的指纹）。10-01 之后四个文件都没有再改，Router 当前内容仍是复核时的 `446e5771…`；10-06 另做了一次独立复审，逐行确认了复核结论，另提三点不影响更新指纹的后续事项（结算 `REPLAY` 判定的注释与 SQL 不符、平台出网授权实际还依赖未钉住的 `source-tools.ts`、客户侧中途拒绝的预留释放），一并记在复核记录文末。据此把 Router 指纹更新为 `446e5771…`，检查失败时的提示也改为「先复核、记录复核，再更新指纹」。
- 该 spec 现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行，`MANUAL_SPECS` 删去该项（剩 2 项）。去掉这条导入时，可达性门报 `SPEC_UNREACHABLE`。
- 合并前的独立代码复审找到新解析逻辑会漏报的几种写法。这些写法当前代码里都没有，但都已改为按失败处理：
  - 产物上限按首个记号读取：`LIMIT * 10`、`[…].concat(more)`、`86_400 * 365` 都会被当成合规。现在要求取值是紧接 `,` 或 `}` 的单个记号。
  - `getTask` 改用语法树扫描，也能识别 import 别名、`?.`、`!` 和成员访问。参数不是字面量、也不是同文件常量的调用，只允许 Router、运行时桥、ToolBroker、预算信封这四处登记过的通用查找（`EXPECTED_GENERIC_MODEL_TASK_LOOKUPS`）；把 `getTask` 当作值传递（如 `ids.map(getTask)`）同样报错。
  - 同名常量被声明多次，或经 `import { A as B }` 改名绑定的，按无法解析处理。只有恰为 `const x = platformExecutionToolContract("<id>");` 且只声明一次的绑定，才按平台合同解析。
  - 新增：运行时的封闭清单 `MODEL_RESULT_TASK_IDS` 必须与期望的 Model 任务清单完全一致（`EXECUTION_AUTHORITY_MODEL_RESULT_TASKS_MISMATCH`）。
- 对修复的复查又发现四处问题，均已补上：
  - 加了锚定之后，`match()` 会跳过不合规的首个 `maxBytes:`，转而命中同一 Tool 执行体里的另一个同名属性。现在用 TypeScript 解析该 Tool 唯一的 `durableResultStrategy` 对象，只读它的直接属性，块内其他同名键与注释都不再能顶替。
  - 以函数参数或解构遮蔽的同名常量此前没有识别。现在 `getTask` 的常量参数按语法树上的全部绑定判断：只认文件内唯一的字符串 `const`。
  - 以新名字再导出 `getTask` 此前没有识别。
  - `import def, { A as B }` 形式的改名此前没有识别。
- 在仓库副本上做了 21 项变异，全部被拦下：
  - 先前的 7 项：Router、ToolBroker 各改一个字节，平台合同里 `crawl4ai.render` 的 schema，专利计费上限常量，`icp.design` 的投影值，把 trade-role 任务常量改成未登记的 id，以未定义常量调用 `getTask`；
  - 复审给出的反例及据此补充的 9 项：产物上限三种表达式、`getTask` 经对象成员 / 小写常量 / 作为值传递、常量 import 改名、被遮蔽的任务常量、运行时任务清单多一项；
  - 复查给出的 5 项：制裁与 `http.get` 的上限表达式落到后面的同名属性、在策略对象之前放一个同名键、参数遮蔽任务常量、以新名字再导出 `getTask`。

  新增用例在加固前的脚本上均失败。spec 由 10 项增至 16 项。`governance:test` 由 276 项增至 292 项，xin 上 load 12 时 48 秒，其中本 spec 约 18 秒。

## 2026-10-06 · Model settlement REPLAY must be this attempt's own

- `settle_site_build_spend` 与 `settle_unknown_site_build_spend` 对任何已不是 RESERVED 的行都返回 `REPLAY`，而且这一判断在 fence 校验之前。Router 原先把 `REPLAY` 一律当作结算成功，首次调用也不例外。可是 provider-spend 恢复任务（`completeProviderSpendReconciliation`）会把仍为 RESERVED 的模型支出结算为 UNKNOWN，或结算为结果为空的 FAILED（`MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY`）。原调用若只是慢，随后会拿到 `REPLAY`，把自己的输出当作成功返回，而账本记的是「输出不可用」。没有预算泄漏，也不会多发一次调用，但交出去的结果不是持久记录。
- 现在首次结算返回 `REPLAY` 即冻结（`SETTLEMENT_REPLAY`，停用该 BuildRun 的付费调用）；失败与零调用释放路径也一样，与 `STALE_FENCE` 的处理一致。唯一一次 ACK 重试返回的 `REPLAY`，要经新增的只读方法 `SiteBuildCostLedger.confirmSettlementReplay` 回读该行，确认 status、fence、计费依据、调用次数、结果、meta 与错误码都正是本次写入的内容，才接受；否则冻结（`SETTLEMENT_REPLAY_UNCONFIRMED`）。只比较 fence 与调用次数不够：恢复任务以该行自身的 fence 结算，调用次数又由触发器固定，所以 meta 与错误码也要比较。超出预留时记录的 `CAP_VARIANCE` 也计入比较。不需要迁移。
- `router-model-gateway.ts` 是受保护文件。复核记录追加在[围栏复核](../evidence/execution-authority-fence-review-20261001.md)文末（独立复审：无 CRITICAL/HIGH；MEDIUM 一项已修复；LOW 一项按设计保留），指纹 `446e5771…` → `0ad768f0…`。新增 Router 用例 6 个、账本用例 13 个（先确认为红；去掉 meta 与错误码比较后，区分恢复任务的 4 个用例会失败）。`paid-execution-gates` 中 ACK 丢失后重放的用例改为要求回读确认。没有用真实 PostgreSQL 做往返：现有 live spec 会在共用的 `global_dev` 留下夹具，所以没有跑。

## 2026-10-06 · Platform wire dispatch fence

- 平台出网自 7c87ea80 起按每次物理调用授权，前提是工具把 `sourcePhysicalWire(ctx, "<wire>")` 交给适配器，适配器也只经这个调度器发请求。四个适配器（`requestPublicHttp`、`crawlUrl`/`crawlHtml`、`queryAlgoliaExhibitors`，以及转交调度器的 `isAllowedByRobots`）在没拿到调度器时会直接发请求，这是客户侧路径的正常行为。因此只要平台工具或适配器丢了调度器，请求就会绕过平台出网授权，ToolBroker 也照样接受结果。这几处都不在 Router/ToolBroker 指纹围栏里（#592 围栏复审后续事项 2）。
- 用户选定静态接线检查，不把这些文件整份钉住（`source-tools.ts` 自 8-01 起改过 16 次）。新增 `scripts/execution-authority-wire-dispatch.mjs`，作为 `execution-authority-policy` 的一部分在 required 门里运行：
  - 接受调度器的导出适配器函数构成封闭清单，共 5 个；
  - 终端适配器的每个发送调用（`fetch` / `execute`）都必须位于唯一的 `executePhysicalWire` 闭包内，闭包只能经 `dispatchPhysicalWire ? await dispatchPhysicalWire(executePhysicalWire) : await executePhysicalWire()` 执行；
  - 转交型适配器所在文件里，所有 `requestPublicHttp` 调用都必须在它内部，并把收到的调度器原样转交；
  - 活跃平台工具（从平台合同推导，跳过 `disabled_no_egress`）的 `execute`，及其调用到的同文件辅助函数里，每个适配器调用都必须带一个 `sourcePhysicalWire(ctx, "<wire>")`，而且 wire 必须是调度器按合同会接受的那一个；合同声明的每个 wire 都必须用到；不得直接调用 `fetch`、Node 网络模块，或未登记的适配器函数；
  - `sourcePhysicalWire` 的故障即拒绝函数体按文本钉住。
- 合并前的独立复审在不改变「静态检查」选型的前提下找到若干绕过写法，均已改为按失败处理：
  - 平台工具能触达的导入改为白名单。只允许已登记的 wire 适配器，以及 `EXPECTED_PLATFORM_TOOL_IMPORTS` 中的平台合同、`ExecutionControlError`、`assertToolExternalActionAuthorized`、`decodeJsonBytes`、`EgressBlockedError` 与 `createHash`。从其他模块导入、动态 `import()`、`globalThis` / `fetch` 作为值使用、axios / child_process 等网络模块都报错。
  - 工具会顺着它引用的所有同文件声明继续检查，包括回调、别名和方法对象。这样也覆盖了经 robots 的 `request` 钩子注入未经调度的请求。wire 适配器只能被直接调用，不能当作值传递。
  - 终端适配器：同文件中任何能发请求的声明，都不得在闭包外被引用（传递求出，例如 `executePinnedHttp` 与 `crawlUrl`）；闭包内只能发一次、不在循环里；调度条件必须读取函数自身的调度器参数，且该参数不得被重新赋值、删除或遮蔽。
  - 转交型适配器：`requestPublicHttp` 只能作为带调度器调用的被调函数出现，包装器只能经收到的调度器执行。
  - 合同行不得含 spread，且只认 `deepFreeze` 与 `technicalRow` 两个构造器；文件里只能有一个名为 `sourcePhysicalWire` 的绑定；兼容 `.js` 后缀导入与 const 箭头函数形式的适配器。
- 第二轮独立复审又找到一批绕过写法，同样改为按失败处理：
  - 适配器文件的导入改为白名单：只允许网络模块与 `EXPECTED_WIRE_ADAPTER_IMPORTS`（`bounded-fetch-response`、`guarded-http`、`url-guard`、平台合同），其他导入报 `WIRE_ADAPTER_IMPORT_UNREGISTERED`；`process.getBuiltinModule` / `process.binding` / `module.require` / `eval` / `Function` 这类运行时加载器在适配器文件与平台工具里都报错。
  - robots 文件只能经 `requestPublicHttp` 发请求：文件里出现网络模块、网络全局或其他 wire 适配器即报 `WIRE_ADAPTER_FORWARD_MISSING`。
  - 终端适配器的 send 别名（`dependencies.executePinned ?? executePinnedHttp`）里不得有调用或新建函数，防止提前发送或包进重试。
  - 调度器参数只读：`dispatchPhysicalWire` 只能出现在调度条件里；options 参数只能以 `<param>.<property>` 读取，不得整体传出、别名、经成员改写（含 `Object.assign`）、删除或遮蔽。
  - `executePhysicalWire` 闭包内的那一次发送必须直接位于闭包，不能藏在嵌套函数（如 `Promise.all([..].map(...))`）里。
  - 平台工具对象不得被展开、重新赋值或经 `Object.assign` / `defineProperty` 改写（`PLATFORM_TOOL_REDEFINED`），保证被检查的 `execute` 就是注册运行的那个。
- 当前代码零问题。在仓库副本上做了 29 项变异，全部被拦下：
  - 先前 15 项：工具丢了调度器、传 `undefined`、使用未声明的 wire、直接 `fetch`、调用未登记的适配器、经本地辅助函数绕过、`sourcePhysicalWire` 去掉平台拒绝、三个终端适配器绕过闭包或调度、robots 的三种转交缺陷、新增接受调度器的适配器、合同新增却从未用到的 wire；
  - 第一轮复审补充 7 项：robots 的 `request` 钩子、`globalThis.fetch`、从非适配器模块导入、`executePinnedHttp` 预检、`crawlHtml` 未经调度调用 `crawlUrl`、调度器参数被置空、把 `requestPublicHttp` 当作值传给 `loadRobots`；
  - 第二轮复审补充 7 项：适配器文件导入白名单外模块、robots 文件裸 `fetch`、send 别名包进调用、`Object.assign` 改写调度器参数、闭包内经嵌套函数发送、工具里 `process.getBuiltinModule("node:https")`、注册时展开工具对象替换 `execute`。

  spec 共 17 项，其中第一轮 8 项、第二轮 4 项在各自加固前的检查上失败。
- 定位：这是防回归的检测器，不是出网边界。白名单模块内部（例如平台合同模块）若藏有发送，本检查看不到。复审建议在 ToolBroker 加运行时兜底（平台调用必须至少经过一次调度），用户 2026-10-07 决定不加：它只多抓「完全没经过调度」这一种情况，而这种情况静态检查已经覆盖；它会误杀 robots 缓存命中且被禁抓时的零请求结果；4 个平台 schedule 仍处于暂停状态。真正的边界应在网络层做：platform worker 只能经过一个校验授权的代理出网。恢复平台 schedule 或上 pilot 前再评估。

## 2026-10-01 · @grpc/grpc-js security floor

- 9-30（UTC）官方 advisory 库新收录 2 条 `@grpc/grpc-js` 生产 advisory：GHSA-m9gg-hp2v-232j（高危，特定配置下 `getAuthContext` 可能把未经授权的证书当作已授权返回）与 GHSA-f596-whhp-79r4（低危，服务端把方法处理器抛出的部分错误信息放进状态消息发给客户端），受影响 `>=1.14.0 <1.14.5`。main 锁文件里是 1.14.4（经 `@temporalio/*` 1.23.0 与 OpenTelemetry 的 OTLP gRPC exporter 引入）。这两条在 GitHub 上 9-30 15:35Z 发布，但 #576 在 16:13Z 的官方审计仍为 0（npm 审计库收录滞后），所以 #576 合入后（22b1ca31，19:45Z）main 的 `production advisory baseline freshness · canary` 立即报 `BASELINE_STALE`，`current_advisories` 正是这 2 条，直到 e7ee633d 都没变。
- #583 的月度刷新已把它解析到 1.14.5（Temporal SDK 1.24.0 的声明范围内，不需要 override），合入后 main（590b9f3e）的 canary 恢复 `FRESH`、零 advisory。#583 的回执只记录了刷新后的审计，没有写到这 2 条，在此补记。
- 按 runbook，`scripts/dependency-security-remediation.spec.mjs` 新增 `@grpc/grpc-js` 下限 1.14.5，并把 1.14.4 登记进 `VULNERABLE_PREDECESSORS`：对 e7ee633d 的锁文件该下限失败，对当前锁文件通过。锁文件、override 与漏洞基线都不变。

## 2026-10-01 · Dev-dependency alert refresh (axios, brace-expansion)

- 官方全量审计（含开发依赖）在 main 上报 16 条：axios 12 条（7 高危，`<1.20.0`）、brace-expansion 3 条（2 高危，`>=4.0.0 <5.0.12`）、`@faker-js/faker` 1 条（高危，`<=10.4.0`）；生产审计为 0。axios 与 brace-expansion 都来自 nx 23.2.1（当前最新版）自己的精确钉版——`axios 1.18.1`、`minimatch 10.2.5`（后者以 `^5.0.5` 解析出 brace-expansion 5.0.9）——所以 `pnpm update` 移不动。
- 加两条以漏洞区间为选择器的精确 override：`"axios@<1.20.0": "1.20.0"`、`"brace-expansion@>=4.0.0 <5.0.12": "5.0.12"`（minimatch 3/5 用的 1.x、2.x 线不在区间内，不受影响）。锁文件只变这两个包：axios 1.18.1→1.20.0，brace-expansion 5.0.9 并入 5.0.12；nx 照常运行。安全下限表新增 axios ≥1.20.0、brace-expansion（自 4.0.0 起）≥5.0.12，并登记前任 1.18.1、5.0.9：对上一版锁文件失败，对当前锁文件通过。
- 全量审计由 16 条降到 1 条，只剩 faker 5.5.3（`@stoplight/prism-cli` → `json-schema-faker`，仅 contracts 的 mock 开发依赖）：强制换成 faker 10 会让 json-schema-faker 失效，继续开放。Go 侧原生 Temporal 镜像的 otel 3 条低危已于 10-01 按可容忍风险关闭，下次重发该镜像时升级。
- 生产审计仍为零 advisory（830 个依赖）；基线重新绑定到本提交，`valid_until` 不变（2026-10-14T21:28:22Z）；旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20261001-dev-dependency-alert-refresh.json)。Copy fixed-source 回执只重签指纹。

## 2026-10-01 · Egress guard recognizes mihomo IPv6 fake IPs

- xin 的 Clash Verge（mihomo，TUN + fake-ip）打开 IPv6 后，公网域名同时解析出 198.18.x 与默认 `fake-ip-range6` 里的 `fdfe:dcba:9876::x`。出网护栏 `net-guard.ts` 与 Crawl4AI 镜像里的 `fakeip_resolver.py` 都只认 198.18/15：只有全部答案都是假 IP 时才改查固定 Cloudflare DoH，混进 IPv6 假 IP 后就按私网拒绝。结果是 `POST /companies` 对任何官网都报 `INVALID_URL`，抓取也会全部失败。
- 两处都把 `fdfe:dcba:9876::/64` 认作 mihomo 假 IP。规则不变：只有**全部**答案都是假 IP 才走 DoH，DoH 的答案照旧要过全局地址校验；该 /64 之外的 ULA、假 IP 与真实私网的混合答案仍直接拒绝。TS 与 Python 两侧都补了正反例。Crawl4AI 是本机自建的 `global-crawl4ai:local`，下次重建时生效；后端随下一次运行时镜像生效。

## 2026-09-30 · Website profiling in the discovery run (G3 slice 5.4b, part 2)

- discovery run 在归一之后、Fit 之前新增「官网画像」阶段 `profileWebsitesForRun`：按公司绑定主体抓首页与 Impressum，把贸易角色、置信度与来源、是否自有制造、在售品牌与两个品牌信号、法定名称、登记号（带法院）、税号、证据片段写入 `website_profile` 命名空间，登记号与税号作为带校验的语义标识符进入属性白名单。主体被拒只跳过该公司并计入 PARTIAL，控制错误照旧让 run 失败；30 天内画像过的公司不重抓；每个 run 至多 50 家。工作流以 patch `discovery-website-profile-v1` 守卫，旧历史重放不变；阶段为尽力而为，失败时 Fit 照常判定。
- 新数据源 `website_profile` 默认 DISABLED，登记进 provider 注册表、source-class 清单与生成文档，实测后再开启。发现 run 的技术报价补上这一阶段（每家 2 次抓取 + 1 次分类，上限 50 家）。
- Fit 第 2 部分：候选信息带上 `website_profile`（不含登记号与税号），任务说明写明官网画像是角色门与商业模式门的直接证据、在售外国尤其中国品牌是进口分销的强信号。依据：G3 规格 §3 ⑤、§5.4；设计 §3.3、§4 第 7–8 项。有证据的名称修正与次级去重键留待 5.4c。

## 2026-09-30 · Website-profile provider and trade-role task (G3 slice 5.4b, part 1)

- 新增 `WebsiteProfileProvider`（尚未接入 run）：以已建档公司为主体（`artifactSubject`）抓首页与 Impressum，两次抓取都由 ToolBroker 按调用绑定主体。规则分类器能下结论就不调模型，否则调用新任务 `discovery.classify_trade_role`（flash 档，闭合 schema：贸易角色 distributor/wholesaler/manufacturer/mixed/service/other、置信度、是否自有制造、在售品牌、至多 3 条证据）。品牌取词典匹配加模型补充；Impressum 解析出登记号、税号和法定名称。禁令类拒绝与控制错误向上抛出，由调用方按公司跳过或让 run 失败；Impressum 缺失或模型普通失败时保留确定性结果。
- 证据只留公司级：含 Geschäftsführer、Inhaber、Ansprechpartner、Herr/Frau 等人员标记的片段整条丢弃，其余打码电话与邮箱。新任务已登记进 typed projection、回执事实、domain-ACK 与治理清单（`durable-result-strategies.json`、`execution-authority-callsites.json`）。依据：G3 规格 §3 ⑤、§5.4；设计 §3.3。

## 2026-09-30 · Website-profile rules and identifiers (G3 slice 5.4a)

- 新增纯函数（尚未接线）：Impressum 解析，产出 HRB/HRA+登记法院（次级去重键 `de-hrb:<法院>:<号>`）、带校验位的德国税号，以及只接受资合公司形式（GmbH/AG/SE/UG/KG 组合/eG）的法定名称；独资商号（e.K.）与任何人员行一律不取。在售品牌词典附带品牌国别，用来标出「在售中国品牌」和「在售外国品牌」两个信号。贸易角色规则分类器只有结论明确时才跳过模型。
- 主体绑定的 `crawl4ai.fetch` 产物文本改用专用归一化：保留 `DE136695976` 这类税号（原通用打码会把它当成电话），截断上限从 2 万提到 7.5 万码点（仍在 300 KB 合约之内），首次结果与重放一致。Site Builder 的证据归一化与 `scrubPii` 不变。依据：G3 规格 §3 ⑤⑥、§5.4。
- 接手时的审查修正：登记法院未知时不产出去重键（登记号只在同一法院内唯一，`de-hrb:unknown:<号>` 会把不同公司并成一家）；法院识别补上「des Amtsgerichts München」「Registergericht: München」「Registergericht: AG Köln」几种写法，也修正了把后面的「HRB」读进法院名的问题；法定名称截到公司形式为止，丢掉同一行的宣传语；Leo、DAB、Zenit 等本身是常见词或人名的品牌，裸名只在谈到泵、或同一行还有其他明确品牌时才计入，Impressum 里「Geschäftsführer: Leo …」这类行不再被当成「在售中国品牌」。

## 2026-09-30 · Fit judges by the ICP trade role (design §4 step 8, part 1)

- `discovery.qualify_fit` 的四个门原本按「设备制造类买家」写：商业模式门把中介判为 weak，材质门、工艺门对分销商也不适用，分销商 ICP 下的真分销商会被系统性判成 weak。现在 ICP 摘要带上确定性的 `icp_trade_role`（与 5.3 同一套识别规则），任务说明按角色判：distributor 时，采购并转售实物产品的分销商、批发商、进口商、经销商判 pass，只做信息撮合的平台、目录或门户判 weak，同类产品制造商仍按角色门判为竞品；ICP 未对材质或工艺提出要求时视为不适用、判 pass；manufacturer 或未指定角色时，原有判定不变。候选信息新增已抽取的能力关键词（`keywords`），分销证据多在其中。
- 第 2 部分（官网画像给出的贸易角色与在售品牌作为 Fit 证据、评分加减分项）随 5.4 进行。依据：设计 §3.3、§4 第 8 项。

## 2026-09-30 · Company-subject binding for signal enrichment and watch registration (G3 slice 5.5)

- 信号富集（数字足迹 `crawl4ai.render`、结构化收割 `http.get` + `crawl4ai.render`）与网站监控注册（sitemap `http.get`）此前不带主体，调用全部落在主体绑定禁令上。更糟的是，这类拒绝属于控制错误，只要 run 里有公司通过 Fit=match，整个 run 就会在信号富集这一步失败。现在这两处按公司传入 `artifactSubject`（`ExecutionContext` 新增该字段，provider 展开进 ToolContext；`registerWatch` 直接绑定它正在注册的公司），抓取结果按 5.1 的合同以该公司为主体落对象存储。
- 按公司失败语义：主体被 tombstone、SUPPRESSED 或绑定失效时，只跳过这家公司，不写任何属性（已产生的回执照常 ACK），计入 `skippedSubjects`，run 至少记为 PARTIAL，stats 中可见。预算、授权、对象存储不可用等控制错误照旧让 run 失败。
- 联系人发现（decision_maker、public_web 联系人页）有意不接入，继续保持禁令：它不在公司级链路内，报价也仍是 unavailable。这比规格 §5.5 列的范围更保守。依据：G3 规格 §3.1、§4.2、§5.5。

## 2026-09-30 · Technical quotes for discovery runs and company creation (G2)

- `POST /query-plans/:planId/execute` 与 `POST /companies` 的技术报价不再恒为 unavailable，GrowthOS 可以为发现 run 和卖方企业建档签发 Grant。报价是整条链路的物理预留上限（每次模型调用按结构化输出的 2 次 wire 上限预留），逐阶段累加：词表归一、`public_web` 搜索与判站、名录页、单次检索类源（wikidata/osm/ted/openfda/展会）、Fit、GLEIF/Wikidata 富集、信号富集、网站监控注册；建档 = 首页加至多 6 个子页的抓取与逐页抽取。联系人发现仍返回 unavailable（不在公司级链路内）。
- 各阶段上限集中到 `discovery/execution-envelope.ts`，provider、workflow 与报价引用同一常量。借此补上两处此前无界或未强制的上限：robots.txt 声明的 sitemap 根最多读 4 个；每条计划查询送去词表归一的行业词最多 4 个、国家/地区词最多 2 个（原先每个过滤字段最多 32 个值，每个未命中词一次模型调用）。计划查询上限改为 planner 的 64 条加 TED、openFDA 冷路径各 1 条，共 66 条，并在执行时强制（原 64 条上限从未被检查）。
- 按现有上限，一次 run 的预留上限约 5,587 美元，其中 Fit（最多 11,550 家 × 每家预留 40 美分）约占 83%；实际费用按真实用量结算。卖方企业建档约 5.87 美元。依据：设计 §3.1 / §4 第 3 项（G2）。

## 2026-09-30 · ICP trade role carried into keyword discovery queries (G3 5.3 follow-up)

- 5.3 让关键词搜索按 `filters.trade_side` 等构造贸易角色词，但 `discovery.query_plan` 的过滤器 schema 没有 `business_model`，planner 也不一定填 `trade_side`，真实链路上角色词可能根本不出现。现在生成查询计划时，若 ICP 的 `company_attributes.trade_side`（优先）或 `business_model` 能识别出角色，就把规范值 `distributor` / `manufacturer` 写进未带角色的 planner 查询；planner 自己写了角色的保持不变，TED、openFDA 冷路径查询不受影响。写入发生在计划落库前，人工确认计划时可见。

## 2026-09-30 · Monthly dependency refresh and audit baseline renewal

- 按[依赖刷新 runbook](../backend/dependency-refresh.md) §3 做本月批量：`pnpm update -r '!sharp'` 在声明范围内移动约 260 个锁定包，`package.json` 的范围下限随之改写为实际版本。实际变化的直接依赖：NestJS common/core/platform-express 11.2.3→11.2.7、`@nestjs/throttler` 6.5.0→6.7.1、Temporal SDK 1.23.0→1.24.0、`ai` 7.0.105→7.0.124（及 Anthropic/OpenAI provider）、astro 7.3.2→7.3.5、AWS S3 SDK 3.1134→3.1144、jose 6.2.3→6.2.12、fast-xml-parser 5.11.0→5.11.2、`@redocly/cli` 2.53.2→2.57.0、eslint 10.10→10.11、typescript-eslint 8.70→8.71、prettier 3.9.7→3.9.9 等；传递依赖含 AI SDK 链的 undici 7.29.1→7.30.0、vite 8.1→8.3、webpack 5.110→5.111、Sentry 10.70→10.75。未纳入大版本：NestJS 12、`actions/dependency-review-action` v5。
- `pnpm update` 不移动精确钉版，同族包因此显式处理：`apps/api` 精确钉的 `@temporalio/common`、`@temporalio/proto` 与其余 `@temporalio/*` 一起到 1.24.0——有界失败诊断转换器继承 SDK 的 `DefaultFailureConverter` 并自建失败类，必须与 worker/client 同版本；1.24.0 让 `ApplicationFailure` 保留原生 `Error.cause` 链，转换器、控制与重放共 71 个用例照常通过。`sharp` 用 `!sharp` 排除：确定性图片管线精确钉 0.35.4，否则 astro 链会带出 0.35.5 和第二份 libvips。`packages/db/package.json` 是仍与 Copy 固定源一致的绑定文件，丢弃它纯表面的范围改写（prisma 解析本来就是 6.19.3），漂移集合不越出已审范围。
- 撤掉 `multer` override：`@nestjs/platform-express` 11.2.6 起自己钉 2.4.0 且是唯一消费者，解析不变。undici、fast-uri 两条保留（unifont 最新 1.0.2 仍要求 `undici ^8.0.0`，ajv 8.20.0 仍要求 `fast-uri ^3.0.1`）。
- Actions：`github/codeql-action` v4.38.0→v4.38.2（默认 CodeQL bundle 2.27.1，只用于非必需 canary）；`oasdiff/oasdiff-action` v0.1.15→v0.1.17（镜像内 oasdiff 1.31.0→1.32.1，入口脚本只加了 shellcheck 注释，`review: "false"` 与 `OASDIFF_INTERNAL` 的隐私合同不变；两个版本离线重放本仓最近 40 次 `openapi.json` 变更，finding 逐条一致）。
- 官方 registry 生产审计零 advisory（830 个依赖）；基线重新绑定到刷新提交，失效时间 2026-10-14T16:13:14Z → 2026-10-14T21:28:22Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20260930-monthly-dependency-refresh-baseline-renewal.json)）。上一次续期同在当天，所以只顺延数小时，下一次刷新仍须在 10-14 前合入。Copy fixed-source 回执只重签指纹（`HASH_ONLY`）。

## 2026-09-30 · Dependency security floors wired into the governance gate

- `scripts/dependency-security-remediation.spec.mjs` 自 8-15 引入后从未被任何 runner 执行（不在 `governance:test` 入口、package 脚本、workflow 或 `gctl check` 里），#551 之后在 main 上 2/5 失败却无人察觉；安全合同页所说的「真实 deploy 版本不漂移」验证也因此一直没有在跑。现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行；`governance-path-contracts.spec.mjs` 拒绝移除该导入。
- 语义由「精确快照必须存在 + root overrides 全等」改为锁文件上的已审下限：例行升级（如 @nestjs/core 11.2.3→11.2.7）不再误报，而修补版旁边混入的旧版本（如 qs 6.14.0 与 6.16.0 并存）此前两层断言都会放过，现在失败；撤掉已被上游范围覆盖的 override 不受影响，但 override 只能精确钉到正式版本（范围、别名、git/URL 来源都失败）；锁文件里 URL/git/file 来源的同名包按无法比较处理并失败；已登记的漏洞前任（原先分在两张表，现合为 `VULNERABLE_PREDECESSORS`）必须低于下限，防止下调下限；`third-party-web` 仍由真实 pnpm deploy 回归钉住。对 9-30 修复前的 main 锁文件，下限正好报出 fast-uri 3.1.6、multer 2.3.0、undici 8.10.0。
- 代价实测：整份 spec 在 xin（4 核共用、load 12–21）上 2.7–4.3 秒；deploy 回归连续 20 次与 6 路并发 ×5 轮共 50/50 通过，load 37 时最慢 20 秒（单命令超时 50 秒、用例 120 秒）；在 load 35 的完整 `governance:verify` 中占 19.7 秒。

## 2026-09-30 · Scripts specs must be reachable from a CI runner

- 上一条不是孤例：`scripts/` 下另有 8 个 spec 从未被任何 runner 执行。逐个在 xin（4 核共用、load 12–22）上跑：`governance-main-worktree-sync-filesystem`（18 项，0.8 秒）、`runtime-artifact-contract`（13 项，0.4 秒）、`verify-platform-authority-policy-import`（2 项，0.4 秒）、`worktree-inventory`（8 项，0.9 秒）全过且零容器，现由 `governance-contracts.spec.mjs` 导入，随 required 的 `governance · traceability · release` 与 build 作业的 `docs:verify` 执行。
- `governance-github-readback.spec.mjs` 与 `governance-github-readback.mjs` 是 #566 删除 approval/readback 簇时漏掉的两个文件（名字不带 `-` 后缀），它们导入的 5 个 spec 与 4 个模块已随该簇删除，加载即报 `ERR_MODULE_NOT_FOUND`；按该簇已获批准的删除一并移除。
- 三个按设计不进零容器门的 spec 登记为手动（`MANUAL_SPECS`，各带理由与运行命令）：`platform-authority-policy-import.cross-repo` 需要 GrowthOS 权威检出，本机经 `node scripts/verify-platform-authority-policy-import.mjs` 实测 `VERIFIED`（4.0 秒）；`runtime-worker-namespace-lease.postgres` 起一次性 PostgreSQL 容器，默认跳过，设 `RUN_RUNTIME_WORKER_NAMESPACE_POSTGRES=1` 时 7 项全过（24.9 秒，容器已自动清理）；`execution-authority-policy` 在 main 上 6 项中 1 项失败，策略检查报 25 个问题：钉住的 `router-model-gateway.ts` 指纹自 d5e4bc42（8-26）起就不再匹配，Tool、Model 任务与投影清单也跟不上现有源码。重新钉 Router/ToolBroker 围栏要单独做安全复核，本次只登记、不改。
- 新增 `scripts/governance-spec-reachability.mjs`：只读 workflow 步骤的 `run:` 命令（折叠、字面、引号与多行标量整段读取，字面 `if: false` 关掉的步骤或作业不算），`pnpm <script>` 展开为根 package.json 脚本，收集同一命令段里 `node`/`tsx` 的 `--test` 参数，再沿 spec 与辅助模块的 import 求闭包（按 TypeScript 语法树判断，注释、字符串与纯类型导入不算）。`governance:test` 的独立根 `governance-path-contracts.spec.mjs` 断言 `scripts/` 下每个 `*.spec.*`/`*.test.*` 都可达或已登记为手动；登记缺理由或运行命令、已被 runner 执行、文件已删，以及 runner 用 glob 或指向不存在的 spec，都会失败。在仓库副本上做的 15 项变异（删导入、用块注释注掉导入、新增孤儿、删 CI 步骤、把运行步骤换成 echo、用 `if: false` 关掉步骤或唯一运行它的作业、glob runner 等）全部被拦下。`governance:test` 由 221 项增至 276 项，xin 上 load 15–17 时 51–64 秒（改动前 load 14.6 下 45 秒）。

## 2026-09-30 · Production advisory remediation and audit baseline renewal

- 9-28/29（UTC）官方 advisory 库新收录 15 条生产 advisory，9-30 起 main 的 `production advisory baseline freshness · canary` 报 `BASELINE_STALE`（#568、#569 合入后的运行均如此）：undici 8.10.0 共 11 条（3 高危，经 astro→unifont，仅 site-renderer 链）、fast-uri 3.1.6 共 3 条（2 高危，经 `@temporalio/worker` 的 webpack→ajv）、multer 2.3.0 共 1 条（经 `@nestjs/platform-express`）。
- fast-uri、multer 的安全 override 升至 3.1.8 / 2.4.0（后者也是 `@nestjs/platform-express` 11.2.7 自带的版本，并去掉了 concat-stream / typedarray）；另加以漏洞区间为选择器的 `undici@>=8.0.0 <8.10.2` → 8.10.2：pnpm 对声明范围与该区间相交的 undici 依赖生效（这里是 unifont 的 `^8.0.0`），AI SDK 的 `^7.29.0` 不相交，undici 7.29.1 未改动。按包过滤的 `pnpm update` 不会移动这份传递副本，还会扰动 vitest 的 peer 快照，所以沿用 lodash/uuid 那种精确钉版；unifont 自身要求 ≥8.10.2 后应撤掉这条 override。三个新包的 integrity 与官方 registry 一致，离线 `pnpm deploy` site-renderer（镜像构建路径）得到的也是 undici 8.10.2；本仓 API 没有文件上传路由，site-renderer 用 `@fontsource` 自带字体、不经 unifont 下载，两处升级触及的运行面都很小。
- 官方 registry 生产审计清零（870 个依赖）；基线重新绑定到修复提交，失效时间由 2026-10-03 延至 2026-10-14T16:13:14Z（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`、新绑定 `FRESH`，见[回执](../evidence/security/20260930-advisory-remediation-baseline-renewal.json)）。Copy fixed-source 回执只重签指纹；`scripts/dependency-security-remediation.spec.mjs` 同步到新的安全下限（目前没有入口执行它）。

## 2026-09-25 · Search-first company discovery (G3 slice 5.3)

- `public_web` 发现阶段不再抓官网：SearXNG 的搜索语言随 ICP 目标国（德奥瑞 → `de`，法 → `fr`……，未知 → `en`）；查询串 = 品类词 × 目标国语言的贸易角色词（分销商 ICP → Großhandel/Händler/Vertrieb，角色来自 `trade_side`/`business_model`/`establishment_type`），不再硬加 `manufacturer company`；候选域名额外过滤非目标国 ccTLD；`discovery.extract_company` 只凭同一域名的搜索标题、摘要与 URL 判站并抽取，任务白名单去掉 `crawl4ai.fetch`。记录的 `parserVersion` 为 `public_web/v2-search`。官网页面改为在建档之后、以公司为主体抓取（5.4）。
- `directory` 名录页在建档前没有真实主体，抓取被主体绑定禁令拒绝时只跳过该页，不再让整个发现 run 失败；预算、授权等控制错误照旧上抛。
- 未升 lineage/materialization 合约版本：producer（`discovery.extract_company`）与结果 schema（`discovery-extract-company/v1`）不变，搜索回执本来就作为辅助回执处理；materialization 合约版本钉在 SQL 触发器与 activation 表中，升版不带来额外可验证性。依据：G3 规格 §3、§4.3、§5.3（版本一项按上述理由偏离，已在 PR 说明）。

## 2026-09-25 · Skippable artifact-subject denials (G3 slice 5.2)

- 新增 `artifactSubjectSkipReason`：沿 cause 链识别 ToolBroker 的四类禁令拒绝（主体 HOLD、tombstone、SUPPRESSED、绑定失效），供按公司处理的富集阶段跳过该公司，而不是让整个 run 失败。预算、授权、存储不可用等控制错误照旧上抛；`isExecutionControlError` 不变，所以发现阶段（无主体）的行为不变。`resolveRunStatus` 新增 `skippedSubjects`：有跳过时至少为 PARTIAL，但不会把全失败的 run 抬成 PARTIAL。依据：G3 规格 §4.2、§5.2；调用方在 5.4 接入。

## 2026-09-25 · Per-call artifact subject binding (G3 slice 5.1)

- `crawl4ai.fetch` / `crawl4ai.render` / `http.get` 的主体绑定禁令改为按调用判断：调用方在 `ToolContext.artifactSubject` 给出已建档的公司或联系人时，ToolBroker 先在 RLS 事务内核对主体属于本 workspace、未被 DSR tombstone、公司（或联系人所属公司）未被 SUPPRESSED，全部通过才发请求；抓取结果按工具声明的 `PERSONAL_DATA`、1 天 TTL 经 `GenericOperationArtifactService` 落对象存储，以 artifact 引用原子结算，重放时从校验过的对象字节还原。没有主体的调用（发现阶段建档前、平台 sanctions）保持原禁令；存储配置缺失时一律拒绝，不回退到内联结算。
- 新增迁移 `20260925090000_artifact_subject_execution_hold`：app_user 对 tombstone 表无表权限，执行前检查经只读 SECURITY DEFINER 函数完成，守卫与其余 v1 主体函数一致。治理锁 `artifactPhysicalExecution.status` 改为 `PER_CALL_SUBJECT_BINDING`。依据：G3 规格（2026-09-24，用户批准）§4.1、§5.1。本条不含失败语义（5.2）与发现阶段改造（5.3），产品链路尚未有调用方传入主体。

## 2026-09-22 · Native Temporal loopback ingress and customer namespace provisioning

- 原生 Linux dockerd 不为只接 `internal` 网络的容器映射宿主端口，`temporal-platform` 的 `127.0.0.1:17233` 在任何 Linux 宿主上都从未生效（Docker Desktop 用自带端口转发掩盖了它），`network_mode: host` 的 Backend 因此连不到原生 Temporal。改为：Temporal 不发布端口、仍只接 internal 网络；新增 `temporal-platform-ingress`（官方 HAProxy 3.4 LTS，按 digest 钉住，uid 99、只读、无能力、无密钥），只把 `127.0.0.1` 转发为纯 TCP 到 `temporal-platform:7233`，TLS 与 JWT 授权仍端到端。relay 另接一个关闭 masquerade 与 ICC、无 IPv6 的网桥，能发布端口但不能出网。
- 保留准入拒绝 Temporal 自身的任何宿主端口，钉住 relay 的镜像、入口、用户、挂载、网络、loopback 端口与网桥选项；relay 配置并入原生源码摘要，启用需要从包含本改动的提交重新发布原生镜像。
- 共享 provision 现在同时创建 `default`（`roles.json` 授予 customer worker/client 的命名空间）：7 天保留、不带任何归属标记，漂移报 `TEMPORAL_CUSTOMER_NAMESPACE_DRIFT` 且不自动修复；已按 `--retention 7d` 手工创建的宿主不受影响。disposable harness 用产品 relay 配置证明宿主网络路径，machine-worker 探针不再自建 `default`（这正是缺口此前未被发现的原因）。原生 dockerd 真实运行见[记录](../evidence/temporal-platform-loopback-ingress-20260922.md)；不是 RuntimeEvidence 或保留部署。

## 2026-09-21 · Dev-dependency alert refresh

- vitest / @vitest/coverage-v8 升至 4.1.11；baseline-browser-mapping 经传递升级至 2.11.25；Prism 模拟服务链上 `postman-collection` 固定依赖的 lodash、uuid 以精确范围 override 升至 4.18.1 / 11.1.1（上游最新版仍固定旧版本）。升级后本地启动模拟服务，`/api/v1/health` 返回 200。
- `@faker-js/faker` 5.5.3 保留：仅 `@global/contracts` 的 Prism 开发依赖使用，上游精确固定且 10.x API 不兼容；模拟服务只渲染本仓 OpenAPI 示例，`helpers.fake` 模板注入不可达。Go OTel 三项低危告警随 Temporal 服务镜像另行处理。
- 生产审计仍为零 advisory；漏洞基线重新绑定到新锁文件（旧绑定 `BASELINE_SOURCE_LOCK_MISMATCH`，新绑定 `FRESH`，见[回执](../evidence/security/20260921-dev-dependency-alert-refresh.json)），`valid_until` 2026-10-03 未延长。Copy fixed-source 回执只重签指纹。
## 2026-09-21 · PR decision card retired; standing merge authorization

- 移除 `nontechnical decision card freshness` 必需检查及其 `pull_request_target` 工作流、`pr-decision-card-status/v4` 解析器与测试；PR 模板改为四行不经机器解析的「给产品负责人的说明」。原因：卡片按其自身合同只是未验证声明、授权字段恒为 `NOT_AUTHORIZED`，检查不能验证真实性也不承载授权，却让每次推送都失效（两天 123 次运行、40 次失败、42 次取消）。历史合同见 Git provenance 与[真实验证记录](../ai-development/decision-card-live-validation.md)。
- 产品负责人以 `DEC-AIDEV-004` 授予常规 PR 常设合并授权：开发代理独立审查通过、必需检查全绿、线程清零且基于最新 main 后可合并；ruleset/设置/权限、部署发布与付费调用不在其内。`required-contexts.json` 中 ≥1 批准 + CODEOWNERS 的远期目标保持不变。
- Copy fixed-source 回执只因 `package.json` 删去一条脚本而重签指纹；漂移集合与 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` 不变。
- #549 合入后经产品负责人授权修改 `protect-main`：移除决策卡 required check（余 5 项），并关闭 strict，以免每次合并后其余 PR 串行重跑；替代保护见 [CI 合并自动化](../backend/ci-merge-automation.md#2026-09-21-ruleset-变更产品负责人授权)。

## 2026-09-20 · Dependency queue and source-status closeout

- 按批准顺序接入 Redocly2.53.2（#539）、Langfuse5.11.1（#540）、配对S3 3.1134.0（#541）与AI SDK补丁（#543）。工具链更新与本次状态修订组成最后候选；最终 head、hosted checks、独立审查与 merge 分别从原#533的successor记录回读，不预设本文自身未来SHA。完整来源与验证边界见[本轮证据](../evidence/dependency-queue-closeout-20260920.md)。
- 保留 Copy 固定 binding 和 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`，只重算实际源码的派生指纹；保留无关平台 metadata，工具链候选恢复10项共享解析降级。真实MinIO、本地SDK/loopback与现有测试不升级为retained runtime、Release、UAT或Pilot/GA。
- 修正状态页中#407仍开放、#451仍待办以及把2026-09-12运行观察当作当前事实的旧文字；原文Git provenance、历史evidence和产品完整C1–C5/QGO、Site验收、Billing延期边界保留。#494/#495实际分别MERGED，随后#497收口；不把实际历史改写成最初计划的superseded路线。
- 216个历史worktree候选的commit/tree完成独立恢复回读，ignored材料、owner release与精确删除授权仍独立处理；没有据此删除未知分支或现场。根main只经受控governor跟随，实际同步与全量处置结果由批末回执确立。
- 生产审计零advisories不等于baseline freshness。迁移任务的#542合入并发布后明确释放依赖窗口；本工具链候选重新采集精确生产审计，实际旧绑定HOLD、新绑定FRESH，保留原政策/到期时间/verifier及全部历史回执。其他owner的R4、身份admission与Program C按各自已交付层级记录，未声明全产品闭环。

## 2026-09-12 · GrowthOS managed release restoration

- 只读发现current选择器仍指向20260823 demo及local标签；恢复已发布541bcc63基线的三项exact镜像，并把选择器改到managed release，不重建源码、不接空卷。恢复前用实际Flyway12.8.1校验代码逐项比对27个迁移checksum，全部匹配；fresh备份可读且0600，基础设施镜像及既有凭据保持。
- 三项产品容器healthy，JWKS三端点200且public-only；Tenant/Platform首页200，3002/3003/18081只绑定loopback。MySQL改用已发布release中正确权限的配置，旧world-writable警告消失；27/27迁移无变化。
- Backend的identity/Budget/Execution JWKS、workspace budget和quote authentication恢复ok；aggregate仍503，阻断推进至平台Temporal proof和matching Worker。没有把历史基线恢复冒充最新GrowthOS候选、serviceJWT/producer/consumer、UAT或Pilot完成。精确来源、备份/校验摘要及镜像见[恢复记录](../evidence/growthos-managed-runtime-restoration-20260912.md)。

## 2026-09-12 · Browser proc-exit race successor and exact-image adoption

- #517 在同步 #498 后以 exact head `0a7d2259466c144291f1e6abede51360c02eb1ac` 完成 required CI 和独立 delta review，合入为 `b6be49020b28dccf2f67413667c396a893b9ce94`。修复将 Linux proc stat 的 ESRCH 识别为该 PID 已消失，仍扫描其他成员并保留 EACCES/EIO/活进程组的阻断。先前 headless/timeout 变更及重启后的短暂成功并未消除该竞态。
- 从该 exact main 发布 `ghcr.io/mlhjyx/global-backend@sha256:175ae53c6500456f1121d006fd4add694231d15e20d26fbd77ef795d3f9f90d5`，先完成发布来源校验、服务器预拉取和离线 verifier，再于13:28 UTC采用。API、Worker、Relay回读匹配同一source/image/artifact/migration；没有queued/running BuildRun，没有手工业务数据更新、迁移或凭据改动。
- [持续运行观察](../evidence/browser-readiness-runtime-adoption-20260912.md) 已完成30分钟60次采样，observer exit0且PASS；browser持续`ok`不升级为整体ready。GrowthOS旧demo运行导致identity/Budget/Execution JWKS不可用，平台当前首先停在QUOTE_UNAVAILABLE，Worker仍STARTING。历史观察保留，不重写成新版本通过。
- GrowthOS0101/0102的codec与独立签名/JWKS完成本地patch重放和35项相关测试；实际Java签名与Backend互操作通过，Backend本地`a56665123572b9471dff2761fb87cb3eb6472c9a`增加持久golden vectors及111项capability回归，精确绑定见[本地验签记录](../evidence/platform-capability-java-local-20260912.md)。未把这些源码结果外推为service JWT交付、真实producer/consumer、hosted跨仓CI或UAT。

## 2026-09-12 · Browser readiness headless environment successor

- PR #513 `fix(runtime): pass headless mode to browser readiness probe` 已通过完整 hosted CI 并合入，merge commit 为 `479d51f0dd474df31f0547923cc072064b897a03`。修复在受控浏览器子进程环境中显式传递 `CHROME_HEADLESS=1`，保留批准的 Chromium executable、隔离临时目录、网络禁用参数和 fail-closed 错误语义；聚焦 runtime 测试 58/58 通过。
- 从该 exact main 发布并验证新的 immutable OCI：`ghcr.io/mlhjyx/global-backend@sha256:137f881da04ac2d22258dd909c674798613335745226d22dd2cc9a03c965a783`，artifact `sha256:fe8e6fb41438012b502a791b7b3a9eda32bb4af078a5593dbf2e1c20fd5d6070`，manifest `sha256:0111e7a4016fa052788abd1604d9d0365202b3c554279cb5b0df791e61b2389f`，SBOM `sha256:5fe6a6215565126612b2476fcfe27c77618a9fb1f768d213529dc85fa3d882ff`，并完成 registry provenance attestation。
- API 与 Worker 已通过受控 drain-and-swap 运行该同一 digest，`/health/build` 返回 attested、image/artifact/migration identity 一致；Chromium browser readiness 现为 `ok`。`/health/ready` 仍为 503，原因仍是 `PLATFORM_AUTOMATION_ACQ_SWEEP_TEMPORAL_PROOF_UNAVAILABLE` 与 `MATCHING_WORKER_NOT_READY`，不把浏览器修复外推为平台或产品就绪。
- 首次运行中 readback 曾捕获一次 browser probe 清理失败并按 singleton 语义保持 fail-closed；未修改数据或绕过门，执行同 digest 的受控 API/Worker 重启后 browser 恢复，连续 5 次 `/health/ready` readback 均为 browser=`ok`，残留 probe 目录已清理。该事实说明当前恢复依赖受控重启，不能宣称已有自动自愈或 RuntimeEvidence。
- 当前未执行真实付费模型调用；客户 Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`，`cap_microusd` 仍只是平台内部执行安全包络。旧 PR #479 已关闭为 provenance，干净重放候选 #515 的 GrowthOS capability producer、capability JWKS/service token、真实 Temporal reader、revocation delivery 和跨仓 hosted contract 仍保持 HOLD。


## 2026-09-06 · GitHub queue currentness closeout

- 22:09 +08:00 只读复核 root/remote main `17b637d7e2a333cc4c76f04c7798b42f74f2fb37` 及该提交成功的 build/contracts/security/governance/CodeQL/advisory checks；#455 平台 Temporal 基础设施、#456 执行规则与 #457 决策卡修复均已合入，不再列为待合入候选。
- GrowthOS 本地 authority 已前进到 clean `51d7420373e31ba5c2a696513d8d6b5e77ed3fe0`；其当前接纳仍需独立证据。API/Worker metadata 仍为 `674ff12d…` / `sha256:b70175a0…`，6 条 RuntimeEvidence 全部 historical；本次没有重新验证 readiness 或用户旅程。
- 承接既有 #451 文档修订，保留原历史条目和冻结证据。GitHub 队列收口授权不扩大为部署、保留迁移、Provider/模型/付费或 Pilot 授权。

## 2026-09-06 · Global source merge readback and currentness correction

- #452 Browser 默认生命周期接线、#453 ACK 状态回读、#454 DeletionCompleted v1 兼容修复依次合入，最终 merge 为 `63b4af94b662d7e2b6a40823a1872daf0fc9b993`。三项 PR 必需 CI 与该主线 CI 全部成功；最终源码树匹配本地组合，134 项相关测试、4 项一次性 PG/RLS、构建与 OpenAPI 一致性通过。
- 后续另一任务合入 #457，主线前进到 `8eefba1cff15f2bbe4154451cac958a072803ab5`。2026-09-06 21:17 +08:00 回读时，其安全、治理、依赖、CodeQL 成功，CI 仍在运行；不能挪用前一提交的全绿描述。
- 同次 Docker metadata 显示 API/Worker 仍运行旧 `674ff12d…`/image `b70175a…`，不是新修复的运行验收。治理报告 0 current / 6 historical RuntimeEvidence；没有新部署、保留数据迁移、缓存清理、Provider/模型调用或 UAT。
- Program C 同文件 C1 合同在独立工作区提交 `4b116f10…`，三项剩余 wire/privacy/digest finding 已复审关闭；这是本地文档，不是 main 中的 C1 实现。GrowthOS 当前 writer 仍须完成明确文件交接。
- 此次文档候选撤销针对旧日期/SHA/临时状态的硬编码文字断言，保留稳定 ownership、历史计划合同及真实机器 RuntimeEvidence/Release/权限/晋级测试；architecture 与 evidence 索引改为引用唯一 current 页面，不复制动态计数。旧观察和原始 evidence 不改写。

## 2026-09-04 · Global dynamic currentness successor

- 18:58 +08:00 source/worktree 与 18:32 runtime readback 固定 repository source `0679a0bc510a980f65ebd33eb88b3215a97c20ba` 和 development runtime source `674ff12d4d768ce5599fc07b565fe21da37dc5fe` 为分离身份；后者落后 main 4 commits。服务/探针健康不等于 current main 已部署，3001 与 legacy 8080 wildcard 风险仍开放。
- 全局 G5 拆为 `G5-Site=AMBER / TIME_LIMITED` 与 `G5-Acquisition=RED / NOT_READY`：6 条 RuntimeEvidence 中 current 2 / historical 4，current 2 仅属 Site 且到期 `2026-09-05T03:49:25.000Z`；Acquisition evidence 为空，platform readiness 报 `PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING`。
- Program B accepted source slices #427/#431/#432 已不可变进入 main，必须与 active Task0L 分开；后者 authoritative implementation review 仍为 `C3 / H3` 且 coverage <80%。Program C durable consumer/Opportunity/commit-before-ACK 尚未实现。current-main Supply Chain Canary run `33855198691` 因 advisory baseline stale 失败，不能称 main CI 全绿。
- 本 successor 只更新 currentness 合同和导航；不改写 RuntimeEvidence/Release Bundle，不执行 push、PR、merge、retained migration、部署、listener 调整、provider/model dispatch、UAT 或 Pilot。

## 2026-09-04 · Platform writer terminal reconciliation and fresh zero-model evidence

- 追加 platform-writer development successor evidence。fresh deterministic smoke 在同一 exact runtime 上完成且 model calls 为 0；历史 Spend 保持 `UNKNOWN/unknown`、reservation/conservative charge 均为 `800000`。
- request-bound reconciliation attempts 1–5 为 `UNRESOLVED`，attempt 6 已 `EXPIRED`；该终态不产生 durable output、ACK、精确费用、redispatch 或第二次物理调用，也不构成 generative success、UAT、Pilot 或 GA。Platform acquisition authority 仍 missing，customer Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`。

## 2026-09-02 · Platform writer API composition and exact-runtime successor

- PR #443 修复 API Nest composition 漏装配：专用 `execution_budget_platform_writer` client 只来自唯一 deployment env，缺失/空白保持 fail-closed，owner/app URL 行为级负例禁止 fallback；API/Worker 复用同一工厂，API lifecycle 负责断连。完整 CI、CodeQL、安全与独立 review 通过。
- exact main `674ff12d…` 发布为 `sha256:b70175a0…`，GitHub environment approval、registry attestation、非 root/entrypoint 与离线 image verifier 通过；API/Worker/Relay drain-and-swap 后共同绑定 artifact `sha256:f34128f5…`，127 migrations、READY、restart 0、mixed digest 0。
- Platform capability 从 `WRITER_UNAVAILABLE` 变为 `PLATFORM_ACQUISITION_MISSING`，证明专用 writer/principal 可用但外部 Control Plane 仍未摄入 `platform.acquisition`、`platform.intent_watch`、`platform.sanctions`。没有 seed 假 authority；该缺口不阻塞 Site Builder workspace Grant。
- 新 digest 上以 `DETERMINISTIC_ONLY=1` 运行 GrowthOS Session→Access Token→Technical Quote→Budget Grant→Intake→READY Release，BuildRun `034e4175…` 成功且模型调用为 0。历史 UNKNOWN Spend 在三次只读 reconciliation 后仍无 Gateway consume log；完整 reservation 与不重发语义保持。
- 新增追加式 successor RuntimeEvidence、readback 与 development CANDIDATE；旧 evidence 不改写，Pilot/GA、成功 generative output、公开发布和客户 Billing/Credits 均未因此成立。

## 2026-09-02 · Production Parity development capability cutover and UNKNOWN settlement correction

- GrowthOS authority `541bcc63…` 的三个独立 RS256 signing domains、短期 Backend Access Token、零费用 Technical Budget Quote 与自动 Site Build Budget Grant 已装配到 Tenant Web；客户没有余额、充值、模型次数或固定金额门，technical cap 只作为平台执行安全包络。商业 Billing/Credits 继续 `DEFERRED / NOT_IMPLEMENTED`。
- Backend PR #440/#441 合入后发布并部署 `main@da2f7aeb…` 的 exact OCI `sha256:66e2dbf8…`。API、Worker、Outbox Relay 三个 fresh lease 共用同一 image/artifact/migration；127 migrations、readiness、GrowthOS 三个 JWKS 与无 mixed queue digest 均已读回。
- 同路径确定性 Intake BuildRun `84aa659f…` 成功并产生 READY Release。获授权的一次真实模型 refurbish BuildRun `81dcfe5a…` 没有 durable output/ACK；修复后的持久事实为 `UNKNOWN/unknown`、完整 reservation 保守扣减、paid-call kill switch 关闭，request-bound reconciliation attempt 1 为 `UNRESOLVED/log_unavailable`。只有一次物理模型调用，没有自动重发。
- 新增 development RuntimeEvidence、脱敏 readback 与 `CANDIDATE` Release Bundle；它们明确不授权 Pilot/GA，不证明模型质量或公开发布。`platform_budget_authority` writer 仍不可用，但 Site Builder 使用的 workspace budget authority ready。

## 2026-09-01 · MinIO PERSONAL_DATA exact-version cleanup policy correction

- Production Parity retained-development bootstrap 首次真实 provision dedicated artifact bucket 时，bucket、versioning、SSE-S3、lifecycle、runtime policy 和 personal-read policy 均成功，但 MinIO 对 cleanup policy 返回：`s3:ExistingObjectTag/artifact-privacy` 不支持 `s3:DeleteObjectVersion`。bootstrap 按设计失败关闭，没有创建 cleanup user，也没有启动 Backend runtime。
- 根因是 S3 授权模型本身不允许基于 existing-object tag 授权 DELETE，而不是 development/production 配置差异。修复保持一个产品路径：final key 由受控 privacy class + digest 派生到三个互斥物理 prefix；runtime 的 Put/PutTag 权限逐 prefix 绑定唯一 privacy tag，cleanup IAM 只允许 `final/personal-data/*` 的 exact-version read/tag/delete，无 list/write/tag mutation/bucket管理。adapter 在同一 exact `VersionId` 上读取 tag，并只在 tag set 唯一等于 `artifact-privacy=PERSONAL_DATA` 时删除。缺 tag、非个人 tag、歧义 tag、版本不一致或读取失败均在 delete 前关闭；模糊 404 只有在 bucket location 仍可读时才作为 ABSENT，NoSuchBucket/endpoint 404 保持重试失败。
- 新增 forward-only `20260901060000_generic_operation_artifact_privacy_prefix`：任一 object/manifest/pending cleanup 非空即要求显式迁移；空库才把 object 主键扩成 `(sha256, privacy_class)`，并替换两张表 CHECK、manifest assertion、append/cleanup object lookup。一次性 PostgreSQL 从零应用 125 migrations；同一 digest 的三种 privacy object 可并存，新 prefix 通过、旧 prefix 拒绝、函数 readback 更新。S3 bootstrap 在首个 provision mutation 前独立执行 version-aware predecessor-prefix scan；root bucket inventory 或 version listing 任一失败均稳定 `STORAGE_PREFLIGHT_UNAVAILABLE` 且零 mutation，真实 MinIO 非零 version 拒绝、清零后接受，覆盖“DB 空但 promote 后 orphan version 存在”的失败窗。
- RED 覆盖证明旧 adapter 会跳过 tag gate；GREEN 后 artifact+budget focused 336 PASS / 9 conditional skip、deployment contract 9/9、API build 和完整 API 429 files / 6,396 tests PASS（4 files / 42 tests conditional skip）。修复版 bootstrap 在同一 retained MinIO 上完成三类最小权限 user/policy attach并返回 `OBJECT_STORAGE_PROVISIONED`；真实 cleanup-principal spec 3/3 证明 personal exact-version 删除、confidential direct-delete deny、cross-prefix/tag 写拒绝、无 list/tag mutation、旧版本删除不产生新 marker 与 missing-bucket fail closed。测试在任何 client/stage/promote 前进入外层 `try/finally`，按阶段登记 staging/final key 与 exact VersionId；从全 bucket 0 开始并在 finally version-aware 清除 final/staging versions 与 delete markers，结束仍为 0。这仍不等于 Backend API/Worker readiness、真实 BuildRun 或 Pilot/GA；必须发布新的 exact-main OCI，当前中间镜像不得部署。

## 2026-08-24 · Production Parity PERSONAL_DATA cleanup runtime readback

- [PR #413](https://github.com/mlhjyx/global-backend/pull/413) 在 required CI、Supply Chain、CodeQL 与全部 inline review thread 收口后，以普通 merge commit `866ede78` 合入 main；未使用 admin bypass。main freshness 以 `BASELINE_SOURCE_LOCK_MISMATCH` HOLD，证明旧 36-advisory baseline 不能描述新 lock。后继 baseline refresh 从 exact main 重建 10 条 advisory / 10 条 canonical exposure，并逐项继承剩余 Site Renderer/Astro 的 owner、due date 与 validity；不把已解决项保留为例外，也不延后剩余债务。

- 生产依赖安全收口提交 `7a7bea11` 完成 NestJS 10→11 / Express 4→5 与 `fast-xml-parser` 4→5 的协调迁移；未通过 override 强压不兼容主版本。新增 loopback HTTP 测试捕获并修复 Express 5 wildcard 参数从字符串变为数组的真实语义变化，同时保留 nested query 的 extended parser 合同。API 385 files / 5755 tests PASS（3/39 skipped），本地受信 base→candidate graph-delta 为 `COMPARABLE_AUDIT_PASS`，36 条 production advisory 降至 10 条、26 条 resolved，全部逾期 NestJS/Express/XML 公告消失。该记录不替代 PR #413 Hosted CI、合并或部署 readback；Copy fixed-source 继续为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。

- `codex/production-parity` 的 exact clean HEAD `50c23d8de738ba7bdac9b9b2ff85630bab8473a1` 收口了 PERSONAL_DATA artifact cleanup 的物理 runtime wiring：内部 exact S3 VersionId、tombstone/audit commit fence、shared-digest advisory fence、durable cleanup command、Outbox→Temporal retry/backoff 与独立 cleanup principal。ToolBroker 的 `GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD` 仍保持，未新增 producer 旁路。
- 用户授权的 disposable PostgreSQL 16 验证使用本机已有 `pgvector/pgvector:pg16`、内部临时网络与 tmpfs 数据目录；全新数据库应用 98 个迁移，真实 `app_user` 通过受控函数完成 inspect/enqueue/claim/complete/replay，验证 exact VersionId、FORCE RLS、直表权限拒绝、跨 workspace deny 与 shared subject binding fence。临时容器和网络已清理；该记录不触碰 retained `global-postgres`。
- 运行验证先后捕获并修复两个迁移缺陷：PL/pgSQL `audit` 局部变量与 SQL alias 歧义、PostgreSQL 不支持 `{1,1024}` 重复上限。修复提交为 `da7b92c0`、`bb5a9d03`，并新增 migration regression tests；cleanup activity 的异常 cause 保留修复为 `50c23d8d`。
- 最新 source checks：API 384 files / 5752 tests（3/39 skipped）、API build PASS、lint 0 errors/16 既有 warnings、governance 118/118、`docs:verify` 0 errors/1 既有 table warning、ContractGraph 10917 nodes / 25049 edges / 0 errors。MinIO/S3 policy attach 与 exact-version delete、Temporal/Worker/Relay 目标环境 admission、OCI 发布/部署、主线合并、RuntimeEvidence 与真实模型调用仍为 UNKNOWN/未执行。
- 后续门修复：`f41c12a5` 恢复 sanctions workflow 的 destructured activity graph binding，并让 Temporal 测试 proxy 在 reset 时保留 memoized spies；`65eabae9` 修正文档注释。`fb5e2e21` 将 OCI Dockerfile 与 SBOM/manifest contract pin 从已撤出的 Chromium `151.0.7922.137-1~deb12u1` 更新到当前可得的锁定版本 `151.0.7922.173-1~deb12u1`。新 PR CI 的 governance/contracts/renderer/gitleaks/CodeQL canary 结果已回读，production advisory delta 仍因既有 overdue advisories fail；OCI 完整 readback尚在运行。
- CodeQL 安全收口提交 `a648706a`：Helmet 恢复 CSP；catalog 与 image pipeline/child 使用 `O_NOFOLLOW` 句柄并校验 dev/ino/size；managed image child path 改为生产相邻制品、测试显式 DI；slug 去除交替锚定正则；opaque provider token 保留 v2 SHA-256 fingerprint 合同并添加有理由的 CodeQL 语义抑制。该提交的本地 API 384/5752 与 focused 39/39 通过，新的 CodeQL/CI readback 尚待推送。
- `05b8b73d` 补齐 child/runner 输入输出文件句柄的 before/opened/after `dev/ino/size` 复读校验，并把 slug suffix 改为 rejection sampling、前缀清理改为线性字符扫描。该提交尚未完成新的 CodeQL/CI readback；此前 `ac9a3143` 的 CodeQL 仍报告 6 个 high，不能用本地测试替代远端安全门。
- `41843111` 将 catalog、child input、runner output 的读取顺序进一步改为先 `open(O_NOFOLLOW)` 再句柄校验/读取，消除 CodeQL 的 check-before-open 模式；保留 opaque token v2 SHA-256 fingerprint 合同和有理由的 in-source suppression。新 CodeQL readback尚待该提交推送。
- `ae2d9a0e` 将已退出产品 composition 的 legacy attestation verifier credential check 改为 work-factor PBKDF2；正常产品 Budget Grant/模型路径不读取该 verifier。新一轮 CodeQL 尚待推送 readback，旧 `161bdd68` CodeQL 仍只剩该 legacy weak-hash alert。
- `40c13f1c` 删除产品源码中的 fast credential fingerprint helper，legacy verifier 继续使用 PBKDF2，测试改用固定脱敏 digest。目标是让 CodeQL 只看到 work-factor legacy sink；新一轮远端安全 readback尚待执行。

## 2026-08-22 · 通用操作 Artifact 耐久重放 Task 8 记录（pre-cutover / no runtime claim）

- 新增 [通用操作 Artifact 耐久重放实现记录](../implementation-records/generic-operation-artifact-replay.md)，固定 Task 1–7 在 `codex/production-parity` 的 `a06eb7f4f29d8b9dd0ed47f52a1d86d60a13379b` 审查基线：closed small reference、digest-derived immutable key、七个 additive artifact migrations、expected facts、`RESULT_UNKNOWN` recovery、bounded materializers，以及 deployment-owned MinIO lifecycle/IAM/readiness contract。
- 本次聚焦 artifact/ToolBroker suite 为 232 passed / 6 skipped（artifact statements 86.95%、branches 82.89%），schema validate、API build、governance（118/118）和 docs verifier 通过；ContractGraph clean scan/status 绑定 `a06eb7f4…`（10,407 nodes / 23,838 edges），但仅为 static impact，未评估 RuntimeEvidence。
- 在 `9aab31ff0239165ef373ed9eb17adf6c0e630b5e`，legacy ToolRegistry fixtures 已显式声明匹配当前合同的 `durableResultStrategy`，先前 `public-web-wire-suppression` 1 个与 `paid-execution-gates` 3 个 fixture mismatch 因而关闭。完整 API suite 现为 **349 files / 5,375 tests / 10 skipped / exit 0**；这只是本地 deterministic suite，不推导 MinIO、OCI、部署或 RuntimeEvidence。
- 当前 worktree 没有 fresh disposable PostgreSQL/MinIO receipt；为不写入其他 worktree 保留的 `global-postgres`/`global-minio`，real RLS 和 Task 7 six-scenario MinIO contract 继续为 `RESULT_UNKNOWN`，不伪造 PASS。
- 仍是 additive/pre-cutover：没有 Domain ACK/cutover、Authority admission/Control Plane transport、retained migration、OCI/deployment/readback、production RuntimeEvidence、Release Bundle、merge 或用户可用性声明。Copy receipt 保持 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`，不 rebaseline 或授权 dispatch。

## 2026-08-21 · Execution Budget Authority additive foundation

- Tasks 1–7 在 `c96b5d4f04ca8d93ad23b4b7b690e88bd2449f42` 后完成共享 Authority claim/JWKS verifier、Workspace Grant 同事务 consume+authorized-open、Platform signed command/schema/ingestion、FORCE RLS authority/revocation/account binding，以及独立 capability health snapshots；实现收口于 `bea4d7392344cd44cbfbc5379a7d620f418122fc`。现有产品 caller、API/Worker admission 与 legacy cap path 未切换，probe 只观察、不 admission。
- 外部 Control Plane signer/JWKS、Workspace producer、Platform inbound transport、部署 writer LOGIN/credential/connection 均为 `EXTERNAL_OWNED/PARTIAL`。本批次没有 retained migration、服务重启、真实 JWKS/provider/model/paid call、部署、RuntimeEvidence 或用户可用性声明；产品 cutover 仍须按独立计划与授权执行。
- Authority 新 export 令 active Copy v22 source bundle 多出 `packages/contracts/src/index.ts` 漂移。旧 binding/evidence 未改写；机器 successor 固定 11-path fingerprint `fadc301c5944d06e1a97dd77c022b3d5d6b79ce9fe52758329f22fa6e69984a9`，继续为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。partial/extra/predecessor path-set mutation 均拒绝，不 rebaseline Copy、不授权 dispatch。
- Fresh verification：Authority/Task 7 changed-scope coverage statements 88.30%、branches 87.71%；API 327 files / 4,836 tests；disposable PostgreSQL 16.14 从空库完成 84 migrations 与 RLS/ACL/concurrency 20/20，容器和匿名卷均销毁；Governance 115/115；ContractGraph 0 errors。完整 provenance、命令、外部交接与 deferred minors 见[实施记录](../implementation-records/execution-budget-authority-contract.md)。
- Fix Round 1 更正 coverage denominator：完整 include 为 `execution-budget/**/*.ts`、managed dependency readiness、runtime readiness、health controller/schema、Site Build request guard 与 `budget-store.ts`，并执行原十个 specs 加 `budget-store.spec.ts`；11 files / 252 tests PASS，statements 88.76% (632/712)、branches 88.21% (479/543)、functions 88.10% (163/185)、lines 91.19% (611/670)。同时把 [Copy fixed-source CURRENT 治理页](../implementation-records/copy-fixed-source-impact-governance.md)更新到 active v22、多 narrow exact scopes 和当前 Authority 11-path `STALE_HOLD / NOT_AUTHORIZED / BLOCKED` 机器真值；successor 不等于 CURRENT、rebaseline 或 dispatch 授权。
- Final-review fix wave 以 `0ba38497…` RED / `98a7d600…` GREEN 收口 6 个 Important：authority-bound 账户使用 `cap_cents=0` 且 legacy cents lifecycle 全面 fence；Platform ingest/open/revoke 在 repository readback 外由同一 PostgreSQL helper 重做 exact LOGIN/group attestation；新增窄 append-only revoke 与共享 campaign/60 秒 freshness 计算；DB 强制 schedule subject equality；verified time 改为 immutable NumericDate seconds。writer-only microusd reserve/settle/status/close、外部 transport、产品/API/Worker cutover 仍为 blocker，不宣称完整 Platform lifecycle。验证为 focused 225/225、coverage 12 files / 283 tests（statements 89.63%、branches 87.79%）、Full API 327 files / 4,865 tests、fresh PG16 28/28、84 migrations up-to-date、pre-Task3 upgrade 与 fresh schema 无差异；无 retained migration、真实 JWKS/provider/model/paid call、部署或 runtime claim。Copy bound paths 未新增，existing 11-path successor 继续 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`。
- Correction gate 在 `51f61391…` → `c29e5742…` 修复剩余整秒 NumericDate 边界和 readiness 后台 rejection containment：SQL 只把比较时钟归整到秒，verifier/ingest/open/freshness 对 `-61/-60/0/+60/+61` 使用同一容差矩阵；Platform freshness 显式处理 `invalid` 并生成固定 purpose-derived code；bootstrap/interval refresh 以有界 catch 保留 fail-closed snapshot。独立 scoped review PASS。全新一次性 PG16 的完整 Authority RLS/ACL/concurrency 为 29/29、84 migrations up-to-date；fresh deploy 与 old-migrations-plus-Authority upgrade schema diff 为 `No difference detected.`。Copy readback 无指纹变化，仍为 `STALE_HOLD / NOT_AUTHORIZED / BLOCKED`；没有 retained migration、RuntimeEvidence、真实 JWKS/provider/model/paid call、部署、重启或 product cutover。

## 2026-08-10 · 获客 Suppression/DataRights source 治理

- #375 已以 merge commit `5b588353fba6cdbda3a7e0f5f171a3e2fabbc786` 合入 roles→scopes，并在该 main commit 上通过 CI、Governance、Security、Supply Chain 与 CodeQL push canary；Supply Chain 仍是带 36 项生产依赖遗留风险的 ratchet pass，不是漏洞清零。
- 当前独立变更集取消 suppression 裸 DELETE：`suppression_record` 保留事实、未知原因 fail-closed 为 LEGAL、只允许 PREFERENCE→LEGAL；类型化 canonicalizer 拒绝无效禁联值，并在新写入、旧值读取、发现匹配、即时公司分块更新和所有动作门共享规范键，避免“201 成功但永不命中”。fit/enrich/signal/watch/contact/guess 六个自动 backlog 阶段每家出网前直接复核原始 suppression；长网络后的联系人/猜测写入、邮箱验证回写、Lead accept 和 suppression 创建共享 workspace 事务 advisory lock 并在提交前复读。被禁邮箱联系人从 `LeadQualifiedPackage` 排除，过滤后零可达则 accept fail-closed。释放和身份纠正的 `suppression_decision` 分别保留 requested command 与 outcome，同 requestId 的不同原始 reason 返回幂等冲突；DB 固定合法语义组合，普通 API 不执行真实 release。OpenAPI 现显式列出 400/404/409 统一错误 envelope 与 UUID path；审计/PII 列表使用 cursor page envelope 且每页最多 100。
- DataRights DENY 从“throw 导致日志回滚”改为先在租户事务提交 `policy_decision_log`、再在事务外返回 409；在 DENY 前不执行 Lead CAS、不建 LeadDecision、不发 LeadQualified。隔离无卷 PostgreSQL 空库完成全部 82 migrations，并验证 app_user 禁止删除 suppression、禁止更新/删除 decision、禁止 LEGAL 降级与跨 workspace 关联；测试容器已删除。该证据只属于 source/migration 验证，不代表已部署或真实 pilot。

## 2026-08-10 · Copy fixed-source 影响治理

- 新增 [Copy source eligibility receipt](../evidence/site-builder/copy-runtime-eligibility.json) 和 required-build verifier。活跃 v15 binding 的路径、文件 SHA、artifact ID、82-file bundle digest、当前 source fingerprint 与 drift paths 都必须精确匹配。
- 只有零漂移可执行 v15 双 fixed-source rebuild。与 Copy 无关的 Prisma schema 漂移必须显式降级为 `STALE_HOLD`，且 verifier/runner/model runtime/lockfile 等其他路径不允许进入例外；receipt 永远不能授权 dispatch 或 pilot。
- 该治理避免未授权的 Site Builder 评测冻结获客数据库演进；CI impact verifier 以描述符锚定、同句柄稳定读取和总量上限证明当前 source 状态。历史 dispatch verifier 的中间目录/并发读取与 ledger/claim 前置时序仍是明确 NO-GO，必须随下一次 Copy fixed-source rebase 关闭，不能由本 receipt 冒充已解决。完整设计见[实施记录](../implementation-records/copy-fixed-source-impact-governance.md)。

## 2026-08-09 · Copy Sonnet recovery v14 create-only preparation

- #356 与 #359 已以 merge commit 进入 `origin/main@2557b991e62ff171aeec60abff33de2ad8f2859f`。v14 [manifest](../evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v14.json) 以该主线为 fixed source；[runtime binding](../evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v14.json) 固定 canonical path 与后续身份绑定提交 `3da93486163404e3943711c6689a55c9a9e2c119`、82-file source digest `cbec88ad…`、53-file compiled tree `ce806d78…` 与 artifact digest `4f9fdf06…`。
- admission 现在要求 campaign、global authorization、child authorization 与 reservation 全部使用各自的 v14 namespace；即使重算 manifest/global/child/reservation digest，v11/v12/v13 身份仍会在 ledger/client 前拒绝。同代 v14 的重复消费继续由 durable ledger/marker 阻止。
- recovery execution 与 child slot 均版本化为 v14；runner 的 Git-reviewed evidence acceptance 复用 recovery-aware execution plan，不再把合法 v14 receipt 误当成旧 pilot ID。fake gateway 覆盖 1 wire known settlement、完成、PR-merge acceptance，全程零真实模型调用。
- v13 后续私有 operator run 以 2 known-settlement wires、1 repair、0 completion 停止并冻结；它不是 tracked capability/质量 evidence。v14 明确禁止复用 Terra/Sol v11 及停止的 v12/v13 authorization、campaign 或 wire。
- v14 artifact 继续是 create-only、`NOT_AUTHORIZED`、`dispatchCapable=false`、0 network/model wire、0 cost；本批次不包含凭据、真实调用、36/72、晋级或 route adoption。

## 2026-08-09 · Copy Sonnet recovery v13 create-only preparation（#356）

- [实施/TDD 记录](../implementation-records/copy-sonnet-recovery-v13-create-only-tdd.md)、[v13 manifest](../evidence/site-builder/m1-g-copy-sonnet-recovery-manifest-v13.json) 与 [post-sync runtime binding](../evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v13.json) 固定 #355 后的唯一 Sonnet Messages/medium recovery：1 execution、最多 2 wires、最多 1 次 closed repair；Terra/Sol v11 成功 wire 及停止的 v12 wire/authorization 均不可复用。
- 主线同步后的 binding 固定 source commit `874a8cc2aa637c35f8c78302006ffb370913fcb7`、82-file source digest `139c8661…`、53-file compiled tree `a7ac0ca8…` 与 artifact digest `caa42cbf…`。它仍为 create-only、`NOT_AUTHORIZED`、`dispatchCapable=false`、0 network/model wire、0 cost；#356 后续已合并，真实私有 operator run 的 stopped 诊断由上方 v14 条目承接，不能回写该 artifact。
- 本交付不包含 capability evidence、36/72 质量矩阵、模型晋级或生产 route adoption；这些门继续独立决策。

## 2026-08-08 · Governance trust-boundary hardening

- `nontechnical decision card integrity` 取代会误导为 freshness/授权的 context 名。Draft 可非阻断展示 `CURRENT_UNVERIFIED`；非 Draft 中完整的 `PASS / RECOMMEND_MERGE / MERGE` 作者声明在没有可信外部 provenance 时必须阻断，用户授权仍固定为 `NOT_AUTHORIZED`。
- Release Bundle 新增显式 `external_provenance`。当前没有独立外部 readback verifier，所以 machine/reviewer/authorization/merge refs 都只是 documentary，任何 `PILOT/GA` 均以 `RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED` fail closed；伪造 `VERIFIED` 或 URL 另报 unsupported，不能晋级。
- 治理验证器扫描全部 GitHub workflow 的外部 `uses:`，只接受从官方 tag 只读解析的完整 commit SHA 与版本注释；CI、Security、Governance 和 Decision Card 四个 workflow 已全部 pin。CODEOWNERS 最终规则块覆盖政策、schema、verifier、runtime evidence 与 release 输入/输出，删除或后置覆盖会使 mutation test 失败。

## 2026-08-07 · Governance foundation、current 入口瘦身与证据晋级门

- `AGENTS.md` 只保留稳定 authority、产品边界、Ubuntu/Compose/Temporal 约束、worktree ownership、外部动作、TDD/安全、模型费用与 evidence/release 规则；`docs/status/current.md` 只保留远端主线 SHA、在途主题、blocker、最新 runtime fact 和下一产品决策。迁移前的完整日期化文字保留在 Git 对象 `35145699db63fc8aef2350a0ca331fef9724f617`，没有删除或重写原始实施 provenance。
- 新增机器 `provider-registry/v1`，逐项绑定代码 seed 的 key、SourceClass、默认 enablement、purpose、taxonomy、license、个人数据等级、调用门、测试与 evidence anchor，并生成单一人类页。研究型 `discovery-sources.md` 不再承担 provider 当前状态真值。
- 新增 `runtime-evidence/v1`、`delivery-traceability/v1` 与 `release-bundle/v1` schema、验证器、生成器和模板。到期 RuntimeEvidence 只能成为 historical；Capability→Object→operationId→code→test→Scenario 链若声明 `PILOT`/`GA`，必须同时有 fresh PASS evidence 与真实 Release Bundle。
- Release Bundle 将机器 check、独立 reviewer、产品负责人签署授权和真实 merge method provenance 分开，PR 正文声明不能升级任一门。当前 fresh RuntimeEvidence 和真实 Release Bundle 均为零，因此获客恢复链保持 `INTERNAL_ONLY / NOT_AUTHORIZED`。
- 仓库新增可执行的 governance required context 与 required-context 清单；OpenAPI 手写总数从权威架构页删除并加防回归检查。GitHub ruleset/branch protection 仍是外部配置，仓内声明本身不证明已生效。
- 历史模型与 Site Builder 证据统一由 [evidence 索引](../evidence/README.md)导航；索引不改变 artifact 的历史分类，也不复制模型评测或运行结论。

## 2026-07-22 · Site Builder DI-0 净室设计合同与静态 Catalog 基础（#164）

- `@global/contracts` 新增并导出 DesignSourceManifest、DesignObservation、DesignRule、DesignDNA、TemplateFamily/Blueprint、DesignBrief、DesignEvaluation 与 DesignCatalog；每个非可信对象都有运行时 fail-closed validator，目录与 Family 使用确定性 digest。
- 来源合同区分平台原创、许可归档、仅视觉研究与书面授权路径；授权、训练、保留、未来生效时间、外部贡献稳定身份和至少五个独立贡献组均在合同层拒绝违规输入。Tier B 视觉研究不得保存原始文案、素材、DOM、代码、精确坐标或进入训练/运行时 RAG。
- API 只提供递归冻结的空静态 Catalog 和 approved-family-only resolver；当前没有真实 Family、Blueprint、StylePreset、DemoVisualPack、SiteSpec 1.1 或 Renderer/assembly 消费。DesignEvaluation 只落合同，运行时生产仍归 M1-f。本交付不代表 M1-e、设计系统或生产部署完成。
- CI build/test、contracts drift/lint/breaking 与 gitleaks 全绿后合并；下一主线为 M1-e-A 26 型封闭组件与变体，实验模板只能按批准合同选择性提取。

## 2026-07-18 · MODEL-1 BrandProfile 首个逐任务晋级

- 真实 new-api 同形 6×2 评测固定 prompt/schema/evaluator 与协议：Terra/Responses、Sonnet/Messages 均 12/12 accepted、0 hard failure；当时 DeepSeek Pro/Chat 为 10/12。候选/基线报告与价格快照写入 evidence id `model1-brand-profile-20260718-v1`，故 owner 批准 Terra 主、Sonnet 回退。**2026-07-19 fast-follow 已 supersede 此 active evidence**：v20 final-code candidate 24/24、完整 legacy route baseline 12/12；旧 v1 只保留为历史裁决输入，不再作为当前 baseline 真值。
- 生产 provider 复用已验证的 model→transport 显式映射；BrandProfile `promotedRoute` 有 provider/schema/截断/超时回退及 EvidenceRef v2 任务硬门，失败 usage 不丢。`SITE_BUILDER_MODEL_ROLLBACK_BRAND_PROFILE=true` 可回冻结 DeepSeek Pro→GLM，原紧急 model/fallback override 优先级不变，route policy/trace 记录实际快照与来源。
- 仅 BrandProfile 代码路由晋级；其余 6 个文本 task、图片和视频均未继承。GPT Image 2 单次 `/images/generations` 真探不等于 MediaGateway、edit/mask 或生产消费者上线；本记录也不代表生产部署、真实租户 canary、locale/视觉覆盖或 R4-B-min 持久成本真值完成。

## 2026-07-17 · Site Builder R3-B2（局部 SiteSpec 消费与单调 Build 进度）

- `scope=page|section` 与 `options.pages` 现在冻结请求时的 active `baseVersionId` 并做确定性局部合并：只替换命中的 page/block 及其引用文案键，未选择页面、全站主题、assets 与其余 CopyBundle 保持不变；发布时以 active pointer CAS 防止覆盖并发人工编辑。新执行先渲染到 run-scoped staging，再移入不直接服务的 immutable 本地版本目录；数据库提交后以单次原子 symlink rename 切换 `.active/<slug>`，因此 CAS/事务失败不泄露候选且成功切换无目录缺口。Site 级 advisory lock 覆盖最终数据库复核与 pointer rename；旧 Activity retry 若发现更新 build 已接管，只丢弃自己的 pending link，不会回写旧预览。提交后进程崩溃由 Temporal Activity retry 根据 durable artifactKey 重建 pending pointer；生产对象存储 Release、跨节点恢复与回收仍归 R1-min。缺目标 404、重复目标/脏 active spec 422。`stylePreset` 属全站副作用，禁止与局部请求组合。非 `en` 仍 422，真实多语种 CopyBundle/Renderer 路径归 M1-d，不以英文复制冒充翻译。
- 新增 RLS/FORCE RLS 的 `SiteBuildStep` 一等真值表；Temporal patch 保护旧历史命令序列，新执行按 Activity/图片批次增量落 attempt/status/phase/progress。BuildRun phase/progress 只前进，旧 attempt 迟到不可覆盖，begin replay 不重写 `startedAt`，成功/失败/取消均终态化未完成步骤；`SiteBuildRun.steps` 继续作为有界公共读模型，`costSummary` 保持 null 归 R4-B-min。
- 验证：157 files / 1628 tests 全绿、API build、lint 0 error；独立空库 50 migrations；真 PostgreSQL `app_user`/FORCE RLS 验证跨租户不可见与 attempt fencing；隔离 Temporal namespace/worker 验证 page 局部构建、immutable version→active symlink 提升、KB Activity 中取消补偿，以及 renderer 忽略取消并迟到完成时的版本 fencing/产物清理；另以注入的持续 pointer rename 故障验证 durable publication base 的 Site/run/version 回滚，并以旧 finalize retry/更新 active version 的并发单测验证旧 pointer 不会复活。临时 namespace/数据库/预览均清理。仅代表 Ubuntu 开发环境，不代表生产部署。

## 2026-07-17 · Site Builder R3-B1（Build 请求合同、持久幂等与 Temporal ACK）

- **Breaking correction（需 PR 标签 `breaking-change-approved`）**：Build API 改用有界 SiteSpec 字符串标识符、严格 options 与共享 Renderer preset 目录；机器契约只声明当前真实执行的整站/stylePreset/en，并收紧 `Idempotency-Key`。此前会被静默忽略却返回 201 的 page/section/pages/非 en 请求，现分别 fail-closed 为 `422 BUILD_SCOPE_UNAVAILABLE/BUILD_OPTION_UNAVAILABLE`。消费者必须停止发送未实现字段/非法 key，并从本版 OpenAPI 重新生成客户端。
- `Idempotency-Key` 统一为 1–128 位安全字符，按 workspace+Build 操作持久 `requestHash`；siteId 进入请求指纹而非账本分区，同 key 换 Site/换参数均 409。跨 Site 同 key 并发先取 key 锁再取 site 锁，避免 P2002 泄漏或重复副作用。
- Temporal 使用确定性 workflowId、`REJECT_DUPLICATE + USE_EXISTING` 与 describe 恢复；只有 workflowId+firstExecutionRunId 双 ID 持久化后才返回 201。ACK 不明保留原 queued run，同 key 或无 key 的完全相同规范化请求都收敛同一执行链，不误标 failed、不另起 run；正式客户端仍必须带 key。
- 取消改为等待 Temporal 执行链关闭及不可取消补偿完成后才释放 DB active 单飞门；取消未确认/未关闭返回 `502 BUILD_CANCEL_UNAVAILABLE` 并保持 active，避免新旧 workflow 并行。取消与失败补偿分终态，旧 run 只有 CAS 赢得 active ownership 才可回写 Site 状态；若补偿因 DB 故障耗尽重试，后续同 buildId 取消会在确认执行链已关闭后以同站锁+CAS redrive 最小终态事务，不永久卡 active。
- Ubuntu 开发环境以真 PostgreSQL/app_user/FORCE RLS + 真 Temporal 验证双 ID 对账、同请求重放、异请求 409、跨 Site 同 key 并发恰一胜、取消与夹具清零；仅代表开发验证，不代表生产部署。R3-B2 继续真实 scope/options 与单调 step/progress/replay，costSummary 仍归 R4-B-min。

## 2026-07-17 · Site Builder R3-A（BuildRun 数据库背书）

- `site_build_run` 改以 `(site_id,workspace_id)` 复合外键绑定 Site，父 workspace 更新为 `NO ACTION`、禁止隐式搬迁 run；validated CHECK 固定 `queued/running/succeeded/failed/cancelled`，部分唯一索引保证每个 Site 最多一个 active run。
- 新增 nullable `temporal_workflow_id`；独立数据迁移只为已知 `demo_v0/refurbish` kind 生成确定性 workflow ID，未知 kind 保持 NULL，交由其 owner 显式处理。
- schema 迁移以 5 秒 lock timeout / 60 秒 statement timeout 取得表锁并 fail-closed 预检孤儿/跨 workspace provenance、非法状态和重复 active；不自动修归属、不改状态、不任选 run 取消。
- Ubuntu 开发环境验证：隔离空库 49 migrations 全量 deploy；三类脏旧库均阻止升级；`global_dev` 真 owner/app_user/FORCE RLS、双连接单飞、复合 FK/CHECK/父归属更新负例与 nullable ACK 前语义全绿，夹具已清理。仅为开发验证，不代表生产部署。
- 评审后 timeout 加固改变了尚未提交但已在开发库试跑的 060/061 字节；没有静默改 `_prisma_migrations` checksum，而是先做 0600 dump，再由最终 49 migrations 重建候选库、恢复除迁移账本外的数据。60 张业务表逐表 count+内容 hash 与旧库完全一致、49/49 checksum 与 schema diff 全绿后原子切换；旧库 `global_dev_pre_r3_checksum_20260717` 与 `/global/backups/global_dev_pre_r3_checksum_20260717.dump` 保留回退，不涉及生产。

## 2026-07-17 · Site Builder M1-c（纯 Sharp 确定性图片管线）

- API 直接 exact pin `sharp@0.35.0`，pipeline identity 同时包含 libvips；输入按 20 MiB/40 MP/4 channels/单页严格解码，自动方向与 sRGB，输出默认剥离 EXIF/GPS/XMP。模糊/曝光/噪点记录为版本化 warning，不以未校准阈值主观拒绝可解码图片。
- kind→role 与 explicit focal policy 版本化；只生成源裁切可承受的 320/640/960/1440/1920 档，绝不放大。每档 AVIF+WebP+JPEG/PNG fallback；共享 recipe 保留 MF0-A 旧 API/hash 行为，并以显式 V2 纳入 encoder/alpha/background/kernel/withoutEnlargement 等全部字节影响参数。inspection 与编码均在 cache=false、concurrency=1 且可超时终止的子进程运行；父协议、路径、输出字节和全 worker 并发有硬门，Ubuntu 编译子进程另加 `prlimit`，但不冒充生产容器/cgroup/独立 UID/禁网隔离。
- 首个真实 Variant writer 先核验 ready-set，完整重放零编码；ready 账本缺对象时 fail-closed。否则在首个对象写前持久预占完整 recipe set 的 `processing` owner。对象先写带一日 lifecycle tag 的 producer-token 隔离 attempt key，只有重新锁定 Asset、校验 token 并取得 canonical key fence 后才能在 15 秒有界窗口内 promote，copy 去除 TTL tag；attempt key 进入 durable metadata/cleanup plan。响应丢失按对象真值收敛，失败只 CAS 自己的 owner；重试前以 8 路有界 IO 对账并压缩 attempt，settled cleanup 重放只重删冻结 attempt，cleanup IO 接 cancellation+110 秒 deadline。生产 lifecycle 默认 validate-only、缺失阻止启动，仅单一部署 owner 可管理。单 Asset 最多 120 行；新 cleanup 的 canonical+Variant+attempt 总对象≤128，历史无 attempt payload 兼容 128 Variant+canonical。
- refurbish P2 正式调用图片活动：逐图失败隔离，步骤记录 done/degraded 与数量，取消穿透；既有 `hasPerson` 只保留不臆测，全部 `aiEdited=false`。Temporal 以 patch marker 兼容在途历史。
- refurbish 首个 Activity 一次物化≤512 个排序 Asset ID 的不可变 workset，后续每 Activity 最多两张；超限在 Sharp 前降级，旧 cursor history 仅作 replay。
- Ubuntu 开发环境真 PG/app_user FORCE RLS + MinIO 验证 30 项断言：同 asset 双 producer 同 key 只物化 30 行、对象/DB checksum 对账、EXIF/GPS/XMP 清零、sRGB、原图不变、重放 ID/hash 不变、PUT response loss 收敛、首个对象写前完整 owner、中断只落 attempt key、接管、批间 INSERT 隔离与既有成员 UPDATE 不漏、坏图隔离、A/B/unset RLS 与 fixture/object 清零。仅为开发验证，不代表生产部署。
- 明确未做：migration、MediaJob/AssetUsage、rembg、生成图、视频、Readdy/设计 Agent、公开 process/select API、SiteSpec variantId 与 Renderer `<picture>`；最后两项归 M1-e 消费者交付。

## 2026-07-17 · Site Builder MF0-B（引用守卫与 canonical/Variant 安全回收）

- Profile 三个正式 Asset 引用面与当前 `Site.activeVersionId` SiteVersion 进入同一 fail-closed scanner；SiteSpec 1.0.0 manifest UUID/kind/hash 与 ready Asset 对账，开放 props 按媒体字段语义有界扫描，缺 manifest/畸形/未知/超预算拒绝。Profile/active 指针/Variant/DELETE 共用 Asset 行锁，Variant trigger 作 DB backstop；DELETE 命中返回稳定 `409 ASSET_IN_USE` usages。
- canonical producer 按 key advisory xact lock 串行，事务内拒绝任一 active/unsettled owner后 copy+fenced 激活；关闭同 hash 多 tombstone 与 `copy→旧 cleanup→finalize` 误删窗口。DELETE 同事务只写 tombstone、cleanup ownership 与严格 schema v2 frozen plan；Temporal 两轮 Variant 叶→根/canonical 最后 Delete+HEAD，再重验 provenance、删 Variant 行并 durable settle。settle 响应丢失和旧事件重放均不会触碰后来 replacement。
- copy 成功但数据库 finalize/commit 失败时，producer 会重取同 key 锁，仅在无 owner 时 Delete+HEAD 补偿；补偿失败持久标记 retryable Asset 并阻止 DELETE，避免留下不可追踪 canonical 孤儿。
- 历史 schema v1 parked 对账默认 dry-run、单实例 advisory lock、稳定游标与逐项 poison 隔离；eligible 生成带 `causationId` 的 v2 successor，不篡改旧事件。050000 保持已应用字节不变；051000 显式 quarantine 迁移前 unbound tombstone、禁止新写伪造 legacy 标记，并将 lifecycle CHECK 收为 validated。
- Ubuntu 开发环境验证：46 migrations up-to-date、schema diff=0、lifecycle validated；真 PG RLS/双连接验证 Profile/activeVersion/Variant/delete 顺序与 props-only gate；真 PG 历史对账六分类 dry/apply/rerun；真 MinIO+Temporal canonical+多层 Variant 清理、settle、同 hash replacement 全绿。仅为开发环境，不代表生产部署。Sharp writer、MediaJob/AssetUsage、rembg、生成式图片与视频均未加入。

## 2026-07-17 · Site Builder MF0-A（AssetVariant 数据地基）

- 新增 additive `asset_variant`：workspace/site/Asset 直接 scope，父 Asset 与 source Variant 复合 FK 锁 provenance；单输出 `(asset_id,recipe_hash)` 幂等、canonical object key/hash/正尺寸/状态 payload CHECK、显式 app_user CRUD、ENABLE+FORCE RLS。
- `@global/contracts` 新增 recipe 与 `DerivedImageManifest` 共享类型；recipe hash 覆盖 pipeline/source/role/format/尺寸/crop/focal/quality，纯 projector 只从 ready Variant 确定性物化旧 `derivedKeys` 视图。未接 Sharp writer、未伪造历史 backfill、未预建 MediaJob/AssetUsage。
- TDD 与 Ubuntu 开发环境真 PostgreSQL 验证：app_user 非 super/non-BYPASSRLS，A/B/unset 隔离，跨 workspace/site/Asset provenance、ready+checksummed source 门、MIME→规范扩展名精确绑定的 Variant 专属对象键、不可改写行身份/来源/ready 账本、锁内 `row_security=off` 的脏升级 fail-closed 预检和 CHECK/trigger 负例，并发同 recipe 恰一胜；非 BYPASSRLS 扫描会直接失败而非假报 0；verifier 用数据库 advisory lock 串行，并在启动时只清理带专用 marker 的中断残留；现库增量迁移、临时空库 44 migrations 与 Prisma schema diff=0，fixture 清零。这里只代表开发环境，不代表生产部署。
- MF0-B 仍须完成 SiteSpec+Profile 引用扫描、409、删除/写侧共享并发门，以及 canonical+Variant 严格异步回收与历史 parked 对账；在此之前 canonical 继续 parked，不宣称整个 MF-0 完成。

## 2026-07-17 · Site Builder R2-A2（KB 正确性状态机）

- KB 改为单素材持久状态机：due queued/过期 processing 以 Asset attempt+UUID token+lease CAS 认领；外部 IO 间续租，所有回写 fenced。文档/chunks 与 Asset ready 同事务提交，结果丢失重跑 replace 同一文档，旧 worker 复活不能 zombie write。
- migration 以 020000 单事务/表锁完成 reconciliation + constraints 原子门，021000 仅作已在共享开发库执行过旧迁移名的 compatibility marker，022000 再让旧开发库形态通过正常 deploy 收敛到同一结构。除 duplicate/orphan/零块/不完整历史外，Site→Asset/KbDocument、document→Asset、chunk→document 均闭合复合租户 provenance；Site/workspace 不一致的子行无法安全跨租户改写时迁移直接中止，要求显式 quarantine/audit，绝不硬删 canonical Asset 或绕过 R2-A4/MF-0 cleanup 账本。开发库应用前预检该类行数为 0。
- Docling、embedding 与 KB 存储边界改 typed error；瞬时故障回 `queued+retryAt`，真损坏文档才 `failed_terminal`。commit workflow 透传 assetId；新增 5 分钟 recovery Schedule、有界扫描、结构化告警和 `redrive-site-builder-kb.mts`。
- 验证：专项 TDD、空库 37 migrations、从 34 migrations 构造旧 020000/021000 实际形态再只执行 022000 的升级、零块/healthy+processing|failed/重复/跨 workspace chunk/跨 Site 租户/terminal 保留等样本，以及真 PostgreSQL/app_user RLS/MinIO/Docling/BGE-M3、双 worker/过期接管/zombie fence、真损坏 PDF、recovery/redrive、unique/FK 与删除级联全部通过；fixture、对象与旧 M1-a verifier 残留均清零。当前仅为 Ubuntu 开发环境验证，不代表生产部署；生产迁移仍须独立变更审批与备份/回滚窗口。

## 2026-07-17 · Site Builder R2-A1（Asset 正确性状态机）

- Asset 增加 `processing_attempt`、UUID `lease_token`、`lease_until`、`retry_at` 与 `deleted_at`；active `object_key` 改为部分唯一索引，并以 validated CHECK 锁住状态/lease/tombstone 形状。
- commit 入口先 CAS 认领，所有完成/失败回写按 attempt+token fencing；canonical copy content-addressed 幂等，DB 真值先于 staging 删除，瞬时错误保留 staging 转 `failed_retryable`，唯一竞态显式转 `duplicate`。
- DELETE 从硬删改为 tombstone，KB 检索面同事务移除；cleanup intent 与状态变化同事务写 Outbox。R2-A4 前命令刻意 parked，MF-0 引用扫描器前 canonical 不自动删除。
- TDD 覆盖并发 loser、过期 lease 接管/zombie write、copy 失败重试、P2002、清理失败与 tombstone；开发环境真 PostgreSQL/app_user RLS/MinIO/presigned PUT 全绿，34 个 migration 在临时空库全量 deploy、索引与约束复验通过，verifier 无残留。

## 2026-07-17 · Site Builder R1-safety ②（抓取出口隔离）

- 移除开发 Compose 的 `CRAWL4AI_ALLOW_INTERNAL_URLS`；Crawl4AI 固定到 0.9.1 不可变 digest，保留 global-unicast seed guard 与浏览器 pinning proxy，并只在系统解析结果全部为 `198.18.0.0/15` fake-IP 时经固定 Cloudflare DoH 窄回退。
- API 新增统一 guarded HTTP：Crawl、robots 与 `http.get` 均在每一跳校验 global-unicast、将连接钉扎到已校验 IP、跨域剥离凭证并执行 redirect/超时/响应大小上限；不再保留 check-then-fetch 的 DNS-rebinding 窗口。
- 单测覆盖特殊地址、fake/private 混合答案、无二次 DNS、redirect 与大小上限；真机探针覆盖公网 `/md`+`/crawl`，并确认 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 均被拒绝。R1-safety 两个安全小 PR 至此完成，下一主路为拆分后的 R2-A。

## 2026-07-17 · Site Builder R1-safety ①（构建隔离）

- 两条 Astro 构建路径共用随机 0700 临时目录与 0600 SiteSpec，成功/异常均由 `finally` 删除，消除失败/超时后的租户内容残留。
- Renderer 改为固定 Node/Astro 入口和 7 变量 env allowlist，不经 shell/pnpm/PATH、不再展开 `process.env`；数据库、对象存储、模型网关、代理和 `NODE_OPTIONS` 均不出域。
- 新增单测锁住权限/清理/错误保持/allowlist，并以真 Astro fixture 验证三页产物与子路径资产；R1-safety ② Crawl/robots egress/SSRF 仍是下一项，未把 per-run staging/原子预览冒充已完成。

## 2026-07-16 · Site Builder R0 contract closeout（#126）

- intake 成功合同收口为 `{siteId,buildId,status:"generating_demo"}`，移除旧响应 `mode`；`hasWebsite/websiteUrl` 仅作品牌理解背景。
- 复用通用 `idempotency_key` 账本并新增 nullable SHA-256 `request_hash`：同 workspace/endpoint/key 同请求重放首次结果，异请求 fail-closed 409；历史其他 endpoint 的 NULL 行保持兼容；格式约束先以 `NOT VALID` 落地，再由独立迁移事务验证，避免把建列锁持有到全表扫描结束。
- Temporal 以确定性 workflowId、`REJECT_DUPLICATE + USE_EXISTING`、execution-chain head 与 DB CAS 持久化收敛启动 ACK 不确定窗口；终态缺 ACK 只 describe 修复，不重新 start；start 已成功但 ACK 写库失败时保留 Site/run，绝不补偿删除仍在运行的 workflow 锚点。
- code-first OpenAPI、生成类型、消费者迁移说明、稳定 400/409/502 错误码同步；验证包含单测、真实 PostgreSQL 并发/RLS/迁移约束与真实 Temporal probe。

# 后端路线图 · 能力一：AI 获客主线

> 范围锁定：**企业理解 → ICP → 客户发现 → 验证评分 → Lead**。
> 市场研究（PRD 7.3）与触达/Campaign 延后为下一能力。数据源第一版走 sandbox。

## 目标

跑通「客户输入官网/产品 → 系统理解企业 → 生成 ICP → 多源发现目标客户 → 验证补全评分 → 产出分好组的可跟进 Lead」的后端闭环，产出可交给 Campaign（触达）的合格 Lead。

对应 PRD：旅程 5.2 / 5.4 / 5.5 / 5.6；功能域 7.2 / 7.4 / 7.5；架构第 11 部分。

## 阶段与交付物

| 阶段            | 交付物                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | PRD 依据                 | 状态            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | --------------- |
| **P0 地基**     | ✅ Nx monorepo · ✅ NestJS `api` + Swagger(`/api/docs`, code-first) · ✅ 本地 PG+Redis · ✅ Prisma 多租户 + RLS（隔离已验证）· ✅ 事件 Outbox 表 · ✅ api↔db(app_user 连) · ✅ 鉴权 seam + AuthGuard + `whoami` · ✅ `workspace` 精简为租户锚点 + JIT provision · ✅ Model Gateway（app→**单一中转站(new-api)端点** + 薄契约 + task 选 model 名 + stub fallback；模型在中转站 UI 统一管理）· ✅ Outbox relay（owner 扫描跨租户）+ Temporal 编排（dev server）· ⬜ Policy stub                                                                                                                                                                                                                                                                                                                                                                  | 11.5 · ADR-001/002/009   | 🚧 收尾中       |
| **P1 企业理解** | ✅ 数据模型 `company_profile`/`offering`/`knowledge_source`/`claim`/`evidence`/`citation` + RLS · ✅ `POST/GET /companies`（code-first、租户隔离验证、创建写 `CompanyProfileCreated` Outbox）· ✅ Temporal 理解工作流端到端（relay→workflow→活动→ACTIVE + 写 Claim(NEEDS_REVIEW)/Source，活动 stub）· ✅ 抽取走**真模型**（DeepSeek V4 经 new-api 中转站，实测抽出 ISO/CE/MOQ/交期/市场等真实 Claim）· ✅ Claim 审核端点 + 人工 Gate（approve/reject 状态机 + ClaimApproved 事件 + 乐观锁 + 409 非法转移）· ✅ 抓官网走 **Crawl4AI**（真实抓取 + 自带 SSRF egress 防护；实测抓 python.org 抽出真实 Claim）· ✅ **字段级 Evidence**：每条 Claim 存 来源URL+官网原文片段+置信度，可溯源（事实 vs 推断）· ✅ **按任务选模型**（抽取=deepseek-v4-flash，ICP=deepseek-v4-pro）· ⬜ Docling（文档上传路径）· ⬜ 知识冲突/术语表                      | 7.2 · 5.2 · KNW-001..011 | 🚧 深化中       |
| **P2 ICP**      | ✅ 数据模型 `icp_definition`/`persona`/`buying_committee_role` + RLS · ✅ AI 生成 ICP（`icp.design` Task，DeepSeek 从已确认 Claim 生成 目标属性/痛点/触发信号/排除/买家委员会）· ✅ `POST /companies/:id/icps`、`GET /icps`、`activate`（→ACTIVE + ICPActivated 事件，未回测标 HYPOTHESIS）· ⬜ 样例回测(LED-004) · ⬜ QualificationRule · ⬜ 按 ICP 生成多源查询计划(LED-005，接客户发现)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 7.5 · 5.4 · LED-001..005 | 🚧 骨架完成     |
| **P3 客户发现** | ✅ `ProviderAdapter` 契约（七类，ADR-017 raw 不穿透领域层）· ✅ **真实公开数据挖掘**（PublicWebDiscoveryProvider：SearXNG 元搜索→噪声过滤→robots 闸门→Crawl4AI 抓官网→gemini-2.5-flash 判站抽取→provenance 指纹）· ✅ **Source Registry**（source_policy，SUSPENDED 域名爬前跳过）· ✅ Temporal discoveryWorkflow（READY 计划→逐源→归一→**ICP 资格门**→PARTIAL 容错）· ✅ `raw_source_record`（带采集留痕）→`canonical_company`/`canonical_contact` · ✅ 确定性身份解析（domain_exact > name_country，identity_link 留痕）· ✅ 字段级 `field_evidence` · ✅ **ICP 资格门**（discovery.qualify_fit，gemini-2.5-pro，四门：材质/角色/工艺/商业模式）· ✅ 联系人按需发现 + 邮箱验证 + Suppression · ✅ **真实评测通过**（19 家真公司，真实性 3 项满分，资格门拦竞品/品类不符）· ⬜ 真源合同接入 · ⬜ 规范词表归一（中英属性值映射，真源前必须做） | 7.4 · 5.5 · DAT-001..017 | ✅ 真实数据闭环 |
| **P4 验证评分** | ✅ 六维评分（确定性：规则引擎 Fit + 委员会覆盖 Role + 信号代理 Intent + 完整度 DataQuality + 可达 Reachability + Engagement=0 待触达）· ✅ `lead` + 四队列 + 分数明细（逐规则评估可审计）· ✅ 人工裁决 accept/reject + `lead_decision` 留痕 · ✅ LeadQualified 事件（Campaign 入口）· ✅ 重评不覆盖人工终态 · ⬜ 真实意向信号源 · ⬜ LLM 辅助评分层（LED-007 组合评分）                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 7.5 · 5.6 · LED-006..009 | 🚧 主链完成     |
| **P5 收口**     | ✅ OpenAPI 导出（38 端点，`packages/contracts/openapi/openapi.json`）+ `INTEGRATION.md` 前端接入说明 · ✅ LeadQualified 出口事件（Campaign 入口）· ✅ 单元测试基线（vitest 24 用例：规则引擎/评分/身份解析/选页/联系方式抽取，`pnpm test`）· ⬜ API 集成测试 + RLS 回归入 CI · ⬜ 事件对外发布通道（现仅 outbox 内部消费）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 11.10/11.11 · 14.1       | 🚧              |

### 补充完成（差距盘点驱动的收口，2026-07-06）

- **P1 深化**：多页抓取（关键子页确定性选择）· Offering 结构化抽取（幂等 upsert + 溯源）· 公开联系方式/社媒（正则确定性，Buyer Trust 原料）· 画像回填（industry/summary）· 手工 Claim 录入 · APPROVED→REVOKED 撤销 + validUntil→EXPIRED 扫描 · 知识冲突检测（Jaccard 启发式 + 人工裁决）· **REVIEW Gate**（零审批不得 ACTIVE，审批≥3 自动激活或显式 confirm）
- **AI 基建**：ai_trace + usage_ledger 全调用记账 · 结构化输出 ajv 校验 + 修复重试 · stub 仅 DEV · 模型调用超时 · persistClaims 幂等（ingestKey）
- **横切**：统一错误模型全局过滤器 · Idempotency-Key（POST /companies）· 我方侧 URL/SSRF 守卫 · outbox producer 字段

### 多源发现 + 工具编排 + 接口管理（2026-07-06 续）

- **真实多源发现**：官网(SearXNG+Crawl4AI+Gemini) + **Wikidata SPARQL**(结构化，实测 20 家真实公司端到端) + **OpenStreetMap Overpass**(地理，多实例 fallback)；executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器；source_hint 收窄子源。设计蓝图见 [discovery-sources.md](../backend/discovery-sources.md)。
- **✅ GLEIF 富集**（[discovery-sources.md](../backend/discovery-sources.md#gleif-富集落地要点本轮)）：`CompanyEnrichmentAdapter` 新契约 + `enrichRun` 活动（fit 门后，只富集 match 公司）；对已归一公司补 **LEI + 法人形式(ELF) + 实体·登记状态 + 直接·最终母公司**；核心名召回 + 拼写全称归一 + 置信门槛 0.72 + 歧义边距 0.1（绝不贴错身份）；429/5xx 退避重试。实测 Audi→Volkswagen AG、BMW Bank→BMW AG 母子关系落地。
- **✅ Wikidata 富集**（直连 REST，与 GLEIF 互补并跑）：`WikidataEnrichmentProvider` 走 wbsearchentities+wbgetentities，补 **行业/产品/员工数/成立年/母子/LEI/ISIN/上市交易所/总部/官网**；复用共享 name-match（精确命中凭搜索知名度排名消歧、模糊命中需边距）。enrichRun 改为**多源命名空间合并**（`attributes.gleif.*` / `attributes.wikidata.*`，逐源 field_evidence，按源幂等）。实测 SAP(32 万员工/LEI/交易所)、Siemens、Bosch、Bystronic→母公司 Conzzeta。
- **✅ 名录/列表发现**（**已端到端实测**）：`DirectoryDiscoveryProvider` + `discovery.extract_list`（一页多公司）。一次真实运行从 3 个静态目录（metalstamper/mrforum/thefabricator）抽出 **151 家真实公司**（带官网+地址），并正确拒绝非名录页（单会员/单供应商详情页判 not-a-directory）。剩余短板：地域精度——查 Germany 会召回美国目录，需下游 fit/地域过滤收敛。
- **✅ 展会参展商 API 模板**（**已端到端实测**，解决 JS-SPA 短板）：`TradeFairDiscoveryProvider` + `trade-fairs.ts` 逐站/逐平台模板。逆向大展会 SPA 的托管搜索（EuroBLECH/RX=Algolia），**直接打 public API** 拿结构化参展商名录。实测 EuroBLECH 2026 一次拉 **398 家 / 5 秒**（带官网 324 / **公开邮箱 322 / 电话 320** / 招聘信号 55）。`scripts/discover-fair-algolia.mjs` 用 crawl4ai 网络抓取自动提取展会配置（加新展会/换届一条命令）。维护：apiKey/eventEditionId 按届刷新。
- **✅ SearXNG 出网绕行**：本环境对消费级搜索引擎做 SNI 过滤，切到放行侧引擎（Yandex/Marginalia/Mojeek）恢复搜索（0→14 结果），解冻 public-web 发现。
- **工具/Broker 层**（[discovery-architecture.md](../research/discovery-architecture.md)）：Tool 契约 + Registry + **ToolBroker**（allowedTools 白名单/预算 reserve-settle/限流/source_policy/幂等/trace 统一闸门）；AiTaskContract 加 allowedTools 等边界字段。MCP=传输非授权，第一步不做。
- **✅ 规范词表归一**（[vocab-taxonomy.md](../backend/vocab-taxonomy.md)）：canonical_taxonomy + term_alias 表；250 国 ISO3166 + 1910 多语言别名 + ISIC 行业；TaxonomyResolver 确定性 + LLM 冷路径沉淀。实测中文「半导体/德国」→ wikidata 挖到 18 家德国公司。**欠账已还**。
- **✅ 统一接口门户**（[api-management.md](../research/api-management.md)）：自托管 Scalar `/api/portal`（前端一个入口浏览+调试全部端点）；OpenAPI 单一事实源 `--export-openapi`；结论：单端点是伪需求、不用 Apifox（出海数据合规）。
- **✅ 前端护栏**：helmet + CORS 白名单 + 按 workspace 限流。
- **✅ 生产鉴权**：JwksTokenVerifier（jose，验签 iss/aud/exp）；生产禁 dev stub。**待 SaaS 平台给 JWKS 契约激活**。

### 采集监控层 + v3.0 买家智能（2026-07-07）

- **✅ 采集监控层（源无关，平台级）**：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→**清洗**（域名/电话/邮箱分级）→落库→**增量 diff**（ADDED/UPDATED/REMOVED，连续缺席阈值防误杀）) + **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，源自带 cadence，`nextFetchAt` 到期自动增量）。展会只是第一个源：`trade_fair`(RX/Algolia，**实测 INTERPHEX 美国 602 家/12 国**，证明不锁德国/行业) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。源→`canonical_company` 租户投影（RLS+去重+🔴合规隔离）。
- **✅ v3.0 P0 信号富集（零付费，[buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)）**：直接兑现 P4「⬜ 真实意向信号源」。signal 源写 `attributes.*` 喂六维 Intent/Reachability：`digital_footprint`（官网 HTML/DNS→技术栈/在投广告像素/服务市场 hreflang/邮件商 MX/JSON-LD 事实，实测 TRUMPF 30 国/Xometry 社媒句柄）+ `structured_harvest`（sitemap→careers→招聘信号，采购岗=买家团队扩张）。走 enrichRun 命名空间+field_evidence+幂等。
- **✅ v3.0 P0 自建邮箱验证 `smtp_self`（#3）**：MX + SMTP RCPT 握手 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 → **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **✅ v3.0 P0 网站变更 = intent 引擎 `web_watch`（#4，`apps/api/src/intent/`）**：**复用 `source_entity_change` diff**——逐页抓意图承载页（产品/招聘/供应商招募·RFQ/新闻）→ 抽结构化信号 → `signalHash` 只覆盖信号字段（cosmetic 抖动不触发）→ 前后快照 diff 出 delta → 每条 = intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED` + 强度）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；**实测** TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（registry 正向过滤，不碰通用采集 sweep）；DAT-011 SUSPENDED + robots + crawl4ai SSRF 守；🔴 新闻只存**指纹哈希**（不落标题/人名），保留期清理；租户 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影 `attributes.intent.*`。**✅ 已接进六维 Intent 维**（`lead/scoring.ts`：真实 intent 事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，`intent=max(realIntent,keywordIntent)`；代理排除 intent 命名空间防双重计数；`scoreLead` 加 `opts.nowMs` 可测；权重/阈值不变，仅在有真实信号时上移）。**✅ 从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun` 接在 `discoveryWorkflow` 信号富集后：本 run fit=match+域名公司自动建 web_watch → intentSweep 持续盯，best-effort）。**dev 整条链路实测**（`verify-intent-loop.mts`，真库+真 crawl）：TRUMPF supplier 真实 diff→`SOURCING_OPENED`→投影→Intent 维 0→1、总分 0.39→0.54。**下一步**：六维加法→乘法门（需 backtest 校准阈值）。
- **⬜ v3.0 续（P1）**：自有 ATS JSON 逆向（Greenhouse/Lever/Workday CXS 招聘）· 海关提单（ImportYeti 免费+FOIA 基线+HS 反查逆向）· 招投标（TED v3/SAM.gov）· 认证注册库（openFDA/FCC/EUDAMED）· 专利 inventor（USPTO/EPO）。设计+免费访问+对抗核验见 [buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)。

### 管线通脉：存量对账 + 队列门修复 + loop 收口（2026-07-08）

> 背景（全库体检结论）：架构跑在数据前面——982/1040 家公司卡在 `fitVerdict=null`（投影公司从不属于任何 run，够不到前向取件的资格门）；4 个 signal provider 只靠 relay 启动静默 seed；`recommended` 队列被 fit 单维覆盖（11 家推荐里 9-10 家零联系人）；`DecisionMakerProvider` 从未注册；intent 事件无人投影。本次不建新能力，只让已建好的在存量上真跑。

- **✅ 存量对账管线 `backlogSweepWorkflow`**（`temporal/backlog.activities/workflow.ts`，Schedule 24h + 手动 `scripts/run-backlog-sweep.mts`）：资格门（`fit-judge.ts` 共享四门核心）→ GLEIF/Wikidata 快事实 → 信号富集（TTL 感知）→ web_watch 注册 → 联系人发现 → `scoreCandidates` 重评分。`id>cursor` 分页防活锁（单 sweep 每行至多一次，跨 sweep 自然重试）；批量+轮次双上限有界；网络一律事务外；DAT-011/SUPPRESSED 全程守。跨租户目标经 ownerDb 只读扫描（「受信系统扫描器」，同 relay 先例）。
- **✅ 队列门修复**：`scoreLead` 接 `authoritativeFit`（LLM 资格门）**只覆盖 Fit 维**；队列走六维总分阈值 + **Reachability 硬底**（match 但零联系方式 → needs_review 并注明先做联系人发现）；EXCLUSION 永远优先。`scoreCandidates` 每批独立事务（千余家单事务会撞 Prisma 5s 超时）。
- **✅ `decision_maker` 复活**：`ContactDiscoveryAdapter` 包装注册为联系人发现**首选**（Impressum/管理层页具名决策人+买家角色，此前是死代码、实际走 public_web 正则只挖 info@）；`contact-persist.ts` 共享持久化（🔴具名人 `person.profile` 证据 + `personal_data` 标记，无 outreach 授权）；`discoverContacts` 服务改「短事务①→网络→短事务②」。
- **✅ 启动自愈**：worker 启动幂等 seed（失败大声，双保险 relay）+ **三个 Schedule 自动 ensure**（acq/intent/backlog——dev Temporal 重置即丢 Schedule 的根治）；relay 合并 QualifyRequested AlreadyStarted。
- **✅ loop 双收口**：`intentSweepWorkflow` 尾部 `projectIntentAllWorkspaces`（事件自动流到 `attributes.intent.*` → Intent 维）；`finalizeRun` 自动发 `QualifyRequested`（发现完成 → 评分自动刷新）。
- **✅ 数据完整性**：fit-judge 拒绝 stub 兜底判定（实测抓到 2 家被网关 fallback 的罐头 null 假判定并重置）。
- **✅ dev 实测（真库真 crawl·无 sandbox）**：有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等，首轮冷样本 **6 阶段全产出**——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、`scored` 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过，不重复烧网关/抓取）。
- **✅ 对抗式复审收口（5 维·14 agent·逐条核验 → 6 findings）**：已修 3 手术刀——① 队列门 Reachability 硬底此前**只在 authoritative 分支生效**，`fitVerdict=null` 存量（982/1040 家）走规则引擎老路径时零联系方式仍能进 recommended（实算 total 0.57≥0.55），抽 `canRecommend` 对两条推荐分支统一生效 + 补 2 测试（RED→GREEN）；② DAT-011 `registerWatchesBacklog` 唯独没调 `suspendedDomains()` → 补 SUSPENDED 守（🔴 注册期 sitemap 探测对 kill-switch 域名越线）；③ 6 阶段静默 catch→`log.warn`（持续性故障不再吞成绿色空转）。

### TED 招投标 provider（P1 中标发现 + P2 ICP→CPV + P3 招标 intent，2026-07-09）

> 获客三缺环「需求证据/时机/对的人」的欧盟官方源。TED（Tenders Electronic Daily）= 欧盟采购官方公报，**零鉴权 REST**、绿事实 CC BY 4.0。归 `public_intelligence` 类，**复用 discovery→fit→enrich→score 全管线，无需新 SourceClass**。规格 [ted-provider-spec.md](../implementation-records/ted-provider-spec.md)（活 API 实测 + 对抗核验，含 §8 审查修正 8 点）。

- **✅ P1 中标发现**：`adapters/ted-api.ts`（`POST /v3/notices/search` expert query 构造 / ITERATION 滚动分页 / `winner-name` 多语言 eng 优先解包 / 缺键当 null / winner-* 按位对齐 / URL 身份安全归属）+ `discovery/providers/ted.provider.ts`（中标公告 → 每中标方一条 `ProviderCompanyRecord`，`winner-name` + 国别税号主解析键；`executeQuery` fan-out，无 CPV → fail-safe 空）。**实测**：泵(CPV 42120000)+德国 近 60 天真拉 12 家（BBA Pumpen/KAESER 等，真税号）→ 真落 canonical 过 fit 门。
- **✅ P2 ICP→CPV 映射（多租户不硬编码）**：`discovery/icp-to-cpv.ts` `resolveIcpToCpv`（industry `crosswalk.cpv` 锚定确定性 + product LLM 精修**限子树** + country 覆盖门非 EU/EEA/UK → `icp_fit_warning` 绝不静默丢）+ **§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零覆盖子码）+ **§8.7** planner 路由 TED（`generateQueryPlan` **确定性注入** TED 查询，LLM 绝不臆造 CPV）+ CPV 子树种子（手工核验，非全 9450 树）。**实测**：ICP「pumps+德国」→ cpv 42120000+DEU → 注入 TED 查询 → 真拉 29 家闭环；US → 覆盖门 warning。
- **🔴 合规**（spec §3）：绿事实带 **CC BY 4.0** 署名（发现证据 `field_evidence.license` 修，非硬编码 `'licensed'`）· `winner-email`/具名联系点**不入绿库** · `source_policy(api.ted.europa.eu, personalData=true)` **用途门**（含个人数据源直连前 fail-closed，非「ToolBroker 可选」）· 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并）· 国别 ISO-3→alpha-2 归一（防跨源 dedupe 裂键）。
- **质量闭环**：TDD（252 单测）+ 真库真 API 端到端（无 sandbox，`verify-ted-discovery.mts`/`verify-icp-to-cpv.mts`）+ **2 轮对抗复审工作流**（P1 修 1 HIGH 跨境同号误并 · P2 修 3 findings：CPV 子树前缀去尾零/缓存子树作用域/行业词双路采集）。PR #30/#31 自审自合。
- **✅ P3 招标 → TENDER_PUBLISHED intent（招标=买方需求，动 Intent 维）**：`adapters/ted-api.ts` `searchContractNotices`（`cn-standard`，`CONTRACT_FIELDS` 只取绿字段 buyer/CPV/截止/发布日，**绝不 winner/buyer-email**；抽共享 `fetchNoticesRaw` 分页，award 路径不变）+ `intent/ted-intent-projection.service.ts` `projectTenders`（买方身份 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → append `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，**新 event type 无需改评分**）。**§8.6** 发布日 `tedDateToIso` 归一（缺 T 补全 + Date.parse 校验；非法/缺失则跳过，绝不 NaN 静默 0 分）。🔴 **§8.8** 直连前过 `source_policy` 门（SUSPENDED/用途不含 intent\|discovery → fail-closed，与 P1 同一 DAT-011 kill-switch）· **幂等**（`sameIntent` canonical **键序无关**比较——开放招标每 sweep 复现不 bump version/不堆 evidence/不虚报指标）· **无国别招标跳过**（防跨国同名误并）· 新建买方写 `identity` 署名证据（CC BY 4.0 provenance）。**实测**（真库真 API 无 sandbox，`verify-ted-intent.mts` 五段全绿）：泵+德国近 90 天 **24 条开放招标 → 18 家买方 canonical**（skip 全 0）；同参再跑幂等（`companiesTouched=0`、evidence 36→36）；样本 Intent **0→0.8657**、总分 **0.1425→0.2724**；SUSPENDED→零落地。**3 轮对抗复审**（本轮 4 维·16 agent → 9 findings 收敛 5 处真缺陷全修；幂等修复被实测反抓 **jsonb 键序** bug）。TDD 261 测（+2 tedDateToIso）。PR #33 自审自合。
- **✅ P5 招标 intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」——TED 招标 + openFDA 清关共用 `externalIntentSweepWorkflow`，ACTIVE ICP → CPV/FDA 码 → 投影，生产周期真跑）。
- **⬜ 下一步**：P4 招标 SAM.gov Sources Sought（早数月意图）。

### openFDA 认证注册库 provider（P1 器械注册发现 + P2 ICP→FDA 产品码 + P3 510(k) intent，2026-07-09）

> 获客第二个官方免费源。openFDA（`api.fda.gov`）= 美国 FDA 官方开放数据 API，**零鉴权、CC0 公共领域**。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单（「注册人=合规卖家」）。与 TED 同构，归 `public_intelligence` 类、**复用全管线无需新 SourceClass**。规格 [openfda-provider-spec.md](../implementation-records/openfda-provider-spec.md)。

- **✅ P1 器械注册发现**：`adapters/openfda-api.ts`（`GET /device/registrationlisting.json` search 构造 / 有界样本分页 skip≤25000 / `openfda` 谐调块缺块当 null / 判 `error.NOT_FOUND` 空 / 429 退避 / 分类事实取**匹配 ICP 搜索码**的产品块）+ `discovery/providers/openfda.provider.ts`（establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主解析键、FDA 注册号→`fda-reg` **全局唯一 scheme**（非国别税号）、externalId 无注册号退 name:country 防跨国同名互撞；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。fit 门设备信号经 `attributes.products`=device_name 送达。
- **🔴 合规**（spec §3，**与 TED 关键差异**）：绿事实 **CC0**（可商用、**署名非义务**，`license='CC0-1.0'`，非 TED 强制 CC BY）· `us_agent`/`owner_operator`/`contact` **具名个人绝不入绿库**（CC0≠GDPR 依据）· **「注册≠核准」文案红线**（`attributes.fda.disclaimer`，绝不称 FDA 认证）· `source_policy(api.fda.gov, personalData=true)` **§8.8 用途门** fail-closed · MAUDE/FAERS 患者数据不摄入 · 捕获的 `owner_operator_number` 是非个人 firm id。
- **质量闭环**：TDD（289 单测，+28）+ 真库真 API 端到端（无 sandbox，`verify-openfda-discovery.mts` 四段全绿：LLZ 放射影像美国进口商 27 家 → canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地）+ **对抗复审工作流**（4 维·10 agent → 4 findings 全修：匹配产品分类/跨国 externalId/fit 门设备信号/firm 归并留键）。PR #34 自审自合。⚠️ Tier 3 fit 门 LLM 判别受阻于**网关 Gemini 额度耗尽(429)**（环境/计费，波及全部 fit 门，已建 task 跟进），openFDA 数据已正确进入门。
- **✅ P2 ICP→FDA 产品码映射（多租户不硬编码）**：`taxonomy-resolver.ts` 加 `resolveFdaProductCode`（产品词精修，枚举**限 panel 子树** `parentCode ∈ panelCodes`——FDA 3 字母码不透明无前缀层级、靠显式 panel 父维；缓存命中复验落当前子树；**复用 parentCode 列零 migration**）+ `listFdaProductCodes`（panel 宽网）；`discovery/icp-to-fda.ts` `resolveIcpToFda`（industry `crosswalk.fdaPanels` 锚定 + product LLM 精修限子树 + panel 宽网回退 + 直锚码**并集**）+ `buildFdaQuery`；`icp.service.ts` `generateQueryPlan` 链式 `injectFdaQuery`。**国家维与 TED 相反**：FDA=全美市场无覆盖门，租户选**贸易侧**（进口渠道 `initial_importer_flag:Y` / 同类制造商 `establishment_type`；未识别侧默认进口 + warn）。种子 curated（同 CPV 子树哲学）：6 panel + 6 放射 product code（码/名/class/regulation 手工核验自 `/device/classification`）+ ISIC 医疗器械节点 '325' crosswalks.fdaPanels（**只列已种子 panel**，不 over-claim）。**实测**（真库真 API，`verify-icp-to-fda.mts` 三段全绿，**确定性 allowLlm=false 即通**、不依赖模型）：ICP「放射影像器械+进口商」→ panel RA → 码子树 → 闭环真拉 25 家在美注册进口商（Philips Ultrasound/Carestream/Xoran…）。TDD 302 测 + 对抗复审（3 维·11 agent → 6 findings 全修：wikidata QID 错锚[Q12140 药品→Q6554101 器械]/panel 过度声明/贸易侧兜底/直锚码并集/标签截断）。PR #36。基于 #35（Gemini→deepseek 改路由）rebase。
- **✅ P3 510(k) → `FDA_CLEARANCE` intent 投影（动分，镜像 TED intent 投影）**：`adapters/openfda-api.ts` 加 `search510kClearances`（`GET /device/510k.json`，**顶层** `product_code`/`country_code` + `decision_date:[FROM TO TO]` 有界分页）+ `build510kSearch` + `map510k`（只取绿事实：法人 applicant/清关码/器械名/顶层 `openfda` 块，🔴 绝不取 `contact`/地址自然人）+ `fdaDateToIso`（§8.6/gotcha#5：`YYYY-MM-DD`/紧凑 `YYYYMMDD`/ISO datetime → `'YYYY-MM-DD'`，非法→undefined，防 `scoring.ts` `Date.parse` NaN 静默 0 分）+ `isClearedDecision`（§8.6/gotcha#6：**只对正向清关投**——`SE*` 家族 + `SN/ST/PT/SI` + `DENG`；NSE/被拒/撤回排除，绝不给被拒公司误加分；allowlist=fail toward 不投影）。`intent/openfda-intent-projection.service.ts` `projectClearances`：**具名申请人清关=新品/上市时机**，按 name+alpha-2 归并取最新决定日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength 0.85}]` → 动六维 Intent 维（复用 `mergeIntent`，新 event type **无需改评分**——`scoring.ts` 逐事件泛读）。§8.8 用途门 fail-closed；**§6 高精度个体户边界**（`isLikelyIndividualApplicant` 只判人称头衔/"Surname, Given" 逗号格式，**绝不按「几个大写词」形状误伤真公司**——"GE Precision Healthcare"/"Karl Storz Endoscopy" 都是 3 词却是公司；风险有界=从不落 contact/邮箱、applicant 为公开备案主体名）；幂等（`sameIntent`）。**合规（与 TED 关键差异）**：CC0 **署名非义务**（`field_evidence.license='CC0-1.0'`，非 TED 强制 CC BY）+「注册/清关≠核准」`attributes.fda.disclaimer` 恒置。**DRY**：`sameIntent`/`canonicalize` 上移 `intent-projection.service.ts` 供 TED/openFDA 共享；`mergeIntent` 排序比较器改一致（相等 `at` 返 0 保序，V8 稳定；修共享幂等基石的潜在不一致比较器）。**实测**（真库真 API 无 sandbox，`verify-openfda-510k-intent.mts` 五段全绿）：ICP「AI 放射影像诊断软件 product code QAS」近 1 年 16 条清关（Qure.Ai/Aidoc/Ischemaview/A2z Radiology Ai… IN/TW/US/CA/ES/IL）→ **11 家去重 canonical + 11 FDA_CLEARANCE**（"Ischemaview"+"Ischemaview, Inc." 正确并到最新决定日）、disclaimer/CC0-1.0/无 PII、同参再跑幂等（evidence 22→22）、Intent 维 0→0.0252 总分 0.1425→0.1463、§8.8 SUSPENDED 零落地。TDD 339 测（+37：510k 映射/日期/清关码 + `isLikelyIndividualApplicant` + 共享幂等基石单测）+ 对抗复审（3 维·7 agent → 4 findings 全经核验，2 条真机制加固：比较器一致性 + 共享幂等基石单测）。PR #37。
- **✅ 510k intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」）。
- **⬜ 下一步**：P4 `attributes.fda.*` 富集（分类事实/清关历史）· monitoring sweep（定时扫新注册/清关 `created_date`/`decision_date` 增量）· FDA 分类扩 `foiclass.zip` 全表种子（resolver/宽网机制已就位，扩种子即生效）。

### 外部源 intent sweep 上 Temporal Schedule（P5 · loop 收口，2026-07-09）

> 让已落地的两 P3 intent 投影（TED 招标 `TENDER_PUBLISHED` + openFDA 510k 清关 `FDA_CLEARANCE`）**在生产周期真跑**——此前只在 verify 脚本里活，生产永不触发、Intent 维永远拿不到外部信号。核心原则「已建的东西在生产真跑优先于建新能力」。

- **✅ `externalIntentSweepWorkflow` + 第 4 个 Schedule**（`temporal/external-intent.{activities,workflow}.ts` + `ensure-schedules.ts`，默认 6h、overlap=SKIP、env `EXTERNAL_INTENT_SWEEP_EVERY` 可调，worker 启动幂等自愈）：`listExternalIntentTargets`（ownerDb 只读枚举**全部** ACTIVE ICP——无静默截断防旧 ICP 饿死，稳定序 id asc；+ data_provider `ted`/`openfda` ENABLED kill-switch）→ 逐 ICP `projectExternalIntentForIcp`：ICP `companyAttributes`/`targetMarkets` → **确定性**（`allowLlm:false`，调度不臆造码/可复现/零 LLM 成本）解析 CPV（`resolveIcpToCpv`）+ FDA 产品码（`resolveIcpToFda`）→ `projectTenders` + `projectClearances`。各 provider 独立 enabled 门 + 单 provider/单 ICP 失败 fail-safe 不阻断其余；投影写全走 `withWorkspace`（RLS 安全，跨租户枚举走「受信系统扫描器」先例）；§8.8 source_policy 门由两 projection service 各自把守。worker 抽出**共享** `TaxonomyResolver` 一实例（discovery + external-intent 复用）。
- **实测**（真库真 API 无 sandbox，`verify-external-intent-sweep.mts` 四段全绿，活动级）：seed 两 ACTIVE ICP → 枚举命中 + provider ENABLED；pumps+EU → CPV 1 码 → **68 招标 → 54 买方 canonical → 54 TENDER_PUBLISHED**；radiology+US → 6 FDA 码 → **82 清关 → 70 公司 → 70 FDA_CLEARANCE**；`ted` DISABLED → `tedEnabled=false` 跳过。build 绿 · 340 单测绿 · 对抗复审（3 维·7 agent → 1 finding 经核验后加固：ACTIVE ICP 枚举去静默截断防饿死）。PR #38。
- **⬜ 下一步**：超大规模（ACTIVE ICP 数千+）再上 `lastSweptAt` 水位列做增量轮转（当前全量枚举，dozens 级绰绰有余）。

### 已知欠账（按优先级）

- 🟠 **存量下游跨-sweep 游标饿死（fast-follow，复审 #1/#2 HIGH）**：`enrichBacklog/enrichSignalsBacklog/registerWatchesBacklog/discoverContactsBacklog` 每 sweep 游标复位为 null（Schedule 全新 workflow、无跨-sweep 持久化）+ 扫描集按 `fitVerdict='match'` 不随处理收缩（处理只改 attributes/version，不脱离过滤集；联系人集靠结果依赖的 `contacts:{none:{}}`，空结果常态 → 永久留前排）→ 每轮重扫 id 最前固定 N 家（预算 signals/watch 各 36），**预算位次后的 match 公司在信号/监控/联系人上永久饿死**（某租户 match>36 即触发），Intent/Reachability 恒 0、永不满足 recommended——**本管线立论 bug 在下游复现**。根治：加 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt`，WHERE 过滤「已处理且 TTL 新鲜」使扫描集随处理收缩、游标真吞噬存量（仅调大预算治标不治本）。

1. **鉴权契约对接**：JwksTokenVerifier 已就绪，但需 SaaS 平台的 JWKS 端点 + claim 约定书面确认才能激活（联调前提）。
2. **多源 P0 补源**：VDMA 协会名录 / Hannover Messe·EuroBLECH 展会名录（需逐站抓取模板）。~~GLEIF LEI 富集~~ ✅ 已落地。
3. 异步长任务前端交付：SSE 进度流 + 领域事件出口（现仅裸轮询）。
4. 契约防漂移进 CI：openapi-typescript 生成前端类型 + oasdiff 破坏性变更检查。
5. Docling 文档上传路径；OPA / Langfuse / Golden Set；brand_profile / glossary。
6. 海关贸易公司级数据（付费 reseller，留契约插槽）；product/HS 维归一。

## 关键数据模型（本能力落地的主要表）

所有业务表带 `workspace_id` + PostgreSQL RLS（ADR-001）。

- **企业理解**：`company_profile` · `offering` · `brand_profile` · `knowledge_source` · `claim` · `evidence` · `citation` · `knowledge_conflict` · `glossary`
- **ICP**：`icp_definition` · `persona` · `buying_committee_role` · `qualification_rule`
- **Data Hub**：`data_provider` · `provider_contract` · `dataset_license` · `source_policy` · `raw_source_record` · `canonical_company` · `canonical_contact` · `field_evidence` · `identity_link` · `data_quality_issue` · `data_cost_ledger` · `suppression_record`
- **Lead**：`account` · `contact` · `lead` · `signal` · `lead_score` · `lead_decision` · `lead_cohort`
- **公共/基础设施**：`organization` · `workspace` · `membership` · `outbox_event` · `ai_trace` · `usage_ledger` · `audit_log`

## 状态机（PRD 11.9）

- **Claim**：INGESTED → EXTRACTED → NEEDS_REVIEW → APPROVED → EXPIRED/REVOKED
- **ICP**：DRAFT → HYPOTHESIS → VALIDATING → ACTIVE → SUPERSEDED → ARCHIVED
- **Lead**：DISCOVERED → ENRICHING → REVIEW → QUALIFIED/REJECTED/SUPPRESSED → CONTACTED → CONVERTED

## 贯穿约束（每个阶段都要守）

1. **多租户**：Shared Schema + `workspace_id` + RLS，领域 API 不感知物理隔离（ADR-001）。
2. **AI 分层**：AI 只理解/研究/生成/建议；状态/权限/预算/执行/审计由确定性系统兜底（无「超级 Agent」）。
3. **对外动作前置校验链**：数据权利 → Suppression → Policy → RBAC/ABAC → Campaign Scope → Approval → ExecutionAuthorization。
4. **字段级 Evidence**：Canonical 字段不只存「最终值」，保存来源/时间/置信度/许可/允许动作（7.4.9）。
5. **契约先行**：数据模型 + OpenAPI/AsyncAPI 先定，Provider JSON 禁穿透领域层（ADR-017）。
6. **幂等**：所有外部副作用用稳定 idempotency_key；业务更新用乐观锁/version（11.16）。

## 接口文档（后期交付，code-first）

**不为前端并行开发做协调/mock；后端做好后再出一份接口文档告诉前端如何接入**，不等前端（见 [[api-contract-approach]]）。做法：

1. REST 采用 **code-first**——用 `@nestjs/swagger` 从实现自动生成 OpenAPI，开发期 `/api/docs` 可看可试；后期**导出 OpenAPI + 简短接入说明**作为交付物。
2. 事件用 AsyncAPI/JSON Schema（`packages/contracts/events/`，按 11.10/11.11），随实现补。
3. `packages/contracts` 保留：事件 schema、通用约定(README)、以及最终导出的 OpenAPI；spectral/redoc 用来 lint 与渲染导出的 doc。

统一约定（错误模型 11.15、游标分页、uuid、UTC 时间、金额币种、幂等键、乐观锁）见 `packages/contracts/README.md`。

**鉴权边界**：身份/登录由**外部 SaaS 平台**拥有，我方只校验其签发的 bearer token 并解出 workspace/角色（做成可插拔守卫，本地 dev 校验器）。契约安全方案 `bearerAuth` 不变。

**文档工具链就绪**（早期用手写 `/health`+`/companies` 验证过 lint/mock/gen 全链路；REST 契约后续改由 Nest 自动生成，手写 openapi.yaml 仅作过渡参考）：

- `pnpm contracts:lint` / `contracts:docs` — spectral 校验 + Redoc 渲染（用于最终导出的 doc）
- `contracts:mock` / `contracts:gen` — Prism mock / TS 类型（备用，非当前优先）

## 待定决策

- **数据层 ORM**：✅ 已定 **Prisma**。RLS 用「非超级用户 app_user 连接 + 每事务 `set_config('app.current_workspace_id')` + `current_workspace_id()` 策略函数」，迁移 `20260706_rls_and_app_role` 已落地并验证隔离。
- **首个真实数据源**：Provider 合同 Validation Required；先 sandbox，合同确认后接第一个真实 TradeData/B2B 源。

### 收口① CandidateAssessment：fit 判定迁到 ICP×公司维（2026-07-10，PR #43）

> release-plan 六收口第一项。修 as-built 缺口 #1（真 bug）：fit_verdict/fit_reasons 原挂 canonical_company（公司级），同 workspace 两个 ACTIVE ICP 时后判 ICP 判不了（qualifyFit 只判 null）且评分读到前判 ICP 的判定（污染）。

- **迁移**：Lead(+fitVerdict/fitReasons/`[ws,icp,fitVerdict]` 索引/FK→canonical onDelete:Cascade)；canonical 删两列、4 水位索引去 fit 前缀；migration 有意不 backfill（生产未上，sweep 按 ICP 重判）。共享 `upsertLeadFit`（run 增量 + backlog 存量两路统一）；初始 queue 按 verdict 映射（mismatch→rejected）。
- **过滤语义**：discovery 下游=本 run ICP 的 match（`leads.some(icpId,match)`）；backlog 下游=任一 ICP match（公司级去重）；四水位列留 canonical（公司级，多 ICP 共享）。scoreCandidates 的 authoritativeFit 改读本 ICP Lead。
- **对抗复审 2 findings 已修**：ENRICHED 死值（真正富集成功处写回，updateMany+SUPPRESSED 守护）；空分 Lead 置顶（排序 nulls last）。迁移/RLS/并发维 5 疑点全核验安全。
- **实测**：build 零错 · 343 vitest（回归 spec RED→GREEN）· 真库真 RLS `verify-candidate-assessment-fit.mts` 全绿（app_user 硬 guard；两 ICP 独立/幂等/迁移生效/水位保留）。

### 收口③ LeadQualifiedPackage 真实交付：Outbox 假发布根治（2026-07-10，PR #46）

> release-plan 六收口第三项（P0）。修 as-built 缺口 #3：relay 对无 handler 的 8 种事件（含 LeadQualified）也标 publishedAt——假发布、静默丢失，平台核心交付物事实上发不出去。

- **事件注册表三分支**（`relay/event-registry.ts` 穷举 11 种产地）：3 内部命令→Temporal（补 AlreadyStarted 幂等，`startWorkflowIdempotent` 三处共用）；8 集成事件→`outbox_delivery` 账本单事务原子路由（skipDuplicates 幂等，publishedAt 语义=已路由进交付层）；未注册→`parkedAt` 停靠+大声报错（不假发布、不毒化 2s 轮询）。
- **双 sink**：`saas` 拉模式=`GET /events`（游标=**交付账本行 id**，构造性消除「低 id 晚发布被游标越过→永久漏交付」；任意重放 at-least-once）+ `POST /events/ack`（幂等、锁死 pull sink——webhook 的 ACKED 只能由 relay 2xx 写）；`webhook` 推模式=URL+SECRET 且 https 才启用、HMAC-SHA256 签名（验签契约 `contracts/events/WEBHOOK.md`）、指数退避封顶 1h、10 次 DEAD（DLQ）、成功/失败双路径 CAS。
- **LeadQualified 快照 v1**（decide(accept) 事务当刻不可变副本，契约 `lead-qualified.v1.schema.json` + ajv Consumer Test）：六维分（demand_proof 收口⑤前恒 null）+ icp_version + company_ref（LEI/FDA 标识符）+ 🔴 contact_refs 只带 ref+职务元数据绝不嵌人名/邮箱（additionalProperties:false 契约兜死）；含具名 refs 事件 privacyClassification=RESTRICTED。
- **decide 幂等+CAS**：同状态重复裁决短路（双击不产生第二条 LeadQualified）；version 乐观锁并发 409。值域护栏：权重 @Min(0)+快照/scoring clamp01。expireDueClaims 两步包事务（ClaimExpired 现为对外事件，不可丢）。
- **对抗复审**（3 维 18 agent 逐条核验）：15 findings→确认 13（2 对重复=11 独立）**全修**，杀 2 误报。记档不阻塞：游标 volume 侧信道→后续不透明游标；LeadQualificationRevoked 撤销事件；internal command attempts 上限停靠。
- **实测**：build 零错 · 435 vitest（RED→GREEN 有据）· 真库真 RLS `verify-outbox-delivery.mts` 24 断言全绿（app_user 非 superuser 硬 guard；路由/幂等/停靠/账本游标翻页不漏不重/跨租户 RLS/端到端 decide→快照→拉取→ajv 契约校验→无 PII/重复 decide 幂等）。
- **部署注意**：relay 单写者约束（多副本前需 advisory lock）；存量已假发布旧事件不回补（thin payload 无快照可补）。

### 选项 B · P0.4 决策人邮箱猜测接入主链（2026-07-10，PR #49，设计 [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)）

> 承接 P0.3（PR #42/#45）：已落地但**无生产调用方**的 `guessEmailsForCompany` 接进主链，让 fit=match+域名+缺邮箱的具名决策人**自动补全邮箱**。混合姿态（会话拍板）。service 方法零改动，两条路复用其底层纯件。

- **组件 A 按需端点**：`POST /canonical-companies/:id/guess-emails`（`GuessEmailsDto` 镜像 VerifyContactPointDto + maxContacts/maxProbe 护栏）→ 透传 `guessEmailsForCompany`。调用方（SaaS 前端代客户）带 LIA = per-tenant 干净合法性来源。
- **组件 B 存量 sweep 阶段⑤b**：新活动 `guessEmailsBacklog`（镜像 discoverContactsBacklog：短事务①载入→事务外 SMTP→短事务②落库→水位 stamp-all）。🔴 **双闸合规门·默认关**：全局 kill-switch `email_guess` provider（seed **DISABLED**）ENABLED **且** `config.lawfulBasis` 有合法记录才自动探测；**自动路径永不 allowPersonalWithoutBasis**（红线，单测+实测证伪）。RISKY 猜测无 outreach、suppression 不落、personal_data+lawful_basis 留痕（走未改动的 persistGuessedEmail）。
- **组件 C 水位列**：迁移加 `canonical_company.email_guess_attempted_at`（加性可空 + 索引，镜像 4 同族列）；`backlog.eligibility` 加该水位（30d TTL 防重锤 MX）+ `requireEmaillessContact` 谓词。
- 🔴 **诚实交底**：B 路径 `config.lawfulBasis` 是 **interim 全局**（ENABLED 时对所有租户套同一条），仅适用当前单客户/dev；per-tenant LIA 采集归收口⑥ DataRightsService+SaaS。默认 DISABLED 即为此设计。
- **对抗复审**（4 维·逐条对抗核验）：无 HIGH/CRITICAL；修 2 MEDIUM（自动路径 per-company SMTP 扇出无上界→大团队公司超时→水位不 stamp→重锤 MX；service/backlog 目标构建逐字重复漂移）——抽共享纯件 `buildGuessTargets`（RISKY 排除 + per-company cap 25）供两路共用一并根治 + 补 no_verifier 测试 + 清死字段。
- **实测**：build 零错 · **464 vitest** · 真库真 SMTP 真 RLS `verify-email-guess-backlog.mts` 全绿（app_user 非 superuser 硬 guard；双闸全开→真扫→真 SMTP 诚实降级 RISKY 不谎报 VALID→落库+水位 stamp；幂等 scanned=0 不重锤；两红线可证伪 DISABLED/无 LIA→skip）。
- **遗留**（后续独立 track）：待办 2 跨源身份解析（name-match 合并多源同一人）；待办 3 P1 身份源（专利/注册处/商标）。

## 2026-07-10 · 收口④ OpenAPI 单一真值 + 统一信封（PR #48，缺口#4 已修）

- **统一响应信封定稿**（PRD 11.12/11.15 + contracts README 既有约定落地）：2xx 一律 `{data}`；分页 `{data, page:{next_cursor, has_more}}`（协议键 snake_case、资源字段 camelCase）；错误 `{error}`；`/health*` 探针例外。8 控制器 38 业务操作全套 + `@ApiEnvelope/@ApiPageEnvelope/@ApiListEnvelope`（与运行时 `common/envelope.ts` 同源），响应 schema 覆盖 23 缺失→0。
- **双源消失**：删旧 3-path `openapi.yaml`；contracts lint/bundle/docs/mock/gen 5 脚本切 code-first 导出的 `openapi.json`（40 paths）；README 重写 code-first；`src/generated/api.ts` 从 JSON 重生成。顺手修 17 处 DTO 契约错型（`string|null` 联合被 swagger 推断成 object）+ create 202/201 错位。
- **CI contracts job 三道门**：`--export-openapi`（无需 DB/Temporal，假 DATABASE_URL 实测可跑）→ drift（`git status --porcelain`，抓修改+untracked+删除态）→ spectral lint → oasdiff breaking（PR base 对比；`breaking-change-approved` label 放行——本 PR 即首例，v1 无消费方是定稿零成本窗口；`review:'false'` 关掉 action 默认把私有契约上传 oasdiff.com 的外发）。
- **对抗复审**（3 维 find + 逐条对抗核验，14 agent）：11 findings → 10 确认全修 + 1 误报杀掉。HIGH×2：6 端点 13 个可选 @Query 被推断 required:true（prism mock 实测合法首页请求 422）→ 显式 @ApiQuery；Idempotency-Key 大小写不合并成双 header 矛盾参数 → 改小写合并。MEDIUM×4：事件 envelope schema 与 envelope.schema.json 双源漂移（补 10 required+枚举+3 条一致性单测）；恒在可空字段错标可缺失（@ApiProperty+nullable 正确建模）；22 处裸 `{type:'object'}` 致 codegen `Record<string,never>` 字段访问全编译错（补 additionalProperties:true）。LOW×4：drift 门 untracked 盲区、oasdiff 隐私外发、class-validator 约束进契约、INTEGRATION.md 旧示例。
- **实测**（真实数据无 sandbox）：461 vitest 全绿（TDD RED→GREEN）· `verify-envelope.mts` 真 API+真 dev 库 18 断言全绿（1040 家 canonical 真数据游标续拉不重复、真事件 snake_case envelope、404/400 错误模型、真响应逐个过 openapi.json ajv 校验）· 契约复检（query required 清零/单 idempotency header/events 10 required+enum/裸 object 清零）· CI contracts job 首跑即绿（ubuntu 重导出与提交契约逐字节一致=跨平台确定性）。
- **记档不阻塞**：Lead/CanonicalCompany 等松散 object 的结构化 DTO 待收口⑤/实体解析定型后收紧；信封扩展字段（Evidence/Quality/Rights/Freshness/Cost/Partial）随收口⑤⑥补。

## 2026-07-11 · 收口② ExecutionContext + Broker 真收口（PR #51，缺口#2 已修——R0 四刀全部完成）

- **主链全经 Broker**：新增 8 个 L0 工具（`crawl4ai.render`/`http.get`/`wikidata.entity`/`gleif.fetch`/`ted.search`/`openfda.search`/`tradefair.algolia`/`mapyourshow.fetch`，`tools/source-tools.ts`）+ 既有 5 件套，收编 22 处直连出网——发现/富集/intent/采集/理解五条链全部 `broker.invoke`（业务层直连 grep 清零）。登记例外四类注明：robots.txt 抓取（合规原语）、DNS 解析（SSRF 护栏原语）、模型网关内部 HTTP（网关层自治）、outbox relay webhook（交付账本治理）。
- **source_policy fail-closed 分层**：`ComplianceMeta.sourcePolicy = required|advisory|none`——required（受治理数据源，policyDomain 固定治理域）未登记/无 reader/提不出域一律拒；advisory（标的公司站点）登记即强制、未登记放行（robots/SSRF/DAT-011 兜底，不杀发现引擎）。删 ted/openfda 四处手写 §8.8 镜像（「无 reader fail-open」缺陷）收敛 Broker 单点；用途门按**本次调用用途**判（`ToolContext.purpose: string|string[]`，any-of ∩ 工具声明集——TED E2E 负向测试抓到交集弱化回归后补）；seed 补 6 治理域行（algolia.net ToS 灰红源如实标 REVIEWED_RESTRICTED=显性风险登记点，SUSPENDED 即全链停抓）。
- **预算真开账 + LLM 网关门**：discovery run 逐活动幂等 `open(runId, RUN_BUDGET_CENTS)`/finalize 强制 close；backlog sweep fit/contact 阶段账（BudgetLedger open/close 引用计数防并发误删 + settle 迟到句柄钳 0）；**RouterModelGateway reserve-then-settle**——`maxCostCents` 从纯声明变真闸，settle 按 token 折算实际成本（`LLM_CENTS_PER_MTOK` 保守混合价；复审 HIGH：原按上限记账令 $20 run 实为 ~100 次调用硬顶）、预算拒绝落 trace、fit 截断显性化（`stats.fitSkippedForBudget` + run 转 PARTIAL 绝不假 DONE；backlog 该页收手下轮重判）、stub fallback 零成本入账。
- **allowedTools 填实 + 灭伪 workspace**：extract_company/extract_list/find_decision_makers/extract_claims 填真实工具 id，provider 经 broker 调用绑 taskContractId（白名单真实生效）；`ExecutionContext {workspaceId, runId?, correlationId?}` 贯穿 adapter 契约（discoverCompanies/enrichCompany/discoverContacts 增 ctx），`'discovery'`×3 + `'taxonomy'`×3 伪值清零（taxonomy 无租户时跳过 LLM 冷路径）——ai_trace/usage_ledger 按真租户/run 归账。
- **实测**（真库真源无 sandbox）：`verify-broker-closure.mts` 15/15 断言（未登记拒/无 reader 拒/SUSPENDED 真库翻转 Broker 真拦/预算双门真拦截/**ai_trace 真写入** + 伪 workspace 负向对照 22P02 静默 0 行/TED 真拉 5 中标/SSRF 真拦云元数据 IP）· `verify-ted-discovery.mts` 端到端全绿（raw 13→canonical 13→CC BY 证据→真 LLM fit 四门）· 494 vitest（+33 新测）· 15 个 verify 脚本同步新契约。
- **对抗复审**（3 维 find + 14 agent 逐条对抗核验）：11 findings 确认全修（HIGH×2：预算按上限记账静默截断假 DONE、http.get redirect:'follow' SSRF 绕过→改 manual 逐跳护栏≤3 跳；MEDIUM×4：intent 用途门缺口、directory 名录页 60k→40k 上下文劣化（工具加 maxChars）、http.get 丢浏览器兼容 UA、sweep 预算生命周期注释与事实不符；LOW×3）+ 3 误报核验杀掉（含 algolia seed APPROVED——显性登记优于 main 零门现状）。
- **记档不阻塞**：整轮 sweep 硬上界需持久化账本（收口⑤/R2 预算基建）；DNS-rebinding TOCTOU 连接层 IP pinning（收口⑥安全加固）；Broker ToolTrace 落库（现 console，成本/合规决策审计表后续）；幂等闸门仍为 trace 元数据（无结果缓存）。

### 选项 B · 待办 2 跨源决策人身份解析（2026-07-11，PR #54，设计 [decision-maker-cross-source-identity-design.md](decision-maker-cross-source-identity-design.md)）

> 承接 P0.4（#49）+ 设计定稿（#53）：落库前加 `resolvePersonIdentity` 解析前置——先问「本公司是否已有同一人」，有则并入、无则新建——修 P0.4 令其更活的决策人重复 bug（email/无-email 桥 + 人名变体），并建成待办 3（专利/注册处/商标）复用缝。

- **新 `person-name.ts`**：从 `email-permutation.ts` **搬迁**人名归一（去称谓/贵族前缀/"Surname, Given" 语序/NFC/德语去音标），email-permutation 改 import + re-export，**行为逐字不变**（69 email 测全绿）。
- **新 `person-identity.ts` `resolvePersonIdentity`**：同 companyId 内 4-Tier（externalId / 邮箱精确 / 归一名精确 / 高置信模糊）。🔴 **绝不错并**：仅同公司 + fuzzy 严阈值 **0.9 + margin 0.1** + **邮箱冲突守卫**（同公司同名不同邮箱→判不同人、不并）；方向宁欠并不错并。
- **改 `contact-persist.ts`**：命中并入（title/seniority 补空不覆盖 + `identity.merge` snake_case 证据）、无则原 `contactIdentity` 键新建；`created`/`merged` 分计。**无 schema 迁移**（键形不变、matchRule 走 field_evidence、Tier0 留 TODO 供待办 3）。
- **对抗复审**（单 reviewer 逐条对抗核验）：抓 **1 HIGH（🔴 错并）**——Tier 3 原误借**公司名匹配器** `normForMatch` 剥法人后缀（co/sa/oy/as…），姓氏恰为这些真实姓氏时（"Marco Sa"/"Erik Oy"/挪威姓 "…As"）→ 剥成只剩名 → 错并两人；**已修**：Tier 3 改用人名归一 token Jaccard、不碰公司匹配器 + 锁死回归测。2 LOW（`created` 含并入、证据 camelCase→snake_case）一并修；邮箱守卫/欠并方向/重构等价/事务纪律逐条核验安全。
- **实测**：build 零错 · **521 vitest**（+3 错并回归）· 真库真 RLS `verify-cross-source-identity.mts` 三场景全绿（①一人无邮箱→带邮箱同名→并一条 ②同公司同名不同邮箱→两条不并🔴 ③"Dr. Johann Schmidt"→"Johann Schmidt"→并）。
- **遗留**：待办 3 P1 身份源（专利 inventor/注册处董事/商标申请人）——本期已建 `externalIds→Tier 0` 缝、留 TODO 空跑通。

## 2026-07-11 · 收口⑤ 一等 Signal + ingest-once（PR #56 代码 + 本 PR 文档）

**缺口#5 根治**：intent 从「JSON 投影非一等事实 + 外部源按 ICP×workspace 重复直拉」反转为两层模型。

- **平台层**：`source_signal` 一等信号表（无 RLS 零个人数据：payload 白名单显式构造 + FDA 个体户摄取层即拒 + 对抗单测锁；subject 身份键与租户 dedupeKey 同规范化；双时间轴 occurred/observed=backtest 基础；license 行级；状态机 ACTIVE→EXPIRED|REVOKED + 类型 TTL 招标 90d/清关 365d）+ `signal_ingest` ingest-once 账本。**时间窗拍板：6h UTC 对齐桶**（env `SIGNAL_INGEST_WINDOW_MS`），拉取键=(provider, 规范化查询指纹, windowKey)——跨 workspace 同参 ICP 天然共享一次拉取。
- **SignalIngestService**：经 Broker（PLATFORM_WORKSPACE + purpose=['intent','discovery']）+ `sweep:external-intent` 预算开账 + BudgetExceeded 透传；ERROR 条件记账绝不覆盖并发 OK 行（TOCTOU 护栏）；**撤即脱敏** revoke + revokeBySubjectKey/ByProvider（Art.17 路径）。**两级撤停语义拍板**：source_policy SUSPENDED=停采不停用（只拦出网），「采集被判违规」类事件用 revokeByProvider 处置存量。
- **投影反转**：TED/openFDA intent 投影只读 source_signal（fetch 拆层、构造去 broker）；FDA 码过滤下推 jsonb；扫描窗/上限截断显性告警 + subjectsTruncated 可观测。sweep 四段化（枚举→确定性解析→指纹去重拉取一次→逐 ICP 投影），expireStale 状态机先行。
- **可复算**：IntentRecomputeService（surfaces=与增量投影同过滤面——对抗复审 HIGH：防跨 CPV/跨 ICP 注入与抖动循环，不动点回归锁）；mergeIntent 去重键 epoch 归一（对抗复审 HIGH：存量旧格式 at 与新 UTC ISO 同刻去重，生产 sweep 一次重写自然收敛，无需 backfill）。web_watch 按 ADR-006 留租户轨（事实账本=source_entity_change，复算地平线=保留期）。
- **demand_proof 维切分拍板**：需求证据=TENDER_PUBLISHED+SOURCING_OPENED（FDA_CLEARANCE 属上市时机留 Intent 维）；evidence 判据强制（ADR-010）；观测维**不进总分**（乘法门待 R2 backtest ≥50 QGO 标签）；快照 v1 契约预留槽位 → **零破坏填充**（snapshot_version 保持 1，不开 v2 文件防混流；qualification_rule_version→additive-6dim-v2）。
- **实测**（真库真 API 无 sandbox，四脚本全绿）：verify-signal-first 38 断言（验收①②③各有专属断言：24 条真招标一次拉取双租户各投 18 家零出网 / EXPIRED-REVOKED 剔除+脱敏 / 复算重建 unchanged）；三旧脚本适配两层架构（真跑抓到并修 openFDA 投影 taxonomy 键大小写 bug）。547/547 vitest（+53 新测 TDD）+ build + eslint 零告警。
- **对抗复审**：3 维 21 agent 逐 finding 独立核验——14 缺陷确认全修/记档（2 HIGH 根治+回归锁）、2 误报驳回。
- **记档不阻塞**：ingest PENDING 抢锁根治 · TED CPV 前缀列+GIN 下推 · 投影上限游标化（缺口#8 同类）· license 值 SPDX 统一（随收口⑥ 权利词表）。

### 选项 B · 待办 3 首个身份源 UK Companies House（2026-07-11，PR #58，设计 [decision-maker-p1-companies-house-design.md](decision-maker-p1-companies-house-design.md)）

> 承接待办 2（#54）**兑现 `resolvePersonIdentity` 的 Tier 0 externalId 缝**：对 fit=match 英国公司 → CH 官方注册处取现任董事 → 高置信对齐公司 → `externalId(uk-ch-officer)` 走 Tier 0 精确并/新建；**同董事若也在 Impressum 出现→自动并成一条**（兑现待办 2 跨源合并）。

- 新 `adapters/companies-house.ts`（Basic auth CH client，经 ToolBroker 出网）+ `providers/companies-house.provider.ts`（`ContactDiscoveryAdapter`）；扩 `ProviderContactRecord.externalIds/license` + `contact-persist` 写 `external_id` 点/传 resolve；联系人发现改 **fan-out 全部 enabled adapter**（CH 与 decision_maker 并跑经缝合并，逐 adapter fail-safe）；seed `companies_house` data_provider（无 key 天然 no-op）+ source_policy。**无 schema 迁移**。
- 🔴 合规：**GB country 门**（非英不搜）+ 公司对齐 `pickBestByName` 0.9·margin（绝不挂错公司）+ **数据最小化**（只 name+role+officer_id，不摄 DOB/国籍/职业/住址）+ **§8.8 source_policy 用途门 fail-closed** + 董事 personalData + **OGL-UK-3.0** 署名穿透 field_evidence。
- **对抗复审**（PoC 单测在分支上实测复现）：抓 **2 HIGH 全修**——① Tier 0 缺反向守卫致同公司同名不同 officer_id 董事误并（加 `hasExternalIdConflict` 对称 email 守卫，Tier 2/3 拦冲突）；② GB 门 `.uk` 域名当辖区可绕过（`.uk` 2014 全球开放），改 country 优先（非英一律拒、`.uk` 仅缺国别弱兜底）+ 1 MED（fan-out 静默 catch 补 warn）。已核验安全：数据最小化/§8.8 门/公司对齐 margin/key 不泄漏/自足性（committed schema 构建通过，不依赖并发 storage-compliance WIP）。
- **实测**：build 0 · **610 vitest**（含错并回归）· 真库真 CH API `verify-companies-house.mts` 四段全绿（AstraZeneca 真拉 12 董事·对齐 1.00·Tier 0 二次幂等 merged=12·跨源与 Impressum 并一条·§8.8 去用途→拒→零联系人·无 DOB/国籍入库）。
- **遗留**：待办 3 后续源（专利 inventor USPTO/EPO、商标 EUIPO/WIPO；CH 扩德/法）——fan-out + Tier 0 缝已跑通，后续源同法接入。

## 2026-07-11 · 收口⑥ 存储合规 PR-B 删除编排（GDPR Art.17，六项工程收口最后一项完成）

设计见 [../implementation-records/storage-compliance-spec.md §8](../implementation-records/storage-compliance-spec.md)。承 PR-A #60（存储合规地基），本 PR 落地 DSR 删除编排，**满足收口⑥ 验收① DSR 全链演练 + ②「删除编排先于任何发送上线」时序门前置**——**六项工程收口至此全部完成**。

- **schema**：`deletion_request`（状态机 RECEIVED→FROZEN→ERASING→COMPLETED\|FAILED，租户 RLS，`stats` 持久化擦除计数）+ `deletion_receipt`（租户 RLS + **append-only** REVOKE UPDATE,DELETE + **FK onDelete RESTRICT** 防级联删绕过 + `REVOKE DELETE ON deletion_request`）+ 「同主体至多一条在途」**部分唯一索引**。
- **纯核**（+12 单测）：`deletion.types/state`(状态机)/`plan`(禁联项)/`snapshot`(最小化事件 payload)。
- **Temporal 三段编排 + 四活动（CAS 幂等）**：`freezeSubject`（定位擦除面 pre-deletion 快照 + 写 suppression_record 对外动作第一道闸 + **company 即标 SUPPRESSED**）→ `eraseSubject`（硬删 canonical_contact 级联 contact_point + 显式删 field_evidence(contact) + **擦除时刻重查 company 联系人捕漏网** + 受影响 ACTIVE ICP 发 QualifyRequested 重评分 + 同 tx 持久化 stats）→ `completeDeletion`（写回执 append-only + DeletionCompleted 事件同 tx + **取持久化 stats 写忠实回执、拒绝为未擦除请求伪造回执、CAS 收尾**）。
- **`DeletionService`**：受理 → **事务性 outbox 发 DeletionRequested** → relay dispatch 起 deletionWorkflow（Temporal 暂挂靠 relay 重试起，「受理即必然执行」）；`createRequest` catch P2002 → 复用在途请求（并发去重）。**`DeletionController`** `POST/GET /deletion-requests`（authN + RLS 隔离，**无 RolesGuard**=授权归 SaaS，R1 加固）。
- **outbox 注册** DeletionRequested(internal)+DeletionCompleted(integration) + 契约 `deletion-completed.v1.schema.json`。
- 🔴 **合规红线**：located 进 Temporal 历史 **PII-free**（只 uuid+计数，禁联邮箱仅 freeze 内部落库不外泄）；`source_signal` 是**平台共享零-PII 绿库** → 租户 DSR **不撤**（避免跨租户误删），signalsRevoked 恒 0；回执/事件**内容最小化**只计数 + 行 id 引用；receipt DB 层 append-only + FK RESTRICT 双护 GDPR Art.5(2) 问责证据。
- **质量**：TDD **682 单测**（12 新纯核）+ **真库 DSR 全链演练 31 断言全绿**（contact/company 主体 + 幂等 + 无 PII 残留 + RLS 隔离 + 并发去重 + 部分失败忠实回执 + append-only 护证 + 擦除完整性）+ **对抗复审（5 维·16 agent·逐条 adversarial 核验）6 findings（11 raised）去重 4 根因全修**：F1 部分失败伪造 0 回执（stats 持久化 + 拒伪造 + CAS）、F2 append-only 被级联删绕过（FK RESTRICT + REVOKE DELETE）、F3 createRequest 并发竞态重复请求（部分唯一索引 + P2002 复用）、F4 company freeze→erase 窗口漏网新联系人（freeze 即 SUPPRESSED + 擦除时刻重查）；驳回 HIGH「verify 不真跑 Temporal」（测试覆盖 gap 非可触发缺陷）。openapi 无 drift。
- **下一步**：R1 发送侧上线时联合校验「删除编排先于发送」时序门；细粒度 RolesGuard、consent_record(Art.21)、retention sweep 随 R1；`verify-deletion-orchestration.mts` 后续可补 Temporal 端到端（现活动级）。

## 2026-07-11 · 收口⑤ fast-follow：外部源 intent 投影 live 重读 DataProvider kill-switch（Codex #56 P1）

Codex 复审 #56（收口⑤ 一等 Signal）提 **P1 TOCTOU**：`temporal/external-intent.activities.ts` 的 `projectExternalIntentForIcp` 只认 sweep 头部 `listExternalIntentTargets` **捕获的** `tedEnabled/openfdaEnabled` 标志。摄取活动 `ingestExternalSignals` 已逐指纹 `liveEnabled` 重读 `data_provider`，但投影此前只受**捕获门**——若 provider 在捕获之后被 ops 置 DISABLED（`DataProvider.status`=Kill Switch 执行点），投影仍会把缓存 `source_signal` 投进本租户 canonical **造新线索**，绕过摄取侧的 live kill-switch（原 verify Tier 5 只喂 `tedEnabled=false` 走 trivial 分支，从未覆盖「捕获=true 但 live=DISABLED」的真缺口）。

- **修**：`projectExternalIntentForIcp` 投影前 `liveEnabled()` 重读 `data_provider`，`tedOn = 捕获标志 && live.ted`（openfda 同），对齐摄取侧逐单元重读纪律——provider 中途下线本轮即不投影。kill-switch 自此是**非破坏性「停一切新活动（含新线索）不脱敏存量」**闸，填补 SUSPENDED（太软·仍投）与 `revokeByProvider`（太硬·脱敏存量）之间的空档。
- **刻意不做**：**不**在投影加 `source_policy` SUSPENDED 门。SUSPENDED=**停采不停用**（egress-only，见 [../architecture/current.md](../architecture/current.md) §5 两级撤停语义）——停「用」存量信号的正解是 `revokeByProvider`（翻 REVOKED，投影已按 `status='ACTIVE'` 剔除）。在投影加 SUSPENDED 门会违背该设计。Codex 建议「re-check live provider state」被采纳（=DataProvider kill-switch）；「skip cached signals while suspended」按两级语义驳回并说明。
- **实测**：build 0 · **673 vitest**（新增 `external-intent.activities.spec.ts` 3 测：捕获 true+live DISABLED→跳过该 provider / 双 ENABLED→均投 / 双 DISABLED→全跳）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加 **TOCTOU 断言**：喂过时 `tedEnabled=true` + `data_provider` DISABLED → 投影 live 重读 kill-switch，TED 仍跳过；Tier 4 正路 64 信号→50 买方 canonical 不受影响）。**无 schema 迁移**。

## 2026-07-11 · 待办 2 create 层收尾：createContact 尊重 resolve 拒并（#54-D/#54-E / Codex #62-2/#62-3）

> Codex 复审（PR #62 P2 + 重开 #54 P1）暴露待办 2 遗留缺陷：`resolvePersonIdentity` 的合并守卫被 `persistDiscoveredContacts`→`createContact` 的 `contactIdentity` **键控 upsert 旁路**——resolve 明确「拒并」（同名歧义 / RISKY 猜测邮箱）返 null 后，create 层仍按键相同的旧行 upsert，把新记录并回错行，令拒并形同虚设。**先合入 #62（resolve 层拒并的另一半，含 Tier 1 RISKY 跳过 + Tier 2 唯一才并 + external_id 不算可达），再补 create 层**（本 PR）——两半齐落才真正闭合误并。

- **`resolvePersonIdentity` 返富结果 `{hit, ambiguous}`**（`person-identity.ts`；`resolveAmongCandidates` 保留为薄封装、签名与其 ~25 单测不变）：`ambiguous`=因**同名歧义**拒并（Tier 2 ≥2 合格同名候选 / Tier 3 高分但 margin 不足），**与 DB 当前占位无关**（只看候选语义）——这是幂等的关键（见下）。
- **`createContact` 拒并键**（`identity.ts` 新纯件 `declinedContactIdentity` + `contact-persist.ts` 守卫）：resolve 返 null 时，若 `ambiguous || 明文键（盲值）与既有**不同**联系人碰撞`（`findUnique` 探测，同 tx 读己写），改用**不碰撞确定性拒并键**新建独立行——`dx:` 命名空间与明文 `e:`/`c:` 互斥、按 `companyKey` 隔离；判别符优先级 **externalId `dx:x:<ck>:<scheme:value>` > 可信 email `dx:e:<ck>:<归一名>:<email>` > 人名 `dx:c:<ck>:<归一名>`**。可信 email=明文键 `e:<email>` 未被占用（非 catch-all/RISKY 共享地址），占用则退回人名。拒并键盲化落库（复用 #65 `blindContactKey`，去 PII 明文）。
- 🔴 **绝不错并**：同名不同 externalId（HIGH-1）/ 同址不同名（catch-all，#54-E）/ **同名不同 VALID 邮箱**（名+邮箱双判别符）三类全分开。**同源再跑幂等**：`ambiguous` DB-state 无关 + 拒并键确定性 → 二次跑落回同一行、不生重复（纯碰撞探测会在「歧义但来件明文键恰空」翻键生第三/四行，故 `ambiguous` 信号必需）；正常合并/新建路径行为逐字不变（EPO/CH verify 二次跑 created=0 不破）。
- **质量**：TDD **725 vitest**（新增 `declinedContactIdentity` 单测 + `createContact` 歧义/RISKY/误并回归 + `resolvePersonIdentity` `ambiguous` 信号）· build 0 · 真库真 RLS 真盲化 `verify-contact-decline-honor.mts` **三场景全绿**（① RISKY 同址不同名新建+二次跑幂等 ② 歧义无邮箱新建独立行+二次跑不生第 4 行 ③ 同名不同邮箱各自成行+二次跑幂等）。**对抗复审 3 维（误并 / 幂等 / 集成完整性，逐条 adversarial + 修后再攻）**：误并维抓 **1 HIGH**（`dx:c` 只按名致同名不同 VALID 邮箱塌键=净新误并）→ 补 email 判别符 → 再攻确认闭合 + 补**名+邮箱双判别符**闭合「不同名共用 catch-all」残余（LOW）；幂等维 5 场景全幂等；集成维 6 类（ripple/blinding/regression/completeness/tx/test）全净。**无 schema 迁移**。#62 的 2 条 Codex 线程已回复「create 层于本 PR 修」并 resolve。

## 2026-07-11 · 收口⑤ fast-follow²：外部源 intent 投影 kill-switch 单次重读优化（承 #64）

承 #64（Codex #56 P1，投影每 ICP `liveEnabled()` 重读 DataProvider kill-switch）。#64 的 per-ICP 重读正确但每 ICP 一次 owner-DB 读；本 PR 把它降到**每 sweep 一次**，同时**不丢活动自守与任何既有保证**（保严格性优化，非「移守卫出活动去信任调用方」的降级式改法）。

- **workflow 单次读 + thread**：`externalIntentSweepWorkflow` 摄取后调**一次** `liveProviderState()`（新活动=`liveEnabled()` 薄封装），把 `LiveProviderState` 快照 thread 给逐 ICP `projectExternalIntentForIcp`。取「投影阶段开始前一刻」的 live 态——覆盖 #64 关掉的**主窗口**（sweep 头部捕获→摄取全程分钟级 egress→投影开始），残留仅投影循环自身（零出网、下轮自愈）。
- **投影活动保留自守（防御纵深）**：`projectExternalIntentForIcp` 新增可选 `live?: LiveProviderState`，`const live = args.live ?? await liveEnabled()`——**注入优先**（省读），**缺省自读兜底**（直连调用者=测试/verify/未来调用不被信任，#64 的 TOCTOU 断言与单测零改动仍绿）。仍逐 ICP AND 各自捕获标志（捕获=false 者无论 live 都不投）。workflow 单次读失败 fail-safe→undefined→投影自读兜底（一次读故障不放大成整轮不投）。
- **刻意仍不做**：`source_policy` SUSPENDED 门不入投影（停采不停用，见 §4/#64）。
- **实测**：build 0 · **759 vitest**（新增注入快照 4 测：注入门控且零自读 / 注入优先 / 捕获标志不被绕过 / 缺省自读兜底）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加：`liveProviderState` 单次重读 + 「data_provider ENABLED 但注入 live.ted=false → 投影用注入快照跳过 TED」证明非自读）。**无 schema 迁移**。

## 待办 3 第二源 · 专利发明人 BigQuery Google Patents（替代被封 EPO OPS）

- **背景**：EPO OPS（PR #61）账号被网关封停、PatentsView 卡 ID.me 美国身份墙 → 专利发明人源改走 **BigQuery Google Patents Public Data**（`patents-public-data.patents.publications`，IFI CLAIMS 谐调）：仅需 Google 账号，**无审批/无身份墙/无封号风险**，1TB/月查询免费。
- **DRY 源无关移植**：provider（`bigquery-patents.provider.ts`）几乎原样移植自 #61 `epo-ops.provider.ts`——那套护栏源无关，只换 L0 数据客户端（EPO OPS REST → BigQuery）。保留：applicant 高置信对齐（0.9·margin 0.1）+ 归一名去重候选 + **只取独家申请人专利**（防合著误挂）+ 国别门 + 近 5 年·cap 25 + **归一名并（非 Tier 0，无 externalIds）**。
- **L0 adapter**（`adapters/bigquery-patents.ts`）：`assigneeLikeAnchor` 宽预筛锚（provider 再精确对齐）+ `buildQuery` 只 SELECT 2 列 + **`maximumBytesBilled` 成本硬顶**（默认 200GB，超顶即 fail-closed，护免费额度）+ `normalizeRow` 🔴 **数据最小化**（inventor 只留 name，丢 country_code）+ 无 SA key/project → 天然 no-op 返空。
- **合规**：`google_patents.search` = required 工具（personalData=true，policyDomain `bigquery.googleapis.com`，§8.8 用途门 fail-closed）+ CC-BY-4.0 署名写 `field_evidence.license`（⚠️ ENABLE 前核实确切 attribution 文案）+ SA key 文件 gitignored（`.env.example` 记 `GOOGLE_PATENTS_SA_JSON`/`_PROJECT`/`_MAX_GB`）。
- **⚠️ 规模警示**：publications 表无 assignee 分区 → 每查全表扫描（约数十 GB/查）→ 适合有界样本/周期 sweep，不适合高频实时逐公司；生产规模 fast-follow = 物化「assignee→inventor」小表。
- **seed DISABLED**：`google_patents` data_provider 种 DISABLED（真库真测待 GCP key），`bigquery.googleapis.com` source_policy APPROVED（供 verify 过 §8.8 门）。verify 脚本直 new Provider 跑，DISABLED 不挡真测；生产 fan-out 不路由（无静默错采）。
- **质量**：build 0 · eslint 0 · **909 vitest**（新增 33：adapter `assigneeLikeAnchor`/`normalizeRow` 数据最小化/成本护栏 env+默认路径/无 creds fail-safe + provider 全护栏移植测）。**无 schema 迁移**（新增依赖 `@google-cloud/bigquery`）。EPO 代码 PR #61 留档 DISABLED。
- **✅ 真库真 BigQuery 四段 verify 全绿**（2026-07-14，用户 GCP key，无 sandbox）：A 真 API Siemens(DE)→**25 名真实发明人**六护栏全绿；B 落库 25 + person.profile CC-BY-4.0 署名/personal_data、无 external_id 点、二次幂等（created=0/merged=25 Tier 2 归一名）；C 跨源并 match_rule=name_exact；D §8.8 用途门 DENIED 零发明人。对抗复审 APPROVE（0 CRITICAL/HIGH，1 MEDIUM「MAX_GB=0 静默默认」+ 2 LOW 均已收）。
- **⚠️ seed 仍 DISABLED（刻意）**：verify 证明源可用，但 publications 无 assignee 分区 = 每查全表扫（数十 GB）→ 生产逐公司 fan-out 会快速吃光 1TB/月免费额度。**生产启用 = 物化「assignee→inventor」小表 fast-follow**（scale-safe），非直接翻 ENABLED 全量 fan-out。


## 2026-09-20 · Production audit baseline refresh for Windows migration

2026-09-20 锁文件更新后的重审绑定 `6213baf2715f0680f05024bee0994e8593403433`：官方 registry 的 production audit 覆盖 845 个依赖，所有严重度计数均为零。旧绑定对当前锁文件返回 `BASELINE_SOURCE_LOCK_MISMATCH`；刷新来源提交、锁文件摘要和采集时间后，同一份审计返回 `FRESH`。原失效时间、零例外策略和 verifier 保持不变；后续锁文件变更仍须重新审计，不能复用本次通过结论。

同日 main 合入配对 S3 依赖更新后，再以干净提交 `1aaa1a779bbf716f301e5f08c7f3d0ad37eeaacc` 对官方 registry 重审，仍为零公告；刷新当前绑定并保留原到期时间。同一审计在旧绑定下失败，在新绑定下返回 `FRESH`。

同日 main 合入AI SDK 依赖更新后，再以干净提交 `03e8ada02010052bf4220e1063d2c5c987bf1f8a` 对官方 registry 重审，仍为零公告；刷新当前绑定并保留原到期时间。同一审计在旧绑定下失败，在新绑定下返回 `FRESH`。

原始审计和新鲜度回执保存在[冻结证据](../evidence/security/20260920-baseline-refresh.json)。本记录不证明镜像已发布、运行部署完成或当前主线永远满足基线。


2026-09-20 工具链候选重审：源码 `728fbf8eaab86f24182cffe1cccdfb5fbaa7e16c`、锁文件 `sha256:3fa4365cd8f83ba44680fa94e1f3c336a5c94eb055065a0b1eae38ab97333787`，官方production audit共872依赖、零公告；同一审计在旧绑定下HOLD，刷新来源和采集时点后FRESH。原有效期不变，前后回执见[工具链重审证据](../evidence/security/20260920-tooling-baseline-refresh.json)。
