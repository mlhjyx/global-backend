/**
 * 接口门户（/api/portal）每个操作的正文说明。
 *
 * 为什么集中在这里而不是写在控制器上：这些文字是给对接方看的描述，不是运行时行为，
 * 集中一处便于整篇通读与统一口径；控制器上的 summary 仍然贴着代码，两个层次各管各的。
 *
 * 键是 `<METHOD> <OpenAPI path>`，与 packages/contracts/openapi/openapi.json 完全一致。
 * 覆盖由 operation-descriptions.spec.ts 机械保证：新增端点没写描述，测试就红。
 * 描述只写代码里成立的事实（状态迁移、scope、状态码、幂等/异步语义、错误码），
 * 不写推测的业务承诺。
 */
export const OPERATION_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  // ── System ────────────────────────────────────────────────────────────────
  'GET /api/v1/health':
    '存活探针：不探测任何依赖，恒返回 200，供负载均衡与进程守护使用。响应不套 { data } 信封。',
  'GET /api/v1/health/live':
    '进程存活检查：只证明事件循环仍在响应，不探测数据库、Temporal 等依赖。',
  'GET /api/v1/health/db':
    '以 app_user 身份对数据库做一次连通性检查，验证连接与 RLS 角色可用；失败返回非 200。',
  'GET /api/v1/health/build':
    '非敏感的构建身份回执：build_sha、镜像 digest、attestation 摘要。用来确认线上跑的到底是哪个提交。',
  'GET /api/v1/health/ready':
    '接流就绪检查：逐项给出数据库、Temporal control plane、worker、平台准入等组件状态；任一项不 ok 时整体不 ready（503）并列出原因。',
  'GET /api/v1/whoami':
    '回显 token 解析出的身份与服务端派生的权限（userId / workspaceId / roles / scopes）。前端可用它决定页面可见性。需要 ops:read。',
  'GET /api/v1/health/clock':
    '带 nonce 的准入相对时钟观测，供服务间判断时钟漂移；普通前端不需要。',

  // ── ExecutionBudget ───────────────────────────────────────────────────────
  'POST /api/v1/execution-budget/workspace-technical-quote':
    '服务间：计算某个 workspace operation 的平台内部执行预算包络。它不是客户价格、余额或额度限制，数字不能展示给终端客户。',

  // ── PlatformAuthority ─────────────────────────────────────────────────────
  'POST /api/v1/platform-authority/revocations':
    '服务间：应用一条已签名的撤销，或重放它已提交的 ACK。重复投递返回首次提交的 ACK（幂等），签名不合法直接拒绝。',
  'GET /api/v1/platform-authority/fence-ack-jwks':
    '服务间：只读返回 fence-ACK 的公钥族（JWKS），供对端验证确认签名；只含公钥。',

  // ── Companies ─────────────────────────────────────────────────────────────
  'GET /api/v1/companies':
    '游标分页列出本 workspace 的企业画像：limit 默认 20、上限 100，返回 { data, page: { next_cursor, has_more } }。',
  'GET /api/v1/companies/{companyId}':
    '按 id 取单个企业画像。资源属于其他 workspace 时返回 404，而不是 403——不泄露存在性。',
  'GET /api/v1/companies/{companyId}/completeness':
    '企业完整度：已批准事实、待审事实、产品条目、未决冲突的数量，以及企业当前状态。前端轮询理解进度用它。',
  'POST /api/v1/companies/{companyId}/confirm':
    '人工确认企业可用：REVIEW → ACTIVE，是显式的 Gate 出口。需要 acquisition:review。',
  'GET /api/v1/companies/{companyId}/offerings':
    '理解阶段抽取出的结构化产品/服务，每条带来源页 URL 与原文片段。数组响应，不分页。',
  'PATCH /api/v1/companies/{companyId}':
    '编辑 DRAFT 档案的卖家自查事实（名称/官网/行业/目标市场/业务邮箱）。补填官网后，调用方需另取 quote 与 Grant 调 retry 端点启动理解；本接口不消费 Grant。非 DRAFT 档案返回 409 COMPANY_NOT_EDITABLE。',
  'DELETE /api/v1/companies/{companyId}':
    '软删除 DRAFT 档案：列表与详情不再可见，关联事实与审计保留；物理删除归 owner/DSR。非 DRAFT 返回 409 COMPANY_NOT_DELETABLE。',
  'POST /api/v1/companies/{companyId}/website-candidates':
    '按公司名用自托管 SearXNG 搜索官网候选（两个有界查询），过滤企业信息聚合站/社交/搜索引擎并按标题与公司名的匹配度排序，最多 5 条；只返回 {url,title,score}，不抓页面，需人工确认后通过 PATCH 采用。',

  // ── SellerDocuments（模块 02 · Phase 2）──────────────────────────────────────
  'POST /api/v1/companies/{companyId}/seller-documents/presign':
    '为卖家资料上传签发短时 presigned PUT（15 分钟）。校验 MIME 白名单与单文件上限（PDF/Word/PPT/Excel ≤50MB，文本/Markdown ≤10MB）与配额（每空间 500 份/2 GiB、每公司 200 份，env 可调）；超限返回 409。返回 documentId 与 uploadUrl，上传对象带 1 天过期的 staging 生命周期标签。',
  'PUT /api/v1/companies/{companyId}/seller-documents/{documentId}/content':
    '浏览器直传中转：把文件原始字节经引擎写入 presign 时的暂存对象（浏览器访问不到对象存储内网地址时使用）。仅 pending_upload 可用；Content-Type 必须与 presign 申报一致，字节数必须等于申报大小；超限 413。写入后照常调 commit 校验并入队。',
  'POST /api/v1/companies/{companyId}/seller-documents/{documentId}/commit':
    '确认上传完成：对 staging 对象做 HEAD、流式 sha256 与魔数校验（声明的 MIME 必须与实际内容相符），通过后转存 canonical 对象并将文档置为 queued、入队解析。上传未完成返回 409 并留在 pending_upload；内容不符置 rejected；同一公司已存在相同内容时返回 409 并清理已复制副本。',
  'GET /api/v1/companies/{companyId}/seller-documents':
    '游标分页列出公司的卖家资料（软删不可见）：limit 默认 20、上限 100，返回 { data, page: { next_cursor, has_more } }。每条含状态（pending_upload/committing/queued/processing/ready/failed_terminal/rejected）、类型与字节数。',
  'GET /api/v1/companies/{companyId}/seller-documents/search':
    '资料库混合检索：查询词经本机 BGE-M3 嵌入后与分块向量做余弦（权重 0.7）并与全文 ts_rank_cd（权重 0.3）合成排序；只检索该公司 status=ready 且未删除的资料，limit 上限 50。',
  'GET /api/v1/seller-documents/{documentId}':
    '按 id 取单份资料详情。资源属于其他 workspace 或已软删时返回 404，不泄露存在性。',
  'GET /api/v1/seller-documents/{documentId}/download-url':
    '返回 10 分钟有效的 presigned GET；尚未上传完成（pending_upload/committing）或已被拒绝时返回 409。',
  'POST /api/v1/seller-documents/{documentId}/retry':
    '重试解析：仅 failed_terminal 或 queued 状态可调用，重置错误码后重新入队（202）。需要 acquisition:write。',
  'DELETE /api/v1/seller-documents/{documentId}':
    '软删一份资料：置 deleted_at 并从列表与下载中消失；对象与分块的物理清理在受控清理管线（DSR 同路径）完成。需要 acquisition:review。',

  // ── Claims ────────────────────────────────────────────────────────────────
  'GET /api/v1/companies/{companyId}/claims':
    '列出该企业的事实（Claim），可用 ?status=NEEDS_REVIEW 过滤；每条带来源与状态。',
  'POST /api/v1/companies/{companyId}/claims':
    '手工录入一条企业事实（KNW-001 手工路径）。它与自动抽取的事实走同一套审批生命周期，初始状态为待审。',
  'POST /api/v1/companies/{companyId}/claim-drafts':
    '从公司档案确定性生成待审事实草稿（NEEDS_REVIEW）：主营产品 → capability、行业 → company_fact、目标市场 → market，证据记为「注册引导填写」。不调用模型、不消费 Grant；按归一化语句幂等去重，REVOKED 的语句不复活。批准任意一条后 ICP 生成不再被 NO_APPROVED_CLAIMS 阻断。需要 acquisition:review。',
  'POST /api/v1/claims/{claimId}/approve':
    '审批通过一条待审事实：NEEDS_REVIEW → APPROVED，并发出 ClaimApproved 事件供下游使用。需要 acquisition:review。',
  'POST /api/v1/claims/{claimId}/reject':
    '驳回一条待审事实：NEEDS_REVIEW → REVOKED。需要 acquisition:review。',
  'POST /api/v1/claims/{claimId}/revoke':
    '撤销一条已批准事实：APPROVED → REVOKED，并发出 ClaimRevoked——下游必须停止使用该事实。',
  'GET /api/v1/companies/{companyId}/conflicts':
    '列出该企业的知识冲突（KNW-004），可用 ?status=OPEN 只看未决的。',
  'POST /api/v1/conflicts/{conflictId}/resolve':
    '裁决一条冲突：保留指定的事实，另一条置 REVOKED。',

  // ── ICP ───────────────────────────────────────────────────────────────────
  'GET /api/v1/icps':
    '列出 ICP，可用 ?companyId= 过滤到某家企业。数组响应，不分页。',
  'GET /api/v1/icps/{icpId}':
    'ICP 详情，含 Persona 与买家委员会成员。',
  'PATCH /api/v1/icps/{icpId}':
    '人工修订 ICP（AI 产出只是假设，允许改）。带 version 乐观锁：传 expectedVersion，不一致返回 409 VERSION_CONFLICT。',
  'POST /api/v1/icps/{icpId}/activate':
    '激活 ICP：→ ACTIVE；同一企业原先 ACTIVE 的 ICP 置 SUPERSEDED，并发出 ICPActivated 事件。需要 acquisition:review。',
  'POST /api/v1/icps/{icpId}/rules':
    '为 ICP 新增一条机器可评估的验证规则，类型为 must_have / nice_to_have / exclusion。',
  'PATCH /api/v1/icp-rules/{ruleId}':
    '局部修改一条验证规则：kind / field / operator / value / weight（≥0）/ rationale 都可选。返回更新后的规则及其 version。',
  'DELETE /api/v1/icp-rules/{ruleId}':
    '删除一条验证规则，返回 { deleted: true }。',
  'POST /api/v1/icps/{icpId}/backtests':
    '用已知客户/非客户样例做确定性回测，检验规则命中率；ICP 由 HYPOTHESIS 转 VALIDATING。',
  'GET /api/v1/icps/{icpId}/backtests':
    '该 ICP 的回测历史。',
  'GET /api/v1/icps/{icpId}/query-plans':
    '该 ICP 的查询计划列表（含状态：DRAFT / READY）。',
  'POST /api/v1/query-plans/{planId}/confirm':
    '人工确认查询计划：DRAFT → READY，确认后才能执行发现。需要 acquisition:review。',

  // ── Discovery ─────────────────────────────────────────────────────────────
  'POST /api/v1/query-plans/{planId}/execute':
    '执行一个查询计划：READY 首跑；EXECUTED 计划携带新 attemptId 即重跑（新请求哈希/新预算 Grant，同一 attempt 重放报 EXECUTION_BUDGET_GRANT_REUSED，缺 attemptId 报 RERUN_REQUIRES_ATTEMPT）。多源发现 → Raw → Canonical，由 Temporal 异步编排，返回 202 与 runId。',
  'POST /api/v1/discovery-runs/{runId}/cancel':
    '停止深挖：向 Temporal 发取消请求。已完成公司的结果保留，未完成公司标 skipped（下一次 run 会重新排队），run 以 CANCELLED 收尾。已结束的 run 幂等返回当前状态。',
  'GET /api/v1/icps/{icpId}/feedback':
    'M2 反馈闭环：按来源/渠道/行业/国家聚合的接受率与拒绝理由分布，以及 ICP 建议卡（只给建议，人工采纳后才改 ICP）。',
  'POST /api/v1/icps/{icpId}/feedback/recompute':
    '重算该 ICP 的反馈聚合（幂等；通常由接受/拒绝动作自动触发，这里是手动补偿入口）。',
  'GET /api/v1/discovery-runs/{runId}/events':
    'run 进度事件（append-only，按 seq 增量拉取）：阶段开始/完成、公司进出阶段、预算耗尽、租约跳过、run 收尾。用 ?after=<上次的 nextAfter> 断点续拉，事件可重放。',
  'GET /api/v1/discovery-runs/{runId}/jobs':
    'run 的公司级队列（快扫名单 + 深挖逐家状态：stage/粗判/精判/失败码/耗时），游标分页。',
  'GET /api/v1/source-channels':
    '渠道列表（状态/模式/类别/最近运行与失败率）。平台级渠道注册表，运营台读取（ops:read）；租户侧只看 /available。',
  'GET /api/v1/source-channels/available':
    '租户可用的已批准渠道（status=ENABLED），并标注本工作空间是否已启用。',
  'GET /api/v1/source-channels/import-template':
    '导入通道的示例 CSV（10 行，列：company/website/country/industry），附 columns 与建议 mapping；预览/提交缺少或错配 mapping 时，错误信息会列出可用列并给出示例。',
  'POST /api/v1/source-channels':
    '新建平台渠道（默认停用 DISABLED）。仅运营身份（ops:write）；配置按形态校验：crawl 需 https 列表页与选择器；api 需适配器名；import 直接可用。启用前必须登记许可、条款与 robots 结论。',
  'PATCH /api/v1/source-channels/{channelId}':
    '更新渠道配置/治理信息/状态。仅运营身份（ops:write）。启用硬闸门：license+tosUrl+robots 结论齐全，robots=C 永不启用，crawl 仅允许 robots=A。',
  'POST /api/v1/source-channels/{channelId}/enable':
    '租户启用一个已批准（ENABLED）渠道；只能启用，不能新建平台渠道。',
  'DELETE /api/v1/source-channels/{channelId}/enable':
    '租户停用渠道（平台渠道本身不受影响）。',
  'POST /api/v1/source-channels/{channelId}/preview':
    '试跑抓取通道（抓 1 页/前 20 条）。仅运营身份（ops:write）。抓取出网需要平台级抓取预算权威（platform.channel_crawl purpose），授权链落地前该端点 fail-closed 返回 409 CHANNEL_CRAWL_REQUIRES_PLATFORM_AUTHORITY。',
  'POST /api/v1/source-channels/{channelId}/run':
    '立即运行抓取通道（同 preview 的门槛与限额，仅运营身份 ops:write；失败率连续 3 轮 >30% 自动停用）。',
  'GET /api/v1/source-channels/{channelId}/records':
    '渠道最近物化的抓取记录（默认最近 50 条，limit 1–100）：公司/官网/国家/行业/产品/关键词与联系人（人名/职位/邮箱/电话，均为渠道页公开信息）。仅运营身份（ops:read），用于选择器校验与获客联系；同一公司跨轮去重合并（渠道+去重键 upsert），重跑不重复。',
  'POST /api/v1/imported-buyers/preview':
    '导入预览：解析 CSV、校验列映射（至少公司名列）、给出前 10 行样例与去重/抑制命中计数，不写库。',
  'POST /api/v1/imported-buyers':
    '导入提交：原始行落 imported_buyer，按域名/名称+国家去重并过抑制门后物化进本租户的公司池（私有），并写渠道 sighting。',
  'GET /api/v1/imported-buyers/{batchId}':
    '导入批次明细（每行状态 MATERIALIZED/DUPLICATE/SUPPRESSED 与去重键）。',
  'GET /api/v1/discovery-runs/{runId}':
    '发现运行的状态与统计（每源计数、归一、suppression）。completedAt 为空表示仍在跑。',
  'GET /api/v1/canonical-companies':
    '归一后的目标公司，游标分页；可用 ?status=NEW|ENRICHED|SUPPRESSED 过滤。',
  'GET /api/v1/canonical-companies/{id}':
    '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值来自哪一页、哪段原文）。需要 contact-discovery:read（只覆盖联系人数据面，不等于 personal-data:read）。',
  'POST /api/v1/canonical-companies/{id}/discover-contacts':
    '按需发现联系人（Waterfall 第 5 步，只对高价值企业调用）：先过 suppression，再抽取联系人。必须带 lawfulBasis；缺 body 会在消耗预算前以 CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED 拒绝。需要 contact-discovery:read 与 compliance:manage。',
  'POST /api/v1/suppressions':
    '加入禁联名单（email / domain / company_name）；命中的公司立即转 SUPPRESSED。需要 compliance:manage。',
  'GET /api/v1/suppressions':
    '本 workspace 的禁联名单，游标分页。需要 compliance:manage（workspace 隔离，租户 admin 可管理自己的禁联记录）。',
  'GET /api/v1/suppressions/{id}/decisions':
    '列出该条禁联的 append-only 解除/更正决策记录（请求本身不解除禁联）。',
  'DELETE /api/v1/suppressions/{id}':
    '已弃用：不会物理删除，而是提交一条解除请求（append-only 决策）。法定禁联不可解除，返回 409。',
  'GET /api/v1/data-providers':
    '平台级数据源注册表（状态与成本）。DISABLED 相当于该数据源的 Kill Switch。需要 ops:read。',

  // ── Leads ─────────────────────────────────────────────────────────────────
  'POST /api/v1/icps/{icpId}/qualify':
    '对一个 ACTIVE ICP 的全部候选公司做六维评分，产出 Lead 与四个队列。异步，返回 202。',
  'GET /api/v1/leads':
    'Lead 列表，可按 ?icpId= 与 ?queue=recommended|needs_review|rejected|suppressed 过滤，按分数排序。',
  'GET /api/v1/lead-candidates':
    '机器候选只读视图（候选 ≠ 线索，不复制表）：候选行就是 qualify 产出的 lead，语义由 queue/fit_verdict/scored_at 与 score_detail.candidateBatchRef 组装。?runId=<qualify 工作流 run id> 只看该 run 的全部批次（批次引用前缀 qualify:<runId>:）；?icpId=/?queue= 收窄；按 scored_at 倒序、id 升序游标分页（limit 默认 50、上限 200）。runId 仅接受 [A-Za-z0-9-]{1,64}，否则 400。',
  'GET /api/v1/icps/{icpId}/lead-queues':
    '五个队列的计数（推荐 / 待确认 / 拒绝 / 禁联 / 制裁隔离）与队列依据（预置 / 评分 / 人工）。',
  'GET /api/v1/leads/{leadId}':
    'Lead 详情：六维分、规则逐条评估依据、公司与联系人、裁决历史。需要 personal-data:read。',
  'GET /api/v1/leads/{leadId}/package':
    '交付读模型 LeadPackage：公司事实、建议联系路径、信号、证据 URL、原因码；不含具名联系人。历史证据为合成来源时返回 409（产品读一律隔离）。',
  'POST /api/v1/leads/{leadId}/outcomes':
    '回写线索结果（BI-23），只追加：可填相关性 1–5、意愿、原因码、备注、是否已联系。整条没有任何已填字段返回 400。需要 acquisition:review。',
  'POST /api/v1/leads/{leadId}/accept':
    '接受 Lead：→ QUALIFIED，并发出 LeadQualified，这是交给 Campaign 的出口。当前 suppression / 合规 / 制裁状态阻断交付时返回 409。',
  'POST /api/v1/leads/{leadId}/reject':
    '拒绝 Lead：→ REJECTED。必须带原因码，缺失返回 422 REASON_CODE_REQUIRED；自由文本放 reason。',
  'POST /api/v1/leads/{leadId}/sanctions-review':
    '制裁筛查的复核裁决（第五道门的人审）：判为误报则回落到正常队列并允许复发抑制；确认真命中则留在隔离，永不交付。',

  // ── Reports ───────────────────────────────────────────────────────────────
  'GET /api/v1/reports/weekly':
    '导出周报 CSV：该 ICP 下、指定 ISO 周（UTC，周一起）accept 的线索。每行写一条 EXPORT 判定到 policy_decision_log，被拒或被拦的行不导出；超过单次上限整份拒绝而不截断。需要 acquisition:export。',
  'POST /api/v1/reports/weekly/feedback':
    '上传客户填写后的周报 CSV 原文：按「线索 ID」列匹配、逐行校验，只追加写 lead_outcome，返回接受 / 拒绝 / 跳过计数与带文件行号的拒绝原因。',

  // ── Events ────────────────────────────────────────────────────────────────
  'GET /api/v1/events/{eventId}/ack-status':
    '读取某个事件的 ACK 状态。只有 ACKED 才代表已消费；404 不代表未消费。',
  'GET /api/v1/events':
    '拉取集成事件流（envelope 形状），参数 cursor / limit / type。游标与 ACK 互不影响，可以重放。',
  'POST /api/v1/events/ack':
    'ACK 已消费的事件（pull sink 的消费真值）。幂等：重复 ACK 计 0。',

  // ── Compliance ────────────────────────────────────────────────────────────
  'POST /api/v1/deletion-requests':
    '受理数据主体删除请求（GDPR Art.17），异步编排，返回 202 与请求 id。需要 compliance:manage。',
  'GET /api/v1/deletion-requests/{id}':
    '查询删除请求的状态与擦除回执；COMPLETED 后回执才有值，且只给计数、不含 PII。',

  // ── SiteBuilder ───────────────────────────────────────────────────────────
  'POST /api/v1/site-builder/intake':
    '注册引导提交：无条件创建建站档案并立即触发 demo v0。需 acquisition:write；支持 idempotency-key，同 key 重放返回首个结果。',
  'GET /api/v1/site-builder/sites':
    '列出本 workspace 的站点，含预览地址。',
  'GET /api/v1/site-builder/sites/{id}':
    '站点详情：状态、模式、语言、当前生效版本与预览地址；demo 就绪前 previewUrl 为空。',
  'GET /api/v1/site-builder/sites/{id}/profile':
    '建站向导档案，含 companyProfile / trustAssets / onlineAssets / brand / contact 五组。需要 personal-data:read。',
  'PATCH /api/v1/site-builder/sites/{id}/profile':
    '向导分步保存：按组整体替换（五组任选，可跳过）。并发用强 ETag 控制：If-Match 头与 body.baseVersionId 至少给一个，两者矛盾返回 400。',
  'POST /api/v1/site-builder/sites/{id}/assets/presign':
    '素材上传第 1 步：校验请求并签发 15 分钟有效的直传 URL，客户端拿它直接传对象存储。',
  'POST /api/v1/site-builder/assets/{id}/commit':
    '素材上传第 3 步：魔数、大小、去重校验后归位；doc 类素材进入知识库队列。',
  'GET /api/v1/site-builder/sites/{id}/assets':
    '站点素材列表：每条的 kind、文件名、MIME、字节数、处理状态与内容哈希；数组响应，不分页。',
  'DELETE /api/v1/site-builder/assets/{id}':
    '引用守卫通过后软删除素材；对象由异步清理回收。成功返回 204。',
  'GET /api/v1/site-builder/sites/{id}/kb/status':
    '知识库状态：文档数与块计数，以及仍待补充的资料缺口。',
  'POST /api/v1/site-builder/sites/{id}/builds':
    '触发精装修构建。已有构建在跑返回 409，当日配额用尽返回 429；支持 idempotency-key，同 key 异请求返回 409。',
  'GET /api/v1/site-builder/builds/{id}':
    '构建进度，前端轮询用（SSE 事件流按设计后置，尚未提供）。',
  'POST /api/v1/site-builder/builds/{id}/cancel':
    '取消构建；已处于终态返回 409。',
  'POST /api/v1/site-builder/intake-budget-quote':
    '计算 intake 的内部技术预算包络：零模型调用、零工作流、零持久写入，纯计算。',
  'POST /api/v1/site-builder/sites/{id}/build-budget-quote':
    '计算 refurbish 的内部技术预算包络；不构成客户报价，也不限制余额。',
  // ── Skills（AI 底座 · S0）──────────────────────────────────────────────────
  'GET /api/v1/skills':
    '列出平台技能目录：技能键、pack_type、启停状态与当前版本；仅运营身份（ops:read）可读，租户调用返回 403。',
  'GET /api/v1/skills/{skillKey}':
    '返回单个技能的 manifest、SKILL.md 正文与全部版本历史；未登记返回 404；需要 ops:read。',
  'GET /api/v1/skills/{skillKey}/workspaces/{workspaceId}':
    '查看目标 workspace 的技能生效状态：平台状态、覆盖行与合成后的 enabled；需要 ops:read。',
  'PATCH /api/v1/skills/{skillKey}/status':
    '平台级启停（kill switch）：DISABLED 后该技能对所有 workspace 停止执行（fail-closed），worker 最迟 30 秒生效；需要 ops:write。',
  'PUT /api/v1/skills/{skillKey}/workspaces/{workspaceId}':
    '设置 workspace 级启停覆盖（幂等 upsert）；删除覆盖行则跟随平台默认；需要 ops:write。',
  'DELETE /api/v1/skills/{skillKey}/workspaces/{workspaceId}':
    '删除 workspace 启停覆盖，回到跟随平台默认；重复删除幂等返回 removed=false；需要 ops:write。',
  // ── Packs（AI 底座 · S1 Pack Studio）───────────────────────────────────────
  'GET /api/v1/packs':
    '列出 Pack 目录：pack_key、类型、启停状态与当前激活版本；仅运营身份（ops:read）可读。',
  'GET /api/v1/packs/{packKey}':
    '返回单个 Pack 的版本历史、草稿、激活日志与最近评测回执；未登记返回 404；需要 ops:read。',
  'POST /api/v1/packs/{packKey}/drafts':
    '新建 Pack 草稿（可从已发布版本派生）；草稿可反复编辑，发布后才生成不可变版本；需要 ops:write。',
  'PATCH /api/v1/packs/{packKey}/drafts/{draftId}':
    '编辑草稿的 manifest 或内容正文；编辑会使既有校验/评测失效，需重新 validate 与 eval；需要 ops:write。',
  'POST /api/v1/packs/{packKey}/drafts/{draftId}/validate':
    '校验草稿：四类 Schema、平台语义与单包冲突模拟；结果写入草稿的 validation 报告；需要 ops:write。',
  'POST /api/v1/packs/{packKey}/drafts/{draftId}/dry-run':
    '零成本试跑：在给定行业/市场/动作选择器下解析策略，返回策略简报与相对当前版本的差异；需要 ops:write。',
  'POST /api/v1/packs/{packKey}/drafts/{draftId}/eval':
    '运行确定性 Golden Set 评测（零模型）并写入不可变回执；发布门只认与草稿摘要匹配的回执；需要 ops:write。',
  'POST /api/v1/packs/{packKey}/drafts/{draftId}/publish':
    '发布草稿为不可变版本：要求当前摘要已通过校验且存在匹配、未过期（30 天）的通过回执；需要 ops:write。',
  'POST /api/v1/packs/{packKey}/activate':
    '激活已发布版本：scope=platform 设为平台默认，scope=workspace 仅对白名单空间灰度；回滚=激活旧版本；需要 ops:write。',
  'GET /api/v1/packs/{packKey}/workspaces/{workspaceId}':
    '查看目标 workspace 的 Pack 生效状态（平台状态 + 覆盖行）；需要 ops:read。',
  'PUT /api/v1/packs/{packKey}/workspaces/{workspaceId}':
    '设置 workspace 级 Pack 启停覆盖（幂等 upsert）；删除覆盖则跟随平台默认；需要 ops:write。',
  'DELETE /api/v1/packs/{packKey}/workspaces/{workspaceId}':
    '删除 workspace 启停覆盖，回到跟随平台默认；重复删除幂等返回 removed=false；需要 ops:write。',
});
