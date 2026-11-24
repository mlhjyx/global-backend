---
date: 2026-11-24
title: Parallelize CI build/test lanes, optimize buildcache, and standardize PR body template
---

- 起因：`CI / build · typecheck · test` 在单个 runner 内串行跑 14 个重型步骤（~6000 个 Vitest 单测 6m11s、每次从源码编译 MinIO 3m04s、15+ 个 PostgreSQL 语义门 ~4m），导致每个代码 PR 需等待 14m41s–15m31s；同时 `OCI runtime image · smokes` 在 PR 上执行不必要的 `--cache-to` 额外耗时 ~72s，且 PR 模板将产品负责人摘要放在文末、缺少从 changelog 片段生成标准中文 PR 正文的脚本。
- 改动：
  - 将 `.github/workflows/ci.yml` 中串行的 `build-test` 拆为 5 条并行泳道（`build-test-core` 构建/Lint/治理/attestation、`build-test-unit` Vitest 4 分片矩阵、`build-test-pg` Service PostgreSQL 语义与权限门、`build-test-pg-disposable` 一次性 PG 激活与池帽套件、`build-test-manufacturer` Manufacturer HTML+MinIO 契约），保留原必需检查名 `build · typecheck · test` 作为 5 秒 fail-closed 汇总门，主分支 ruleset 必需检查清单零变更。
  - 在 `apps/api/scripts/test-manufacturer-network-postgres.mts` 与 `build-test-manufacturer` 接入可选 GHCR BuildKit 缓存（`ghcr.io/<repo>-buildcache:manufacturer-minio`），保留任务级镜像标签归属校验与 MinIO 二进制版本断言；在 `build-test-oci` 对 PR 默认只读 `--cache-from`、仅在非 PR 或缓存缺失时写入 `--cache-to`。
  - 在 `.github/required-contexts.json` 与 `scripts/governance-ci-contracts.mjs` 引入受机审约束的 `allowed_internal_needs` 校验（强制内部并行泳道必须使用 `${{ !cancelled() }}`、禁止 `continue-on-error`、仅依赖必需检查），同步更新 `scripts/governance-ci-topology.spec.mjs` 与 `scripts/governance-contracts.spec.mjs`。
  - 调整 `.github/pull_request_template.md` 将「给产品负责人的说明」置顶，新增 `scripts/pr-body-from-changelog.mjs` 与 `scripts/pr-body-from-changelog.spec.mjs` 从 `changelog.d` 片段一键生成标准中文 PR 正文。
- 测试：`pnpm governance:verify`、`pnpm docs:verify`、`node scripts/governance-api-postgres-coverage.mjs verify`、`node scripts/check-file-budgets.mjs`、`node scripts/governance-changelog-fragments.mjs require --base origin/main --head HEAD` 全部通过；Vitest `manufacturer-minio-fixture.spec.mts` 通过；新 CI 并行泳道总时长将在本 PR 的真实 GitHub Actions Checks 上直接验证。
- 未做：不改 GitHub 分支保护 ruleset 的 8 个必需检查名称；不改 `Dockerfile` 分层结构（留待后续评估）。
