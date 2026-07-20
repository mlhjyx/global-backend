# Gate 7 评审包

> 文档 ID：`GATE-FE-P7-001`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 授权：Gate 6 于 2026-07-20 通过，`DEC-FE-P6-001..012` 已批准，`BLK-FE-001..007` 与 `GAP-FE-P6-001..012` 保留
> 工程基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 当前授权终点：Gate 7；未获批准不得进入 Phase 8 或任何采用实现

## 1. 评审结论

Phase 7 已把 Word、GoodJob、Phase 1 外部研究、本地代码/依赖和 Ubuntu 开发运行中出现的外部能力归并为 31 个稳定 Card。每项都具备 `Learn / Build / Adapt / Integrate / Buy / Avoid / Defer` 主决定、许可/商业边界、Adapter/SoR、安全/数据、测试/Release Gate、责任帽和 Exit Plan。

组合没有把“开源项目多”当能力完整：八项已有 as-built 继续硬化；Puck 只作为受阻 Spike；Readdy 运行时/代码/素材/训练用途明确 Avoid；UI、增长、媒体、知识、策略、备用网关和观测候选继续按触发器 Learn/Defer。没有候选因本轮文档自动获得安装、采购、账号、依赖、部署或生产授权。

## 2. 覆盖结果

| 检查面 | Phase 7 结果 | 不代表 |
|---|---|---|
| 候选总账 | `ADP-FE-001..031` 连续、唯一并有分组 Card | 31 项都值得集成 |
| 现用事实 | 8 项独立列出代码/lock/runtime 证据与硬化缺口 | 已 pin、已生产、已完成法务/安全 |
| 外部来源 | Phase 1 `SRC-OSS-001..020` 全部映射；11 项新增/方法来源有官方入口 | 滚动来源永远有效或等于本地版本 |
| 采用边界 | 所有运行候选必须在我方 Contract/Adapter 后，业务对象/身份/权限不外包 | Adapter 已实现或测试已执行 |
| 商业/许可 | 开源核心、EE、AGPL、专用许可、ToS、模型/素材/渠道权利拆开 | 工程初审替代正式法律意见 |
| 安全/测试 | 每 Card 有数据风险、测试门和 release 条件 | 候选通过安全审查 |
| Owner/退出 | 每 Card 有责任帽和具体替换方向；现用八项有退出基线 | 实际 assignee 已接受或已演练 |
| 产品优先级 | 非 Site 域仍 `NOT_DEV_READY`，客户开发仍冻结，Site blocker 保留 | 外部项目进入 roadmap |

## 3. 推荐批准决定

| Decision ID | 推荐批准内容 | 采用后的约束 | 不代表 |
|---|---|---|---|
| `DEC-FE-P7-001` | 批准 31 项全量 Registry 与稳定 `ADP-FE-*` Card | 新候选先入 Registry，不在 PRD/代码注释里形成影子清单 | 31 项均获采用 |
| `DEC-FE-P7-002` | 批准七类采用词汇和 fail-closed 准入政策 | 状态变化必须有触发器、delta 证据和 Gate | `LEARN/DEFER` 可先安装 |
| `DEC-FE-P7-003` | 批准业务能力只依赖我方 Contract/Adapter，业务对象/身份/权限不进入 OSS SoR | Vendor UI/DB/SDK 不成为产品合同 | Adapter 已编码 |
| `DEC-FE-P7-004` | 批准 8 项现用能力为 `INTEGRATE / *_HARDEN` | 补 pin、许可、安全、恢复、Owner、退出和生产证据 | 当前已生产可用 |
| `DEC-FE-P7-005` | 批准 Puck 为 `ADAPT / SPIKE_BLOCKED`，Readdy 为用途级 `AVOID` + 净室 `LEARN` | 关闭先决 blocker 前不安装 Puck；Readdy 不进入运行时/训练链 | 否定可视化编辑或设计研究 |
| `DEC-FE-P7-006` | 批准 UI 基底与 Storybook/Playwright 工具等到正式前端后同 Fixture bake-off | 只选一个 primary UI 基底，方法可先学习 | 已选择 React/shadcn 或测试栈 |
| `DEC-FE-P7-007` | 批准增长/自动化/互动候选保持 `LEARN/DEFER` | 先有批准纵切、SoR、渠道/embedding/PII/退出门 | 功能被永久拒绝 |
| `DEC-FE-P7-008` | 批准媒体候选保持 `LEARN/DEFER`，Remotion 受公司许可门 | 先有用户结果、资产权利、模型/节点、GPU/成本和退出证据 | 视频能力已进入 roadmap |
| `DEC-FE-P7-009` | 批准 Cognee/Graphiti/LightRAG 只在同 corpus/问题/删除/引用/成本下 bake-off | pgvector 基线不达门才重开；胜者仍在 `RetrievalGateway` 后 | 当前 KB 需引入图数据库 |
| `DEC-FE-P7-010` | 批准 Docling/Crawl4AI/SearXNG 继续硬化，Firecrawl 只作 fallback；Temporal/new-api 硬化，OPA/LiteLLM/Langfuse 触发式重开 | 禁滚动 `latest` 进生产，禁止长期双网关/双真值 | 授权镜像/依赖变更 |
| `DEC-FE-P7-011` | 批准 Diátaxis、GoodJob、TechDocs、Playwright 的方法性吸收 | 学习表达/治理/场景，不复制导航、代码、内容或营销声明 | 需要部署 Backstage/GoodJob |
| `DEC-FE-P7-012` | Gate 7 后只授权 Phase 8 文档 lint、归档提案、Release Bundle 与最终治理收口 | Phase 8 不自动实施任何候选、采购或生产动作 | 授权产品代码或历史文件移动 |

## 4. Gate 7 验收

| 验收项 | 结果 | 证据 |
|---|---|---|
| Word/Phase 1/GoodJob/local 候选无失踪 | `PASS_FOR_ADOPTION_REVIEW` | [Registry](../../backend/oss-registry.md) + [来源快照](../../platform/oss-adoption/official-source-snapshots.md) |
| 每项有七类决定、许可、Adapter、安全、测试、Owner、Exit | `PASS_FOR_CARD_DEPTH` | [采用入口](../../platform/oss-adoption/README.md)下七组 Card |
| 开源、企业、商业与内容权利未混写 | `PASS_FOR_ENGINEERING_REVIEW` | [采用政策](../../platform/oss-adoption/adoption-policy.md) + 来源快照 §5 |
| as-built 与 production-ready 未混写 | `PASS` | [现用硬化基线](runtime-hardening-and-exit.md) |
| UI/编辑/知识/媒体候选有重开条件 | `PASS` | [组合与触发器](portfolio-decisions-and-triggers.md) |
| Adapter/SoR 与退出不是口号 | `PASS_FOR_DESIGN_DEPTH` | Registry + 每项 Card + 现用退出基线 |
| 既有产品边界、冻结和 blocker 保留 | `PASS` | Phase 6 Pack 状态 + 本评审 §5 |
| 无实现、依赖、部署、采购或外部状态变更 | `PASS` | Phase 7 diff 仅 Markdown |

## 5. 保留的阻塞与未决门

- `BLK-FE-001..007` 与 `GAP-FE-P6-001..012` 全部保留；正式前端、设计源、权限/Claim、指标/Owner、公开站链均未因 OSS 组合关闭。
- 八项现用能力的固定版本/SBOM、生产拓扑、安全/商业签字、实际 assignee、SLO/恢复与退出演练仍未关闭。
- Puck、UI 库、Storybook/Playwright 工具仍受正式前端和设计 source 阻塞。
- 增长、Conversation、媒体、知识图、OPA、备选网关和 Langfuse 没有获批产品纵切或运行时采用。
- 工程许可证初审不能替代公司法务意见；尤其 AGPL、EE、专用许可、平台 ToS、模型/素材/渠道和客户内容继续 fail-closed。

## 6. 质量与非越界检查

- 37 份变更均为 Markdown；每份恰有一个 H1、代码围栏成对、结尾换行合法，135 个表格列结构一致。
- 343 个 Markdown 链接的本地目标存在；其中 38 个本地 heading anchor 与目标标题匹配。
- 全仓扫描到的 90 个 Document ID 唯一；`ADP-FE-001..031` 连续唯一，31 个 Registry row 与 Card 主决定逐项一致。
- 31 个 Card 的 248 个必需字段（每项八字段）齐全；每项只有一个 Accountable Owner，均能在 23 项责任词典中解析。
- 八项 `INTEGRATE / *_HARDEN` 集合与 Registry 精确一致；Phase 1 `SRC-OSS-001..020` 全部有 Card 映射；12 个 Gate 7 Decision 唯一。
- Ubuntu 开发环境复核五个相关容器仍在运行，配置 tag 与 image ID 与来源快照一致；Temporal dev service active，CLI/Server/UI 与 lockfile 版本一致。该复核只证明当前开发机状态。
- 占位/越权扫描未发现 `APPROVED_AT_GATE_7`、`PHASE_8_GRANTED` 或实现/生产批准；`git diff --check` 通过，变更路径白名单中没有代码、依赖、Schema、OpenAPI、infra 或历史文件动作。

这些机器检查不替代产品负责人、法务、安全、实际 Owner、用户、运维或生产 Release 验收；精确 Git checkpoint 由提交记录承重，不在文档中自引用不稳定 hash。

## 7. 请求 Gate 7 决定

请确认：

1. 是否按 `DEC-FE-P7-001..012` 批准 31 项采用组合、准入词汇与重开条件；
2. 是否接受 8 项现用能力当前只达到 `INTEGRATE / DEV_AS_BUILT_HARDEN` 或 `AS_BUILT_CODE_HARDEN`；
3. 是否接受其余候选按 Card 保持 `ADAPT/LEARN/DEFER/AVOID`，不自动进入 roadmap；
4. 是否保留所有既有 Blocker/Gap 以及本轮未关闭的许可、安全、Owner、生产和退出门；
5. 是否只授权 Phase 8 文档治理与最终 Release Bundle，不授权任何候选实现。

推荐批准语句：

`Gate 7 通过，按 DEC-FE-P7-001..012 批准 OSS/外部能力采用组合、准入门、Adapter/SoR 边界与退出计划；接受 ADP-FE-001..031 的当前决定，接受 8 项现用能力仅为 INTEGRATE / *_HARDEN、其余候选按触发条件保持 ADAPT/LEARN/DEFER/AVOID，并在保留 BLK-FE-001..007、GAP-FE-P6-001..012 与全部未关闭许可、安全、Owner、生产和退出门的前提下授权 Phase 8。`

收到明确批准前，当前任务停止在 Gate 7，不进入 Phase 8。
