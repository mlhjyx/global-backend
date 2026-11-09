---
date: 2026-11-09
title: P3 J03 — 终判 judge 模型路由护栏（JUDGE_MODEL_ALLOWLIST、override 拒绝、启动自检、替换收紧）
---

- 起因：ch04 §4.3.3.6（D4-10）。线上实测 `MODEL_ACQUISITION_TASK_MODELS={"discovery.qualify_fit":"gemini-3.8-flash"}` 把 L2 深判钉在 flash 档，是「判定 45% 失败」的直接工程根因之一；judge 的模型身份必须有代码级护栏，而不是靠运维记得别写错 env。
- 改动：
  - 新增 `apps/api/src/ai-tasks/judge-model-routing.ts`（零依赖）：终判任务集合 `JUDGE_FINAL_VERDICT_TASK_IDS`（当前仅 `discovery.qualify_fit`）、pro 档白名单 `JUDGE_MODEL_ALLOWLIST`（deepseek-v4-pro / gemini-4-argon-high / gpt-5.6-sol）、`JUDGE_ALLOW_FLASH=true` 显式降档逃生口、`filterJudgeSubstitutes`（终判的模型身份替换只接受白名单目标，过滤为空即只收精确身份，fail closed）、`assertJudgeModelRouting`（启动自检）。
  - `task-registry.ts`：终判任务的非白名单 per-task override 被忽略、回落 tier 默认并留痕（`judgeModelOverrideRejections`，启动日志打印）；新增 `enforceJudgeModelRouting({mode})`。API（`main.ts`）与 worker（`temporal/worker.ts`）启动时调用：受控模式（pilot/production）下终判解析到白名单外模型即抛错不启动（fail-closed）；development/test 只告警（本地开发与 CI 契约导出/Nest 启动验证不因缺模型 env 而失败）。
  - `router-model-gateway.ts`：`acceptsModelSubstitute` 的部署级替换对终判任务先过 `filterJudgeSubstitutes`——`deepseek-v4-pro>deepseek-v4-flash` 这类同代理降档不再作用于最终 verdict；普通获客任务语义不变（D14 不变）。
- 测试：`judge-model-routing.spec.ts` 新增 12 例（集合/白名单快照、override 解析、替换过滤、自检四条路径）；`task-registry.spec.ts` 新增 3 例（flash override 被忽略并留痕、`JUDGE_ALLOW_FLASH=true` 放行、tier 本身是 flash 时自检失败）；`router-model-identity-substitution.spec.ts` 的替换主体改用非 judge 任务，并新增「judge 拒绝 flash 替换」与「仅 JUDGE_ALLOW_FLASH=true 放行」两例。
- 上线注意：发车后线上那条 `discovery.qualify_fit: gemini-3.8-flash` override 会被代码忽略并打 warn（深判回落到 reasoning tier）；运维应同步从运行 env 删除该键。若 reasoning tier 本身被配成 flash，进程会启动失败（刻意 fail-closed）。
- 未做：`discovery.quick_judge` / `discovery.qualify_fit` 双契约拆分与 `judge-output/v2` schema 换代（依赖技能目录与金标，和 J06 写入改造一起做）；`judgment_record.model_*` 三列落库（依赖 J04 建表 + J06 写入）。
