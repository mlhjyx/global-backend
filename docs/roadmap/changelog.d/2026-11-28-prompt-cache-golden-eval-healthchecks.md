---
date: 2026-11-28
pr:
title: "优化 fit-v3 Prompt Caching 系统前缀、补齐 3 行业黄金评测集与 Worker 容器健康检查"
---

- 起因：单轮流式寻源需对 180 家候选重复调用 `fit-v3` 匹配模型，此前将整段 ICP 口径拼入每家企业的 user prompt 削弱了前缀缓存命中；同时黄金评测集 `queries.yaml` 仅标注泵类 1 个行业，`global-worker` 与 `global-platform-worker` 尚缺 Docker healthcheck。
- 改动：在 `apps/api/src/discovery/streaming/fit-v3.ts` 拆分 `buildFitV3SystemPrompt`（同次寻源逐字节一致，上移受信任评估口径与 ICP 画像）与 `buildFitV3UserPrompt`（仅承载不可信候选企业网页事实）；在 `docs/eval/golden-icp/queries.yaml` 基于现网真数据补齐光伏/储能（DE/NL/GB/BR）、奥地利泵类与德国工业电子 3 行业共 6 条已标注黄金查询；在 `infra/backend-runtime.compose.yml` 为 `worker` 与 `platform-worker` 补齐轻量 `/proc` 进程健康检查。
- 测试：通过 `fit-v3.spec.ts`、`golden-icp.spec.ts`、`evaluate-golden-icp.mts` 现网真库实测、全量 `nest build`、文件预算与全部仓库治理门禁。
- 未做：不改动受锁模型网关协议层与旧 `fit-v2` 契约哈希。
