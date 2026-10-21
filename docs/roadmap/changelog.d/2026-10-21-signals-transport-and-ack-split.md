---
date: 2026-10-21
title: Let one site's dropped connection cost only that company's enricher, and acknowledge signal receipts so a retry never mixes old and new
---

- 起因：RL1 验收 run `c6b09756`（xin，2026-10-20）在信号阶段失败，根因复核找到三个缺陷，其中媒体类型那个由 #673 修，这里修另外两个。
  - 缺陷 A：第 1 次尝试中，price-pumpen.de 在 TLS 握手时重置连接。http.get 把 Node 的原始错误原样抛出，它带 host/port 等字段，分类器按失败关闭的规则判为控制错误。于是一家公司的一个站点让整个活动失败。
  - 缺陷 B：第 2 次尝试中，biergans 第 1 次的 4 条回执已经确认过；这次 robots 预检通过，多读了一页，多出 1 条新回执。同一家公司的确认批次变成「4 条重放 + 1 条新增」，抛出 `DOMAIN_ACK_MIXED_REPLAY_STATE`，run 判 FAILED。同一操作在一家公司里被读到两次（careers 页就是首页、两个 sitemap 列出同一子图）时，第 1 次尝试就会撞上同样的错误。
- 改动：
  - `guarded-http.ts`：Node 在已 pin 的 socket、TLS 会话或 HTTP 解析器上抛出的错误，按对象身份登记进一个 WeakSet，导出 `isPublicHttpTransportFailure`。错误对象本身不变，墙钟超时、各道闸门、出网拦截、体积超限都不登记，所以没有主动询问的调用方行为完全不变（分类器也没改）。
  - `enrichSignalsRun`：
    - 富集源抛出被登记的传输失败时，只跳过这家公司的这一个源，其余源照常运行，并计入新的返回字段 `transportFailed`（只在大于 0 时出现）。那次读取留在 RESERVED：下一个 run 换了操作键会再试；同一 run 若第 1 次尝试另因别的原因失败，第 2 次尝试会把这家记为不可重放（见「未做」）。仿冒同形字段的错误照旧失败关闭。
    - 回执按产生它的富集源分组，同一操作只记一次。有命中的源，用它自己的回执做一个批次，apply 只写它自己的命名空间，ACK 键带上命名空间名（`…:signal-enrichment:<源>`）；其余回执逐条单独确认，apply 为空操作，键格式不变。这样重试时，旧回执不会和新回执进同一个批次；一个源先前以未命中确认过的回执，命中后也能正常落库。
    - 命中先问一遍治理：`company-enrichment-commit.ts` 把逐条命中的治理抽成纯函数（`enrichmentHitSurvivesGovernance`，提交函数照用它，行为不变）。字段全被治理滤掉的命中按未命中处理，否则它的回执会以命中键确认、却不写 `_ts`，重试时这个源再跑一遍、多读一页就又是混合批次（复审发现，测试先红后绿）。
    - 公司查询加 `orderBy: { id: 'asc' }`，重试按同样顺序、同样的上限截断遇到同一批公司。
    - 更正 enrichSignalsRun 的注释：它不发 heartbeat（此前注释写「每家 heartbeat」）。
  - 没有改 workflow 和 run 状态判定：`transportFailed` 接进 stats 与 PARTIAL，以及信号阶段的逐家租约检查，由 #672 的作者在本 PR 合入后补上。
- 测试：
  - `guarded-http.spec.ts` 新增 5 例，全部在真实回环上跑：TLS 握手被重置、响应 socket 被挂断都被登记，且分类器对它的判定不变；墙钟超时不登记；四类闸门错误都不登记；仿冒的同形错误不登记。
  - 新增 `discovery.signals-retry.spec.ts`，9 例。它用真实的 ACK 绑定辅助函数，只把 Postgres 行存储换成内存实现，事务抛错时连同 ACK 行一起回滚。三例按 run `c6b09756` 的顺序复现缺陷 B，改前都抛 `DOMAIN_ACK_MIXED_REPLAY_STATE`：
    - 第 2 次多读一页的未命中公司；
    - 先前以未命中确认、这次命中的源；
    - 同一操作被读两次。
    另一例复现复审发现的「命中但字段全被滤掉、重试多读一页」，改前同样抛 MIXED。其余几例覆盖：公司顺序；单站断连只记一个源；仿冒错误仍失败关闭；没有断连时结果里没有 `transportFailed`。
  - `company-enrichment-commit.spec.ts` 新增 1 例：纯函数对可存、被扣下、未知字段三种命中的判断。
  - `discovery.activities.spec.ts` 里「无命中回执走批量确认」那条只保留 `enrichRun`；信号阶段的这条行为改由新 spec 用真实绑定覆盖。
- 未做：
  - 卖方入驻理解工作流 `persistOfferings` 的同类混合确认（claims 与 offerings 共用同一个 crawl ACK 键）另开 PR。
  - `profileWebsitesForRun` 把首页、Impressum 读取和模型调用放在一个批次里确认，部分重试时有同样的风险，另开 PR。
  - 同时运行两个执行的 MIXED 仍按失败关闭处理，没有放宽。
  - 「连续两家不可重放即停」规则在同一 run 的重试里可能误触发：被吸收的断连会把那次读取留在 RESERVED，第 2 次尝试里这家公司是不可重放的；两家这样的公司在已尝试的公司里相邻，就会让第 2 次尝试失败。前提是第 1 次尝试另因别的原因失败（改前每次断连都会让第 1 次尝试失败，所以这是收窄而不是新增）。根治要让 broker 的不可重放错误带上原因，并让规则只数本次尝试新出现的失败；fit、画像、信号共用这条规则，另开 PR。
