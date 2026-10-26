---
date: 2026-10-27
pr: 677
title: Pin the revocation TLS fixture CA file mode
---

- 起因：新开发机 xin 的进程 umask 为 002，测试夹具用 `openssl` 现场生成的 CA 证书因此是 0664（组可写）；平台撤销信任运行时对信任锚文件做严格的属主/权限/不可变校验（拒绝组或其他可写文件），快照构造失败后 `platform-revocation-http*` 的 7 个 real-HTTPS 用例全部以 `PLATFORM_REVOCATION_UNAVAILABLE` 失败。CI（umask 022 → 0644）与当年以 root 运行的旧会话掩盖了这个环境依赖。
- 改动：`apps/api/src/platform-authority/platform-revocation-http.test-fixture.ts` 在生成证书后显式 `chmodSync(certificate, 0o644)`，不再继承环境 umask；产品代码与运行时的信任锚校验均不变。
- 测试：本机（umask 002）该组 4 个文件 33 个用例全部通过（修复前 7 个失败）；CI `build · typecheck · test` 通过。
- 未做：另两处 openssl 测试夹具（`machine-token-client`、`platform-capability-https`）在同一 umask 下本已通过，本次未改动。
