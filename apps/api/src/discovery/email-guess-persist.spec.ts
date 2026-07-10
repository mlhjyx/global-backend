import { describe, expect, it, vi } from 'vitest';
import {
  allowedActionsForGuess,
  guessedEmailWritePlan,
  persistGuessedEmail,
} from './email-guess-persist';
import { GuessResult } from './email-guesser';

const verifiedResult: GuessResult = {
  status: 'verified',
  best: { email: 'h.herold@acme.de', pattern: 'f.last', prior: 0.85, verdict: { status: 'VALID', detail: 'smtp_accepted:250', costCents: 0 }, confidence: 0.9 },
  triedCount: 1,
  candidates: [],
  reason: 'smtp_verified:f.last',
};
const unverifiedResult: GuessResult = {
  status: 'unverified',
  domainFact: 'catch_all',
  best: { email: 'hans.herold@acme.de', pattern: 'first.last', prior: 0.9, verdict: { status: 'RISKY', detail: 'catch_all_domain', costCents: 0 }, confidence: 0.36 },
  triedCount: 1,
  candidates: [],
  reason: 'catch_all_domain_unconfirmable',
};
const blockedResult: GuessResult = { status: 'blocked', triedCount: 0, candidates: [], reason: 'lawful_basis_gate:personal_email_no_lawful_basis' };
const exhaustedResult: GuessResult = { status: 'exhausted', triedCount: 5, candidates: [], reason: 'all_probed_candidates_rejected' };

describe('email-guess-persist · 落库计划（纯）', () => {
  it('verified → VALID 计划', () => {
    expect(guessedEmailWritePlan(verifiedResult)).toMatchObject({ email: 'h.herold@acme.de', pointStatus: 'VALID', verified: true, pattern: 'f.last' });
  });
  it('unverified → RISKY 计划', () => {
    expect(guessedEmailWritePlan(unverifiedResult)).toMatchObject({ email: 'hans.herold@acme.de', pointStatus: 'RISKY', verified: false });
  });
  it('blocked/exhausted/无 best → 不落(null)', () => {
    expect(guessedEmailWritePlan(blockedResult)).toBeNull();
    expect(guessedEmailWritePlan(exhaustedResult)).toBeNull();
  });
  it('allowedActions：VALID 才可 outreach，RISKY 只展示/匹配', () => {
    expect(allowedActionsForGuess('VALID')).toContain('outreach');
    expect(allowedActionsForGuess('RISKY')).not.toContain('outreach');
  });
});

function fakeTx() {
  const upsert = vi.fn(async () => ({}));
  const create = vi.fn(async () => ({}));
  return { tx: { contactPoint: { upsert }, fieldEvidence: { create } } as never, upsert, create };
}
const NOW = new Date('2026-07-10T00:00:00.000Z');
const LIA = { basis: 'legitimate_interest' as const, ref: 'LIA-1' };

describe('email-guess-persist · 落库（fake tx）', () => {
  it('verified：contact_point status=VALID + verifiedAt，证据 allowedActions 含 outreach', async () => {
    const { tx, upsert, create } = fakeTx();
    const out = await persistGuessedEmail(tx, { workspaceId: 'w', contactId: 'c1', result: verifiedResult, suppressedEmails: new Set(), lawfulBasis: LIA, now: NOW });
    expect(out).toMatchObject({ persisted: true, email: 'h.herold@acme.de', status: 'VALID' });
    expect(upsert.mock.calls[0][0].create).toMatchObject({ status: 'VALID', verifiedAt: NOW, type: 'email' });
    expect(upsert.mock.calls[0][0].update).toMatchObject({ status: 'VALID', verifiedAt: NOW }); // 重 upsert 也置 verifiedAt
    expect(create.mock.calls[0][0].data.allowedActions).toContain('outreach');
    expect(create.mock.calls[0][0].data.value.personal_data).toBe(true);
  });

  it('unverified：contact_point status=RISKY 无 verifiedAt，证据不含 outreach', async () => {
    const { tx, upsert, create } = fakeTx();
    const out = await persistGuessedEmail(tx, { workspaceId: 'w', contactId: 'c1', result: unverifiedResult, suppressedEmails: new Set(), now: NOW });
    expect(out).toMatchObject({ persisted: true, status: 'RISKY' });
    expect(upsert.mock.calls[0][0].create.status).toBe('RISKY');
    expect(upsert.mock.calls[0][0].create.verifiedAt).toBeNull();
    expect(upsert.mock.calls[0][0].update.verifiedAt).toBeNull(); // 降级也显式清 verifiedAt（不留 stale）
    expect(create.mock.calls[0][0].data.allowedActions).not.toContain('outreach');
  });

  it('suppression 命中：不落，upsert 不调用', async () => {
    const { tx, upsert } = fakeTx();
    const out = await persistGuessedEmail(tx, { workspaceId: 'w', contactId: 'c1', result: verifiedResult, suppressedEmails: new Set(['h.herold@acme.de']), now: NOW });
    expect(out).toEqual({ persisted: false, reason: 'suppressed' });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('blocked/无可用地址：不落，upsert 不调用', async () => {
    const { tx, upsert } = fakeTx();
    const out = await persistGuessedEmail(tx, { workspaceId: 'w', contactId: 'c1', result: blockedResult, suppressedEmails: new Set(), now: NOW });
    expect(out.persisted).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });
});
