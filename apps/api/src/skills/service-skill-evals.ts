import { runDeterministicEvals, type EvalRunResult } from "./evals/deterministic-executor";
import type { EvalManifest } from "./evals/eval-manifest";
import { executeServiceSkill, type ServiceSkillDeps } from "./service-skill-runtime";
import type { SkillManifest } from "./skill-manifest";

/** 服务型技能的确定性评测：逐用例执行 handler 并断言输出（零模型）。 */

export interface ServiceSkillEvalSubject {
  readonly manifest: SkillManifest;
  readonly evals?: EvalManifest;
}

export class ServiceSkillEvalUnavailableError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "ServiceSkillEvalUnavailableError";
  }
}

export async function runServiceSkillEvals(
  subject: ServiceSkillEvalSubject,
  deps: ServiceSkillDeps = {},
): Promise<EvalRunResult> {
  if (subject.manifest.platform.skillKind !== "service") {
    throw new ServiceSkillEvalUnavailableError(
      "SERVICE_SKILL_EVAL_NOT_APPLICABLE",
      "deterministic eval runs only for service-kind skills",
    );
  }
  const handlerId = subject.manifest.platform.serviceHandler;
  if (!handlerId) {
    throw new ServiceSkillEvalUnavailableError(
      "SERVICE_SKILL_EVAL_NOT_APPLICABLE",
      "service skill has no handler",
    );
  }
  if (!subject.evals) {
    throw new ServiceSkillEvalUnavailableError(
      "SERVICE_SKILL_EVAL_MANIFEST_MISSING",
      "service skill has no eval manifest",
    );
  }
  return runDeterministicEvals(subject.evals, (evalCase) => ({
    output: executeServiceSkill(handlerId, evalCase.input, deps),
  }));
}
