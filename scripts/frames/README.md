# scripts/frames — registry frame 装载与召回审计（ch03 P2 v0）

> 生命周期：`GUIDE`
> 依据：GainOS v3.0 第 3 章（召回与枚举）第一波；实现与设计说明见
> `apps/api/src/registry/` 与 PR 描述。真实注册库接入（T3-04 起）、MinIO/Temporal（T3-03
> 完整版）、Splink（T3-16）、Tier A 人工裁决（T3-20）都不在本目录的 v0 范围内。

## 目录约定

- `frames/<frameKey>.json` — 帧定义 + 列映射（`registry-frame/v1`，`parseFrameConfig` 校验）。
- `fixtures/` — 装载与审计的样例输入（Companies House 风格 CSV、GLEIF 风格 JSON、召回审计
  的 frame/pool 导出），全部为虚构数据。
- `import-frame.mts` — CSV/JSON frame 装载 CLI（tsx 运行，owner 连接写平台表）。
- `recall-audit.mjs` — 召回审计 CLI（Node ≥22.18 原生 type-strip 直接运行，无需构建）。

## 装载

```bash
# 先离线核对映射（不连库、不出网）
pnpm exec tsx scripts/frames/import-frame.mts \
  --frame scripts/frames/frames/gb-companies-house.json \
  --file scripts/frames/fixtures/gb-companies-house.sample.csv \
  --dry-run

# 真正装载（DATABASE_URL 缺省时读 packages/db/.env 的 owner 连接；平台表 app_user 只读）
pnpm exec tsx scripts/frames/import-frame.mts \
  --frame scripts/frames/frames/gb-companies-house.json \
  --file scripts/frames/fixtures/gb-companies-house.sample.csv

# 装载后跑硬键 + 名称 trigram 链接提案（写 registry_entity_link，软键只落 PROPOSED）
pnpm exec tsx scripts/frames/import-frame.mts ... --propose-links
```

幂等：同一文件（sha256 相同）重导直接复用既有 PARSED 快照；实体按 `(scheme, reg_number)`
upsert；事件按 `(scheme, reg_number, snapshot_id, change_type)` 唯一键跳过。

## 召回审计

```bash
node scripts/frames/recall-audit.mjs \
  --frame scripts/frames/fixtures/recall-frame.sample.json \
  --pool  scripts/frames/fixtures/recall-pool.sample.json \
  --period 2026-11 --sample 384 --seed 2026-11 \
  --out /tmp/recall-audit
```

输出固定模板 Markdown + JSON（Wilson 95% CI）。口径：分母来自 frame（外部注册库），
「找到」按注册号键（scheme + regNumber）精确匹配；名称/域名模糊匹配与 miss 归因留给 T3-20。
