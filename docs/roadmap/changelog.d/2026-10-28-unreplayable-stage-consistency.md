---
date: 2026-10-28
pr:
title: Count an unreplayable company in every best-effort pass instead of failing the run
---

- 起因：2026-10-27 16:04–17:07 上游断流留下 19 笔「已扣费、无持久结果」的调用（约 $0.42）；run `659f2320` 的活动重试时，画像阶段**相邻两家公司**各撞上一个历史操作键，触发 #641 的「连续两次不可重放 = 判 run 失败」规则，整条 run 判死。这条规则的前提（时间相邻 ≈ 上游现在在故障）在重试场景不成立：重试会把**历史**操作键按公司顺序重新遇到，相邻性是重试顺序，不是故障时序。
- 改动：画像（`profileWebsitesForRun`）、信号（`enrichSignalsRun`）、监控注册（`registerWatchesForRun`）三个尽力而为的阶段与 fit 对齐——`BudgetOperationReplayError` 一律「跳过这家、计入 `unreplayable`」，不再因为前一家也被跳过而升级为控制错误。fit 阶段早在 D13 修正时就是这个语义（其注释写明「不可重放与上游无关，既不启动也不延续两连规则」）。画像阶段的跨活动 `previousUnreplayable` 交接（活动入参、返回值、workflow 续做参数）一并移除——它只服务于这条规则。查询阶段的两连规则保持不变：那里的回执缺失本来就该让 run 失败（物化准入要求每条查询都有回执）。
- 测试：`discovery.activities.spec.ts` 三个「连续两家不可重放就停」用例改为「连续两家都被跳过并计数、其余照常」；画像交接与非法标志两个用例替换为「续做只带 startIndex」；`workspace-authority.workflow.spec.ts` 的交接断言改为断言不再传递该标志。两个 spec 374 例全绿。
- 未做：drain 探针容错是同日另一个 PR（#683）的内容；预算操作的重放语义本身（D13，PR #597）仍未动。
