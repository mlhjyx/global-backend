# 14 · MF-0 媒体地基契约 — 施工级展开（media foundation）

> **薄版媒体合同的裁决已在别处，本文只做施工级展开。** 决策真值 = [00-decisions MF-0 裁决](00-decisions-and-coordination.md)（2026-07-15）+ [`docs/adr/registry.md` ADR-018](../adr/registry.md)（MF-0 媒体地基·薄版）；契约周边真值 = [02-architecture §8](02-architecture.md)（素材与版权基线）+ [04-sitespec-contract §4](04-sitespec-contract.md)（资产引用约定）+ DQ-1 `@global/contracts`（SiteSpec 1.0.0）。本文**非权威**、不自封"单一入口"；它把 ADR-018 的两句薄合同展开成可施工的表结构、扫描器、处理矩阵与分期触发条件，并把 v3.2 §20–§21 里关于图片/视频/音频的实质设计**回写归档**，好让 v3.2 归档时零内容损失。
>
> **严格分层（勿混淆 as-built 与 target）**：
> - **当前 as-built（MF0-A + MF0-B，2026-07-17）**：`AssetVariant` 数据地基、Profile + 当前 `activeVersionId` 引用守卫、共享 Asset 行锁、`409 ASSET_IN_USE`、严格 canonical/Variant Temporal 回收与历史 parked 对账已落；`MediaJob`/`AssetUsage`/`SiteRelease`、Sharp writer 仍不存在。
> - **M1-c as-built**（本文 §4，2026-07-17 当前交付分支）：MF0-B 之上已落纯 Sharp 确定性图片管线并写 `AssetVariant`；是否进入 `main` 以 PR/CI/合并证据为准。
> - **MF-1 目标**（本文 §6，事件触发补建，YAGNI）：`MediaJob`/`AssetUsage`——**接生成式/异步媒体或跨 Release 持久反查的第一个真实消费者前**才落，不提前建。
> - **M3 目标**（本文 §7–§8，远期，全为 target）：视频与音频（VideoBrief/Shot/Seedance/旁白/播放/ReleaseManifest 媒体组合）。

---

## 0. 定位与边界

- **MF-0 = 图片资产的最小可发布地基**：把"图片不是一次性 build 临时文件"这条承重事实固化成 schema——M1-e 要固定具体 Variant、删除要查引用、Release 要快照、M3 视频要复用 job/provenance/cost。若现在把 `derivedKeys` JSON 当权威，后面接 Variant/Release/视频时必然二次迁移。故 ADR-018 把媒体地基与图片算法**拆成两个独立可评审 PR**：
  1. **MF-0-thin**：`AssetVariant` + RLS/FORCE RLS + 幂等 recipe + 删除守卫扫描器 + derivedKeys 兼容投影——**阻断 M1-c 合并**。
  2. **M1-c Deterministic Image**：纯 Sharp 算法/recipe/格式/QA，不接任何图片模型（依赖 MF-0-thin 先落）。
- **不在 MF-0/M1-c**：生成式图片（M1-c2/M2 独立 feature flag）、rembg 抠图容器（D-M1c-1，唯一消费者=生成式重绘已延后）、`MediaJob`/`AssetUsage`（MF-1）、视频/音频/字幕（M3）、Readdy 与设计 Agent。
- **对标先例**：本文体例镜像 [09 施工图](09-m1-implementation-design.md) 与 `docs/implementation-records/ted-provider-spec.md`（as-built 触点 + 合规 + 决策 + 分期 + 合并门）。

## 1. 分期与触发条件（additive、按消费者分流）

数据库分期**只做 additive migration**，绝不把整张未来 schema 绑进一个 PR（v3.2 §25 迁移分期）：

| 阶段 | 新增 | 触发条件（何时才落） | 合并门 |
|---|---|---|---|
| **MF0-A ✅** | `AssetVariant` + RLS/FORCE RLS + recipe/checksum/provenance + derivedKeys 纯兼容投影 | 2026-07-17 | 真 PostgreSQL A/B RLS、复合 FK/CHECK、并发 recipe、空库迁移与 schema diff |
| **MF0-B ✅** | `SiteSpecAssetReferenceScanner` + Profile 引用面 + 删除 409 + 并发写侧门 + canonical/Variant 严格异步回收 | 2026-07-17 | §3 + 真 PostgreSQL 并发、MinIO/Temporal/replay/历史 parked 对账 |
| **M1-c** | 无新表；纯 Sharp 处理 + 写 `AssetVariant` | MF0-A/B 全部合并后 | §4 处理矩阵 + v3.2 §20.7 合并门 |
| **MF-1** | `MediaJob` / `AssetUsage` | **第一个**生成式/异步 MediaJob 消费者，**或**第一个需跨 Release 持久反查 AssetUsage 的消费者出现前 | Job↔Variant 事务边界 + 补偿/对账 + rights |
| **M3** | 视频/音频/字幕 Variant 种类 + 视频 provider adapter | 视频真实消费者；**MF-1 必须先于任何视频 provider adapter 合并** | §7 全部门 + 主体/时序/成本门 |

> 🔴 **YAGNI 红线（ADR-018）**：不能为了"以后可能用"提前让当前图片 PR 承担三张表与跨域状态机。`MediaJob`/`AssetUsage` 的目标形状本文 §6 已定，但**属于 MF-1，不是 M1-c 合并门**。

## 2. AssetVariant 表结构（MF0-A as-built · v3.2 §20.2 回写）

`AssetVariant` = **可发布派生**（区别于 `Asset` = 逻辑素材/原件）。M1-c 里它承载 Sharp 确定性输出的每一档尺寸/格式。

- **身份与来源**：`workspaceId`、`siteId`、`assetId`、`variantType`、`mime`、`width`/`height`/`durationMs`/`bitrateKbps`、`sizeBytes`。
- **物化与幂等**：`objectKey`（MinIO 对象键）、`contentHash`、`pipelineVersion`、`recipeHash`、`sourceVariantId`（派生链，如从某 variant 再转码）。
- **状态**：`status`/`error`/`metadata`。
- **幂等约束**：`unique(assetId, recipeHash)`——**同一 recipe 不产生重复 Variant**（同图重跑幂等）。
- **单输出 recipe 语义**：pipeline/source content/source Variant/role/format/尺寸/crop/focal/quality 全部进入规范 hash；一组响应式输出不能共用一个 recipeHash。
- **provenance 硬门**：父 Asset 与 source Variant 均用复合 FK 锁住相同 workspace/site/asset；带 `sourceVariantId` 的行只能引用已有、已校验 checksum 的 ready 来源，processing/failed 来源不能授权派生；canonical key、hash、正尺寸、状态 payload 由 DB CHECK/trigger 守卫。
- **多租户**：RLS + FORCE RLS + 显式 `app_user` CRUD；Ubuntu 开发库已验证 A 可 CRUD、B/unset-context 零可见、跨租户/站点/Asset 派生链拒绝与并发同 recipe 恰一胜。该证据不代表生产部署。
- **对象与来源账本**：Variant 只允许写入 `ws/{workspace}/{site}/variants/{assetId}/{recipeHash}.{ext}`，且 MIME 精确绑定规范扩展名（AVIF→`.avif`、WebP→`.webp`、JPEG→`.jpg`、PNG→`.png`），不得与 original/staging 共用 key；行 `id/createdAt`、来源链与 recipe/object identity 插入后不可改写，带后代的来源行须按叶到根显式清理，不能靠级联静默抹掉账本。升级会在锁内以 `row_security=off` 扫描历史坏来源链与非规范 key：有全表权限则真实扫描，权限不足则迁移直接失败；发现坏行即带 remediation hint 中止，绝不静默承认。
- **ready 不变量**：`image/*` 的 ready 行必须同时有正 `width/height`、checksum 与 `sizeBytes`；ready 后物化身份和载荷不可回退或换写，业务 metadata 仍可独立更新。

写路径（M1-c）：**同一事务**写 `AssetVariant`，再物化兼容 manifest（§5）；**不为**确定性同步 Sharp 处理强制创建 `MediaJob`（那是 MF-1 异步任务的边界）。读路径：新代码优先读 Variant，旧代码可读 manifest。

> `Asset`（原件，已存在，M1-c 扩展）目标字段：origin、kind/mediaClass、parentAssetId、contentHash、尺寸/时长、person/text/logo/cert flags、moderation、rights/license evidence、AI 标记、provenance、deletedAt。🔴 **原件永不覆盖**（v3.2 §20.7）。

## 3. 删除守卫：SiteSpecAssetReferenceScanner → 409（v3.2 §20.2 回写）

MF-0-thin 阶段的删除保护是一个**确定性扫描器**，不是 `AssetUsage` 表（那是 MF-1）：

- **输入**：待删 `assetId`。
- **当前扫描面**：Profile 三个正式引用面（`brand.logoAssetId`、认证 `certificateAssetIds`、客户案例 `assetIds`）+ `Site.activeVersionId` 指向的**唯一当前 SiteVersion**。当前 schema 没有 preview/published 双指针；历史版本不阻止删除，但未来重新激活时必须在切指针事务内重新验证。
- **SiteSpec 1.0.0**：manifest 的 UUID、kind、hash 必须与同站 ready/checksummed Asset 对账；开放 `root.props`/`content[].props` 采用有界递归，并按媒体字段语义识别 `assetId`/`*AssetId`/`*AssetIds` 与 `videoRef` 引用，明确排除组件 `id`、`offeringRef` 等业务 UUID。任何语义媒体引用未进 manifest、畸形 envelope/page/puck/block、重复大小写 UUID、未知版本、超深/超量均 fail-closed。
- **命中即拒**：返回 **HTTP 409 `ASSET_IN_USE`** + `details.usages[]`；每项稳定含 `source/page/component/fieldPath`，SiteSpec 项另带 `siteVersionId`。替换流程 = **先改 Profile/Spec 再删**。
- **并发不变量**：Profile PATCH、activeVersion 指针切换、Variant INSERT/UPDATE 与 DELETE 使用同一 Asset 行锁纪律；Variant 另有 DB trigger backstop。任一顺序都不能让引用写与 tombstone 同时成功。
- **接口不变式**：MF-1 上线后由**同一接口**切换到 `AssetUsage` 查询实现，**调用方无感**（先扫描器、后反查表，API 契约稳定）。

> DELETE 事务只写 tombstone、不可变 schema v2 cleanup plan 与 Outbox，不做 MinIO IO。Temporal 两轮按 Variant 叶→根、canonical 最后执行 Delete+HEAD，随后在重新核对 Outbox/Asset/冻结计划后删 Variant 行并 durable settle。canonical key 在旧 cleanup settle 前禁止复用；settle 后旧事件完整重放为 no-op。历史 v1 parked 事件默认 dry-run，eligible 才生成带 `causationId` 的 v2 successor，不篡改旧事件。

> commit 的 canonical copy 位于同 content-key advisory transaction 内；当前 Asset 行同时 `FOR UPDATE`，避免 DELETE 穿过 copy/finalize 窗口。若 copy 成功而后续数据库 finalize/commit 失败，会在同 key 锁下确认无 owner 后 Delete+HEAD 补偿；补偿失败则在 retryable Asset 上持久标记并阻止 DELETE，直到重试 commit 收口。

> **迁移 rollout**：050000 先 additive 建 cleanup ownership 与 trigger；051000 将迁移前未绑定 tombstone 标为 `cleanupLegacyUnbound`、禁止新写伪造该标记，并把 lifecycle CHECK 收为 validated。operator 对账会清除 eligible 的标记；referenced/busy/inconsistent 保持隔离并需人工处置。Ubuntu `global_dev` 的 46 migrations、validated constraint、schema diff=0 与真服务验证仅代表开发环境，不代表生产部署。

## 4. 图片处理矩阵：纯 Sharp 确定性算法（M1-c · v3.2 §20.4 回写）

M1-c 图片管线 = **确定性 Sharp**，零模型、零生成式（ADR-018 + D-M1c-1）。固定流水线：

**MIME/像素/解码炸弹检查 → 自动方向/sRGB → 解码重编码/去 EXIF·GPS → 模糊/曝光/噪点分析 → 安全裁切 / focal point → 320 / 640 / 960 / 1440 / 1920 响应式输出（webp + avif + fallback） → 写 Variant / recipeHash / checksum**。

按素材类型分流（生成式列为 M1-c2 以后，**非本阶段**）：

| 类型 | 确定性处理（M1-c） | 生成式策略（M1-c2 以后，默认关） | 硬门 |
|---|---|---|---|
| Logo | sRGB、透明边界、尺寸 | 禁止 | 形状/颜色不改 |
| Product | 校色、裁切、抠图可后置、多尺寸 | 仅可靠 mask 外背景 | OCR、pHash/embedding、几何、接口/孔位/标签 |
| Factory | 校色、多尺寸 | 无人物时可轻修光线/背景 | 人脸、事实场景、权利 |
| Person/Team | 裁切、调色 | 禁止换脸/换装/身体生成 | 人脸和授权 |
| Certificate/Report | 方向、无损预览 | 禁止 | OCR、hash、可审计 |
| Hero creative | 多尺寸、裁切 | 可生成非事实性场景 | 品牌、安全、版权、文字质量 |
| Video poster | 抽帧、多尺寸 | 可生成备选 | 与视频内容一致 |

- **格式**：每档尺寸输出 AVIF + WebP + fallback（渲染器统一 `<picture>` 消费，见下）。
- **焦点裁剪**：`focalPoint`（04 §4，`[x,y]∈[0,1]`）驱动 contain/cover 受控裁切，避免主体被裁掉。
- **失败隔离**：M1-c 逐图返回结构化成功/失败，坏图只令本步骤 `degraded`，取消必须穿透。当前 SiteSpec/DesignBrief 尚无可靠 required-media 声明，故“必需 Hero 无 fallback 才阻断”由 M1-e 消费者落地，M1-c 不猜测。
- 🔴 **不接 rembg**（D-M1c-1）：抠图容器唯一消费者=生成式重绘，已延后；M1-c 不加 rembg 容器、不写生成式图片调用。
- 🔴 **cert/person/logo 不进入生成式分支**；本 PR 无任何 provider 调用。

> ✅ **M1-c as-built（2026-07-17）**：`sharp@0.35.0` 为 API 直接 exact dependency，运行时 `pipelineVersion=sharp-0.35.0-vips-<version>-m1c.1`；输入硬限 20 MiB/40 MP/4 channels/单页，`failOn=warning`，输出再解码核验 MIME/尺寸/sRGB/无 EXIF/XMP/hash/bytes。质量指标只产生 `image-qa-m1c.1` warning；显式 focal 才 cover，其他路径保守保持主体比例，任何 role 都不放大。inspection 与编码均在 `cache(false)`、`concurrency(1)` 的可杀子进程内执行；worker 内全局门默认并发 1，输出/结果有硬字节上限，Ubuntu 编译产物子进程再用 `prlimit` 限虚拟地址空间与 fd。临时目录可配置并 `finally` 清理；这些是开发环境 containment，**不冒充生产容器/cgroup/独立 UID/禁网沙箱**。writer 在首个对象写前为完整 recipe set 持久预占带 token/lease 的 `processing` 行；对象先写 producer-token 隔离的 attempt key，只有当前 token 在 Asset/key fence 内才能 promote canonical，attempt key 同样进入冻结 cleanup plan。refurbish 首个 Activity 物化≤512 个排序 Asset ID 的不可变 workset，再按两张/Activity 执行；超限在 Sharp 前降级，旧 cursor history 只作 replay。
>
> writer 先核验完整 ready-set；对象/DB 全部匹配时直接复用并修正 manifest，不启动 Sharp；ready 账本对应 canonical 对象缺失/身份不符时按完整性故障 fail-closed，绝不绕过 fencing 原地补写。否则先在父 Asset 行锁与规范 recipe 集合下持久建立完整 `processing` owner，再于事务外编码并写 `ws/{workspace}/{site}/variant-attempts/{assetId}/{producerToken}/{recipeHash}.{ext}`。每个 attempt 回读 hash/content-type/bytes；随后重新锁父 Asset、校验 source identity/token、取得 canonical key advisory fence，在至多 15 秒的短事务窗口内 copy/promote 到 `ws/{workspace}/{site}/variants/{assetId}/{recipeHash}.{ext}` 并转 ready，copy 显式剥离 attempt TTL tag。失败只以 producer token 的 JSON CAS 把自己的 owner 转 `failed`；重试前以 8 路有界 Delete+HEAD 删除并压缩 ready/failed/过期 processing attempt，最后完整 ready set 与 `derivedKeys` 同事务收口。attempt key 进入 Variant metadata 与 DELETE 冻结计划，promotion 后尽力删除；settled cleanup 重放只重删冻结 attempt，不碰后来 canonical/Variant。attempt PUT 带专用 tag，bucket 一日 lifecycle 是晚恢复 producer 的最终收敛门：生产 API 默认只验证、不改全桶规则，缺失即阻止启动；只有单一 IaC/部署 owner 可显式管理。cleanup S3 调用接 Temporal cancellation 与 110 秒本地 deadline。单 Asset 最多 120 个 Variant 行；新 attempt-aware cleanup 的原件 + Variant + attempt **总对象硬上限为 128**，不能把“120 行”误写成 120×8 个可清理 attempt；历史无 attempt 字段合同继续兼容 128 Variant + canonical（129 对象）。

**渲染器同步契约（M1-e，v3.2 §20.5）**：图片组件统一输出 `<picture>`（AVIF/WebP/fallback）+ `width`/`height`（防 CLS）+ 按角色设 `loading`/`fetchpriority`/`sizes`；**不允许组件自己拼对象存储 URL**、**不允许 Renderer 自己选最新 Variant**——build 时固定 `variantId`。

## 5. derivedKeys 兼容投影（过渡角色 · v3.2 §20.3 回写）

`derivedKeys`（现存 JSON 列）在 MF-0/M1-c 里**降级为兼容投影**，不是权威数据，只保留**一个 Release 周期**给旧 API/旧 Renderer 做读优化。MF0-A 已在 `@global/contracts` 落下列共享类型，并提供由 ready `AssetVariant` 行确定性生成的纯 projector；真正同事务双写由 M1-c 首个 writer 接入，不对历史 JSON 伪造 backfill：

```ts
export interface DerivedImageManifest {
  schemaVersion: "1.0";
  pipelineVersion: string;
  sourceHash: string;
  variants: { hero?: ImageVariantSet; card?: ImageVariantSet; thumb?: ImageVariantSet; logo?: ImageVariantSet };
}
export interface ImageVariantSet {
  avif?: Array<{ key: string; width: number; height: number; bytes: number }>;
  webp?: Array<{ key: string; width: number; height: number; bytes: number }>;
  jpeg?: Array<{ key: string; width: number; height: number; bytes: number }>;
  png?: Array<{ key: string; width: number; height: number; bytes: number }>;
}
```

每个 codec 数组按宽度升序；同 codec、同宽度的重复候选由 projector 按稳定 identity 规则只选一条。fallback 是具体的 `jpeg` 或 `png`，不使用会丢失真实 MIME/扩展名的抽象 `fallback` 值。

停止双写的条件：完成 Renderer 切换 + 旧 Release 验证后停止 manifest 双写，**但不立即删列**（v3.2 §25 达迁移门后才停写旧字段）。

## 6. MediaJob / AssetUsage 后续补建（MF-1 目标 · 事件触发 · v3.2 §20.2 回写）

以下两类是**目标合同**，属 **MF-1**、**不是 M1-c 合并门**（ADR-018 YAGNI）。此处只锁形状，落地由 §1 触发条件决定：

**MediaJob**（异步处理或生成任务）：
- `buildRunId`/`siteId`/`assetId`、`operation`、`status`/`attempt`/`idempotencyKey`。
- `modelProfile`/`provider`/`model`/`promptVersion`；**确定性任务 `provider='sharp'`**。
- `input`/`output` variant ids、`parameters`、`safety`/`identity`/`OCR`、`cost`/`providerJobId`/`errorCode`。
- 触发：第一个生成式/异步媒体任务的真实消费者出现前落。进入生成式/长任务后，MF-1 才要求 Job↔Variant 的事务边界、补偿和对账。

**AssetUsage**（持久引用权威，反查受影响组件）：
- `siteVersionId`/`releaseId`、`assetId`/`variantId`、`page`/`component`/`fieldPath`/`usage`、`source`、`locked`。
- 触发：M1-e/M2 出现稳定 Release、增量重建或跨版本版权审计消费者前落。落地后，§3 删除守卫由扫描器切换到 `AssetUsage` 查询（接口不变）。

## 7. 视频与动效地基（M3 目标 · 全为 target · v3.2 §21 回写）

> **M1 不生成视频。** SiteSpec/`AssetRef` 与 04 §6 的目标 `videoRef` 应预留可演进的 `kind`，但 `MediaJob`/`AssetUsage` 等到 M3/MF-1 有真实消费者前落地。🔴 **MF-1 必须先于任何视频 provider adapter 合并**——让 M3 不必把 provider 调用、成本账和 Release 引用塞回业务 JSON。视频**不得进入 Demo v0 10 秒路径**。视频模型/TTS/转写模型一律走 **ModelProfile 四态路由（ADR-016）** 的 evaluatedCandidate/targetCandidate 位，**通道接通 + 评测门通过前不接生产流量**。

### 7.1 VideoBrief 合同（v3.2 §21.2 回写）

`VideoBrief` 必须**版本化**并**继承 `TemplateFamily.motionPolicy`**，至少包含：

- **业务与投放**：`businessGoal`、`placement`、`audience`/`market`/`locale`。
- **规格与预算**：`aspect`（16:9 / 9:16 / 1:1 / 4:5）、`duration`、`shotCount`、`maxCost`。
- **事实与品牌锚**：`approvedClaims`、`offeringRefs`、`brandRules`、`referenceAssetIds`。
- **镜头指令**：`shot type`、`camera motion`、`first/last frame`、`motion intensity`。
- 🔴 **subject locks**（防主体漂移）：Logo、标签、孔位、产品比例、颜色、人物。
- **音画与播放策略**：`voiceover`/`captions`/`music`、`autoplay`/`loop`/`reducedMotion` policy。
- **降级与风格约束**：`poster`、静态降级、Family 风格约束。

### 7.2 Shot 独立 job 单元与失败语义（v3.2 §21.2 回写）

- **每个 Shot = 独立 `MediaJob`、独立成本、独立重试单元**。
- 先生成 **5–10 秒可复用镜头**，后处理拼接成片。
- 🔴 **整片失败不要求所有镜头重做**——只重做失败 Shot（见 §7.3 步 5）。产品/工厂镜头优先 image-to-video，减少主体漂移。

### 7.3 M3 视频工作流六步（v3.2 §21.3 回写）

1. **资产权利 + 敏感内容检查**（rights/moderation 前置门）。
2. **生成 `VideoBrief` + `Storyboard` + `ShotPlan`**。
3. **Seedance 2.0 官方 Ark API**：异步提交、轮询、取消、超时回收（`video.primary` 首选 evaluatedCandidate；只有 M3 capability/主体/时序/成本门通过才写为 promotedRoute，ADR-016）。
4. **按 Shot QA**：安全、主体、品牌、时序、闪烁、文字、音画（详见 §7.4 补充；QA 由 `multimodal.review` 档按时间戳输出 finding，模型不可用时保留确定性时长/编码/闪烁基础门；关键产品/人物严重漂移直接拒绝 Shot，低风险缺陷可替换为静态图/上一版镜头；QA 须记录输入帧/时间戳/rubric/model snapshot/置信度，不只存总分）。
5. **只重做失败 Shot**；通过后转码 **H.264（可选 AV1）** + 生成 **poster / 音轨 / 字幕 Variant**。
6. **写 Usage、成本、Release 引用**；🔴 **失败自动退静态图 + 确定性动效**（不阻断整站）。

> 已知约束：方舟套餐需 Large 档才可用 Seedance；new-api 视频中转需 M3 前真探，不稳定时按 02 方案 B 由后端直连方舟异步任务（密钥集中管理、成本写入 build run）；Veo 3.1 仅 shadow/premium 候选（当前 Preview），Sora 2 不接（官方目录已标 deprecated）；C2PA/Content Credentials 可后续记录来源，非 M1 阻断项。

### 7.4 旁白事实安全（v3.2 §21.5 回写）

- 🔴 **旁白文本只消费 approved `ClaimSnapshot`**；生成后的**数字、型号、品牌词必须回听/转写比对**（与 ADR-017 禁虚构身份、ADR-010 证据先行同源）。
- 旁白型号不预先锁死：MODEL-1 评测比较仍受支持的 OpenAI TTS / Gemini TTS / 现有 provider / 人工授权旁白，**把 provider 生命周期作硬门**；🔴 **不做未经授权的声音克隆**。GPT-4o mini TTS 因官方目录出现弃用信号，仅留迁移观察位。
- 字幕/转写主选受支持的 Transcribe 档（批量低风险可回退轻量档），输出 **WebVTT/SRT Variant**；转写须与品牌词/数字比对。
- 背景音乐首版**只用授权库存、不生成音乐**，记录 license/地域/期限/用途；用户上传真人音频须记录授权/说话人/允许用途，删除/撤权能反查 Release。

### 7.5 视频站点播放与性能规则（v3.2 §21.6 回写）

- 🔴 **默认不自动播放有声视频**；自动播放必须 **muted + playsInline + 可暂停**。
- **`prefers-reduced-motion` 返回 poster**；弱网/移动端按 **Network Information** 或服务端策略选码率。
- **必有**：字幕、poster、静态降级、可访问名称、`transcript` 入口。
- **首屏 poster 优先，视频延迟加载**；🔴 **视频不得成为 LCP 资源**；**移动端可完全不加载视频**。

## 8. ReleaseManifest 媒体组合固定与回滚（M3 目标 · v3.2 §21.6 回写）

- 🔴 **`ReleaseManifest` 固定视频 / poster / caption / audio Variant** —— 一次发布锁定完整媒体组合（内容寻址、可回放，对齐 ADR-013 不可变 Release）。
- 🔴 **回滚时恢复完整媒体组合**（不是只回视频，poster/字幕/音轨一并回到该 Release 的快照），保证历史重放与回归定位。
- 所有模型 alias 在运行时解析到 snapshot；ReleaseManifest 保存 snapshot（含 §7 视频/TTS/转写档 model snapshot），保证历史重放和回归定位。

## 9. 合规与承重红线（与 ADR 同源，不复述整条决策）

- **ADR-018**：MF-0 薄版——M1-c 只落 AssetVariant + 删除守卫；MediaJob/AssetUsage 事件触发补建；纯 Sharp、不加 rembg（D-M1c-1）。
- **ADR-014**：资产走**引用**不走外链 URL 直嵌（版权链 + 稳定性）；SiteSpec 是三方唯一契约，扫描器与 1.0.0 同步。
- **ADR-013**：每次发布 = 不可变 Release，异步失败绝不删用户现有 Site（视频失败退静态图 + 确定性动效）。
- **ADR-017 / ADR-010**：旁白/文案只消费 approved Claim，禁虚构身份；person/cert/logo 不进生成式分支；AI 产物记录 provider/model/prompt/input/provenance；个人肖像/真人音频记录授权，删除/撤权可反查 Release。
- **ADR-016**：视频/TTS/转写/视觉 QA 模型绑 ModelProfile 语义档，候选只经评测晋升，**现在不接**；deepseek 一律显式 `v4-pro`/`v4-flash`（chat/reasoner 别名已死）。

## 10. 决策台账（本文引用，真值在 registry）

| 决策 | 摘要 | 出处 |
|---|---|---|
| MF-0 薄版 | M1-c 只落 AssetVariant + 删除守卫；MediaJob/AssetUsage 事件触发 | ADR-018、00-decisions（2026-07-15） |
| D-M1c-1 | M1-c 纯 Sharp，不加 rembg 容器 | ADR-018、00-decisions（2026-07-14 认可） |
| 图片/视频分期 | additive migration 按消费者分流；MF-1 先于视频 adapter | v3.2 §20/§21/§25 回写 |
| 视频候选 | Seedance 2.0 Ark 首选 evaluatedCandidate；Veo shadow；Sora 不接 | ADR-016、v3.2 §21.3 回写 |

---

> **归档说明**：本文 §2–§6 展开 ADR-018 的图片地基薄合同（M1-c near-term 目标）；§7–§8 归档 v3.2 §21 的视频/音频/播放/Release 媒体组合设计（M3 远期目标，6 条 high-loss 全落）。v3.2 系外部起草稿，归档后本目录 00-11 + 本文 + `docs/adr/registry.md` 为设计真值。
