import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HEAD_SHA,
  collect,
  expectCode,
  fixtureState,
  jsonResponse,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

const codeownerReversal = (state) => ({
  id: 2006,
  node_id: 'PRR_2006',
  user: structuredClone(state.reviewPages[1][2].user),
  body: 'CODEOWNER REVIEW',
  state: 'CHANGES_REQUESTED',
  commit_id: HEAD_SHA,
  submitted_at: '2026-08-30T11:00:00.000Z',
});

const forceReviewPagination = (state, pages, headerForPage) => {
  state.forced = {
    predicate: (url) => url.pathname.endsWith('/pulls/427/reviews'),
    response: (url) => {
      const page = Number(url.searchParams.get('page'));
      const link = headerForPage(url, page);
      return jsonResponse(pages[page - 1] ?? [], {
        headers: link === null ? {} : { link },
      });
    },
  };
};

const relativePage = (page) => `?per_page=100&page=${page}`;

test('round2 rejects reviewer counterexample: future last page without sequential next', async () => {
  const state = fixtureState();
  const oldApprovals = state.reviewPages.flat();
  forceReviewPagination(
    state,
    [oldApprovals, [codeownerReversal(state)]],
    (_url, page) => (page === 1
      ? `<${relativePage(2)}>; rel="last"`
      : null),
  );
  await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
});

test('round2 closes supported Link relations and rejects duplicates or ambiguity', async (t) => {
  for (const [name, header] of [
    ['unknown relation', `<${relativePage(1)}>; rel="canonical"`],
    ['unsupported first', `<${relativePage(1)}>; rel="first"`],
    ['unsupported prev', `<${relativePage(1)}>; rel="prev"`],
    ['ambiguous relation list', `<${relativePage(2)}>; rel="next last"`],
    ['duplicate last', `<${relativePage(1)}>; rel="last", <${relativePage(1)}>; rel="last"`],
    ['duplicate next', `<${relativePage(2)}>; rel="next", <${relativePage(2)}>; rel="next"`],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      forceReviewPagination(state, [state.reviewPages.flat()], () => header);
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
});

test('round2 validates last target origin, path, closed query, and page direction', async (t) => {
  for (const [name, target] of [
    ['cross origin', 'https://evil.example/reviews?per_page=100&page=1'],
    ['wrong path', 'https://api.github.com/repos/mlhjyx/global-backend/pulls/999/reviews?per_page=100&page=1'],
    ['missing page', '?per_page=100'],
    ['duplicate page', '?per_page=100&page=1&page=2'],
    ['extra query', '?per_page=100&page=1&filter=all'],
    ['last before current', '?per_page=100&page=0'],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      forceReviewPagination(
        state,
        [state.reviewPages.flat()],
        () => `<${target}>; rel="last"`,
      );
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
});

test('round2 rejects next/last contradictions', async (t) => {
  await t.test('last is current but next points to future', async () => {
    const state = fixtureState();
    forceReviewPagination(
      state,
      [state.reviewPages.flat(), [codeownerReversal(state)]],
      (_url, page) => (page === 1
        ? `<${relativePage(2)}>; rel="next", <${relativePage(1)}>; rel="last"`
        : null),
    );
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });

  await t.test('last is future but next is absent', async () => {
    const state = fixtureState();
    forceReviewPagination(
      state,
      [state.reviewPages.flat(), [codeownerReversal(state)]],
      (_url, page) => (page === 1 ? `<${relativePage(2)}>; rel="last"` : null),
    );
    await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
  });
});

test('round2 accepts relative sequential next and a true relative last page', async () => {
  const state = fixtureState();
  forceReviewPagination(
    state,
    state.reviewPages,
    (_url, page) => {
      if (page === 1) {
        return `<${relativePage(2)}>; rel="next", <${relativePage(2)}>; rel="last"`;
      }
      return `<${relativePage(2)}>; rel="last"`;
    },
  );
  const { evidence, calls } = await collect(state);
  assert.equal(evidence.review_pagination_complete, true);
  assert.equal(
    calls.filter(({ url }) => new URL(url).pathname.endsWith('/pulls/427/reviews')).length,
    2,
  );
});

test('round2 accepts no-last sequential next until an uncontradicted terminal page', async () => {
  const state = fixtureState();
  forceReviewPagination(
    state,
    state.reviewPages,
    (_url, page) => (page === 1 ? `<${relativePage(2)}>; rel="next"` : null),
  );
  const { evidence } = await collect(state);
  assert.equal(evidence.review_pagination_complete, true);
});

test('round2 accepts a single real terminal page identified by relative last=current', async () => {
  const state = fixtureState();
  forceReviewPagination(
    state,
    [state.reviewPages.flat()],
    () => `<${relativePage(1)}>; rel="last"`,
  );
  const { evidence } = await collect(state);
  assert.equal(evidence.review_pagination_complete, true);
});
