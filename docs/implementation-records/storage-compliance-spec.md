# 收口⑥ 存储合规收口 —— 设计定稿（spec）

> 2026-07-11。六项工程收口最后一项。上游权威：[ADR-010 COMPLIANCE-SCORING](../adr/registry.md) + [ADR-003 DATA-PLANES](../adr/registry.md) + [platform-top-level-design-v1 §11/§6.3](../research/platform-top-level-design-v1.md)（frozen 研究，已蒸馏进 ADR-010）。本收口=把散落的合规「代码纪律」升级为**一等事实 + 确定性引擎 + 删除编排**，让存储侧 GDPR/PIPL 义务可判定、可审计、可执行。

## 0. 范围与不做（KISS/YAGNI）

**做（release-plan §1 ⑥）**：`DataRightsService.evaluate()` + 7 动作词表 + `policy_decision_log` + `lia_record` + Art.14 通知义务判定；`deletion_request`/`deletion_receipt` + `deletionWorkflow`；`dataClass` 列；PII 列级加密；DB 角色拆分；`jurisdiction_policy`（含 PIPL 行）。

**验收（三条）**：① DSR 全链演练通过；② **删除编排先于任何发送上线**（本收口建成即满足该时序门）；③ 具名决策人字段加密落库。

**不做（YAGNI，归后续）**：制裁名单筛查（待拍板，qualify 第五门）；OPA 引擎（PolicyPort 抽象够用，规模化再引）；OUTREACH/VIEW/EXPORT **执行点**（归 SaaS B 侧，本仓只产**判定**供其消费——责任三栏 §11）；`consent_record` 撤回联动表（Art.21，随 R1 发送侧建）；全 4 连接串角色插拆（见 §7 演进）。

## 1. 两 PR 切分（安全优先）

删除编排**不可逆**（硬删 PII），且依赖加密列 + 判定日志就位，故独立成 PR 单独聚焦审查 + 单独 DSR 演练。

- **PR-A 存储合规地基**（`feat/compliance-storage-foundation`）：schema（jurisdiction_policy / policy_decision_log / lia_record / article14_notice / dataClass 列）+ `DataRightsService.evaluate()` 7 动作引擎 + jurisdiction_policy seed(含 PIPL) + policy_decision_log 接线 + subsume `evaluateEmailGate` + PII 列级加密（contact_point.value / canonical_contact.full_name / field_evidence.value）+ dataClass 落列 + DB 角色拆分（append-only 审计表）。→ 满足验收③ + 判定/LIA/Art.14/jurisdiction。
- **PR-B 删除编排**（`feat/compliance-deletion-orchestration`）：deletion_request/receipt + deletionWorkflow 五步 + `POST /deletion-requests` + Art.17 擦除链 + 删除先于发送时序门。→ 满足验收① + ②。

## 2. 7 动作词表（DataAction）

从现有 3（隐含 store/probe/retain）扩到 7，覆盖责任三栏。AI_PROCESS 是「每天在做却无判定点」的动作，优先补。

| 动作 | 语义 | 责任门 | 本仓执行点 |
|---|---|---|---|
| `STORE` | 落库个人数据（摄取/富集写） | 存储侧 A（C） | ✅ 写路径 |
| `AI_PROCESS` | 把个人数据送 LLM/模型 | 存储侧 A（C） | ✅ 网关/抽取前 |
| `DERIVE` | 由个人数据算派生（评分/embedding/邮箱排列） | 存储侧 A（C） | ✅ 派生前 |
| `RETAIN` | 超保留阈值继续留存 | 存储侧 A（C） | ✅ 保留期 sweep |
| `EXPORT` | 交付/纳入 LeadQualified 快照/导出 | 平台侧 | 本仓产判定，快照侧消费 |
| `OUTREACH` | 联系本人（发送） | 发送侧 B（SaaS） | 本仓产判定，SaaS 执行 |
| `VIEW` | 展示/读取个人数据 | 平台侧 RBAC | 本仓产判定，B 层 Guard 执行 |

## 3. dataClass 分级（三色）

`green`（公司事实/GLEIF CC0，可商用，无限制）｜`amber`（职能邮箱 info@/sales@，ePrivacy，非个人数据 Recital 14）｜`red`（具名人名/人名邮箱/直线/联系人，GDPR Art.4 个人数据，默认隔离）。

- 落列：`field_evidence.dataClass`（替代散落在 `value` JSON 里的 `personal_data:true` 代码纪律，可查询/可索引）。分级函数复用 `acquisition/clean.ts` 白名单（role/personal），provider 具名人恒 `red`。
- 快照 `personal_data_class` 由本列聚合。

## 4. DataRightsService.evaluate()（确定性纯函数，LLM 绝不参与）

```ts
type DataAction = 'STORE'|'AI_PROCESS'|'DERIVE'|'RETAIN'|'EXPORT'|'OUTREACH'|'VIEW';
type DataClass  = 'green'|'amber'|'red';
type Jurisdiction = 'EU'|'UK'|'US'|'CN'|'OTHER';        // 数据主体法域（由 subjectCountry 归一）
type PolicyEffect = 'ALLOW'|'ALLOW_WITH_BASIS'|'REQUIRE_APPROVAL'|'DENY';

interface DataRightsContext {
  action: DataAction;
  dataClass: DataClass;
  subjectJurisdiction: Jurisdiction;      // 数据主体所在
  processorJurisdiction: Jurisdiction;    // 处理地（租户部署法域）
  lawfulBasis?: LawfulBasis;              // 现有 LIA/consent/contract 存在性
  suppressed?: boolean;                   // 禁联命中（对外动作第一道检查）
  hasEvidence?: boolean;                  // 证据先行红线
}
interface DataRightsDecision {
  effect: PolicyEffect;                   // 归一到 allow/deny/require_approval（ALLOW_WITH_BASIS 视 basis 存在性坍缩）
  allowed: boolean;
  reason: string;                         // 机器可读
  ruleId: string; ruleVersion: string;    // 命中的 jurisdiction_policy 行 + 版本
  requiresLawfulBasis: boolean;
  article14NoticeRequired: boolean;       // Art.14 主动告知义务判定
}
```

**判定算法（纯、确定性、fail-closed）**：
1. `suppressed` → `DENY:suppressed`（永远最先，先于一切）。
2. `dataClass='green'` → `ALLOW`（公司事实无限制）。
3. 查 `jurisdiction_policy`：按 (subjectJurisdiction, processorJurisdiction, dataClass, action) **最具体优先**匹配（精确 > `*` 通配；四维特异度打分）。
4. 命中行 effect：
   - `ALLOW` → allowed。
   - `ALLOW_WITH_BASIS` → `isValidLawfulBasis(lawfulBasis)` ? allowed : `DENY:no_lawful_basis`。
   - `REQUIRE_APPROVAL` → allowed=false, effect 透传（PIPL 跨境等，人审）。
   - `DENY` → 拒。
5. **无匹配行 → fail-closed**：`red` → `DENY:unregistered_red`；`amber`/其他 → 保守 `DENY:unregistered`（种子须覆盖常规组合，未覆盖=拒）。
6. **证据先行红线**：`hasEvidence===false` 且 `action∈{DERIVE,EXPORT}` → `DENY:no_evidence`（覆盖上面的 allow）。
7. Art.14：`red` 且 `action∈{STORE,AI_PROCESS,DERIVE,OUTREACH}` 且 subjectJurisdiction∈{EU,UK} → `article14NoticeRequired=true`（间接收集透明义务，1 个月内/首次接触时）。

**每次判定写 `policy_decision_log`**（租户 RLS，append-only）。**subsume**：`evaluateEmailGate` 的人名邮箱分支改为委托本引擎（AI_PROCESS on red），保留其现有 `EmailGateDecision` 接口（零破坏 caller），共用 `isValidLawfulBasis`。

## 5. jurisdiction_policy（平台种子表，含 PIPL）

无 RLS 平台参考表（同 source_policy/data_provider：GRANT SELECT，owner 写，随 API 启动 seed）。行=`(subjectJurisdiction, processorJurisdiction, dataClass, action) → effect + requiresLawfulBasis + article14Required + retentionDays? + note + ruleVersion`。

种子基线（`red` 为主，green/amber 少量兜底）：
- **green**：`(*,*,green,*) ALLOW`。
- **amber**：`(*,*,amber,{STORE,AI_PROCESS,DERIVE,RETAIN,EXPORT,VIEW}) ALLOW`；`(*,*,amber,OUTREACH) ALLOW`（职能邮箱 ePrivacy 可发）。
- **red / EU 主体**：STORE `ALLOW`(art14)、AI_PROCESS/DERIVE/EXPORT `ALLOW_WITH_BASIS`(art14)、RETAIN `ALLOW`(retentionDays 上限)、OUTREACH `ALLOW_WITH_BASIS`(art14)、VIEW `ALLOW`。UK 同构。
- **red / US 主体**：较宽（CCPA/CPRA，B2B 豁免 2023 日落后仍宽于 EU）：STORE/AI_PROCESS/DERIVE/EXPORT/VIEW `ALLOW`、OUTREACH `ALLOW_WITH_BASIS`、art14 false。
- **PIPL 法域对（跨境）**：`(EU, CN, red, {AI_PROCESS,DERIVE,EXPORT,OUTREACH}) REQUIRE_APPROVAL`（欧盟自然人数据→中国处理地=双向跨境，人审）；`(CN, *, red, OUTREACH) REQUIRE_APPROVAL`。
- **OTHER 主体 red**：保守 `ALLOW_WITH_BASIS`/OUTREACH `REQUIRE_APPROVAL`。

## 6. 合规表（schema）

| 表 | 层级/RLS | 语义 | 写权限 |
|---|---|---|---|
| `jurisdiction_policy` | 平台无 RLS | 规则数据行（种子） | GRANT SELECT，owner 写 |
| `policy_decision_log` | 租户 RLS | 每次 evaluate 判定留痕（AiTrace 形） | **append-only**（REVOKE UPDATE,DELETE） |
| `lia_record` | 租户 RLS | 一等 LIA（balancing test 字段 + 版本 + 主体范围） | **append-only** |
| `article14_notice` | 租户 RLS | Art.14 告知义务记录（obligation + 履行状态） | **append-only** |
| `deletion_request` | 租户 RLS | DSR 状态机（PR-B） | 全 CRUD（状态转移需 UPDATE） |
| `deletion_receipt` | 租户 RLS | 删除完成证明（PR-B） | **append-only** |

## 7. PII 列级加密 + DB 角色拆分

**加密（greenfield，app 层 AES-256-GCM）**：无既有加密约定，选 app 层 `node:crypto`（零新依赖，key 应用持有、绝不过 DB，强于 pgcrypto）。密文格式 `enc:v1:<base64(iv|tag|ciphertext)>`，**版本前缀**使旧明文行零破坏共存（读检测前缀：有则解密，无则原样返回=legacy）。key 自 `PII_ENCRYPTION_KEY`（32 字节 hex/base64），缺失时 **PII 写入 fail-closed**（绝不明文落）。
- 加密列：`contact_point.value`（email/phone/URL）、`canonical_contact.full_name`（人名）、`field_evidence.value` 内 PII 拷贝（person.profile/email.guess blob——**第二份明文不加密则控制失效**）。
- 不加密：`canonical_contact.dedupe_key`（派生查找键，非可读 PII）、`source_signal.subject_name`（平台绿库法人名，靠 `isLikelyIndividualApplicant` 守零 PII）。
- 加解密封装 `PiiCryptoService`（encrypt/decrypt/isEncrypted 纯壳 + env key），写路径加密、读路径解密，DRY 单点。旧明文行经 `scripts/backfill-pii-encryption.mts` 回填（有界、幂等、可选）。

**DB 角色拆分（本收口的具体交付=DB 层最小权限）**：
- 语义映射：`global`（owner，跑 migration/owns tables/绕 RLS）= `migration_owner`；`app_user`（RLS runtime）= `tenant_app`。
- **append-only DB 强制**：审计/证明表（policy_decision_log/lia_record/article14_notice/deletion_receipt）migration 内 `REVOKE UPDATE, DELETE ... FROM app_user`——即便应用角色也不能篡改/删审计（DB 层保证，非代码纪律）。
- **诚实交底（演进）**：`platform_worker`/`platform_reader` 独立连接串插拆（sweep 用 worker、读模型用 reader）**归 R1**（触发时机=B 写路径进场或第二领域模块，见 architecture §3:48）。PII 机密性当下由**加密边界**（app_user 在 DB 只见密文，唯持 key 的应用可解）真实保证，非靠列级 REVOKE（与 app 层加密不兼容）。此为 KISS 取舍，PR 正文标注。

## 8. 删除编排（PR-B，Art.17）

`deletionWorkflow` 五步（Temporal，file-triple + 4 wiring anchors，模板 external-intent）：
1. **冻结**：先写 `SuppressionRecord`（对外动作第一道闸，删除期间禁联）。
2. **定位**：按 `personal_data` 证据 + 命名空间跨 `canonical_contact`/`contact_point`/`field_evidence`(person.profile/email)/`source_signal`(revokeBySubjectKey) 定位主体全部 PII。
3. **擦除**：硬删/匿名化（指纹哈希天然免删；`revokePatch` 脱敏模式复用；密文列直接删行）。
4. **重评分**：触发受影响 Lead 重算（联系人没了→Reachability 变化）。
5. **回执**：写 `deletion_receipt`（完成证明，append-only）+ 发 `DeletionCompleted` 事件（复用 outbox）。

`deletion_request` 状态机：`RECEIVED→FROZEN→ERASING→COMPLETED|FAILED`。`POST /deletion-requests` 端点受理（统一信封）。**硬前置**：本编排建成 = 满足「删除编排先于任何发送上线」时序门。

## 9. 不可回退红线（继承 ADR-010，永久生效）

🔴 具名个人数据默认隔离（无 LIA 不解锁 OUTREACH）｜LLM 绝不做权利判定｜source_policy fail-closed｜证据先行（无 evidence 不评分不导出）｜内容最小化（个人数据不写 Trace/日志/Prompt——policy_decision_log 只存 subjectId 引用 + dataClass，**绝不嵌人名/邮箱明文**）｜embedding 只对公司事实｜个人数据必有保留期清理｜RLS 不回退｜Suppression 一切对外动作第一道检查｜技术能抓≠合规能用。

## 10. 测试与验收

- TDD：DataRightsService（7 动作 × 三色 × 跨法域 × basis 存在性，含 PIPL 跨境 REQUIRE_APPROVAL）、PiiCryptoService（往返/legacy 明文/缺 key fail-closed/篡改检测）、evaluateEmailGate subsume 回归、dataClass 落列、article14 判定。
- 真库实测（无 sandbox，superuser guard）：`verify-data-rights.mts`——7 动作跨法域判定 + policy_decision_log 落行 + PII 加密往返（密文落库、明文绝不落列）+ jurisdiction_policy PIPL 行 seed。PR-B：`verify-deletion-orchestration.mts` DSR 全链演练。
- 对抗复审（Workflow 3 维 pipeline 逐条核验），每 PR 一轮。
