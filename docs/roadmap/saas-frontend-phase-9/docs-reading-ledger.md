# Phase 9 docs 全量阅读与采用总账

> 文档 ID：`AUD-FE-P9-003`
> 层级：`L3 / Complete source audit ledger`
> 状态：`DRAFT`
> 事实 Owner：`OWN-DOC-GOV`
> 快照日期：2026-07-23
> 工程基线：`origin/main@8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`
> 最新增量指纹刷新：`origin/main@e0e51075df8ee8bb14dc5141f83365c6a2a4dec1`（2026-07-23）
> 快照范围：创建本总账前 `docs/**` 下全部 Markdown/DOCX；本文件不纳入自身快照

## 1. 完整性结论

本轮对 `docs` 快照中的 **171/171** 份文档完成逐文件读取、指纹登记和权威分层：

- Markdown：166 份，共 26,873 行；
- DOCX：5 份，按 OOXML `word/document.xml` 主文档顺序提取，共 16,685 个段落节点；
- 总字节数：5,217,473；
- 目录分布：根目录 5、adr 1、architecture 1、backend 6、design 4、evidence 1、frontend 29、governance 10、implementation-records 8、platform 12、releases 1、research 7、roadmap 63、site-builder 18、status 2、templates 3。

`FULL_READ_RECONCILED` 表示正文已进入本轮语义审计并按更高层真值处理冲突；不表示每份文档仍然 current、内容全部获批或功能已经实现。DOCX 的图片、嵌入对象和版式不是机器合同；其中主文档正文只作为历史输入。

初始 171 份快照不重写。当前工作树共有 177 份 Markdown/DOCX：171 份来源快照 + 5 份快照后 successor + 本总账自身；本总账不为自身登记指纹。增量基线上发生变化的 current 文档使用 `POST_BASELINE_HASH_REFRESH` 更新指纹和处理说明，且必须在提交前通过全 176 条已登记文件指纹复核。

## 2. 权威与采用规则

| 层级 | 使用方式 |
|---|---|
| `L1_CURRENT` | 产品边界、as-built、ADR、当前状态和 Release Plan；按主题拥有 current truth |
| `L2_ACTIVE_GOVERNED` | 活规格、治理 Registry 和实施设计；必须与代码、OpenAPI、Prisma 和 L1 一致 |
| `L3_FROZEN_EVIDENCE` | 冻结阶段、实施记录和证据；只证明其版本/日期，不反写 current |
| `L3_WORKING_REFERENCE` | 工作稿、研究性路线或参考入口；可提出候选，不能单独批准对象/能力 |
| `L4_HISTORICAL_INPUT` | 旧 Word、历史研究和 superseded 方案；只发现遗漏、术语和假设 |

冲突时固定顺序：

```text
产品边界
→ as-built / current code / OpenAPI / Prisma
→ ADR
→ current status / release plan
→ 活规格与治理 Registry
→ 实施记录和冻结 Gate
→ 历史 Word / research / Mock / 截图 /竞品
```

## 3. 对本轮前端设计的直接校正

完整阅读后，本轮只保留下列可由 current 事实支撑的设计结论：

1. 资料不是固定制造业规格表。客户可通过最少填写、引导补充、文件/图片上传、网站或店铺导入进入 Profile、Asset、KB/KnowledgeSource，再由人审核候选 Claim/Evidence。
2. current Profile 只有五个通用组；行业字段只能是条件化表单元数据、KB 抽取结果或 Offering attributes。没有独立 ProductFamily/Variant/TechnicalSpecification/Certification/CapacityProfile 合同。
3. `KbStatus.gaps` 和 completeness 是派生投影，不建立 Readiness 聚合、独立准备度工作台或伪精确百分比。
4. Inbox 作为目标态私密会话面可以设计队列、会话、分派、上下文和 AI 草稿；Conversation/Opportunity SoR 仍未定位，当前不新增 RFQ Lite 或工程生命周期。
5. Site 当前能证明 Intake/Profile/Asset/KB/Build/开发 Preview 子集；公开 Publish、Domain/TLS、Hosting、Inquiry 仍是目标态或受阻能力。
6. Buyer Intelligence 继续 `FROZEN_MAP_ONLY`；完整前端设计不恢复后端施工。
7. Aitoearn、Chatwoot、BaoTa 和 new-api 都不进入一级 IA，也不取得我方业务 SoR；所有 runtime 采用仍受合同、许可、安全、隐私和退出 Gate 约束。
8. 用户确认的五张界面只作为视觉/布局基线；示例公司、CNC 内容、RFQ、评分、模型和 KPI 均不转化为产品事实。

## 4. 逐文件登记

下表的 SHA-256 锁定本轮实际读取版本。任何文件内容变化都必须重算相应行并重新检查其冲突去向。

| 路径 | 类型 | 规模 | 权威层级 | 读取状态 | SHA-256 | 采用规则 |
|---|---:|---:|---|---|---|---|
| `docs/README.md` | MD | 169 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + PHASE9_DELTA` | `fc2064447b49e01f27c9c5f49063e5e53401ff863710344c7ac2ea2d2ddde1cb` | 工作/参考；Phase 9 增补设计系统与 Canva 入口；不得覆盖 current |
| `docs/adr/registry.md` | MD | 43 行 | `L1_CURRENT` | `FULL_READ_RECONCILED` | `b367482b4d53022d46c9cc887e96aeca707f79d8ff19554365c8c31cbfe6812e` | current 真值；冲突时优先 |
| `docs/architecture/current.md` | MD | 134 行 | `L1_CURRENT` | `FULL_READ_RECONCILED` | `86af41da970c8d1b2c00283ac107c2b71e92f8942ecbad4f82397fb5caac25ff` | current 真值；冲突时优先 |
| `docs/backend/ci-merge-automation.md` | MD | 36 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `9272e87b0980bb531241c974b84cb2777800f39b0b5d5811ade7e92e02788a11` | 活规格/治理；须与机器事实一致 |
| `docs/backend/compose-project-migration.md` | MD | 55 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `16d19521dcb06654fe2bbee508d03838f773816cfc7de9a8ba7d3dae76335e2e` | 活规格/治理；须与机器事实一致 |
| `docs/backend/discovery-sources.md` | MD | 69 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `cea879e45dc179e0e590cff3aeb9430538455f25fdcc93c3f43254ba7a32ceb0` | 活规格/治理；须与机器事实一致 |
| `docs/backend/oss-registry.md` | MD | 93 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `595269020bf22aad7cca4e2b43e66a2e2cc1861abe7c73f797b368c52e55b4fc` | 活规格/治理；须与机器事实一致 |
| `docs/backend/vocab-taxonomy.md` | MD | 53 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `c7a849d81fbba0027fbc9d2631eaecb9281735c4cc3a18592a1933b2aa6dfc7a` | 活规格/治理；须与机器事实一致 |
| `docs/backend/worktree-management.md` | MD | 99 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `870186b0813458d34952c8cb3fcf77fe843663e6f6a85823e52f9925de24668d` | 活规格/治理；须与机器事实一致 |
| `docs/design/README.md` | MD | 16 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `19e7b11671dfbdde608f8fd33c6af787dc0638e5f42efcec2dbaf9fe9cf8f754` | 活规格/治理；须与机器事实一致 |
| `docs/design/content-and-microcopy-catalog.md` | MD | 96 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `d6968862ee03e8ccfd5b3f7c5cd6a876874d9a23aed2d59c945092a02fe6fe83` | 活规格/治理；须与机器事实一致 |
| `docs/design/design-asset-register.md` | MD | 90 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + PHASE1_DELTA + IA_DELTA` | `92d65ea77d945cef167927348f694c4a759a3a2bf39a2b78f2e90c5d938c37bc` | 活规格/治理；登记 Foundations、代表页、状态/移动端/原型、生成素材和待评审的 8/38 IA Manifest；须与机器事实一致 |
| `docs/design/independent-site-management-wireframes.md` | MD | 256 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `0a393bbb0264f0775cd2dc35808b42b94154cb1d7f0f9e8fd6bb0a0ef73341f9` | 活规格/治理；须与机器事实一致 |
| `docs/evidence/model-routing/model1-brand-profile-20260719-v20/README.md` | MD | 31 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `01df8693abd318527295cf238906d73c5a5e3e62aba94b1807abeb867122edfc` | 冻结证据；只做 provenance/delta |
| `docs/frontend/00-scope-authority-and-status.md` | MD | 77 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `83b589bd37efa5d582016a906833be2eb7819eb2a245b80cf5913ca65f4f6caa` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/01-product-experience-principles.md` | MD | 61 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `5b307917fe2ffe851b7491d6ce3c7027edca9f47a5fdf336aa220b75b35f1a2d` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/02-information-architecture.md` | MD | 104 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `129366da0ab061ee11bb306acdfe1c9760c3f828cb2138252a1b47062842d127` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/03-users-roles-and-journeys.md` | MD | 104 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `bd4a1a055d7c3d710cedeb96094b43bf655adbe1b541650f61e2a7b080ce992a` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/04-page-and-capability-catalog.md` | MD | 195 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `05c1b3902abbf37d139c3eee9381f0f3291559ebd7c95a709abd70a0612f3630` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/05-navigation-and-workspace-shell.md` | MD | 90 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `51ed46ee8931ae0038f3ee6bf86b060207e9b931a258796271237b2c391164ea` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/06-permissions-and-data-visibility.md` | MD | 133 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `0c9ee053f424bc9426c0c37baf8f3cdd462439d5237fc3fd03e3011b1d1e7c9d` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/07-state-error-degradation-and-recovery.md` | MD | 126 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `e61b754a8a68df0dabef53a6c8a9e127474a3d0015c0fd2df63b41ec8a7facdf` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/08-ai-approval-evidence-and-human-control.md` | MD | 112 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `6ef8f2d3553b3440269907da06079e41fa83d813f0f6aaca9b57c3e4593a9c19` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/09-design-system-and-content-guidelines.md` | MD | 130 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `c6cbd1d0422b32d5f14bd1d7d66561b111f8a90aa8836d009b51235883a101ad` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/10-responsive-accessibility-and-performance.md` | MD | 104 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `ceac97d3792dd06ba57c9c76cb3015cca7cb422cbd4ecac100ae6c39047d4948` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/11-frontend-contracts-and-integration.md` | MD | 150 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `d66cf41665b6b28da67910dcdfca7621115dbb6fe73c6a0198cb41a4f10b3cae` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/12-analytics-testing-and-release-evidence.md` | MD | 128 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `a161bd5b7c430195fdd9f61e62d742745ff6a0c87e074ab155bb7903db9a8088` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/13-open-decisions.md` | MD | 77 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `a9abb0c869d60b6bdaf36af524f357cfeed2b911ef97ac43c9ff706a34e823b5` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/README.md` | MD | 73 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + PHASE9_DELTA` | `b22727d6e7546c8d4e22940ad9a56358e35723479cf76dee045e375457dce42d` | 活规格/治理；增补 Phase 9 设计系统阅读入口；须与机器事实一致 |
| `docs/frontend/implementation/independent-site-management-blueprint.md` | MD | 232 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `db2c60f384aa1af426c9541309f4a0927f35e0bc398adae2e3c0d02a95ecb476` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/README.md` | MD | 63 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `2107f65406540008a5b58245741c9f1616ef76131c29b29b71083b7aa3b8b6ea` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/buyer-development/README.md` | MD | 91 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `65e136b2463c6f300247b8072808a668d977440ffab06ec2ea2526ffe96791ea` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/engagement-and-opportunity/README.md` | MD | 84 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `9beaac559dd47b7a0e1eb036ddc8edf21a07ba860a661f6007b41b26d1813d81` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/enterprise-trust-and-knowledge/README.md` | MD | 98 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `39335c368bd0e0467c85a0ed94c59b81d94d9cafa094f639b8a1d1e9a88d3d88` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/growth-execution/README.md` | MD | 96 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `4e363ef5f6cb469c73088eec2d3320a5c7e46e86e825bd3d77a4e65d93a31a9a` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/independent-site-management/README.md` | MD | 99 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `a9df64f6d281e85398ca148c7c419c987cd463d7a8332b5bd2df4677e1245fc8` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/independent-site-management/journeys-and-page-spec.md` | MD | 192 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `a3eb36a4adeaae40dcf354d4a33e66791c1fd0808674b2a1d1af3f8fbfab2831` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/independent-site-management/lifecycle-permissions-and-state.md` | MD | 213 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `3d26f8f6c0503c7976eba3606b9ec76b3e8b3f4e2f8f3d2b57d58ae83f3bbc97` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/independent-site-management/operations-and-acceptance.md` | MD | 176 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `c34f46edd11dff6a6a996baf6ad35a38b9de57e7d6f70db8b1f62653c46c6930` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/independent-site-management/public-site-output-spec.md` | MD | 158 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `f088973df95176b237ec6513f0fc1cfe5f0c3090a193b0274905234cfdda379b` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/insights-and-learning/README.md` | MD | 63 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `179b8631125f2a1ced351c990d698e8f232663db124302ce75f6995aa8ea1cda` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/team-integrations-settings-and-operations/README.md` | MD | 76 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `00c47df75d7eaa5195b7bf2bf6cffe54e71c248f2ef1ae1fc51d429a3e61d1d5` | 活规格/治理；须与机器事实一致 |
| `docs/frontend/modules/workspace-shell-and-today/README.md` | MD | 98 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `3886b925fcb0c090694ae59708014b5266889f4247d34a5a2b1e0e5577c06599` | 活规格/治理；须与机器事实一致 |
| `docs/governance/README.md` | MD | 50 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `973de4b55f83d9ca79676d965254cc9f049e0e1a1d2d79ba4a99c57732b8007b` | 活规格/治理；须与机器事实一致 |
| `docs/governance/capability-register.md` | MD | 124 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `eadeaba33d1583c0a533861c02e06b18b3f439e78cb247ef5fc4b18dc6124fe3` | 活规格/治理；须与机器事实一致 |
| `docs/governance/conflict-register.md` | MD | 200 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `b14cb246880be5cdecbf01fbfe4f4cb0b48a64021034bd7cfede9f6c5fbcc41b` | 活规格/治理；须与机器事实一致 |
| `docs/governance/core-object-register.md` | MD | 200 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `8e087d2ae0fd2cfaafbaf0c925f80caf876905d9909811cae79224a7a5083ca6` | 活规格/治理；须与机器事实一致 |
| `docs/governance/docs-verification.md` | MD | 85 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `727c5016e62f1faa3a897dc31a37940f6ec9eaaaece8c2bd86ea008f85d9c117` | 活规格/治理；须与机器事实一致 |
| `docs/governance/document-register.md` | MD | 271 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + PHASE1_DELTA` | `e56611d7377f4cf4d2d2a6e19b45f999089b42c2fd808d5b7f4ebfcdc76789b5` | 活规格/治理；增补 `DESIGN-FE-P9-005..007` 与 `EVID-FE-P9-001`；须与机器事实一致 |
| `docs/governance/release-and-learning-governance.md` | MD | 110 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `167926b5636b37c3bb8cb467f55d2d3778bc75b2e7caa2dfc4a3d5e6ce2bf421` | 活规格/治理；须与机器事实一致 |
| `docs/governance/scenario-catalog.md` | MD | 158 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `4cce86974e009e5d7621af3edfba3927d8534cc7b336bbad70fe4a99912031f6` | 活规格/治理；须与机器事实一致 |
| `docs/governance/terminology-and-status.md` | MD | 240 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `26b58cc9532e8708c9c7512863ead58caa8e95360100c56dc73fe7258b3305b2` | 活规格/治理；须与机器事实一致 |
| `docs/governance/traceability-matrix.md` | MD | 144 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `c5b4cb637a7fd93b135ded8fca177c97e0fa2e33e0d3f772c3538c8d293e6df2` | 活规格/治理；须与机器事实一致 |
| `docs/implementation-records/deletion-art17-residual-window.md` | MD | 70 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `0a518bf4db2b49944613a33ef7e79b6569bc0467ed1b47d5a10673a31c0948de` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/openfda-provider-spec.md` | MD | 294 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `5c6eaf2039be05346b1e06b4e4f417e828072e87970df3bdf7e519521ee8203b` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/patent-cache-codex-p93-fixes.md` | MD | 51 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `0608a7f331951f6dec17a99e80f316f607887182fbd957645b3651f01a691769` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/site-builder-m1d-copy.md` | MD | 55 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `485dc0fb99aae4a243ca9581beb6c5144a902f6393748f8c3231b1c4e57007d4` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/storage-compliance-spec.md` | MD | 146 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `6c4525bca25614322d645954f98965115396cfad23c782b752ccd37552ab21e4` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/ted-provider-spec.md` | MD | 355 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `ce447fa7258fc597162591820a7020b8065cdfa6e140dd393629cd96e4eff626` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/temporal-workflow-testing.md` | MD | 72 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `583e0112978e97d8205c9d4ef0277e1e1f2694b1a39a1be89c953d67649490cd` | 冻结证据；只做 provenance/delta |
| `docs/implementation-records/trade-fair-intelligence.md` | MD | 112 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `3403f74125a7fcd7b4c6046e97db7e58f8d944abf8783c33c51e587fb66d0381` | 冻结证据；只做 provenance/delta |
| `docs/platform/oss-adoption/README.md` | MD | 51 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `5a08c19fe0e9829d32a6bdd91404852ff278aa1847002ed48a422a53a9dc244d` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/adoption-policy.md` | MD | 82 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `aa2f0d698ee77dcdafe817fffd33be68c3403aa33ea91ac4f5ff38f49e873ed3` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/documentation-and-quality-methods.md` | MD | 74 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `19e12d6c7220eaa58264000b60dbb105aa2adf8decc99e0e38e33b7b2da4e2de` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/documents-and-acquisition.md` | MD | 61 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `c4f6f3102a95ae424c3e0c83f96d5a618cb141f3f54900a3e0af52d9f0b9d32d` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/foundation-site-and-design.md` | MD | 117 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `8c8c931b7105467e034a48ad571506bfd5a1d032e297921a356c744127803031` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/growth-automation-and-engagement.md` | MD | 50 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `e9243e4496e87f64cc87ba9974ec369471628d552b8e4bc52b2827c4e0790d4e` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/knowledge-and-retrieval.md` | MD | 48 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `07d8e0f9602b807e1b14dac41f8b14b110ce3776c69ede4f395c76bd2eca45ce` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/media-generation.md` | MD | 48 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `0271783609ac6cf1fce6992e72a7017992101913cbcb2468a08e43e1d32d8b3a` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/official-source-snapshots.md` | MD | 101 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `a7dbd4791934ddf9558e25ad46a1cf70bb995c151b8310e02443e0f0c86a6c12` | 活规格/治理；须与机器事实一致 |
| `docs/platform/oss-adoption/workflow-policy-model-and-observability.md` | MD | 74 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `761157e08fc89ac44ca7c42f88f7c1e2243f4aad81362482909a2930f29ab0cc` | 活规格/治理；须与机器事实一致 |
| `docs/platform/全球客户开发与增长执行平台_v3.0文档体系重构与实施治理方案_v1.0.docx` | DOCX | 441 段 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `68e66a8371a7a4b7e5ee497b751fe8b91db81ea310939b17e75f6aea27394bb0` | 历史输入；只发现候选 |
| `docs/platform/全球客户开发与增长执行平台_顶层产品与系统架构设计_v1.0.docx` | DOCX | 1119 段 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `e3e267437340b266a81f9cb92202ce021c58e4ead28a1baf9f5c2c55865956f7` | 历史输入；只发现候选 |
| `docs/product-scope.md` | MD | 137 行 | `L1_CURRENT` | `FULL_READ_RECONCILED` | `df89846575810e59fb7e060435e81a61f74e8d6101b694ec9afc722c6fe40f22` | current 真值；冲突时优先 |
| `docs/releases/README.md` | MD | 18 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `ed7d891611c5c20a5ce5ef5ab35366cf5dafd547fe07a8dc12ea5aed20bed0a6` | 冻结证据；只做 provenance/delta |
| `docs/research/api-management.md` | MD | 38 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `b05c5c3002524daa0ff3d9b893e90360f4472a49a6cc270c13fd69fc0afe9597` | 历史输入；只发现候选 |
| `docs/research/buyer-intelligence-v3.md` | MD | 270 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `3d9576efec7129d7f619d1cf2601eb7f84ec26be6af6923a3e19204f7f155554` | 历史输入；只发现候选 |
| `docs/research/discovery-architecture.md` | MD | 76 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `7b563cb506e17184a17ec5da5e4ac2a3a5758cf6bf5d36eb9d96f0f9b9446d35` | 历史输入；只发现候选 |
| `docs/research/discovery-eval-round2.md` | MD | 39 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `a24be41b8a149922b41b5fbf6827fd73f050f30f457847bf608b36997d38dab3` | 历史输入；只发现候选 |
| `docs/research/discovery-eval.md` | MD | 80 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `d11467e275d0489c64ec2f0695cc56948a0ec2016ad8069998ccd20f744cd720` | 历史输入；只发现候选 |
| `docs/research/platform-top-level-design-v1.md` | MD | 289 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `44b3df444657ffbec688d80abd7c351f8ae5ca4ee9d24567365535d4d8a58939` | 历史输入；只发现候选 |
| `docs/research/positioning-and-acquisition-backlog.md` | MD | 78 行 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `6edeec472216d2dfd16f4686b24134449698cc402ebca2b6807fec9cb79a4a45` | 历史输入；只发现候选 |
| `docs/roadmap/changelog.md` | MD | 384 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `f1c8da73e0973806b1173222257ca242e500d1d7d61b87065cabf4ed676b5eae` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-cross-source-identity-design.md` | MD | 102 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `594d10b3443be9081039813a1670f28d99f1fdbe4883424fd3a2c092f46f74d6` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-multi-source-spec.md` | MD | 112 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `01226cbedee87ef867d5aaa5cbd0bdfc3708bfa70206706f548f63155a332b01` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-p0.4-mainchain-wiring-design.md` | MD | 74 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `502132b1fdfe5d20a46c994fcf1a59443556e5eeec76e5c2cb5b50f6f6233b38` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-p1-companies-house-design.md` | MD | 79 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `a4a8d77d24e2cbc26bce621c98e5296a3b4bf34ac8fc93e599be0bb451d676cb` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-p1-google-patents-inventor-design.md` | MD | 66 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `46edcc55e56dd24328f5a792bf5aebbaaeaff2c4777b69b6d3da1fbb833d782a` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-p1-inpi-rne-dirigeant-design.md` | MD | 115 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `c90cea980858f8e828675c0ceada051fbd7a786d494a1e5040cfc9cb78bfa3f0` | 工作/参考；不得覆盖 current |
| `docs/roadmap/decision-maker-p1-patent-cache-design.md` | MD | 45 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `b6aadc68ecf09b8fc0a6028862346c4b6465a7cb288238fdbaa7cbcbcaf1436e` | 工作/参考；不得覆盖 current |
| `docs/roadmap/release-plan.md` | MD | 75 行 | `L1_CURRENT` | `FULL_READ_RECONCILED` | `41b2972084ff93e3ea67cb47c3f3c347cacdb1030a478bcd5bf24703de322e62` | current 真值；冲突时优先 |
| `docs/roadmap/saas-frontend-documentation-program-plan.md` | MD | 967 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `cfe798e3b06c9952de378da91bc152e733cd78ec47834c7b65e5eafcde8ca8da` | 工作/参考；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-1/README.md` | MD | 41 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `d10fc0a76113e7e37ee22ab98ce60e5394f0687c5fccd9cb7b144c34c29319bc` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/audit-coverage-and-limitations.md` | MD | 98 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a48eaca7c172885b9902d7f6a2f740babcda497a2ea07f56def22a42b8b2a327` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/capability-status-matrix.md` | MD | 73 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `14d19f36d8cbd79417e62756a3863ca8f676bfb9abffe1a166797df475468060` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/conflict-register.md` | MD | 37 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `ca2406ca8eb55b32050db84629d6d620b0fd8d6390c8a1890817a8264574d925` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/external-benchmark-and-oss-audit.md` | MD | 147 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `e9b3fbe6fce3df3748833e05846bdb51ee097f929acea84ace96a5206882d355` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/frontend-design-source-audit.md` | MD | 82 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `e19d251de3554517d64afc6f868061f27f204fe6063a12a730685047b735bbd0` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/gate-1-review.md` | MD | 95 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a1732fa4953e16c7614bf54fd085b595cfcc5a92558445b204250b23ee94acd2` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/implementation-evidence-matrix.md` | MD | 91 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a64aac06deb7ef1217072750da85fd37f4e7bd7c78d10a8419a2562f3297c4e2` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/open-decisions-and-risks.md` | MD | 72 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `2be01fff427c4dc65a3b26e475cf5a050b0fde18fdda26cec6d9faadc5d50cd3` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/source-detail-register.md` | MD | 120 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `4a12b449958e9727badd16b1210a1f831028d434b7a7769c13c1e7c00e191523` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/source-register.md` | MD | 133 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `b4b9ef4f2987ca58cef433946bb35b30e67a2cafd1a191bd920867e3e1cabeb0` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-1/worktree-provenance.md` | MD | 56 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `1c6a4bbd636d0fdf26e027eeb8bcd3758f6cb707a744abfa695fa64e4ab6f76f` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/README.md` | MD | 74 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `517f08573a8280f3c0e8cbc1ca4eed2922a70d7b5ba5762a6992536e0c54f1ab` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/gate-2-review.md` | MD | 119 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `6b7c2754b5d20c0d5d07a14c407db7703801938f7a07bc36828ad49d115898c8` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/ia-conflict-and-decision-register.md` | MD | 132 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `8f93fa18848f0c3a0d2f90aacc01a8e37f1372b1289722d97aebe8d8a568a185` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/navigation-and-workspace-shell-options.md` | MD | 252 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `195e5909453947f0093b2e245333d1bb1647353bdb9551aba5f26fc99a9728f0` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/object-lifecycle-and-sor-register.md` | MD | 201 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `c3503068bce2bbcc178ee3d088911e3618c0a067ef53dc43ce9b44d70603cd7b` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/page-and-capability-catalog.md` | MD | 207 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `4829f1f4ed7e0b1c6018179be6f7e50a56ef7c4d7b65597bd4da3bcf612da7a1` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/product-domain-and-object-map.md` | MD | 193 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `c0513674f00829e7c6e0ab4d220960455efd8c2409752a5b72c9f52788eddd5d` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/success-metrics-and-instrumentation.md` | MD | 172 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `02d076f02d457dbf3de95f6caec276896078336f8f696119c1b705c9145750d4` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-2/user-problem-and-journey-baseline.md` | MD | 178 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `15e7024780ff809dce9a0a08b2f498beee1163576c2b6920d1e6afb4bcd66cfd` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-3/README.md` | MD | 62 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `1f46497907cde46f9b7846fbd0b67a0ac35b3ff0dcd132c9fcf1d5a8caed3362` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-3/gate-3-review.md` | MD | 114 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `d151bac6cfaac860b6ac65251cf1fa278f52dd6c8b021197e70ea012d3142dbe` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-4/README.md` | MD | 45 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `d8652aac29b4e66acd928c0aa4f94d7260d3380df40452896ce7666f729043c5` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-4/gate-4-review.md` | MD | 113 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `ea1e631a0aefba0519362e040dd9c16bcc82f85c78a860be826a16721e846b7b` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-5/README.md` | MD | 57 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `dc6d4687811da807be5cce0d356b8b5f520a19c92ed2570c2dce1ca1dd6d951f` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-5/gate-5-review.md` | MD | 106 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `2ef415cc7573421fca6540e9baefe24edb6800074cd75ae641cf336e4bb229e2` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-6/README.md` | MD | 54 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `2eccdd973a505e00b38af3ed24af08170c6f7f199aa46f024fc2a7d9c1ae8ce2` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-6/cross-domain-handoffs-and-gaps.md` | MD | 67 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a7e3866165023d07745a83e7af5a3918b5b3ea0a3141cee5309a4e95e7eaf46b` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-6/gate-6-review.md` | MD | 100 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a261238139140a0b4060c2f5b2bdec888204b8be3ebbe6b7a11de696b6e38851` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-6/portfolio-coverage-and-priority.md` | MD | 79 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `2d8c1c93ab6bb23b2b796989f092ec09d3d38da42322cc3ac8a8ed212a76ae15` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-6/source-migration-coverage.md` | MD | 63 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `101a469287256b9297200d8a176fd0a394ffea2a2575017c5f58ba6c38abf295` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-7/README.md` | MD | 48 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `2a0eed558eafc5861a6d0c2558f13e3045e80597fda2b8d2ac9c776358303dd2` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-7/gate-7-review.md` | MD | 92 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `0253b9e4f5eaa931ae8902a4e9bf591b844a644e0bdc2a9c1b3ff33fd7ea533c` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-7/portfolio-decisions-and-triggers.md` | MD | 63 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `0ccffc4f7b1794f783d74e88da6f67746719fef79ed33f46ed2ebc3460179e95` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-7/runtime-hardening-and-exit.md` | MD | 67 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `f5047653941c114557930c7e118ab8a17dfa7cb1569af85357cfcff21dd382ea` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-8/README.md` | MD | 51 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `fa9318db3f23dbbbb6282b54d2de706786e879f0bff478c97358b1f614207d02` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-8/gate-8-review.md` | MD | 90 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `e10f5830b6166cf5ae501d289129c4c8d42dee1ea6cc3e235cc6c24e7596ab2e` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-8/history-disposition-proposal.md` | MD | 70 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `416ddcd8ae0de3e1901343b58b80912bf9487150b4057ed50eba632e5d877e0c` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-8/reading-route-acceptance.md` | MD | 72 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `d41f13f95e0aa11e74b989c35858037c5ff16bfc481a60fa6cebde74403eec62` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-8/verification-report.md` | MD | 67 行 | `L3_FROZEN_EVIDENCE` | `FULL_READ_RECONCILED` | `a619042a381b842c5bc8e4b1e1c5cac27c3b8cb52f84869b6c02e1d5b2b2addf` | 冻结证据；只做 provenance/delta |
| `docs/roadmap/saas-frontend-phase-9/README.md` | MD | 132 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + PHASE1_DELTA + POST_BASELINE_HASH_REFRESH + IA_DELTA` | `d06a54509ad3888a083074b60aeb6684030bd33cb75200a732e0a77b2b528cc4` | 工作/参考；同步 Phase 0/1、76/76 Manifest、`e0e5107` 增量事实和待评审的完整管理员 8/38 IA；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/conflict-and-decision-ledger.md` | MD | 114 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + PHASE1_DELTA + POST_BASELINE_HASH_REFRESH + IA_DELTA` | `8778a8ea632abbc9aef1a2261d60f44b8fb1619f4e9eb7c92c545123a06f3a92` | 工作/参考；同步设计证据、组件资格、MapLocation 合同及 `DEC-FE-P9-019/020` IA 纠偏；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/feature-coverage-ledger.md` | MD | 210 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `a7acaaa341f370505b6c69f80aa36b5289029e1c3a9f3e8afb0f454b41870ca7` | 工作/参考；OpenAPI 在 `e0e5107` 仍为 56 paths / 64 operations；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/figma-delivery-register.md` | MD | 148 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + PHASE1_DELTA + IA_DELTA` | `57c191399258e570ffc5afe392dea1246703a8653df3c7af0a4249d5c40edd23` | 工作/参考；登记 FigJam、Foundations、代表页、状态/移动端与原型 Node，并标明旧六域节点待 8/38 评审后重构；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/interaction-language-and-visual-semantics.md` | MD | 237 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + IA_DELTA` | `30d34a82b854fd53d612255062e13805835e233836e5153f1f8d67809d7fa208` | 工作/参考；同步 8/38 侧栏、7 个 Shell 控件和对象 Tab；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/journey-and-prototype-catalog.md` | MD | 112 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `390739a1bb9c9dacf2ab5f72119f2dc10bc5dd0e190ce46d66d7fd49a08ce818` | 工作/参考；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/object-page-family-review.md` | MD | 286 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + IA_DELTA` | `5448e3b9d6035f937fd1602596d01ca7d9cb7dd5857c63e8fcc561a669e7d2a9` | 工作/参考；24 个页面族与待评审 8/38 IA 对齐；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/provider-and-sor-architecture.md` | MD | 638 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `060009a32974a67745d7ce273672a8ea80b97a46e06c6152c17fd977714a35a7` | 工作/参考；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/source-and-truth-ledger.md` | MD | 220 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED + PHASE1_DELTA + POST_BASELINE_HASH_REFRESH + IA_DELTA` | `167ef6ad6e1294f7820a9ed399df262facf8ccd9eac9a6580203304809f47d44` | 工作/参考；更新 Figma、组件资格、MapLocation、`e0e5107` 增量事实和待评审 8/38 IA successor；不得覆盖 current |
| `docs/roadmap/saas-frontend-phase-9/visual-direction-content-fixture.md` | MD | 132 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `ed4a7a292be7daa62596356921072867de82d1869a14e9691330a7d13f340512` | 工作/参考；不得覆盖 current |
| `docs/roadmap/sam-sources-sought-p4-design.md` | MD | 158 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `17fafbf7b3547d9a3cb870f6fee5db2cbfcee10bdbe1211337edcab52695dead` | 工作/参考；不得覆盖 current |
| `docs/roadmap/sanctions-screening-design.md` | MD | 206 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `a73f7755174f4a6fa4c2628b0ff3f160dc82535cd9d6e4e3eeeeffc3450368f3` | 工作/参考；不得覆盖 current |
| `docs/site-builder/00-decisions-and-coordination.md` | MD | 53 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `68e389d73a666136aa0901aaa1ff31a6eef9da0fa3c3b8cf24434cddb84868c9` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/01-prd.md` | MD | 165 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `ee827a484ab628a91729e6cc5c5518b9e9008e5fd061ebeb030ef8d8d71f5d41` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/02-architecture.md` | MD | 378 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `4824e1e3553e2ee83798a84a68abc550bf3cf88895a020546977206be55c775b` | 活规格/治理；D16 已改为无外呼 MapLocation 文本卡；须与机器事实一致 |
| `docs/site-builder/03-agents.md` | MD | 220 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `21ffee79038cc7f6566d5ac4bc9be850926744207dbfaaabf401a8e193affd7a` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/04-sitespec-contract.md` | MD | 286 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `b7b47f6922e198106ec77d0802bbc0cddf8488516c8246ff5e3b536e11452c04` | 活规格/治理；分批资格摘要不作 current 总数，MapLocation 为文本合同；须与机器事实一致 |
| `docs/site-builder/05-deployment-hosting.md` | MD | 166 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `62861fd7b4d7820fe5b0f2ac07c5de6f027825207b987002ab07d56543ecde10` | 活规格/治理；MapLocation 不再需要地图 key/CSP 白名单；须与机器事实一致 |
| `docs/site-builder/06-security-abuse.md` | MD | 243 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `53b472e1b7ddf1bda75f17b9d416115b91a97f907c144503b481e6934a64c35c` | 活规格/治理；MapLocation 禁 iframe/Geocoding/坐标和位置推断；须与机器事实一致 |
| `docs/site-builder/07-api-contract-draft.md` | MD | 228 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `34b71b7d7faffb97b1c20eed42027dec87aacecb7e9e3bf1f191d71233c7da22` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/08-eval-testing.md` | MD | 367 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `602631a594d31fc45d93d5434e1759e8cded8b602798bcf07d65b9916f0a8de3` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/09-m1-implementation-design.md` | MD | 364 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `9f05a9571a3728b00cd8fbf1d73fd6b97383d7a7da0b5c06b7c59d94dc5bbaf0` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/10-model-selection-study.md` | MD | 344 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `16608f79e84b7cd4115d4cf510f37cd10b1770bc4880c859b0df901787e6346c` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/11-readdy-component-source-study.md` | MD | 250 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `74069d7be6f89254cb4c32ea26fe16df534b42d4f873793afaa7318e3ee90aeb` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.1.md` | MD | 2477 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `632dce6057b78f4f57a95f40f425d379e945701b773a43ee27b6547dc7a83302` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/12-site-builder-design-intelligence-and-cc-implementation-v3.2.md` | MD | 2410 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `ddfb0592b5021f35078434ce327593da92a10333266256953b774b6c9104f74c` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/13-design-domain-model.md` | MD | 255 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `ebbbf5277a421bd89eba74634f2ad742b92d2f8c4dbb8171275395b034e548a3` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/14-media-foundation-mf0.md` | MD | 209 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `b8d6ab907a168795ebe5759a87836fe0977d59a54fb18bab116dab2d086b4792` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/DQ-1-shared-sitespec-contract.md` | MD | 68 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `db2baa359e4f3d7c72a149e60b994207051842f1ca47cf307de9b4a4c82c1f1d` | 活规格/治理；须与机器事实一致 |
| `docs/site-builder/handoffs/r1-min-execution-brief.md` | MD | 343 行 | `L2_ACTIVE_GOVERNED` | `FULL_READ_RECONCILED` | `40d2a2167537d4f76ad30f8bd8501a1007a13d33dacfe5705763b0c1e925167b` | 活规格/治理；须与机器事实一致 |
| `docs/status/current.md` | MD | 59 行 | `L1_CURRENT` | `FULL_READ_RECONCILED + POST_BASELINE_HASH_REFRESH` | `b4339da4c9e201eeeeebbeb42bf12aa65a80e03a16be3496156df70918688ff7` | current 真值；已对账 44/55 资格、308 份证据和 132 张截图；冲突时优先 |
| `docs/status/pilot-readiness-gap-report.md` | MD | 45 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `a75259a9f2a8502c9c0b50a46725fa6a25a1cd1b5c4229d94efb836a69032a73` | 工作/参考；不得覆盖 current |
| `docs/templates/release-bundle-template.md` | MD | 107 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `75a03cebd34e74b2b74784054fbfcb4fba830689ffab53db6937f3af44360e0a` | 工作/参考；不得覆盖 current |
| `docs/templates/release-learning-template.md` | MD | 50 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `aadd41d04533f53a50aaa170f88e3685f9d608fb965d06e3dc28d693cb919c5f` | 工作/参考；不得覆盖 current |
| `docs/templates/前端技术方案模板.md` | MD | 52 行 | `L3_WORKING_REFERENCE` | `FULL_READ_RECONCILED` | `8b68e4320ca13e8628a2ce2e19da806abfe98328e5e02746da5936acf0e2d173` | 工作/参考；不得覆盖 current |
| `docs/出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` | DOCX | 5677 段 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `b3759d906f3d9bb51246549d406a3abd252048e7a5393dc1f3b183853613ed76` | 历史输入；只发现候选 |
| `docs/出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` | DOCX | 3218 段 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `5fcf59f05413e3a212b301651ee68c950a6306ebd7492eb31f685d7d2f8a3d6b` | 历史输入；只发现候选 |
| `docs/出海企业AI增长平台_总产品手册与PRD_v2.0_完整产品母本.docx` | DOCX | 6230 段 | `L4_HISTORICAL_INPUT` | `FULL_READ_RECONCILED` | `7c174c5d67ac553aca8e42bf571adcc4d2ad7b0ceffceacd1ff54df882f30ad7` | 历史输入；只发现候选 |

## 5. 变更与复读门

### 5.1 快照后的 Phase 9 新文件

以下文件在 171 份来源快照完成后创建，是本轮设计 successor，不修改“171/171 已读来源”的分母；已单独全文读取并登记：

| 路径 | 类型 | 规模 | 权威层级 | 读取状态 | SHA-256 | 采用规则 |
|---|---:|---:|---|---|---|---|
| `docs/roadmap/saas-frontend-phase-9/design-system-v1-scope.md` | MD | 119 行 | `L3_WORKING_REFERENCE` | `PHASE9_SUCCESSOR_READ + PHASE1_DELTA + POST_BASELINE_HASH_REFRESH` | `52598ea0dcebd90eb3b6f455225b336115bb7629c6d7e3054954890efbe8d4e8` | Phase 0 已批准并记录四个 Design 文件、17 张桌面代表、5 个关键状态、3 张移动端和 6 条原型骨架的 Phase 1 草稿；不得冒充已冻结 Token/组件 |
| `docs/roadmap/saas-frontend-phase-9/canva-review-delivery.md` | MD | 64 行 | `L3_WORKING_REFERENCE` | `PHASE9_SUCCESSOR_READ` | `6a9b654119ff393ced6aca5d46fe1e1a05b5d2bb618e33ac4482b8cae0d275b4` | Canva 传播层登记；不得覆盖 Figma 设计真值 |
| `docs/roadmap/saas-frontend-phase-9/phase-1-design-evidence.md` | MD | 193 行 | `L4_FROZEN_EVIDENCE` | `PHASE9_SUCCESSOR_READ + IA_DEBT_ANNOTATED` | `967d7304576ed98070aa0caf35bb722993e8cf73110ca8615942a6ebdf2fcfeb` | Phase 1 Design Node 与作者 QA 证据；已标注旧六域公共首页为待修正设计债，不证明用户验证或实现 |
| `docs/roadmap/saas-frontend-phase-9/information-architecture-and-coverage-audit.md` | MD | 286 行 | `L3_WORKING_REFERENCE` | `PHASE9_SUCCESSOR_READ` | `5fcc7f7863a08fc3266dcb15f208b297116482ad4a44361263c20269d34c1438` | 8 个一级/38 个二级、7 个 Shell 控件、对象 Tab、76 Page、36 Feature 和 24 Page Family 的完整归属提案；评审前不得批量改 Figma |
| `docs/roadmap/saas-frontend-phase-9/page-manifest-v2.md` | MD | 167 行 | `L3_WORKING_REFERENCE` | `PHASE9_SUCCESSOR_READ` | `b72ed15bd9d7715418624080b7f1ece24ae8c4e9f35e66a359fc493f54fe7fd4` | 76 个稳定 Page ID、已设计跨域代表/状态/响应式/六条原型 Node 与公共站候选的 Manifest 2.0 登记；不改变 current Page Registry 或产品状态 |

出现以下任一情况时，不能沿用本总账的“已读”结论：

1. 文件 SHA-256 改变；
2. product scope、architecture、ADR、status 或 release plan 改变；
3. OpenAPI/Prisma/current code 与文档出现新的不一致；
4. 历史稿被提议升级为 current；
5. 新截图、竞品或生成稿引入文档中没有的对象、字段或生命周期。

复读后必须同步 [来源与事实总账](source-and-truth-ledger.md)、[冲突与决策总账](conflict-and-decision-ledger.md)、[功能覆盖总账](feature-coverage-ledger.md)和受影响的对象/旅程/Figma 登记。
