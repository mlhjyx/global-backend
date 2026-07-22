# 部署与托管设计（草稿，待用户确认）

> 落实 [02-architecture.md](02-architecture.md) D10（海外部署）与 D7（预览域名）。2026-07-14 web 调研支撑。
> Reviewed against 12 v3.2（2026-07-16 回写：slug 覆盖 → 不可变 Release、加域名 ownership/tombstone/原子指针、R1-min 构建隔离）。承重决策见 **ADR-013**（不可变 Release：内容寻址、可回放、可回滚，异步失败绝不删除用户现有 Site）。
> **里程碑分层**：**M1 = 本地预览**（R1-safety 临时文件/子进程 env 与 Crawl4AI/robots 出站闸已完成；接着做 R1-min 本地原子指针，零域名依赖）；**M2 = 发布/域名**（不可变 Release 构建产物 + Caddy 边缘 + 自定义域 + 询盘）。素材/KB 对象当前已使用 MinIO，不能与尚未对象化的 Release artifact 混为一谈。本文 as-built 与 target 分栏，绝不把目标态写成已落地。

## 0. 全景（target 目标态）：一份产物，两条链路，三类域名

```
                       ┌─ 预览域 {slug}.preview.<平台域> ──→ 香港节点（国内用户看，免备案，CN2 线路 30-50ms）
构建产物（对象存储） ──┤
                       └─ 发布域 {slug}.sites.<平台域>
                          + 客户自定义域 ────────────────→ 海外边缘网关（海外买家看，全球分发）
```

同一份静态产物，按域名走不同线路——受众不同（国内工厂用户 vs 海外买家），链路分开设计。**此图是 M2 目标态**；平台域名未定前 M1 用本地路径预览起步（§0.5、§3）。

## 0.5 as-built 现状与 target 的分界（先分清）

| 主题 | as-built（2026-07-16，含 #125 truth-sync / #126 R0 contract） | target（本文设计，未落地） |
|---|---|---|
| 预览地址 | `PREVIEW_URL_PATTERN` env（`preview-url.ts` / `site-builder.activities.ts`），默认本地路径 `http://localhost:3000/preview/{slug}/`；仅 `ready`/`published` 站返回地址 | 平台域到手后改 env 为 `{slug}.preview.<平台域>`——**前端/后端零代码改动**（§3） |
| 版本模型 | `SiteVersion`（`version` 站内递增、`@@unique([siteId,version])`、`artifactKey?`、`buildRunId?`）+ `Site.activeVersionId` 指针字段均存在 | 升级为**不可变 `SiteRelease`**（§1.2）；`SiteVersion` 继续做构建版本，Release 做发布单元 |
| 构建落盘 | 直接构建到 `previewRoot()/site.slug`（`activities.ts` L259/L608），refurbish 在 finalize 前已覆盖当前可见目录（**R1-1**）→ 失败/取消构建破坏当前预览、`activeVersionId` 形同虚设 | **R1-min 构建隔离**：per-run staging → 硬门过 → 事务切指针 → 原子替换（§5） |
| 版本分配 | `max(version)+1` 无 advisory lock（**R1-3**），并发/活动重试可 P2002 | 同事务 advisory lock + CAS（§5 规则 7） |
| Release / 产物快照 | **无** `SiteRelease` / `ReleaseManifest` / `AssetVariant` 模型 | §1.2 / §1.3 定义，M2（部分随 R1-min） |
| 对象存储 / Caddy / CDN | 素材与供 KB 消化的上传对象已走 MinIO/S3 `StorageService`；renderer 构建产物仍以 `local:` 路径落本机。Caddy/CDN/Release artifact 对象化均未落地 | 构建/发布产物按不可变 Release prefix 进入对象存储；Caddy/CDN 见 §1、§4（M2） |
| 多语言 | `[...slug].astro` 只渲染默认 locale（M0），多语言站点无法完整验证 | 多语种路径随 M1 copy agent 落，发布前完整验证 |

**结论**：M0/M1-a 的"版本化 + 指针"骨架在 schema 层已预埋，但**原子性尚未真正成立**（R1-1/R1-3），构建仍直写可见目录。`finally` 清理、renderer env allowlist 与 Crawl4AI/robots 完整出站闸已由 **R1-safety** 完成；R1-min 余项最迟在 M1-e 真实构建接入前完成（§10）。

## 1. 发布托管（D10 落细，M2）

### 1.1 架构与网关

- **架构**：对象存储 → **Caddy 边缘网关**（海外 VPS/容器，起步 1~2 节点）→ 流量起来后可选前置全球 CDN。产物按**不可变 Release 前缀**存放（§1.2），**禁止再按 slug 覆盖历史目录**（v3.2 §1.6 回写）。
- **为什么 Caddy**：`on-demand TLS`——客户自定义域名**首次被访问时自动向 Let's Encrypt 签证书**、此后缓存续期，零预配置、零证书数量上限、零证书成本；社区有千级域名规模的生产验证。对比：Cloudflare SSL for SaaS 是企业版功能（每月数千美元档）——多租户自定义域+自动 HTTPS 这个能力上，自托管 Caddy 是压倒性性价比。

### 1.2 SiteRelease 与不可变前缀（v3.2 §7.1 回写）

发布单元 = **不可变 `SiteRelease`**（ADR-013：内容寻址、可回放、可回滚）。`SiteRelease` 至少含：`site` / `version` / `releaseNumber` / `status` / `manifest` / `artifactPrefix` / `artifactDigest` / `buildRunId` / `createdBy` / `publishedAt`。

- **对象前缀固定** `sites/{siteId}/releases/{releaseId}/…`——每次发布写**新前缀**，历史 Release 不被覆盖，回滚只切指针（§1.4）。
- 私有桶，只经网关签名回源（§7）。

### 1.3 ReleaseManifest 快照（7 组，v3.2 §7.1 回写）

每个 Release 冻结一份 `ReleaseManifest`，供回放/审计/回滚，内容与 `artifactDigest` 绑定：

1. `SiteSpec` + 各 locale `CopyBundle` hash + `ClaimSnapshot` + `CatalogSnapshot`。
2. Asset / Variant hash + 权利与来源。
3. Industry / Market / Growth Pack + DesignCatalog + Family + `variationSeed`。
4. component / renderer 版本 + prompt / schema / route policy / model snapshot。
5. QA / SEO / Aesthetic / Safety / PublishReview 报告。
6. artifact 文件清单与 digest。
7. DecisionTrace 引用与 hash（§8，解释文本不塞进 SiteSpec）。

### 1.4 原子发布与回滚

- **原子发布**：产物写新 Release 前缀 → 生成 immutable manifest + digest → 数据库事务切站点指针（`previewReleaseId` / `publishedReleaseId`）并同写 Outbox → 网关按 Host 查指针回源（完整 5 步与失败语义见 §5）。
- **回滚 = 切完整 Release**（改指针，秒级），**不是**只切 SiteSpec JSON——避免只回内容而遗留旧 artifact/manifest 不一致（v3.2 §7.2 回写）。
- **失败/取消/未过硬门的构建都不改变当前指针**；异步终态失败绝不删除用户现有 Site（ADR-013）。

## 2. 客户自定义域绑定流程（M2；给 SaaS 前端的交互契约）

1. 用户在工作台填域名 → 后端生成**随机 ownership token**，返回 CNAME 记录指引（指向 `edge.<平台域>`）+ 待验证的 **TXT/CNAME ownership** 记录（v3.2 §7.3 回写：防任意域名蹭绑）。
2. 后端轮询 DNS 验证 ownership token 生效 → 域名写入**已授权列表**（active）。**绑定、续期、所有权迁移时均复验 ownership**，不只验一次。
3. Caddy `ask` 端点校验"该域名 ∈ 授权列表且 verified+active"才允许签证书——**防任意域名指过来蹭证书/钓鱼挂靠**；证书签发有**速率限制、重试、告警与失败状态**（不静默重试打爆 ACME 配额）。
4. 首次访问自动签发（一次性 3~5 秒）→ 绑定完成事件；MapLocation 为无外呼地址文本卡，不配置第三方地图 key 或域名白名单（04 §10 D16）。
5. **删除/解绑防护**（v3.2 §7.3 回写）：删除域名后打 **tombstone + cooldown**，防 dangling CNAME takeover（他人抢注已解绑域名指回本平台蹭证书/内容）；**站点删除先撤路由、再清产物**，不留悬挂路由。

## 3. 预览链路（M1 起步本地路径，平台域后升子域）

- **M1 as-built**：本地预览服务 + 路径式地址 `PREVIEW_URL_PATTERN`（默认 `http://localhost:3000/preview/{slug}/`），仅 `ready`/`published` 站返回。平台域到手后**改 env 为 `{slug}.preview.<平台域>` 即切子域，前端无需改代码**（§0.5）。
- **免备案原理**（M2/子域态）：节点在境外即不触发 ICP 备案要求；选**香港节点 + CN2 GIA/三网直连线路**，到北上广深延迟 30~50ms，晚高峰可控。
- v1 预览流量小：单台香港 VPS + Caddy 泛证书即可承载，**不必上 CDN**；量大再评估免备案 CDN 服务商。
- **预览安全**（v3.2 §7.3 回写）：Preview slug **随机不可枚举** + 强制 `noindex,nofollow`；高风险 workspace 可加**短时签名 token**。**Preview 与 Publish 使用同一 artifact，禁止二次构建导致结果漂移**——预览过什么就发布什么。

## 4. 域名与证书体系（M2）

| 域 | 解析 | 证书 |
|---|---|---|
| `*.preview.<平台域>` | 泛解析 → 香港节点 | Let's Encrypt 泛证书（DNS-01，DNS 商 API 自动续期） |
| `*.sites.<平台域>` | 泛解析 → 海外网关 | 同上泛证书 |
| 客户自定义域 | 客户 CNAME → `edge.<平台域>` | Caddy on-demand（HTTP-01，逐域自动） |

平台域名待用户定（开放问题 #1）；DNS 建议托管在有 API 的服务商（DNS-01 自动化需要）。

## 5. 部署流水线与构建隔离

### 5.1 R1-min：构建隔离与原子预览（→ M1，最迟 M1-e 真实构建前）

当前构建直写可见目录（§0.5 R1-1），指针式发布/回滚的**前提**是先做构建隔离。目标目录形态（v3.2 §24.4 回写）：

```
previewRoot/{slug}/versions/{siteVersionId}/
previewRoot/{slug}/current.json
```

8 条规则：

1. Astro **只构建到 run/version 独立 staging 目录**，不把 slug 目录当正在构建的 outDir。
2. 构建成功、质量通过且 run 仍 publishable 后，数据库**同事务**切 `activeVersionId`。
3. 数据库提交成功后，用**原子 rename / current.json 临时文件替换**更新本地预览指针。
4. 预览服务按 active version / current manifest 读取。
5. **失败或取消只清本 run 的 staging，绝不触碰当前 active artifact**（失败构建不破坏可见预览）。
6. `SiteVersion.artifactKey` 指向**不可变**版本目录。
7. `allocateNextSiteVersion` 在同一事务先取 `site-version-{siteId}` advisory lock 再读 max+1（修 R1-3）；加 `buildRunId` 索引，若保持"一 run 一版本"则加唯一约束（`SiteVersion` 已有 `@@unique([siteId,version])`）。
8. 临时 spec / staging 清理放 `finally`；构建子进程 env 改**明确 allowlist**，只传 Renderer 必需变量（修 R1-2：子进程继承整个 `process.env` 会拿到无关密钥）。渲染器对未知组件 **fail-closed**（`Section.astro` 静默 null → 显式拒绝/告警，见 ADR-015）。

### 5.2 原子发布 5 步 + 失败语义（→ M2，v3.2 §7.2 回写）

1. 在**新 Release prefix** 构建（`sites/{siteId}/releases/{releaseId}/…`）。
2. **完整性、安全、性能、noindex/robots** 扫描（质量硬门，L0-L3 见 06/§8.1）。
3. 生成 **immutable manifest 与 digest**（§1.3）。
4. 数据库事务切 `previewReleaseId` 或 `publishedReleaseId`，**同时写 Outbox**（发 `SiteDemoReady` / `SitePublished` 域事件）。
5. CDN 按版本 URL 自然失效或精确 purge。

**失败语义**：失败、取消、未过硬门的构建**都不改变当前指针**；回滚切完整 Release（§1.4）。

## 6. 监控与运维

- 拨测：预览/发布各一组探针（可用性 + TLS 有效期）。
- 证书：Caddy 自动续期 + 到期 15 天兜底告警；平台泛证书续期失败告警；on-demand 签发失败进入**失败状态**并告警（§2.3）。
- 域名：客户自定义域到期提醒（whois，提前 30 天通知用户——域名过期是客户站消失的第一大原因）。
- 存储生命周期：非活跃 Release 产物保留最近 N 版 + 30 天后清理（02 §11.9）；被任一指针（preview/published）引用的 Release **不清**。
- 运行期复扫（Claim 过期/素材投诉/恶意域名/安全策略变化）触发维护任务，高风险可把指针切到 `taken_down` 页并保存审计/通知/申诉（详见 06）。

## 7. 安全基线

- 对象存储私有桶，只经网关签名回源；网关限速防刷。
- 发布站默认安全头：CSP（自站资源）、HSTS、X-Content-Type-Options、Referrer-Policy；**外呼域与第三方资源以 Release 扫描结果为准**（v3.2 §7.3 回写），不硬编码。MapLocation 不增加第三方地图白名单。
- Caddy `ask` 端点 + 授权列表（§2.3）杜绝非客户域名蹭挂；tombstone/cooldown 防解绑后 takeover（§2.5）。
- Preview/Publish 同一 artifact，杜绝二次构建漂移（§3）。
- AI 媒体真实性与披露按 `syntheticClass` / `disclosureMode` 分类处理（v3.2 §29.4，详见 06）——发布扫描据此决定机器标记/可见披露/阻断，不一刀切。
- 生产禁止设置 `CRAWL4AI_ALLOW_INTERNAL_URLS=true`。现有 as-built 已在 API 与 Crawl4AI 两层执行 global-unicast 校验、连接 pinning、redirect 逐跳重验、超时和响应大小上限；Ubuntu fake-IP 只在答案全部属于 `198.18.0.0/15` 时走固定 DoH 窄回退，混合/private/metadata 答案 fail-closed。

## 8. Release 可解释性 DecisionTrace（M2，v3.2 §9.2 回写）

每个公开块应能回答：**为什么选该结构、用了哪些 Claim/Offering/Asset、哪个 Prompt/Schema/Route 生成、通过哪些规则、谁编辑或锁定**。

- 解释文本**不塞进 SiteSpec**（SiteSpec 是渲染契约，见 ADR-014）；由 `ReleaseManifest` 保存 DecisionTrace 的**引用与 hash**（§1.3 第 7 组）。
- 服务于合规审计、投诉恢复与 PublishReview 复核——发布后可追溯"这一块凭什么这么写"。

## 9. 成本估算（平台级固定成本，M2）

香港 VPS（CN2 线路）≈ $10-30/月 + 海外网关 VPS ×1-2 ≈ $10-40/月 + 对象存储按量（静态站极小）+ 证书 $0 ——**起步 < $100/月，与站点数量弱相关**；单客户边际成本 ≈ 存储几十 MB + 忽略不计的带宽。M1 本地预览期近乎零外部成本。

## 10. 里程碑门与施工顺序（v3.2 §0.3 / §1.5 / §26 回写）

**裁决（v3.2 §1.5）**：原子指针/幂等是**单用户正确性**问题——必须做；原子多 worker 预算治理、全量 shadow/canary 是**规模**问题——可后置到付费候选进生产前。即"原子发布/多 worker 预算都是规模问题"被**部分否决**：指针原子性不后置。

| 门 | 内容 | 时点 |
|---|---|---|
| **R1-safety**（✅ 2026-07-17） | 两个小 PR 已完成：① 临时 spec 的 `finally` 清理 + renderer 子进程 env allowlist（§5.1 规则 8）；② API/Crawl4AI/robots 完整 egress gate、fake-IP 窄回退、连接 pinning 与公网/内网真机矩阵 | 已解除 R2-A 前置；不与原子 Release 全套捆绑，R1-min 余项仍单列 |
| **R1-min 余项**（→ M1） | per-run staging、不可变 artifact、active pointer 原子切换、版本 CAS/advisory lock、unknown component fail-closed（§5.1 规则 1–7/8 后半） | R1-safety 后可与 M1-c 算法并行，**必须早于 M1-e 可见预览 / 公开发布** |
| **M2-PUBLISH**（→ M2） | 不可变 Release manifest（§1.2/§1.3）、原子发布/回滚（§1.4/§5.2）、域名 ownership + tombstone（§2）、安全头（§7）、最小询盘 + consent + anti-abuse + Outbox、AI 媒体按 §29.4 分类披露 | **公开发布前**；依赖 R1-min + PublishReview + 质量门（06/08） |

**完整发布域名治理在 M2 公开发布前完成**；多 worker 高级预算治理与全 canary 自动化在付费 targetCandidate 进入生产前完成（不阻断 M1/首发）。M2-PUBLISH 依赖 R1-safety + R1-min 余项；与 MF-1/MODEL-2 一样，开工需以当时 main 证据为准，不以"v3.2 已写"替代。

## 11. 开放问题 / 待拍板

1. **平台域名**（等用户定，D7/本文件全部域名体系挂在它下面；未定前 M1 用 `PREVIEW_URL_PATTERN` 本地路径起步）。
2. 香港/海外 VPS 具体服务商——实施期按线路实测选（CN2 GIA 质量差异大，以实测为准）。
3. 发布链路前置 CDN 的引入时机——建议按流量阈值触发，v1 不上（KISS）。
4. `SiteRelease` 与现有 `SiteVersion` 的落库分工（Release 做发布单元 / Version 做构建版本）——在 R1-min → M2-PUBLISH 之间随 schema PR 定稿，需独立迁移与 ADR 记录。
