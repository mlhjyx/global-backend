# 媒体生成候选 Capability Cards

> 文档 ID：`OSS-FE-004`
> 状态：`READY_FOR_GATE_7_REVIEW`
> 当前事实：M1-c 只有确定性 Sharp 图片管线；没有生成式图片/视频生产消费者

## `ADP-FE-012` MoneyPrinterTurbo

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 学习脚本→素材→语音→合成的流水线拆分；不把“一键视频”作为当前 Site/Growth 承诺 |
| 当前等价与证据 | Word 候选，main 未采用；MediaJob 尚未因真实消费者建立 |
| 主决策 | `LEARN / PIPELINE_DECOMPOSITION`；运行时 `DEFER` |
| License / 权利 | Phase 1 精确快照根许可证 MIT；模型、字体、音乐、图库、TTS、模板和输出权利各自独立 |
| Adapter / SoR | 仅学习 `MediaProvider` stage；未来输入/输出必须为我方 Asset/Variant/Job 引用，不写入其内部项目库 |
| Security / 数据 | 提示词/客户素材、下载 URL、命令执行、媒体解析、GPU/CPU 资源、第三方 API key、肖像/音乐/商标权 |
| Test / Release Gate | 固定素材权利 Fixture、确定性/可重放、超时/取消、资源上限、损坏媒体、watermark/metadata、成本和输出追踪 |
| Owner / Exit | `OWN-CONTENT-PRODUCT`；无运行时退出；重开后用 MediaProvider 逐 stage 替换 |

## `ADP-FE-013` ComfyUI

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选复杂图像/视频节点工作流；不允许任意节点、模型或用户工作流直接进入生产 |
| 当前等价与证据 | 未采用；ADR-020 指定模型路由目标但 MediaGateway/消费者未建 |
| 主决策 | `DEFER / GPL_NODE_MODEL_SUPPLY_CHAIN_GATE` |
| License / 权利 | 核心 GPL-3.0；custom nodes、模型权重、LoRA、素材和输出条款分别核验，根许可证不覆盖生态 |
| Adapter / SoR | 若重开，只允许签名/白名单 workflow behind `MediaProvider`；我方 MediaJob/AssetVariant 为真值 |
| Security / 数据 | 任意代码节点、模型反序列化、网络访问、GPU 隔离、队列 DoS、恶意 workflow、秘密和输出 provenance |
| Test / Release Gate | SBOM/allowlist、离线镜像、恶意节点/模型、资源/超时/取消、确定性、输出安全、升级和 GPL 义务评审 |
| Owner / Exit | `OWN-MEDIA-PLATFORM`；保存供应商无关 job/spec/asset，禁把 Comfy workflow 作为唯一可恢复格式；GPL/节点/模型评审为强制 Gate |

## `ADP-FE-014` Remotion

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选确定性 React 视频渲染；不把 source-available 等同免费企业商用 |
| 当前等价与证据 | 未采用；静态/确定性动效是 ADR-020 的视频 fallback |
| 主决策 | `DEFER / COMPANY_LICENSE_AND_PRODUCT_TRIGGER` |
| License / 权利 | 专用许可：个人、非营利及不超过 3 名员工的营利组织可免费；其他营利组织需要 Company License；衍生转售限制另核 |
| Adapter / SoR | 若重开，`VideoRendererPort(timelineSpec, assets) -> AssetVariant`；不得把 React composition 变成业务 SoR |
| Security / 数据 | Chromium/codec/字体/媒体供应链、无头浏览器 sandbox、云渲染数据区、资源成本、模板/音乐/素材权利 |
| Test / Release Gate | 法人/人数/用途书面确认与采购；帧/音画同步、确定性、字体、取消、容量、成本、浏览器升级和输出权利 Fixture |
| Owner / Exit | `OWN-MEDIA-PLATFORM`；timelineSpec/Asset 独立，替换 renderer 后可重渲；许可证失效立即 kill switch，商业许可另过强制 Gate |

## 组合决定

媒体不是当前 Site 可信开发预览的前置。先维持 Sharp 和静态/确定性降级；只有产品明确需要视频、MediaJob/AssetVariant/rights/成本/失败语义已成为正式 Contract 时，才重开三者比较。
