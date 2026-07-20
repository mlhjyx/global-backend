# 内容与微文案目录

> 文档 ID：`DESIGN-FE-002`
> 层级：`L2 / Content registry`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_4`
> 内容 Owner：`OWN-DESIGN`
> Source locale：`zh-CN`；其他翻译尚未创建

## 1. 使用方式

本目录固定跨模块和首个独立站纵切关键文案的意图与变量，不替代页面内容设计。以下中文均为 `DRAFT_SOURCE_COPY`，仍需在真实界面、目标用户、长度、读屏和翻译环境验证。

变量使用 `{object}`、`{time}`、`{count}` 等命名；值必须转义、本地化并按权限脱敏。禁止将原始错误、Prompt、用户上传文本直接插入 `aria-live`、Toast 或通知。

## 2. 跨模块文案

| Copy ID | Intent | Draft source copy | Variables / action | 关联状态/场景 | 状态 |
|---|---|---|---|---|---|
| `COPY-FE-STATE-001` | 能力不可用 | “此功能当前不可用：{reason}。” | 可选 `{next_action}`，不承诺日期 | `STATE-FE-005` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-002` | 数据 stale | “显示的是 {time} 的数据。刷新后再执行高影响操作。” | `刷新` | `STATE-FE-012` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-003` | 部分成功 | “已完成 {success_count} 项，{failed_count} 项需要处理。” | `查看失败项` | `STATE-FE-010` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-004` | 降级可用 | “结果可用，但 {degraded_scope} 未达到完整质量。” | `查看影响/补资料/接受` | `STATE-FE-011` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-005` | ACK 不明 | “请求可能已经提交，正在确认结果。请不要重复创建。” | `重新确认` | `STATE-FE-018`；Site 002/005/015 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-006` | 可重试错误 | “{step} 未完成。已有结果已保留。” | `重试此步骤/查看详情` | `STATE-FE-014` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-007` | 取消确认中 | “已请求取消；在系统确认前，任务仍可能有在途操作。” | `查看任务` | `STATE-FE-016` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-STATE-008` | 旧结果保留 | “本次候选未生效，当前可用版本保持不变。” | `打开当前版本` | Site 014/017 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-PERM-001` | 动作无权 | “你可以查看此对象，但不能执行 {action}。” | `申请权限/联系 Owner` 若可用 | `STATE-FE-004` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-PERM-002` | 对象不可披露 | “找不到此内容，或你没有访问权限。” | 安全返回 | Shell 001 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-AI-001` | AI 草稿 | “这是基于现有资料生成的草稿，发布前需要审核。” | `查看资料/审核` | `AIINFO-FE-004` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-AI-002` | 推断/未知 | “这是推断，不是已核验事实。仍缺少：{missing}。” | `补资料/忽略` | `AIINFO-FE-002` | `DRAFT_SOURCE_COPY` |
| `COPY-FE-APPROVAL-001` | 批准确认 | “批准后，{scope} 可在 {use} 中使用。你批准的是版本 {version}。” | `批准/退回` | Claim/Content Approval | `DRAFT_SOURCE_COPY` |
| `COPY-FE-COST-001` | 成本未知 | “本次实际成本尚未确认；系统不会把估算值当作实际值。” | `查看明细/等待结算` | Site 013 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-001` | 开发预览边界 | “这是开发预览，不是已公开发布的网站。” | `打开预览` | Site 016 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SUPPORT-001` | 支持信息 | “如需协助，请提供诊断编号 {correlation_id}。” | `复制编号` | Incident/Help | `DRAFT_SOURCE_COPY` |

## 3. 独立站管理模块文案

| Copy ID | Intent | Draft source copy | Variables / action | 关联场景 | 状态 |
|---|---|---|---|---|---|
| `COPY-FE-SITE-002` | Intake 校验 | “请先修正标出的资料；尚未创建新站点。” | `查看错误` | Site 001 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-003` | Intake 幂等冲突 | “这次提交与正在确认的请求不一致。请返回已有结果，或明确开始一次新建站。” | `返回已有结果` | Site 002 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-004` | Demo 准备 | “Demo 正在准备。你可以离开此页，任务会继续。” | `查看任务` | Site 001 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-005` | Profile 冲突 | “资料已被更新。你的修改已保留，请比较后再保存。” | `比较版本` | Site 003 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-006` | 上传授权过期 | “上传授权已过期，文件尚未丢失。请重新获取授权后继续。” | `继续上传` | Site 005 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-007` | Commit 确认 | “文件可能已经提交，正在确认处理状态。请不要重复上传。” | `重新确认` | Site 005 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-008` | 重复素材 | “相同素材已存在，本次不会创建重复对象。” | `打开已有素材` | Site 006 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-009` | 素材拒绝 | “此文件不能用于站点：{reason}。” | `更换文件` | Site 006 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-010` | 处理可重试 | “素材处理未完成，素材身份已保留。” | `重试处理` | Site 006 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-011` | 素材被引用 | “此素材仍被 {usage_count} 处内容引用，尚未删除。” | `查看引用` | Site 007 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-012` | KB 部分成功 | “已有资料可以使用，但仍缺少：{gaps}。” | `补充资料` | Site 008 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-013` | Claim 合同阻塞 | “站点事实审核尚未开放，系统不会自动批准这些内容。” | `查看处理说明` | Site 009 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-014` | Claim 待审核 | “这条事实需要审核后才能用于新的站点内容。” | `查看证据` | Site 009/010 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-015` | 已有 Build | “此站点已有任务运行中，请先查看当前任务。” | `打开任务` | Site 012 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-016` | 不支持选项 | “当前不支持 {option}。请选择系统提供的范围、风格或语言。” | `返回配置` | Site 012 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-017` | 配额/预算阻塞 | “当前预算或配额不足，系统没有启动新的付费操作。” | `{next_action}` 仅服务端提供时显示 | Site 012 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-018` | Build 运行 | “正在生成候选站点。你可以离开此页，稍后继续查看。” | `查看步骤` | Site 011/013 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-019` | Build 降级 | “候选结果可查看，但以下部分未完整完成：{degraded_scope}。” | `查看影响` | Site 013/018 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-020` | Build 失败保旧结果 | “本次候选未生成可用结果；当前开发预览保持不变。” | `打开当前预览/恢复` | Site 014 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-021` | Cancel ACK unknown | “取消请求正在确认。确认前任务仍可能有在途操作。” | `重新确认` | Site 015 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-022` | Preview 完整性失败 | “候选站点未通过完整性检查，系统没有切换当前结果。” | `打开旧预览/查看任务` | Site 017 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-023` | 无开发预览 | “当前还没有可用的开发预览。” | `查看任务/开始 Build` | Site 016 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-024` | Locale 降级 | “{locale} 内容未完整生成，主语言结果已保留。” | `查看缺失内容` | Site 018 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-025` | Runtime 合同阻塞 | “此候选包含当前不支持的页面组件，未生成可用预览。” | `返回任务` | Site 017 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-026` | Publish 不可用 | “当前只提供开发预览，公开发布尚未开放。” | `返回预览` | Site 020 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-027` | Domain 不可用 | “域名与 SSL 配置尚未开放；开发预览不是公开域名。” | `了解当前边界` | Site 021 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-028` | Inquiry 禁用 | “当前站点不接收在线询盘。请使用页面中已核验的其他联系渠道。” | 无提交动作 | Site 022 | `DRAFT_SOURCE_COPY` |
| `COPY-FE-SITE-029` | Analytics 不可用 | “站点分析尚未开放；此处不会显示示例数据冒充真实访问。” | 无 | Site 023 | `DRAFT_SOURCE_COPY` |

## 4. 内容结构模板

| Surface | 顺序 |
|---|---|
| 状态 Banner | 状态/影响 → 保留内容 → 下一步 → 详情 |
| Error summary | 发生什么 → 字段/步骤链接 → 修复方式 → 支持 ID |
| Approval | 决定对象/版本 → diff/Evidence → 影响/范围 → 批准/退回 |
| Long task | 任务/对象 → 当前步骤/更新时间 → 成本/影响 → cancel/recovery |
| Empty state | 为什么为空 → 是否正常 → 第一个有价值动作 → 可选指南 |
| AI result | 类型 → 来源/未知 → 内容/diff → review/feedback/action |

## 5. 本地化与 a11y

- 每条 Copy 记录 description/context、字符长度假设、变量类型、plural/select、读屏优先级和不应翻译的术语。
- 不依赖标点、大小写或颜色传达状态；screen-reader-only 文本仍进入 Copy ID。
- Error live announcement 保持简短；详细诊断由聚焦区域读取，不重复整页。
- 翻译审批与产品事实审批分开；Claim 的语言适用范围不可由 UI 翻译状态替代。

## 6. 禁止文案

- 无证据的“已完成、全绿、100% 准确、生产就绪、发布成功”。
- 将 `partial/degraded/unknown/skipped` 写成“成功”。
- “确定吗？”而不说对象、版本、范围和影响。
- “权限不足”同时给出无权对象名称、成员或敏感配置。
- 使用模型/Provider/HTTP/数据库名作为普通用户主错误。
