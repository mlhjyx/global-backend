---
date: 2026-11-12
title: Normalize registry_frame country input and classify parameter errors
---

- 起因：registry_frame 只接受特定国家写法，国家缺失、多值或无法解析时被当成「空结果」，无法区分用户输入错误与真实无数据。
- 改动：
  - `DiscoveryResult` 增加可选 `outcome`（`PARAM_INVALID` / `EMPTY_RESULT` + `reasonCode`，可带 `issues`）；严格回执 v1 不变。
  - registry_frame 把 `country` / `_countryCode` 归一化为 ISO2 后再查询；缺失/多值/不可解析返回 `PARAM_INVALID`（`COUNTRY_INVALID` / `COUNTRY_UNRESOLVED`），筛选词非法返回 `FILTERS_INVALID`，真实无数据仍是 `EMPTY_RESULT/NO_ROWS`。
- 测试：`registry-frame.provider.spec.ts` 12 tests passed；全量 13243 passed（首轮 4 个渲染器超时为本机负载假红，复跑全绿）；build 与 lint 通过。
- 未做：其他数据源未接入 `outcome`；下游消费者暂不读取该字段。
