# google_patents 启用前置：许可核实与 LIA 草稿

> 生命周期：`DRAFT`
> 依据：产品负责人 2026-11-03 决定「先保持禁用」，并同意先做许可核实与 LIA 草稿；`data_provider.google_patents` 维持 `DISABLED`，`PATENT_SOURCE_MODE=off` 不变，本文件不改变任何运行时状态。

## 一、许可核实结论（2026-11-03）

**数据集**：引擎只查询 `patents-public-data.patents.publications`（Google Patents Public Data，IFI CLAIMS 谐调），见 `apps/api/src/adapters/bigquery-patents.ts`。

**官方声明原文**（Google Cloud 官方博客 "Google Patents Public Datasets: connecting public, paid, and private patent data" 的示例查询署名）：

> Source: “Google Patents Public Data” by IFI CLAIMS Patent Services and Google, CC BY 4.0, “Cooperative Patent Classification” by the EPO and USPTO, for public use.

- **许可**：CC BY 4.0（允许商用），署名义务成立。
- **署名格式以此为准**：`“Google Patents Public Data” by IFI CLAIMS Patent Services and Google, CC BY 4.0`；"for public use" 只属于同页的 CPC 数据，不适用于本数据集。
- 旁证：Google 在 Kaggle 的同名数据集页也标注 CC BY 4.0；官方示例仓 `google/patents-public-data` 的 LICENSE 是 Apache-2.0，**只覆盖仓内代码，不覆盖数据**（不要拿它当数据许可依据）。
- 结论：`docs/governance/provider-registry.json` 的 `CC-BY-4.0_UNCONFIRMED` 可以改为已核实；**这不等于可以启用**——启用的另外两道门（LIA/DPIA、平台执行契约）见下。

Sources:
- [Google Cloud Blog: Google Patents Public Datasets](https://cloud.google.com/blog/topics/public-datasets/google-patents-public-datasets-connecting-public-paid-and-private-patent-data)
- [Kaggle: Google Patents Public Data](https://www.kaggle.com/datasets/bigquery/patents)

## 二、LIA 草稿（Art. 6(1)(f) 合法利益，待产品负责人签署）

**处理活动**：从公开专利文献抽取发明人姓名，作为 B2B 决策人线索，写入本地缓存供客户发现流程使用。

| 要素 | 内容 |
| --- | --- |
| 控制者 / 处理者 | 产品负责人（控制者）；引擎与 SaaS 为同一控制者下的内部处理 |
| 数据主体 | 专利发明人（自然人） |
| 个人数据 | **仅姓名**（provider 契约明确不摄住址、国籍、联系方式；`inventorName` 列级加密 + 盲键） |
| 处理目的 | 为出海获客识别企业技术决策人；属控制者的合法商业利益，也是租户的获客利益 |
| 必要性 | 专利登记是识别技术负责人的公开且唯一系统化来源；不采集超出姓名的字段，不做跨源画像 |
| 利益权衡 | 姓名载于公开专利登记、职业语境；主体对姓名公开有合理预期；无自动化决策、无敏感类别、不用于监控；残余风险低—中 |
| 保障措施 | 只存姓名；`encryptPii` 列级加密 + 盲键检索；TTL ≤ 180 天到期清理；Art.17 擦除按盲键扫描删除；`data_provider` 状态门 + 用途门（SUSPENDED→DENIED）；平台运行需 Grant 与预算上限；对外触达仍逐次过 `lawful_basis` 门（D6 per-tenant 声明） |
| 署名义务 | 产品需在「数据来源」页/文档固定展示：`“Google Patents Public Data” by IFI CLAIMS Patent Services and Google, CC BY 4.0` |
| DPIA 判断 | 非大规模、非敏感类别、非系统性监控、无自动化决策 → 记录理由后以本 LIA 覆盖，不单独做 DPIA；如后续新增字段（住址/国籍/联系方式）须重评 |

**待签**：签署人（产品负责人）____ 日期 ____。签署后本文件转 `APPROVED`。

## 三、启用清单（签署后才可逐项执行，每步独立授权）

1. **签 LIA**（本文件转 `APPROVED`）。
2. 线路确认：先以 `PATENT_SOURCE_MODE=bigquery` 做一次受控大扫落 `patent_inventor_cache`（`maximumBytesBilled` 护栏，目标 ≤700GB/次），核对缓存行数与字段只有 `inventorName`；随后切 `PATENT_SOURCE_MODE=cache`（逐公司零 BQ 字节）。
3. `UPDATE data_provider SET status='ENABLED' WHERE key='google_patents'`（数据源门）。
4. **平台执行契约变更**（代码 PR + 新镜像）：`platform-execution-contract.ts` 的 patents 行从 `disabled_no_egress` 改为有界启用（物理线路上限、provider `requiredEnablement: ENABLED`、政策资产重生成），并出对应证据。
5. `patents-cache-refresh` schedule 取消 pause（此前即使恢复也会被 Grant 拒绝——契约先改）。
6. 受控验证 run（一次周更量级）+ RuntimeEvidence 记录；署名展示上线检查。

## 四、决策记录

- 2026-11-03：产品负责人决定**先保持禁用**（问题：许可复核与合法性基础是否已按「已复核」翻 ENABLED）。同步授权：先做许可核实与 LIA 草稿（本文件）。
- 同日协调会话口径确认：产品意向 ≠ 许可复核；本文件核实了许可，LIA 待签，故仍不启用。
