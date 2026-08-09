# 供应链安全门

> 事实 Owner：`OWN-SECURITY`。本目录记录机器可读安全债务，不构成漏洞豁免、生产部署证明或 GitHub 安全功能已启用证明。

## 当前合同

- `production-dependency-audit-baseline.json` 固定 `origin/main@6b78901c2b4aee211e93ca11d5af13ea74398459` 的 `pnpm audit --prod` 结果与 canonical finding evidence：36 条 advisory，其中 high 18、moderate 14、low 4、critical 0。
- ratchet 允许 advisory 消失；PR 还会使用受信 base 的依赖图生成独立 audit，已经消失的 advisory 再次出现、同一 advisory 新增 vulnerable version/path 或风险元数据漂移都会失败。新增 advisory、严重度提高、critical、畸形/非 production-only 报告和过期 baseline 全部失败。
- PR 正常路径读取 base commit 中的 baseline 与 verifier，避免同一个 PR 放宽 policy 后自证通过。head 与 base 都以固定 pnpm、禁 lifecycle scripts、禁 `.pnpmfile.cjs` hooks 的方式物化依赖路径；缺路径证据直接失败。首次引入时只允许 candidate baseline 逐字绑定 PR exact base、base lockfile digest、advisory 集和 finding exposure；bootstrap PR 不得同时修改 manifest、lockfile、workspace、npmrc、pnpm hook 或 patch。合并后不再走 bootstrap。
- 扫描器固定使用 `https://registry.npmjs.org/`；安装与 audit 从环境 allowlist 启动，user/global npm config 固定到 `/dev/null`，仓库任意层级 `.npmrc` 在联网前 fail-closed。受信 base 的 `supply-chain-source-policy.mjs` 还会在 head 安装前拒绝 direct HTTPS/Git/tarball/file source、越界 workspace/link 和未经评审的 patch/config dependency，只允许官方 registry 版本与已跟踪 workspace 包；`supply-chain-audit.mjs` 即使脱离 workflow 单独执行，也会先重复执行同一依赖源准入。依赖 manifest、lock/workspace、npmrc、pnpm hook、source-policy 与 patch 同时进入 CODEOWNERS。未来若需要私有 registry 或其他 source，必须先引入独立的受信配置合同，不能在普通依赖 PR 中直接放行。
- 默认镜像、历史审计数字或 Dependency Review 都不作为 production audit ratchet 的等价证据。

本地验证：

```bash
node scripts/supply-chain-audit.mjs verify
node scripts/supply-chain-source-policy.mjs validate-sources --repository-root .
pnpm governance:verify
```

## Canary 边界

- `dependency review · canary` 只评估 PR 新引入的 runtime 依赖，moderate 及以上失败。
- `production dependency audit · canary` 对整个 production lock graph 执行遗留债务 ratchet。
- `CodeQL JavaScript/TypeScript · canary` 使用 `security-extended` 查询；本地只能验证 workflow 合同，真实扫描结果必须来自 exact-head GitHub Actions。
- 三个 context 都未写入 `.github/required-contexts.json`，本轮也不修改 live ruleset 或 GitHub Security 设置。观察到稳定的真实 canary 后，是否升级 required context 必须另行审查和授权。
- RED→GREEN checkpoint、验证矩阵和未证明边界见 [TDD 记录](../implementation-records/acq-supply-chain-gates-tdd.md)。

## 处置原则

Baseline 是限时治理账，不是 `allow-ghsas`。每条 advisory 都有 remediation stream、Owner、原因和不晚于 baseline 失效时间的 due date；到期仍未解决会失败。机器成功回执在仍有漏洞时只能写 `RATCHET_PASS_WITH_LEGACY_RISK`，仅零漏洞允许 `PASS_CLEAR`。需要调整 baseline 时必须作为安全决策审查；普通依赖 PR 不应把新漏洞追加为“遗留”。
