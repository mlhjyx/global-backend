import { types as nodeUtilTypes } from "node:util";
import type { Prisma } from "@prisma/client";
import { isCanonicalArtifactUuid } from "./artifact.types";
import {
  GenericOperationArtifactSubjectRepository,
  parseGenericOperationArtifactSubjectRef,
  type GenericOperationArtifactSubjectRef,
  type ResolvedGenericOperationArtifactSubject,
} from "./generic-operation-artifact-subject.repository";

export type SubjectBoundArtifactSchema =
  | "sanctions-download/v1"
  | "http-get/v1"
  | "crawl4ai-fetch/v1"
  | "crawl4ai-render/v1";

export type ArtifactSubjectBindingDecision =
  | Readonly<{
      status: "SUBJECT_BINDING_HOLD";
      reason: "PLATFORM_SUBJECT_UNAVAILABLE" | "CANONICAL_SUBJECT_UNAVAILABLE";
    }>
  | Readonly<{
      status: "DENIED";
      reason: "SUBJECT_BINDING_INVALID";
    }>
  | Readonly<{
      status: "BOUND";
      subjectRef: GenericOperationArtifactSubjectRef;
    }>;

type SubjectResolver = Pick<
  GenericOperationArtifactSubjectRepository,
  "resolveExistingSubject"
>;

const WORKSPACE_SUBJECT_SCHEMAS: ReadonlySet<string> = new Set([
  "http-get/v1",
  "crawl4ai-fetch/v1",
  "crawl4ai-render/v1",
]);

const DENIED: ArtifactSubjectBindingDecision = Object.freeze({
  status: "DENIED",
  reason: "SUBJECT_BINDING_INVALID",
});

const PLATFORM_HOLD: ArtifactSubjectBindingDecision = Object.freeze({
  status: "SUBJECT_BINDING_HOLD",
  reason: "PLATFORM_SUBJECT_UNAVAILABLE",
});

const CANONICAL_SUBJECT_HOLD: ArtifactSubjectBindingDecision = Object.freeze({
  status: "SUBJECT_BINDING_HOLD",
  reason: "CANONICAL_SUBJECT_UNAVAILABLE",
});

function closedInput(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    const expected = new Set([
      "resultSchema",
      "scopeKind",
      "workspaceId",
      "subjectRef",
    ]);
    if (
      (keys.length !== 3 && keys.length !== 4) ||
      keys.some((key) => typeof key !== "string" || !expected.has(key)) ||
      !["resultSchema", "scopeKind", "workspaceId"].every((key) =>
        Object.hasOwn(value, key),
      )
    ) {
      return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        return null;
      }
    }
    return value as Readonly<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function exactResolvedSubject(
  resolved: ResolvedGenericOperationArtifactSubject | null,
  workspaceId: string,
  subjectRef: GenericOperationArtifactSubjectRef,
): boolean {
  return Boolean(
    resolved &&
    resolved.workspaceId === workspaceId &&
    resolved.subjectType === subjectRef.subjectType &&
    resolved.subjectId === subjectRef.subjectId,
  );
}

/**
 * Pre-binding decision only. It deliberately has no ToolBroker, provider,
 * object-store or execution dependency, so a BOUND result cannot start a
 * physical call. The four product schemas remain held at ToolBroker until a
 * separately reviewed wiring phase consumes this contract.
 */
export class ArtifactSubjectBindingContract {
  constructor(
    private readonly subjects: SubjectResolver = new GenericOperationArtifactSubjectRepository(),
  ) {}

  async resolve(
    tx: Prisma.TransactionClient,
    input: unknown,
  ): Promise<ArtifactSubjectBindingDecision> {
    const source = closedInput(input);
    if (!source) return DENIED;

    if (source.resultSchema === "sanctions-download/v1") {
      return source.scopeKind === "platform" &&
        source.workspaceId === null &&
        !Object.hasOwn(source, "subjectRef")
        ? PLATFORM_HOLD
        : DENIED;
    }

    if (
      typeof source.resultSchema !== "string" ||
      !WORKSPACE_SUBJECT_SCHEMAS.has(source.resultSchema) ||
      source.scopeKind !== "workspace" ||
      !isCanonicalArtifactUuid(source.workspaceId)
    ) {
      return DENIED;
    }

    if (!Object.hasOwn(source, "subjectRef")) {
      return CANONICAL_SUBJECT_HOLD;
    }

    let subjectRef: GenericOperationArtifactSubjectRef;
    try {
      subjectRef = parseGenericOperationArtifactSubjectRef(source.subjectRef);
    } catch {
      return DENIED;
    }

    const resolved = await this.subjects.resolveExistingSubject(tx, {
      workspaceId: source.workspaceId,
      subjectRef,
    });
    if (!exactResolvedSubject(resolved, source.workspaceId, subjectRef)) {
      return DENIED;
    }
    return Object.freeze({ status: "BOUND", subjectRef });
  }
}
