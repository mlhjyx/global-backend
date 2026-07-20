# 历史文档 banner 与归档处置建议

> 文档 ID：`BASE-FE-P8-001`
> 层级：`L3 / Governance proposal`
> 状态：`FROZEN_EVIDENCE` / `APPROVED_AT_GATE_8`
> 事实 Owner：`OWN-DOC-GOV`
> 文件动作：`APPROVED_POLICY / NO_MOVE_NO_DELETE`
> 核验日期：2026-07-20

## 1. 建议结论

Phase 8 建议采用“**原位保留 + 强 banner + Registry successor + 自动检查**”，暂不把 Site 10–12、Word、Phase 1–7 评审证据或旧模板迁入 `archive/`。理由不是历史文件继续有效，而是当前仍有仓内深链、Git provenance 和主工作区用户删除现场；移动的收益低于断链与误恢复风险。

该建议已在 Gate 8 获批，只批准文件生命周期和后续动作规则；本阶段仍不移动或删除任何历史文件。

## 2. Site 10–12 逐项处置

| Registry ID | 当前 banner / 状态 | 非自身文件引用数 | Successor | 建议动作 |
|---|---|---:|---|---|
| `DOC-HIST-SB-010` | 顶部有治理定位、旧 Mac 环境迁移和 2026-07-19 supersession | 11 | `task-routes.ts`、active model evidence、ADR-016/020 | 原位 `FROZEN_EVIDENCE`；只允许附加新 supersession，不重写旧实验 |
| `DOC-HIST-SB-011` | 顶部明确“历史研究档案、ADR-019 取代”和禁止用途 | 4 | ADR-019 + `ADP-FE-004` | 原位 `DATED_PROPOSAL`；不恢复旧“导出/逆向”建议 |
| `DOC-HIST-SB-012A` | 顶部 `SUPERSEDED`，指向 v3.2、00–14、ADR 和 Codex 入口 | 4 | Site 00–14 + ADR + status + Phase 5 Pack | 原位保留；禁止以“完整”或篇幅恢复权威 |
| `DOC-HIST-SB-012B` | 顶部“dated proposal/非权威/不再更新”，有后续漂移提示 | 8 | Site 00–14 + ADR + status/release-plan + Phase 5 Pack | 原位保留；保留已知历史表格告警，不为 lint 改写冻结正文 |

引用数由当前 worktree 用精确 basename 搜索得到，只用于评估移动风险；不是全部外部深链证明。

## 3. Word 与旧产品母本

DOCX 不能像 Markdown 一样安全添加首屏 banner，且原件是来源 provenance。建议：

- 五份 Word 原位保留，只能从 [Document Registry](../../governance/document-register.md)和[门户](../../README.md)进入；
- `SRC-WORD-001/002/004` 保持 `DATED_PROPOSAL`，`SRC-WORD-003` 保持 `SUPERSEDED`，`SRC-WORD-005` 保持 `FROZEN_EVIDENCE`；
- 任何内容复用先引用已迁入的 Capability/Object/Frontend/OSS current 文档，不从 Word 直接拆开发任务；
- 若未来需要分发 Word，生成带水印/封面的派生副本，原文件 hash 和路径不变；该动作需另授权。

## 4. Phase 1–7 Gate 证据

Gate 包记录当时输入、选项、批准语句与限制，应该冻结而不是“更新到最新”。Phase 8 只把已批准决定回写 current Registry/规范；不得用后来事实重写 Phase 1–7 的审核数字、main SHA 或当时状态。

建议生命周期：

- Phase 1：`FROZEN_EVIDENCE`，保留 `c3f0cca` 时点；
- Phase 2–7：Gate 获批后 `FROZEN_EVIDENCE / APPROVED_AT_GATE_N`；
- current Registry、前端规范和 OSS Registry 继续维护，链接回 Gate provenance；
- Phase 8 评审包在 Gate 8 决定后同样冻结。

## 5. 旧前端技术方案模板

`docs/templates/前端技术方案模板.md` 内容过薄，缺少 Document ID、Owner、事实状态、权限/失败恢复、合同、证据、发布和学习字段；主工作区还存在用户删除 provenance。建议：

- 将其登记为 `REFERENCE_ONLY / LEGACY_TEMPLATE`，不作为新能力的写作入口；
- 不在本阶段修复、删除、移动或用 Git 操作恢复主工作区现场；
- 新 release/learning 使用本阶段受控模板；Capability 方案继续从全局规范和模块 Pack 裁剪，不用一个万能模板替代事实链；
- 若未来确需技术方案模板 v2，独立建立稳定 ID，并先定义适用任务和非目标。

## 6. 未来允许移动到 archive 的门

只有同时满足以下条件才能另提文件动作 PR：

1. 所有仓内与已知外部深链已枚举并有 redirect/兼容策略；
2. successor 有稳定 Document ID、Owner、状态、最后核验点和主题覆盖证明；
3. Git blame/Decision/Evidence provenance 不丢失；
4. 文档 Owner 与产品/技术事实 Owner 分别批准；
5. 移动前后运行 `pnpm docs:verify` 和角色任务；
6. 不涉及用户主工作区未提交删除/修改或未归属附件；
7. 移动、删除和 redirect 在单独授权范围内。

## 7. 自动护栏

[机器政策](../../governance/docs-verification-policy.json)固定检查四份 Site 历史稿的顶部 banner。它不扫描 DOCX 正文，也不自动移动文件。历史表格问题可以作为显式 warning 保留；current 文档同类问题必须失败。
