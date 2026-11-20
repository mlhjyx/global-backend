import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  MAX_DOCUMENT_BYTES, MarketCandidateBasisSnapshotDto, MarketCandidateCorrectionDto,
  MarketCandidateFeedbackInputDto, MarketCandidateSetDraftV1Dto, MarketCandidateSetV1Dto,
  type MarketCandidateDto, type MarketCandidateProposalDto,
} from './dto/market-candidate-set.dto';

export function invalidCandidateInput(): never {
  throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: '市场候选文档或反馈不符合合同' } });
}

export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): string {
    if (depth > 40) return invalidCandidateInput();
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || seen.has(v)) return invalidCandidateInput();
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return invalidCandidateInput();
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) return invalidCandidateInput();
      result = `[${v.map(item => visit(item, depth + 1)).join(',')}]`;
    } else {
      if (Object.getOwnPropertySymbols(v).length > 0) return invalidCandidateInput();
      result = `{${Object.keys(v).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'prototype', 'constructor'].includes(key)) return invalidCandidateInput();
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    }
    seen.delete(v);
    return result;
  }
  return visit(value, 0);
}

export function documentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function strict<T extends object>(type: ClassConstructor<T>, input: unknown): T {
  const encoded = canonicalJson(input);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_DOCUMENT_BYTES || input === null || Array.isArray(input) || typeof input !== 'object') return invalidCandidateInput();
  const instance = plainToInstance(type, JSON.parse(encoded), { enableImplicitConversion: false });
  if (validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).length > 0) return invalidCandidateInput();
  return JSON.parse(JSON.stringify(instance)) as T;
}

function validateProposal(proposal: MarketCandidateProposalDto, basisKeys: Set<string>): void {
  if (!proposal || !proposal.supplyOrCapability || !proposal.application || !proposal.organizationRole || !proposal.fitExplanation || !proposal.recommendation) return invalidCandidateInput();
  if (!basisKeys.has(`OFFERING:${proposal.supplyOrCapability.offeringId}`)) return invalidCandidateInput();
  const statements = [proposal.application, proposal.organizationRole, proposal.fitExplanation,
    ...proposal.entryConditions, ...proposal.support, ...proposal.counterEvidence, ...proposal.gaps];
  for (const statement of statements) {
    if (statement.basisKeys.some(key => !basisKeys.has(key)) || (statement.knowledgeState === 'REVIEWED_SOURCE_FACT' && statement.basisKeys.length === 0)) return invalidCandidateInput();
  }
}

function validateOutcome(outcome: string, length: number): void {
  if ((outcome === 'COMPLETED_EMPTY') !== (length === 0)) return invalidCandidateInput();
}

export function parseDraft(input: unknown): MarketCandidateSetDraftV1Dto {
  const draft = strict(MarketCandidateSetDraftV1Dto, input);
  validateOutcome(draft.generationOutcome, draft.candidates.length);
  const keys = draft.sources.map(source => `${source.kind}:${source.sourceId}`);
  if (new Set(keys).size !== keys.length) return invalidCandidateInput();
  for (const candidate of draft.candidates) validateProposal(candidate.proposal, new Set(keys));
  return draft;
}

export function parseDocument(input: unknown): MarketCandidateSetV1Dto {
  const doc = strict(MarketCandidateSetV1Dto, input);
  if (!doc.basisSnapshot?.company || doc.basisSnapshot.company.companyId !== doc.companyId) return invalidCandidateInput();
  validateOutcome(doc.generationOutcome, doc.candidates.length);
  const ids = doc.candidates.map(candidate => candidate.candidateId);
  if (new Set(ids).size !== ids.length) return invalidCandidateInput();
  const keys = doc.basisSnapshot.sources.map(source => source.key);
  if (new Set(keys).size !== keys.length) return invalidCandidateInput();
  for (const source of doc.basisSnapshot.sources) {
    if (source.key !== `${source.kind}:${source.sourceId}`) return invalidCandidateInput();
    if (source.kind === 'SELLER_DOCUMENT_CHUNK' && (!source.parentId || !source.parentContentHash || source.position?.seq === null || source.position?.seq === undefined)) return invalidCandidateInput();
  }
  for (const candidate of doc.candidates) {
    if (!candidate.corrections) return invalidCandidateInput();
    validateProposal(candidate.proposal, new Set(keys));
    if (Object.keys(candidate.corrections).length > 0 && (!candidate.needsReassessment || candidate.impactScope !== 'UNKNOWN')) return invalidCandidateInput();
  }
  return doc;
}

export function parseFeedback(input: unknown): MarketCandidateFeedbackInputDto & { reason: string | null } {
  const feedback = strict(MarketCandidateFeedbackInputDto, input);
  if (feedback.action === 'CORRECT') {
    if (!feedback.correction || Object.keys(feedback.correction).length === 0) return invalidCandidateInput();
  } else if (Object.hasOwn(feedback, 'correction')) return invalidCandidateInput();
  return { ...feedback, reason: feedback.reason?.trim() ? feedback.reason : null };
}

export function createInitialDocument(
  draft: MarketCandidateSetDraftV1Dto,
  identity: { setId: string; companyId: string; candidateIds: string[] },
  basisSnapshot: MarketCandidateBasisSnapshotDto,
): MarketCandidateSetV1Dto {
  if (identity.candidateIds.length !== draft.candidates.length) return invalidCandidateInput();
  return parseDocument({ schemaVersion: 'market-candidate-set/v1', setId: identity.setId,
    companyId: identity.companyId, revision: 1, generationOutcome: draft.generationOutcome,
    basisSnapshot, candidates: draft.candidates.map((candidate, index) => ({ ...candidate,
      candidateId: identity.candidateIds[index], corrections: {}, feedback: 'PENDING', needsReassessment: false, impactScope: 'NONE' })) });
}

function effectiveCorrectionValue(candidate: MarketCandidateDto, key: keyof MarketCandidateCorrectionDto): unknown {
  if (Object.hasOwn(candidate.corrections, key)) return candidate.corrections[key];
  if (key === 'supplyDescription') return candidate.proposal.supplyOrCapability.description;
  if (['application', 'organizationRole', 'fitExplanation'].includes(key)) return (candidate.proposal[key as 'application']).text;
  if (key === 'entryConditions' || key === 'gaps') return candidate.proposal[key].map(statement => statement.text);
  return candidate.proposal[key];
}

export function applyFeedback(
  document: MarketCandidateSetV1Dto, candidateId: string, input: MarketCandidateFeedbackInputDto,
): MarketCandidateSetV1Dto {
  const current = parseDocument(document);
  const feedback = parseFeedback(input);
  const target = current.candidates.find(candidate => candidate.candidateId === candidateId);
  if (!target || current.revision !== feedback.expectedRevision) return invalidCandidateInput();
  if (feedback.action === 'CORRECT') {
    const patch = feedback.correction!;
    const different = (Object.keys(patch) as (keyof MarketCandidateCorrectionDto)[]).some(key => {
      const previous = effectiveCorrectionValue(target, key), next = patch[key];
      return canonicalJson(typeof previous === 'string' ? previous.trim() : previous) !== canonicalJson(typeof next === 'string' ? next.trim() : next);
    });
    if (!different) return invalidCandidateInput();
    target.corrections = { ...target.corrections, ...patch };
    target.needsReassessment = true;
    target.impactScope = 'UNKNOWN';
  }
  const states = { CONFIRM: 'CONFIRMED', CORRECT: 'CORRECTED', KEEP_PENDING: 'PENDING_EVIDENCE', REJECT: 'REJECTED' } as const;
  target.feedback = states[feedback.action];
  return parseDocument({ ...current, revision: current.revision + 1 });
}
