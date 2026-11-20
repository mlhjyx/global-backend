# 厂家官网经销证明：独立测试实施计划

> 状态：`APPROVED`
> 实施进度：正在实施；尚未完成真实来源验收或部署。
> 方向与边界：产品负责人2026-11-20明确允许在独立测试接入经核对主体的厂家官方经销名单；保持至少两个来源分层、国家/产品/采购角色门，不推断当前采购意向，不开放协会或工商聚合。证据规格已由独立业务与安全审查通过。生产部署不在授权内。

## 验收与责任

Backend产品源码由Task1实施者独占，root负责ADR/计划、SaaS独立分支与测试恢复，独立业务与安全reviewer只读。先3–5个正负例验证完整链，随后30家“逐条来源核查合格∩系统正式可交付”的不同企业，再到累计100家（含30），再验证持续新增。AI资料核查、人类验收、旧库首次交付、本轮新搜和首次建档分开；不把既有12家或原始FIT自动计数。不得虚构通用工业泵缺失的参数。

## 已核实的最小方案

1. M1仅德国工业泵经销进口场景，复用现有三场景定义和Run2补证入口，不重造搜索引擎或新增模型任务。新增`manufacturer_network`富集provider，默认不启用，逐源批准厂家及详情路径才可抓取。
2. 每公司最多一次SearXNG定向查询和一次`crawl4ai.fetch`精确HTML抓取，50公司上限；不能把厂家全体经销商索引页当共享多主体制品。同run同URL不同company Subject必须拒绝串用，不靠query参数或correlationId伪造不同操作。
3. 业务合同`manufacturer-network-evidence/v1`复用现有`crawl4ai.fetch` producer、`crawl4ai-fetch/v1`制品、artifact_reference回执和相应ACK绑定。provider先校严格source policy，工具advisory不能替代准入。确定性解析身份/关系/国家及有限逐页引文，不能从搜索摘要产事实。
4. namespace及FieldEvidence保留真实来源、用途/许可、采集时间、原引用和receipt绑定。同步TS sanitizer与前向SQL治理函数，不能假称已有统一DB触发器阻断；不扫描改写旧数据。Claim当前属于卖家CompanyProfile，不为目标canonical公司强造Profile。
5. 新T2必须经过版本化验证和身份/发布者/时效筛选；使用独立namespace，不冒充Wikidata或登记T1。判定输入加入有界原页spans，URL门仅扩展当前公司对应的已验证完整页。必须做URL→该页span绑定，不能拿官网句子引用厂家页。原HTML可能含PII，继续原隐私、Subject、保留期及DSR，不在规范化字段/审计输出存个人信息。
6. canonical可能是品牌短名。仅凭逐目标已核身份FieldEvidence的UUID与原字符串值摘要，接受同WS/company、许可可match、未过期/未抑制、目标自站或已批准登记来源的完整法人名候选；厂家页不作其自己的身份依据。只做完整字符串格式归一后相等，不做子串/编辑距离/词语增删，不直接改活库名称。没有独立引用则未知。

## 新调用的明确授权与旧运行兼容

当前workspace Grant路径不校验technicalPolicyRevision，因此不能仅凭部署开关新增工具量。M1保留`executionContractVersion:2`及严格八字段ExecutionBudgetBinding；新增有限的`manufacturerNetworkRevision`到execute请求规范与requestSha256，缺省严格off。新quote为该revision增加最多50定向查询、50精确详情抓取，并记录其工作量；旧请求/旧Grant不能授权新feature。

该字段从DTO和请求hash，经准入、outbox、relay、父/子Workflow传到activity。新补证和新增T2视图仅在冻结的新revision下生效；旧历史与重放不新增调用，也不追认新规则。SaaS对应BFF规范化/透传与生成engine-client合同升级单独PR完成，正常SaaS报价/Grant/登录链不替换。不趁本功能重构所有workspace policyRevision语义。

## 已核实的采集接线修正

静态页面里存在真实公司h1和经销关系，不保证Readability正文保留它；实际工具只持久化正文、没有保留另行返回的title。已用合成HTML走真实converter→tool→artifact规范化→parser复现两种名称输入均MISS，不能把预制Markdown测试当成实际网页链路已经通。隐私规范化也会删除个人邮箱及其域名。

此缺陷在已批准来源范围内修复：现有单一selector增`manufacturer-network/v2`，v1与无selector的旧请求/键/转换保持原样；不增加第二公共签名字段，workflow2/八字段Binding/50+50上界不变。仅v2的精确HTML调用传内部`profileTextRevision:manufacturer-profile/v1`并绑定工具幂等键，从同一次HTTP200、Readability修改前提取唯一受支持profile的真实h1、文本、链接、国家和关系，保留否定和主体冲突。不得注入title/搜索/调用方名称补造事实，不加请求、重定向、缓存或renderer降级。

已读实际静态页面的AESSEAL locations模板，真实h1位于同一唯一canvas下的preface，正文在唯一locations article；不得把整个main及其相关内容合入。保留真实h1–h6原textContent并只规范空白，覆盖标题内嵌DIV，避免丢掉公司名或其他公司冲突标题。仅可剔除结构严格且全部文本恰为`×`的已识别关闭控件，否定或其他文字仍保留。真实页面内存预检只验证表示法，不代替Broker、回执、PG或正式资格结果。

只有邮箱域名的页面，可以从该profile真实email/mailto生成仅域名的受控producer投影，与原页引用分开，绑定版本/回执/制品字节；不存localpart或个人姓名，不伪造官网链接，不相信普通网页自造的标志。域名只作身份一致性辅助，仍需完整法人名、国家和独立身份依据。真实HTML运输注入必须贯穿converter/tool/artifact/Broker/PG/MinIO做正负例与重放验证；本地合成结果不能计真实企业。实现按前向迁移和现有CI真实PG测试接入，不加豁免。

## RED → GREEN顺序

1. 纯业务schema/模板解析：同目标官网域/国家/明确厂家关系可读；错国、错域、仅同名、目标自托管证书、关联发布者、过期、无关系声明、整站索引均拒绝或待核。
2. 真实Broker/制品回放：严格政策、robots、跳转、原时间；错误workspace/authority/company/producer/schema不能过；同URL跨subject不串证据。测试可注入工具替身，但不得将其结果当真实企业证据。
3. 提交及PG治理：artifact_reference真实receipt必需；ACK与业务写同事务、重放幂等；不走UNRECEIPTED或mixed apply旁路；sourceUrl/许可/允许用途/UUID/hash保留，抑制、跨租户和删除约束不退化。
4. 判定：T2装配、精确引用URL及对应span、新鲜度和规则版本；旧模式不消费M1调用/新来源资格视图，原judgment不重写。
5. 请求与报价：new revision参与requestSha；无/非法revision/旧Grant不启用新调用；新query/fetch上界确实进入服务端报价。SaaS标准请求与Backend规范逐字一致。
6. 相关单元/集成/E2E、相关80%以上覆盖、lint/build、真实PG、docs/governance/ContractGraph及必需CI、独立审查。只部署正式不可变制品到独立测试，再用真实来源和正常SaaS路径验收。

## 实施与保留边界

产品代码按逻辑变更形成可独立审查回滚的PR，必要SQL只做前向迁移与测试库私有备份；不改生产数据/配置，不启用platform schedules或触达。每源实际条款/路径/用途审核及启用属于测试配置，不宣称发布者给予全面内容许可。

原三个无快照UNKNOWN及ARO后续RESERVED保持原账本与恢复身份。新试验须证明不会自动重发这些未决恢复请求，不能借新accountKey逃逸；无法隔离则该执行保持阻断，继续必要修复。未取到完整证据就不凑30或100。

恢复独立测试身份的材料只保存在仓外持久私有目录；相同原值优先复用。新签名/证书及唯一测试账号恢复已另获明确附条件授权，但仍须冻结具体脚本、独立审查和正常TLS/JWKS/机器/集群实测；持久备份格式通过不等于完整恢复或产品ready。

## Global Constraints

- 用户明确批准的是独立测试中的厂家官方经销关系证据；至少2tiers、国家/产品/采购角色门不变，不推断当前采购，不开放协会/工商聚合/任意第三方网页。不得伪称人类验收、QGO、部署或新获客结果。
- 不修改生产、共享密钥/服务、现有业务/账本或原UNKNOWN；不通过新account/correlation/query伪造操作身份。测试替身只在测试入口，产品代码不fallback到fixture或直接出网。
- 一个mutable surface只有一个writer，保留其他writer/用户的改动与所有未跟踪数据。root只写ADR/计划和仓外测试恢复/SaaS分支；Task1实施者接管Backend应用/合同/迁移/测试及自己的changelog。独立审查者只读。
- 既有费用、相关提交/推送/审查检查后合入及独立测试发布授权有效；实施者只可作本地提交，不推送/开PR/合并/部署/付费搜索。后续外部动作由root协调。使用用户选择的模型，子代理继承，不为技能模板调整模型。
- RED→GREEN、相关80%以上覆盖和仓库必需检查不省略；可复用同source可信证据，不因阶段/定时机械重跑。独立审查发现的必修问题不因固定轮数停修。

## Task 1: Backend manufacturer evidence and signed execution integration

Owner：一名新实施者，工作区`/global/backend/.claude/worktrees/buyer-manufacturer-evidence`、分支`claude/buyer-manufacturer-evidence`、base`bdb05a0c0ab75fec64a249375a7b79feac7aff28`。接管本任务Backend产品源码、必要增量SQL治理迁移、生成OpenAPI与直接相关测试；不得改root的ADR/计划或SaaS/私有测试配置。你不是唯一writer，保留root已存在的两份execution helper文件（36测试通过）并延续实现，不回退其他文件。不派新subagent，独立审查由root安排。

要求以本文方案为准完成M1。`manufacturerNetworkRevision`接受`manufacturer-network/v1`和`manufacturer-network/v2`；v1维持原转换，v2显式选择下述同响应profile采集修正；现有workflow版本2和八字段Binding不变。新增执行快照至少包含planId/原attemptId/revision，经DTO→request canonical→quote→execute→outbox→relay→父/子workflow→activity传递；Node活动/relay重算Binding.requestSha256，Workflow不得导入node:crypto。无标记旧请求hash、quote及历史命令保持原样，厂家新调用与资格视图严格off。

新quote只对该revision额外计50次定向Searxng和50次exactHtml fetch；不冒称旧quote覆盖，也不做Workspace通用policyRevision安全重构。工具沿GLEIF/Wikidata独立确定性adapter，不冒用AI task白名单；新source默认为DISABLED，严格逐源/路径/用途审核后才能使用。支持厂家独立详情页、一次lookup一次fetch每公司；搜索摘要不作事实，模板未知/主体冲突/发布者独立性未知/来源不准入诚实待核。不得只凭不同域名就证明独立控制，也不得硬编码目标公司来凑数量。

业务合同`manufacturer-network-evidence/v1`复用既有producer：Searxng=typed_projection/searxng-search/v1，fetch=artifact_reference/crawl4ai-fetch/v1。按producer/schema/strategy/authority/WS/company/持久引用逐项严校。命名空间、FieldEvidence出处/许可/用途、身份/时效、SQL规范治理、T2装配、判定输入和URL→该页span校验必须端到端接通，单mock matched:true不够。必须保证普通raw/API输入不能伪造新T2证据；若必要写权限/不可变标记缺失，应明确补闭环而非相信字段名。

先完成真实Broker/持久制品到同事务ACK/写回/实际判定的RED→GREEN。旧/错revision、旧Grant、篡改快照、错source/subject/回执、跨WS、同URL跨company、已抑制/过期/撤销/自托管/错误国家及伪造引文均需负例。保存原manifest采集时间，重放不能刷新时效。增量SQL保持owner/ACL/pg_temp最后，不扫改历史；没有现成触发器就不虚构其故障。需要PG时只用全新专用临时测试PG，不碰保留的15433实例，不改变任何现存角色/认证配置。

完成相关测试、范围覆盖、lint/build、OpenAPI正规生成与治理/文档检查，检查diff/秘密/边界后只提交本任务拥有文件和changelog（Conventional Commit），不stage root文档/计划。将完整报告放本计划workspace的`task-1-report.md`，含提交范围、实际测试、RED/PG/覆盖证据、迁移说明与未做；返回简短状态/commit/测试摘要/风险。若依赖SaaS或无法满足安全门，报告具体证据，不做旁路。SaaS消费者由root单独分支/PR处理。

## Task 2: SaaS canonical execution and generated contract consumer

Owner：root在独立SaaS worktree，沿其AGENTS。复用同一execute-only canonical helper，保证通用BFF报价/透传、AcquisitionTask执行和Web调用的revision一致，不影响ICP/计划生成。Backend新API可用后按engine-client README从固定目标生成/更新pin与types，独立PR，不手改生成物。技术revision不进入面向最终用户的选项/解释。默认旧行为兼容，未知版本在出网前拒绝。

## Task 3: Isolated normal identity/runtime recovery

Owner：root；独立安全审查者只读。仅原buyer-test容器/卷/数据库/账号，复用已保留原值；缺失时执行已批准、精确脚本审查后的新材料恢复。持久0700/0600，不从共享生产.env/PKI脚本读取或写入。不改用global运行SaaS、不新建用户或workspace；正常SaaS/JWKS/Grant/机器mTLS/native协议。先核已有namespaces与真实clusterId，不重新provision历史，不把健康live或备份目录格式当产品ready。完成后与Task1/2正式制品集成，再开真实搜索。

## Task 4: Source review, real samples and 30/100 delivery

Owner：root；逐条事实另独立复核。先3–5个明确正负例，用正常API新专用ICP的冻结域范围隔离四个原未决对象，不改其业务/财务状态。小样本只验证接线，不宣称搜索发现能力；到30扩大前必须明确技术隔离/hold或正式恢复路径，不能悄悄跨account重发。后续按已批准产品/国家/采购场景正常搜索，报告旧库首次交付与本轮新搜，逐条证据卡+正式结果交集才计30/累计100，人类验收另列；持续新增须真实新增，不循环旧12/首批30。

## Task 5: Restore the documented homepage-only robots fallback

独立的小型bugfix与独立PR，作为深层厂家详情真实抓取前的依赖。已核`apps/api/src/adapters/robots.ts`普通网络失败返回空Disallow，`isAllowedByRobots`对任意深层URL均放行，与现有注释“只放行首页，不放行深层”不符；`builtin-tools.ts`的客户抓取路径确实会调用这个检查。修复应保留首页历史降级、正常成功规则/无robots语义及SSRF、workspace suppression、durable ACK/physical fence拒绝的现有强边界，仅阻断未获得规则时的深层抓取，不引入新调用、旁路、预算或身份算法。先RED复现普通网络异常/HTTP5xx的深层放行与缓存复用，再GREEN；完整相关单元、必要覆盖、构建/治理/文档/ContractGraph和独立review，按已授权流程合入与只测试发布。不得混入Task1已有commit或由Task1实施者并行改同文件。

Owner：Task1实施者DONE后才派一位新实施者（SDD不并行两位implementation child）。独占`/global/backend/.claude/worktrees/buyer-robots-deep-guard`，branch`claude/buyer-robots-deep-guard`，base`bdb05a0c0ab75fec64a249375a7b79feac7aff28`；负责`apps/api/src/adapters/robots.ts`、直接相关测试与自己的changelog。不得改Task1/SaaS/私有测试环境或其source policy。其他writer存在，保留其改动。root预备了独立worktree与离线依赖，不链接.env，不接生产/保留15433库。不能自行派子代理，独立review由root安排。

要求只把“未取到规则”与“成功读到空规则/正常4xx无robots”内部状态分开，普通网络/HTTP5xx未知时只保持首页旧语义，深层路径包括缓存复用均不可放行；成功200、真正404无规则及显式Disallow的既有处理继续。SSRF/超限、当前workspace拒绝、物理fence拒绝以及ACK_UNKNOWN不得被缓存成普通网络降级或跨workspace污染。不能通过额外HTTP请求、换UA、跳过robots、开生产开关解决，也不做通用parser/RFC/UA选择重构。测试应覆盖相同origin先首页后深层、先深层后首页，以及故障分类的既有回归；文档如实写普通homepage降级仍存在，不能称全域robots严格failclosed。

先查精确worktree ContractGraph，再核真实调用点与测试；相关范围覆盖80%以上、API构建/相关lint、docs/governance、秘密/diff检查，所有结果写本计划workspace`task-5-report.md`（注明源码commit/命令/实际scope/未做）。只允许本任务ownedfiles本地Conventional Commit，不push/PR/merge/部署/付费调用。独立最终review与外部动作由root完成；用户已授权同scope必要修复/相关提交推送/检查审查后合入/仅独立测试部署，不需重复请求。
