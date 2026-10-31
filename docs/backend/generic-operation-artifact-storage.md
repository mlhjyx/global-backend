# 通用操作产物的对象存储：寻址、复用、保留期与擦除

> 生命周期：`GUIDE`
> 生命周期依据：2026-10-14 产物对象 TTL 不随复用刷新的修复，2026-10-15 擦除改为按桶列出该键全部版本；设计权威仍是 [Execution Budget Authority 与大型结果耐久重放设计](../architecture/execution-budget-authority-artifact-replay-design.md)，本页只记录 as-built 的存储行为与运维边界

受管工具的大结果（页面抓取、渲染、HTTP 响应、制裁名单下载）不进数据库，而是作为**产物对象**写进专用 S3 桶（本机是 MinIO，桶 `GENERIC_OPERATION_ARTIFACT_S3_BUCKET`），数据库只存小清单（`generic_operation_artifact`）和闭合引用。本页说明对象怎样寻址、复用时发生什么、两套保留期如何对齐、擦除怎样找到每一个版本，以及哪些失败会留下什么痕迹。代码在 `apps/api/src/durable-results/artifact/`。

## 1. 寻址与复用

- 最终 key 只由内容摘要和隐私类派生：`generic-operation-results/v1/final/<privacy-class>/sha256/<前两位>/<sha256>`（`artifact-key.ts`）。同样的字节在同一隐私类下只有一个对象，任何清单都不能自选 key。
- 写入走 staging（按产物 UUID）→ 校验字节 → `PutObject … IfNoneMatch: *` 到最终 key（`generic-operation-artifact.store.ts` 的 `promote`）。对象带五项固定元数据、一个 `artifact-privacy` 标签和 SSE-S3，缺一项都视为合同破坏（`generic-operation-artifact.object-contract.ts`）。
- 最终 key 已存在时走**复用分支**：只要求字节摘要、大小与隐私类相同（`sameArtifact`，#644），再把现有对象的字节流式读回校验一遍，然后才把它当作这次操作的结果。结果 schema 与 media type 不参与复用判定：对象自己的元数据与 `ContentType` 保留**首写者的合同**，每个清单各自记录自己的 `resultSchema`/`mediaType`，物化器只读清单。所以空的 HEAD 探测（`http-get/v1`、`text/plain`）可以复用空抓取（`crawl4ai-fetch/v1`、`text/markdown`）写下的同一个空对象。
- 复用**从不改写对象的合同**。下面第 2 节的刷新复制会写对象，但写回的元数据、`ContentType` 与标签全部取自现有对象，而不是这次清单。

## 2. 两套保留期，以及复用时的刷新

产物有两个到期时间，而且它们原本互不知道对方：

| 时钟 | 谁定 | 值 |
| --- | --- | --- |
| 清单行 `expires_at` | 调用方（`generic-operation-artifact.execution.ts`）按工具策略的 `ttlSeconds` 从**本次写入时刻**起算 | PERSONAL_DATA 工具：1 天 |
| 桶生命周期 | `infra/minio/generic-operation-artifact-lifecycle.json`，按**当前版本的年龄**（LastModified）过期 | PERSONAL_DATA 1 天、CONFIDENTIAL_TENANT 7 天、PUBLIC_ORGANIZATION 30 天 |

MinIO 的实际删除时刻是 `LastModified + (Days + 1) 天` 向下取整到 UTC 午夜（`ExpectedExpiryTime`），HEAD/GET 会在 `x-amz-expiration` 头里公布这个时刻。第一次写入后，后来的清单复用同一个对象不会改变 LastModified，所以第一个写入者的到期一到，对象就没了，而更晚的清单行还在有效期内——2026-10-14 在 xin 上，空页面摘要 `e3b0c442…` 有 23 行清单，最晚到 10-14 16:36，对象在 10-14 00:00 已被删除。

现在 `promote` 接收 `retainUntil`（= 本次清单的 `expiresAt`，由 `GenericOperationArtifactService.persist` 传入），在复用分支按下表决定：

| 当前版本公布的生命周期到期 | 动作 |
| --- | --- |
| ≥ `retainUntil` | 原样复用，不动对象 |
| < `retainUntil`，或没有公布（没有规则命中、头不可读） | **把对象复制到自身**：`CopyObject`，`MetadataDirective: REPLACE` + `ContentType` + `TaggingDirective: REPLACE` + `ServerSideEncryption: AES256`，元数据、`ContentType` 与标签都取自**现有对象**（首写者的合同），这次清单的 schema/mediaType 不写上对象。S3 与 MinIO 把它记成一个**新的当前版本**，LastModified 为现在，生命周期从现在重新起算；旧版本变为 noncurrent，由 `NoncurrentVersionExpiration` 规则在 1/7/30 天后清掉 |

复制之后再 HEAD 一次，要求新版本与现有对象的合同**全等**（字节摘要、大小、隐私类、`ContentType`、结果 schema，`sameObjectContract`），任何一项漂移都按 `GENERIC_OPERATION_ARTIFACT_INVALID` 拒绝。返回的 `versionId` 是复制响应里的那个版本（而不是重新 HEAD 看到的当前版本），这样即使两次复用并发、各自复制了一次，每个结算记录的都是自己创建的版本。`persist` 在 `promote` 之后的 inspect 只核对 key、字节与隐私类（与 `sameStoredArtifact` 一致），不要求版本号相等。

- 复制失败（传输错误、权限）**不让这次操作失败**：对象本身已经校验过，`promote` 返回现有版本，并以固定码 `GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED` 记一条告警（不含端点、key、凭据）。代价是这一行清单可能比对象多活最多一个生命周期日，重放时会按下面第 4 节的 `OBJECT_MISSING` 收口。
- 不传 `retainUntil` 的调用（只有测试和恢复路径）保持原有「纯复用」语义。
- 权限：运行时 principal 对 `final/<class>/*` 的 `s3:PutObject`（带 `s3:RequestObjectTag/artifact-privacy` 条件）同样约束 `CopyObject`。在 `infra/minio/bootstrap.sh` 的策略下实测（MinIO RELEASE.2025-09-07T16-13-09Z）：带正确标签的复制到自身成功；不带标签头（`TaggingDirective: COPY`）或标签值错误的复制被拒（403）；运行时 principal 仍不能删除或列出最终对象的版本。xin 的桶策略不需要改。

## 3. 版本账本：结算怎样记录版本，擦除怎样找到它们

一个对象从此可能有多个 S3 版本（复用刷新、生命周期删除后同样的字节被再次写入）。在此之前，schema 里有两处假设「一个对象永远只有一个版本」：

1. `settle_tool_budget_artifact_manifest_with_receipt_v3` 拒绝任何与 `generic_operation_artifact_object.object_version_id` 不同的版本。生命周期把对象删掉后，同样字节的下一次写入就会以 `GENERIC_OPERATION_ARTIFACT_INVALID` 结算失败（xin 2026-10-14：173 个对象里有 126 个钉在桶里已不存在的版本上）。
2. 个人数据擦除只删钉住的那一个版本。而**按版本号删除当前版本会让上一个版本重新成为当前版本**（MinIO 实测，GET 仍可读），刷新过的对象擦除后旧字节仍在。

迁移 `20261014050000_generic_operation_artifact_object_version_ledger` 的处理：

- `generic_operation_artifact_object.object_version_id` 的含义改为「最近一次结算校验过的版本」；新表 `generic_operation_artifact_object_version`（sha256 + 隐私类 + 版本号，append-only）记录每一个被结算记录过的版本，并从现有钉住的版本回填。
- `settle_tool_budget_artifact_manifest_with_receipt_v4` 取代 v3：预算、清单、expected facts、回执、主体绑定语义全是 v2 的；版本号改为「移动钉子 + 写入账本」（`record_generic_operation_artifact_object_version_v1`，只有 SECURITY DEFINER 内部可调）。`PostgresBudgetStore.settleArtifactManifest` 已改调 v4。
- `enqueue_workspace_personal_artifact_cleanup_v1` 同签名重建：对象无其它在册主体引用时，为账本 ∪ 钉子里的**每个版本**各建一条清理命令（命令表的唯一键本来就是「请求 × 摘要 × 版本」）。`claim` 每次都会重跑 enqueue，所以首次入队后新出现的版本也会在下一次 claim 时得到命令；清理工作流每次活动处理一条命令，直到没有待处理命令为止。

### 3.1 擦除不依赖账本完整：按桶列出该键的全部版本（2026-10-15）

账本只能记录**结算落库了的**版本，而刷新复制在结算之前就生成了新的当前版本。只要这次结算没有落库，这个版本就不在账本里。已知路径：进程在复制与结算之间死掉；结算被 `enforce_personal_artifact_cleanup_binding_fence_v1` 以 `SUBJECT_TOMBSTONED` 拒绝并整体回滚（擦除进行中另一主体以同样字节复用）；复制 ACK 丢失（按 fail-open 当作复制失败、以旧版本结算，复制其实已落地）；复制后的 HEAD 报 `STORAGE_UNAVAILABLE` 或合同漂移。#647 时的擦除只删「账本 ∪ 钉子」里的版本，这些版本会留下来，被擦除主体的字节最长约 2 天仍可读。

现在擦除端口（`personal-artifact-cleanup.store.ts` 的 `eraseFinalObject`）每执行一条命令，都对该摘要派生的 PERSONAL_DATA 最终键做 `ListObjectVersions`（前缀就是这个精确键，`MaxKeys` 1000 分页，只取 `Key` 全等的条目），删掉桶里这个键的**全部版本与删除标记**，不管哪个版本进过账本：

1. 先读每个对象版本的标签，任何一个不是唯一的 `artifact-privacy=PERSONAL_DATA` 就整键拒绝、一个都不删（`PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE`，命令重试）；读标签时版本已不在（生命周期刚清掉）按已删除处理。
2. 删除顺序：**非当前版本 → 当前版本 → 删除标记**。按版本号删当前版本会让下一个版本变成当前版本（MinIO 实测）；先删非当前版本，当前版本始终不变直到最后一个被删，任何时刻都不会有旧版本「复活」可读，中途崩溃也只留下本来就可读的东西。删除标记压在对象版本上时，先删其下的对象版本，GET 全程 404，最后才删标记。
3. 删完再列一次；并发复制又生成了版本就再扫一轮，最多 3 轮仍不为空则本次失败、交给命令的持久重试（工作流退避重放）。
   - 删一个已经不在的版本（另一条请求在扫同一个共享摘要，或生命周期刚清掉）时，MinIO 回 204 且不带 `x-amz-version-id`（真实 MinIO 实测）。这不能当作删除成功：下一个要删的可能就是当前版本，万一那个旧版本其实还在，它就会复活。所以先按版本号读回那个版本：确认不在（`NoSuchVersion`）就继续，还在或读不准就本次失败、交给重试。
   - 每次尝试最多花 60 秒（`ERASE_TIME_BUDGET_MS`），超时后不再发新请求，本次失败、交给持久重试；下一次重新列出、接着删。请求数随该键版本数增长，而清理活动只跑一次、`startToCloseTimeout` 2 分钟，这样慢存储或版本很多的键走的是记录在命令表里的 RETRY（attempt 加一、写 `last_error_code`），而不是活动超时。
   - 工作流把活动的 `START_TO_CLOSE` 超时（典型是 Worker 在擦除中途死掉或卡住）与 `PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE` 同样按退避重放处理，不再让工作流失败。outbox 只启动这个工作流一次，失败会让命令停在 CLAIMED 无人接手；claim 会重新领取 CLAIMED 的命令，擦除本身幂等。
4. 回执：结果是这条命令所记版本的状态——擦除时在桶里找到它为 `DELETED`，已不在为 `ABSENT`。同一个键的第一条命令就会清空整个键，所以后续命令通常回 `ABSENT`；两种回执都表示「该版本确认已不在桶里」。账本与命令表只作审计与回执，不再决定删什么。

权限：清理 principal（`generic-operation-artifact-personal-cleanup` 策略）新增 `s3:ListBucketVersions`，条件 `s3:prefix` 用 `ForAllValues:StringLike` 匹配**一个完整的内容寻址键**，并加 `"Null": {"s3:prefix": "false"}`：`generic-operation-results/v1/final/personal-data/sha256/??/` 后接 64 个 `?`。这个 principal 本来就能按版本读对象，若允许列一个更短的前缀（例如 `personal-data/*`），单凭它就能枚举并批量读出全部 PERSONAL_DATA 对象；限定为完整键后，它只能列出调用方已经从数据库拿到摘要的那一个键。`personal-data/`、`personal-data/sha256/`、两位分片目录、少一个字符的键前缀，以及整桶、其它隐私类前缀、staging 前缀的列出都被拒绝（真实 MinIO 实测）。必须用 `ForAllValues`：同一请求可以重复 `prefix` 查询参数，MinIO 对普通 `StringLike` 只要任一个值匹配就放行，而 ListObjectVersions 按第一个值列出，于是「一个短前缀 + 一个完整键」就能绕过（#659 第二轮复审在一次性 MinIO 上实测）；`ForAllValues` 要求每个值都匹配，`Null: false` 拒绝不带 `prefix` 的请求（`ForAllValues` 对空集合按真处理）。运行时 principal 列 `readiness/*` 的那条授权同样改用这种写法。readiness 除 `GetBucketLocation` 外，再列一个不存在的 PERSONAL_DATA 键（全零摘要）的版本；没有这个授权时 Worker 报 `PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE` 不就绪，而不是让擦除在后台无限重试。

共享对象：多个产物行指向同一摘要时，只有所有引用主体都已墓碑才会建清理命令（`SHARED_OBJECT_STILL_REFERENCED` 期间保持 HOLD）；一旦命令存在，围栏拒绝任何新主体绑定。擦除删掉对象后，其它行的重放在 `readVerified` 得到 `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`，按第 4 节当作无法重放的操作处理，不读到任何残留字节。

剩余边界（未做）：清理命令全部完成之后，另一主体再次抓到同样字节会走全新 `PutObject` 写入同一个键，而它的结算会因该摘要已有清理命令被围栏永久拒绝（这是 #647 之前就有的行为）。这个对象不属于已完成的擦除请求，也不会再被扫到，作为当前版本按年龄过期（PERSONAL_DATA 最长约 2 天）。

## 4. 错误码与痕迹

| 码 | 哪里 | 含义与调用方处理 |
| --- | --- | --- |
| `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`（`GenericOperationArtifactError`） | `GenericOperationArtifactService.readVerified`：清单行在有效期内，`inspect` 却找不到对象 | 已结算的结果不可再现；与篡改（`…_INVALID`）区分开。重放路径（`GenericOperationArtifactExecution.replay`）记一行 `[artifact] <schema> replay failed for operation <id>: GenericOperationArtifactError:GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING` 后原样抛出；ToolBroker 把它转成 `BudgetOperationReplayError`，发现 run 按「无法重放的操作」跳过该公司/查询并计数，**不发起第二次物理调用** |
| `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`（`ArtifactStorageError`） | `store.read` 遇到 NotFound | 同上；以前混在 `…_INVALID` 里 |
| `GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED`（告警） | `store.promote` 复用分支复制失败 | 操作继续；清单可能比对象活得久 |

`[artifact] … persist failed …` 的行格式不变；两种行都只带 schema、操作 id 和有界码，不带摘要或 key。

## 5. 部署与回退

- 迁移随携带它的镜像部署（见 `docs/backend/compose-project-migration.md` 与 RUNBOOK「换后端运行时镜像」）；旧镜像在迁移应用后因 `MIGRATION_REVISION_MISMATCH` 拒绝启动。回退 = 恢复迁移前的数据库备份 + 旧镜像。
- 版本账本那次（#647）：桶生命周期、IAM 策略、readiness 期望的规则集都没有变，换镜像不需要重跑 `minio-bootstrap`。
- 已经钉在已删除版本上的 126 个对象行不需要修：下一次同样字节的写入会走全新 `PutObject`，v4 把钉子移到新版本并记入账本。
- 按桶列出全部版本那次（3.1 节）：没有迁移，但**清理 principal 与运行时 principal 的 IAM 策略都变了**：清理 principal 多一条只匹配完整键的 `s3:ListBucketVersions`；运行时 principal 原有的 `readiness/*` 列出授权从普通 `StringLike` 改为 `ForAllValues:StringLike` 加 `"Null": {"s3:prefix": "false"}`（理由见 3.1 节）。顺序是先重跑 `minio-bootstrap`（幂等：策略同名覆盖，用户、桶、生命周期按原值重放；在已有部署上实测返回 `OBJECT_STORAGE_PROVISIONED`），再换到含此改动的镜像。**漏了第一步的后果不只是擦除**：清理 readiness 是 understanding Worker 的硬检查（`worker.ts` 启动时的 `waitForWorkerDependencyAdmission` 和运行中的依赖心跳都查它），新镜像的这个 Worker 会以 `PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE` 停在不就绪、不 poll，understanding 队列上的全部后台工作流都停。新策略对旧镜像同样无影响，可以提前做：旧镜像不用清理 principal 的列出授权；运行时 readiness 每次只带一个 `prefix`（`readiness/` 下的探针键，`generic-operation-artifact.readiness.ts`），收紧后的授权照样放行（#659 合并前的复审在一次性 MinIO 上实测）。回退 = 旧镜像，策略保留新版即可。不要用旧版 `bootstrap.sh` 再跑一次来撤掉列出授权：那样运行时 principal 的 `readiness/*` 授权也会退回普通 `StringLike`，重复 `prefix` 的绕过（见 3.1 节）对运行时凭据重新成立。

## 6. 没有采用的方案

按库里每个对象所有行的最晚 `expires_at` 清理、放弃桶生命周期的按年龄过期（任务里的方案 B）更贴近设计文档「对象回收必须等所有引用过期」的原意，但需要新的跨工作区特权清扫任务与调度决定、改桶生命周期并与 readiness 期望同步切换，部署耦合大；当前用量（只有 PERSONAL_DATA 的 1 天工具）下，复用时按需刷新一次（每个对象每天至多一次复制）就能让对象活过最晚的清单行。如果日后出现长 TTL 类或刷新带来的版本数成为负担，再评估方案 B。
