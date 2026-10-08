# 供应链安全门

> 生命周期：`CURRENT`
> 生命周期依据：供应链安全门的现行合同

> 事实 Owner：`OWN-SECURITY`。本目录记录机器可读安全债务，不构成漏洞豁免、生产部署证明或 GitHub 安全功能已启用证明。

## 当前合同

- `production-dependency-audit-baseline.json` 绑定 2026-10-08 legacy-javascript 钉版提交 `9e3dae0dd933e01c56e39a5eed72e3aede2421d0` 及其锁文件；对该精确干净提交执行 production audit 得到零条 advisory，因而基线同样记录零条 advisory/exposure。修复前 `04e1acc489838ff99b8300ee6cc93e794fd57564` 的 devalue 风险不被伪装为零，也不再用它绑定新快照。已修复的 10 条历史例外撤销；精确 bootstrap 集合与锁文件绑定仍由原 verifier 校验。
- ratchet 允许 advisory 消失；PR 还会使用受信 base 的依赖图生成独立 audit，已经消失的 advisory 再次出现、同一 advisory 新增 vulnerable version/path 或风险元数据漂移都会失败。新增 advisory、严重度提高、critical、畸形/非 production-only 报告和过期 baseline 全部失败。
- PR 正常路径读取 base commit 中的 baseline 与 verifier，避免同一个 PR 放宽 policy 后自证通过。head 与 base 都以固定 pnpm、禁 lifecycle scripts、禁 `.pnpmfile.cjs` hooks 的方式物化依赖路径；缺路径证据直接失败。首次引入时只允许 candidate baseline 逐字绑定 PR exact base、base lockfile digest、advisory 集和 finding exposure；bootstrap PR 不得同时修改 manifest、lockfile、workspace、npmrc、pnpm hook 或 patch。合并后不再走 bootstrap。
- 扫描器固定使用 `https://registry.npmjs.org/`；安装与 audit 从环境 allowlist 启动，user/global npm config 固定到 `/dev/null`，仓库任意层级 `.npmrc` 在联网前 fail-closed。受信 base 的 `supply-chain-source-policy.mjs` 还会在 head 安装前拒绝 direct HTTPS/Git/tarball/file source、越界 workspace/link 和未经评审的 patch/config dependency，只允许官方 registry 版本与已跟踪 workspace 包；`supply-chain-audit.mjs` 即使脱离 workflow 单独执行，也会先重复执行同一依赖源准入。依赖 manifest、lock/workspace、npmrc、pnpm hook、source-policy 与 patch 同时进入 CODEOWNERS。未来若需要私有 registry 或其他 source，必须先引入独立的受信配置合同，不能在普通依赖 PR 中直接放行。
- 已审安全下限由 `scripts/dependency-security-remediation.spec.mjs` 守住，经 `pnpm governance:verify` 进入 required 的 `governance · traceability · release`：`SECURITY_FLOORS` 所列包在锁文件里的每个已解析版本都不得低于下限（`from` 把下限限定在修复所在的版本线），已登记的漏洞前任必须落在下限之下；root `pnpm.overrides` 只能精确钉到正式版本（不得是范围、别名或 git/URL 来源）；`third-party-web` 的精确 override 由真实 pnpm deploy 回归验证；`@paulirish/trace_engine` 以 dist-tag 声明的依赖（`third-party-web`、`legacy-javascript`）都必须有精确 override，且等于锁文件中的唯一版本，trace_engine 一换版本就要先复核这份名单。例行升级与撤掉已被上游范围覆盖的 override 都不必改表，只有修复新 advisory 时才上调下限。
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

2026-09-19 重审的失效时间保持为 2026-10-03T13:46:50Z。历史 10 条准入记录仍保存在提交 `04e1acc489838ff99b8300ee6cc93e794fd57564` 的该文件版本中。重审移除旧例外，并配套兼容补丁 `devalue@5.9.2` 与 `third-party-web@0.29.2` 精确 override；后者防止 pnpm 9 deploy 重新解析上游 `latest` 而令镜像与锁文件漂移。ratchet 实现及 required contexts 均不变。测试分别验证清洁审计通过、devalue 拒绝、到期拒绝与真实 deploy 版本不漂移。

旧受信 base 已到期时，读取它的非必需 `production dependency delta · canary` 仍会失败；不能把候选的新基线当作该检查已通过。此纠正变更依靠独立审查、实际零漏洞候选审计、真实 deploy 回归及全部既有 required checks 验证；合入后使用新主线作受信 base，后续比较仍正常拒绝任何新漏洞。没有新增 advisory 例外，也没有停用检查。

本次锁文件重审的历史记录见 [changelog](../roadmap/changelog.md)，原始审计与前后回执见 [迁移基线证据](../evidence/security/20260920-baseline-refresh.json) 和 [工具链重审证据](../evidence/security/20260920-tooling-baseline-refresh.json)。

2026-09-30 续期：当日 main 的 freshness canary 报 `BASELINE_STALE`，原因是 9-28/29（UTC）官方 advisory 库新收录的 15 条生产 advisory——undici 8.10.0 共 11 条（经 astro→unifont，仅 site-renderer 链）、fast-uri 3.1.6 共 3 条（经 `@temporalio/worker` 的 webpack→ajv）、multer 2.3.0 共 1 条（经 `@nestjs/platform-express`）。处置是升级而不是追加例外：fast-uri、multer 的精确 override 升至 3.1.8 / 2.4.0，另加以漏洞区间为选择器的 `undici@>=8.0.0 <8.10.2` → 8.10.2：pnpm 只对声明范围与该区间相交的 undici 依赖生效（这里是 unifont 的 `^8.0.0`），AI SDK 的 `^7.29.0` 不受影响。它和其他安全 override 一样是精确钉版，`pnpm update` 不会再移动这份 undici；unifont 自身要求 ≥8.10.2 后应撤掉。修复提交重审为零 advisory 后重新绑定，失效时间由 2026-10-03T13:46:50Z 延至 2026-10-14T16:13:14Z；零例外策略、verifier 与 required contexts 均不变。审计与前后回执见[冻结证据](../evidence/security/20260930-advisory-remediation-baseline-renewal.json)。

2026-09-30 月度刷新：按[依赖刷新 runbook](../backend/dependency-refresh.md) 在声明范围内批量升级（`pnpm update -r '!sharp'`），Temporal SDK 全组锁步到 1.24.0，`sharp` 为确定性图片管线保持 0.35.4。`multer` override 撤除：`@nestjs/platform-express` 11.2.6 起自带同一版本 2.4.0，且是唯一消费者。undici、fast-uri 两条 override 的撤除条件尚未满足（unifont 最新 1.0.2 仍要求 `undici ^8.0.0`，ajv 8.20.0 仍要求 `fast-uri ^3.0.1`），保留。刷新提交重审为零 advisory（830 个依赖）后重新绑定，失效时间由 2026-10-14T16:13:14Z 延至 2026-10-14T21:28:22Z（仍按采集后约两周；上一次续期同在当天，所以实际只顺延数小时）；零例外策略、verifier 与 required contexts 均不变。审计与前后回执见[冻结证据](../evidence/security/20260930-monthly-dependency-refresh-baseline-renewal.json)。

2026-10-01 补记：9-30（UTC）新收录的 2 条 `@grpc/grpc-js` 生产 advisory（GHSA-m9gg-hp2v-232j 高危、GHSA-f596-whhp-79r4 低危，受影响 `>=1.14.0 <1.14.5`）在 #576 的审计（16:13Z，当时 npm 审计库尚未收录）之后才进入官方审计，#576 合入（22b1ca31）后 main 的 freshness canary 即报 `BASELINE_STALE`。上面的月度刷新已在上游范围内把它升到 1.14.5，合入后 canary 恢复 `FRESH`；安全下限表随之新增 `@grpc/grpc-js` ≥ 1.14.5 并登记前任 1.14.4。没有新增 override 或 advisory 例外，基线绑定不变。

2026-10-01 开发依赖告警刷新：nx 23.2.1 精确钉的 `axios 1.18.1` 与经其 `minimatch 10.2.5` 解析出的 brace-expansion 5.0.9 共有 15 条开发依赖 advisory（生产审计不含）。以 `axios@<1.20.0` → 1.20.0、`brace-expansion@>=4.0.0 <5.0.12` → 5.0.12 两条精确 override 修复，并上调对应安全下限、登记被替换的前任。生产审计仍为零，基线重新绑定到该提交，`valid_until` 不变；仅在 Prism mock 链上的 faker 5.5.3 继续开放。回执见[冻结证据](../evidence/security/20261001-dev-dependency-alert-refresh.json)。

2026-10-06 生产漏洞修复：10-01 重绑后官方审计库新收录 2 条生产 advisory（astro 链）。`http-cache-semantics`（GHSA-ch52-4w7c-c8xp，高危，`<=4.2.0`，未列修复版本）在 astro 自身的 `^4.2.0` 范围内升到 10-04 发布的 4.3.0，不加 override；需要说明的是，这不是实质修复——维护者判定上游报告不成立，4.3.0 的 max-stale 逻辑未改，它只是不在 advisory 现行范围内。本仓只在构建期远程图片缓存这条未启用的路径上用到它，没有多用户共享缓存，不构成暴露；若 advisory 范围扩到 4.3.0，须另作安全决策，不能直接追加为遗留。`smol-toml`（GHSA-r4xh-jqrq-34v2，中危，`<=1.8.0`）的精确 override 由 1.7.1 升到修复版 1.9.0。安全下限同步上调并登记前任。生产审计回到零 advisory，基线重新绑定到修复提交，`valid_until` 不变；零例外策略、verifier 与 required contexts 均不变。审计、检出记录与前后回执见[冻结证据](../evidence/security/20261006-production-advisory-remediation.json)。

2026-10-07 sharp 漏洞修复：GHSA-wq5f-xc86-pv6w（高危，`sharp <0.35.5`，10-06 13:43Z 发布）：sharp 预编译 libvips 自带的 librsvg 有释放后重用，解码 SVG 时在 glibc Linux 上可能导致远程代码执行。10-06 17:16Z 起 main 每次 push 的 freshness canary 都报 `BASELINE_STALE`。`apps/api` 的精确钉版由 0.35.4 升到修复版 0.35.5（librsvg 2.63.2、libvips 8.18.7）；astro 的可选依赖 `^0.35.4` 与 webpack 压缩插件的可选 peer 随之解析到同一个 0.35.5，没有加 override。修复前的暴露面：API 图片管线只把魔数为 JPEG/PNG/WebP 的字节交给 sharp，解码后再核对格式，且只在强制 `VIPS_BLOCK_UNTRUSTED=1` 的子进程里解码，该设置下 libvips 拒绝 SVG 输入（0.35.4 与 0.35.5 均实测）；渲染器不用 `astro:assets`。因此没有产品路径解码过 SVG，但有漏洞的二进制确实随运行镜像发布。安全下限新增 `sharp` ≥ 0.35.5 并登记前任 0.35.4。生产审计回到零 advisory，基线重新绑定到修复提交，`valid_until` 不变；零例外策略、verifier 与 required contexts 均不变。审计、检出记录与前后回执见[冻结证据](../evidence/security/20261007-sharp-advisory-remediation.json)。

2026-10-08 legacy-javascript 钉版：`@paulirish/trace_engine` 0.0.65（经 lighthouse）把 `third-party-web` 与 `legacy-javascript` 都声明为 dist-tag `latest`。前者早有精确 override，后者自 2025-03 起 latest 一直是 0.0.1，10-07/08 上游连发 0.0.2、0.0.3 后，镜像构建里全新缓存的 `pnpm deploy` 装进 0.0.3，而按锁文件生成的 SBOM 记的是 0.0.1，main（698b4518 起）的「Build and inspect immutable OCI runtime」因此失败。根 overrides 新增 `legacy-javascript` 0.0.1（锁文件只改 overrides 段）；新增防回归测试，要求 trace_engine 以 dist-tag 声明的依赖都由精确 override 钉在锁文件的唯一版本上。这不是漏洞修复：生产审计仍为零 advisory，基线只按锁文件变动重新绑定，`valid_until` 不变。审计、全新缓存 deploy 的前后对照与回执见[冻结证据](../evidence/security/20261008-legacy-javascript-dist-tag-pin.json)。
