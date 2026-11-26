import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRemediatePilotArgs,
  runWorkspacePilotRemediation,
  type WorkspaceRemediationTx,
} from './remediate-pilot.mts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const STALE_MAILBOX = 'stale@example.test';
const CORRECT_MAILBOX = 'corrected@example.test';
const EXPECTED_DIGEST = createHash('sha256').update(STALE_MAILBOX).digest('hex');
const TARGET = ['--workspace-id', WORKSPACE, '--company-profile-id', COMPANY] as const;
const SCOPE = { id: COMPANY, workspaceId: WORKSPACE, deletedAt: null };

function makeTx(businessEmail: string | null) {
  let current = { businessEmail, version: 7 };
  const findUnique = vi.fn(async () => current);
  const updateMany = vi.fn(async () => {
    current = { businessEmail: null, version: current.version + 1 };
    return { count: 1 };
  });
  const tx = { companyProfile: { findUnique, updateMany } } as unknown as WorkspaceRemediationTx;
  return { tx, findUnique, updateMany };
}

describe('scoped pilot company mailbox remediation', () => {
  it('requires both explicitly supplied IDs before dry-run or --apply', () => {
    for (const args of [[], ['--apply'], ['--workspace-id', WORKSPACE]]) {
      expect(() => parseRemediatePilotArgs(args)).toThrow('PILOT_REMEDIATION_EXPLICIT_TARGET_REQUIRED');
    }
    expect(parseRemediatePilotArgs(TARGET)).toEqual({
      apply: false, workspaceId: WORKSPACE, companyProfileId: COMPANY,
    });
    expect(parseRemediatePilotArgs([...TARGET, '--apply']).apply).toBe(true);
  });

  it('rejects actions outside mailbox remediation and conflicting targets', () => {
    expect(() => parseRemediatePilotArgs([...TARGET, '--reconcile-stale-enrichment'])).toThrow();
    expect(() => parseRemediatePilotArgs([...TARGET, '--workspace-id', COMPANY]))
      .toThrow('PILOT_REMEDIATION_DUPLICATE_OPTION');
  });

  it('requires the mailbox digest before reading the selected company', async () => {
    const { tx, findUnique } = makeTx(STALE_MAILBOX);
    await expect(runWorkspacePilotRemediation(tx, {
      ...parseRemediatePilotArgs(TARGET), expectedDirtyEmailSha256: 'invalid',
    })).rejects.toThrow('PILOT_REMEDIATION_EXPECTED_EMAIL_SHA256_REQUIRED');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('previews only the explicitly targeted live company record without emitting its mailbox or writing', async () => {
    const { tx, findUnique, updateMany } = makeTx(STALE_MAILBOX);
    const summary = await runWorkspacePilotRemediation(tx, {
      ...parseRemediatePilotArgs(TARGET), expectedDirtyEmailSha256: EXPECTED_DIGEST,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: SCOPE,
      select: { businessEmail: true, version: true },
    });
    expect(summary).toEqual({
      mode: 'dry-run',
      companyProfileFound: true,
      companyProfileHadDirtyEmail: true,
      companyProfileEmailCleared: false,
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('clears only the known stale value at the expected version and repeats without writing again', async () => {
    const { tx, updateMany } = makeTx(STALE_MAILBOX);
    const opts = { ...parseRemediatePilotArgs([...TARGET, '--apply']), expectedDirtyEmailSha256: EXPECTED_DIGEST };

    await expect(runWorkspacePilotRemediation(tx, opts)).resolves.toMatchObject({ companyProfileEmailCleared: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { ...SCOPE, businessEmail: STALE_MAILBOX, version: 7 },
      data: { businessEmail: null, version: { increment: 1 } },
    });
    await expect(runWorkspacePilotRemediation(tx, opts)).resolves.toMatchObject({
      companyProfileHadDirtyEmail: false, companyProfileEmailCleared: false,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('keeps a mailbox already changed by the workspace', async () => {
    const { tx, updateMany } = makeTx(CORRECT_MAILBOX);
    await expect(runWorkspacePilotRemediation(tx, {
      ...parseRemediatePilotArgs([...TARGET, '--apply']), expectedDirtyEmailSha256: EXPECTED_DIGEST,
    })).resolves.toMatchObject({ companyProfileHadDirtyEmail: false, companyProfileEmailCleared: false });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('fails the apply when the target changes after the preview read', async () => {
    const { tx, updateMany } = makeTx(STALE_MAILBOX);
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(runWorkspacePilotRemediation(tx, {
      ...parseRemediatePilotArgs([...TARGET, '--apply']), expectedDirtyEmailSha256: EXPECTED_DIGEST,
    })).rejects.toThrow('PILOT_PROFILE_CHANGED_DURING_REMEDIATION');
  });
});
