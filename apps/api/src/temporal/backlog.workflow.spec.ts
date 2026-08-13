import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));

import { acts, log, resetActivities } from './testing/temporal-workflow.mock';
import { backlogSweepWorkflow } from './backlog.workflow';

const TARGET = { workspaceId: 'ws-1', icpId: 'icp-1' };

function primeSinglePageActivities(): void {
  acts.qualifyFitBacklog.mockResolvedValue({
    scanned: 2,
    judged: 2,
    verdicts: { match: 1, weak: 1, mismatch: 0 },
    nextCursor: null,
  });
  acts.enrichBacklog.mockResolvedValue({ scanned: 2, attempted: 2, matched: 1, nextCursor: null });
  acts.enrichSignalsBacklog.mockResolvedValue({ scanned: 2, attempted: 1, matched: 1, nextCursor: null });
  acts.registerWatchesBacklog.mockResolvedValue({ scanned: 2, registered: 1, nextCursor: null });
  acts.discoverContactsBacklog.mockResolvedValue({
    scanned: 2,
    attempted: 2,
    contactsCreated: 3,
    nextCursor: null,
  });
  acts.guessEmailsBacklog.mockResolvedValue({ scanned: 2, attempted: 1, guessed: 1, nextCursor: null });
  acts.scoreCandidates.mockResolvedValue({ scored: 2, queues: {} });
}

beforeEach(() => {
  resetActivities();
});

describe('backlogSweepWorkflow', () => {
  it('uses the explicit target, default page sizes, and accumulates every stage', async () => {
    primeSinglePageActivities();

    const result = await backlogSweepWorkflow(TARGET);

    expect(acts.listBacklogTargets).not.toHaveBeenCalled();
    expect(acts.qualifyFitBacklog).toHaveBeenCalledWith({ ...TARGET, limit: 20, cursor: null });
    expect(acts.enrichBacklog).toHaveBeenCalledWith({ workspaceId: 'ws-1', limit: 25, cursor: null });
    expect(acts.enrichSignalsBacklog).toHaveBeenCalledWith({ workspaceId: 'ws-1', limit: 12, cursor: null });
    expect(acts.registerWatchesBacklog).toHaveBeenCalledWith({ workspaceId: 'ws-1', limit: 12, cursor: null });
    expect(acts.discoverContactsBacklog).toHaveBeenCalledWith({ ...TARGET, limit: 8, cursor: null });
    expect(acts.guessEmailsBacklog).toHaveBeenCalledWith({ ...TARGET, limit: 6, cursor: null });
    expect(acts.scoreCandidates).toHaveBeenCalledWith(TARGET);
    expect(result).toEqual([
      {
        ...TARGET,
        fit: { scanned: 2, judged: 2, verdicts: { match: 1, weak: 1, mismatch: 0 }, exhausted: true },
        enrich: { scanned: 2, attempted: 2, matched: 1 },
        signals: { scanned: 2, attempted: 1, matched: 1 },
        watches: { scanned: 2, registered: 1 },
        contacts: { scanned: 2, attempted: 2, contactsCreated: 3 },
        guesses: { scanned: 2, attempted: 1, guessed: 1 },
        scored: 2,
      },
    ]);
  });

  it('threads cursors, honors per-stage round limits, and reports fit as not exhausted', async () => {
    const paged = {
      fit: [
        { scanned: 3, judged: 2, verdicts: { match: 1, weak: 1 }, nextCursor: 'fit-1' },
        { scanned: 3, judged: 1, verdicts: { mismatch: 1 }, nextCursor: 'fit-2' },
      ],
      enrich: [
        { scanned: 4, attempted: 3, matched: 1, nextCursor: 'enrich-1' },
        { scanned: 4, attempted: 2, matched: 2, nextCursor: 'enrich-2' },
      ],
      signal: [
        { scanned: 5, attempted: 4, matched: 1, nextCursor: 'signal-1' },
        { scanned: 5, attempted: 3, matched: 2, nextCursor: 'signal-2' },
      ],
      watch: [
        { scanned: 6, registered: 2, nextCursor: 'watch-1' },
        { scanned: 6, registered: 1, nextCursor: 'watch-2' },
      ],
      contact: [
        { scanned: 7, attempted: 4, contactsCreated: 2, nextCursor: 'contact-1' },
        { scanned: 7, attempted: 3, contactsCreated: 1, nextCursor: 'contact-2' },
      ],
      guess: [
        { scanned: 8, attempted: 5, guessed: 2, nextCursor: 'guess-1' },
        { scanned: 8, attempted: 4, guessed: 1, nextCursor: 'guess-2' },
      ],
    };
    acts.qualifyFitBacklog.mockResolvedValueOnce(paged.fit[0]).mockResolvedValueOnce(paged.fit[1]);
    acts.enrichBacklog.mockResolvedValueOnce(paged.enrich[0]).mockResolvedValueOnce(paged.enrich[1]);
    acts.enrichSignalsBacklog.mockResolvedValueOnce(paged.signal[0]).mockResolvedValueOnce(paged.signal[1]);
    acts.registerWatchesBacklog.mockResolvedValueOnce(paged.watch[0]).mockResolvedValueOnce(paged.watch[1]);
    acts.discoverContactsBacklog.mockResolvedValueOnce(paged.contact[0]).mockResolvedValueOnce(paged.contact[1]);
    acts.guessEmailsBacklog.mockResolvedValueOnce(paged.guess[0]).mockResolvedValueOnce(paged.guess[1]);
    acts.scoreCandidates.mockResolvedValue({ scored: 9, queues: {} });

    const [stats] = await backlogSweepWorkflow({
      ...TARGET,
      fitBatch: 3,
      maxFitRounds: 2,
      enrichBatch: 4,
      maxEnrichRounds: 2,
      signalBatch: 5,
      maxSignalRounds: 2,
      watchBatch: 6,
      maxWatchRounds: 2,
      contactBatch: 7,
      maxContactRounds: 2,
      guessBatch: 8,
      maxGuessRounds: 2,
    });

    expect(acts.qualifyFitBacklog.mock.calls).toEqual([
      [{ ...TARGET, limit: 3, cursor: null }],
      [{ ...TARGET, limit: 3, cursor: 'fit-1' }],
    ]);
    expect(acts.enrichBacklog.mock.calls[1]?.[0]).toEqual({ workspaceId: 'ws-1', limit: 4, cursor: 'enrich-1' });
    expect(acts.enrichSignalsBacklog.mock.calls[1]?.[0]).toEqual({ workspaceId: 'ws-1', limit: 5, cursor: 'signal-1' });
    expect(acts.registerWatchesBacklog.mock.calls[1]?.[0]).toEqual({ workspaceId: 'ws-1', limit: 6, cursor: 'watch-1' });
    expect(acts.discoverContactsBacklog.mock.calls[1]?.[0]).toEqual({ ...TARGET, limit: 7, cursor: 'contact-1' });
    expect(acts.guessEmailsBacklog.mock.calls[1]?.[0]).toEqual({ ...TARGET, limit: 8, cursor: 'guess-1' });
    expect(stats).toMatchObject({
      fit: { scanned: 6, judged: 3, verdicts: { match: 1, weak: 1, mismatch: 1 }, exhausted: false },
      enrich: { scanned: 8, attempted: 5, matched: 3 },
      signals: { scanned: 10, attempted: 7, matched: 3 },
      watches: { scanned: 12, registered: 3 },
      contacts: { scanned: 14, attempted: 7, contactsCreated: 3 },
      guesses: { scanned: 16, attempted: 9, guessed: 3 },
      scored: 9,
    });
  });

  it('enumerates targets and keeps later stages running after independent failures', async () => {
    acts.listBacklogTargets.mockResolvedValue({ targets: [TARGET] });
    acts.qualifyFitBacklog.mockRejectedValue(new Error('fit unavailable for jane@example.com'));
    acts.enrichBacklog.mockResolvedValue({ scanned: 1, attempted: 1, matched: 1, nextCursor: null });
    acts.enrichSignalsBacklog.mockRejectedValue(new Error('signal unavailable'));
    acts.registerWatchesBacklog.mockResolvedValue({ scanned: 1, registered: 1, nextCursor: null });
    acts.discoverContactsBacklog.mockRejectedValue(new Error('contact unavailable'));
    acts.guessEmailsBacklog.mockResolvedValue({ scanned: 1, attempted: 1, guessed: 1, nextCursor: null });
    acts.scoreCandidates.mockRejectedValue(new Error('score unavailable'));

    const [stats] = await backlogSweepWorkflow();

    expect(acts.listBacklogTargets).toHaveBeenCalledTimes(1);
    expect(acts.enrichBacklog).toHaveBeenCalledTimes(1);
    expect(acts.registerWatchesBacklog).toHaveBeenCalledTimes(1);
    expect(acts.guessEmailsBacklog).toHaveBeenCalledTimes(1);
    expect(acts.scoreCandidates).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({
      fit: { scanned: 0, judged: 0, exhausted: false },
      enrich: { scanned: 1, attempted: 1, matched: 1 },
      signals: { scanned: 0, attempted: 0, matched: 0 },
      watches: { scanned: 1, registered: 1 },
      contacts: { scanned: 0, attempted: 0, contactsCreated: 0 },
      guesses: { scanned: 1, attempted: 1, guessed: 1 },
      scored: 0,
    });
    expect(log.warn).toHaveBeenCalledTimes(4);
    expect(log.warn.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: 'ws-1',
          icpId: 'icp-1',
          errorCode: 'ACQUISITION_ACTIVITY_FAILED',
        }),
      ]),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('jane@example.com');
  });

  it('returns an empty result when target discovery has no active ICPs', async () => {
    acts.listBacklogTargets.mockResolvedValue({ targets: [] });

    await expect(backlogSweepWorkflow()).resolves.toEqual([]);
    expect(acts.qualifyFitBacklog).not.toHaveBeenCalled();
    expect(acts.scoreCandidates).not.toHaveBeenCalled();
  });
});
