import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { sanitizeEvidenceUrl } from '../../site-builder/agents/evidence-ref';
import { normalizeArtifactPageText } from './artifact-page-text';
import type { BudgetReservation } from '../../tools/budget-store';
import type {
  ArtifactExecutionAdmission,
  ArtifactExecutionPort,
  ArtifactSubjectRef,
} from '../../tools/artifact-execution-port';
import type { Tool, ToolResult } from '../../tools/tool-contract';
import { parseArtifactExpectedFacts } from './artifact-expected-facts';
import type { ArtifactMaterializerRegistry } from './artifact-materializer.registry';
import type { ArtifactSubjectBindingContract } from './artifact-subject-binding.contract';
import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactUuid,
} from './artifact.types';
import type { GenericOperationArtifactService } from './generic-operation-artifact.service';

type WorkspaceArtifactSchema =
  | 'crawl4ai-fetch/v1'
  | 'crawl4ai-render/v1'
  | 'http-get/v1';

interface ArtifactPayload {
  readonly body: string;
  readonly mediaType: string;
  readonly expectedFacts: unknown;
  /** Exactly what the schema materializer reconstructs from body + facts. */
  readonly data: unknown;
}

export interface GenericOperationArtifactExecutionDeps {
  readonly withWorkspace: <T>(
    workspaceId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
  readonly binding: Pick<ArtifactSubjectBindingContract, 'resolveForExecution'>;
  readonly service: Pick<GenericOperationArtifactService, 'persist' | 'readVerified'>;
  readonly materializers: Pick<ArtifactMaterializerRegistry, 'materialize'>;
  readonly now?: () => Date;
}

const invalid = invalidGenericOperationArtifact;
const MICROUSD_PER_CENT = 10_000n;

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : invalid();
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}

function isPersistableUrl(url: string): boolean {
  try {
    parseArtifactExpectedFacts('crawl4ai-fetch/v1', {
      sanitizedUrl: url,
      contentHash: '0'.repeat(24),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The persisted fact URL must satisfy the closed sanitized-URL contract
 * (lowercase path, no query/escapes, no long digit runs). When the exact page
 * URL cannot, the site origin is the truthful company-level provenance.
 */
function persistableUrl(raw: unknown): string {
  const sanitized = sanitizeEvidenceUrl(typeof raw === 'string' ? raw : undefined);
  if (!sanitized) return invalid();
  const url = new URL(sanitized);
  url.search = '';
  url.hash = '';
  const candidates = [url.toString(), `${url.protocol}//${url.hostname}/`];
  return candidates.find(isPersistableUrl) ?? invalid();
}

function isHtmlBody(value: string): boolean {
  return /^\s*<(?:!doctype\s+html\b|[a-z][a-z0-9:-]*\b)/i.test(value);
}

function crawl4aiFetchPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  const text = normalizeArtifactPageText(stringField(source.text));
  const url = persistableUrl(source.url ?? record(input).url);
  const contentHash = shortHash(text);
  return {
    body: text,
    mediaType: 'text/markdown',
    expectedFacts: { sanitizedUrl: url, contentHash },
    data: { url, text, contentHash },
  };
}

function crawl4aiRenderPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  const url = persistableUrl(source.url ?? record(input).url);
  if (source.robotsBlocked === true) {
    return {
      body: '',
      mediaType: 'text/html',
      expectedFacts: { sanitizedUrl: url, blocked: true },
      data: { url, html: '', robotsBlocked: true },
    };
  }
  const html = stringField(source.html);
  if (!isHtmlBody(html)) return invalid();
  return {
    body: html,
    mediaType: 'text/html',
    expectedFacts: { sanitizedUrl: url, blocked: false },
    data: { url, html },
  };
}

function httpGetPayload(input: unknown, data: unknown): ArtifactPayload {
  const source = record(data);
  if (typeof source.blocked === 'string') {
    return {
      body: '',
      mediaType: 'text/plain',
      expectedFacts: { status: 0, ok: false, sanitizedUrl: null, blocked: source.blocked },
      data: { status: 0, ok: false, mediaType: 'text/plain', text: '', blocked: source.blocked },
    };
  }
  const status = source.status;
  if (typeof status !== 'number' || typeof source.ok !== 'boolean') return invalid();
  const url = persistableUrl(source.finalUrl ?? record(input).url);
  const text = stringField(source.text);
  return {
    body: text,
    mediaType: 'text/plain',
    expectedFacts: { status, ok: source.ok, sanitizedUrl: url, blocked: null },
    data: { status, ok: source.ok, mediaType: 'text/plain', text, finalUrl: url },
  };
}

const PAYLOADS: Readonly<
  Record<WorkspaceArtifactSchema, (input: unknown, data: unknown) => ArtifactPayload>
> = Object.freeze({
  'crawl4ai-fetch/v1': crawl4aiFetchPayload,
  'crawl4ai-render/v1': crawl4aiRenderPayload,
  'http-get/v1': httpGetPayload,
});

function workspaceSchema(tool: Tool<unknown, unknown>): WorkspaceArtifactSchema {
  const strategy = tool.durableResultStrategy;
  if (strategy.kind !== 'artifact_reference' || !Object.hasOwn(PAYLOADS, strategy.schema)) {
    return invalid();
  }
  return strategy.schema as WorkspaceArtifactSchema;
}

function authorityOf(reservation: BudgetReservation): string {
  return isCanonicalArtifactUuid(reservation.authorityId)
    ? reservation.authorityId
    : invalid();
}

async function* bytesOf(body: string): AsyncIterable<Uint8Array> {
  if (body.length > 0) yield new TextEncoder().encode(body);
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
        scopeKind: 'workspace',
        workspaceId: input.workspaceId,
        subjectRef: input.subjectRef,
      }),
    );
    if (decision.status === 'BOUND') {
      return { status: 'BOUND', subjectRef: decision.subjectRef };
    }
    return {
      status: 'DENIED',
      reason: decision.status === 'SUBJECT_BINDING_HOLD' ? 'SUBJECT_BINDING_HOLD' : decision.reason,
    };
  }

  async persist<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
    readonly input: I;
    readonly result: ToolResult<O>;
    readonly subjectRef: ArtifactSubjectRef;
  }): Promise<ToolResult<O>> {
    const schema = workspaceSchema(input.tool as Tool<unknown, unknown>);
    const strategy = input.tool.durableResultStrategy as Extract<
      Tool['durableResultStrategy'],
      { kind: 'artifact_reference' }
    >;
    const authorityId = authorityOf(input.reservation);
    const costCents = input.result.costCents;
    if (!Number.isSafeInteger(costCents) || costCents < 0) return invalid();
    const payload = PAYLOADS[schema](input.input, input.result.data);
    const expiresAt = new Date(this.now().getTime() + strategy.ttlSeconds * 1_000);
    const settled = await this.deps.service.persist({
      reservation: input.reservation,
      authorityId,
      source: { body: bytesOf(payload.body), mediaType: payload.mediaType },
      maxBytes: strategy.maxBytes,
      resultSchema: schema,
      privacyClass: strategy.privacyClass,
      subjectRef: input.subjectRef,
      expiresAt: expiresAt.toISOString(),
      observedMicrousd: BigInt(costCents) * MICROUSD_PER_CENT,
      expectedFacts: payload.expectedFacts,
    });
    return {
      data: payload.data as O,
      costCents,
      durableReceipt: settled.durableReceipt,
    };
  }

  async replay<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
  }): Promise<ToolResult<O>> {
    const schema = workspaceSchema(input.tool as Tool<unknown, unknown>);
    const replay = input.reservation.replayResult;
    if (
      replay?.resultStrategy !== 'artifact_reference' ||
      replay.reference.resultSchema !== schema ||
      !input.reservation.receipt
    ) {
      return invalid();
    }
    const verified = await this.deps.service.readVerified({
      scopeKind: 'workspace',
      workspaceId: input.reservation.workspaceId,
      authorityId: authorityOf(input.reservation),
      reference: replay.reference,
    });
    const data = await this.deps.materializers.materialize<O>(
      schema,
      verified.body,
      verified.manifest,
      verified.expectedFacts,
    );
    return { data, costCents: 0, durableReceipt: input.reservation.receipt };
  }
}
