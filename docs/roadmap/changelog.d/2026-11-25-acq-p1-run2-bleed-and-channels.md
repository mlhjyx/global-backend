---
date: 2026-11-25
pr:
title: Stabilize Run 2.0 discovery cancellation, scoring, signal projection, and dormant sourcing channels (Phase 1)
---

- 起因：Run 2.0 挖掘链路在取消收尾、深挖止血、快扫口径、评分可达性、信号投影与多渠道唤醒上存在多处断点，导致取消任务误报 `FAILED` 且留下 `total_score=NULL` 线索、`weak` 候选继续消耗信号抓取、`.pdf` 链接拖垮 `crawl4ai.render`、`discovery.quick_judge` 系统提示词与用户提示词矛盾、淘汰公司在评分阶段复活进 `needs_review`、`RISKY`/`pattern_guess` 盲猜邮箱误拿可达性分、档案页信号区为空以及 `ecosystem-sniper`/`Exa findSimilar`/`channel_catalog` 处于沉睡状态。
- 改动：
  1. Run 2.0 取消与评分完整性：`discovery.workflow.ts` 把取消路径上的 `acts.deepStageSummary()` 移入 `CancellationScope.nonCancellable` 确保落库统计并标 `CANCELLED`；`discovery.activities.ts` 在 `FIT_REACHED_FAILURE_STAGES` 补入 `'deep'` 与 `'contacts'`，并让 `fitStageJudged` 合并 `discovery_company_job` 的已判公司 ID，确保深挖中断仍触发 `QualifyRequested`。
  2. Run 2.0 深挖止血与活性：`discovery.run2.pipeline.workflow.ts` 通过新版本闸 `COMPANY_PIPELINE_WEAK_SKIP_SIGNALS_PATCH` 让 `weak` 在 `signals` 之前短路（保留既有 `COMPANY_PIPELINE_QUALITY_GATE_PATCH` 历史重放路径），并为 `modelActs`/`signalActs` 补 `heartbeatTimeout: '5 minutes'`；`discovery.run2.pipeline.activities.ts` 接入 `withActivityHeartbeat` 与 `cancellationSignal` 检查，并在 L0 enforce 拦截时清理旧暂定 `weak` Lead；`source-tools.ts` 及 4 个抓取调用点增加 `.pdf` URL 与 `application/pdf` Content-Type 护栏。
  3. 快扫 / 评分 / 合格化除错：`task-registry.ts`（`discovery.quick_judge`）与 `discovery-quick-judge/SKILL.md` 及生成的 `builtin-skill-catalog.ts` 统一为两层买家口径；`pool.ts` 与 `discovery.run2.activities.ts` 拦截历史 `mismatch`/`prefiltered_out` 重复入池并在预筛淘汰时降级旧暂定 Lead；`qualify.activities.ts` 通过 `qualify-elimination-filter.ts` 禁止复活淘汰公司；`scoring.ts` 取消 `RISKY` 与未验证 `pattern_guess` 邮箱的 `0.5` 可达性分。
  4. 信号恢复与沉睡渠道唤醒：`discovery.workflow.ts` 通过 `DISCOVERY_RUN2_WATCHES_PATCH` 补回 Run 2.0 `registerWatchesForRun` 并在 `discovery.activities.ts` 合并 Run 2.0 `verdictDeep='match'` 公司；新增 `enrichment-signal-projection.ts` 把 `digital_footprint`/`structured_harvest` 信号以 `signal_kind='page_change'` 幂等写入 `company_signal`，并在 `lead-package.ts`/`lead.service.ts` 投影到 `LeadPackage.signals`；修复 `public-web.provider.ts` 狙击查询截断与纯种子域 Exa `find_similar` 提前返回，在 `ecosystem-sniper.ts`/`icp.service.ts` 透传 ICP 品牌与种子过滤词；放开 `channel-catalog-query.ts` 对已启用渠道的 `PENDING` 记录与 `provider.registry.ts` 默认血缘声明；收紧 `icp-trade-role.ts` 与 `directory.provider.ts` 过宽的 `LISTING_HINT`。
- 测试：完成全量 `@global/api` 构建与全量单元测试、新增与更新的 Phase 1 专项单测、`skills:validate` / `skills:evals:validate`、`governance:verify`、`copy-fixed-source-impact.mjs`、`governance-document-drift.spec.mjs`、`governance-changelog-fragments.mjs`、`docs:verify` 与 `gitleaks` 扫描。
- 未做：Phase 2 HTTP-first 单活动提取重构、Phase 3 多渠道轻触达与生产环境部署/实机 Run 验收待后续阶段推进；本分支改动尚未合入 `main`。
