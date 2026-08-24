import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  ArtifactSubjectBindingContract,
  type ArtifactSubjectBindingDecision,
} from './artifact-subject-binding.contract';

const WORKSPACE_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-0000000000b2';
const COMPANY_ID = '00000000-0000-4000-8000-0000000000c3';
const CONTACT_ID = '00000000-0000-4000-8000-0000000000d4';
const tx = {} as Prisma.TransactionClient;

const WORKSPACE_SCHEMAS = [
  'http-get/v1',
  'crawl4ai-fetch/v1',
  'crawl4ai-render/v1',
] as const;

function repository(
  resolved: Readonly<{
    workspaceId: string;
    subjectType: 'company' | 'contact';
    subjectId: string;
  }> | null,
) {
  return {
    resolveExistingSubject: vi.fn(async () => resolved),
  };
}

function workspaceInput(
  resultSchema: (typeof WORKSPACE_SCHEMAS)[number],
  subjectRef?: unknown,
) {
  return subjectRef === undefined
    ? { resultSchema, scopeKind: 'workspace', workspaceId: WORKSPACE_ID }
    : { resultSchema, scopeKind: 'workspace', workspaceId: WORKSPACE_ID, subjectRef };
}

describe('ArtifactSubjectBindingContract', () => {
  it('parks platform sanctions and first-discovery HTTP/Crawl without a canonical subject', async () => {
    const subjects = repository(null);
    const contract = new ArtifactSubjectBindingContract(subjects);

    await expect(contract.resolve(tx, {
      resultSchema: 'sanctions-download/v1',
      scopeKind: 'platform',
      workspaceId: null,
    })).resolves.toEqual({
      status: 'SUBJECT_BINDING_HOLD',
      reason: 'PLATFORM_SUBJECT_UNAVAILABLE',
    });

    for (const resultSchema of WORKSPACE_SCHEMAS) {
      await expect(contract.resolve(tx, workspaceInput(resultSchema))).resolves.toEqual({
        status: 'SUBJECT_BINDING_HOLD',
        reason: 'CANONICAL_SUBJECT_UNAVAILABLE',
      });
    }
    expect(subjects.resolveExistingSubject).not.toHaveBeenCalled();
  });

  it.each([
    ['http-get/v1', 'company', COMPANY_ID],
    ['crawl4ai-fetch/v1', 'contact', CONTACT_ID],
    ['crawl4ai-render/v1', 'company', COMPANY_ID],
  ] as const)('binds %s only after the repository verifies an exact current-workspace %s', async (
    resultSchema,
    subjectType,
    subjectId,
  ) => {
    const subjectRef = Object.freeze({ subjectType, subjectId });
    const subjects = repository({ workspaceId: WORKSPACE_ID, ...subjectRef });
    const contract = new ArtifactSubjectBindingContract(subjects);

    const decision = await contract.resolve(tx, workspaceInput(resultSchema, subjectRef));

    expect(decision).toEqual({ status: 'BOUND', subjectRef });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen((decision as Extract<ArtifactSubjectBindingDecision, { status: 'BOUND' }>).subjectRef)).toBe(true);
    expect(subjects.resolveExistingSubject).toHaveBeenCalledWith(tx, {
      workspaceId: WORKSPACE_ID,
      subjectRef,
    });
  });

  it.each([
    ['missing canonical row', null],
    ['cross-workspace row', {
      workspaceId: OTHER_WORKSPACE_ID,
      subjectType: 'company',
      subjectId: COMPANY_ID,
    }],
  ] as const)('denies a syntactically valid claim when the repository reports %s', async (
    _case,
    resolved,
  ) => {
    const subjects = repository(resolved);
    const contract = new ArtifactSubjectBindingContract(subjects);

    await expect(contract.resolve(tx, workspaceInput('http-get/v1', {
      subjectType: 'company',
      subjectId: COMPANY_ID,
    }))).resolves.toEqual({
      status: 'DENIED',
      reason: 'SUBJECT_BINDING_INVALID',
    });
  });

  it.each([
    ['partial ref', { subjectType: 'company' }],
    ['wrong subject kind', { subjectType: 'schedule', subjectId: COMPANY_ID }],
    ['identity text', { subjectType: 'contact', subjectId: 'person@example.test' }],
    ['subject extra email', { subjectType: 'contact', subjectId: CONTACT_ID, email: 'person@example.test' }],
    ['input URL inference', { resultSchema: 'http-get/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, url: 'https://example.test/' }],
    ['input body inference', { resultSchema: 'http-get/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, body: 'company' }],
    ['authority inference', { resultSchema: 'http-get/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, authorityId: COMPANY_ID }],
    ['schedule inference', { resultSchema: 'http-get/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, scheduleId: 'sanctions-refresh' }],
    ['privacy downgrade', { resultSchema: 'http-get/v1', scopeKind: 'workspace', workspaceId: WORKSPACE_ID, privacyClass: 'PUBLIC_ORGANIZATION' }],
  ])('denies %s rather than inferring a binding', async (_case, candidate) => {
    const subjects = repository(null);
    const contract = new ArtifactSubjectBindingContract(subjects);
    const input = Object.hasOwn(candidate as object, 'resultSchema')
      ? candidate
      : workspaceInput('http-get/v1', candidate);

    await expect(contract.resolve(tx, input)).resolves.toEqual({
      status: 'DENIED',
      reason: 'SUBJECT_BINDING_INVALID',
    });
    expect(subjects.resolveExistingSubject).not.toHaveBeenCalled();
  });

  it('denies sanctions workspace claims and platform claims with a fabricated subject', async () => {
    const subjects = repository({
      workspaceId: WORKSPACE_ID,
      subjectType: 'company',
      subjectId: COMPANY_ID,
    });
    const contract = new ArtifactSubjectBindingContract(subjects);

    for (const input of [
      {
        resultSchema: 'sanctions-download/v1',
        scopeKind: 'workspace',
        workspaceId: WORKSPACE_ID,
        subjectRef: { subjectType: 'company', subjectId: COMPANY_ID },
      },
      {
        resultSchema: 'sanctions-download/v1',
        scopeKind: 'platform',
        workspaceId: null,
        subjectRef: { subjectType: 'company', subjectId: COMPANY_ID },
      },
    ]) {
      await expect(contract.resolve(tx, input)).resolves.toEqual({
        status: 'DENIED',
        reason: 'SUBJECT_BINDING_INVALID',
      });
    }
  });
});
