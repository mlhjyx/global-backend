---
date: 2026-11-09
title: Add threshold and freshness alert evaluation for gain metrics (ch01 PR-05)
---

- 起因：ch01 PR-05（看板告警）要求对度量结果做阈值与新鲜度告警；看板/渠道接线是后续切片，本 PR 交付纯引擎评估与规则文件。
- 改动：
  - 新增 `docs/metrics/alerts/rules.v1.json`（`measurement-alerts/v1`，4 条首发规则：T1-008 public_web 7 日均接受率 <50% 为 CRITICAL、T2-001 全员邮箱覆盖率 7 日均 <10% 为 WARNING、T0-001 观测新鲜度 36h、T2-001 周桶新鲜度 192h）与 `docs/metrics/alerts.md`（字段、评估语义、CLI、退出码、首发阈值依据）。
  - 新增纯评估器 `apps/api/src/measurement/alerts.ts`：阈值规则（below/above 严格比较、latest/mean 聚合、lookback 按已观测桶、minSample、stratumEquals、每桶取最高 metric_version）与新鲜度规则（observation window_end / rollup 桶结束时刻），输出 OK/FIRING/NO_DATA/INSUFFICIENT_DATA 与退出码汇总；缺失数据不会被折叠成绿色。
  - 新增 `apps/api/scripts/measurement-alerts.mts`：owner 连接只读 SELECT，`--json/--as-of/--rules`，退出码 0/10/20/1，不发通知不落库。
  - `scripts/metrics/metrics-lint.mjs` 接入规则校验（schema、id 唯一、指标存在性、kind 专属字段词表），规则文件与字典同门禁；`alerts.spec.ts` 覆盖评估语义并断言 checked-in 规则引用的指标都在字典。
- 测试：`node --test scripts/metrics/metrics-lint.test.mjs`（14 例）、`vitest run src/measurement`（34 例）本地全过；`measurement-alerts.mts --json` 对 dev 库只读试跑输出 NO_DATA（尚无 rollup 数据）。
- 未做：告警持久化、通知渠道（邮件/IM/站内信）、看板 UI 与 SaaS BFF 代理（后续切片/运维接线）；未发车、未部署。
