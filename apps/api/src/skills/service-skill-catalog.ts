/**
 * 服务型技能（skill-kind = service）的执行器目录（闭集）。
 *
 * 服务型技能没有模型调用与工具访问：由确定性 handler 在引擎进程内执行，输出过 schema
 * 校验并经快照审计。handler 实现随 S1-4 落地（sanctions / quoting）；此处先固定
 * id、风险级与人工门，manifest 校验以它为唯一真值。
 */

export interface ServiceSkillHandlerDefinition {
  readonly handlerId: string;
  readonly title: string;
  readonly risk: "low" | "medium" | "high";
  readonly humanGate: boolean;
  /** 输出契约名（文档用；具体 schema 由 handler 代码校验）。 */
  readonly outputSchemaRef: string;
}

export const SERVICE_SKILL_HANDLERS = Object.freeze({
  "sanctions.screen.v1": Object.freeze({
    handlerId: "sanctions.screen.v1",
    title: "制裁名单筛查（确定性）",
    risk: "low",
    humanGate: false,
    outputSchemaRef: "sanctions-screening/v1",
  }),
  "quoting.incoterms.v1": Object.freeze({
    handlerId: "quoting.incoterms.v1",
    title: "Incoterms 报价计算（确定性，L1）",
    risk: "medium",
    humanGate: true,
    outputSchemaRef: "incoterms-quote/v1",
  }),
} satisfies Record<string, ServiceSkillHandlerDefinition>);

export type ServiceSkillHandlerId = keyof typeof SERVICE_SKILL_HANDLERS;

export function isServiceSkillHandlerId(value: string): value is ServiceSkillHandlerId {
  return Object.hasOwn(SERVICE_SKILL_HANDLERS, value);
}
