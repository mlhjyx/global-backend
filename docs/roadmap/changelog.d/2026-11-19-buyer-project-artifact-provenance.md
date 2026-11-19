---
date: 2026-11-19
pr: null
title: Restore verified project-page source metadata across artifact persistence
---

## 起因

独立测试的工厂直采运行已选出当轮获准的公司项目页，但项目证据始终为空。实际 ToolBroker 用持久化返回值替换抓取结果，ArtifactExecution 没有返回 WebsiteProfileProvider 所需的来源信息；原有 provider 测试直接模拟带来源信息的 broker，漏掉此边界。

## 改动

仅对 crawl4ai-fetch/v1，在首次持久化和重放时从已校验存档的正文、规范网址、摘要和 manifest.createdAt 重建可选来源信息。时间表示原始存档观察时间，重放不刷新；不信任调用者传入的来源，不以请求网址覆盖规范网址。既有精确HTML、当前运行来源准入、公司域名、隐私、预算与字节上限保持原有语义；无需数据库迁移。

## 测试

新增 WebsiteProfileProvider → 真实 ToolBroker → 真实 ArtifactExecution → 真实 materializer 的边界回归，先复现项目证据丢失，再验证首次与重放相同、重放不再物理抓取、薄页和降为主页的网址不产生项目证据、存档丢失不重新发起请求。补充不信任伪造来源和存档校验失败的回归。具体执行结果见此 PR 的必需检查与任务证据。

## 未做

不放宽判定或来源许可，不修改生产环境，不将已完成的旧运行改写成新结果。新鲜抓取增加一次受现有校验和大小约束的本机存档读取；真实买家效果须由独立测试环境后续运行核实。
