import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, resetActivities, setPatched, sleep } from './testing/temporal-workflow.mock';
import { deletionWorkflow } from './deletion.workflow';

beforeEach(() => resetActivities());

const INPUT = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  deletionRequestId: '90000000-0000-4000-8000-000000000009',
  subjectType: 'seller_document' as const,
  subjectId: '40000000-0000-4000-8000-000000000004',
};

const LOCATED = {
  subjectType: 'seller_document' as const,
  subjectId: INPUT.subjectId,
  documentId: INPUT.subjectId,
  companyId: '30000000-0000-4000-8000-000000000003',
  policyVersion: 'seller-document-cleanup/v1',
  chunkCount: 1,
  claimCount: 1,
  evidenceCount: 1,
  referenceCount: 1,
  knowledgeSourceCount: 0,
};

describe('deletionWorkflow（seller_document 对象存储删除重试与 fail-closed）', () => {
  it('DB 批次擦完但 blob 删除瞬时失败时，退避重试 eraseSubject 并在恢复后完成回执', async () => {
    acts.freezeSubject.mockResolvedValue(LOCATED);
    acts.eraseSubject
      .mockResolvedValueOnce({ chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, knowledgeSourcesErased: 0, blobDeleted: false, blobFailures: 1, done: true })
      .mockResolvedValueOnce({ chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, knowledgeSourcesErased: 0, blobDeleted: true, blobFailures: 0, done: true });
    acts.completeDeletion.mockResolvedValue({ chunksErased: 1, claimsErased: 1, evidenceErased: 1, referencesErased: 1, knowledgeSourcesErased: 0, blobDeleted: true, blobFailures: 0 });

    const out = await deletionWorkflow(INPUT);

    expect(acts.eraseSubject).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(acts.completeDeletion).toHaveBeenCalledTimes(1);
    expect(acts.failDeletion).not.toHaveBeenCalled();
    expect(out).toMatchObject({ blobDeleted: true, blobFailures: 0 });
  });

  it('对象存储持续失败耗尽重试后交由 completeDeletion fail-closed 报错并记录 failDeletion', async () => {
    acts.freezeSubject.mockResolvedValue(LOCATED);
    acts.eraseSubject.mockResolvedValue({
      chunksErased: 1,
      claimsErased: 0,
      evidenceErased: 0,
      referencesErased: 0,
      knowledgeSourcesErased: 0,
      blobDeleted: false,
      blobFailures: 1,
      done: true,
    });
    acts.completeDeletion.mockRejectedValue(new Error('completeDeletion: seller document cleanup has blob residue'));

    await expect(deletionWorkflow(INPUT)).rejects.toThrow(/blob residue/);
    expect(acts.eraseSubject).toHaveBeenCalledTimes(4); // 首次 + 3 轮退避重试
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(acts.failDeletion).toHaveBeenCalledTimes(1);
  });

  it('旧历史回放（patch=false）保持原有单次 eraseSubject → completeDeletion 命令序列', async () => {
    setPatched(() => false);
    acts.freezeSubject.mockResolvedValue(LOCATED);
    acts.eraseSubject.mockResolvedValue({
      chunksErased: 1,
      claimsErased: 0,
      evidenceErased: 0,
      referencesErased: 0,
      knowledgeSourcesErased: 0,
      blobDeleted: false,
      blobFailures: 1,
      done: true,
    });
    acts.completeDeletion.mockRejectedValue(new Error('completeDeletion: seller document cleanup has blob residue'));

    await expect(deletionWorkflow(INPUT)).rejects.toThrow(/blob residue/);
    expect(acts.eraseSubject).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
