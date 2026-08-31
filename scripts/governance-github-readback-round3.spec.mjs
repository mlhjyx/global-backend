import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectGitHubApprovalEvidence,
  createGitHubReadbackClient,
} from './governance-github-readback.mjs';
import {
  API_VERSION,
  AUTH_SENTINEL,
  collect,
  expectCode,
  fixtureFetch,
  fixtureState,
  jsonResponse,
  limits,
  policy,
  request,
} from './fixtures/approval-readback/task5-github-readback-fixture.mjs';

const relativeQuery = (query) => `?${query}`;

const forceReviewQueries = (state, firstHeader, secondHeader = '<?per_page=100&page=2>; rel="last"') => {
  state.forced = {
    predicate: (url) => url.pathname.endsWith('/pulls/427/reviews'),
    response: (url) => {
      const page = Number(url.searchParams.get('page'));
      return jsonResponse(state.reviewPages[page - 1] ?? [], {
        headers: { link: page === 1 ? firstHeader : secondHeader },
      });
    },
  };
};

test('round3 rejects reviewer next/last page=%32 before requesting the alternate URL', async () => {
  const state = fixtureState();
  const encoded = relativeQuery('per_page=100&page=%32');
  forceReviewQueries(
    state,
    `<${encoded}>; rel="next", <${encoded}>; rel="last"`,
    `<${encoded}>; rel="last"`,
  );
  const fixture = fixtureFetch(state);
  const client = createGitHubReadbackClient({
    fetch: fixture.fetch,
    token: AUTH_SENTINEL,
    apiVersion: API_VERSION,
  });
  await expectCode(
    () => collectGitHubApprovalEvidence(client, request(), limits(), policy()),
    'APPROVAL_GITHUB_PAGINATION_INVALID',
  );
  const reviewCalls = fixture.calls.filter(({ url }) => new URL(url).pathname.endsWith('/pulls/427/reviews'));
  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls.some(({ url }) => url.includes('%32')), false);
});

test('round3 applies raw canonical page rules independently to next and last', async (t) => {
  for (const [name, nextQuery, lastQuery] of [
    ['encoded next page', 'per_page=100&page=%32', 'per_page=100&page=2'],
    ['encoded last page', 'per_page=100&page=2', 'per_page=100&page=%32'],
    ['encoded next key', 'per_page=100&%70age=2', 'per_page=100&page=2'],
    ['encoded last key', 'per_page=100&page=2', 'per_page=100&%70age=2'],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      forceReviewQueries(
        state,
        `<${relativeQuery(nextQuery)}>; rel="next", <${relativeQuery(lastQuery)}>; rel="last"`,
      );
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
});

test('round3 rejects encoded per_page plus and semicolon raw forms', async (t) => {
  for (const [name, query] of [
    ['encoded per_page', 'per_page=%31%30%30&page=2'],
    ['page plus', 'per_page=100&page=+2'],
    ['per_page plus', 'per_page=+100&page=2'],
    ['page semicolon', 'per_page=100&page=2;ignored'],
    ['empty token', 'per_page=100&&page=2'],
    ['missing equals', 'per_page=100&page'],
    ['multiple equals', 'per_page=100&page=2=2'],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      const target = relativeQuery(query);
      forceReviewQueries(
        state,
        `<${target}>; rel="next", <${target}>; rel="last"`,
      );
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
});

test('round3 rejects encoded check-run filter key or value', async (t) => {
  for (const [name, query] of [
    ['encoded filter value', 'filter=%61ll&per_page=100&page=2'],
    ['encoded filter key', '%66ilter=all&per_page=100&page=2'],
  ]) {
    await t.test(name, async () => {
      const state = fixtureState();
      state.forced = {
        predicate: (url) => url.pathname.endsWith('/check-suites/71001/check-runs'),
        response: (url) => {
          const page = Number(url.searchParams.get('page'));
          if (page === 1) {
            const target = relativeQuery(query);
            return jsonResponse(
              { total_count: 1, check_runs: state.checkPages[0] },
              { headers: { link: `<${target}>; rel="next", <${target}>; rel="last"` } },
            );
          }
          return jsonResponse(
            { total_count: 1, check_runs: [] },
            { headers: { link: '<?filter=all&per_page=100&page=2>; rel="last"' } },
          );
        },
      };
      await expectCode(() => collect(state), 'APPROVAL_GITHUB_PAGINATION_INVALID');
    });
  }
});

test('round3 accepts canonical relative query tokens in a different closed order', async () => {
  const state = fixtureState();
  forceReviewQueries(
    state,
    '<?page=2&per_page=100>; rel="next", <?page=2&per_page=100>; rel="last"',
    '<?page=2&per_page=100>; rel="last"',
  );
  const { evidence } = await collect(state);
  assert.equal(evidence.review_pagination_complete, true);
});

test('round3 accepts canonical absolute query tokens in a different closed order', async () => {
  const state = fixtureState();
  forceReviewQueries(state, null);
  state.forced.response = (url) => {
    const page = Number(url.searchParams.get('page'));
    const target = `${url.origin}${url.pathname}?page=2&per_page=100`;
    return jsonResponse(state.reviewPages[page - 1] ?? [], {
      headers: {
        link: page === 1
          ? `<${target}>; rel="next", <${target}>; rel="last"`
          : `<${target}>; rel="last"`,
      },
    });
  };
  const { evidence } = await collect(state);
  assert.equal(evidence.review_pagination_complete, true);
});
