import { CapabilityRegistry } from './capability-registry';
import { verifyContextEnvelope } from './context-engine';
import { deepFreeze, immutableClone } from './immutable';
import type {
  ContextEnvelope,
  ContextSegment,
  ModelCapabilityProfile,
  ModelProtocol,
  ReasoningLevel,
  TaskModelContract,
} from './types';

export interface ModelExecutionPromptPlan {
  taskId: string;
  taskVersion: string;
  contextDigest: string;
  alias: string;
  protocol: ModelProtocol;
  reasoning: ReasoningLevel;
  segments: readonly ContextSegment[];
  providerOptions: {
    nativeCache: { enabled: boolean; mechanism?: string };
  };
}

interface CompilePromptInput<Input, Output> {
  contract: TaskModelContract<Input, Output>;
  context: ContextEnvelope;
  capability: ModelCapabilityProfile;
  reasoning: ReasoningLevel;
}

/** Compiles the provider-neutral task/context contract without protocol coercion. */
export class PromptCompiler {
  compile<Input, Output>(input: CompilePromptInput<Input, Output>): ModelExecutionPromptPlan {
    verifyContextEnvelope(input.context);
    if (input.context.policyVersion !== input.contract.contextPolicy.version) {
      throw new Error('prompt context policy does not match the task contract');
    }
    if (!input.contract.reasoningPolicy.allowed.includes(input.reasoning)) {
      throw new Error('prompt reasoning is not allowed by the task contract');
    }
    new CapabilityRegistry([input.capability]).negotiate(
      input.capability.alias,
      {
        ...input.contract.capabilityRequirements,
        reasoning: input.reasoning,
      },
    );
    const nativeCache = input.capability.nativeCache;
    return deepFreeze({
      taskId: input.contract.taskId,
      taskVersion: input.contract.version,
      contextDigest: input.context.digest,
      alias: input.capability.alias,
      protocol: input.capability.protocol,
      reasoning: input.reasoning,
      segments: immutableClone(input.context.segments),
      providerOptions: {
        nativeCache: nativeCache?.proven
          ? { enabled: true, mechanism: nativeCache.mechanism }
          : { enabled: false },
      },
    });
  }
}
