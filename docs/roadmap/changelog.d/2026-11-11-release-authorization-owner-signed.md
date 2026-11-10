---
date: 2026-11-11
title: Owner-signed release authorization replaces the unreachable external readback (PRD4-D12)
---

- 起因：PRD4-D12 死锁——`validateExternalProvenance` 对任何 `PILOT`/`GA` bundle 无条件阻断，而单账号仓库也无法产生真正独立的 GitHub review；2026-11-11 产品负责人拍板以 SSH 签名回执替代外部 readback，**不**移除 RuntimeEvidence / Release Bundle。
- 改动：
  - 新增 `scripts/release-authorization.mjs`：bundle 摘要（`external_provenance` 除外）、证据集摘要、回执绑定校验与 `ssh-keygen -Y verify` 离线验签（公钥 pin 在 `docs/governance/release-authority-keys.json`，支持吊销）。
  - 新增 `scripts/sign-release-authorization.mjs`：签名时通过 `gh` 回读必需 check-run 结论，生成并签名回执，随后自检；打印下一步（更新 bundle、重生成伴随 markdown、随 PR 提交回执与 `.sig`）。
  - `release-bundle.schema.json` v1 枚举增加 `OWNER_SIGNED` / `PRODUCT_OWNER_SSH_SIGNATURE` 并更新说明；新增 `docs/governance/release-authorization.schema.json` 与空的 `release-authority-keys.json` pin 清单。
  - `governance-delivery-contracts.mjs`：`OWNER_SIGNED` 走新校验；`EXTERNAL_UNVERIFIED` 仍阻断 `PILOT`/`GA`，自证 `VERIFIED` / 攻击者 URL 仍被拒绝；`governance-verify.mjs` 传入 repo root 供回执与钥匙文件解析。
  - 规则回写：`AGENTS.md` §7、`conflict-register` PRD4-D12=RESOLVED、`adr/registry.md`、`status/current.md`（G7 与死锁段）、`ci-merge-automation.md`「发布授权签名」、`governance/README.md`、`evidence/README.md`。
- 测试：新增 `scripts/release-authorization.spec.mjs`（11 例：有效签名放行、改 bundle、错钥、未知/吊销钥、过期、必需 context 缺失、证据集变化、审查回执篡改、自证仍被拒、摘要稳定性），由 `governance-contracts.spec.mjs` 引入 `pnpm governance:test`。
- 未做：未生成任何真实 `PILOT`/`GA` 回执（当前无此类 bundle）；未来独立外部 readback verifier 仍保留 `VERIFIED` / `INDEPENDENT_EXTERNAL_READBACK` 的拒绝路径，另立状态接入。
