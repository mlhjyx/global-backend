# 获客渠道身份质量摘要

> 状态：隔离分支实验能力；尚未提交、发布或部署。

渠道开关、成本、许可和调用闸门继续使用现有 Provider Registry。这里不建立第二套渠道管理，只在一次采集运行的现有 `DiscoveryRun.stats` 中补充可核验的身份质量事实。

## 读取位置

`GET /api/v1/discovery-runs/:runId` 返回：

```json
{
  "stats": {
    "identityQuality": {
      "wikidata": {
        "acceptedRows": 18,
        "namedRows": 18,
        "domainRows": 18,
        "authorityIdentifierRows": 18,
        "officialRegistrationRows": 3,
        "boundRows": 18,
        "uniqueCompanies": 18,
        "conflictRows": 0,
        "suppressedRows": 0,
        "replayedRows": 0
      }
    }
  }
}
```

## 字段口径

- `acceptedRows`：通过 Raw Source 接收门、进入身份解析的记录数。
- `namedRows` / `domainRows`：具有可用企业名、官网域名的记录数。
- `authorityIdentifierRows`：带有该 Provider 获准声明的权威标识的记录数，例如 Wikidata QID。
- `officialRegistrationRows`：带 LEI、SIREN、UEI、FDA registration、Companies House number 或 TED national id 的记录数。
- `boundRows`：成功绑定到企业身份的记录数。
- `uniqueCompanies`：本次该 Provider 实际指向的唯一根企业数。
- `conflictRows`：强标识相互矛盾、已停止自动绑定并进入人工裁决的记录数。
- `suppressedRows`：被现有 Suppression 规则拦截、未物化为可用客户的记录数。
- `replayedRows`：同一 Raw 与解析输入被幂等重放的记录数。

这些数字衡量的是数据完整性和身份解析结果，不等于“销售线索准确率”。渠道是否真的找对目标客户，必须由具体 ICP 的 fit 判定和后续人工接受/拒绝反馈计算，不能用字段齐全率替代。

## 本机真实试点证据（2026-08-12）

受控条件为 Wikidata、德国、manufacturing、单次上限 25。真实运行返回 18 条记录；第三次运行通过 API 返回上面的质量摘要。重复运行保留新的 Raw 审计快照，但企业池仍为 18 家，活动强标识未重复，身份冲突为 0，未获得 fit 判断的企业没有生成 Lead。

该证据只证明本机 PostgreSQL、Temporal、Outbox Relay 和真实 Wikidata 调用下的有限样本行为，不代表生产部署，也不能推导 Wikidata 对所有行业查询的语义准确率。

## 官网业务证据前置金丝雀（2026-08-12）

此轮没有新建渠道，而是把已登记的 `digital_footprint` 官网富集源放到 ICP 资格判定之前。前置路由仅选择 `wikidata` 与 `digital_footprint`，单次最多处理 5 家；GLEIF 和招聘/站点结构收割仍保留在后续阶段。

`digital_footprint` 先经 ToolBroker 调用 Crawl4AI 渲染官网；渲染器不可用时，可经同一 ToolBroker 降级为静态 `http.get`。降级仍受 robots、SSRF、source policy、suppression 和预算闸门约束；合规拒绝不得触发备用通道。只有官网 Product JSON-LD 解析成功时，`digital_footprint.structured_products` 才会作为材料/产品、企业角色和工艺判定的可引用证据。v2 不据产品名自动推断商业模式；v3 也只接受 Product JSON-LD 中明确的 `manufacturer`、`seller` 或类型为 `Offer/AggregateOffer` 的报价节点，品牌字段或普通文案单独出现仍不算商业模式证据。

真实单企业运行 `4f261c2c-d913-4a73-9487-9cbfb66c4b86` 完成了 Wikidata 发现、Identity 绑定、官网取证尝试和 fit 判定。标的 `European Semiconductor Company / esmc.eu` 的官网对实验机返回 Cloudflare 403 challenge，因此系统没有落库任何 `digital_footprint` 产品证据，也没有把拦截页当成业务事实。新建实验 ICP 下的 Lead 结果为 `weak / insufficient`，AI trace 计数在运行前后均为 58，证明本次负向路径未发生模型调用。

这是“失败不误报”的真实验收。随后的正向 Provider 金丝雀使用 Fireball Tool 官网：现有 sitemap 收割器返回 490 个同站 URL，新增选择器只尝试前 3 个具体产品页，并在第 3 页成功解析 `Plate Leveling Fastener (1 Stud)`。结果绑定官方产品页 `https://www.fireballtool.com/products/plate-leveling-fastener-1-stud`、SHA-256 内容指纹 `e1eb10764aff59f74b0f621f772b3e6bd5cc18e88dcff35030cd26ee6e5659ab` 和解析器 `digital-footprint/v2`。

正向验收经真实 ToolBroker 和公开官网执行，不是 mock；但它是 Provider 级验收，尚未冒充“Fireball Tool 已经全链路写入 Raw/Canonical/Lead”。全链路持久化需由一个真实发现源先产生该企业，不通过手工伪造 Raw 记录来充数。

随后使用 Böker 完成真实持久化闭环，运行 ID 为 `2bcca62e-9039-4f20-8bed-4553175586d3`。查询计划使用 Wikidata 已核验的窄行业标识 `Q1436188`，预检和正式运行都只返回 `Böker / boker.de / Q5005154`。正式工作流产生 1 条 `raw-source/v2` Raw、1 个活动 Identity v2 链接、活动 domain 与 Wikidata QID 标识、1 家 CanonicalCompany，以及官网产品页解析出的 `Little Dvalin Tanto` 证据。产品证据的来源页为 `https://boker.de/products/little-dvalin-tanto-02bo034`，内容指纹为 `e5f3e3f8e36abd20b67f18087f498183f6dc56a06d7be0dad8725006da2d2732`，成本为 0。

该 Lead 最终为 `weak / needs_review`，原因是来源证据覆盖了材料、角色和工艺，但没有覆盖商业模式；系统因此没有调用模型、没有发布 `LeadQualified`。AI trace 总数保持 58。`DiscoveryRunRequested` 与 `DiscoveryRunCompleted` 均由 Outbox Relay 写入 `publishedAt`，完成事件已建立 SaaS pull delivery，状态为等待消费者 ACK。这里的闭环证明客户数据真实进入 Raw、身份、企业、证据和 Lead，并证明 Outbox 运行正常；它不冒充“已产生合格商机”或“SaaS 已消费”。

实跑还暴露出一个审计噪声：空的 `discovery_match.industries: []` 曾被包装成证据引用。打包器现已拒绝空字符串、仅空白字符串和空数组，避免无内容字段占据资格证据位置。

## 官网显式商业模式证据 v3（2026-08-12）

`digital-footprint/v3` 在原 Provider 内增加 `business_model` 事实，不新增渠道。输出值只可能来自三类明确结构：`manufacturer:<name>`、`seller:<name>`、`official_product_offer`。其中引用 `@id` 的 Organization 会在同一 JSON-LD 图内解析；仅有 `brand`、Organization 类型、价格文案或页面标题时一律不产出。旧企业已有 v2 产品证据但没有 `fit_evidence_version=digital-footprint/v3` 时，会在下一次资格门前取证中懒升级，同时保留原数字足迹信号。

零费用真实 Provider 验证再次读取 Böker 官方产品页，得到 `structured_products=["Little Dvalin Tanto"]`、`business_model=["official_product_offer"]`、解析器 `digital-footprint/v3`，来源 URL 与内容指纹仍分别为 `https://boker.de/products/little-dvalin-tanto-02bo034` 和 `e5f3e3f8e36abd20b67f18087f498183f6dc56a06d7be0dad8725006da2d2732`。该页面没有被解析出 manufacturer 或 seller，因此系统没有补造这两项。调用成本为 0，AI trace 前后均为 58。

本轮没有执行 Böker 的完整 Discovery 重放：v3 已使四道资格证据具备进入模型判断的条件，真实重放可能调用已配置的 Gemini。依照费用闸门，在明确模型价格、单次上限、请求上限、结算方式并取得用户费用授权前，停在 Provider 真实验证，不把“代码可调用”冒充“已获付费执行授权”。

## 夜间收口与真实重放（2026-08-13）

用户随后明确授权一次有界付费重放：仅 Böker，模型 `gemini-3.5-flash`，最多一个物理调用，不自动 repair，run 与 fit 单次预算上限均为 10 美分。首次运行 `fb058ae7-2630-4426-bf8e-f55bf9c37da3` 确实发出一个模型请求；网关返回 2,317 input tokens、533 output tokens，因当时输出上限 512 且 `finish_reason=length` 导致 JSON 截断。系统没有持久化 fit verdict，也没有生成 Lead 或 `LeadQualified`。NewAPI 未返回 `costUsd`；本地保守账本按 2,850 tokens 结算 1 美分，但这不是上游账单回读。

该失败暴露出运行真实性缺口：工作流曾把“fit 无结果”收成 `DONE + failures=0`。现已修复为单家公司模型失败显式增加 `fitFailures`，并让已有采集数据的 run 进入 `PARTIAL`；截断、超时、schema 失败和 stub 都不得伪装成功。

提高输出上限前，代码审查同时纠正了一项名单纯净度问题：产品名、行业和 `structured_products` 不再自动证明企业具备生产工艺，只有明确的 process/capability/manufacturing-process 来源字段才能支持 process gate。随后运行 `0a5dba75-bc1d-40ad-a175-b098d71c585e` 再次只发现 Böker 一家公司，产生 1 条 Raw、成功绑定现有 Identity 根、身份质量冲突为 0，并输出 `weak / needs_review`。原因是已持久化证据覆盖产品、角色和官方报价商业模式，但没有明确 process 来源。该运行的 AI Trace 增量为 0，证明 2,048 token 的一次调用额度没有被消费；系统在缺证据时停止，而不是为了跑通模型补造工艺事实。`DiscoveryRunRequested` 与 `DiscoveryRunCompleted` 均已发布，SaaS pull delivery 为 `PENDING`，尚未 ACK；没有 `LeadQualified` 是正确结果。

Identity v2 同期完成以下安全收口：split 只在 replay 投影恢复成功的最后一步撤销 mapping，失败整笔回滚；Replay 使用租户级事务锁、锁后重读和 CAS，避免双 Worker 重复执行；身份、冲突、mapping、replay 与 Raw 审计事实撤销 `app_user DELETE` 并有数据库删除 guard；未知 Provider 不再默认获得 domain 身份权限；产品深层页逐 URL 检查 robots；identity group 内同一 ICP 只复用唯一 Lead，重复事实 fail closed。

独立本地 PostgreSQL 验收库 `global_identity_v2_acceptance_20260813` 从空库真实执行 85 个迁移，Prisma schema diff 为零；`app_user` 的 workspace A/B/unset RLS、跨租户写拒绝、owner/app_user 删除保护、append-only decision、mapping root guard 和两个并发会话争抢同一活动强标识均通过。该证据只属于 Mac 隔离实验环境，不替代 Ubuntu `/global/backend` 正式验收。

## 获客主线收口（2026-08-13）

本轮没有建立第二套渠道管理，也没有新增外部 Provider。改造继续复用现有 Provider Registry、DiscoveryRun、ToolBroker、RawSourceRecord、Identity v2 和 Outbox，只补齐三个原链路中的缺口。

第一，受监控来源的 `SourceEntity` 现在可以带着它实际来自的 `SourceFetch` 进入 Raw 与 Identity 投影。系统只接受已完成或部分完成、解析器和完成时间吻合的精确 fetch；来源停用、非企业实体、历史来源关系含糊或事实漂移都会失败关闭。相同内容在新的 fetch 中仍保留新的 Raw 观察快照，旧 Raw 过期不会永久堵塞新观察。

第二，已完成或部分完成的发现运行可以请求下一轮搜索建议：`POST /api/v1/discovery-runs/:runId/adaptive-query-plan-suggestions`。建议只读取已经持久化的运行统计和原计划，最多按既定轮次生成一个 `DRAFT`；不会直接转成 READY、不会自行执行、不会调用模型或外部渠道。服务端自行推导轮次并校验完整 trace，重复 source class、统计缺失/多余、客户端伪造轮次或修改既定轮次上限都会返回冲突。

第三，渠道执行结果新增不可改写的质量贡献账本，并由 `GET /api/v1/provider-quality-rankings` 提供只读窗口排名。每个真实尝试过的 Provider 都会入账，包括零结果和全失败；系统分别给出绑定率、身份冲突率、失败率和重复率，不制造一个难以解释的综合分。样本量不足或指标事实缺失时不排名，因此管理端不能把“字段齐全”误称为“获客最准”。

主代理合并验收覆盖 acquisition、discovery、ICP、Temporal、健康检查、Relay 和 Lead 共 77 个测试文件、790 条测试，全部通过；API、Contracts 和 Prisma schema 编译/校验通过，OpenAPI Spectral 为 0 error。最终本机 PostgreSQL 实验库显示 89 个迁移全部完成、0 个未完成，渠道质量表已启用并强制 RLS，包含运行归属、唯一性和事实一致性约束。macOS 治理测试为 59/60，唯一失败仍是仓库既有测试依赖 Linux `/proc/self/fd`，需留待 Ubuntu 正式环境验证。

上述能力仍只存在于 `codex/goodjob-acquisition-integration` 隔离工作树，未暂存、未提交、未推送、未部署，也未修改 `main`。下一阶段若开始真实渠道试点，应继续通过现有 Provider Registry 接入一个来源，并用这里的 Raw、Identity、质量账本和人工确认边界验收，而不是复制 GoodJob 的 CRM 或另起评分体系。

## 第一批新增官方渠道（2026-08-13）

> **历史阶段快照，已由后续实现覆盖。** 本节记录 2026-08-13 当时的范围；其中对 ROR、SEC EDGAR 与 USAspending 的“未注册 Tool/seed、不可路由”描述不再代表当前状态。当前实现与真实运行边界只认 [`docs/status/current.md`](../status/current.md) 和 Provider Registry；保留本节仅用于历史 provenance。

本批没有新增第二套渠道后台，而是把确认缺失的来源接入现有 `Provider Registry → ToolBroker → RawSourceRecord → Identity v2 → 质量账本`。运行时代码新增 7 个 Provider：法国官方组织搜索、NPPES、World Bank Procurement、UK Find a Tender、Brazil PNCP、Singapore GeBIZ 和 UK Contracts Finder。ROR、SEC EDGAR、USAspending、DENUE 与 FMCSA 仍停留在审计或设计层，没有注册 Tool、没有 seed、不会被路由执行。

默认状态遵循“先窄后宽”：法国官方组织搜索、NPPES、World Bank 与 UK Find a Tender 为 `ENABLED`；Brazil PNCP、Singapore GeBIZ 与 UK Contracts Finder 为 `DISABLED`。GeBIZ 只有历史中标供应商，且尚未从客户 Lead 主链分流到独立研究投影，因此当前不允许运行；World Bank 与 PNCP 只返回采购方或实施机构；英国两个 OCDS 来源默认只返回仍处 planning/tender 阶段的 buyer，只有显式供应商研究才返回 awarded supplier。

所有新网络客户端都有超时、响应体上限、分页上限、HTTPS 官方域名与精确 API 路径重定向白名单；每次物理请求和重定向都重新经过 ToolBroker 的来源策略检查。provenance 使用最终真实 URL、抓取时间、解析器版本和实际响应正文 SHA-256。法国与 NPPES 只持久化组织白名单字段，负责人、authorized official、电话、邮箱、街道和邮编不进入企业记录。精确 SIREN/NPI 查询还会核对响应编号，拒绝相似搜索结果冒充精确身份。

真实公共接口金丝雀在 `2026-08-12T19:48:38Z` 完成，单渠道最多 5 条、无数据库写入：

- France：5 条，样本为 Schneider Electric 组织记录；真实 URL、响应哈希和解析器版本齐全。
- NPPES：5 条，只接受 `NPI-2`，样本为 Mayo Clinic 组织记录；NPI-1 和个人联系人字段不投影。
- World Bank Procurement：4 条，样本为 WSTF Wajir/Mandera Sub-PIU，角色固定为采购方/实施机构。
- Singapore GeBIZ：5 条，样本为历史中标供应商；只用于显式供应商/竞品研究。
- UK Find a Tender、Brazil PNCP、UK Contracts Finder：官方接口可访问，但本次关键词与首批窗口经本地角色/关键词过滤后为 0 条，记为 `ZERO_RESULT`，没有冒充成功获客。

随后使用最新编译产物恢复本地 API、Worker 与 Outbox Relay。`GET /api/v1/health/ready` 返回 ready，数据库、Temporal control plane、Worker PostgreSQL heartbeat、Outbox Relay heartbeat 与 admission 全部为 ok。实验库可直接查到 7 个 Provider seed 与 7 个 `APPROVED/api` 来源策略；Provider 状态与上述默认值一致。

最终定向验收中，新增渠道与身份/工具/治理组 11 个测试文件、94 条测试通过；Identity、Raw、质量账本、自适应搜索、Temporal 回放与健康心跳主链 27 个测试文件、183 条测试通过；API 构建、定向 ESLint 和 `git diff --check` 通过。采购复审另覆盖游标快照、官方数字时区、非法日期、非法角色、无 Content-Length 超限和重定向逐请求复核。全量治理仍为 59/60，唯一失败是 macOS 不存在 Linux `/proc/self/fd` 的既有环境兼容测试，不能写成全量治理通过。

NPI-2 仍可能代表医疗组织 subpart，不可单凭 NPI 宣称跨来源法律法人合并。采购渠道的编排分页与真实租户持久化限制已在下节收口。

## 采购安全翻页与 World Bank 真实租户试点（2026-08-13）

`DiscoveryResult` 现可返回仅供运行时使用的 `nextCursor`。查询计划中的 `cursor`、`page`、`offset` 及下划线变体不会被当成续页状态；续页只能来自上一次受信 Provider 响应。每个 Provider 最多连续读取 3 页，单查询最多保留 25 个去重组织，重复、超长或含 NUL 的游标失败关闭。第二页之后失败时保留前页 Raw，但运行标记为 `PARTIAL`；首次请求失败仍按 Provider 失败处理。多个 Provider 之间继续并行，单个 Provider 的页序列保持串行，避免页快照乱序。

最终 v3 库真实试点创建了随机隔离 workspace `c85656d8-242a-4adb-842a-c18d5f1c64e0`，ICP 为“Kenya public water infrastructure buyers”，运行 ID `097c5aa3-3dce-4520-bd9e-a742a6064c46`。Temporal Worker 经 ToolBroker 访问 World Bank 官方接口，共实际读取 3 个 URL（offset 0、25、41），持久化 12 条 `raw-source/v2` Raw 和 12 个活动 IdentityLink，归并为 7 家 CanonicalCompany，并为该 ICP 建立 7 条 Lead。样本包括 Ministry of Water, Sanitation and Irrigation、Coast Water Services Board、Tavevo Water and Sewerage Company Ltd 及四个 WSTF County Sub-PIU。Provider 质量账本记录 accepted=12、bound=12、conflict=0、failure=0；AI Trace 增量为 0。

该运行终态为 `PARTIAL`，不是渠道报错。原因一是达到三页安全上限且仍有后续游标，`paginationTruncated=true`；原因二是公告只提供组织名和国家，缺少域名与官方注册号，7 条 Lead 均为 `weak / needs_review`。Outbox Relay 随后发布 `DiscoveryRunCompleted` 与 `QualifyRequested`，`LeadsScored` 已落库，7 条 Lead 的确定性总分均为 0.345。系统没有生成 `LeadQualified`，也没有把弱证据包装成推荐客户。

实跑还暴露并修复了旧实验库的 Provider 质量账本迁移漂移。前向升级现在会在单事务内临时移除 UPDATE 不可变触发器，仅从父 `DiscoveryRun.stats.perProvider` 的完整八项事实精确回填，随后恢复触发器、FORCE RLS、对称租户策略和最小权限。无法精确还原的旧行明确失败关闭，不会猜成成功运行。事务级 PostgreSQL 验收覆盖干净库顺序迁移、旧表完整事实精确升级、不可变触发器恢复，以及不完整历史事实拒绝升级。

本轮新增定向回归：分页与工作流 57 项通过；渠道、Identity、Raw、质量账本、Relay 和健康主链 103 项通过；迁移安全修订后的关键组合 73 项通过。API、Worker 与 Outbox Relay 保持在线，`/api/v1/health/ready` 再次返回全部组件 `ok`。以上仍是 macOS 隔离实验，不替代 Ubuntu 或生产验收。

第二个对照试点使用法国官方组织名录，最终 v3 随机隔离 workspace 为 `37959c6e-5c1a-4301-9174-1fc796f2ddce`，运行 ID 为 `659484ba-8ceb-471f-8f15-baf8c1b9ed47`，查询 `Schneider Electric`、上限 10。运行终态为 `DONE`，真实写入 10 条 Raw、10 个活动 IdentityLink、10 家 CanonicalCompany 和 10 个由 `fr_company` 声明并经 `siren-v1` 校验的活动 SIREN，身份冲突与 Provider 失败均为 0。质量账本记录 accepted=10、bound=10、authorityIdentifier=10、officialRegistration=10。

## 名称企业身份补全闭环（2026-08-13）

本轮没有新增渠道，而是把现有 `Wikidata + GLEIF + digital_footprint` 接成一条安全的资格前置链。Wikidata 与 GLEIF 不再允许纯名称绑定强身份：输入国家先统一为 ISO alpha-2，候选国家必须一致；同国完全同名多候选仍按歧义拒绝。GLEIF 即使首轮带国家查询为空、退回名称检索，也只保留与输入国家一致的实体。Wikidata 官网域名只有通过上述身份门后才作为 `domain` 强标识提交。

提交边界先执行现有 suppression 与 Identity v2 冲突保护，再在企业主档 `domain` 为空时补齐域名；已有非空域名不覆盖，旧 `dedupeKey` 不修改。同一 workspace 内已有其他根企业持有相同 legacy domain，或当前身份组已有不同域名时，建立确定性身份冲突并停止提交。资格前置富集改为逐源提交：Wikidata 安全补出的域名可以在同一轮交给 `digital_footprint`，随后才进入 fit 判断。

最新真实对照运行使用最终 v3 实验库。World Bank workspace `175b61ea-f543-4feb-92da-e92d2dfab562`、run `80cdd087-2983-4f0a-b5bb-fbd61f553647` 保持安全负向：12 Raw、7 家企业、0 Provider failure，但 5 家资格前置样本均未得到足够身份证据，因此没有写 domain/QID/LEI。单独查询 `Tavevo Water and Sewerage Company Ltd` 的 Wikidata 官方搜索结果为空，证明该源在该样本上确实没有可用候选，不能把缺失数据包装成命中。

法国旧实验 workspace `04261c89-8084-48f2-9dd8-556f3ad80002`、run `4dbcf774-3ca4-446e-b619-eec1f238d29f` 暴露出不能验收的误配：SIREN `803086586` 的 `SCHNEIDER ELECTRIC` 曾因同名被补入属于 `SCHNEIDER ELECTRIC SE` 的 `se.com`、LEI `969500A1YF1XUYYXS284` 与 Wikidata QID `Q49053`；同一批数据中后者的官方 SIREN 实为 `542048574`。`conflict=0` 只说明旧解析器没发现问题，不代表身份正确。该实验数据保留作失败审计，不再作为正向证明。

修订后，Discovery 主链、存量 Backlog 与信号富集都会聚合根企业及活动别名上的全部活动强标识后再调用 Provider。Wikidata 对已有 SIREN/LEI/QID 必须逐值吻合；GLEIF 若只看到另一官方注册号而没有权威交叉表，就不再凭名称新增 LEI。未知注册号方案同样失败关闭。域名冲突比较覆盖 `https://www.Example.com/path` 等旧格式，并通过租户级规范化表达式索引查询，不逐企业拉取整张表，也不新增投影列或回填历史企业。suppression、Identity graph、canonical rows 与 identifier 的锁顺序统一；merge、split、Replay、Raw resolver、富集提交和租户投影共享租户级身份锁。外部调用前读取根、别名与活动标识的确定性快照，提交时在锁内重新计算；期间发生任何 merge、split 或标识变化都会拒绝旧结果写入。资格前置的逐源提交成功后会刷新标识与快照，再调用下一来源。域名提升另以 `domain IS NULL` CAS 收口。富集新增标识保存来源 URL、抓取时间、内容哈希和解析器版本。

最终锁序与 Backlog 修订后的全新法国隔离 workspace `ae1d41db-991f-4f36-ace5-dd3966d9b76a`、run `a5c024d4-c6ac-4813-bccd-4aa154fcf8b0` 重跑终态为 `DONE`：10 Raw、10 活动 IdentityLink、10 家 CanonicalCompany、10 个经 `siren-v1` 校验的活动 SIREN、10 条 `weak / needs_review` Lead。资格前置检查前 5 家 `matched=0`，没有新增 domain、LEI 或 QID。这是正确的安全负向结果：公开源没有提供与各 SIREN 一致的交叉证明，系统不再把集团信息贴给同名法人。

最终并发收口后的获客、Identity、Raw、Temporal 与健康相关扩大回归为 74 个测试文件、712 项全部通过；关键快照 CAS、Replay 锁序和无回填迁移组在最终复审时为 6 个文件、54 项通过，API 编译、定向 ESLint 与格式检查通过。全 API 测试仍有 Site Builder 的 macOS `/proc/self/fd`、Chrome 缺失与长测试环境失败，因此不表述为全仓全绿。当前 API、Worker 与 Outbox Relay 已用新编译产物和 v5 空库恢复；等待一个心跳周期后，`/api/v1/health/ready` 的数据库、Temporal、Worker lease、Relay lease 与 admission 仍全部为 `ok`。

法国试点最终形成 10 条 `weak / needs_review` Lead，自动评分后总分均为 0.3825。`DiscoveryRunCompleted`、`QualifyRequested` 和 `LeadsScored` 均由 Relay 发布，AI Trace 增量仍为 0。这个对照证明法国名录在“企业是谁”上明显强于 World Bank 采购公告，但强身份不等于强销售命中：缺少官网产品、工艺、角色与商业模式证据时仍不能进入推荐队列。

最终迁移修订显式使用 `BEGIN/COMMIT`，升级期间在持表锁的事务内临时关闭 RLS，完成后恢复 ENABLE + FORCE、对称租户策略、INSERT guard、UPDATE/DELETE 不可变触发器，并撤销 app_user 的 UPDATE/DELETE/TRUNCATE。父运行事实不完整或旧行的 ICP、终态、完成时间、身份质量计数不一致时整条迁移回滚。真实验证使用一个 `NOSUPERUSER + NOBYPASSRLS` 的临时表 owner 成功升级 FORCE RLS 旧表，精确得到 attempted=1、success=1、processed=2；失败路径验证新增列为 0 且 update guard 仍为 1，证明没有半迁移。

最终另建空数据库 `global_identity_v2_acceptance_20260813_v5`，从零完整执行 92 条迁移。第 92 条改为不带 `IF NOT EXISTS` 的 `CREATE INDEX CONCURRENTLY` 域名规范化表达式索引：失败后重试会显式暴露同名残留，而不会静默跳过无效索引；同时不包含 `UPDATE canonical_company`、新增投影列或 trigger。`prisma migrate status` 显示 92 条全部完成，最终数据库到 Prisma datamodel 的 diff 为 `No difference detected`。该库只用于本地迁移与运行验收并保留，不是部署环境；旧 v3/v4 数据仍保留作历史审计，未被覆盖。

最新构建在 v5 上重新运行法国官方名录金丝雀，workspace `1fd7e718-941f-4d0c-8959-0e595f211aa3`、run `0b7c8d9a-e477-4f26-b7c2-eaedf72bb891` 终态 `DONE`：10 Raw、10 ACTIVE IdentityLink、10 家企业、10 个经 `siren-v1` 校验的活动 SIREN、10 条 `weak / needs_review` Lead，Provider failure/conflict/错误身份补全均为 0，AI 调用为 0。随后 `DiscoveryRunCompleted`、`QualifyRequested` 与 `LeadsScored` 均由 Relay 发布。

真实 PostgreSQL 双连接锁竞争也已执行：会话 A 持有该 workspace 的 identity advisory transaction lock；会话 B 通过 `app_user` 和 `withWorkspace` 调用身份快照读取，在 A 提交前保持阻塞，释放后成功返回，记录等待 5733ms。它证明生产 helper 与 merge/split/replay 使用的是同一数据库互斥键；这不是完整的业务 merge→commit 并发场景，但已经超出 mock 单测，提供了真实数据库锁级证据。

## Identity v2 业务竞态与可逆生命周期验收（2026-08-13）

在 v5 本机实验库上新增了显式 opt-in 的双连接 PostgreSQL 验收。最终 9 项全部通过：Lead accept 与 merge 两种先后顺序、split 排队与 replay、fit 与 merge 两种先后顺序、富集快照漂移，以及 domain / company-name suppression 在 fit 提交前落定的两种竞态。所有连接均由测试前置门确认是 `app_user`、非 superuser、非 BYPASSRLS；无显式环境变量时 9 项全部跳过，避免普通测试误连数据库。该组证明的是这些具体业务流在真实 RLS 连接下的串行化，不等于六张 Identity 表的完整 RLS 矩阵。

人工身份生命周期另在 API、Worker 与 Relay 停止时用 service/activity 直调完成真实 PostgreSQL 验收。最终保留工作区为 `37e33cb5-1d44-4df0-a413-9f04dfcaf0c4`；输入冲突是脚本在真实 PostgreSQL 中建立的验收状态，并非 resolver 自动发现。`merge → replay → split → replay`、重复 replay 幂等、append-only decision、merge 未稳定时拒绝 split、商业事实在请求后出现时 replay 失败关闭均通过。持久核对为 4 条 `SUCCEEDED / attempt=1`、2 条 `FAILED / COMMERCIAL_FACTS_IMMUTABLE / attempt=1`、1 条 `PENDING / attempt=0`，7 条 replay outbox 当时均未发布，因此证据没有被异步 Worker 改写。

随后重新编译并恢复最新 API、Worker 与 Outbox Relay；两个间隔心跳周期的 `/api/v1/health/ready` 均返回数据库、Temporal control plane、Worker lease、Relay lease 与 admission 全部 `ok`。这里不能写成“生命周期经 Temporal/Relay 实跑”，因为生命周期证据来自真实 PostgreSQL 上的 service/activity 直调；Temporal/Relay 的证据仅是最新构建持续在线和心跳可验证。

本轮还关闭了两个审计缺口：LeadQualified 交棒、fit 提交、merge/split/replay 统一使用 suppression → workspace identity → 细粒度行/Lead 锁序；失败 replay 的持久 `attempt` 在回滚后的 catch 事务中累加，不再把失败次数记成 0。同一 identity group 内同一 ICP 存在两条 Lead 的独立分支也有直接回归测试。

## NPPES 获客生命周期闭环（2026-08-13）

NPPES 不再只处理“首次发现时为活动状态”的组织。精确 NPI 查询现在会保留 `NPI-2 + status=D` 的官方状态事实；名称搜索仍只允许 `status=A` 进入候选，缺失或未知状态按 Provider 失败处理，不冒充零结果。D 事实只凭当前 workspace 的活动 `us_npi` 强标识定位已有身份，不按名称猜测，也不创建新企业。命中后 Raw、来源证明、NPI 标识和 IdentityLink 全部保留，新增幂等 `nppes.status=D` Evidence；根企业及活动别名转为 `SUPPRESSED`，普通候选 Lead 转为 `SUPPRESSED / suppressed`，已经 `QUALIFIED / CONTACTED / CONVERTED` 或存在 `LeadQualified` 的商业事实保持原样并标记需要人工跟进。

真 PostgreSQL 验收运行于 `global_identity_fresh2_acceptance`，随机隔离 workspace 为 `a35bd1fd-fc15-4b86-ac10-0d99066c6b34`，连接角色为临时 `nppes_acceptance_runner`，确认 `NOSUPERUSER + NOBYPASSRLS` 后执行并在结束时删除。验收先暴露并修复了 company-row lock 中 UUID 列与 text 参数比较失败的问题，修复后最终通过：普通 REVIEW Lead 被安全停用；已有 LeadQualified 的 REVIEW Lead 保持不变并要求人工处理；同一 D Raw 重放不重复改变状态；4 条活动/停用 Raw、2 个活动 NPI、2 条生命周期 IdentityLink 和 2 条 D Evidence 均保留。

并发真实验覆盖两种顺序：D 先提交时，随后 accept 观察到企业已停用，0 个 LeadQualified；accept 先持锁并提交时，D 等待其事务完成，随后只停用企业，已形成的 `QUALIFIED + LeadQualified` 保留。另以 workspace B 读取 workspace A 的 Company、Lead、Identifier 与 Raw，四类计数均为 0。该证据使用受控、符合 NPPES 官方响应结构的 D 状态输入，因为不能为测试要求真实官方记录即时从 A 改成 D；真实正向 NPPES 入池证据仍来自 Mayo Clinic 精确 NPI 金丝雀，二者不能合并描述成“官方在验收时真实发生停用”。最终相关回归为 7 个文件、109 项通过，API build tsconfig、定向 ESLint 与 `git diff --check` 通过。
