# 内容与微文案目录

> 文档 ID：`DESIGN-FE-002`
> 层级：`L2 / Content registry`
> 生命周期：`ACTIVE_INPUT`
> 评审状态：`READY_FOR_GATE_4_REVIEW`
> 内容 Owner：`OWN-DESIGN`
> Source locale：`zh-CN`；其他翻译尚未创建

## 1. 使用方式

本目录固定跨模块关键文案的意图和变量，不替代模块页面文案。以下中文是 `DRAFT_SOURCE_COPY`，Gate 4 通过后仍需在实际界面、目标用户、长度、读屏和翻译环境验证。

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

## 3. 内容结构模板

| Surface | 顺序 |
|---|---|
| 状态 Banner | 状态/影响 → 保留内容 → 下一步 → 详情 |
| Error summary | 发生什么 → 字段/步骤链接 → 修复方式 → 支持 ID |
| Approval | 决定对象/版本 → diff/Evidence → 影响/范围 → 批准/退回 |
| Long task | 任务/对象 → 当前步骤/更新时间 → 成本/影响 → cancel/recovery |
| Empty state | 为什么为空 → 是否正常 → 第一个有价值动作 → 可选指南 |
| AI result | 类型 → 来源/未知 → 内容/diff → review/feedback/action |

## 4. 本地化与 a11y

- 每条 Copy 记录 description/context、字符长度假设、变量类型、plural/select、读屏优先级和不应翻译的术语。
- 不依赖标点、大小写或颜色传达状态；screen-reader-only 文本仍进入 Copy ID。
- Error live announcement 保持简短；详细诊断由聚焦区域读取，不重复整页。
- 翻译审批与产品事实审批分开；Claim 的语言适用范围不可由 UI 翻译状态替代。

## 5. 禁止文案

- 无证据的“已完成、全绿、100% 准确、生产就绪、发布成功”。
- 将 `partial/degraded/unknown/skipped` 写成“成功”。
- “确定吗？”而不说对象、版本、范围和影响。
- “权限不足”同时给出无权对象名称、成员或敏感配置。
- 使用模型/Provider/HTTP/数据库名作为普通用户主错误。
