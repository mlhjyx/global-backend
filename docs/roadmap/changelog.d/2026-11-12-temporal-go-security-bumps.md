---
date: 2026-11-12
title: Bump Go security dependencies in the native Temporal reader server
---

- 起因：Dependabot 对 `infra/temporal-platform/server` 报出 2 个 high：`github.com/go-jose/go-jose/v4` 4.1.4（修复 4.1.6）、`github.com/klauspost/compress` 1.18.0（修复 1.18.7）；两个 Dependabot PR（#1021/#1022）缺 changelog 片段而无法合入。
- 改动：在同一个 PR 中把两个间接依赖升到修复版本，`go mod tidy` 更新 `go.mod` / `go.sum`；关闭被取代的 #1021/#1022。
- 测试：`go mod tidy` 成功；`go test ./readerpolicy` 通过。`cmd/server` 的两个 trust 测试在本机与 main 上同样失败（既有本地环境差异），以 CI 的 Docker Go race 步骤为准；CI 同时构建 OCI。
- 未做：不重建运行中的原生 Temporal 镜像（下一次发版列车按 RUNBOOK §2 重钉 digest）；不升级其它 Go 依赖。
