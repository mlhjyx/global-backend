import type { currentDiscoveryV3OperationScope } from "../durable-results/discovery-v3-operation-scope";
import type { DiscoveryV3ArtifactExecutionPort } from "./discovery-v3-artifact-execution-port";
import { executeDiscoveryV3Tool } from "./discovery-v3-tool";
import type { GenericOperationProjection } from "./generic-operation-projection";
import type { Tool, ToolContext, ToolResult } from "./tool-contract";
import { ToolPolicyDenied } from "./tool-policy-denied";

type ReleaseLimit = () => void | Promise<void>;

export function assertNoCallerDiscoveryV3WireFence(toolId: string, context: ToolContext): void {
  if (context.dispatchDiscoveryV3Wire || context.checkDiscoveryV3Robots) {
    throw new ToolPolicyDenied(toolId, "DISCOVERY_V3_CALLER_FENCE_DENIED");
  }
}

export async function invokeDiscoveryV3Tool<I, O>(input: {
  scope: NonNullable<ReturnType<typeof currentDiscoveryV3OperationScope>>;
  context: ToolContext;
  tool: Tool<I, O>;
  request: I;
  artifactSchema: string | null;
  artifactExecution?: DiscoveryV3ArtifactExecutionPort;
  acquireLimit: () => Promise<ReleaseLimit>;
  releaseLimit: (release: ReleaseLimit) => Promise<void>;
  authorizeSource: () => Promise<void>;
  project: (result: ToolResult<O>) => GenericOperationProjection;
  restore: (result: GenericOperationProjection) => ToolResult<O> | null;
}): Promise<ToolResult<O>> {
  const { context, tool, request, artifactSchema, artifactExecution } = input;
  const timeoutMs = tool.discoveryV3SingleWireTimeoutMs;
  const artifact = artifactSchema && context.artifactSubject && artifactExecution
    ? { port: artifactExecution, subjectRef: context.artifactSubject, schema: artifactSchema }
    : undefined;
  const nonArtifactAllowed = () => (!tool.compliance.personalData || tool.discoveryV3CompanyOnly?.(request) === true) &&
    tool.durableResultStrategy.kind === "typed_projection";
  if (context.paidCost || context.platformEgress || (!artifact && !nonArtifactAllowed()) ||
    !timeoutMs || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ToolPolicyDenied(tool.id, "DISCOVERY_V3_TOOL_NOT_READY");
  }
  const release = await input.acquireLimit();
  try {
    return await executeDiscoveryV3Tool({
      scope: input.scope, context, tool, request, timeoutMs, artifact,
      authorizeSource: input.authorizeSource,
      authorizeSubject: artifact ? async () => {
        const admission = await artifact.port.admit({
          workspaceId: context.workspaceId, resultSchema: artifact.schema, subjectRef: artifact.subjectRef,
        });
        if (admission.status !== "BOUND") {
          throw new ToolPolicyDenied(tool.id, `GENERIC_OPERATION_ARTIFACT_${admission.reason}`);
        }
      } : undefined,
      project: input.project,
      restore: input.restore,
    });
  } finally {
    await input.releaseLimit(release);
  }
}
