---
date: 2026-11-02
title: Guard malformed tel links and name internal failures in the exception filter
---

- 起因：M4 会话在 ftc-de.com 的按需联系人发现中发现两处问题——`public_web` 适配器抛 `URIError: URI malformed`（页面含非法百分号序列的 `tel:` 链接，`decodeURIComponent` 未防护，导致整页抽取失败），以及全局异常过滤器对 500 只输出固定诊断、无法区分错误类别。
- 改动：`contact-extractor` 对 `tel:` 的解码加 try/catch（非法序列按原文处理，不再中断整页抽取）；全局异常过滤器在固定诊断上补充**受控的错误类名**（正则白名单，绝不输出 message/stack/凭据）。
- 测试：新增「坏 tel 链接不中断抽取」与过滤器 errorName 断言；相关 35 项与全量单测通过（仅已知负载假红，单跑复核绿）。
- 未做：不改变 500 响应的对外契约（仍是固定文案）；M4 报告的 500 是否同源待下次真实调用用 errorName 核实。
