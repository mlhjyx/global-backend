# 平台撤销恢复：已批准差额规格

> 生命周期：`APPROVED`
> 生命周期依据：已批准规格；恢复查找原语已合入，其余在 R4 线（#545 与 GrowthOS 105 补丁线）进行中

状态：**USER_APPROVED / IMPLEMENTATION_PENDING / NO_RUNTIME_ACCEPTANCE**。

2026-09-13 用户明确同意推荐方案并要求继续实施。原冻结提案 `/var/tmp/parity-revocation-recovery-decision.md` SHA-256：`ddba48051c4435577d027ad200a69c782560acf04a1a65353fe069439ca7e5fc`。以下提案正文保留审查时措辞作为 provenance；其中“待用户确认”已由本批准记录覆盖，U1–U5 的事实核验、安全边界和未知状态处置并未豁免。产品实施与运行验收分别取证。

本文件仅供父代理独立审查后提交用户确认；不是实施计划、凭据签发许可、部署许可或运行证据。只写本临时文件，不修改 Backend/GrowthOS 产品文件。目标是在复用已批准撤销合同的前提下，覆盖已证实的恢复缺口，不新增客户计费、Grant 业务或自由调度。

## 1. 决策摘要

独立审查确认 request/attempt 恢复是必要差额；只读 lookup 是推荐取舍，并非唯一最小实现。推荐以下组合：

1. **可恢复 target 观察**：增加 Backend 只读 exact-target lookup。优先复用 GrowthOS 既有 identity 签名 keyring/JWKS 根，签发专用 audience/scope/subject/typ 的服务 token；使用受控且服务端身份经过验证的 HTTPS 直接读回闭合响应。**不再增加 Backend target-proof 签名 keyring/JWS。** 响应仅帮助选择 locator，最终 authority 校验、schedule fence 和生效凭证仍完全依赖既有 Backend 事务与签名 ACK。
2. **append-only command successor**：将一个 immutable disable request 与多个不可变投递 attempt 区分。首次命令尚未确认已提交且已过期时，可以为同一请求、同一 schedule、同一 fence sequence、同一撤销原因追加新 JTI 的短期命令；保留每个原始字节、digest 和历史。不把缺 ACK 当成未提交证明，Backend 的同 sequence 仲裁仍是安全基础。最终任何一个真实、精确绑定已登记 attempt 的 ACK 才使整个请求有效。

这是有安全语义变化的推荐方案，不因复用密钥而自动属于旧批准。用户需要确认新增只读服务权限、同请求 successor 规则及下述有限 target 重选规则。**不推荐直接实现旧 target-proof addendum；它额外引入签名根，却仍未覆盖命令首次提交前过期和已冻结错误 target。**

现有代码支持的基础：同一 schedule/sequence 的 Backend receipt 唯一；第一次成功 fence 后，其余不同 JTI 的同 sequence 命令不能再 fence；任一已成功命令可以原字节重放查回自己的 ACK。拟议方案不修改该 wire schema 或这些 PostgreSQL 规则。

## 2. 已核验证据与三个窗口

Backend 独立复核检查点：`/global/backend`，`b07090011de652385aa53b17f6fd73c0e2e466d5`。相对原 `5afc2f699b6fa0a6880441437c3b79248f349380` 的 platform-authority、相关迁移及合同无源码差异。GrowthOS 补丁仓：`/root/.codex/worktrees/growthos-platform-authority-20260908`，`cbac08f9244230e708918191d9e02b7df9b24a89`；0099 是未跟踪候选补丁。这里只证明源码行为，不证明该补丁已部署或这些窗口已发生于保留数据。

| 窗口                                        | 源码事实                                                                                     | 必须达到的结果                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| W1：issuance committed、Backend 尚无 target | 0099 取最新 issuance 并冻结 outbox；Backend 找不到 exact authority 时在 fence/receipt 前拒绝 | 不伪造 authority；优先选择实际存在的本方 locator；已存在的错误 target 命令通过受限 successor 恢复 |
| W2：首次 Backend fence 提交前命令过期       | revoke TTL 为 300 秒；没有 receipt 时 Backend 即使收到原命令也拒绝过期                       | 在同一 disable 请求/sequence 内恢复投递，不改旧字节、不扩大授权、不假装过期命令曾成功             |
| W3：Backend 已提交、ACK 响应丢失或过期      | exact receipt 重放不再 fence；receiver 返回持久化 ACK winner                                 | 原命令重放取得同一个签名 ACK；不得因响应不明重复推进 generation                                   |

承重引用：

- 已批准规格 §5 的历史施工来源：`/global/backend/.codex/worktrees/platform-receiver-rebase-20260912/docs/superpowers/plans/2026-09-08-platform-proof-approved-spec.md:37`。独立撤销控制面，复用既有合同，缺合同需规格评审；该候选引用不代表已进入 main。
- GrowthOS 最新 target、命令冻结与 target SQL 的跨仓施工来源：`/root/.codex/worktrees/growthos-platform-authority-20260908/patches/0099-platform-disable-outbox-ack-transactions.patch` 第 116、16 行。
- [Backend receipt、exact replay 与 target/expiry/sequence 检查](../../../packages/db/prisma/migrations/20260908120000_platform_signed_revocation_receipt/migration.sql)：审查基线第 27、87、108 行。
- [现有撤销与 ACK 闭合合同](../../../packages/contracts/src/platform-authority/revocation.ts)、[receiver 的 durable ACK winner](../../../apps/api/src/platform-authority/platform-revocation-receiver.ts)：后者审查基线第 21 行。
- GrowthOS 原 TARGET_BOUND ACK 限制位于上述跨仓 `0099-platform-disable-outbox-ack-transactions.patch` 第 148 行；这是必须调整的本地状态派生，不能只增加新表而不改消费条件。

独立复核的 ContractGraph 返回 `ok: true`，绑定 `b07090011de652385aa53b17f6fd73c0e2e466d5`；SQL 函数未被 query 索引到，因此 SQL 结论来自直接源码检查，不宣称图覆盖完整。

## 3. 比较的选择

| 选择                                                               | 新的信任/接口                                                    | 覆盖能力                                                                  | 判断                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| 仅原样重试 0099                                                    | 无                                                               | 仅 W3；W1/W2 可永久 pending                                               | 不满足本次恢复目的                               |
| 仅用既有 Temporal history 选 target                                | 可不新增 key/API；需定义 admission 观察合同                      | 能观察成功 activity；无法保证 PG commit 后 completion 丢失窗口有成功历史  | 可作未来辅助，不作为唯一恢复条件                 |
| 不新增 lookup，按候选追加 successor 走既有 fence endpoint          | 不新增读接口或信任根；仍需多 attempt 与有限重选新合同            | 可恢复 W1/W2/W3，但每个候选失败后需等待过期，发现与撤销共用有副作用的接口 | 可选的较小实现；恢复速度与诊断性较差，不作为推荐 |
| 旧 addendum：专用 reader key + Backend 签名 proof                  | 新 API、两套专用 keyring/信任配置                                | 改善尚无 outbox 的 W1；排除旧错误 outbox；未解 W2                         | 不推荐作为最小闭环                               |
| **推荐：共用 identity 根的专用读权限 + HTTPS locator + successor** | 新只读 API/授权用途；不新建签名根；本地 append-only attempt 合同 | 覆盖有可定位 Backend authority 的 W1/W2/W3                                | 待安全前提核实及用户批准                         |

Temporal reader 当前只检查 start/RUNNING 等任务证明，不检查 admission completion。即使复用其 mTLS 权限，也不能把未知历史当 absence。上述推荐不依赖 Temporal history 恰好保留成功 completion。

## 4. Exact-target lookup：最小接口与信任边界

### 4.1 固定操作和输入

拟议 operation identity：`platformAuthorityTargetLookup_v1`。具体 HTTP 路径在 code-first 合同中唯一确定，不在多文档手抄；使用有界 POST，业务语义为只读。

请求是闭合 JSON，包含 `target_issuer`、`target_jti`、`schedule_id`、`workflow_run_id`、`nonce`。前四项重用既有 revocation 对应字段的校验；nonce 是每次 lookup 新生成的 128-bit 随机值，编码固定为 32 位小写 hex。调用者不能指定数据库、namespace、任意查询条件、外部 URL 或 workspace。

仅查询 committed 的 `scope_key=platform`、`authority_kind=PLATFORM_GRANT` 与 exact issuer/JTI/schedule/run；过期或已 revoked 的 authority 仍可作为 schedule fence locator，这与现有 Backend SQL 一致。不得创建、消费、刷新 authority、启动 Workflow、reserve 费用或访问 Provider。

### 4.2 复用签名根，但不复用其他用途 token

拟议 reader token：RS256，JOSE header 仅 `alg/kid/typ`；typ=`platform-authority-target-reader+jwt`；audience=`global-backend:platform-authority-target-read`；scope 为唯一字符串 `platform-authority.target.read`；subject 固定为部署配置中的 GrowthOS control-plane 服务主体，不通过普通 role 映射。

闭合 claims：`iss,aud,sub,scope,jti,iat,nbf,exp`。issuer/JWKS URI/kid 集合来自独立受控部署配置，不采纳 token 内 jku/x5u 或请求指定根。固定服务 issuer 在配置中映射到唯一允许的 Grant `target_issuer`，用户不能借输入切换映射。

NumericDates 是有界非负安全整数；`iat <= nbf < exp`，TTL≤300 秒，iat/nbf 未来容忍≤60 秒，**now<exp 严格生效，不沿用 quote verifier 对过期的宽限**。kid/RS256 key 位数/重复 key/私钥字段/重复 JSON key/UTF-8/体积约束沿现有严格 verifier 模式；实现前抽取可复用纯校验，不扩大旧 quote 或普通用户 guard 的可接受用途。

共用 identity keyring 的批准含义：接受相同签名根服务于新增的专用 service-token 用途；**不接受任何现存普通用户 token、quote token、Budget Grant、revocation command、ACK 或 capability JWS 直接调用此 API**。签发端必须 server-owned 地固定服务主体与权限，不能提供让用户提交任意 sub/aud/scope 的通用签发入口。若现有 identity keyring 的管理边界不能做到这一点，此复用选择不成立，需返回独立 keyring 决策，不能静默 fallback。

### 4.3 HTTPS 响应，不签第二份 proof

GrowthOS 只访问部署清单固定的 Backend HTTPS origin/path；验证服务端证书链、hostname 和受控 CA，禁止不验 TLS、HTTP fallback、redirect、caller URL、非受控 proxy/自动跨源转发 Authorization。信任根/地址可按环境配置，不更换实现。JWKS 获取也须满足受控根、TLS、无 redirect 和大小/timeout 边界。

成功响应为闭合 JSON：`schema_version=platform-authority-target-observation/v1`、原 nonce、exact 四元组、`found=true`、`observed_at`。不返回不必要的 Backend 内部 authority UUID。时间为 NumericDate；只在当前 in-flight 请求中接受相同 nonce/四元组，响应年龄≤5秒且不得超允许时钟偏差；不缓存成功响应跨请求复用。请求体≤4KiB、响应≤4KiB、JWT≤16KiB、单次总deadline≤2秒，使用每服务身份的原子限流，响应 `Cache-Control: no-store`。

NOT_FOUND 只表示该次 committed snapshot 未找到该 exact tuple；UNAVAILABLE 包括 DB/网络/认证依赖/超时不可判定；两者都不是“全局无 authority”或 fence 成功证据。未认证/无权限请求在 DB 前失败，错误不回显 tuple、查询结果、SQL、token 或用户数据。

该响应是**经服务端认证的同步 locator 观察**，不是可转交验证的 Backend 签名证明。GrowthOS 只保存必要 validated tuple、nonce/digest、时间和受控部署引用，不保存 token/raw JWS、原始 HTTP 或个人数据。不能把这些记录标记为独立签名 RuntimeEvidence。

省略第二份签名的理由：即使 locator 观察陈旧或错误，最终 Backend 仍执行 exact target 和 schedule/run 校验；lookup 绝不使 GrowthOS 进入 EFFECTIVE。要伪造成功仍须突破既有 ACK 签名或 Backend fence，而不是仅提供 lookup 响应。错误观察可能造成可用性故障，故仍要求 TLS、绑定、限流和 fail-closed；这不是放弃服务端真实性。

### 4.4 DB 权限建议

优先沿既有 `inspect_platform_egress_fence_v1` 的受限函数/专用 principal 模式：新增只读 SECURITY DEFINER exact lookup 函数，固定 search_path、参数化、只返回 allowlisted 字段；只授予已存在且经 attest 的 `execution_budget_platform_writer` 执行，不授予表 SELECT，不用 app_user/owner fallback。这样不新增数据库 credential，也不让普通 API principal 枚举 platform authority。必须核实 lookup composition 可以复用已被授权持有该连接的安全边界；若会把平台 writer credential 引入原来无该权限的新进程，则该前提不成立，需单独审批权限设计。

## 5. GrowthOS 本地模型：请求恒定，attempt 追加

### 5.1 不可变请求语义

逻辑 disable request identity 是已持久的 `(schedule_id,fence_sequence)`；其 immutable 内容至少绑定授权 issuer、schedule、reason、创建时间和创建时的 policy revision/provenance。request digest 采用明确 canonical codec，作为 attempt 外键语义，不新增到现有 revoke wire claims 中。

同一 policy 行锁下从 ENABLED 转 DISABLE_REQUESTED，停新 issuance，并记录请求；不根据“issuance 存在”自动创建未证明 target 的新 outbox。已有 request 的 reason/issuer/schedule 不得改写；已有 NO_TARGET 是创建时快照，后续有效 target 状态由追加的 observation/attempt 推导，不能原地改成 TARGET_BOUND。

**旧请求若没有持久记录能确认授权 issuer 或原始请求语义，不能靠当前配置猜出后续授权**；迁移分类为 RECOVERY_BINDING_UNPROVEN，并保持 pending，等待精确人工审查。这是遗留恢复前提，不自动扩大旧请求。

### 5.2 候选和 observation

请求转 disabled 时，在既有 issuance/policy 锁序下确定候选上界；禁用状态下 issuance 不能追加。候选仅为该 schedule、配置绑定 issuer 且来自本方 immutable issuance 的历史行；不要求候选 Grant 仍有效，因为 locator 不是消费授权。

不持有 DB 锁进行网络 lookup；每轮最多8个候选、总deadline≤10秒，durable cursor 公平轮询；NOT_FOUND/UNAVAILABLE 不永久移除候选，到尾重新扫描，间隔按1s/5s/30s增长，稳定后每分钟最多一轮。durable cursor 不得通过同一不可用前缀饿死后续候选。recovery 不重签/重发 Grant、不重新启动 Workflow 或模型。此前已证实的老 target 可优先，而不是偏好最新 issuance。

采用 observation 时重取 policy 锁，确认同请求/sequence 仍 pending、tuple 对应本地 immutable issuance、nonce/current attempt 匹配、观察仍新鲜；在同事务追加 observation/attempt 及加密命令。多个恢复者只能产生一个当前有效投递 attempt；竞争失败者读取已提交 winner，不返回未提交签名字节。

### 5.3 首次 attempt 和既存旧 outbox

无 outbox 的 pending 请求获得有效 locator 后创建首次 attempt。原 0099 outbox 不删除、不覆写，保留原 JTI、digest、ciphertext、claims、expires_at；forward-only 映射使其成为该请求的历史 attempt 0。映射必须验证原始签名/claims 与本地请求/issuance 一致，不合格遗留状态保持隔离。

新 observation/adoption 不能绕开既有 ACK 验证。ACK gate/existing-state 派生必须由“原请求 + 登记的 attempts + 真实 ACK”计算，兼容 creation-time NO_TARGET；禁止继续以原 target_state 单字段拒绝所有恢复后的 ACK，也禁止有 outbox 即认 EFFECTIVE。

## 6. 命令 successor：续接投递而非新业务授权

### 6.1 允许追加的严格条件

仅在同一 request 仍 DISABLE_REQUESTED、无本地有效 ACK、已有 attempt 已按受控时间源过期、且没有仍有效的 successor 时，追加下一个 attempt。先优先原字节重放所有未确认历史 attempt，尝试查回 Backend receipt/ACK；查询不明时不宣布未提交。即使提交结果未知，后述同 sequence 唯一性仍防止第二次 fence。

时钟约束：GrowthOS 与 Backend 的部署必须有受监控的最大时钟差≤60秒；新 attempt 在本地可信 now≥前序 exp+60秒后才可创建。时钟健康未知立即停止 successor 但继续原字节 ACK readback。不可机械拿用户/HTTP时间当 now。该等待是减少重叠的防护，安全性最终仍由 Backend 同 sequence 串行/唯一性保证。

successor 必须保持：原 request、issuer/target issuer、audience、schema_version、schedule、fence_sequence、reason。只允许新的 `revocation_jti`、`iat/nbf/exp`、受控轮换后的 signing kid，以及下述受限 target 选择。TTL 仍≤300秒，不延长或重签旧 token。每次追加绑定 predecessor attempt/digest 与 ordinal；每请求一个当前有效 attempt；无ACK情况下以过期周期恢复，不按HTTP错误高频签发。签名/加密/插入失败回滚该 attempt，原请求和历史不变。

### 6.2 有限 target 重选（须用户明确确认）

对已有有效 locator 的 attempt，successor 默认保持同 target；不为了新鲜度更换。对旧0099冻结但无法确认存在的 target，前序已过期后可采用同请求候选集合内、刚经 exact lookup 确认存在的另一个本方 target，并追加 successor；必须保留原 target 和不成功观察的审计，不写“旧 target 从未 admitted”。不允许在仍有效的原命令期间换 target，不允许跨 schedule、issuer、reason 或隐式变更 sequence。

这一变化之所以可评审为同一撤销意图：现有 SQL 的实际效果是**关闭整个 schedule**，target 是必须存在且归属匹配的 locator；它不是只关闭某个 run。任意合法候选均只触发同一个原 schedule 的相同 disable，且最多提交一次。但 target 变更仍是原0099本地冻结约束的放宽，必须在本差额规格中明确批准，不以“内部重试”隐瞒。

若原请求的授权本来只允许撤销指定 Grant 而不是关闭 schedule，则不允许此重选；必须通过请求来源/旧规格证据核实，这是启用前阻断条件。

### 6.3 Backend 不变，以及为什么不会重放/降序/新授权

Backend 保持现有 verifier、revoke claims、`apply_platform_revocation_fence_v1` 和 ACK 格式：

- exact issuer/JTI/schedule/run 仍先校验；不存在的 target 永不 fence。
- 同 schedule 行锁串行处理；receipt `(schedule,sequence)` 唯一，要求新 command 的 sequence 大于 fence 已提交 sequence。故同一请求的A/B无论顺序，只能一个 first commit，generation只增一次。
- 若A早已提交但ACK丢失，B不能 fence；B的sequence conflict只作为待查回信号，**不是成功ACK**。恢复器继续原字节重放A，读取A的既有receipt和持久ACK。
- 若A尚未提交且过期，它不能在B之后被首次接受；即使时钟边界出现有效重叠，也由同sequence first-commit规则仲裁。
- exact A 已提交后过期重放，只返回原receipt/ACK，不改generation、不重新撤销或发wire。
- 若Backend已有更高sequence，而本地没有可验证的本请求ACK，保持STORED_STATE_CONFLICT/NOT_READY；不能自动sequence+1、把他人更高fence当本请求成功或用新attempt反向覆盖。
- successor不发Grant、不增加预算、不恢复消费、不重试UNKNOWN物理请求，只重复同一关闭意图。无法证明请求原始授权时不签successor。

保持ACK验签材料可读是必要前提：revocation历史签名公钥与ACK历史验签公钥须有与恢复周期一致的受控保留；secret仅用于合法新签名/解密。不得在旧key删除后把未知签名当真，也不得为“恢复”自动轮换key。历史ciphertext不可解密或签名根失效时保持pending并报告实际阻断。

### 6.4 ACK 接收与公平恢复

ack的`revocation_jti + command_sha256 + schedule + fence_sequence`必须定位到该请求已经committed且不可变的**某一个**登记attempt；不只接受最新attempt，也不接受未登记但同schedule/sequence的命令。ACK签名、issuer/audience/typ、key用途、generation/committed_at/in-flight claims继续按现有contract验证；过期ACK只用于精确已登记请求的历史读回。

同policy锁内append ACK receipt并派生DISABLED_EFFECTIVE；并发不同ACK只可接受与同一个Backend winner一致的绑定，冲突fail closed。ACK生效后停止创建/发送新的successor；在途重复response只能幂等读回，不能推进状态第二次。Backend `in_flight_attempts>0` 时仍明确表示send-cut之前已进入SENDING的旧请求可能完成，不宣称撤销了已经发送的物理调用。

恢复按durable公平cursor遍历历史未确认attempt，单轮最多8条、10秒；优先当前已知可能成功项，但不能因新successor不断追加而饿死旧的实际winner。transport不可用时延后新签发，不无限预造过期命令；restore后先查回。长期pending不删除历史，不伪造完成，设置有界报警与readiness阻断。

## 7. Capability 和控制面语义

revocation consumer仍独立于平台业务Worker准入启动，只执行lookup/revoke/ACK恢复，不做Provider或Grant业务。关闭policy后新issuance拒绝，不代表Backend fence已有效。

capability的undeliveredCount定义为**尚无真实ACK的逻辑disable请求数**，包括NO_TARGET、无outbox、过期attempt、cipher不可读、Backend state conflict；同请求多个attempt不得重复计数。oldestUndeliveredCreatedAt取原请求创建时间，不能按observation、successor或重启刷新。这样未决请求超过已批准30秒期限会使capability/readiness fail closed，零outbox不能被当成零积压。consumer lease与部署identity约束维持原规格。

no-target-ever、所有候选不可判定或trust失效时保持pending/NOT_READY，不声称全局不存在、零影响或DISABLED_EFFECTIVE。**本方案不提供target-free fence**。用户若要求从未有任何Backend authority的schedule也必须产生“有效撤销ACK”，仍需另立不同授权合同，不在本方案中隐含承诺。

## 8. 精确影响边界（不是实施拆解）

Backend：

- `packages/contracts/src/platform-authority/`：新增lookup请求/观察与专用service-token用途合同；code-first operation唯一真值及闭合负例；不修改revocation/ACK已有wire schema。
- `apps/api/src/platform-authority/`：新增只读controller、专用身份verifier/composition、lookup repository；复用严格验证原语而不扩大旧quote/identity guard；现有receiver/ACK存储和fence算法预计无需语义变化。
- `packages/db/prisma/migrations/`：一个forward-only只读lookup函数与精确EXECUTE权限；无authority创建/消费/数据修复；不改signed-revocation first-commit/expiry逻辑。
- 受控配置/部署：已有identity JWKS的新增用途allowlist、固定HTTPS信任清单、现有platform writer连接边界；key/service权限、TLS终止链、时钟健康必须真实验证。

GrowthOS patch/source权威：

- `PlatformAuthorityDisableMapper/Service`及对应migration：request/attempt分层、旧outbox append-only映射、observation、predecessor/ordinal/immutable constraints、ACK可引用任何登记attempt、真实pending派生。
- 服务身份签发composition：复用identity keyring但固定专用service用途；bounded HTTPS lookup client；独立consumer对历史ACK、公平cursor、successor和backlog事实负责。
- 不改Grant issuance业务、费用规则、技术quote、Temporal任务证明，不将其他worker正在开发的capability codec作为本方案隐式修改范围；只声明pending事实应如何由其producer提供。

共同门：cross-language合同、真实隔离MySQL+PostgreSQL跨库测试、read-onlyauth/TLS负例、相关≥80%覆盖、docs/governance/ContractGraph及独立review。runtime部署仍需固定exactsource/image/migrations/信任revision，不由本临时文件证明已完成。

## 9. 必须通过的负例与竞争验收

1. 普通用户、quote、Grant、ACK、capability token，即使同key/issuer有效，也不能访问lookup；错误sub/aud/scope/typ、extra scope/claim、duplicate JSON/JWK、wrong key用途、过期token均在DB前拒绝。
2. token签发入口不能通过用户参数生成此服务身份；普通身份权限提升为此scope失败；未知issuer到target issuer映射失败。
3. wrong TLS CA/hostname、redirect、HTTP downgrade、非受控proxy、任意endpoint、超大/慢响应、错nonce/tuple/encoding均失败；不暴露Bearer。
4. 合法 platform tuple 可读；tenant、非 platform Grant、跨 issuer/run/schedule 不可读；读取前后 authority/预算/fence/attempt/费用表零业务变更。
5. W1：A 已 admitted，B 仅有 issuance。新请求只从确认过的 A 创建命令；旧错误 B outbox 保留，在 B 过期后用同 sequence 的 A successor 取得真实 PostgreSQL fence 和 GrowthOS ACK。
6. 初次 NOT_FOUND，原 Grant 随后正常 admitted：轮询能发现；没有 replacement Grant 或第二次模型调用。全部 NOT_FOUND/UNAVAILABLE 仍 pending，无全局不存在的结论。
7. W2：正确 target 但 Backend 停机超过命令 TTL；恢复后追加同请求 successor，旧 token 字节与 digest 不变，仅一次 PostgreSQL generation 推进。命令有效期内不得重新签发，时钟不健康不得 successor。
8. W3：原 command fence 已提交但 ACK 丢失，随后本地产生 successor：successor 不能再 fence；公平重放找到原命令 ACK；过期 ACK 精确验证后有效。
9. A/B 命令锁等待和到期交错、两个 recovery 实例同时创建、旧 ACK 与 successor 创建同时竞争：只一个当前有效 attempt、只一个 Backend receipt/generation 增量、只一个逻辑 effective 结果。
10. 错 request/issuer/schedule/sequence/reason 的 successor、跳过 predecessor、改原 target 字节、改旧 outbox、伪造 adoption、无本地 issuance 的 target 均拒绝。
11. ACK 绑定旧登记 attempt 可接受；绑定未登记 JTI/digest、其他 request、另一 sequence、错误签名或冲突 receipt 必须拒绝；HTTP 200 或 sequence conflict 绝不是 ACK。
12. Backend 已有更高 sequence 时不能自动加 sequence 或误认成功；先前 request 的迟到 ACK 不能完成另一个 request。
13. NO_TARGET 后追加 target/attempt 能够接受真实 ACK，不再被创建时的状态快照挡住；零 outbox 但 pending>30秒使 readiness 失败，successor 不重置 age。
14. ACK winner 被历史 cursor 公平查回；大量候选/attempt/并发有界且不饿死；重启恢复相同 cursor/逻辑请求，不删除 unknown history。
15. issuer/ACK 公共验证 key 移除、cipher key 不可用、旧 request 缺原授权绑定、TLS trust 变化时 fail closed；不能假装恢复成功。
16. 真实跨库测试分别模拟 MySQL commit→PG admission、PG fence commit→ACK store、ACK store→response、GrowthOS ACK insert→policy transition 失败/回滚；源码/tests 不能替代部署 readback。

## 10. 未决安全前提和用户要确认的差额

独立审查通过前，以下不能写成已核实：

- **U1 Identity根与签发权限**：本机存在identity-keyring实现证据，但未审计当前部署issuer/kid/JWKS与调用主体能否安全签发固定专用service用途；不读取secret来“证明”。同key compromise的blast radius扩大由用户接受，或选择独立根。
- **U2 受控HTTPS路径**：尚未证明GrowthOS→Backend部署已有符合上述要求的HTTPS/TLS终止与代理链；如只有loopbackHTTP/Unixrelay，不能把它标成HTTPS或静默降级。可在单路径配置中建立受控HTTPS，但其证书/端点/部署动作需明确授权及验证。
- **U3 原始撤销意图**：现有 SQL 是 schedule-wide fence，但旧 disable 请求的授权来源是否确实许可关闭该 schedule 而非仅撤销特定 Grant，需要审查旧确认/入口。未证明前不能 target 重选或给 legacy request 补 issuer。
- **U4 复用DBprincipal、时钟与key保留**：部署composition是否本已持有platformwriter、可验证时钟界限、恢复窗口内历史verification/decryptionkey保留尚待检查；任何不满足都保留pending，不创建新credential或自动旋转。
- **U5 target-free 产品接受条件**：用户是否接受从未有 Backend authority 的请求保持 pending 且 not ready；如不接受，当前推荐仍不够，必须额外审批 target-free fence 合同。

建议交给用户的精确决策：确认“增加专用只读 target lookup 用途、优先复用现有 identity 信任根并以受控 HTTPS 读回；不新增 Backend proof 签名；允许同一已授权 schedule-disable 请求/sequence 下的 append-only 过期命令 successor，且仅在上述条件满足时重选本方已存在 locator；所有生效仍需真实 exact ACK；unknown 和 target-free 状态不伪造完成”。

这项确认不自动消除U1–U5事实核验；若核验需要改变信任根、外部权限、原请求授权或target-free语义，提交差额，不擅自实现另一个方案。

## 11. 迁移、停止和回退原则

只做forward-onlyschema/受限函数；保留原request/outbox/ACK/authority/receipt和所有独有历史。不以测试需要为由改写保留数据。新旧服务混跑时不得让旧consumer误读多attempt语义：部署切换需停旧control-planeconsumer、保留pending，核对新consumeridentity后受控启动；不同时存在两个不同语义writer。

回退是停用 lookup/successor producer 并继续 fail closed，不删新历史、不回滚已生效 fence、不重新 enable policy。已经接受新 attempt 的库不能直接配回只认原 outbox 的旧 consumer；如必须回滚 binary，先提供兼容 readback 路径，否则保持 not ready。平台业务 Worker 不因回退绕开 readiness。

交付到此为**待审查决策规格**；没有批准、实现、迁移、凭据变更、部署、真实调用或用户验收结论。
