# 通用操作产物的对象存储：寻址、复用、保留期与擦除

> 生命周期：`GUIDE`
> 生命周期依据：2026-10-14 产物对象 TTL 不随复用刷新的修复；设计权威仍是 [Execution Budget Authority 与大型结果耐久重放设计](../architecture/execution-budget-authority-artifact-replay-design.md)，本页只记录 as-built 的存储行为与运维边界

受管工具的大结果（页面抓取、渲染、HTTP 响应、制裁名单下载）不进数据库，而是作为**产物对象**写进专用 S3 桶（本机是 MinIO，桶 `GENERIC_OPERATION_ARTIFACT_S3_BUCKET`），数据库只存小清单（`generic_operation_artifact`）和闭合引用。本页说明对象怎样寻址、复用时发生什么、两套保留期如何对齐、擦除怎样找到每一个版本，以及哪些失败会留下什么痕迹。代码在 `apps/api/src/durable-results/artifact/`。

## 1. 寻址与复用

- 最终 key 只由内容摘要和隐私类派生：`generic-operation-results/v1/final/<privacy-class>/sha256/<前两位>/<sha256>`（`artifact-key.ts`）。同样的字节在同一隐私类下只有一个对象，任何清单都不能自选 key。
- 写入走 staging（按产物 UUID）→ 校验字节 → `PutObject … IfNoneMatch: *` 到最终 key（`generic-operation-artifact.store.ts` 的 `promote`）。对象带五项固定元数据、一个 `artifact-privacy` 标签和 SSE-S3，缺一项都视为合同破坏（`generic-operation-artifact.object-contract.ts`）。
- 最终 key 已存在时走**复用分支**：清单元数据必须全等（`sameArtifact`），再把现有对象的字节流式读回校验一遍，然后才把它当作这次操作的结果。复用判定收紧到「字节 + 大小 + 隐私类、schema/mediaType 由各自清单记录」由另一条分支（`claude/artifact-dedupe-bytes`）处理，本页不覆盖。

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
| < `retainUntil`，或没有公布（没有规则命中、头不可读） | **把对象复制到自身**：`CopyObject`，`MetadataDirective: REPLACE`（同一套元数据）、`TaggingDirective: REPLACE`（同一个标签）、`ContentType`、`ServerSideEncryption: AES256`。S3 与 MinIO 把它记成一个**新的当前版本**，LastModified 为现在，生命周期从现在重新起算；旧版本变为 noncurrent，由 `NoncurrentVersionExpiration` 规则在 1/7/30 天后清掉 |

复制之后再 HEAD 一次核对合同，返回的 `versionId` 是复制响应里的那个版本（而不是重新 HEAD 看到的当前版本），这样即使两次复用并发、各自复制了一次，每个结算记录的都是自己创建的版本。

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
- `enqueue_workspace_personal_artifact_cleanup_v1` 同签名重建：对象无其它在册主体引用时，为账本 ∪ 钉子里的**每个版本**各建一条精确版本的清理命令（命令表的唯一键本来就是「请求 × 摘要 × 版本」）。`claim` 每次都会重跑 enqueue，所以首次入队后新出现的版本也会在下一次 claim 时得到命令；清理工作流每次活动处理一条命令，直到没有待处理命令为止。擦除端口（`personal-artifact-cleanup.store.ts`）与其权限不变。
- 边界：复制成功但本次结算没有落库（进程在两者之间死掉）会留下一个账本不知道的版本。它会作为当前版本按年龄过期（≤ 2 个生命周期日），`ExpiredObjectAllVersions` 同时清掉所有版本；擦除链覆盖不到它，这是已知的有界缺口。

## 4. 错误码与痕迹

| 码 | 哪里 | 含义与调用方处理 |
| --- | --- | --- |
| `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`（`GenericOperationArtifactError`） | `GenericOperationArtifactService.readVerified`：清单行在有效期内，`inspect` 却找不到对象 | 已结算的结果不可再现；与篡改（`…_INVALID`）区分开。重放路径（`GenericOperationArtifactExecution.replay`）记一行 `[artifact] <schema> replay failed for operation <id>: GenericOperationArtifactError:GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING` 后原样抛出；ToolBroker 把它转成 `BudgetOperationReplayError`，发现 run 按「无法重放的操作」跳过该公司/查询并计数，**不发起第二次物理调用** |
| `GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING`（`ArtifactStorageError`） | `store.read` 遇到 NotFound | 同上；以前混在 `…_INVALID` 里 |
| `GENERIC_OPERATION_ARTIFACT_RETENTION_REFRESH_FAILED`（告警） | `store.promote` 复用分支复制失败 | 操作继续；清单可能比对象活得久 |

`[artifact] … persist failed …` 的行格式不变；两种行都只带 schema、操作 id 和有界码，不带摘要或 key。

## 5. 部署与回退

- 迁移随携带它的镜像部署（见 `docs/backend/compose-project-migration.md` 与 RUNBOOK「换后端运行时镜像」）；旧镜像在迁移应用后因 `MIGRATION_REVISION_MISMATCH` 拒绝启动。回退 = 恢复迁移前的数据库备份 + 旧镜像。
- 桶生命周期、IAM 策略、readiness 期望的规则集都**没有变**；换镜像不需要重跑 `minio-bootstrap`。
- 已经钉在已删除版本上的 126 个对象行不需要修：下一次同样字节的写入会走全新 `PutObject`，v4 把钉子移到新版本并记入账本。

## 6. 没有采用的方案

按库里每个对象所有行的最晚 `expires_at` 清理、放弃桶生命周期的按年龄过期（任务里的方案 B）更贴近设计文档「对象回收必须等所有引用过期」的原意，但需要新的跨工作区特权清扫任务与调度决定、改桶生命周期并与 readiness 期望同步切换，部署耦合大；当前用量（只有 PERSONAL_DATA 的 1 天工具）下，复用时按需刷新一次（每个对象每天至多一次复制）就能让对象活过最晚的清单行。如果日后出现长 TTL 类或刷新带来的版本数成为负担，再评估方案 B。
