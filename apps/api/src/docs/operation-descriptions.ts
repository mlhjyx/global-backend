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

  // ── Claims ────────────────────────────────────────────────────────────────
  'GET /api/v1/companies/{companyId}/claims':
    '列出该企业的事实（Claim），可用 ?status=NEEDS_REVIEW 过滤；每条带来源与状态。',
  'POST /api/v1/companies/{companyId}/claims':
    '手工录入一条企业事实（KNW-001 手工路径）。它与自动抽取的事实走同一套审批生命周期，初始状态为待审。',
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
    '执行一个 READY 查询计划：多源发现 → Raw → Canonical，由 Temporal 异步编排。返回 202 与 runId，用 GET /discovery-runs/{runId} 轮询。',
  'GET /api/v1/discovery-runs/{runId}':
    '发现运行的状态与统计（每源计数、归一、suppression）。completedAt 为空表示仍在跑。',
  'GET /api/v1/canonical-companies':
    '归一后的目标公司，游标分页；可用 ?status=NEW|ENRICHED|SUPPRESSED 过滤。',
  'GET /api/v1/canonical-companies/{id}':
    '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值来自哪一页、哪段原文）。需要 personal-data:read。',
  'POST /api/v1/canonical-companies/{id}/discover-contacts':
    '按需发现联系人（Waterfall 第 5 步，只对高价值企业调用）：先过 suppression，再抽取联系人。必须带 lawfulBasis；缺 body 会在消耗预算前以 CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED 拒绝。需要 personal-data:read 与 compliance:manage。',
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
});
