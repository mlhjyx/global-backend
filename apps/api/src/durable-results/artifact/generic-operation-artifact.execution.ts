import { observedToolMicrousd } from "../../tools/tool-cost-microusd";
import type { Prisma } from "@prisma/client";
import type { BudgetReservation } from "../../tools/budget-store";
import type {
  ArtifactExecutionAdmission,
  ArtifactExecutionPort,
  ArtifactSubjectRef,
} from "../../tools/artifact-execution-port";
import type { Tool, ToolResult } from "../../tools/tool-contract";
import type { ArtifactMaterializerRegistry } from "./artifact-materializer.registry";
import type { ArtifactSubjectBindingContract } from "./artifact-subject-binding.contract";
import {
  GenericOperationArtifactError,
  invalidGenericOperationArtifact,
  isCanonicalArtifactUuid,
} from "./artifact.types";
import type { GenericOperationArtifactService } from "./generic-operation-artifact.service";
import type { GenericOperationArtifactReference } from "./artifact.types";
import type { DurableExecutionReceipt } from "../durable-execution-receipt";
import { ArtifactStorageError } from "./generic-operation-artifact.store";
import {
  bytesOfArtifact,
  record,
  stringField,
  workspaceArtifactPayload,
  workspaceArtifactSchema,
  type WorkspaceArtifactSchema,
} from "./workspace-artifact-payload";

export interface GenericOperationArtifactExecutionDeps {
  readonly withWorkspace: <T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
  readonly binding: Pick<ArtifactSubjectBindingContract, "resolveForExecution">;
  readonly service: Pick<
    GenericOperationArtifactService,
    "persist" | "readVerified"
  >;
  readonly materializers: Pick<ArtifactMaterializerRegistry, "materialize">;
  readonly now?: () => Date;
}

const invalid = invalidGenericOperationArtifact;

function authorityOf(reservation: BudgetReservation): string {
  return isCanonicalArtifactUuid(reservation.authorityId)
    ? reservation.authorityId
    : invalid();
}

/** The bounded artifact or storage code of a failure, or only the error's class. */
function failureLabel(error: unknown): string {
  if (
    error instanceof ArtifactStorageError ||
    error instanceof GenericOperationArtifactError
  ) {
    return `${error.name}:${error.code}`;
  }
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Production ArtifactExecutionPort (G3 spec 2026-09-24 §4.1): RLS subject
 * admission, bounded PERSONAL_DATA object persistence bound to the subject
 * (1-day TTL from the tool strategy) and verified replay.
 */
export class GenericOperationArtifactExecution implements ArtifactExecutionPort {
  private readonly now: () => Date;

  constructor(private readonly deps: GenericOperationArtifactExecutionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async admit(input: {
    readonly workspaceId: string;
    readonly resultSchema: string;
    readonly subjectRef: ArtifactSubjectRef;
  }): Promise<ArtifactExecutionAdmission> {
    const decision = await this.deps.withWorkspace(input.workspaceId, (tx) =>
      this.deps.binding.resolveForExecution(tx, {
        resultSchema: input.resultSchema,
        scopeKind: "workspace",
        workspaceId: input.workspaceId,
        subjectRef: input.subjectRef,
      }),
    );
    if (decision.status === "BOUND") {
      return { status: "BOUND", subjectRef: decision.subjectRef };
    }
    return {
      status: "DENIED",
      reason:
        decision.status === "SUBJECT_BINDING_HOLD"
          ? "SUBJECT_BINDING_HOLD"
          : decision.reason,
    };
  }

  async persist<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
    readonly input: I;
    readonly result: ToolResult<O>;
    readonly subjectRef: ArtifactSubjectRef;
  }): Promise<ToolResult<O>> {
    const schema = workspaceArtifactSchema(input.tool as Tool<unknown, unknown>);
    const strategy = input.tool.durableResultStrategy as Extract<
      Tool["durableResultStrategy"],
      { kind: "artifact_reference" }
    >;
    const authorityId = authorityOf(input.reservation);
    const costCents = input.result.costCents;
    let observedMicrousd: bigint;
    try {
      observedMicrousd = observedToolMicrousd(input.result);
    } catch {
      return invalid();
    }
    const isContactFind =
      schema === "contact-email-find-hunter/v1" ||
      schema === "contact-email-find-prospeo/v1";
    const expectedContactFindToolId =
      schema === "contact-email-find-prospeo/v1"
        ? "contact_email.find.prospeo"
        : "contact_email.find.hunter";
    if (isContactFind) {
      if (
        input.tool.id !== expectedContactFindToolId ||
        input.subjectRef.subjectType !== "contact" ||
        typeof input.result.costMicrousd !== "string" ||
        observedMicrousd > 150000n ||
        observedMicrousd !== input.reservation.estimatedMicrousd ||
        !Number.isFinite(costCents) ||
        Object.is(costCents, -0) ||
        costCents !== Number(observedMicrousd) / 10000 ||
        strategy.privacyClass !== "PERSONAL_DATA" ||
        strategy.maxBytes > 16384 ||
        strategy.ttlSeconds > 86400
      )
        return invalid();
    } else if (
      "costMicrousd" in input.result ||
      !Number.isSafeInteger(costCents) ||
      costCents < 0
    )
      return invalid();
    const payload = workspaceArtifactPayload(
      schema,
      input.input,
      input.result.data,
      input.reservation.workspaceId,
    );
    const expiresAt = new Date(
      this.now().getTime() + strategy.ttlSeconds * 1_000,
    );
    let settled: Awaited<
      ReturnType<GenericOperationArtifactExecutionDeps["service"]["persist"]>
    >;
    try {
      settled = await this.deps.service.persist({
        reservation: input.reservation,
        authorityId,
        source: { body: bytesOfArtifact(payload.body), mediaType: payload.mediaType },
        maxBytes: strategy.maxBytes,
        resultSchema: schema,
        privacyClass: strategy.privacyClass,
        subjectRef: input.subjectRef,
        expiresAt: expiresAt.toISOString(),
        observedMicrousd,
        expectedFacts: payload.expectedFacts,
      });
    } catch (error) {
      // The broker turns this into an unreplayable operation and logs only the error's class, so
      // say which step failed. Only the bounded storage code is logged: a raw message may carry
      // endpoints or object keys.
      console.warn(
        `[artifact] ${schema} persist failed for operation ${input.reservation.operationId}: ${failureLabel(error)}`,
      );
      throw error;
    }
    const verifiedHttpHomepage =
      schema === "http-get/v1" &&
      record(payload.data).ok === true &&
      new URL(stringField(record(input.input).url)).pathname === "/";
    if (schema === "crawl4ai-fetch/v1" || verifiedHttpHomepage) {
      return this.verifiedResult<O>(
        input.reservation,
        schema,
        settled.reference,
        costCents,
        settled.durableReceipt,
      );
    }
    return {
      data: payload.data as O,
      costCents,
      ...(isContactFind
        ? { costMicrousd: observedMicrousd.toString() }
        : {}),
      durableReceipt: settled.durableReceipt,
    };
  }

  /** Source metadata comes from verified stored facts, including on the first read.
   * The manifest time records artifact capture; replay must not refresh it.
   * Never restore the caller's provenance or replace a normalized URL with the request URL.
   */
  private async verifiedResult<O>(
    reservation: BudgetReservation,
    schema: WorkspaceArtifactSchema,
    reference: GenericOperationArtifactReference,
    costCents: number,
    durableReceipt: DurableExecutionReceipt,
  ): Promise<ToolResult<O>> {
    const verified = await this.deps.service.readVerified({
      scopeKind: "workspace",
      workspaceId: reservation.workspaceId,
      authorityId: authorityOf(reservation),
      reference,
    });
    const data = await this.deps.materializers.materialize<O>(
      schema,
      verified.body,
      verified.manifest,
      verified.expectedFacts,
    );
    const page = schema === "crawl4ai-fetch/v1" ? record(data) : undefined;
    const http = schema === "http-get/v1" ? record(data) : undefined;
    return {
      data,
      costCents,
      durableReceipt,
      ...(schema === "contact-email-find-hunter/v1" ||
      schema === "contact-email-find-prospeo/v1"
        ? { costMicrousd: "0" }
        : {}),
      ...(page
        ? {
            provenance: {
              sourceUrl: stringField(page.url),
              fetchedAt: verified.manifest.createdAt,
              artifactExpiresAt: verified.manifest.expiresAt,
              contentHash: stringField(page.contentHash),
              parserVersion: "artifact/crawl4ai-fetch/v1",
            },
          }
        : http?.ok === true && typeof http.finalUrl === "string"
          ? {
              provenance: {
                sourceUrl: http.finalUrl,
                fetchedAt: verified.manifest.createdAt,
                artifactExpiresAt: verified.manifest.expiresAt,
                parserVersion: "artifact/http-get/v1",
              },
            }
          : {}),
    };
  }

  async replay<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
  }): Promise<ToolResult<O>> {
    const schema = workspaceArtifactSchema(input.tool as Tool<unknown, unknown>);
    const replay = input.reservation.replayResult;
    if (
      replay?.resultStrategy !== "artifact_reference" ||
      replay.reference.resultSchema !== schema ||
      !input.reservation.receipt
    ) {
      return invalid();
    }
    try {
      return await this.verifiedResult<O>(
        input.reservation,
        schema,
        replay.reference,
        0,
        input.reservation.receipt,
      );
    } catch (error) {
      // The broker turns any replay failure into an operation it cannot replay
      // (no second physical call, the company or query is skipped and counted),
      // and logs only the error's class. Leave the bounded code, the schema and
      // the operation behind: an object the bucket no longer holds
      // (GENERIC_OPERATION_ARTIFACT_OBJECT_MISSING) reads differently from a
      // tampered one. Never the digest or an object key.
      console.warn(
        `[artifact] ${schema} replay failed for operation ${input.reservation.operationId}: ${failureLabel(error)}`,
      );
      throw error;
    }
  }
}
