import { isServiceSkillHandlerId, type ServiceSkillHandlerId } from "./service-skill-catalog";
import { computeIncotermsQuote } from "./service-handlers/incoterms-quote";
import { runSanctionsScreen, type SanctionsScreenFn } from "./service-handlers/sanctions-screen";

/**
 * 服务型技能执行入口（skill-kind = service）：闭集分派，无模型、无工具。
 * 依赖由进程注入（制裁筛查需要内存索引服务）；缺失依赖时 fail-closed。
 */

export interface ServiceSkillDeps {
  readonly sanctionsScreen?: SanctionsScreenFn;
}

export class ServiceSkillUnavailableError extends Error {
  readonly code = "SERVICE_SKILL_HANDLER_UNAVAILABLE";

  constructor(detail: string) {
    super(`${"SERVICE_SKILL_HANDLER_UNAVAILABLE"}: ${detail}`);
    this.name = "ServiceSkillUnavailableError";
  }
}

export function executeServiceSkill(
  handlerId: string,
  input: unknown,
  deps: ServiceSkillDeps = {},
): unknown {
  if (!isServiceSkillHandlerId(handlerId)) {
    throw new ServiceSkillUnavailableError(`unknown handler: ${handlerId}`);
  }
  const known: ServiceSkillHandlerId = handlerId;
  switch (known) {
    case "sanctions.screen.v1": {
      if (!deps.sanctionsScreen) {
        throw new ServiceSkillUnavailableError("sanctions screening index is not wired");
      }
      return runSanctionsScreen(input, deps.sanctionsScreen);
    }
    case "quoting.incoterms.v1":
      return computeIncotermsQuote(input);
    default:
      // 目录新增 handler 而运行时未接线时必须显性失败，不能静默返回 undefined。
      throw new ServiceSkillUnavailableError(`handler is not wired into the runtime: ${String(known)}`);
  }
}
