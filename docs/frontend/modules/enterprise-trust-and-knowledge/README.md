# 企业、产品与信任 Capability Pack

> 文档 ID：`FE-P6-TRUTH-000`
> 层级：`L2 / Map-complete capability pack`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_6_REVIEW`
> Capability：`CAP-TRUTH-001`、`CAP-KNOW-001`、`CAP-SITE-PROFILE-001`、`CAP-SITE-ASSET-001`、`CAP-SITE-KB-001`、`CAP-SITE-CLAIM-001`
> 事实 Owner：`OWN-PRODUCT`；对象 Owner：`OWN-TRUTH-BE` / `OWN-SITE-BE`

## 1. Capability

Workspace 团队维护一套可追溯、可审核、可撤销、可复用的企业资料、Offering、知识、素材、Claim 和 Evidence，让 Site、未来 Content/Campaign 与销售材料消费同一事实底座，而不是各模块复制一份企业真相。

## 2. 用户结果与边界

用户从 `PAGE-FE-020..026` 完成五类结果：看清资料完整度；维护产品/服务；理解来源和证据；处理事实冲突/过期/撤销；知道素材和知识正被哪里使用。

本 Pack 不把 `BrandProfile` 当 Company SoR，不把 Site `PublishableClaimSnapshot` 反写 Claim，也不把 Site KB 汇总接口冒充全平台知识库。完整公开事实审核和影响合同仍受 `BLK-FE-004` 阻塞。

## 3. 事实形成与消费旅程

```text
CompanyProfile / Offering
→ KnowledgeSource / Asset
→ extraction or manual proposal
→ Claim + Evidence
→ NEEDS_REVIEW / conflict
→ authorized review
→ approved + scope + validity
→ immutable consumer snapshot
→ Site / Content / Campaign / Sales material
→ expiry/revoke/conflict
→ impact task + rebuild/unpublish decision
```

关键不变量：来源不等于事实；事实不等于批准；批准不等于永远有效；快照不等于 SoR；素材存在不等于拥有公开使用权。

## 4. 页面工作簿

| Page | 用户第一问 | 主动作/下一步 | 必须覆盖 | 当前深度 |
|---|---|---|---|---|
| `020` 企业资料主页 | 哪些资料可用、缺什么、被哪里消费？ | 完善一组资料/进入待审事实 | 完整度、stale、冲突、引用、权限 | Company/Profile 后端局部存在；统一页未建 |
| `021` 产品/服务目录 | 我们具体卖什么、适用哪里？ | 新建/修订 Offering | 版本、市场适用范围、归档、被引用 | 对象存在；统一 CRUD/版本合同不完整 |
| `022` 企业事实审查 | 哪条说法可公开，依据是什么？ | 批准/拒绝/限范围/解决冲突 | Evidence、证书、有效期、撤销、影响 | 通用 Claim API 存在；Site/平台 allowed actions 缺 |
| `023` Evidence Drawer | 这条事实从哪里来？ | 打开来源/影响/相关 Asset | quote、hash、时间、许可、敏感字段遮罩 | 对象和内部链较深；统一展示合同未定 |
| `024` 企业知识与资料 | 哪些资料已处理、失败或过期？ | 上传/重试/补资料 | 文档级状态、部分成功、重复、删除影响 | Site KB 仅聚合状态；平台知识合同 `NONE` |
| `025` Export Readiness / Buyer Trust | 哪些可信度缺口阻止当前目标？ | 建任务/补证据/明确不适用 | 维度口径、证据、时效、不可用原因 | Word/原型输入；机器对象 `NONE` |
| `026` Asset 详情 | 原件权利、用途、引用和派生版本是什么？ | 修正权利/解除引用/删除 | source、rights、variant、引用、tombstone/cleanup | Site Asset 子集存在；通用权利登记不完整 |

## 5. 对象、SoR 和社会属性

| 对象 | SoR/Owner | 社会属性 | 规则 |
|---|---|---|---|
| `OBJ-FE-003` CompanyProfile | 本仓企业事实域 / `OWN-TRUTH-BE` | Workspace 共享事实 | 统一 identity；消费者不可复制主状态 |
| `OBJ-FE-004` Offering | 企业事实域 | Workspace 共享事实 | 需版本/市场范围；Content/Site 只引用 |
| `OBJ-FE-005` KnowledgeSource/KbDocument | 企业事实域 + Site 子集 | 共享或受限 | 两套对象尚待统一 identity，不按文件名猜 |
| `OBJ-FE-006/007` Claim/Evidence | 企业事实域 | 公开候选 + 来源/权利敏感 | Claim 生命周期与 Evidence provenance 分离 |
| `OBJ-FE-008` Asset/Variant | Site DB + 对象存储 | 权利与公开范围敏感 | 原件、派生物、引用和清理状态分离 |
| `OBJ-FE-017` snapshot/Copy/Brand | Site 派生域 | 不可变 Build 输入 | 不能反向覆盖 Company/Claim |

个人数据、商业机密、证书和公开候选必须按字段与用途分层；管理员不自动取得所有原文/个人数据读取权。

## 6. 权限、状态和恢复

- 查看来源、提出修订、审核事实、撤销事实、解除引用、删除原件是不同 allowed action。
- Claim 的 `NEEDS_REVIEW / APPROVED / REJECTED / EXPIRED / REVOKED / CONFLICT` 与素材/知识处理状态分开。
- Claim 撤销后至少阻止新消费者使用；已激活预览/未来公网输出的影响处置必须产生任务，不能只靠前端隐藏。
- Asset 删除先判断引用；被引用时返回影响与解除路径，不显示“删除成功”。对象存储清理是后置运维状态。
- 文档处理允许部分成功，保留 ready 结果；平台知识页不能把汇总 `ready` 当每份文档都成功。
- 审核合同缺时，页面只读显示证据和阻塞原因，走有批准记录的运营 SOP；自动批准禁止。

## 7. 当前机器证据

当前 OpenAPI 可证明：Company list/get/create/confirm/completeness、Offering list、Claim list/create/approve/reject/revoke、conflict list/resolve，以及 Site profile、Asset 和 KB 聚合操作存在。相关 operationId 包括 `CompanyController_*`、`ClaimController_*`、`SitesController_getProfile_v1`、`AssetsController_*`、`KbController_status_v1`。

这些合同不证明：

- Workspace/entitlement/allowed-actions 已闭环；
- 全平台 Offering/Knowledge/Asset 管理模型完整；
- 通用 Claim approve 可以安全承担 Site 影响评估；
- 正式 SaaS 页面、设计、E2E 或部署存在。

## 8. 指标、反指标、FAQ 与限制

方向指标：可公开关键字段证据覆盖率、待审事实处理时长、冲突解决率、撤销影响任务闭环率、重复资料/事实减少、消费者因缺事实阻塞的可解释率。

反指标：用“资料完整度”鼓励虚构；批准数量代替准确性；上传量代替知识可用性；删除成功但引用/对象仍存；管理员查看个人数据成为默认。

常见问题：

- Site 资料是不是另一份企业资料？不是。Site Profile 是任务视图/局部合同，企业事实归 Company/Offering/Claim/Evidence。
- Claim 已 approved 是否能永久发布？不能。还受适用范围、有效期、撤销、冲突和消费者快照影响。
- 上传完成是否等于知识 ready？不等于；PUT、commit、处理、ready 是不同状态。
- 能否先在前端加一个“批准”按钮？不能；必须有 allowed action、影响合同和审计。

## 9. Handoff

本 Pack 达到 `MAP_COMPLETE / PARTIAL_BACKEND / NOT_DEV_READY`。后续需要统一 Company/Offering/Knowledge/Asset 的平台合同，补 Site/跨域 Claim review 与 impact，指定数据/隐私/运营 Owner，再按真实纵切决定是否形成独立 Dev-Ready Pack。
